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
use crate::surface::erosion_engine_state::{EngineIndex, IndexKind};

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
pub fn apex_cotangents(mesh: &PeriodicTriangulation) -> Vec<f64> {
    let mut cot = vec![f64::NAN; mesh.twin.len()];
    for t in 0..mesh.tri_slots() {
        if mesh.t_alive[t] == 0 {
            continue;
        }
        let f = mesh.frame(t);
        for i in 0..3 {
            cot[3 * t + i] = cot_in_frame(&f, i);
        }
    }
    cot
}

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
