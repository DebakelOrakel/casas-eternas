//! THE VOLCANOES' BUILD (docs/decisions/volcanic-islands.md): an island arc
//! and a hotspot pile lava up from the sea floor. The uplift the erosion
//! applies is crustal thickening and lifts land only (`kernel_uplift`), and
//! a hotspot's or a flood basalt's feature has no uplift at all
//! (`uplift_field.rs`): an arc stood 4–5 km under the sea for good, and the
//! open ocean held no island the history made. Measured 2026-10-27 (alpha,
//! epoch 40): 1107 subsiding features on the torus, the median's highest
//! node −4300 to −4600 m.
//!
//! The build: a cone at each active volcano, `volcano_radius_m` round, rises
//! by `volcano_build_m_per_myr` at its summit toward a cone of
//! `volcano_top_m` (the capsule falloff, so the slopes fall to the sea at
//! its foot); above that the erosion and the arc's shortening have it. A
//! hotspot is one cone; an island arc's feature holds three, at
//! `volcano_spacing_m` along it, as an arc is a chain of volcanoes: built
//! along the whole segment, an arc rose as a strip 160 km wide and 1500 m
//! flat (islands of 10 000–1 000 000 km² three to four times as long as
//! wide, 2026-10-27). A cone no node is within builds at its nearest node,
//! within `volcano_reach_m`: the deep sea's mesh is 160 km, and the built
//! relief refines it (mesh_density.rs). An island arc's cones stand
//! `volcano_arc_gap_m` into the overriding plate, behind the trench, as an
//! arc's volcanic front does: at the boundary they stood on the trench's
//! depression. Active: an island arc (a volcanic feature that subsides,
//! both plates oceanic) fed within ARC_ACTIVE_EPOCHS, so it builds while
//! the subduction lasts (only in an epoch with a deposit, the cones stopped
//! 3–4 km under the sea; TEG-54, 2026-10-30), and a hotspot's feature while
//! the plume feeds it. The cone's load bends the plate (the flexure); the
//! plate carries the build away; the ocean floor's age takes it down
//! again, and the waves plane it.

use crate::core::det_math::det_hypot;
use crate::core::domain::Domain;
use crate::elevation::capsule::capsule_weight;
use crate::elevation::elevation_field::build_feature_buckets;
use crate::elevation::elevation_scale::ELEVATION_METERS;
use crate::mesh::periodic_delaunay::PeriodicTriangulation;

use super::plate_seeds::PlateSeed;
use super::tectonics_tune_params::TECTONICS_TUNING;
use super::terrain_features::{MovesWith, TerrainFeature};
use super::volcanoes::ARC_ACTIVE_EPOCHS;

fn active(f: &TerrainFeature) -> bool {
    let island_arc = f.volcanic == Some(true) && f.subsides && f.plate_b >= 0;
    let hotspot = f.plate_b == -1;
    if island_arc {
        f.epochs_since_deposit < ARC_ACTIVE_EPOCHS
    } else {
        hotspot && f.epochs_since_deposit < TECTONICS_TUNING.hotspot_epoch_interval
    }
}

// The direction from an island arc's feature into the overriding plate,
// normal to the feature: the side of the plate the feature moves with.
fn into_overriding(f: &TerrainFeature, seeds: &[PlateSeed], domain: &Domain) -> (f64, f64) {
    let MovesWith::Plate(p) = f.moves_with else {
        return (0.0, 0.0);
    };
    let Some(s) = seeds.get(p as usize) else {
        return (0.0, 0.0);
    };
    let (nx, ny) = (-f.tangent_y, f.tangent_x);
    let o = domain.delta(s.x, s.y, f.x, f.y);
    if nx * o.x + ny * o.y < 0.0 {
        (-nx, -ny)
    } else {
        (nx, ny)
    }
}

// The active volcanoes' cones, each a feature of no length (so the feature
// buckets find them). An island arc's cones stand `volcano_arc_gap_m` into
// the overriding plate.
fn cones(features: &[TerrainFeature], seeds: &[PlateSeed], domain: &Domain) -> Vec<TerrainFeature> {
    let spacing = TECTONICS_TUNING.volcano_spacing_m / domain.metres_per_unit;
    let gap = TECTONICS_TUNING.volcano_arc_gap_m / domain.metres_per_unit;
    let mut out = Vec::new();
    for f in features.iter().filter(|f| active(f)) {
        let along: &[f64] = if f.plate_b == -1 {
            &[0.0]
        } else {
            &[-1.0, 0.0, 1.0]
        };
        let (ix, iy) = if f.plate_b == -1 {
            (0.0, 0.0)
        } else {
            into_overriding(f, seeds, domain)
        };
        for &k in along {
            let p = domain.advance(
                f.x,
                f.y,
                k * spacing * f.tangent_x + gap * ix,
                k * spacing * f.tangent_y + gap * iy,
            );
            out.push(TerrainFeature {
                x: p.x,
                y: p.y,
                ..f.clone()
            });
        }
    }
    out
}

/// The build at each slot, metres, over `epoch_ma`; `z` in elevation units
/// against the sea.
pub fn build_volcanoes(
    mesh: &PeriodicTriangulation,
    z: &[f32],
    features: &[TerrainFeature],
    seeds: &[PlateSeed],
    domain: &Domain,
    epoch_ma: f64,
) -> Vec<f32> {
    let t = &TECTONICS_TUNING;
    let mut build_m = vec![0f32; z.len()];
    let cones = cones(features, seeds, domain);
    if cones.is_empty() {
        return build_m;
    }
    let buckets = build_feature_buckets(&cones, domain);
    let radius = t.volcano_radius_m / domain.metres_per_unit;
    let reach = t.volcano_reach_m / domain.metres_per_unit;
    let most = t.volcano_build_m_per_myr * epoch_ma;
    let build = |v: usize, weight: f64| -> f32 {
        let room = t.volcano_top_m * weight - z[v] as f64 * ELEVATION_METERS;
        if room <= 0.0 {
            return 0.0;
        }
        (most * weight).min(room) as f32
    };
    // Each cone's nearest node and whether one is within its radius.
    let mut nearest = vec![(f64::INFINITY, usize::MAX); cones.len()];
    let mut covered = vec![false; cones.len()];
    let mut near = Vec::new();
    for v in 0..z.len() {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        let (x, y) = (mesh.vx[v], mesh.vy[v]);
        buckets.near(x, y, &mut near);
        let mut weight = 0f64;
        for &b in &near {
            for &ci in &buckets.buckets[b as usize] {
                let c = &cones[ci as usize];
                let o = domain.delta(x, y, c.x, c.y);
                let d = det_hypot(o.x, o.y);
                let ci = ci as usize;
                if d < nearest[ci].0 {
                    nearest[ci] = (d, v);
                }
                let w = capsule_weight(o.x, o.y, c.tangent_x, c.tangent_y, 0.0, radius);
                if w > 0.0 {
                    covered[ci] = true;
                    weight = weight.max(w);
                }
            }
        }
        if weight > 0.0 {
            build_m[v] = build(v, weight);
        }
    }
    for (ci, &(d, v)) in nearest.iter().enumerate() {
        if !covered[ci] && d <= reach {
            build_m[v] = build_m[v].max(build(v, 1.0 - d / reach));
        }
    }
    build_m
}
