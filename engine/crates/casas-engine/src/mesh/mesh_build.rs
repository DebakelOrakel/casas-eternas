//! `mesh/meshBuild.ts`: BUILDING A MESH from point-evaluable fields (the
//! bootstrap lattice at the ocean spacing, refinement under the density
//! rule, one coarsen), the density rule as a target over the mesh's own
//! state, and the triangulation of a given point set (the coupled loop's
//! rebuild). The reasoning is in the TypeScript file.

use crate::core::domain::Domain;
use crate::elevation::elevation_scale::ELEVATION_METERS;

use super::lattice::bootstrap_lattice;
use super::mesh_column::{COLUMN_TUNING, MESH_COLUMN, column_thickness};
use super::mesh_density::{MESH_TUNING, target_spacing_m};
use super::mesh_relief::relief_at;
use super::mesh_state::{FieldKind, MeshState};
use super::periodic_delaunay::PeriodicTriangulation;
use super::remesh::{RefineOptions, RemeshStats, TargetSpacing, coarsen, refine};

pub const MESH_Z: &str = "z";
pub const MESH_DISCHARGE: &str = "discharge";

/// The fields a mesh is built from, evaluable at any point: height in
/// elevation units, discharge in m³/s when there is one.
pub trait FieldSampler {
    fn height_at(&self, x: f64, y: f64) -> f64;
    fn discharge_at(&self, _x: f64, _y: f64) -> Option<f64> {
        None
    }
    fn has_discharge(&self) -> bool {
        false
    }
}

/// The density rule over the mesh's own state: slope and curvature from
/// the node's star, discharge and the sediment column from the node.
pub struct DensityTarget {
    pub budget: f64,
}

impl TargetSpacing for DensityTarget {
    fn targets(
        &mut self,
        mesh: &PeriodicTriangulation,
        state: &MeshState,
        targets: &mut [f64],
        changed: Option<&[u32]>,
    ) {
        let units_to_m = mesh.domain.metres_per_unit;
        let z = state.get(MESH_Z);
        let q = if state.has(MESH_DISCHARGE) {
            Some(state.get(MESH_DISCHARGE))
        } else {
            None
        };
        let column = if state.has(MESH_COLUMN) {
            Some(state.get(MESH_COLUMN))
        } else {
            None
        };
        let built = if state.has("h") {
            Some(state.get("h"))
        } else {
            None
        };
        let budget = self.budget;
        let at = |v: usize, targets: &mut [f64]| {
            let (slope, curvature) = relief_at(mesh, z, v, units_to_m, ELEVATION_METERS);
            let column_m = column.map_or(0.0, |c| column_thickness(c, v, COLUMN_TUNING.layer_cap));
            let h = target_spacing_m(
                slope,
                q.map_or(0.0, |q| q[v] as f64),
                curvature,
                column_m,
                z[v] as f64 * ELEVATION_METERS,
                built.map_or(0.0, |h| h[v] as f64 * ELEVATION_METERS),
                budget,
            );
            targets[v] = h / units_to_m;
        };
        let Some(changed) = changed else {
            for v in 0..mesh.vertex_slots() {
                if mesh.v_alive[v] != 0 {
                    at(v, targets);
                }
            }
            return;
        };
        let mut done = vec![0u8; mesh.vertex_slots()];
        let mut star = Vec::with_capacity(16);
        for &v in changed {
            let v = v as usize;
            if mesh.v_alive[v] == 0 {
                continue;
            }
            if done[v] == 0 {
                done[v] = 1;
                at(v, targets);
            }
            mesh.neighbours(v, &mut star);
            for &u in &star {
                let u = u as usize;
                if done[u] != 0 {
                    continue;
                }
                done[u] = 1;
                at(u, targets);
            }
        }
    }
}

pub struct BuiltMesh {
    pub mesh: PeriodicTriangulation,
    pub state: MeshState,
    pub stats: RemeshStats,
}

/// A triangulation of a given point set, vertex i of the result point i
/// (`mapping` says which vertex a point that coincides with an earlier one
/// collapsed onto). Inserted into the bootstrap lattice in the order given,
/// the lattice removed after.
pub fn triangulate_points(
    domain: &Domain,
    xs: &[f64],
    ys: &[f64],
    lattice_spacing: f64,
) -> (PeriodicTriangulation, Vec<u32>) {
    // The TypeScript engine builds the lattice once per domain and spacing
    // and copies it; a copy is the lattice's state with an empty area cache.
    let mut mesh = bootstrap_lattice(domain, lattice_spacing).clone();
    let lattice_count = mesh.vertex_slots();
    let mut mapping = vec![0u32; xs.len()];
    let mut again = Vec::new();
    for i in 0..xs.len() {
        mapping[i] = mesh.insert(xs[i], ys[i], None) as u32;
        if (mapping[i] as usize) < lattice_count {
            again.push(i);
        }
    }
    for v in 0..lattice_count {
        if mesh.v_alive[v] != 0 {
            mesh.remove(v);
        }
    }
    for i in again {
        mapping[i] = mesh.insert(xs[i], ys[i], None) as u32;
    }
    (mesh, mapping)
}

pub fn build_mesh(
    domain: &Domain,
    sampler: &dyn FieldSampler,
    seed: u32,
    budget: f64,
    max_rounds: usize,
) -> BuiltMesh {
    let mut mesh = bootstrap_lattice(
        domain,
        (MESH_TUNING.ocean_spacing_m * budget) / domain.metres_per_unit,
    );
    let mut state = MeshState::new(mesh.vertex_slots() * 4);
    state.add(MESH_Z, FieldKind::Intensive, 1);
    if sampler.has_discharge() {
        state.add(MESH_DISCHARGE, FieldKind::Intensive, 1);
    }
    let mut sample = |state: &mut MeshState,
                      _: &PeriodicTriangulation,
                      v: usize,
                      x: f64,
                      y: f64,
                      _a: usize,
                      _b: usize,
                      _c: usize| {
        state.get_mut(MESH_Z)[v] = sampler.height_at(x, y) as f32;
        if let Some(q) = sampler.discharge_at(x, y) {
            state.get_mut(MESH_DISCHARGE)[v] = q as f32;
        }
    };
    for v in 0..mesh.vertex_slots() {
        sample(&mut state, &mesh, v, mesh.vx[v], mesh.vy[v], 0, 0, 0);
    }
    let mut target = DensityTarget { budget };
    let mut options = RefineOptions::seeded(seed);
    options.max_rounds = max_rounds;
    options.sample = Some(&mut sample);
    let mut stats = refine(&mut mesh, &mut state, &mut target, &mut options);
    let settled = coarsen(&mut mesh, &mut state, &mut target, 4);
    stats.removed = settled.removed;
    stats.rounds += settled.rounds;
    stats.per_round.extend(settled.per_round.iter().map(|n| -n));
    BuiltMesh { mesh, state, stats }
}
