//! `surface/amplify.ts`: the synthesis of a finer level — seed roughness
//! for the erosion to bite into, ridging scaled by the parent's relief —
//! and AMPLIFY_CONSTANTS, everything whose value changes a level bake, for
//! its cache key. The TypeScript port
//! (`client/src/generator/surface/amplify.ts`, git history) holds the
//! measurements behind each constant.

use crate::core::domain::{Domain, DomainGrid};
use crate::core::js;
use crate::elevation::elevation_scale::{SEA_LEVEL, meters_to_elevation};
use crate::elevation::globe_noise::globe_octave_on;
use crate::elevation::ridged_noise::periodic_value_noise_2d;

use super::erosion_engine::{DEFAULT_SOLVER_PARAMS, STATUS_CLAMP_M};
use super::erosion_forcing_fields::{EROSION_LITHO_SEED_SALT, ROCK_CONTRAST_SIGMA_MAX};
use super::hydrology::{CANONICAL_RIVER_DENSITY, CHANNEL_SLOPE_EXPONENT};
use super::surface_tune_params::SURFACE_TUNING;

/// Peak seed amplitude, metres.
const SEED_ROUGHNESS_M: f64 = 60.0;

/// The seed roughness's amplitude at a height: none on the sea, faded
/// toward sea level.
pub fn seed_roughness_amplitude(elevation: f64) -> f64 {
    if elevation <= SEA_LEVEL {
        return 0.0;
    }
    js::min(meters_to_elevation(SEED_ROUGHNESS_M), elevation * 0.5)
}

const MIN_OCTAVE_PIXELS: f64 = 3.0;
pub const CASCADE_FALLOFF: f64 = 0.55;

/// The noise cascade's domain divisors for a grid `res_x` wide.
pub fn seed_cascade_scales(res_x: f64) -> Vec<f64> {
    let mut scales = Vec::new();
    let mut s = 1.0;
    while s <= 64.0 {
        if res_x / (s * 1024.0) < MIN_OCTAVE_PIXELS {
            break;
        }
        scales.push(s);
        s *= 2.0;
    }
    if scales.is_empty() { vec![1.0] } else { scales }
}

const RIDGE_OCTAVE_CELLS: [f64; 3] = [256.0, 512.0, 1024.0];
const RIDGE_OCTAVE_AMPLITUDES: [f64; 3] = [1.0, 0.5, 0.25];
pub const RIDGE_STRENGTH: f64 = 0.5;
pub const RIDGE_FIELD_MEAN: f64 = 0.47;
const RELIEF_RADIUS_FRACTION: f64 = 1.0 / 64.0;

/// How the bake's solver run differs from the generator's defaults.
pub struct BakeEngineOverrides {
    pub uplift_dt: f64,
}

pub const BAKE_ENGINE_OVERRIDES: BakeEngineOverrides = BakeEngineOverrides { uplift_dt: 0.0 };

/// Everything here whose value changes the bake's output, by the
/// TypeScript names (they are the cache key's), in its order.
pub fn amplify_constants() -> Vec<(String, f64)> {
    let t = &SURFACE_TUNING;
    let p = &DEFAULT_SOLVER_PARAMS;
    let mut out: Vec<(String, f64)> = vec![
        ("seedRoughnessM".into(), SEED_ROUGHNESS_M),
        ("cascadeFalloff".into(), CASCADE_FALLOFF),
        ("minOctavePixels".into(), MIN_OCTAVE_PIXELS),
        ("ridgeStrength".into(), RIDGE_STRENGTH),
        ("ridgeFieldMean".into(), RIDGE_FIELD_MEAN),
        ("reliefRadiusFraction".into(), RELIEF_RADIUS_FRACTION),
    ];
    for (i, c) in RIDGE_OCTAVE_CELLS.iter().enumerate() {
        out.push((format!("ridgeOctaveCells{i}"), *c));
    }
    for (i, a) in RIDGE_OCTAVE_AMPLITUDES.iter().enumerate() {
        out.push((format!("ridgeOctaveAmp{i}"), *a));
    }
    for (k, v) in [
        ("m", p.m),
        ("kappaDt", p.kappa_dt),
        ("baseAreaRel", p.base_area_rel),
        ("channelHeadKm2", p.channel_head_km2),
        ("upliftDt", p.uplift_dt),
        ("settleXiKm", p.settle_xi_km),
        ("settleFloorKm", p.settle_floor_km),
        ("settleMarineKm", p.settle_marine_km),
        ("settleCoarseKm", p.settle_coarse_km),
        ("settleWidthRefKm", p.settle_width_ref_km),
        ("coarseSlope", p.coarse_slope),
        ("abrasionKm", p.abrasion_km),
        ("marineFreeboardM", p.marine_freeboard_m),
        ("depositCapLandM", p.deposit_cap_land_m),
        ("depositCapMarineM", p.deposit_cap_marine_m),
        ("hillDiffKm2", p.hill_diff_km2),
        ("hillRefKm2", p.hill_ref_km2),
        ("hillScaleExponent", p.hill_scale_exponent),
        ("criticalSlope", p.critical_slope),
        ("marineDiffDt", p.marine_diff_dt),
        ("shelfBandKm", p.shelf_band_km),
        ("epsM", p.eps_m),
    ] {
        out.push((format!("engine_{k}"), v));
    }
    for (k, v) in [
        ("bakeUpliftDt", BAKE_ENGINE_OVERRIDES.uplift_dt),
        ("lithoSeedSalt", EROSION_LITHO_SEED_SALT as f64),
        ("rockContrastSigmaMax", ROCK_CONTRAST_SIGMA_MAX),
        ("statusClampM", STATUS_CLAMP_M),
        ("channelSlopeExponent", CHANNEL_SLOPE_EXPONENT),
        ("channelAreaMaxM2", t.channel_area_max_m2),
        ("channelAreaMinM2", t.channel_area_min_m2),
        ("canonicalRiverDensity", CANONICAL_RIVER_DENSITY),
        ("minLakeBasinReliefM", t.min_lake_basin_relief_m),
        ("lakeFrozenBelowC", t.lake_frozen_below_c),
        ("saltBandM", t.salt_band_m),
        ("petBaseMm", t.pet_base_mm),
        ("petPerDegC", t.pet_per_deg_c),
        ("petMinMm", t.pet_min_mm),
        ("petMaxMm", t.pet_max_mm),
        ("regimeAridBelow", t.regime_arid_below),
        ("regimeDrySeasonBelow", t.regime_dry_season_below),
    ] {
        out.push((k.into(), v));
    }
    out
}

/// `(seed + i * 0x9e3779b9) >>> 0`.
fn octave_seed(seed: u32, i: usize) -> f64 {
    js::to_uint32(seed as f64 + i as f64 * 0x9e37_79b9u32 as f64) as f64
}

/// Ridged fBm at the ridgeline octave table, in [0, 1).
pub fn ridged_at(x: f64, y: f64, width: f64, height: f64, seed: u32) -> f64 {
    let (mut sum, mut norm) = (0.0, 0.0);
    for i in 0..RIDGE_OCTAVE_CELLS.len() {
        let cells_x = RIDGE_OCTAVE_CELLS[i];
        let cells_y = js::max(2.0, js::round(cells_x / 2.0));
        let noise = periodic_value_noise_2d(
            (x / width) * cells_x,
            (y / height) * cells_y,
            cells_x,
            cells_y,
            octave_seed(seed, i),
        );
        let ridge = 1.0 - (2.0 * noise - 1.0).abs();
        sum += ridge * ridge * RIDGE_OCTAVE_AMPLITUDES[i];
        norm += RIDGE_OCTAVE_AMPLITUDES[i];
    }
    sum / norm
}

/// The globe's ridged mean minus the chart's.
pub const RIDGE_GLOBE_OFFSET: f64 = 0.0097;

/// `ridged_at` on the globe. Panics on the torus.
pub fn ridged_at_on(domain: &Domain, x: f64, y: f64, seed: u32) -> f64 {
    assert!(domain.is_sphere(), "ridgedAtOn samples the globe");
    let frame = domain.globe_frame(x, y);
    let (mut sum, mut norm) = (0.0, 0.0);
    for i in 0..RIDGE_OCTAVE_CELLS.len() {
        let noise = globe_octave_on(&frame, RIDGE_OCTAVE_CELLS[i], domain, octave_seed(seed, i));
        let ridge = 1.0 - (2.0 * noise - 1.0).abs();
        sum += ridge * ridge * RIDGE_OCTAVE_AMPLITUDES[i];
        norm += RIDGE_OCTAVE_AMPLITUDES[i];
    }
    sum / norm - RIDGE_GLOBE_OFFSET
}

/// How far each cell stands above the land around it, over the macro grid.
pub fn local_relief(field: &[f32], grid: &DomainGrid) -> Vec<f32> {
    let width = grid.res_x;
    let mut at = |x: f64, y: f64| field[y as usize * width + x as usize] as f64;
    let mut out = vec![0f32; field.len()];
    for y in 0..grid.res_y {
        for x in 0..width {
            out[y * width + x] = local_relief_at(&mut at, x as f64, y as f64, grid) as f32;
        }
    }
    out
}

/// One cell of `local_relief` over any source of the macro grid's heights.
pub fn local_relief_at(
    at: &mut dyn FnMut(f64, f64) -> f64,
    x: f64,
    y: f64,
    grid: &DomainGrid,
) -> f64 {
    let radius = js::max(1.0, js::round(grid.res_x as f64 * RELIEF_RADIUS_FRACTION));
    let mut lowest = f64::INFINITY;
    let mut dy = -radius;
    while dy <= radius {
        let ny = grid.wrap_row(y + dy);
        let mut dx = -radius;
        while dx <= radius {
            let value = at(grid.wrap_col(x + dx), ny);
            if value < lowest {
                lowest = value;
            }
            dx += radius;
        }
        dy += radius;
    }
    js::max(
        0.0,
        at(grid.wrap_col(x), grid.wrap_row(y)) - js::max(SEA_LEVEL, lowest),
    )
}
