//! `pipeline/meshTileBake.ts`: the bake of one tile of a fine level — the
//! tile's mesh eroded for a short transient with the level bake's policy,
//! the halo frozen, the edge row pinned, the water entering over the edge
//! from upstream tiles and from level 1's rivers, and the outflow at each
//! edge node. The TypeScript file explains the boundary rule. The progress
//! callback is not ported yet: the boundary to TypeScript adds it.

use std::collections::{HashMap, HashSet};

use crate::climate::climate_points::{
    ClimateCellValues, ClimatePoints, Heights, climate_at_points, climate_cells_from_saved,
};
use crate::elevation::elevation_scale::SEA_LEVEL;
use crate::fields::field_mesh::SharedFieldMesh;
use crate::mesh::mesh_erosion::{
    DEFAULT_ROUTING_EVERY, MeshErosionOptions, MeshPipeline, MeshRouting, run_mesh_erosion,
};
use crate::mesh::mesh_hydrology::mesh_areas;
use crate::mesh::mesh_tile::{
    PARENT_LEVEL_BINS, PARENT_LEVEL_PASSES, SiteKind, TILE_ROLE_EDGE, TILE_ROLE_HALO, TileId,
    TileMesh, TileOptions, TileParent, point_key, tile_corner, tile_spec,
};
use crate::mesh::mesh_tile_cube::{cube_frame_of, cube_to_frame};
use crate::mesh::tile_layout::build_tile_mesh_on_world;
use crate::surface::amplify::BAKE_ENGINE_OVERRIDES;
use crate::surface::erosion_engine::ErosionSolverParams;
use crate::surface::erosion_forcing_fields::{
    CoarseForcingInputs, ErosionControls, assemble_node_forcing,
};
use crate::surface::river_graph::{RiverGraph, RiverReachKind};

use super::tile_plan::tile_at;
use crate::core::domain::Domain;
use crate::core::js;

#[derive(Clone, Copy)]
pub struct TileBakeInputs<'a> {
    pub parent_graph: Option<&'a RiverGraph>,
    pub width: usize,
    pub height: usize,
    pub detail_seed: u32,
    pub litho_seed: u32,
    pub controls: ErosionControls,
    pub uplift: Option<&'a [f32]>,
    pub erodibility: Option<&'a [f32]>,
    pub forcing_res_x: usize,
    pub forcing_res_y: usize,
    pub climate: Option<&'a ClimateCellValues>,
    /// The world's mean land water, mm/yr.
    pub mean_land_water: f64,
    pub upstream: &'a [UpstreamTile],
}

/// An upstream tile as the bake reads it: its inside nodes (cells from
/// its corner on the torus, world points on the sphere) and the outflow at
/// each.
#[derive(Clone, Debug)]
pub struct UpstreamTile {
    pub tile: TileId,
    pub count: usize,
    pub nodes: Vec<f32>,
    pub outflow: Vec<f32>,
}

#[derive(Clone, Copy, Debug)]
pub struct TileBakeOptions {
    pub rounds: u32,
    pub pool: Option<MeshPipeline>,
}

pub struct BakedTile {
    pub tile: TileMesh,
    pub z: Vec<f32>,
    pub routing: MeshRouting,
    pub inflows: usize,
    pub inflow_discharge: f64,
    pub upstream_inflow: f64,
    pub upstream_nodes: usize,
    pub outflow: Vec<f32>,
    pub eroded_flux_m3: f64,
}

/// The bake of one tile. `climate_mesh` is the world's climate field mesh.
pub fn bake_mesh_tile(
    parent: &mut TileParent,
    inputs: &TileBakeInputs<'_>,
    id: &TileId,
    options: &TileBakeOptions,
    climate_mesh: &mut SharedFieldMesh,
) -> Result<BakedTile, String> {
    let world = parent.mesh().domain.clone();
    let mut tile = build_tile_mesh_on_world(
        parent,
        id,
        &TileOptions {
            seed: inputs.detail_seed,
            width: inputs.width,
            height: inputs.height,
            halo: None,
        },
    );
    let slots = tile.mesh.vertex_slots();
    let areas = mesh_areas(&mut tile.mesh);
    let (xs, ys) = (&tile.world_x, &tile.world_y);
    // The water at the tile's nodes.
    let water_nodes = match inputs.climate {
        Some(c) => {
            let cells = climate_cells_from_saved(climate_mesh, c.clone())?;
            let land: Vec<u8> = (0..slots)
                .map(|v| u8::from(tile.mesh.v_alive[v] != 0 && tile.z[v] as f64 > SEA_LEVEL))
                .collect();
            let points = ClimatePoints {
                count: slots,
                x: xs,
                y: ys,
                height: Heights::F32(&tile.z),
                land,
                dry: None,
                alive: Some(&tile.mesh.v_alive[..slots]),
            };
            Some(climate_at_points(climate_mesh, &cells, &points, false).precipitation)
        }
        None => None,
    };
    let none = if world.is_sphere() { 2 } else { 1 };
    let coarse = CoarseForcingInputs {
        uplift: inputs.uplift,
        hardness: inputs.erodibility,
        forcing_res_x: if inputs.forcing_res_x == 0 {
            none
        } else {
            inputs.forcing_res_x
        },
        forcing_res_y: if inputs.forcing_res_y == 0 {
            none
        } else {
            inputs.forcing_res_y
        },
        water: None,
        water_res_x: none,
        water_res_y: none,
        water_nodes: water_nodes.as_deref(),
        litho_seed: inputs.litho_seed,
    };
    let mut assembled = assemble_node_forcing(
        &coarse,
        xs,
        ys,
        &tile.mesh.v_alive,
        slots,
        &tile.z,
        &areas,
        &world,
        &inputs.controls,
        (inputs.mean_land_water > 0.0).then_some(inputs.mean_land_water),
    );
    // The coastline is the parent's.
    let mut status_mask = vec![0u8; slots];
    for v in 0..slots {
        if tile.mesh.v_alive[v] != 0 {
            status_mask[v] = if parent.sampler.height_at(xs[v], ys[v]) > SEA_LEVEL {
                1
            } else {
                2
            };
        }
    }
    // The edge row pinned, the halo frozen.
    let mut pinned_z = vec![f32::NAN; slots];
    let mut frozen = vec![0u8; slots];
    for v in 0..slots {
        if tile.mesh.v_alive[v] == 0 {
            continue;
        }
        if tile.role[v] == TILE_ROLE_EDGE {
            pinned_z[v] = tile.z[v];
        } else if tile.role[v] == TILE_ROLE_HALO {
            frozen[v] = 1;
        }
    }
    // The water from upstream tiles, at every edge node they share.
    let upstream_keys: HashSet<(usize, usize)> = inputs
        .upstream
        .iter()
        .map(|u| (u.tile.x, u.tile.y))
        .collect();
    let mut upstream_inflow = 0.0;
    let mut upstream_nodes = 0;
    let sphere = tile.site.kind() == SiteKind::Cube;
    if !inputs.upstream.is_empty() {
        let weights = &mut assembled.accumulation_weights;
        let spec = tile_spec(id.level);
        let mut edge_at: HashMap<(u64, u64), usize> = HashMap::new();
        for v in 0..slots {
            if tile.mesh.v_alive[v] != 0 && tile.role[v] == TILE_ROLE_EDGE {
                let key = if sphere {
                    point_key(js::fround(xs[v]), js::fround(ys[v]))
                } else {
                    point_key(xs[v], ys[v])
                };
                edge_at.insert(key, v);
            }
        }
        for up in inputs.upstream {
            let corner = if sphere {
                (0.0, 0.0)
            } else {
                tile_corner(&up.tile, spec)
            };
            for i in 0..up.count {
                // `!(outflow > 0)`: NaN is no outflow either.
                if up.outflow[i].is_nan() || up.outflow[i] <= 0.0 {
                    continue;
                }
                let (nx, ny) = (up.nodes[2 * i] as f64, up.nodes[2 * i + 1] as f64);
                let key = if sphere {
                    point_key(nx, ny)
                } else {
                    point_key(world.wrap_x(corner.0 + nx), world.wrap_y(corner.1 + ny))
                };
                let Some(&e) = edge_at.get(&key) else {
                    continue;
                };
                let Some(v) = inside_node_near(&tile, e) else {
                    continue;
                };
                if areas[v] <= 0.0 {
                    continue;
                }
                weights[v] = (weights[v] as f64 + up.outflow[i] as f64 / areas[v] as f64) as f32;
                upstream_inflow += up.outflow[i] as f64;
                upstream_nodes += 1;
            }
        }
    }
    // The rivers of level 1 that enter from any other side.
    let mut inflows = 0;
    let mut inflow_discharge = 0.0;
    if let Some(graph) = inputs.parent_graph.filter(|_| inputs.mean_land_water > 0.0) {
        let crossings = if sphere {
            cube_inflow_crossings(graph, &tile, &world)
        } else {
            inflow_crossings(graph, &tile, &world)
        };
        for c in crossings {
            let from = tile_at(id.level, c.from_x, c.from_y, &world);
            if upstream_keys.contains(&(from.x, from.y)) {
                continue;
            }
            let Some(v) = first_inside_node(&mut tile, c.x, c.y) else {
                continue;
            };
            if areas[v] <= 0.0 {
                continue;
            }
            let w = &mut assembled.accumulation_weights[v];
            *w = (*w as f64 + c.discharge / inputs.mean_land_water / areas[v] as f64) as f32;
            inflows += 1;
            inflow_discharge += c.discharge;
        }
    }
    let mut forcing = assembled.forcing();
    forcing.status_mask = Some(&status_mask);
    forcing.pinned_z = Some(&pinned_z);
    let params = ErosionSolverParams {
        uplift_dt: BAKE_ENGINE_OVERRIDES.uplift_dt,
        ..assembled.params
    };
    // The pool on the single engine's cadence, waited for.
    let pool = options.pool.map(|p| MeshPipeline {
        pipeline_depth: DEFAULT_ROUTING_EVERY,
        synchronous: true,
        ..p
    });
    let result = run_mesh_erosion(
        &mut tile.mesh,
        &tile.z,
        &forcing,
        &MeshErosionOptions {
            age: options.rounds,
            routing_every: None,
            params: Some(params),
            pool,
            frozen: Some(&frozen),
        },
    );
    let mut z = result.z;
    keep_parent_level(&tile, &mut z);
    // The outflow: the drainage of the inside nodes that flow onto the edge.
    let mut outflow = vec![0f32; slots];
    let target = &result.routing.flow_target;
    for v in 0..slots {
        if tile.mesh.v_alive[v] == 0
            || tile.role[v] == TILE_ROLE_EDGE
            || tile.role[v] == TILE_ROLE_HALO
        {
            continue;
        }
        let t = target[v];
        if t >= 0 && tile.role[t as usize] == TILE_ROLE_EDGE {
            let t = t as usize;
            outflow[t] = (outflow[t] as f64 + result.routing.accumulation[v] as f64) as f32;
        }
    }
    Ok(BakedTile {
        tile,
        z,
        routing: result.routing,
        inflows,
        inflow_discharge,
        upstream_inflow,
        upstream_nodes,
        outflow,
        eroded_flux_m3: result.eroded_flux_m3,
    })
}

/// THE PARENT'S LEVEL (TEG-31, 2026-10-29). The bake's erosion lowers a
/// tile's land as a whole, and the pinned edge row stays at the parent's
/// height: a ridge on every tile border. Measured on the mountains of a
/// 1024 × 512 world (seed "seams", 3 × 3 level-2 tiles and the 25 level-3
/// tiles on them): the land inside lowered by 24 m on the mean at level 2,
/// 5 m at level 3, and the edge stood over the land within 0.15 cells of
/// it by 18 m on the mean at level 2 (90th percentile of 0.5-cell
/// segments 48 m, 99th 108 m), 3 m at level 3 (p90 10 m).
///
/// The smooth part of the bake's change is taken out of the land inside:
/// its mean in a grid of `PARENT_LEVEL_BINS` bins a side across the inside
/// nodes' extent (1.3 km at level 2, 650 m at level 3), spread by
/// `PARENT_LEVEL_PASSES` passes of a 3 × 3 sum, read bilinearly at each
/// node. The tile keeps the valleys and ridges its erosion cut, about the
/// parent's surface — the level the edge holds. After it: the edge over
/// the land beside it −3 m on the mean at level 2 (p90 12 m, p99 51 m),
/// 0.2 m at level 3 (p90 1.9 m); the pits on the land inside +1.5 %. With
/// 32 bins the land next to the edge stood 6 m over it (the bins were
/// wider than the pin's reach into the tile). The edge row and the halo do
/// not move, a land node does not go under the sea, the routing is the
/// bake's.
fn keep_parent_level(tile: &TileMesh, z: &mut [f32]) {
    let mesh = &tile.mesh;
    let slots = mesh.vertex_slots();
    let land = |v: usize| {
        mesh.v_alive[v] != 0
            && tile.role[v] != TILE_ROLE_EDGE
            && tile.role[v] != TILE_ROLE_HALO
            && tile.z[v] as f64 > SEA_LEVEL
    };
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for v in 0..slots {
        if mesh.v_alive[v] == 0 || tile.role[v] == TILE_ROLE_HALO {
            continue;
        }
        x0 = x0.min(mesh.vx[v]);
        y0 = y0.min(mesh.vy[v]);
        x1 = x1.max(mesh.vx[v]);
        y1 = y1.max(mesh.vy[v]);
    }
    if !(x1 > x0 && y1 > y0) {
        return;
    }
    let n = PARENT_LEVEL_BINS;
    let (bw, bh) = ((x1 - x0) / n as f64, (y1 - y0) / n as f64);
    let bin = |c: f64, lo: f64, w: f64| (((c - lo) / w) as usize).min(n - 1);
    let mut sum = vec![0f64; n * n];
    let mut count = vec![0f64; n * n];
    for v in 0..slots {
        if !land(v) {
            continue;
        }
        let b = bin(mesh.vy[v], y0, bh) * n + bin(mesh.vx[v], x0, bw);
        sum[b] += z[v] as f64 - tile.z[v] as f64;
        count[b] += 1.0;
    }
    for _ in 0..PARENT_LEVEL_PASSES {
        let (mut s2, mut c2) = (vec![0f64; n * n], vec![0f64; n * n]);
        for j in 0..n {
            for i in 0..n {
                for dj in j.saturating_sub(1)..(j + 2).min(n) {
                    for di in i.saturating_sub(1)..(i + 2).min(n) {
                        s2[j * n + i] += sum[dj * n + di];
                        c2[j * n + i] += count[dj * n + di];
                    }
                }
            }
        }
        sum = s2;
        count = c2;
    }
    for v in 0..slots {
        if !land(v) {
            continue;
        }
        // Bilinear between the bins' centres, over the bins that hold land.
        let fx = ((mesh.vx[v] - x0) / bw - 0.5).clamp(0.0, (n - 1) as f64);
        let fy = ((mesh.vy[v] - y0) / bh - 0.5).clamp(0.0, (n - 1) as f64);
        let (i, j) = ((fx as usize).min(n - 2), (fy as usize).min(n - 2));
        let (tx, ty) = (fx - i as f64, fy - j as f64);
        let (mut acc, mut weight) = (0.0, 0.0);
        for (di, dj, w) in [
            (0, 0, (1.0 - tx) * (1.0 - ty)),
            (1, 0, tx * (1.0 - ty)),
            (0, 1, (1.0 - tx) * ty),
            (1, 1, tx * ty),
        ] {
            let b = (j + dj) * n + i + di;
            if count[b] > 0.0 && w > 0.0 {
                acc += w * sum[b] / count[b];
                weight += w;
            }
        }
        if weight == 0.0 {
            continue;
        }
        let kept = (z[v] as f64 - acc / weight) as f32;
        if kept as f64 > SEA_LEVEL || z[v] as f64 <= SEA_LEVEL {
            z[v] = kept;
        }
    }
}

struct Crossing {
    x: f64,
    y: f64,
    from_x: f64,
    from_y: f64,
    discharge: f64,
}

/// Where level 1's rivers cross a torus tile's edge inward, in its frame.
fn inflow_crossings(graph: &RiverGraph, tile: &TileMesh, world: &Domain) -> Vec<Crossing> {
    let mut out = Vec::new();
    let x0 = tile.origin_x + tile.halo;
    let y0 = tile.origin_y + tile.halo;
    let local = |x: f32, y: f32| (world.wrap_x(x as f64 - x0), world.wrap_y(y as f64 - y0));
    let cells = tile_spec(tile.tile.level).cells;
    let inside = |(lx, ly): (f64, f64)| lx < cells && ly < cells;
    for reach in &graph.reaches {
        if reach.kind != RiverReachKind::River || reach.cell_count < 2 {
            continue;
        }
        let s = reach.cell_start;
        let mut p = local(graph.cell_x[s], graph.cell_y[s]);
        for i in 1..reach.cell_count {
            let q = local(graph.cell_x[s + i], graph.cell_y[s + i]);
            if !inside(p) && inside(q) {
                let t = i as f64 / (reach.cell_count - 1) as f64;
                out.push(Crossing {
                    x: q.0 + tile.halo,
                    y: q.1 + tile.halo,
                    from_x: graph.cell_x[s + i - 1] as f64,
                    from_y: graph.cell_y[s + i - 1] as f64,
                    discharge: reach.discharge_in + (reach.discharge_out - reach.discharge_in) * t,
                });
            }
            p = q;
        }
    }
    out
}

/// The crossings of a sphere tile, by its frame.
fn cube_inflow_crossings(graph: &RiverGraph, tile: &TileMesh, world: &Domain) -> Vec<Crossing> {
    let mut out = Vec::new();
    let g = cube_frame_of(world, &tile.tile, tile.halo);
    // A point off the frame keeps the last point the frame gave, as the
    // TypeScript `at` does.
    let mut at = (0.0, 0.0);
    let mut local = |x: f32, y: f32| -> (f64, f64, bool) {
        let on = match cube_to_frame(world, &g, x as f64, y as f64) {
            Some(q) => {
                at = q;
                true
            }
            None => false,
        };
        (at.0, at.1, on && tile.site.inside(at.0, at.1))
    };
    for reach in &graph.reaches {
        if reach.kind != RiverReachKind::River || reach.cell_count < 2 {
            continue;
        }
        let s = reach.cell_start;
        let mut p = local(graph.cell_x[s], graph.cell_y[s]);
        for i in 1..reach.cell_count {
            let q = local(graph.cell_x[s + i], graph.cell_y[s + i]);
            if !p.2 && q.2 {
                let t = i as f64 / (reach.cell_count - 1) as f64;
                out.push(Crossing {
                    x: q.0,
                    y: q.1,
                    from_x: graph.cell_x[s + i - 1] as f64,
                    from_y: graph.cell_y[s + i - 1] as f64,
                    discharge: reach.discharge_in + (reach.discharge_out - reach.discharge_in) * t,
                });
            }
            p = q;
        }
    }
    out
}

/// The inside node nearest an edge node, ring by ring through the mesh.
fn inside_node_near(tile: &TileMesh, e: usize) -> Option<usize> {
    let (mesh, role) = (&tile.mesh, &tile.role);
    let mut star = Vec::new();
    let mut seen: HashSet<usize> = HashSet::from([e]);
    let mut ring = vec![e];
    let mut depth = 0;
    while depth < 64 && !ring.is_empty() {
        let mut next = Vec::new();
        let mut best: Option<usize> = None;
        let mut best_d = f64::INFINITY;
        for &u in &ring {
            mesh.neighbours(u, &mut star);
            for &w in &star {
                let w = w as usize;
                if !seen.insert(w) {
                    continue;
                }
                if role[w] == TILE_ROLE_HALO {
                    continue;
                }
                if role[w] != TILE_ROLE_EDGE {
                    let d = mesh
                        .domain
                        .distance_sq(mesh.vx[w], mesh.vy[w], mesh.vx[e], mesh.vy[e]);
                    if d < best_d || (d == best_d && best.is_some_and(|b| w < b)) {
                        best_d = d;
                        best = Some(w);
                    }
                } else {
                    next.push(w);
                }
            }
        }
        if best.is_some() {
            return best;
        }
        ring = next;
        depth += 1;
    }
    None
}

/// The tile node nearest a point inside it that is neither edge nor halo.
fn first_inside_node(tile: &mut TileMesh, x: f64, y: f64) -> Option<usize> {
    let t = tile.mesh.locate(x, y, None);
    let mesh = &tile.mesh;
    let mut candidates = Vec::new();
    let mut star = Vec::new();
    for c in 0..3 {
        let v = mesh.tris[3 * t + c] as usize;
        candidates.push(v);
        mesh.neighbours(v, &mut star);
        candidates.extend(star.iter().map(|&w| w as usize));
    }
    let mut best = None;
    let mut best_d = f64::INFINITY;
    for v in candidates {
        if tile.role[v] == TILE_ROLE_EDGE || tile.role[v] == TILE_ROLE_HALO {
            continue;
        }
        let d = mesh.domain.distance_sq(mesh.vx[v], mesh.vy[v], x, y);
        if d < best_d {
            best_d = d;
            best = Some(v);
        }
    }
    best
}
