//! `tectonics/trench.ts`: THE TRENCH (DEC-0036 phase 8e), the floor the slab
//! holds down where an oceanic plate subducts, as a term under the
//! tectonic baseline: on the boundary of the nearest two plates where they
//! converge as a subduction or an island arc, its relief a multiple of the
//! floor's own subsidence, fading to nothing at the slope's foot. The
//! reasoning is in the TypeScript file.
//!
//! The TypeScript function reads the plate simulation; this one takes the
//! parts of it the term is a function of.

use crate::core::domain::Domain;
use crate::crust::raft_field::derive_plate_types;
use crate::crust::raft_types::Raft;
use crate::elevation::elevation_field::ocean_floor_at_age;
use crate::elevation::elevation_scale::{RIDGE_CREST, SLOPE_FOOT_T};

use super::boundary_classification::{BoundaryCharacter, classify_boundary};
use super::plate_motion::PlateMotion;
use super::plate_seeds::PlateSeed;
use super::plate_velocity_decomposition::{BoundaryMotionClass, classify_boundary_motion};
use super::tectonics_tune_params::TECTONICS_TUNING;

/// The term (x, y, margin, age) → depression, or None with fewer than two
/// plates.
pub fn trench_depression<'a>(
    seeds: &'a [PlateSeed],
    motions: &'a [PlateMotion],
    ages: &'a [f64],
    rafts: &[Raft],
    domain: &'a Domain,
) -> Option<impl Fn(f64, f64, f64, f64) -> f64 + 'a> {
    if seeds.len() < 2 {
        return None;
    }
    let types = derive_plate_types(seeds, rafts, domain);
    let half_width = TECTONICS_TUNING.trench_half_width_m / domain.metres_per_unit;
    Some(move |x: f64, y: f64, margin: f64, age: f64| -> f64 {
        if margin >= SLOPE_FOOT_T {
            return 0.0;
        }
        let point = domain.wrap_point(x, y);
        let (mut a, mut b) = (usize::MAX, usize::MAX);
        let (mut da, mut db) = (f64::INFINITY, f64::INFINITY);
        for (p, s) in seeds.iter().enumerate() {
            let d = domain.distance_sq(point.x, point.y, s.x, s.y);
            if d < da {
                db = da;
                b = a;
                da = d;
                a = p;
            } else if d < db {
                db = d;
                b = p;
            }
        }
        let ab = domain
            .distance_sq(seeds[a].x, seeds[a].y, seeds[b].x, seeds[b].y)
            .sqrt();
        let s = if ab > 0.0 {
            (db - da) / (2.0 * ab)
        } else {
            f64::INFINITY
        };
        // `!(s < halfWidth)`.
        if s.is_nan() || s >= half_width {
            return 0.0;
        }
        let at = PlateSeed {
            x: point.x,
            y: point.y,
        };
        let motion =
            classify_boundary_motion(&at, &seeds[a], &motions[a], &seeds[b], &motions[b], domain)
                .motion_class;
        if motion != BoundaryMotionClass::Convergent {
            return 0.0;
        }
        let character = classify_boundary(types[a], ages[a], types[b], ages[b], motion).character;
        if character != BoundaryCharacter::SubductionArc
            && character != BoundaryCharacter::IslandArc
        {
            return 0.0;
        }
        let f = 1.0 - s / half_width;
        let gate = 1.0 - margin / SLOPE_FOOT_T;
        TECTONICS_TUNING.trench_relief_per_subsidence
            * (ocean_floor_at_age(age) - RIDGE_CREST)
            * f
            * f
            * (3.0 - 2.0 * f)
            * gate
            * gate
    })
}
