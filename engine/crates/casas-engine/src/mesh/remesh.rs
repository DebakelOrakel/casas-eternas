//! REMESHING with hysteresis (decision 8 of
//! docs/decisions/adaptive-mesh.md). Nodes go in where an edge is longer
//! than `insert_ratio` times the target and out where a node's spacing is
//! below `remove_ratio` times it; candidates in Hilbert order, the jitter
//! from a generator seeded per round. The reasoning is in the TypeScript
//! port (`client/src/generator/mesh/remesh.ts`, git history).

use crate::core::det_math::sq;
use crate::core::js;
use crate::core::rng::Mulberry32;

use super::hilbert::hilbert_order;
use super::mesh_density::MESH_TUNING;
use super::mesh_state::MeshState;
use super::periodic_delaunay::PeriodicTriangulation;

/// A target spacing per vertex in DOMAIN units, into `targets` (one per
/// vertex slot). `changed`, when given: only these nodes and their
/// neighbours can have a target other than the one in `targets`.
pub trait TargetSpacing {
    fn targets(
        &mut self,
        mesh: &PeriodicTriangulation,
        state: &MeshState,
        targets: &mut [f64],
        changed: Option<&[u32]>,
    );
}

/// Sets the sampled fields of every inserted vertex after its state was
/// interpolated: the mesh as it stands, the vertex, its position, the
/// corners it came from.
pub type Sample<'a> =
    &'a mut dyn FnMut(&mut MeshState, &PeriodicTriangulation, usize, f64, f64, usize, usize, usize);

pub struct RefineOptions<'a> {
    pub seed: u32,
    pub sample: Option<Sample<'a>>,
    pub max_rounds: usize,
    /// Jitter across the edge, as a fraction of its length.
    pub jitter: f64,
}

impl RefineOptions<'_> {
    pub fn seeded(seed: u32) -> Self {
        RefineOptions {
            seed,
            sample: None,
            max_rounds: 24,
            jitter: 0.25,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RemeshStats {
    pub rounds: usize,
    pub inserted: usize,
    pub removed: usize,
    /// Per round, the nodes in (refine) or out (coarsen; negated in a
    /// combined trace, where a round of none is −0, as in TypeScript).
    pub per_round: Vec<f64>,
}

fn grow(targets: &mut Vec<f64>, slots: usize) {
    if targets.len() < slots {
        targets.resize(slots, 0.0);
    }
}

/// Inserts until no edge exceeds the insertion threshold (or `max_rounds`).
pub fn refine(
    mesh: &mut PeriodicTriangulation,
    state: &mut MeshState,
    target: &mut dyn TargetSpacing,
    options: &mut RefineOptions,
) -> RemeshStats {
    let insert_ratio = MESH_TUNING.insert_ratio;
    let remove_ratio = MESH_TUNING.remove_ratio;
    let jitter = options.jitter;
    let mut targets = vec![0.0; mesh.vertex_slots()];
    let mut inserted = 0;
    let mut round = 0;
    let mut per_round = Vec::new();
    let mut inserted_last: Option<Vec<u32>> = None;
    while round < options.max_rounds {
        state.ensure(mesh);
        grow(&mut targets, mesh.vertex_slots());
        target.targets(mesh, state, &mut targets, inserted_last.as_deref());
        let mut this_round: Vec<u32> = Vec::new();
        // Candidates: one per long edge, the halfedge with the smaller id.
        let (mut cx, mut cy, mut ca, mut cb) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for t in 0..mesh.tri_slots() {
            if mesh.t_alive[t] == 0 {
                continue;
            }
            for i in 0..3 {
                let e = 3 * t + i;
                if (mesh.twin[e] as i64) < e as i64 {
                    continue;
                }
                let a = mesh.from(e);
                let b = mesh.to(e);
                let h = js::min(targets[a], targets[b]);
                let lsq = mesh.edge_length_sq(e);
                if lsq <= sq(insert_ratio * h) {
                    continue;
                }
                let ax = mesh.vx[a];
                let ay = mesh.vy[a];
                let offset = mesh.domain.delta(mesh.vx[b], mesh.vy[b], ax, ay);
                let mid = mesh.domain.displace(ax, ay, offset.x / 2.0, offset.y / 2.0);
                cx.push(mid.x);
                cy.push(mid.y);
                ca.push(a);
                cb.push(b);
            }
        }
        if cx.is_empty() {
            break;
        }
        let (width, height) = (mesh.domain.width, mesh.domain.height);
        let order = hilbert_order(&cx, &cy, cx.len(), width, height);
        let mut rng = Mulberry32::new(options.seed ^ (round as u32 + 1).wrapping_mul(0x9e3779b1));
        for &c in &order {
            let (a, b) = (ca[c as usize], cb[c as usize]);
            if mesh.v_alive[a] == 0 || mesh.v_alive[b] == 0 || !adjacent(mesh, a, b) {
                continue;
            }
            let ax = mesh.vx[a];
            let ay = mesh.vy[a];
            let offset = mesh.domain.delta(mesh.vx[b], mesh.vy[b], ax, ay);
            let (ex, ey) = (offset.x, offset.y);
            let across = (rng.next() * 2.0 - 1.0) * jitter;
            let along = 0.5 + (rng.next() * 2.0 - 1.0) * jitter * 0.5;
            let mid = mesh.domain.displace(ax, ay, ex * along, ey * along);
            let side = mesh
                .domain
                .transport(-ey * across, ex * across, ax, ay, mid.x, mid.y);
            let point = mesh.domain.advance(mid.x, mid.y, side.x, side.y);
            let (mut px, mut py) = (point.x, point.y);
            let hint = mesh.triangle_of(mesh.v_edge[a] as usize);
            let mut t = mesh.locate(px, py, Some(hint));
            if mesh.at_vertex >= 0 {
                continue;
            }
            let mut corners = mesh_corners(mesh, t);
            if too_close(mesh, px, py, corners, remove_ratio, &targets) {
                let point = mesh.domain.advance(ax, ay, ex / 2.0, ey / 2.0);
                px = point.x;
                py = point.y;
                t = mesh.locate(px, py, Some(t));
                if mesh.at_vertex >= 0 {
                    continue;
                }
                corners = mesh_corners(mesh, t);
                if too_close(mesh, px, py, corners, remove_ratio, &targets) {
                    continue;
                }
            }
            let (ta, tb, tc) = corners;
            let bary = mesh.barycentric(t, px, py);
            let alive = mesh.alive_vertices;
            let v = mesh.insert(px, py, Some(t));
            if mesh.alive_vertices == alive {
                // The point's float32 position is a vertex's position: the
                // insert returned that vertex and added nothing (TEG-115).
                // `too_close` refuses such a point first, but a target near
                // zero can let one through; that vertex keeps its state.
                continue;
            }
            state.ensure(mesh);
            grow(&mut targets, mesh.vertex_slots());
            state.inherit_insert(v, ta, tb, tc, bary[0], bary[1], bary[2]);
            targets[v] = js::min(js::min(targets[ta], targets[tb]), targets[tc]);
            if let Some(sample) = options.sample.as_mut() {
                sample(state, mesh, v, mesh.vx[v], mesh.vy[v], ta, tb, tc);
            }
            this_round.push(v as u32);
        }
        let count = this_round.len();
        inserted += count;
        per_round.push(count as f64);
        inserted_last = Some(this_round);
        if count == 0 {
            break;
        }
        round += 1;
    }
    RemeshStats {
        rounds: round,
        inserted,
        removed: 0,
        per_round,
    }
}

fn mesh_corners(mesh: &PeriodicTriangulation, t: usize) -> (usize, usize, usize) {
    (mesh.from(3 * t), mesh.from(3 * t + 1), mesh.from(3 * t + 2))
}

/// Removes nodes whose mean incident edge length is below the removal
/// threshold of their EFFECTIVE target (the finest of their own and their
/// neighbours'), in Hilbert order.
pub fn coarsen(
    mesh: &mut PeriodicTriangulation,
    state: &mut MeshState,
    target: &mut dyn TargetSpacing,
    max_rounds: usize,
) -> RemeshStats {
    let remove_ratio = MESH_TUNING.remove_ratio;
    let mut targets = vec![0.0; mesh.vertex_slots()];
    let mut removed = 0;
    let mut round = 0;
    let mut per_round = Vec::new();
    let mut nbrs: Vec<u32> = Vec::with_capacity(16);
    let mut before: Vec<f64> = Vec::with_capacity(16);
    let mut after: Vec<f64> = Vec::with_capacity(16);
    while round < max_rounds {
        state.ensure(mesh);
        if targets.len() < mesh.vertex_slots() {
            targets = vec![0.0; mesh.vertex_slots()];
        }
        target.targets(mesh, state, &mut targets, None);
        let slots = mesh.vertex_slots();
        let order = hilbert_order(
            &mesh.vx,
            &mesh.vy,
            slots,
            mesh.domain.width,
            mesh.domain.height,
        );
        let mut removed_this_round = 0;
        for &v in &order {
            let v = v as usize;
            if mesh.v_alive[v] == 0 {
                continue;
            }
            mesh.neighbours(v, &mut nbrs);
            // The TypeScript engine reads at most 256 neighbours.
            if nbrs.len() > 256 {
                continue;
            }
            let mut h = targets[v];
            for &u in &nbrs {
                if targets[u as usize] < h {
                    h = targets[u as usize];
                }
            }
            if mean_spacing(mesh, v) >= remove_ratio * h {
                continue;
            }
            let area_v = mesh.voronoi_area(v);
            before.clear();
            for &u in &nbrs {
                before.push(mesh.voronoi_area(u as usize));
            }
            if !mesh.remove(v) {
                continue;
            }
            after.clear();
            for &u in &nbrs {
                after.push(mesh.voronoi_area(u as usize));
            }
            state.inherit_remove(v, &nbrs, &before, &after, area_v);
            removed_this_round += 1;
        }
        removed += removed_this_round;
        per_round.push(removed_this_round as f64);
        if removed_this_round == 0 {
            break;
        }
        round += 1;
    }
    RemeshStats {
        rounds: round,
        inserted: 0,
        removed,
        per_round,
    }
}

/// Coarsen, then refine: the between-epochs step.
pub fn remesh(
    mesh: &mut PeriodicTriangulation,
    state: &mut MeshState,
    target: &mut dyn TargetSpacing,
    coarsen_rounds: usize,
    options: &mut RefineOptions,
) -> RemeshStats {
    let c = coarsen(mesh, state, target, coarsen_rounds);
    let r = refine(mesh, state, target, options);
    let mut per_round = c.per_round;
    per_round.extend(r.per_round);
    RemeshStats {
        rounds: c.rounds + r.rounds,
        inserted: r.inserted,
        removed: c.removed,
        per_round,
    }
}

pub fn mean_spacing(mesh: &PeriodicTriangulation, v: usize) -> f64 {
    let start = mesh.v_edge[v] as usize;
    let mut e = start;
    let mut sum = 0.0;
    let mut n = 0;
    loop {
        sum += mesh.edge_length(e);
        n += 1;
        e = mesh.rotate_ccw(e);
        if e == start {
            break;
        }
    }
    sum / n as f64
}

fn too_close(
    mesh: &PeriodicTriangulation,
    px: f64,
    py: f64,
    (a, b, c): (usize, usize, usize),
    ratio: f64,
    targets: &[f64],
) -> bool {
    let d = &mesh.domain;
    let h = ratio * js::min(js::min(targets[a], targets[b]), targets[c]);
    let hsq = h * h;
    d.distance_sq(px, py, mesh.vx[a], mesh.vy[a]) < hsq
        || d.distance_sq(px, py, mesh.vx[b], mesh.vy[b]) < hsq
        || d.distance_sq(px, py, mesh.vx[c], mesh.vy[c]) < hsq
}

fn adjacent(mesh: &PeriodicTriangulation, a: usize, b: usize) -> bool {
    let start = mesh.v_edge[a] as usize;
    let mut e = start;
    loop {
        if mesh.to(e) == b {
            return true;
        }
        e = mesh.rotate_ccw(e);
        if e == start {
            return false;
        }
    }
}
