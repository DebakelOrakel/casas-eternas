//! `surface/sedimentBasins.ts`: sediment basins as features — where the
//! last epoch's erosion left material, as connected sets of nodes with
//! their volume, kind and the provenance of the catchments that feed them.
//! The TypeScript file explains each rule.

use std::f64::consts::PI;

use crate::core::det_math::{det_atan2, det_cos, det_sin};
use crate::core::js;
use crate::elevation::elevation_scale::{SEA_LEVEL, elevation_to_meters};
use crate::mesh::periodic_delaunay::PeriodicTriangulation;

use super::flow_substrate::FlowSubstrate;
use super::river_graph::{RiverGraph, RiverNodeKind};
use super::surface_tune_params::SURFACE_TUNING;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BasinKind {
    Alluvial,
    Marine,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SedimentBasin {
    pub id: usize,
    pub kind: BasinKind,
    pub nodes: usize,
    pub area_km2: f64,
    pub volume_km3: f64,
    pub mean_thickness_m: f64,
    pub max_thickness_m: f64,
    pub x: f64,
    pub y: f64,
    pub mouth_reaches: Vec<usize>,
    pub catchment_km2: f64,
    pub craton_age: f64,
    pub hardness: f64,
}

pub struct SedimentBasinInputs<'a, S: FlowSubstrate> {
    pub mesh: &'a PeriodicTriangulation,
    pub before: &'a [f32],
    pub after: &'a [f32],
    pub substrate: &'a S,
    pub graph: Option<&'a RiverGraph>,
    pub craton_age: Option<&'a [f32]>,
    pub hardness: Option<&'a [f32]>,
}

#[derive(Clone, Debug)]
pub struct SedimentBasinResult {
    pub basins: Vec<SedimentBasin>,
    /// Basin id + 1 per vertex slot, 0 outside every basin.
    pub label: Vec<i32>,
}

pub fn find_sediment_basins<S: FlowSubstrate>(
    input: &SedimentBasinInputs<'_, S>,
) -> SedimentBasinResult {
    let mesh = input.mesh;
    let (before, after, sub) = (input.before, input.after, input.substrate);
    let domain = &mesh.domain;
    let n = mesh.vertex_slots();
    let km2_per_unit = (domain.metres_per_unit / 1000.0) * (domain.metres_per_unit / 1000.0);
    let area_of = |v: usize| sub.area(v) * km2_per_unit;
    let (width, height) = (domain.width, domain.height);
    let globe = domain.is_sphere();
    let min_thickness = SURFACE_TUNING.sediment_basin_min_thickness_m;
    let mut thickness = vec![0f32; n];
    for v in 0..n {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        let t = elevation_to_meters(after[v] as f64 - before[v] as f64);
        if t >= min_thickness {
            thickness[v] = t as f32;
        }
    }
    let craton_at = |v: usize| js::max(0.0, input.craton_age.map_or(0.0, |f| f[v] as f64));
    let hard_at = |v: usize| input.hardness.map_or(1.0, |f| f[v] as f64);
    // Components over the mesh's edges.
    let mut label = vec![0i32; n];
    let mut star: Vec<u32> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut basins: Vec<SedimentBasin> = Vec::new();
    for s in 0..n {
        if thickness[s] <= 0.0 || label[s] != 0 {
            continue;
        }
        let id = basins.len() as i32 + 1;
        label[s] = id;
        stack.push(s);
        let mut members: Vec<usize> = Vec::new();
        while let Some(v) = stack.pop() {
            members.push(v);
            mesh.neighbours(v, &mut star);
            for &u in &star {
                let u = u as usize;
                if thickness[u] > 0.0 && label[u] == 0 {
                    label[u] = id;
                    stack.push(u);
                }
            }
        }
        let mut area = 0.0;
        for &v in &members {
            area += area_of(v);
        }
        if area < SURFACE_TUNING.sediment_basin_min_area_km2 {
            for &v in &members {
                label[v] = -1;
            }
            continue;
        }
        let (mut volume, mut max, mut marine) = (0.0, 0.0, 0.0);
        let (mut sx, mut sy, mut cx, mut cy) = (0.0, 0.0, 0.0, 0.0);
        let (mut gx, mut gy, mut gz) = (0.0, 0.0, 0.0);
        let (mut craton, mut hard) = (0.0, 0.0);
        for &v in &members {
            let t = thickness[v] as f64;
            let w = area_of(v);
            volume += t * w;
            if t > max {
                max = t;
            }
            if after[v] as f64 <= SEA_LEVEL {
                marine += w;
            }
            let (x, y) = (mesh.vx[v], mesh.vy[v]);
            if globe {
                let f = domain.globe_frame(x, y);
                gx += f.px * w;
                gy += f.py * w;
                gz += f.pz * w;
            } else {
                let ax = (x / width) * PI * 2.0;
                let ay = (y / height) * PI * 2.0;
                sx += det_sin(ax) * w;
                cx += det_cos(ax) * w;
                sy += det_sin(ay) * w;
                cy += det_cos(ay) * w;
            }
            craton += craton_at(v) * w;
            hard += hard_at(v) * w;
        }
        let mut mx = ((det_atan2(sx, cx) / (PI * 2.0)) + 1.0) % 1.0;
        let mut my = ((det_atan2(sy, cy) / (PI * 2.0)) + 1.0) % 1.0;
        if globe {
            let c = domain.globe_locate(gx, gy, gz);
            mx = c.x / width;
            my = c.y / height;
        }
        basins.push(SedimentBasin {
            id: id as usize - 1,
            kind: if marine * 2.0 > area {
                BasinKind::Marine
            } else {
                BasinKind::Alluvial
            },
            nodes: members.len(),
            area_km2: area,
            volume_km3: volume / 1000.0,
            mean_thickness_m: volume / area,
            max_thickness_m: max,
            x: mx * width,
            y: my * height,
            mouth_reaches: Vec::new(),
            catchment_km2: area,
            craton_age: craton / area,
            hardness: hard / area,
        });
    }
    for l in &mut label {
        if *l < 0 {
            *l = 0;
        }
    }

    // Provenance from the catchments of the graph's mouths.
    if let Some(graph) = input.graph.filter(|_| !basins.is_empty()) {
        let flow_target = sub.flow_target();
        let pop_order = sub.pop_order();
        let mut mouth_at = vec![-1i32; n];
        for node in &graph.nodes {
            if node.kind == RiverNodeKind::Mouth {
                mouth_at[node.cell] = node.id as i32;
            }
        }
        let mut drains_to = vec![-1i32; n];
        for k in 0..sub.popped_count() {
            let v = pop_order[k] as usize;
            if after[v] as f64 <= SEA_LEVEL {
                continue;
            }
            let t = flow_target[v];
            if t < 0 {
                drains_to[v] = mouth_at[v];
                continue;
            }
            let t = t as usize;
            drains_to[v] = if after[t] as f64 > SEA_LEVEL && mouth_at[t] < 0 {
                drains_to[t]
            } else {
                mouth_at[t]
            };
        }
        let m = graph.nodes.len();
        let (mut count, mut craton_sum, mut hard_sum) = (vec![0.0; m], vec![0.0; m], vec![0.0; m]);
        for v in 0..n {
            let d = drains_to[v];
            if d < 0 {
                continue;
            }
            let d = d as usize;
            let w = area_of(v);
            count[d] += w;
            craton_sum[d] += craton_at(v) * w;
            hard_sum[d] += hard_at(v) * w;
        }
        let mut fed = vec![(0.0, 0.0, 0.0); basins.len()];
        for r in &graph.reaches {
            let node = &graph.nodes[r.to];
            if node.kind != RiverNodeKind::Mouth {
                continue;
            }
            let mut b = label[node.cell];
            if b == 0 && r.cell_count >= 2 {
                b = label[graph.cells[r.cell_start + r.cell_count - 2] as usize];
            }
            if b == 0 {
                continue;
            }
            let b = b as usize - 1;
            basins[b].mouth_reaches.push(r.id);
            fed[b].0 += count[node.id];
            fed[b].1 += craton_sum[node.id];
            fed[b].2 += hard_sum[node.id];
        }
        for (basin, f) in basins.iter_mut().zip(&fed) {
            if f.0 <= 0.0 {
                continue;
            }
            basin.catchment_km2 = f.0;
            basin.craton_age = f.1 / f.0;
            basin.hardness = f.2 / f.0;
        }
    }
    SedimentBasinResult { basins, label }
}

/// The invariants: check name and violations, in the TypeScript order.
pub fn sediment_basin_invariants(
    result: &SedimentBasinResult,
    before: &[f32],
    after: &[f32],
) -> Vec<(&'static str, usize)> {
    let mut counts = vec![0usize; result.basins.len() + 1];
    let mut positive = 0;
    for (v, &b) in result.label.iter().enumerate() {
        if b == 0 {
            continue;
        }
        counts[b as usize] += 1;
        if after[v] as f64 - before[v] as f64 <= 0.0 {
            positive += 1;
        }
    }
    let matches = result
        .basins
        .iter()
        .filter(|b| counts[b.id + 1] != b.nodes)
        .count();
    let finite = result
        .basins
        .iter()
        .filter(|b| {
            !(b.volume_km3.is_finite()
                && b.craton_age.is_finite()
                && b.hardness.is_finite()
                && b.x.is_finite()
                && b.y.is_finite())
        })
        .count();
    vec![
        ("thicknessPositive", positive),
        ("labelsMatch", matches),
        ("finite", finite),
    ]
}
