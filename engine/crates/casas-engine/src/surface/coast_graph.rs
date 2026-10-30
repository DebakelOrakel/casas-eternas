//! The coast as a feature — the shoreline cut into reaches with exposure,
//! relief, hardness and river supply, and a coast type per node and reach
//! from them. `client/src/generator/surface/coastGraph.ts` explains each
//! attribute and rule.

use std::collections::{HashMap, HashSet};

use crate::core::js;
use crate::elevation::elevation_scale::{SEA_LEVEL, elevation_to_meters};
use crate::mesh::periodic_delaunay::PeriodicTriangulation;

use super::coastal::{find_shore, shore_exposure};
use super::river_graph::{RiverGraph, RiverNodeKind};
use super::surface_tune_params::SURFACE_TUNING;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoastType {
    Rocky,
    Cliff,
    Beach,
    Marsh,
    Delta,
}

impl CoastType {
    /// The type as the per-node field and the shader's raster carry it,
    /// one byte each (0 = not on the coast).
    pub fn code(self) -> u8 {
        match self {
            CoastType::Rocky => 1,
            CoastType::Cliff => 2,
            CoastType::Beach => 3,
            CoastType::Marsh => 4,
            CoastType::Delta => 5,
        }
    }

    fn of_code(code: usize) -> Self {
        [
            CoastType::Rocky,
            CoastType::Rocky,
            CoastType::Cliff,
            CoastType::Beach,
            CoastType::Marsh,
            CoastType::Delta,
        ][code]
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CoastReach {
    pub id: usize,
    pub node_start: usize,
    pub node_count: usize,
    pub length_km: f64,
    pub exposure: f64,
    pub relief_m: f64,
    pub hardness: f64,
    pub supply: f64,
    pub coast_type: CoastType,
    /// The river reach that ends on this coast reach, -1 for none.
    pub mouth_reach: i32,
}

#[derive(Clone, Debug)]
pub struct CoastGraph {
    pub reaches: Vec<CoastReach>,
    pub nodes: Vec<i32>,
    /// The type code per vertex slot, 0 off the coast.
    pub coast_type: Vec<u8>,
}

pub struct CoastGraphInputs<'a> {
    pub z: &'a [f32],
    pub wind_e: &'a [f32],
    pub wind_s: &'a [f32],
    pub hardness: Option<&'a [f32]>,
    pub graph: Option<&'a RiverGraph>,
}

/// Scales a field over the coast so its 90th percentile of the positive
/// values is 1, clamped at 1.
fn normalise_to_p90(field: &mut [f32], coast: &[i32]) {
    let mut values: Vec<f32> = coast
        .iter()
        .map(|&c| field[c as usize])
        .filter(|&v| v > 0.0)
        .collect();
    if values.is_empty() {
        return;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    let p90 = values[(values.len() - 1).min((0.9 * values.len() as f64).floor() as usize)] as f64;
    if p90 <= 0.0 {
        return;
    }
    for &c in coast {
        let v = field[c as usize] as f64 / p90;
        field[c as usize] = (if v > 1.0 { 1.0 } else { v }) as f32;
    }
}

const COMPASS: [(f64, f64); 8] = [
    (1.0, 0.0),
    (1.0, 1.0),
    (0.0, 1.0),
    (-1.0, 1.0),
    (-1.0, 0.0),
    (-1.0, -1.0),
    (0.0, -1.0),
    (1.0, -1.0),
];

pub fn build_coast_graph(
    mesh: &mut PeriodicTriangulation,
    input: &CoastGraphInputs<'_>,
) -> CoastGraph {
    let z = input.z;
    let t = &SURFACE_TUNING;
    let slots = mesh.vertex_slots();
    let metres_per_unit = mesh.domain.metres_per_unit;
    let is_sea = |v: usize| z[v] as f64 <= SEA_LEVEL;
    let dist_m = |mesh: &PeriodicTriangulation, a: usize, b: usize| {
        mesh.domain
            .distance_sq(mesh.vx[a], mesh.vy[a], mesh.vx[b], mesh.vy[b])
            .sqrt()
            * metres_per_unit
    };
    let mut star: Vec<u32> = Vec::new();
    let shore = find_shore(mesh, z);
    let coast = shore.shore;
    let is_shore = shore.is_shore;

    // The nearest coast node within `radius_m` along the mesh, or -1.
    let nearest_coast =
        |mesh: &PeriodicTriangulation, star: &mut Vec<u32>, v: usize, radius_m: f64| -> i32 {
            if is_shore[v] != 0 {
                return v as i32;
            }
            let mut seen: HashSet<usize> = HashSet::from([v]);
            let mut queue = vec![v];
            let mut best = -1;
            let mut best_m = f64::INFINITY;
            let mut head = 0;
            while head < queue.len() {
                mesh.neighbours(queue[head], star);
                head += 1;
                for &u in star.iter() {
                    let u = u as usize;
                    if !seen.insert(u) {
                        continue;
                    }
                    let d = dist_m(mesh, v, u);
                    if d > radius_m {
                        continue;
                    }
                    if is_shore[u] != 0 && d < best_m {
                        best_m = d;
                        best = u as i32;
                    }
                    queue.push(u);
                }
            }
            best
        };

    // Mouths: the last land node of every river reach that ends in the sea.
    let mut mouth_at = vec![-1i32; slots];
    let mut delta_mouths: Vec<usize> = Vec::new();
    if let Some(graph) = input.graph {
        let mut course_of: HashMap<usize, bool> = HashMap::new();
        for c in graph.courses.iter().flatten() {
            course_of.insert(c.reach, !c.lobe_ages.is_empty());
        }
        for r in &graph.reaches {
            let node = &graph.nodes[r.to];
            if node.kind != RiverNodeKind::Mouth || !is_sea(node.cell) {
                continue;
            }
            if r.cell_count < 2 {
                continue;
            }
            let k = r.cell_start + r.cell_count - 2;
            let last = nearest_coast(
                mesh,
                &mut star,
                graph.cells[k] as usize,
                t.coast_mouth_reach_m,
            );
            if last < 0 {
                continue;
            }
            let last = last as usize;
            if mouth_at[last] < 0
                || graph.reaches[mouth_at[last] as usize].discharge_out < r.discharge_out
            {
                mouth_at[last] = r.id as i32;
            }
            if course_of.get(&r.id).copied().unwrap_or(false) {
                delta_mouths.push(last);
            }
        }
    }

    // Per-node attributes.
    let mut exposure = vec![0f32; slots];
    let mut relief = vec![0f32; slots];
    let mut hard = vec![0f32; slots];
    let mut supply = vec![0f32; slots];
    let fetch_cap = js::max(
        1.0,
        js::round((t.coast_fetch_cap_km * 1000.0) / t.coast_graph_fetch_step_m),
    ) as usize;
    shore_exposure(
        mesh,
        z,
        &coast,
        input.wind_e,
        input.wind_s,
        t.coast_graph_fetch_step_m / metres_per_unit,
        fetch_cap,
        &mut exposure,
    );
    normalise_to_p90(&mut exposure, &coast);
    let relief_step = t.coast_relief_step_m / metres_per_unit;
    let mut hint = mesh.last_tri as usize;
    for &v in &coast {
        let v = v as usize;
        let mut top = z[v] as f64;
        for (dx, dy) in COMPASS {
            let at =
                mesh.domain
                    .advance(mesh.vx[v], mesh.vy[v], dx * relief_step, dy * relief_step);
            let tri = mesh.locate(at.x, at.y, Some(hint));
            hint = tri;
            let b = mesh.barycentric(tri, at.x, at.y);
            let g = b[0] * z[mesh.tris[3 * tri] as usize] as f64
                + b[1] * z[mesh.tris[3 * tri + 1] as usize] as f64
                + b[2] * z[mesh.tris[3 * tri + 2] as usize] as f64;
            if g > top {
                top = g;
            }
        }
        relief[v] = elevation_to_meters(top - SEA_LEVEL) as f32;
        hard[v] = input.hardness.map_or(1.0, |h| h[v]);
    }

    // Sediment supply from the sea mouths, spread along the coast.
    let supply_reach_m = t.coast_supply_reach_km * 1000.0;
    let mut mouths: Vec<(usize, f64)> = Vec::new();
    if let Some(graph) = input.graph {
        for &v in &coast {
            let v = v as usize;
            if mouth_at[v] < 0 {
                continue;
            }
            let r = &graph.reaches[mouth_at[v] as usize];
            if r.sediment_m3 > 0.0 {
                mouths.push((v, r.sediment_m3));
            }
        }
    }
    if !mouths.is_empty() {
        for &v in &coast {
            let v = v as usize;
            let mut s = 0.0;
            for &(m, load) in &mouths {
                let d = dist_m(mesh, v, m);
                if d > supply_reach_m {
                    continue;
                }
                s += load * (1.0 - d / supply_reach_m);
            }
            supply[v] = s as f32;
        }
        normalise_to_p90(&mut supply, &coast);
    }

    // The type per node.
    let mut coast_type = vec![0u8; slots];
    for &v in &coast {
        let v = v as usize;
        let (e, r, h, s) = (
            exposure[v] as f64,
            relief[v] as f64,
            hard[v] as f64,
            supply[v] as f64,
        );
        let ct = if delta_mouths
            .iter()
            .any(|&m| dist_m(mesh, v, m) <= t.coast_delta_reach_m)
        {
            CoastType::Delta
        } else if e < t.coast_calm_exposure
            && r < t.coast_marsh_relief_m
            && s >= t.coast_marsh_supply
        {
            CoastType::Marsh
        } else if r >= t.coast_cliff_relief_m
            && e >= t.coast_cliff_exposure
            && h <= t.coast_cliff_max_k
        {
            CoastType::Cliff
        } else if s >= t.coast_beach_supply
            || (e >= t.coast_cliff_exposure && r < t.coast_cliff_relief_m)
        {
            CoastType::Beach
        } else {
            CoastType::Rocky
        };
        coast_type[v] = ct.code();
    }

    // Reaches: walks along the coast, ends of a stretch first.
    let mut visited = vec![0u8; slots];
    let mut nodes: Vec<i32> = Vec::new();
    let mut reaches: Vec<CoastReach> = Vec::new();
    let close_reach =
        |nodes: &[i32], reaches: &mut Vec<CoastReach>, start: usize, mouth_reach: i32| {
            let count = nodes.len() - start;
            if count == 0 {
                return;
            }
            let (mut ex, mut rl, mut hd, mut sp) = (0.0, 0.0, 0.0, 0.0);
            let mut votes = [0i32; 6];
            let mut m = 0.0;
            for k in start..nodes.len() {
                let v = nodes[k] as usize;
                ex += exposure[v] as f64;
                rl += relief[v] as f64;
                hd += hard[v] as f64;
                sp += supply[v] as f64;
                votes[coast_type[v] as usize] += 1;
                if k > start {
                    m += dist_m(mesh, nodes[k - 1] as usize, v);
                }
            }
            let mut best = 1;
            for ty in 1..6 {
                if votes[ty] > votes[best] {
                    best = ty;
                }
            }
            let c = count as f64;
            reaches.push(CoastReach {
                id: reaches.len(),
                node_start: start,
                node_count: count,
                length_km: m / 1000.0,
                exposure: ex / c,
                relief_m: rl / c,
                hardness: hd / c,
                supply: sp,
                coast_type: CoastType::of_code(best),
                mouth_reach,
            });
        };
    for pass in 0..2 {
        for &c in &coast {
            let start = c as usize;
            if visited[start] != 0 {
                continue;
            }
            if pass == 0 {
                mesh.neighbours(start, &mut star);
                let degree = star.iter().filter(|&&u| is_shore[u as usize] != 0).count();
                if degree != 1 {
                    continue;
                }
            }
            // The walk from `start`.
            let mut v = start as i32;
            let mut reach_start = nodes.len();
            let mut walked_m = 0.0;
            while v >= 0 {
                let vu = v as usize;
                visited[vu] = 1;
                if nodes.len() > reach_start {
                    walked_m += dist_m(mesh, *nodes.last().unwrap() as usize, vu);
                }
                nodes.push(v);
                let at_mouth = mouth_at[vu] >= 0;
                if at_mouth || walked_m >= t.coast_reach_m {
                    close_reach(
                        &nodes,
                        &mut reaches,
                        reach_start,
                        if at_mouth { mouth_at[vu] } else { -1 },
                    );
                    reach_start = nodes.len();
                    walked_m = 0.0;
                }
                // The nearest unvisited coast neighbour.
                mesh.neighbours(vu, &mut star);
                let mut best = -1;
                let mut best_m = f64::INFINITY;
                for &u in &star {
                    let u = u as usize;
                    if is_shore[u] == 0 || visited[u] != 0 {
                        continue;
                    }
                    let d = dist_m(mesh, vu, u);
                    if d < best_m {
                        best_m = d;
                        best = u as i32;
                    }
                }
                v = best;
            }
            close_reach(&nodes, &mut reaches, reach_start, -1);
        }
    }
    CoastGraph {
        reaches,
        nodes,
        coast_type,
    }
}

/// The invariants of a coast graph: check name and violations, in the
/// TypeScript order.
pub fn coast_graph_invariants(
    coast: &CoastGraph,
    mesh: &PeriodicTriangulation,
    z: &[f32],
) -> Vec<(&'static str, usize)> {
    let is_shore = find_shore(mesh, z).is_shore;
    let (mut on_coast, mut once, mut contiguous) = (0, 0, 0);
    let mut seen = vec![false; mesh.vertex_slots()];
    let mut star = Vec::new();
    for r in &coast.reaches {
        for k in 0..r.node_count {
            let v = coast.nodes[r.node_start + k] as usize;
            if is_shore[v] == 0 || coast.coast_type[v] == 0 {
                on_coast += 1;
            }
            if seen[v] {
                once += 1;
            }
            seen[v] = true;
            if k > 0 {
                let a = coast.nodes[r.node_start + k - 1] as usize;
                mesh.neighbours(a, &mut star);
                if !star.contains(&(v as u32)) {
                    contiguous += 1;
                }
            }
        }
    }
    vec![
        ("nodesOnCoast", on_coast),
        ("nodesOnce", once),
        ("typeKnown", 0),
        ("reachesContiguous", contiguous),
    ]
}
