//! `surface/erosionForcingFields.ts`: the grid half of the erosion forcing —
//! coarse fields in (U, the crust hardness, the water), the solver's
//! forcing per raster cell or per node out, with the controls' parameters.
//! The TypeScript port
//! (`client/src/generator/surface/erosionForcingFields.ts`, git history)
//! explains why it is one function for every producer.

use crate::core::det_math::{det_exp, det_pow};
use crate::core::domain::{Domain, DomainGrid};
use crate::core::js;
use crate::elevation::ridged_noise::{fine_detail_noise, fine_detail_noise_on};

use super::erosion_engine::{DEFAULT_SOLVER_PARAMS, ErosionForcing, ErosionSolverParams};

/// Decorrelates the erosion lithology lattice from the render's fine-detail
/// noise, which shares the warp seed.
pub const EROSION_LITHO_SEED_SALT: u32 = 0x5170_2e77;

pub fn erosion_litho_seed(warp_seed: f64) -> u32 {
    (js::to_int32(warp_seed) ^ EROSION_LITHO_SEED_SALT as i32) as u32
}

/// The σ of the log-normal erodibility factor at rock contrast 100.
pub const ROCK_CONTRAST_SIGMA_MAX: f64 = 2.8;

/// The lithology lattice: a fixed world-space grid.
pub const LITHO_LATTICE_X: f64 = 512.0;
pub const LITHO_LATTICE_Y: f64 = 256.0;

/// `CoarseForcingInputs` in TypeScript, which explains each field.
#[derive(Clone, Copy, Debug)]
pub struct CoarseForcingInputs<'a> {
    pub uplift: Option<&'a [f32]>,
    pub hardness: Option<&'a [f32]>,
    pub forcing_res_x: usize,
    pub forcing_res_y: usize,
    pub water: Option<&'a [f32]>,
    pub water_res_x: usize,
    pub water_res_y: usize,
    pub water_nodes: Option<&'a [f32]>,
    pub litho_seed: u32,
}

/// The erosion controls (`ErosionControlsV2`); None reads as 50.
#[derive(Clone, Copy, Debug, Default)]
pub struct ErosionControls {
    pub alluvium: Option<f64>,
    pub rock_contrast: Option<f64>,
}

/// Bilinear sample of a coarse field at a point of its grid's domain, cell
/// corners at integers, wrapped by the grid.
pub fn upsample_at(coarse: &[f32], grid: &DomainGrid, x: f64, y: f64) -> f64 {
    grid.interpolate(
        coarse,
        (x / grid.domain.width) * grid.res_x as f64,
        (y / grid.domain.height) * grid.res_y as f64,
    )
}

/// The lithology lattice's noise at a point of `domain`: the chart lattice
/// on the torus, the same octaves on the globe on the sphere.
fn lithology_noise_at(domain: &Domain, x: f64, y: f64, seed: u32) -> f64 {
    if !domain.is_sphere() {
        return fine_detail_noise(
            (x * LITHO_LATTICE_X) / domain.width,
            (y * LITHO_LATTICE_Y) / domain.height,
            LITHO_LATTICE_X,
            LITHO_LATTICE_Y,
            seed as f64,
        );
    }
    fine_detail_noise_on(domain, x, y, seed as f64)
}

/// The coarse inputs' two grids over the frame the forcing is evaluated in.
pub struct ForcingGrids {
    pub forcing: DomainGrid,
    pub water: DomainGrid,
}

pub fn forcing_grids(coarse: &CoarseForcingInputs, domain: &Domain) -> ForcingGrids {
    let forcing = domain.grid(coarse.forcing_res_x, coarse.forcing_res_y);
    let water = if coarse.water.is_some() {
        domain.grid(coarse.water_res_x, coarse.water_res_y)
    } else {
        forcing.clone()
    };
    ForcingGrids { forcing, water }
}

/// The forcing at one point: [uplift, erodibility].
pub fn forcing_at(
    coarse: &CoarseForcingInputs,
    grids: &ForcingGrids,
    sigma: f64,
    x: f64,
    y: f64,
) -> [f64; 2] {
    let uplift = coarse
        .uplift
        .map_or(0.0, |u| upsample_at(u, &grids.forcing, x, y));
    let erodibility =
        det_exp(sigma * lithology_noise_at(&grids.forcing.domain, x, y, coarse.litho_seed))
            * coarse
                .hardness
                .map_or(1.0, |h| upsample_at(h, &grids.forcing, x, y));
    [uplift, erodibility]
}

/// The water forcing at one point, before normalisation.
pub fn water_at(coarse: &CoarseForcingInputs, grids: &ForcingGrids, x: f64, y: f64) -> f64 {
    coarse
        .water
        .map_or(1.0, |w| js::max(0.0, upsample_at(w, &grids.water, x, y)))
}

pub fn rock_contrast_sigma(controls: &ErosionControls) -> f64 {
    ROCK_CONTRAST_SIGMA_MAX * (controls.rock_contrast.unwrap_or(50.0) / 100.0)
}

/// The solver's parameters under the controls: the alluvium control scales
/// the settling lengths and the shelf band with them.
pub fn engine_params_for(controls: &ErosionControls) -> ErosionSolverParams {
    let alluvium = controls.alluvium.unwrap_or(50.0);
    let settle_scale = det_pow(2.0, (50.0 - alluvium) / 50.0);
    let d = DEFAULT_SOLVER_PARAMS;
    ErosionSolverParams {
        settle_xi_km: d.settle_xi_km * settle_scale,
        settle_floor_km: d.settle_floor_km * settle_scale,
        settle_marine_km: d.settle_marine_km * settle_scale,
        settle_coarse_km: d.settle_coarse_km * settle_scale,
        shelf_band_km: d.shelf_band_km * settle_scale,
        ..d
    }
}

/// The forcing arrays an assembly makes; `forcing()` lends them to the
/// solver.
#[derive(Clone, Debug)]
pub struct AssembledForcing {
    pub uplift: Vec<f32>,
    pub erodibility: Vec<f32>,
    pub coast_mask: Vec<u8>,
    pub accumulation_weights: Vec<f32>,
    pub params: ErosionSolverParams,
}

impl AssembledForcing {
    pub fn forcing(&self) -> ErosionForcing<'_> {
        ErosionForcing {
            uplift: &self.uplift,
            erodibility: &self.erodibility,
            coast_mask: Some(&self.coast_mask),
            accumulation_weights: Some(&self.accumulation_weights),
            ..Default::default()
        }
    }
}

/// The forcing on a raster: `domain` is what it covers, one cell per unit.
pub fn assemble_fine_forcing(
    coarse: &CoarseForcingInputs,
    raw_elevations: &[f32],
    domain: &Domain,
    controls: &ErosionControls,
) -> AssembledForcing {
    let width = domain.width as usize;
    let height = domain.height as usize;
    let grids = forcing_grids(coarse, domain);
    let n = width * height;
    let sigma = rock_contrast_sigma(controls);
    let mut uplift = vec![0f32; n];
    let mut erodibility = vec![0f32; n];
    let mut coast_mask = vec![0u8; n];
    for y in 0..height {
        for x in 0..width {
            let i = y * width + x;
            let [u, k] = forcing_at(coarse, &grids, sigma, x as f64, y as f64);
            uplift[i] = u as f32;
            erodibility[i] = k as f32;
            if raw_elevations[i] > 0.0 {
                coast_mask[i] = 1;
            }
        }
    }
    let mut accumulation_weights = vec![1f32; n];
    if coarse.water.is_some() {
        let mut land_sum = 0.0;
        let mut land_count = 0u32;
        for y in 0..height {
            for x in 0..width {
                let i = y * width + x;
                let weight = water_at(coarse, &grids, x as f64, y as f64);
                accumulation_weights[i] = weight as f32;
                if raw_elevations[i] > 0.0 {
                    land_sum += weight;
                    land_count += 1;
                }
            }
        }
        let mean_land = if land_count > 0 && land_sum > 0.0 {
            land_sum / land_count as f64
        } else {
            1.0
        };
        for w in &mut accumulation_weights {
            *w = (*w as f64 / mean_land) as f32;
        }
    }
    AssembledForcing {
        uplift,
        erodibility,
        coast_mask,
        accumulation_weights,
        params: engine_params_for(controls),
    }
}

/// The forcing on a point set (the mesh's nodes): `xs`/`ys` in coordinates
/// of `domain`, `alive` the slots that hold a node, `areas` their areas for
/// the water's area-weighted land mean, which `mean_land_water` replaces
/// when given (a tile weighs its water against the world's land).
#[allow(clippy::too_many_arguments)]
pub fn assemble_node_forcing(
    coarse: &CoarseForcingInputs,
    xs: &[f64],
    ys: &[f64],
    alive: &[u8],
    count: usize,
    z: &[f32],
    areas: &[f32],
    domain: &Domain,
    controls: &ErosionControls,
    mean_land_water: Option<f64>,
) -> AssembledForcing {
    let grids = forcing_grids(coarse, domain);
    let sigma = rock_contrast_sigma(controls);
    let mut uplift = vec![0f32; count];
    let mut erodibility = vec![0f32; count];
    let mut coast_mask = vec![0u8; count];
    let mut accumulation_weights = vec![0f32; count];
    let mut land_sum = 0.0;
    let mut land_area = 0.0;
    for i in 0..count {
        if alive[i] == 0 {
            continue;
        }
        let [u, k] = forcing_at(coarse, &grids, sigma, xs[i], ys[i]);
        uplift[i] = u as f32;
        erodibility[i] = k as f32;
        if z[i] > 0.0 {
            coast_mask[i] = 1;
        }
        let weight = match coarse.water_nodes {
            Some(w) => js::max(0.0, w[i] as f64),
            None => water_at(coarse, &grids, xs[i], ys[i]),
        };
        accumulation_weights[i] = weight as f32;
        if z[i] > 0.0 {
            land_sum += weight * areas[i] as f64;
            land_area += areas[i] as f64;
        }
    }
    if coarse.water.is_some() || coarse.water_nodes.is_some() {
        let mean_land = mean_land_water.unwrap_or(if land_area > 0.0 && land_sum > 0.0 {
            land_sum / land_area
        } else {
            1.0
        });
        for w in &mut accumulation_weights {
            *w = (*w as f64 / mean_land) as f32;
        }
    }
    AssembledForcing {
        uplift,
        erodibility,
        coast_mask,
        accumulation_weights,
        params: engine_params_for(controls),
    }
}

/// The solver's rates for an iteration `dt_scale` times the calibrated one.
pub fn scale_engine_params_for_dt(
    params: &ErosionSolverParams,
    dt_scale: f64,
) -> ErosionSolverParams {
    ErosionSolverParams {
        kappa_dt: params.kappa_dt * dt_scale,
        uplift_dt: params.uplift_dt * dt_scale,
        hill_diff_km2: params.hill_diff_km2 * dt_scale,
        marine_diff_dt: params.marine_diff_dt * dt_scale,
        deposit_cap_land_m: params.deposit_cap_land_m * dt_scale,
        deposit_cap_marine_m: params.deposit_cap_marine_m * dt_scale,
        ..*params
    }
}
