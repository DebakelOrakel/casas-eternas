//! `mesh/meshErosion.ts`: EROSION ON THE MESH, the engine's graph index
//! built from the triangulation (ADAPTIVE_MESH_PLAN.md phase 4.2). A node's
//! neighbours are its Delaunay star, a reach the edge's length, the facet
//! over it the dual Voronoi edge in the cotangent form, a node's area its
//! Voronoi cell; the frozen deep ocean and the shelf band as on the raster.
//! The reasoning is in the TypeScript file. The run itself
//! (`runMeshErosion`) comes with the engine.
//!
//! Not ported, because they change the time and nothing else: the reuse of
//! an unchanged index and the per-mesh cache of the cotangents.

use crate::core::js;
use crate::core::min_heap::MinHeap;
use crate::core::shared::{block_ranges, for_ranges};
use crate::surface::erosion_engine::{
    DEFAULT_SOLVER_PARAMS, ErosionForcing, ErosionSolver, ErosionSolverParams,
    PipelinedErosionSolver, Tallies,
};
use crate::surface::erosion_engine_state::{
    EngineIndex, IndexKind, Routing, Terrain, expand_active, expand_active_with,
};

use super::periodic_delaunay::PeriodicTriangulation;

/// Iterations between two routings of the drainage when the caller names
/// none.
pub const DEFAULT_ROUTING_EVERY: u32 = 4;

/// The engine index over the mesh for a terrain z (per vertex slot).
/// `shelf_band_km` is the engine's `shelfBandKm`, `ref_m` the reference
/// length (the domain's metres per unit), `extra_frozen` nodes frozen besides
/// the deep ocean (a tile's halo).
pub fn build_mesh_engine_index(
    mesh: &mut PeriodicTriangulation,
    z: &[f32],
    shelf_band_km: f64,
    ref_m: f64,
    extra_frozen: Option<&[u8]>,
) -> EngineIndex {
    let slots = mesh.vertex_slots();
    let mut star: Vec<u32> = Vec::with_capacity(16);
    // The world ocean: the largest component of z ≤ 0 over alive vertices.
    let mut label = vec![-1i32; slots];
    let mut stack: Vec<usize> = Vec::with_capacity(slots);
    let mut sizes: Vec<u32> = Vec::new();
    for v in 0..slots {
        if mesh.v_alive[v] == 0 || z[v] > 0.0 || label[v] != -1 {
            continue;
        }
        let id = sizes.len() as i32;
        let mut size = 0;
        stack.clear();
        stack.push(v);
        label[v] = id;
        while let Some(i) = stack.pop() {
            size += 1;
            mesh.neighbours(i, &mut star);
            for &u in &star {
                let u = u as usize;
                if z[u] <= 0.0 && label[u] == -1 {
                    label[u] = id;
                    stack.push(u);
                }
            }
        }
        sizes.push(size);
    }
    let mut ocean_id = -1i32;
    for (id, &size) in sizes.iter().enumerate() {
        if ocean_id < 0 || size > sizes[ocean_id as usize] {
            ocean_id = id as i32;
        }
    }
    // The band: multi-source Dijkstra from every non-ocean node along the
    // edges, in domain units; ocean nodes beyond it are frozen, but for the
    // first ring around land.
    let mut frozen = vec![0u8; slots];
    let mut frozen_count = 0u32;
    if ocean_id >= 0 {
        let band_units = (shelf_band_km * 1000.0) / ref_m;
        let mut dist = vec![f64::INFINITY; slots];
        let mut heap = MinHeap::new(slots);
        for v in 0..slots {
            if mesh.v_alive[v] == 0 || label[v] == ocean_id {
                continue;
            }
            dist[v] = 0.0;
            heap.push(0.0, v as i32);
        }
        while !heap.is_empty() {
            heap.pop();
            let key = heap.popped_key;
            let v = heap.popped_index as usize;
            if key > dist[v] || key >= band_units {
                continue;
            }
            let start = mesh.v_edge[v] as usize;
            let mut e = start;
            loop {
                let u = mesh.to(e);
                let d = key + mesh.edge_length(e);
                if d < dist[u] {
                    dist[u] = d;
                    heap.push(d, u as i32);
                }
                e = mesh.rotate_ccw(e);
                if e == start {
                    break;
                }
            }
        }
        for v in 0..slots {
            if mesh.v_alive[v] == 0 || label[v] != ocean_id || dist[v] <= band_units {
                continue;
            }
            let mut touches_land = false;
            let start = mesh.v_edge[v] as usize;
            let mut e = start;
            loop {
                if label[mesh.to(e)] != ocean_id {
                    touches_land = true;
                    break;
                }
                e = mesh.rotate_ccw(e);
                if e == start {
                    break;
                }
            }
            if touches_land {
                continue;
            }
            frozen[v] = 1;
            frozen_count += 1;
        }
    }
    if let Some(extra) = extra_frozen {
        for v in 0..slots {
            if mesh.v_alive[v] == 0 || frozen[v] != 0 || extra[v] == 0 {
                continue;
            }
            frozen[v] = 1;
            frozen_count += 1;
        }
    }
    // Active indices in vertex order.
    let mut active = Vec::new();
    let mut active_of = vec![-1i32; slots];
    for v in 0..slots {
        if mesh.v_alive[v] == 0 || frozen[v] != 0 {
            continue;
        }
        active_of[v] = active.len() as i32;
        active.push(v as i32);
    }
    let active_count = active.len();
    // The CSR tables.
    let mut nbr_start = vec![0i32; active_count + 1];
    let mut edge_count = 0usize;
    for k in 0..active_count {
        nbr_start[k] = edge_count as i32;
        let degree = mesh.degree(active[k] as usize);
        assert!(
            degree <= 254,
            "buildMeshEngineIndex: degree {degree} exceeds the slot range"
        );
        edge_count += degree;
    }
    nbr_start[active_count] = edge_count as i32;
    let mut nbr = vec![0i32; edge_count];
    let mut edge_rev = vec![-1i32; edge_count];
    let mut len_rel = vec![0f32; edge_count];
    let mut diff_factor = vec![0f32; edge_count];
    let mut mfd_factor = vec![0f32; edge_count];
    let mut area_rel = vec![0f32; active_count];
    let mut slot_edge = vec![0usize; edge_count];
    let mut slot_of_edge = vec![-1i32; mesh.twin.len()];
    let cot = apex_cotangents(mesh);
    let mut outgoing: Vec<u32> = Vec::with_capacity(16);
    for k in 0..active_count {
        let v = active[k] as usize;
        mesh.outgoing(v, &mut outgoing);
        let n = outgoing.len();
        // The run starts at the neighbour with the smallest vertex id.
        let mut first = 0;
        for s in 1..n {
            if mesh.to(outgoing[s] as usize) < mesh.to(outgoing[first] as usize) {
                first = s;
            }
        }
        let base = nbr_start[k] as usize;
        area_rel[k] = mesh.voronoi_area(v) as f32;
        for s in 0..n {
            let e = outgoing[(first + s) % n] as usize;
            let u = mesh.to(e);
            slot_edge[base + s] = e;
            slot_of_edge[e] = (base + s) as i32;
            nbr[base + s] = active_of[u];
            len_rel[base + s] = mesh.edge_length(e) as f32;
            let c = cot[e] + cot[mesh.twin[e] as usize];
            let geom = js::max(0.0, c / 2.0) as f32;
            diff_factor[base + s] = geom;
            mfd_factor[base + s] = geom;
        }
    }
    for k in 0..active_count {
        let (base, end) = (nbr_start[k] as usize, nbr_start[k + 1] as usize);
        for s in base..end {
            let j = nbr[s];
            if j < 0 {
                continue;
            }
            let t = slot_of_edge[mesh.twin[slot_edge[s]] as usize];
            if t >= nbr_start[j as usize] && t < nbr_start[j as usize + 1] {
                edge_rev[s] = t;
            }
            assert!(
                edge_rev[s] >= 0,
                "buildMeshEngineIndex: reverse edge not found"
            );
        }
    }
    EngineIndex {
        kind: IndexKind::Mesh,
        width: 0,
        height: 0,
        cell_count: slots as u32,
        active_count: active_count as u32,
        active,
        active_of,
        frozen_count,
        nbr_start,
        nbr,
        edge_count: edge_count as u32,
        edge_rev,
        len_rel,
        diff_factor,
        mfd_factor,
        area_rel,
        ref_m,
    }
}

/// The cotangent at the apex of every halfedge of a live triangle (NaN on
/// a dead one), a triangle's three from one frame.
/// The triangles in fixed blocks on rayon's pool (`for_ranges`): each
/// value is its own triangle's.
pub fn apex_cotangents(mesh: &PeriodicTriangulation) -> Vec<f64> {
    let ranges = block_ranges(mesh.tri_slots(), COT_BLOCK);
    let mut cot = for_ranges(&ranges, |r| {
        let mut out = Vec::with_capacity(3 * r.len());
        for t in r {
            if mesh.t_alive[t] == 0 {
                out.extend([f64::NAN; 3]);
                continue;
            }
            let f = mesh.frame(t);
            out.extend((0..3).map(|i| cot_in_frame(&f, i)));
        }
        out
    })
    .concat();
    cot.resize(mesh.twin.len(), f64::NAN);
    cot
}

/// The triangles of one block of `apex_cotangents`.
const COT_BLOCK: usize = 8192;

/// Cotangent of the angle at the apex of halfedge e's triangle (the corner
/// opposite e), in the triangle's frame.
pub fn cot_at_apex(mesh: &PeriodicTriangulation, e: usize) -> f64 {
    let t = mesh.triangle_of(e);
    cot_in_frame(&mesh.frame(t), e - 3 * t)
}

fn cot_in_frame(f: &[f64; 6], i: usize) -> f64 {
    let ax = f[(2 * i) % 6];
    let ay = f[(2 * i + 1) % 6];
    let bx = f[(2 * i + 2) % 6];
    let by = f[(2 * i + 3) % 6];
    let px = f[(2 * i + 4) % 6];
    let py = f[(2 * i + 5) % 6];
    let ux = ax - px;
    let uy = ay - py;
    let wx = bx - px;
    let wy = by - py;
    let cross = ux * wy - uy * wx;
    if cross == 0.0 {
        return 0.0;
    }
    (ux * wx + uy * wy) / cross.abs()
}

/// The drainage of a run per vertex slot (`MeshRouting` in TypeScript).
#[derive(Clone, Debug)]
pub struct MeshRouting {
    pub flow_target: Vec<i32>,
    pub filled: Vec<f32>,
    pub accumulation: Vec<f32>,
    /// Vertex ids in the flood's pop order, `popped_count` of them.
    pub pop_order: Vec<i32>,
    pub popped_count: usize,
}

/// What a run gives back per vertex slot (`MeshErosionResult` in
/// TypeScript, which explains each field).
#[derive(Clone, Debug)]
pub struct MeshErosionResult {
    pub z: Vec<f32>,
    pub routing: MeshRouting,
    pub sediment_flux: Vec<f32>,
    pub eroded_flux_m3: f64,
    pub exported_flux_m3: f64,
    pub index: EngineIndex,
    pub cut_m3: Vec<f32>,
    pub deposit_m3: Vec<f32>,
    pub deposit_coarse_m3: Vec<f32>,
    pub hill_net_m3: Vec<f32>,
    pub uplift_m3: Vec<f32>,
    pub deposit_craton: Vec<f32>,
    pub deposit_hard: Vec<f32>,
}

/// The pool's scheme for a run (`PipelineOptions` in TypeScript): the
/// cadence, whether each boundary refreshes from its own terrain, and the
/// stencil worker count the tallies are summed over.
#[derive(Clone, Copy, Debug)]
pub struct MeshPipeline {
    pub pipeline_depth: u32,
    pub synchronous: bool,
    pub stencil_workers: usize,
}

/// A run's options (`MeshErosionOptions` in TypeScript, less the
/// callbacks).
#[derive(Clone, Copy, Debug)]
pub struct MeshErosionOptions<'a> {
    pub age: u32,
    pub routing_every: Option<u32>,
    pub params: Option<ErosionSolverParams>,
    pub pool: Option<MeshPipeline>,
    pub frozen: Option<&'a [u8]>,
}

/// The progress chunks a run is taken in: the calm streak starts again at
/// each, as in TypeScript.
const PROGRESS_CHUNKS: u32 = 8;

/// Erodes the mesh's terrain: `initial` and the forcing per vertex slot.
/// On the pool's scheme when `pool` is set, the single solver's otherwise.
pub fn run_mesh_erosion(
    mesh: &mut PeriodicTriangulation,
    initial: &[f32],
    forcing: &ErosionForcing,
    options: &MeshErosionOptions,
) -> MeshErosionResult {
    let params = options.params.unwrap_or(DEFAULT_SOLVER_PARAMS);
    let ref_m = mesh.domain.metres_per_unit;
    let index = build_mesh_engine_index(mesh, initial, params.shelf_band_km, ref_m, options.frozen);
    let chunk_size = options.age.div_ceil(PROGRESS_CHUNKS).max(1);
    let chunks = |run: &mut dyn FnMut(u32)| {
        let mut done = 0;
        while done < options.age {
            let step = chunk_size.min(options.age - done);
            run(step);
            done += step;
        }
    };
    if let Some(pool) = options.pool {
        let mut engine = PipelinedErosionSolver::new(
            index,
            initial,
            forcing,
            params,
            pool.pipeline_depth,
            pool.synchronous,
            pool.stencil_workers,
        );
        chunks(&mut |step| {
            engine.run(step, |_, _| {});
        });
        let popped = engine.finalize_routing();
        let tallies = engine.tallies;
        let routing = engine.active_routing();
        return collect(
            &engine.index,
            &engine.terrain,
            routing,
            popped,
            initial,
            tallies,
        );
    }
    let mut engine = ErosionSolver::on_index(index, initial, forcing, params);
    let routing_every = options.routing_every.unwrap_or(DEFAULT_ROUTING_EVERY);
    chunks(&mut |step| {
        engine.run(step, routing_every, |_, _| {});
    });
    engine.refresh_routing();
    collect(
        &engine.index,
        &engine.terrain,
        &engine.routing,
        engine.popped_count,
        initial,
        engine.tallies,
    )
}

fn collect(
    index: &EngineIndex,
    t: &Terrain,
    r: &Routing,
    popped: usize,
    initial: &[f32],
    tallies: Tallies,
) -> MeshErosionResult {
    let active = &index.active;
    // Both classes: the consumers read one flux.
    let flux: Vec<f32> = (0..index.active_count as usize)
        .map(|a| (t.flux[a] as f64 + t.flux_coarse[a] as f64) as f32)
        .collect();
    let mut flow_target = vec![-1i32; index.cell_count as usize];
    for (a, &target) in r.flow_target.iter().enumerate() {
        if target >= 0 {
            flow_target[active[a] as usize] = active[target as usize];
        }
    }
    let pop_order: Vec<i32> = r.pop_order[..popped]
        .iter()
        .map(|&a| active[a as usize])
        .collect();
    MeshErosionResult {
        z: expand_active(index, &t.z, initial),
        routing: MeshRouting {
            flow_target,
            filled: expand_active(index, &r.filled, initial),
            accumulation: expand_active_with(index, &r.accumulation, 0.0),
            pop_order,
            popped_count: popped,
        },
        sediment_flux: expand_active_with(index, &flux, 0.0),
        eroded_flux_m3: tallies.eroded,
        exported_flux_m3: tallies.exported,
        cut_m3: expand_active_with(index, &t.cut_volume, 0.0),
        deposit_m3: expand_active_with(index, &t.deposit_volume, 0.0),
        deposit_coarse_m3: expand_active_with(index, &t.deposit_coarse, 0.0),
        hill_net_m3: expand_active_with(index, &t.hill_net, 0.0),
        uplift_m3: expand_active_with(index, &t.uplift_net, 0.0),
        deposit_craton: expand_active_with(index, &t.deposit_craton, 0.0),
        deposit_hard: expand_active_with(index, &t.deposit_hard, 0.0),
        index: index.clone(),
    }
}
