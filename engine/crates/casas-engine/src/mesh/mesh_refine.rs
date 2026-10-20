//! `mesh/meshRefine.ts`: one rung of the ladder — a parent mesh refined to
//! a finer budget under the same density rule, every parent kept, every
//! new node given the parent surface's height there plus the level's
//! synthesis (seed roughness and ridging). The TypeScript file explains
//! why the parent surface is sampled from a copy.

use crate::core::det_math::det_pow;
use crate::core::domain::Domain;
use crate::core::js;
use crate::core::rng::hash_seed_string;
use crate::elevation::ridged_noise::{fine_detail_noise, fine_detail_noise_scaled_on};
use crate::surface::amplify::{
    CASCADE_FALLOFF, RIDGE_FIELD_MEAN, RIDGE_STRENGTH, local_relief, ridged_at, ridged_at_on,
    seed_cascade_scales, seed_roughness_amplitude,
};

use super::mesh_build::{DensityTarget, MESH_Z};
use super::mesh_raster::rasterise_node_field;
use super::mesh_sampler::create_mesh_sampler;
use super::mesh_serial::{compact_mesh, decode_mesh, encode_mesh, permute};
use super::mesh_state::{FieldKind, MeshState};
use super::periodic_delaunay::PeriodicTriangulation;
use super::remesh::{RefineOptions, refine};

#[derive(Clone, Copy, Debug)]
pub struct RefineLevelOptions {
    pub budget: f64,
    pub seed: u32,
    pub level: u32,
    /// The macro raster's size in cells.
    pub width: usize,
    pub height: usize,
    pub max_rounds: Option<usize>,
}

pub struct RefinedLevel {
    pub mesh: PeriodicTriangulation,
    pub z: Vec<f32>,
    /// 1 where the node is a parent (kept), 0 where it is new.
    pub parent: Vec<u8>,
    pub inserted: usize,
}

/// The level's seed: the world's detail seed salted by the level number.
pub fn level_seed(seed: u32, level: u32) -> u32 {
    seed ^ hash_seed_string(&format!("mesh-level:{level}"))
}

/// What a level synthesis reads.
#[derive(Clone, Debug)]
pub struct SynthesisLevel {
    pub seed: u32,
    pub level: u32,
    pub budget: f64,
    pub width: usize,
    pub height: usize,
    /// A sphere world's domain, whose synthesis is read on the globe.
    pub sphere: Option<Domain>,
}

/// The synthesis a level puts on a new node at (x, y) over the parent's
/// height `base`; `relief` the parent's local relief there.
pub struct LevelSynthesis {
    l: SynthesisLevel,
    level_width: f64,
    level_height: f64,
    scales: Vec<f64>,
    amplitudes: Vec<f64>,
    norm: f64,
    seed: u32,
    ridge_seed: u32,
}

pub fn level_synthesis(l: SynthesisLevel) -> LevelSynthesis {
    let level_width = js::round(l.width as f64 / l.budget);
    let level_height = js::round(l.height as f64 / l.budget);
    let scales = seed_cascade_scales(level_width);
    let amplitudes: Vec<f64> = (0..scales.len())
        .map(|i| det_pow(CASCADE_FALLOFF, i as f64))
        .collect();
    let norm = amplitudes.iter().fold(0.0, |a, b| a + b);
    let seed = level_seed(l.seed, l.level);
    LevelSynthesis {
        l,
        level_width,
        level_height,
        scales,
        amplitudes,
        norm,
        seed,
        ridge_seed: seed ^ 0x5f35_6495,
    }
}

impl LevelSynthesis {
    fn octave_seed(&self, i: usize) -> f64 {
        js::to_uint32(self.seed as f64 + i as f64 * 0x9e37_79b9u32 as f64) as f64
    }

    pub fn at(&self, x: f64, y: f64, base: f64, relief: &mut dyn FnMut(f64, f64) -> f64) -> f64 {
        let amplitude = seed_roughness_amplitude(base);
        if amplitude == 0.0 {
            return base;
        }
        let mut noise = 0.0;
        if let Some(sphere) = &self.l.sphere {
            for i in 0..self.scales.len() {
                noise +=
                    fine_detail_noise_scaled_on(sphere, x, y, self.scales[i], self.octave_seed(i))
                        * self.amplitudes[i];
            }
            let ridge = (ridged_at_on(sphere, x, y, self.ridge_seed) - RIDGE_FIELD_MEAN)
                * relief(x, y)
                * RIDGE_STRENGTH;
            return base + (noise / self.norm) * amplitude + ridge;
        }
        let px = x / self.l.budget;
        let py = y / self.l.budget;
        for i in 0..self.scales.len() {
            let s = self.scales[i];
            noise += fine_detail_noise(
                px,
                py,
                self.level_width / s,
                self.level_height / s,
                self.octave_seed(i),
            ) * self.amplitudes[i];
        }
        let ridge = (ridged_at(px, py, self.level_width, self.level_height, self.ridge_seed)
            - RIDGE_FIELD_MEAN)
            * relief(x, y)
            * RIDGE_STRENGTH;
        base + (noise / self.norm) * amplitude + ridge
    }
}

/// A copy of the parent triangulation for the sampler, through the codec.
fn decode_parent(parent: &PeriodicTriangulation) -> PeriodicTriangulation {
    let order: Vec<i32> = (0..parent.vertex_slots() as i32).collect();
    decode_mesh(&parent.domain, &encode_mesh(parent, &order)).expect("the parent mesh decodes")
}

pub fn refine_mesh_level(
    mut mesh: PeriodicTriangulation,
    parent_z: &[f32],
    options: &RefineLevelOptions,
) -> RefinedLevel {
    let mut parent_sampler = create_mesh_sampler(decode_parent(&mesh), parent_z, None);
    let slots = mesh.vertex_slots();
    let mut state = MeshState::new(slots * 4);
    state.add(MESH_Z, FieldKind::Intensive, 1)[..slots].copy_from_slice(&parent_z[..slots]);
    {
        let is_parent = state.add("parent", FieldKind::Intensive, 1);
        for v in 0..slots {
            is_parent[v] = mesh.v_alive[v] as f32;
        }
    }
    let macro_ = rasterise_node_field(&mut mesh, parent_z, options.width, options.height);
    let macro_grid = mesh.domain.grid(options.width, options.height);
    let relief = local_relief(&macro_, &macro_grid);
    let synthesis = level_synthesis(SynthesisLevel {
        seed: options.seed,
        level: options.level,
        budget: options.budget,
        width: options.width,
        height: options.height,
        sphere: None,
    });
    let mut sample = |state: &mut MeshState,
                      _: &PeriodicTriangulation,
                      v: usize,
                      x: f64,
                      y: f64,
                      _: usize,
                      _: usize,
                      _: usize| {
        let base = parent_sampler.height_at(x, y);
        let z = synthesis.at(x, y, base, &mut |px, py| {
            macro_grid.sample_bilinear(&relief, px, py)
        });
        state.get_mut(MESH_Z)[v] = z as f32;
        state.get_mut("parent")[v] = 0.0;
    };
    let mut target = DensityTarget {
        budget: options.budget,
    };
    let mut refine_options = RefineOptions::seeded(level_seed(options.seed, options.level));
    if let Some(r) = options.max_rounds {
        refine_options.max_rounds = r;
    }
    refine_options.sample = Some(&mut sample);
    let stats = refine(&mut mesh, &mut state, &mut target, &mut refine_options);
    let (canonical, order) = compact_mesh(&mesh);
    let parent_field = permute(state.get("parent"), &order);
    let parent = parent_field.iter().map(|&p| u8::from(p > 0.5)).collect();
    RefinedLevel {
        z: permute(state.get(MESH_Z), &order),
        mesh: canonical,
        parent,
        inserted: stats.inserted,
    }
}
