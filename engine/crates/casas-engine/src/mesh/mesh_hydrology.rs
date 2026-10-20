//! `mesh/meshHydrology.ts`: the mesh as the flow substrate, its nodes'
//! areas, the routing of a terrain without eroding it, and the water
//! fields on a raster from the mesh's lakes. The TypeScript file explains
//! why the raster takes each cell's nearest node's body. Not ported,
//! because it changes the time and nothing else: the reuse of an engine
//! index.

use crate::core::domain::Domain;
use crate::elevation::elevation_scale::{SEA_LEVEL, meters_to_elevation};
use crate::surface::erosion_engine::{ErosionForcing, ErosionSolver, ErosionSolverParams};
use crate::surface::flow_substrate::FlowSubstrate;
use crate::surface::hydrology::{
    SEA_WATER_LEVEL, SURFACE_ICE, SURFACE_LAKE, SURFACE_SEA, WaterBody, WaterKind,
};
use crate::surface::surface_tune_params::SURFACE_TUNING;

use super::mesh_erosion::{MeshRouting, build_mesh_engine_index};
use super::periodic_delaunay::PeriodicTriangulation;

/// The mesh's nodes as the flow substrate.
pub struct MeshSubstrate<'a> {
    pub mesh: &'a PeriodicTriangulation,
    pub routing: &'a MeshRouting,
    pub areas: &'a [f32],
}

impl FlowSubstrate for MeshSubstrate<'_> {
    fn domain(&self) -> &Domain {
        &self.mesh.domain
    }
    fn count(&self) -> usize {
        self.mesh.vertex_slots()
    }
    fn filled(&self) -> &[f32] {
        &self.routing.filled
    }
    fn flow_target(&self) -> &[i32] {
        &self.routing.flow_target
    }
    fn pop_order(&self) -> &[i32] {
        &self.routing.pop_order
    }
    fn popped_count(&self) -> usize {
        self.routing.popped_count
    }
    fn x(&self, c: usize) -> f64 {
        self.mesh.vx[c]
    }
    fn y(&self, c: usize) -> f64 {
        self.mesh.vy[c]
    }
    fn px(&self, c: usize) -> f64 {
        self.mesh.vx[c]
    }
    fn py(&self, c: usize) -> f64 {
        self.mesh.vy[c]
    }
    fn area(&self, c: usize) -> f64 {
        self.areas[c] as f64
    }
    fn step(&self, a: usize, b: usize) -> f64 {
        let m = self.mesh;
        let d = m
            .domain
            .distance_sq(m.vx[a], m.vy[a], m.vx[b], m.vy[b])
            .sqrt();
        if d == 0.0 || d.is_nan() { 1.0 } else { d }
    }
    fn facet_neighbours(&self, c: usize, out: &mut Vec<u32>) {
        if self.mesh.v_alive[c] != 0 {
            self.mesh.neighbours(c, out);
        } else {
            out.clear();
        }
    }
    fn rim_neighbours(&self, c: usize, out: &mut Vec<u32>) {
        self.facet_neighbours(c, out);
    }
}

/// Every node's Voronoi area in domain units² (0 for a dead slot).
pub fn mesh_areas(mesh: &mut PeriodicTriangulation) -> Vec<f32> {
    (0..mesh.vertex_slots())
        .map(|v| {
            if mesh.v_alive[v] != 0 {
                mesh.voronoi_area(v) as f32
            } else {
                0.0
            }
        })
        .collect()
}

/// The routing of a terrain without eroding it: the solver's index and one
/// routing refresh.
pub fn mesh_routing(
    mesh: &mut PeriodicTriangulation,
    z: &[f32],
    params: &ErosionSolverParams,
) -> MeshRouting {
    let ref_m = mesh.domain.metres_per_unit;
    let index = build_mesh_engine_index(mesh, z, params.shelf_band_km, ref_m, None);
    let cells = index.cell_count as usize;
    let neutral = vec![0f32; cells];
    let forcing = ErosionForcing {
        uplift: &neutral,
        erodibility: &neutral,
        ..Default::default()
    };
    let mut solver = ErosionSolver::on_index(index, z, &forcing, *params);
    solver.refresh_routing();
    let index = &solver.index;
    let r = &solver.routing;
    let mut flow_target = vec![-1i32; cells];
    for (a, &cell) in index.active.iter().enumerate() {
        let t = r.flow_target[a];
        if t >= 0 {
            flow_target[cell as usize] = index.active[t as usize];
        }
    }
    let popped = solver.popped_count;
    let pop_order: Vec<i32> = r.pop_order[..popped]
        .iter()
        .map(|&a| index.active[a as usize])
        .collect();
    let mut filled = z[..cells].to_vec();
    let mut accumulation = vec![0f32; cells];
    for (a, &cell) in index.active.iter().enumerate() {
        filled[cell as usize] = r.filled[a];
        accumulation[cell as usize] = r.accumulation[a];
    }
    MeshRouting {
        flow_target,
        filled,
        accumulation,
        pop_order,
        popped_count: popped,
    }
}

/// The water fields on a raster, from the mesh's lakes.
pub struct RasterWaterFields {
    pub depth: Vec<f32>,
    pub level: Vec<f32>,
    pub body: Vec<i32>,
    pub surface: Vec<u8>,
    pub salt_flat: Vec<u8>,
    pub dry_basin: Vec<u8>,
    pub frozen: Vec<u8>,
}

pub fn water_fields_from_mesh(
    mesh: &mut PeriodicTriangulation,
    node_body: &[i32],
    bodies: &[WaterBody],
    elevation: &[f32],
    width: usize,
    height: usize,
) -> RasterWaterFields {
    let n = width * height;
    let mut out = RasterWaterFields {
        depth: vec![0.0; n],
        level: vec![SEA_WATER_LEVEL as f32; n],
        body: vec![-1; n],
        surface: vec![SURFACE_SEA; n],
        salt_flat: vec![0; n],
        dry_basin: vec![0; n],
        frozen: vec![0; n],
    };
    let sx = mesh.domain.width / width as f64;
    let sy = mesh.domain.height / height as f64;
    let mut hint = mesh.last_tri as usize;
    let mut row_start = hint;
    let salt_band = meters_to_elevation(SURFACE_TUNING.salt_band_m);
    for py in 0..height {
        hint = row_start;
        for px in 0..width {
            let x = px as f64 * sx;
            let y = py as f64 * sy;
            let t = mesh.locate(x, y, Some(hint));
            hint = t;
            if px == 0 {
                row_start = t;
            }
            let bary = mesh.barycentric(t, x, y);
            let mut corner = 0;
            if bary[1] > bary[corner] {
                corner = 1;
            }
            if bary[2] > bary[corner] {
                corner = 2;
            }
            let id = node_body[mesh.tris[3 * t + corner] as usize];
            if id < 0 {
                continue;
            }
            let b = &bodies[id as usize];
            let c = py * width + px;
            let z = elevation[c] as f64;
            out.body[c] = id;
            out.level[c] = b.level as f32;
            out.surface[c] = if b.frozen { SURFACE_ICE } else { SURFACE_LAKE };
            if z <= b.level {
                if b.kind != WaterKind::Dry {
                    out.depth[c] = (b.level - z) as f32;
                    if b.frozen {
                        out.frozen[c] = 1;
                    }
                }
            } else if b.kind != WaterKind::Lake && z <= SEA_LEVEL {
                out.dry_basin[c] = 1;
                if z <= b.level + salt_band {
                    out.salt_flat[c] = 1;
                }
            }
        }
    }
    out
}
