//! `elevation/elevationSampler.ts`: the synthesis at a point — the
//! pre-erosion terrain as a function of (x, y), the form the adaptive mesh
//! is built from: the raft baseline with the warp, the dynamic topography,
//! the deck's isostasy when given, and the elevation over the feature
//! buckets with the ridged and the fine noise at the warped point.
//!
//! The ocean age and the deflection are read on the world's shared field
//! mesh, the dynamic topography on the mantle's; both sample through the
//! meshes' walks, which the sampler holds for its lifetime.

use std::cell::RefCell;

use crate::core::domain::Domain;
use crate::core::js;
use crate::crust::raft_types::Raft;
use crate::fields::field_mesh::SharedFieldMesh;
use crate::mantle::mantle_field::MantleMesh;
use crate::mesh::mesh_build::FieldSampler;
use crate::tectonics::terrain_features::TerrainFeature;

use super::dynamic_topography::dynamic_topography_at;
use super::elevation_field::{
    FeatureBuckets, build_feature_buckets, compute_elevation, raft_baseline_at, warped_sample_point,
};
use super::elevation_scale::ELEVATION_METERS;
use super::ridged_noise::{FINE_DETAIL_SEED_SALT, fine_detail_noise_on, ridged_multifractal_on};

/// What the synthesis reads of a plate simulation (`SynthesisSources`).
pub struct SynthesisSources<'a> {
    pub domain: &'a Domain,
    pub rafts: &'a [Raft],
    pub features: &'a [TerrainFeature],
    /// Per cell of the shared field mesh.
    pub ocean_age: &'a [f64],
    /// Per cell of the mantle's mesh.
    pub mantle: &'a [f64],
    pub warp_seed: f64,
}

struct Meshes<'a> {
    shared: &'a mut SharedFieldMesh,
    mantle: &'a mut MantleMesh,
    near: Vec<u32>,
}

/// The synthesis as a sampler for the mesh's build.
pub struct SynthesisSampler<'a> {
    s: SynthesisSources<'a>,
    buckets: FeatureBuckets<'a>,
    fine_seed: f64,
    /// The plate's deflection under the uplift deck, metres per cell of the
    /// shared mesh (+ up).
    deflection_m: Option<&'a [f64]>,
    meshes: RefCell<Meshes<'a>>,
}

pub fn synthesis_sampler<'a>(
    s: SynthesisSources<'a>,
    shared: &'a mut SharedFieldMesh,
    mantle: &'a mut MantleMesh,
    deflection_m: Option<&'a [f64]>,
) -> SynthesisSampler<'a> {
    let buckets = build_feature_buckets(s.features, s.domain);
    let fine_seed = (js::to_int32(s.warp_seed) ^ FINE_DETAIL_SEED_SALT as i32) as u32 as f64;
    SynthesisSampler {
        s,
        buckets,
        fine_seed,
        deflection_m,
        meshes: RefCell::new(Meshes {
            shared,
            mantle,
            near: Vec::new(),
        }),
    }
}

impl FieldSampler for SynthesisSampler<'_> {
    fn height_at(&self, x: f64, y: f64) -> f64 {
        let s = &self.s;
        let mut m = self.meshes.borrow_mut();
        let Meshes {
            shared,
            mantle,
            near,
        } = &mut *m;
        let mut baseline =
            raft_baseline_at(
                x,
                y,
                s.rafts,
                Some((&mut **shared, s.ocean_age)),
                s.domain,
                s.warp_seed,
                None,
                None,
            ) + dynamic_topography_at(s.mantle, &mantle.sampler, &mut mantle.mesh, x, y);
        if let Some(w) = self.deflection_m {
            baseline += shared.sampler.sample(&mut shared.mesh, w, x, y) / ELEVATION_METERS;
        }
        let wp = warped_sample_point(x, y, s.domain, s.warp_seed);
        compute_elevation(
            wp.x,
            wp.y,
            baseline,
            &self.buckets,
            s.domain,
            ridged_multifractal_on(s.domain, wp.x, wp.y, s.warp_seed),
            fine_detail_noise_on(s.domain, wp.x, wp.y, self.fine_seed),
            near,
        )
    }
}
