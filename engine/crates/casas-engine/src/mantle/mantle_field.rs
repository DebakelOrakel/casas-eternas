//! `mantle/mantleField.ts`: a coarse, evolving mantle buoyancy field under
//! the whole surface, the cause the plates ride on, on its field mesh
//! (DEC-0036 phase 1). Continents insulate, ocean cools, diffusion and decay
//! bound it; the surface flow is the gradient of its Poisson potential. The
//! reasoning is in the TypeScript file.
//!
//! The TypeScript code keeps one mesh per domain in a module cache and
//! looks it up from the domain; here the caller holds the [`MantleMesh`]
//! and hands it in. Its sampler walks the mesh's triangulation, so a reader
//! takes it mutably.

use crate::core::domain::{Domain, domain_area};
use crate::core::js;
use crate::crust::raft_field::compute_membership_at;
use crate::crust::raft_types::Raft;
use crate::fields::field_mesh::{
    FieldMesh, FieldSampler, SavedField, create_field_mesh, create_field_sampler, rasterise_field,
};
use crate::fields::field_operators::{
    SolveOptions, diffuse_explicit, gradient, solve_helmholtz, stable_diffusion_step,
};

use super::mantle_tune_params::MANTLE_TUNING;

/// The chart raster of the screen's overlay, and through the world's area
/// the mesh's spacing.
pub const MANTLE_RES_X: usize = 128;
pub const MANTLE_RES_Y: usize = 64;

/// The mantle's field mesh on a domain, its sampler, and what the
/// operators need of its geometry.
pub struct MantleMesh {
    pub mesh: FieldMesh,
    pub sampler: FieldSampler,
    /// The spacing, metres and domain units.
    pub cell_m: f64,
    pub cell_units: f64,
    /// The total area, m², and the convex diffusion limit at κ = 1, m².
    pub total_area: f64,
    pub stable_step: f64,
}

pub fn mantle_mesh(domain: &Domain) -> MantleMesh {
    let cell_units = (domain_area(domain) / (MANTLE_RES_X * MANTLE_RES_Y) as f64).sqrt();
    let cell_m = cell_units * domain.metres_per_unit;
    let mut mesh = create_field_mesh(domain, cell_m);
    let sampler = create_field_sampler(&mut mesh);
    let mut total_area = 0.0;
    for i in 0..mesh.count {
        total_area += mesh.area[i];
    }
    let stable_step = stable_diffusion_step(&mesh, 1.0);
    MantleMesh {
        mesh,
        sampler,
        cell_m,
        cell_units,
        total_area,
        stable_step,
    }
}

/// The field at a point: linear in the mesh's triangle under it.
pub fn mantle_at(mm: &mut MantleMesh, field: &[f64], x: f64, y: f64) -> f64 {
    mm.sampler.sample(&mut mm.mesh, field, x, y)
}

/// The field on the overlay's chart raster, cell centres.
pub fn rasterise_mantle(mm: &mut MantleMesh, field: &[f64]) -> Vec<f32> {
    rasterise_field(&mut mm.mesh, field, MANTLE_RES_X, MANTLE_RES_Y)
}

pub fn saved_mantle(mm: &MantleMesh, field: &[f64]) -> SavedField {
    SavedField {
        values: field.to_vec(),
        cells: mm.mesh.count,
        spacing_m: mm.cell_m,
    }
}

/// Whether a saved field's mesh is this one.
pub fn mantle_fits(mm: &MantleMesh, cells: usize, spacing_m: f64) -> bool {
    cells == mm.mesh.count && spacing_m == mm.cell_m
}

/// The field back from a save; an error when it belongs to another mesh.
pub fn restore_mantle_field(
    mm: &MantleMesh,
    saved: Option<&SavedField>,
) -> Result<Option<Vec<f64>>, String> {
    let Some(saved) = saved else {
        return Ok(None);
    };
    if !mantle_fits(mm, saved.cells, saved.spacing_m) || saved.values.len() != mm.mesh.count {
        return Err(format!(
            "the saved mantle is for a mesh of {} cells at {} m ({} values); this world's has {} at {} m",
            saved.cells,
            saved.spacing_m,
            saved.values.len(),
            mm.mesh.count,
            mm.cell_m
        ));
    }
    Ok(Some(saved.values.clone()))
}

/// The blur passes of the initial random field: only its starting scale.
pub const DEFAULT_INITIAL_SMOOTHING: usize = 6;

/// A smoothed random initial field; `random` draws in [0, 1).
pub fn create_mantle_field(
    random: &mut dyn FnMut() -> f64,
    mm: &MantleMesh,
    smoothing_passes: usize,
) -> Vec<f64> {
    let mut field: Vec<f64> = (0..mm.mesh.count).map(|_| random() * 2.0 - 1.0).collect();
    for _ in 0..smoothing_passes {
        field = diffusion_pass(field, 0.5, mm);
    }
    clamp_field(&mut field);
    zero_mean(&mut field, mm);
    field
}

/// One pass of diffusion, κ dt = weight · h² / 4, in as many equal explicit
/// steps as keep each a convex combination.
fn diffusion_pass(field: Vec<f64>, weight: f64, mm: &MantleMesh) -> Vec<f64> {
    let kappa_dt = (weight * mm.cell_m * mm.cell_m) / 4.0;
    let steps = js::max(1.0, (kappa_dt / mm.stable_step).ceil()) as usize;
    let mut a = field;
    let mut b = vec![0.0; a.len()];
    for _ in 0..steps {
        diffuse_explicit(&mm.mesh, &a, kappa_dt / steps as f64, 1.0, &mut b);
        std::mem::swap(&mut a, &mut b);
    }
    a
}

/// The area-weighted mean taken out.
fn zero_mean(field: &mut [f64], mm: &MantleMesh) {
    let mut mean = 0.0;
    for i in 0..field.len() {
        mean += field[i] * mm.mesh.area[i];
    }
    mean /= mm.total_area;
    for v in field.iter_mut() {
        *v -= mean;
    }
}

fn clamp_field(field: &mut [f64]) {
    let c = MANTLE_TUNING.clamp;
    for v in field.iter_mut() {
        *v = js::max(-c, js::min(c, *v));
    }
}

/// One epoch of the field: continents heat the mantle beneath, ocean cools
/// it, then diffusion (fractional passes) and decay to a zero mean.
pub fn evolve_mantle_field(
    field: Vec<f64>,
    rafts: &[Raft],
    mm: &MantleMesh,
    diffusion_passes: f64,
) -> Vec<f64> {
    let mut field = field;
    let membership = compute_membership_at(rafts, &mm.mesh.x, &mm.mesh.y, &mm.mesh.domain);
    for i in 0..field.len() {
        if membership[i] > 0.5 {
            field[i] += MANTLE_TUNING.insulation_rate;
        } else {
            field[i] -= MANTLE_TUNING.ocean_cool_rate;
        }
    }
    let whole = diffusion_passes.floor();
    for _ in 0..whole as usize {
        field = diffusion_pass(field, MANTLE_TUNING.diffusion_weight, mm);
    }
    let remainder = diffusion_passes - whole;
    if remainder > 0.0 {
        field = diffusion_pass(field, MANTLE_TUNING.diffusion_weight * remainder, mm);
    }
    for v in field.iter_mut() {
        *v *= MANTLE_TUNING.decay_keep;
    }
    clamp_field(&mut field);
    zero_mean(&mut field, mm);
    field
}

/// Renormalises the field to an area-weighted RMS, the Archean's internal
/// heating.
pub fn sustain_mantle_vigour(field: &mut [f64], target_rms: f64, mm: &MantleMesh) {
    let mut sq = 0.0;
    for i in 0..field.len() {
        sq += field[i] * field[i] * mm.mesh.area[i];
    }
    let rms = (sq / mm.total_area).sqrt();
    if rms < 1e-6 {
        return;
    }
    let scale = target_rms / rms;
    let c = MANTLE_TUNING.clamp;
    for v in field.iter_mut() {
        *v = js::max(-c, js::min(c, *v * scale));
    }
}

/// The thermal doming released at a breakup: a linear bump subtracted
/// around the rift point.
pub fn cool_mantle_at(
    field: &mut [f64],
    x: f64,
    y: f64,
    mm: &MantleMesh,
    world_radius: f64,
    amount: f64,
) {
    let mesh = &mm.mesh;
    let r2 = world_radius * world_radius;
    for i in 0..mesh.count {
        let d2 = mesh.domain.distance_sq(mesh.x[i], mesh.y[i], x, y);
        if d2 > r2 {
            continue;
        }
        let falloff = 1.0 - d2.sqrt() / world_radius;
        field[i] = js::max(-MANTLE_TUNING.clamp, field[i] - amount * falloff);
    }
}

/// The surface flow per cell in its own east/south frame.
pub struct MantleFlow {
    pub east: Vec<f64>,
    pub south: Vec<f64>,
}

const FLOW_SOLVE_TOLERANCE: f64 = 1e-8;

/// ∇²φ = T by conjugate gradients, then u = ∇φ, scaled by `speed_scale` per
/// cell of the gradient.
pub fn compute_mantle_flow(field: &[f64], mm: &MantleMesh, speed_scale: f64) -> MantleFlow {
    let mesh = &mm.mesh;
    let mut phi = vec![0.0; mesh.count];
    let options = SolveOptions {
        tolerance: FLOW_SOLVE_TOLERANCE,
        ..Default::default()
    };
    solve_helmholtz(mesh, 0.0, field, &mut phi, options);
    let mut east = vec![0.0; mesh.count];
    let mut south = vec![0.0; mesh.count];
    gradient(mesh, &phi, &mut east, &mut south);
    let scale = speed_scale / mm.cell_m;
    for i in 0..mesh.count {
        east[i] *= scale;
        south[i] *= scale;
    }
    MantleFlow { east, south }
}

/// The flow at a point, read in the point's own frame.
pub fn mantle_flow_at(mm: &mut MantleMesh, flow: &MantleFlow, x: f64, y: f64) -> (f64, f64) {
    mm.sampler
        .sample_vector(&mut mm.mesh, &flow.east, &flow.south, x, y, None)
}
