//! The raw elevation raster of a render that has no terrain mesh yet (the
//! Archean): `render/elevationMapImage.ts` `renderSimulationImage` up to
//! its `rawElevations`, with the per-pixel loop of the render worker and
//! `dynamicTopographyField` (the TypeScript ports
//! `client/src/generator/render/elevationRenderWorker.ts` and
//! `client/src/generator/elevation/dynamicTopography.ts`, git history). The
//! colours, the shade and the redistribution stay TypeScript; they read
//! this raster.
//!
//! The render worker keeps the warped point, the ridge and the fine noise
//! of each pixel in Float32 arrays, so the port rounds them to f32 before
//! the synthesis reads them. Not ported, because it changes the time and
//! nothing else: the worker's cache of them per world and the split into
//! bands.

use crate::core::domain::Domain;
use crate::core::js;
use crate::crust::raft_types::Raft;
use crate::mantle::mantle_field::MantleMesh;
use crate::mesh::mesh_raster::rasterise_node_field;
use crate::tectonics::terrain_features::TerrainFeature;

use super::elevation_field::{
    OceanAgeInput, build_feature_buckets, compute_elevation, compute_raft_baseline,
    warped_sample_point,
};
use super::elevation_tune_params::ELEVATION_TUNING;
use super::ridged_noise::{FINE_DETAIL_SEED_SALT, fine_detail_noise_on, ridged_multifractal_on};

/// The grid the dynamic topography is rasterised on, at most.
const DYNAMIC_RASTER_X: usize = 256;
const DYNAMIC_RASTER_Y: usize = 128;

/// The dynamic topography over a `width` × `height` grid that covers the
/// domain, at each cell's corner, read bilinearly from the mantle
/// rasterised on a coarser grid plus the row at y = H.
pub fn dynamic_topography_field(
    mantle: &[f64],
    mm: &mut MantleMesh,
    width: usize,
    height: usize,
) -> Vec<f32> {
    let mut out = vec![0f32; width * height];
    let scale = ELEVATION_TUNING.dynamic_topography_per_unit;
    if scale == 0.0 {
        return out;
    }
    let cw = width.min(DYNAMIC_RASTER_X);
    let ch = height.min(DYNAMIC_RASTER_Y);
    let mut coarse = rasterise_node_field(&mut mm.mesh.tri, mantle, cw, ch);
    let (dw, dh) = (mm.mesh.domain.width, mm.mesh.domain.height);
    for i in 0..cw {
        let v = mm
            .sampler
            .sample(&mut mm.mesh, mantle, (i as f64 * dw) / cw as f64, dh);
        coarse.push(v as f32);
    }
    let at = |k: usize| coarse[k] as f64;
    for py in 0..height {
        let fy = (py as f64 * ch as f64) / height as f64;
        let j = fy.floor() as usize;
        let ty = fy - j as f64;
        for px in 0..width {
            let fx = (px as f64 * cw as f64) / width as f64;
            let i = fx.floor() as usize;
            let tx = fx - i as f64;
            let i1 = if i + 1 < cw { i + 1 } else { 0 };
            let a = at(j * cw + i) + (at(j * cw + i1) - at(j * cw + i)) * tx;
            let b = at((j + 1) * cw + i) + (at((j + 1) * cw + i1) - at((j + 1) * cw + i)) * tx;
            out[py * width + px] = ((a + (b - a) * ty) * scale) as f32;
        }
    }
    out
}

/// What the raster reads of a world (`RenderableWorld`).
pub struct RasterSources<'a> {
    pub domain: &'a Domain,
    pub rafts: &'a [Raft],
    pub features: &'a [TerrainFeature],
    pub mantle: &'a [f64],
    pub warp_seed: f64,
}

/// The raw elevation on the world raster, computed on a grid `scale` times
/// coarser and upscaled (the live preview's; 1 is the full raster). The
/// engine calls it for the Archean only, which has no features and no
/// ocean age: the uplift deck and its ridge are compared nowhere yet.
pub fn elevation_raster(
    s: &RasterSources,
    ocean_age: OceanAgeInput,
    mm: &mut MantleMesh,
    scale: usize,
) -> Vec<f32> {
    let (width, height) = (s.domain.width as usize, s.domain.height as usize);
    let scale = scale.max(1);
    let (rw, rh) = (width / scale, height / scale);
    let mut baseline = compute_raft_baseline(s.rafts, ocean_age, rw, rh, s.domain, s.warp_seed);
    let dynamic = dynamic_topography_field(s.mantle, mm, rw, rh);
    for i in 0..baseline.len() {
        baseline[i] = (baseline[i] as f64 + dynamic[i] as f64) as f32;
    }
    let buckets = build_feature_buckets(s.features, s.domain);
    let fine_seed = (js::to_int32(s.warp_seed) ^ FINE_DETAIL_SEED_SALT as i32) as u32 as f64;
    let scale_x = s.domain.width / rw as f64;
    let scale_y = s.domain.height / rh as f64;
    let mut near = Vec::new();
    let mut rendered = vec![0f32; rw * rh];
    for py in 0..rh {
        let world_y = py as f64 * scale_y;
        for px in 0..rw {
            let w = warped_sample_point(px as f64 * scale_x, world_y, s.domain, s.warp_seed);
            let (wx, wy) = (w.x as f32 as f64, w.y as f32 as f64);
            // The ridge and the fine noise at the warped point in doubles,
            // as the worker computes them, then kept as f32.
            let ridge = ridged_multifractal_on(s.domain, w.x, w.y, s.warp_seed) as f32 as f64;
            let fine = fine_detail_noise_on(s.domain, w.x, w.y, fine_seed) as f32 as f64;
            let i = py * rw + px;
            rendered[i] = compute_elevation(
                wx,
                wy,
                baseline[i] as f64,
                &buckets,
                s.domain,
                ridge,
                fine,
                &mut near,
            ) as f32;
        }
    }
    if scale == 1 {
        rendered
    } else {
        s.domain.grid(rw, rh).upscale(&rendered, width, height)
    }
}
