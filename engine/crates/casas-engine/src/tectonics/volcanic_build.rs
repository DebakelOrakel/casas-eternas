//! THE VOLCANOES' BUILD (docs/decisions/volcanic-islands.md): an island arc
//! and a hotspot pile lava up from the sea floor. The uplift the erosion
//! applies is crustal thickening and lifts land only (`kernel_uplift`), and
//! a hotspot's or a flood basalt's feature has no uplift at all
//! (`uplift_field.rs`): an arc stood 4–5 km under the sea for good, and the
//! open ocean held no island the history made. Measured 2026-10-27 (alpha,
//! epoch 40): 1107 subsiding features on the torus, the median's highest
//! node −4300 to −4600 m.
//!
//! The build: under an active volcano the surface rises by
//! `volcano_build_m_per_myr` at the axis, in the capsule falloff of
//! `volcano_radius_m` across it (a hotspot's a disc), until it stands at
//! `volcano_top_m`; above that the erosion and the arc's shortening have
//! it. Active: an island arc (a volcanic feature that subsides, both plates
//! oceanic) that took a deposit this epoch, a hotspot's feature while the
//! plume feeds it. The plate carries the build away; the ocean floor's age
//! takes it down again, and the waves plane it.

use crate::core::domain::Domain;
use crate::elevation::capsule::capsule_weight;
use crate::elevation::elevation_field::{build_feature_buckets, range_half_length};
use crate::elevation::elevation_scale::ELEVATION_METERS;
use crate::mesh::periodic_delaunay::PeriodicTriangulation;

use super::tectonics_tune_params::TECTONICS_TUNING;
use super::terrain_features::TerrainFeature;

fn active(f: &TerrainFeature) -> bool {
    let island_arc = f.volcanic == Some(true) && f.subsides && f.plate_b >= 0;
    let hotspot = f.plate_b == -1;
    if island_arc {
        f.epochs_since_deposit < 1.0
    } else {
        hotspot && f.epochs_since_deposit < TECTONICS_TUNING.hotspot_epoch_interval
    }
}

/// The build at each slot, metres, over `epoch_ma`; `z` in elevation units
/// against the sea.
pub fn build_volcanoes(
    mesh: &PeriodicTriangulation,
    z: &[f32],
    features: &[TerrainFeature],
    domain: &Domain,
    epoch_ma: f64,
) -> Vec<f32> {
    let t = &TECTONICS_TUNING;
    let mut build_m = vec![0f32; z.len()];
    let buckets = build_feature_buckets(features, domain);
    let radius = t.volcano_radius_m / domain.metres_per_unit;
    let arc_half = range_half_length(domain);
    let most = t.volcano_build_m_per_myr * epoch_ma;
    let mut near = Vec::new();
    for v in 0..z.len() {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        let room = t.volcano_top_m - z[v] as f64 * ELEVATION_METERS;
        if room <= 0.0 {
            continue;
        }
        let (x, y) = (mesh.vx[v], mesh.vy[v]);
        buckets.near(x, y, &mut near);
        let mut weight = 0f64;
        for &b in &near {
            for &fi in &buckets.buckets[b as usize] {
                let f = &features[fi as usize];
                if !active(f) {
                    continue;
                }
                let half = if f.plate_b == -1 { 0.0 } else { arc_half };
                let o = domain.delta(x, y, f.x, f.y);
                weight = weight.max(capsule_weight(
                    o.x,
                    o.y,
                    f.tangent_x,
                    f.tangent_y,
                    half,
                    radius,
                ));
            }
        }
        if weight > 0.0 {
            build_m[v] = (most * weight).min(room) as f32;
        }
    }
    build_m
}
