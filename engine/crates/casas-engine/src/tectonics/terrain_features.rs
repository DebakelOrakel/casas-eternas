//! `tectonics/terrainFeatures.ts`: a mountain range (or arc, ridge) or a
//! trench as an oriented feature that rides its plate; found or made where
//! a boundary deposits, carried with the plates every epoch. The reasoning
//! behind each field is in the TypeScript file.

use crate::core::domain::Domain;

use super::plate_motion::{PlateMotion, advance_point_by_motion, get_velocity_at};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeatureKind {
    Range,
    Trench,
}

/// Which plate's motion carries a feature: one of its pair, or the mean of
/// both.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MovesWith {
    Plate(u32),
    Both,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TerrainFeature {
    pub x: f64,
    pub y: f64,
    /// Signed relative crustal thickness change.
    pub thickness: f64,
    pub tangent_x: f64,
    pub tangent_y: f64,
    pub kind: FeatureKind,
    /// The plate pair, unordered; −1 a hotspot, −2 a flood basalt in
    /// `plate_b`.
    pub plate_a: i32,
    pub plate_b: i32,
    pub moves_with: MovesWith,
    pub subsides: bool,
    pub epochs_since_deposit: f64,
    /// A volcanic arc; None reads as false.
    pub volcanic: Option<bool>,
    /// The boundary's shortening rate, km/Myr; None reads as 0.
    pub shortening_km_per_myr: Option<f64>,
    /// The shortening was given before `volcanic`: TypeScript's object
    /// then holds its key first, and the save writes it first. No
    /// computation reads it.
    pub shortening_first: bool,
}

const MERGE_RADIUS_M: f64 = 312_000.0;
const TANGENT_REFRESH_RATE: f64 = 0.1;

fn normalize_tangent(tx: f64, ty: f64) -> (f64, f64) {
    let len = (tx * tx + ty * ty).sqrt();
    let len = if len == 0.0 || len.is_nan() { 1.0 } else { len };
    (tx / len, ty / len)
}

/// The feature a deposit at (x, y) for a plate pair goes to, made on the spot
/// when none matches; the matched feature's tangent is refreshed toward the
/// deposit's.
#[allow(clippy::too_many_arguments)]
pub fn find_or_create_feature_index(
    features: &mut Vec<TerrainFeature>,
    x: f64,
    y: f64,
    plate_a: i32,
    plate_b: i32,
    moves_with: MovesWith,
    mut tangent_x: f64,
    mut tangent_y: f64,
    kind: FeatureKind,
    subsides: bool,
    domain: &Domain,
) -> usize {
    let merge_radius = MERGE_RADIUS_M / domain.metres_per_unit;
    let merge_radius_sq = merge_radius * merge_radius;
    for (i, feature) in features.iter_mut().enumerate() {
        if feature.kind != kind {
            continue;
        }
        let same_pair = (feature.plate_a == plate_a && feature.plate_b == plate_b)
            || (feature.plate_a == plate_b && feature.plate_b == plate_a);
        if !same_pair {
            continue;
        }
        let o = domain.delta(x, y, feature.x, feature.y);
        if o.x * o.x + o.y * o.y <= merge_radius_sq {
            let t = domain.transport(tangent_x, tangent_y, x, y, feature.x, feature.y);
            tangent_x = t.x;
            tangent_y = t.y;
            let aligned = if feature.tangent_x * tangent_x + feature.tangent_y * tangent_y < 0.0 {
                -1.0
            } else {
                1.0
            };
            let (bx, by) = normalize_tangent(
                feature.tangent_x * (1.0 - TANGENT_REFRESH_RATE)
                    + aligned * tangent_x * TANGENT_REFRESH_RATE,
                feature.tangent_y * (1.0 - TANGENT_REFRESH_RATE)
                    + aligned * tangent_y * TANGENT_REFRESH_RATE,
            );
            feature.tangent_x = bx;
            feature.tangent_y = by;
            return i;
        }
    }
    let (tx, ty) = normalize_tangent(tangent_x, tangent_y);
    features.push(TerrainFeature {
        x,
        y,
        thickness: 0.0,
        tangent_x: tx,
        tangent_y: ty,
        kind,
        plate_a,
        plate_b,
        moves_with,
        subsides,
        epochs_since_deposit: 0.0,
        volcanic: None,
        shortening_km_per_myr: None,
        shortening_first: false,
    });
    features.len() - 1
}

/// Every feature carried with its plate(s) for `step_ma`, its tangent
/// carried with the point.
pub fn advance_terrain_features(
    features: &mut [TerrainFeature],
    motions: &[PlateMotion],
    step_ma: f64,
    domain: &Domain,
) {
    for f in features.iter_mut() {
        let (from_x, from_y) = (f.x, f.y);
        let p = match f.moves_with {
            MovesWith::Both => {
                let va = get_velocity_at(f.x, f.y, &motions[f.plate_a as usize], domain);
                let vb = get_velocity_at(f.x, f.y, &motions[f.plate_b as usize], domain);
                let vx = (va.x + vb.x) / 2.0;
                let vy = (va.y + vb.y) / 2.0;
                domain.advance(f.x, f.y, vx * step_ma, vy * step_ma)
            }
            MovesWith::Plate(p) => {
                advance_point_by_motion(f.x, f.y, &motions[p as usize], step_ma, domain)
            }
        };
        f.x = p.x;
        f.y = p.y;
        let t = domain.transport(f.tangent_x, f.tangent_y, from_x, from_y, f.x, f.y);
        f.tangent_x = t.x;
        f.tangent_y = t.y;
    }
}
