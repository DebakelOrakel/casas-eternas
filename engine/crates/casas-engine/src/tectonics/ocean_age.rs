//! `tectonics/oceanAge.ts`: ocean-floor age, epochs, per cell of a field
//! mesh at the domain's width / 256 (DEC-0036 phase 2); carried with the
//! plates each epoch by an exact semi-Lagrangian departure, zeroed under
//! continents, half an epoch where the plates opened new crust. The
//! reasoning is in the TypeScript file.
//!
//! The mesh is the shared one ([`SharedFieldMesh`]), which the caller holds
//! and hands in; [`OceanAge`] holds the stage's own scratch.

use crate::core::domain::Domain;
use crate::crust::raft_field::compute_membership_at;
use crate::crust::raft_types::Raft;
use crate::fields::field_mesh::{SavedField, SharedFieldMesh, rasterise_field};
use crate::fields::field_operators::{
    Departures, departures, departures_from_points, gradient, transport_scalar,
};

use super::plate_motion::{PlateMotion, reverse_point_by_motion};
use super::plate_seeds::PlateSeed;

pub const OCEAN_AGE_RES_X: f64 = 256.0;

/// The ocean age's spacing on a domain, metres: what its shared mesh is
/// built at.
pub fn ocean_age_spacing_m(domain: &Domain) -> f64 {
    (domain.width / OCEAN_AGE_RES_X) * domain.metres_per_unit
}

/// The stage's scratch over its mesh.
pub struct OceanAge {
    pub cell_m: f64,
    pub cell_units: f64,
    dep: Departures,
    grad_e: Vec<f64>,
    grad_s: Vec<f64>,
    px: Vec<f64>,
    py: Vec<f64>,
    stamp: Vec<i32>,
    stamp_counter: i32,
}

pub fn ocean_age(sm: &SharedFieldMesh) -> OceanAge {
    let domain = &sm.mesh.domain;
    let cell_units = domain.width / OCEAN_AGE_RES_X;
    let n = sm.mesh.count;
    OceanAge {
        cell_m: cell_units * domain.metres_per_unit,
        cell_units,
        dep: departures(&sm.mesh),
        grad_e: vec![0.0; n],
        grad_s: vec![0.0; n],
        px: vec![0.0; n],
        py: vec![0.0; n],
        stamp: vec![0; n],
        stamp_counter: 0,
    }
}

pub fn create_ocean_age_field(initial_age: f64, sm: &SharedFieldMesh) -> Vec<f64> {
    vec![initial_age; sm.mesh.count]
}

/// The age at a world point: linear in the mesh's triangle under it.
pub fn ocean_age_at(sm: &mut SharedFieldMesh, age: &[f64], x: f64, y: f64) -> f64 {
    sm.sampler.sample(&mut sm.mesh, age, x, y)
}

/// The field on a chart raster, cell centres: the render's lookup.
pub fn ocean_age_raster(
    sm: &mut SharedFieldMesh,
    age: &[f64],
    res_x: usize,
    res_y: usize,
) -> Vec<f32> {
    rasterise_field(&mut sm.mesh, age, res_x, res_y)
}

pub fn saved_ocean_age(oa: &OceanAge, sm: &SharedFieldMesh, age: &[f64]) -> SavedField {
    SavedField {
        values: age.to_vec(),
        cells: sm.mesh.count,
        spacing_m: oa.cell_m,
    }
}

pub fn ocean_age_fits(oa: &OceanAge, sm: &SharedFieldMesh, cells: usize, spacing_m: f64) -> bool {
    cells == sm.mesh.count && spacing_m == oa.cell_m
}

/// The field back from a save; an error when it belongs to another mesh.
pub fn restore_ocean_age(
    oa: &OceanAge,
    sm: &SharedFieldMesh,
    saved: &SavedField,
) -> Result<Vec<f64>, String> {
    if !ocean_age_fits(oa, sm, saved.cells, saved.spacing_m) || saved.values.len() != sm.mesh.count
    {
        return Err(format!(
            "the saved ocean age is for a mesh of {} cells at {} m ({} values); this world's has {} at {} m",
            saved.cells,
            saved.spacing_m,
            saved.values.len(),
            sm.mesh.count,
            oa.cell_m
        ));
    }
    Ok(saved.values.clone())
}

/// The continental membership at the mesh's cell centres.
pub fn ocean_age_membership(sm: &SharedFieldMesh, rafts: &[Raft]) -> Vec<f64> {
    compute_membership_at(rafts, &sm.mesh.x, &sm.mesh.y, &sm.mesh.domain)
}

const MAX_SEAFLOOR_AGE: f64 = 180.0;

fn nearest(seeds: &[PlateSeed], x: f64, y: f64, domain: &Domain) -> usize {
    let mut best = 0;
    let mut best_sq = f64::INFINITY;
    for (s, seed) in seeds.iter().enumerate() {
        let d = domain.distance_sq(x, y, seed.x, seed.y);
        if d < best_sq {
            best_sq = d;
            best = s;
        }
    }
    best
}

/// One epoch of transport: each cell pulls its age from where its crust
/// was a step ago (its nearest plate's motion turned back) and adds one;
/// zero under continents, half an epoch where the departure lies on
/// another plate than the cell (`previous_seeds`).
#[allow(clippy::too_many_arguments)]
pub fn advect_ocean_age(
    oa: &mut OceanAge,
    sm: &mut SharedFieldMesh,
    age: &[f64],
    seeds: &[PlateSeed],
    motions: &[PlateMotion],
    step_ma: f64,
    membership: &[f64],
    previous_seeds: Option<&[PlateSeed]>,
) -> Vec<f64> {
    let n = sm.mesh.count;
    let mut fresh = vec![0u8; n];
    {
        let mesh = &sm.mesh;
        let domain = &mesh.domain;
        for i in 0..n {
            let (wx, wy) = (mesh.x[i], mesh.y[i]);
            if membership[i] > 0.5 {
                oa.px[i] = wx;
                oa.py[i] = wy;
                continue;
            }
            let near = nearest(seeds, wx, wy, domain);
            let prev = reverse_point_by_motion(wx, wy, &motions[near], step_ma, domain);
            oa.px[i] = prev.x;
            oa.py[i] = prev.y;
            if let Some(previous) = previous_seeds
                && nearest(previous, prev.x, prev.y, domain) != near
            {
                fresh[i] = 1;
            }
        }
    }
    departures_from_points(&mut sm.mesh, &sm.sampler, &oa.px, &oa.py, &mut oa.dep);
    gradient(&sm.mesh, age, &mut oa.grad_e, &mut oa.grad_s);
    let mut next = vec![0.0; n];
    transport_scalar(
        &sm.mesh,
        &oa.dep,
        age,
        &mut next,
        Some((&oa.grad_e, &oa.grad_s)),
        true,
    );
    for i in 0..n {
        if membership[i] > 0.5 {
            next[i] = 0.0;
            continue;
        }
        if fresh[i] != 0 {
            next[i] = 0.5;
            continue;
        }
        let advected = next[i] + 1.0;
        next[i] = if advected > MAX_SEAFLOOR_AGE {
            MAX_SEAFLOOR_AGE
        } else {
            advected
        };
    }
    next
}

/// The age set to 0 in every cell whose centre lies within `world_radius`
/// of a point, by a walk over the mesh's neighbours.
pub fn reset_ocean_age_around(
    oa: &mut OceanAge,
    sm: &mut SharedFieldMesh,
    age: &mut [f64],
    x: f64,
    y: f64,
    world_radius: f64,
) {
    let radius_sq = world_radius * world_radius;
    let reach = world_radius + oa.cell_units;
    let reach_sq = reach * reach;
    oa.stamp_counter += 1;
    if oa.stamp_counter == 0x7fffffff {
        oa.stamp.fill(0);
        oa.stamp_counter = 1;
    }
    let mark = oa.stamp_counter;
    let start = sm.sampler.nearest_cell(&mut sm.mesh, x, y);
    let mesh = &sm.mesh;
    let mut queue = vec![start];
    oa.stamp[start] = mark;
    let mut q = 0;
    while q < queue.len() {
        let c = queue[q];
        q += 1;
        let d = mesh.domain.distance_sq(mesh.x[c], mesh.y[c], x, y);
        if d <= radius_sq {
            age[c] = 0.0;
        }
        if d > reach_sq {
            continue;
        }
        for e in mesh.edges(c) {
            let j = mesh.nbr[e] as usize;
            if oa.stamp[j] == mark {
                continue;
            }
            oa.stamp[j] = mark;
            queue.push(j);
        }
    }
}
