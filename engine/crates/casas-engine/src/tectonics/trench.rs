//! `tectonics/trench.ts`: THE TRENCH (DEC-0036 phase 8e), the floor the slab
//! holds down where an oceanic plate subducts, as a term under the
//! tectonic baseline: on the boundary of the nearest two plates where they
//! converge as a subduction or an island arc, its relief a multiple of the
//! floor's own subsidence, fading to nothing at the slope's foot. The
//! reasoning is in the TypeScript port
//! (`client/src/generator/tectonics/trench.ts`, git history).
//!
//! The TypeScript function reads the plate simulation; this one takes the
//! parts of it the term is a function of.
//!
//! The boundary's character is read from the crust on each side,
//! `crust_side_m` into each plate, as the epoch's boundary pass reads it
//! (TEG-72; DES-0027 entry 27, 2026-10-29) — not from the crust under the
//! plates' seeds.

use crate::core::domain::Domain;
use crate::crust::raft_field::{build_blob_index, raft_field_indexed};
use crate::crust::raft_lifecycle::RAFT_CARRY_REACH;
use crate::crust::raft_types::Raft;
use crate::elevation::elevation_field::ocean_floor_at_age;
use crate::elevation::elevation_scale::{RIDGE_CREST, SLOPE_FOOT_T};

use super::boundary_classification::{BoundaryCharacter, classify_boundary};
use super::plate_motion::PlateMotion;
use super::plate_seeds::PlateSeed;
use super::plate_types::PlateType;
use super::plate_velocity_decomposition::{BoundaryMotionClass, classify_boundary_motion};
use super::tectonics_tune_params::TECTONICS_TUNING;

/// The term (x, y, margin, age) → depression, or None with fewer than two
/// plates.
pub fn trench_depression<'a>(
    seeds: &'a [PlateSeed],
    motions: &'a [PlateMotion],
    ages: &'a [f64],
    rafts: &'a [Raft],
    domain: &'a Domain,
) -> Option<impl Fn(f64, f64, f64, f64) -> f64 + 'a> {
    if seeds.len() < 2 {
        return None;
    }
    let blobs = build_blob_index(rafts, domain, RAFT_CARRY_REACH);
    let crust_side = TECTONICS_TUNING.crust_side_m / domain.metres_per_unit;
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
        // The crust beside the boundary, toward A and toward B.
        let o = domain.delta(seeds[a].x, seeds[a].y, seeds[b].x, seeds[b].y);
        let o = domain.transport(o.x, o.y, seeds[b].x, seeds[b].y, point.x, point.y);
        let len = (o.x * o.x + o.y * o.y).sqrt();
        let len = if len == 0.0 || len.is_nan() { 1.0 } else { len };
        let (nx, ny) = (o.x / len, o.y / len);
        let crust = |sx: f64| {
            let p = domain.advance(point.x, point.y, sx * nx * crust_side, sx * ny * crust_side);
            if raft_field_indexed(p.x, p.y, &blobs) > 0.5 {
                PlateType::Continental
            } else {
                PlateType::Oceanic
            }
        };
        let character =
            classify_boundary(crust(1.0), ages[a], crust(-1.0), ages[b], motion).character;
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
