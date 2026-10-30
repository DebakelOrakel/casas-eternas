//! `elevation/elevationField.ts`: the synthesis's height: the raft baseline
//! (the warped margin profile over the age-deepened ocean floor, the
//! interior's hypsometry), the uplift deck of the terrain features over a
//! bucket index, the ridged detail and the plains' micro-relief. The
//! reasoning and the measurements are in the TypeScript port
//! (`client/src/generator/elevation/elevationField.ts`, git history).
//!
//! Not ported, because it changes the time and nothing else: the render's
//! cache of each cell's warped point and relief. The ocean age is read
//! through the shared field mesh, which the caller holds.

use std::collections::HashMap;

use crate::core::det_math::{det_asin, det_exp, det_pow, det_sin};
use crate::core::domain::{Domain, DomainGrid, Vec2};
use crate::core::js;
use crate::core::shared::{block_ranges, for_ranges};
use crate::crust::raft_field::{
    BlobIndex, build_blob_index, raft_field, raft_field_indexed, sample_owner_field,
};
use crate::crust::raft_types::Raft;
use crate::fields::field_mesh::SharedFieldMesh;
use crate::tectonics::ocean_age::{OCEAN_AGE_RES_X, ocean_age_at, ocean_age_raster};
use crate::tectonics::terrain_features::{FeatureKind, TerrainFeature};

use super::capsule::capsule_weight;
use super::domain_warp::domain_warp_point;
use super::elevation_scale::{ABYSSAL_FLOOR, RIDGE_CREST, margin_parameter, margin_profile};
use super::elevation_tune_params::ELEVATION_TUNING;
use super::hypsometry::{continental_hypsometry, hypsometry_relief, hypsometry_weight};
use super::ridged_noise::RIDGE_MEAN;

pub fn range_perp_radius(domain: &Domain) -> f64 {
    ELEVATION_TUNING.range_perp_radius_m / domain.metres_per_unit
}

pub fn trench_perp_radius(domain: &Domain) -> f64 {
    ELEVATION_TUNING.trench_perp_radius_m / domain.metres_per_unit
}

pub fn range_half_length(domain: &Domain) -> f64 {
    ELEVATION_TUNING.range_segment_half_length_m / domain.metres_per_unit
}

pub fn trench_half_length(domain: &Domain) -> f64 {
    ELEVATION_TUNING.trench_segment_half_length_m / domain.metres_per_unit
}

pub fn feature_max_reach(domain: &Domain) -> f64 {
    js::max(
        range_half_length(domain) + range_perp_radius(domain),
        trench_half_length(domain) + trench_perp_radius(domain),
    )
}

/// A spatial hash over the terrain features: a query needs its own bucket
/// row and the two beside it, each as far either side as the row's span.
pub struct FeatureBuckets<'a> {
    pub features: &'a [TerrainFeature],
    /// Per bucket the indices of its features, in the features' order.
    pub buckets: Vec<Vec<u32>>,
    grid: DomainGrid,
    pub buckets_x: usize,
    pub buckets_y: usize,
    pub bucket_size_x: f64,
    pub bucket_size_y: f64,
    row_span: Vec<i32>,
    clamp_rows: bool,
}

pub fn build_feature_buckets<'a>(
    features: &'a [TerrainFeature],
    domain: &Domain,
) -> FeatureBuckets<'a> {
    let (width, height) = (domain.width, domain.height);
    let sphere = domain.is_sphere();
    let none = features.is_empty();
    let reach = feature_max_reach(domain);
    let fit_x = js::max(1.0, (width / reach).floor());
    let buckets_x = if none {
        2.0
    } else if sphere {
        js::max(2.0, fit_x - fit_x % 2.0)
    } else {
        fit_x
    } as usize;
    let buckets_y = if none {
        1.0
    } else {
        js::max(1.0, (height / reach).floor())
    } as usize;
    let bucket_size_x = width / buckets_x as f64;
    let bucket_size_y = height / buckets_y as f64;
    let mut buckets = vec![Vec::new(); buckets_x * buckets_y];
    for (i, f) in features.iter().enumerate() {
        let bx = js::min((buckets_x - 1) as f64, (f.x / bucket_size_x).floor()) as usize;
        let by = js::min((buckets_y - 1) as f64, (f.y / bucket_size_y).floor()) as usize;
        buckets[by * buckets_x + bx].push(i as u32);
    }
    let mut row_span = vec![1i32; buckets_y];
    if sphere {
        let pi = std::f64::consts::PI;
        let r = width / (2.0 * pi);
        let sin_reach = det_sin(js::min(pi / 2.0, reach / r));
        for (row, span_out) in row_span.iter_mut().enumerate() {
            let sin_min = js::min(
                det_sin((row as f64 * bucket_size_y) / r),
                det_sin(js::min(pi, ((row + 1) as f64 * bucket_size_y) / r)),
            );
            if sin_min.is_nan() || sin_min <= sin_reach {
                *span_out = -1;
                continue;
            }
            let span =
                ((det_asin(sin_reach / sin_min) * r * (1.0 + 1e-9) + 1e-6) / bucket_size_x).ceil();
            *span_out = if 2.0 * span + 1.0 >= buckets_x as f64 {
                -1
            } else {
                span as i32
            };
        }
    }
    FeatureBuckets {
        features,
        buckets,
        grid: domain.grid(buckets_x, buckets_y),
        buckets_x,
        buckets_y,
        bucket_size_x,
        bucket_size_y,
        row_span,
        clamp_rows: sphere,
    }
}

impl FeatureBuckets<'_> {
    /// Per bucket row, how many columns either side a query searches; −1
    /// for every column.
    pub fn row_span(&self) -> &[i32] {
        &self.row_span
    }

    /// The buckets a query at (x, y) must search, into `near` (cleared),
    /// each once, rows outer and columns inner.
    pub fn near(&self, x: f64, y: f64, near: &mut Vec<u32>) {
        near.clear();
        let bx_max = (self.buckets_x - 1) as f64;
        let center_bx = js::min(bx_max, (x / self.bucket_size_x).floor()) as i64;
        let center_by = js::min(
            (self.buckets_y - 1) as f64,
            (y / self.bucket_size_y).floor(),
        ) as i64;
        for dy in -1..=1 {
            let row = center_by + dy;
            if self.clamp_rows && (row < 0 || row >= self.buckets_y as i64) {
                continue;
            }
            let by = self.grid.wrap_row(row as f64) as usize;
            let base = by * self.buckets_x;
            let span = self.row_span[by];
            if span < 0 {
                for bx in 0..self.buckets_x {
                    near.push((base + bx) as u32);
                }
                continue;
            }
            for dx in -(span as i64)..=span as i64 {
                near.push((base + self.grid.wrap_col((center_bx + dx) as f64) as usize) as u32);
            }
        }
    }
}

/// Fraction 0..1 of an ocean plate's subsidence done at `age` epochs (GDH1).
fn subsidence_fraction(age: f64) -> f64 {
    if age < ELEVATION_TUNING.gdh1_young_max_age {
        return ELEVATION_TUNING.gdh1_young_coeff * age.sqrt();
    }
    1.0 - ELEVATION_TUNING.gdh1_old_coeff * det_exp(-ELEVATION_TUNING.gdh1_old_decay * age)
}

pub fn ocean_floor_at_age(age: f64) -> f64 {
    RIDGE_CREST + (ABYSSAL_FLOOR - RIDGE_CREST) * subsidence_fraction(age)
}

/// A term under the floor from the unwarped point, the margin parameter
/// and the floor's age: the trench's depression.
pub type BaselineTerm<'a> = &'a (dyn Fn(f64, f64, f64, f64) -> f64 + Sync);

/// The ocean age a baseline reads: the field on its shared mesh.
pub type OceanAgeInput<'a> = Option<(&'a mut SharedFieldMesh, &'a [f64])>;

/// The baseline at one world point (unwarped; the warp applied here).
#[allow(clippy::too_many_arguments)]
pub fn raft_baseline_at(
    world_x: f64,
    world_y: f64,
    rafts: &[Raft],
    ocean_age: OceanAgeInput,
    domain: &Domain,
    warp_seed: f64,
    blobs: Option<&BlobIndex>,
    below: Option<BaselineTerm>,
) -> f64 {
    let w = domain_warp_point(world_x, world_y, domain, warp_seed);
    let age = match ocean_age {
        Some((sm, field)) => ocean_age_at(sm, field, w.x, w.y),
        None => 0.0,
    };
    let Some(below) = below else {
        return baseline_at_warped(
            w.x,
            w.y,
            rafts,
            age,
            domain,
            warp_seed,
            blobs,
            None,
            0,
            f64::NAN,
        );
    };
    let field = match blobs {
        Some(b) => raft_field_indexed(w.x, w.y, b),
        None => raft_field(w.x, w.y, rafts, domain),
    };
    let t = margin_parameter(field);
    baseline_at_warped(w.x, w.y, rafts, age, domain, warp_seed, blobs, None, 0, t)
        + below(world_x, world_y, t, age)
}

/// `raft_baseline_at` at every point of `xs`, `ys`, the same bits: the
/// warp and everything after the ocean age in fixed blocks on rayon's pool
/// (`for_ranges`), the ocean age's sampler between them in the points'
/// order, as the one-point calls walk it — its walk is state.
#[allow(clippy::too_many_arguments)]
pub fn raft_baselines(
    xs: &[f64],
    ys: &[f64],
    rafts: &[Raft],
    ocean_age: (&mut SharedFieldMesh, &[f64]),
    domain: &Domain,
    warp_seed: f64,
    blobs: &BlobIndex,
    below: Option<BaselineTerm>,
) -> Vec<f64> {
    let ranges = block_ranges(xs.len(), BASELINE_BLOCK);
    let warped: Vec<Vec2> = for_ranges(&ranges, |r| {
        r.map(|i| domain_warp_point(xs[i], ys[i], domain, warp_seed))
            .collect::<Vec<_>>()
    })
    .concat();
    let (sm, field) = ocean_age;
    let ages: Vec<f64> = warped
        .iter()
        .map(|w| ocean_age_at(sm, field, w.x, w.y))
        .collect();
    for_ranges(&ranges, |r| {
        r.map(|i| {
            let (w, age) = (&warped[i], ages[i]);
            match below {
                None => baseline_at_warped(
                    w.x,
                    w.y,
                    rafts,
                    age,
                    domain,
                    warp_seed,
                    Some(blobs),
                    None,
                    0,
                    f64::NAN,
                ),
                Some(below) => {
                    let t = margin_parameter(raft_field_indexed(w.x, w.y, blobs));
                    baseline_at_warped(
                        w.x,
                        w.y,
                        rafts,
                        age,
                        domain,
                        warp_seed,
                        Some(blobs),
                        None,
                        0,
                        t,
                    ) + below(xs[i], ys[i], t, age)
                }
            }
        })
        .collect::<Vec<_>>()
    })
    .concat()
}

/// The points of one block of `raft_baselines`.
const BASELINE_BLOCK: usize = 4096;

/// The baseline after the warp. `relief`, when given, holds the hypsometry
/// relief per cell (NaN: not yet), read from cell `index` or written there;
/// `margin`, when not NaN, is the margin parameter already evaluated.
#[allow(clippy::too_many_arguments)]
fn baseline_at_warped(
    wx: f64,
    wy: f64,
    rafts: &[Raft],
    age: f64,
    domain: &Domain,
    warp_seed: f64,
    blobs: Option<&BlobIndex>,
    relief: Option<&mut [f64]>,
    index: usize,
    margin: f64,
) -> f64 {
    let oceanic = ocean_floor_at_age(age);
    let t = if !margin.is_nan() {
        margin
    } else {
        margin_parameter(match blobs {
            Some(b) => raft_field_indexed(wx, wy, b),
            None => raft_field(wx, wy, rafts, domain),
        })
    };
    let mut hypsometry = 0.0;
    match relief {
        None => hypsometry = continental_hypsometry(wx, wy, t, domain, warp_seed),
        Some(relief) => {
            if t > ELEVATION_TUNING.hypsometry_t_in {
                let mut r = relief[index];
                if r.is_nan() {
                    r = hypsometry_relief(wx, wy, domain, warp_seed);
                    relief[index] = r;
                }
                hypsometry = r * hypsometry_weight(t);
            }
        }
    }
    margin_profile(t, oceanic) + hypsometry
}

const AGE_RASTER_PER_CELL: f64 = 4.0;

/// The baseline on a render_width × render_height raster over the domain,
/// the ocean age read from a chart raster of it.
pub fn compute_raft_baseline(
    rafts: &[Raft],
    ocean_age: OceanAgeInput,
    render_width: usize,
    render_height: usize,
    domain: &Domain,
    warp_seed: f64,
) -> Vec<f32> {
    let blobs = build_blob_index(rafts, domain, 1.0);
    let n = render_width * render_height;
    let scale_x = domain.width / render_width as f64;
    let scale_y = domain.height / render_height as f64;
    let mut warped_x = vec![0.0; n];
    let mut warped_y = vec![0.0; n];
    for py in 0..render_height {
        let world_y = py as f64 * scale_y;
        for px in 0..render_width {
            let w = domain_warp_point(px as f64 * scale_x, world_y, domain, warp_seed);
            warped_x[py * render_width + px] = w.x;
            warped_y[py * render_width + px] = w.y;
        }
    }
    let mut relief = vec![f64::NAN; n];
    let age_res_x = OCEAN_AGE_RES_X * AGE_RASTER_PER_CELL;
    let age_res_y = js::max(1.0, js::round((age_res_x * domain.height) / domain.width)) as usize;
    let age_grid = domain.grid(age_res_x as usize, age_res_y);
    let ages =
        ocean_age.map(|(sm, field)| ocean_age_raster(sm, field, age_res_x as usize, age_res_y));
    (0..n)
        .map(|i| {
            let age = match &ages {
                Some(a) => age_grid.sample_bilinear_at(a, warped_x[i], warped_y[i]),
                None => 0.0,
            };
            baseline_at_warped(
                warped_x[i],
                warped_y[i],
                rafts,
                age,
                domain,
                warp_seed,
                Some(&blobs),
                Some(&mut relief),
                i,
                f64::NAN,
            ) as f32
        })
        .collect()
}

/// The warped sample point of a pixel, wrapped back as a point.
pub fn warped_sample_point(x: f64, y: f64, domain: &Domain, warp_seed: f64) -> Vec2 {
    let w = domain_warp_point(x, y, domain, warp_seed);
    domain.wrap_point(w.x, w.y)
}

/// THE UPLIFT DECK at a warped point: the features' thickness as height,
/// averaged over their capsules, divided by max(1, Σ weight).
pub fn uplift_deck_at(
    wx: f64,
    wy: f64,
    fb: &FeatureBuckets,
    domain: &Domain,
    near: &mut Vec<u32>,
) -> f64 {
    fb.near(wx, wy, near);
    let range_perp = range_perp_radius(domain);
    let trench_perp = trench_perp_radius(domain);
    let range_half = range_half_length(domain);
    let trench_half = trench_half_length(domain);
    let (mut uplift_sum, mut weight_sum) = (0.0, 0.0);
    for &b in near.iter() {
        for &fi in &fb.buckets[b as usize] {
            let f = &fb.features[fi as usize];
            let trench = f.kind == FeatureKind::Trench;
            let half = if trench { trench_half } else { range_half };
            let perp = if trench { trench_perp } else { range_perp };
            let o = domain.delta(wx, wy, f.x, f.y);
            let w = capsule_weight(o.x, o.y, f.tangent_x, f.tangent_y, half, perp);
            if w <= 0.0 {
                continue;
            }
            uplift_sum += f.thickness * ELEVATION_TUNING.thickness_to_elevation_scale * w;
            weight_sum += w;
        }
    }
    if weight_sum > 0.0 {
        uplift_sum / js::max(1.0, weight_sum)
    } else {
        0.0
    }
}

/// The synthesis's height at a warped point.
#[allow(clippy::too_many_arguments)]
pub fn compute_elevation(
    wx: f64,
    wy: f64,
    blended_baseline: f64,
    fb: &FeatureBuckets,
    domain: &Domain,
    ridge_value: f64,
    fine_value: f64,
    near: &mut Vec<u32>,
) -> f64 {
    let uplift = uplift_deck_at(wx, wy, fb, domain, near);
    let detail = if uplift > 0.0 {
        (ridge_value - RIDGE_MEAN) * uplift * ELEVATION_TUNING.ridge_relative_strength
    } else {
        0.0
    };
    let mut elevation = blended_baseline + uplift + detail;
    if fine_value != 0.0 && elevation > 0.0 {
        elevation += fine_value
            * js::min(
                ELEVATION_TUNING.plain_detail_max,
                elevation * ELEVATION_TUNING.plain_detail_height_fraction,
            );
    }
    js::max(-1.0, elevation)
}

/// Each continent's land heights redistributed against its own peak, by
/// the owner field.
pub fn apply_mountain_redistribution(
    elevations: &mut [f32],
    domain: &Domain,
    owner_field: &[i32],
    owner_res_x: usize,
    owner_res_y: usize,
) {
    let (width, height) = (domain.width as usize, domain.height as usize);
    let owner_grid = domain.grid(owner_res_x, owner_res_y);
    let mut owner_at = vec![0i32; elevations.len()];
    let mut max_by_owner: HashMap<i32, f64> = HashMap::new();
    for y in 0..height {
        for x in 0..width {
            let i = y * width + x;
            let owner = sample_owner_field(owner_field, &owner_grid, x as f64, y as f64);
            owner_at[i] = owner;
            let e = elevations[i] as f64;
            if e <= 0.0 {
                continue;
            }
            if e > *max_by_owner.get(&owner).unwrap_or(&0.0) {
                max_by_owner.insert(owner, e);
            }
        }
    }
    for i in 0..elevations.len() {
        let e = elevations[i] as f64;
        if e <= 0.0 {
            continue;
        }
        let max_land = *max_by_owner.get(&owner_at[i]).unwrap_or(&0.0);
        if max_land <= 0.0 {
            continue;
        }
        let normalized = e / max_land;
        elevations[i] =
            (det_pow(normalized, ELEVATION_TUNING.mountain_redistribution_gamma) * max_land) as f32;
    }
}
