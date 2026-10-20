//! `tectonics/boundaryClassification.ts`: a boundary point's character from
//! the plate types and the motion class.

use super::plate_types::PlateType;
use super::plate_velocity_decomposition::BoundaryMotionClass;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoundaryCharacter {
    FoldMountains,
    SubductionArc,
    IslandArc,
    RiftValley,
    MidOceanRidge,
    TransformFault,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpliftSide {
    A,
    B,
    Both,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoundaryClassification {
    pub character: BoundaryCharacter,
    pub uplift_side: UpliftSide,
    pub rate: f64,
    /// +1 builds up, −1 sinks, 0 deposits nothing.
    pub elevation_sign: i32,
}

const FOLD_MOUNTAIN_RATE: f64 = 1.0;
const SUBDUCTION_RATE: f64 = 0.8;
const ISLAND_ARC_RATE: f64 = 0.6;
const RIFT_VALLEY_RATE: f64 = 0.5;
const MID_OCEAN_RIDGE_RATE: f64 = 0.3;
const TRANSFORM_RATE: f64 = 0.15;

pub fn classify_boundary(
    type_a: PlateType,
    age_a: f64,
    type_b: PlateType,
    age_b: f64,
    motion_class: BoundaryMotionClass,
) -> BoundaryClassification {
    use BoundaryCharacter::*;
    let make = |character, uplift_side, rate, elevation_sign| BoundaryClassification {
        character,
        uplift_side,
        rate,
        elevation_sign,
    };
    if motion_class == BoundaryMotionClass::Transform {
        return make(TransformFault, UpliftSide::Both, TRANSFORM_RATE, 0);
    }
    let both_continental = type_a == PlateType::Continental && type_b == PlateType::Continental;
    let both_oceanic = type_a == PlateType::Oceanic && type_b == PlateType::Oceanic;
    if motion_class == BoundaryMotionClass::Convergent {
        if both_continental {
            return make(FoldMountains, UpliftSide::Both, FOLD_MOUNTAIN_RATE, 1);
        }
        if both_oceanic {
            let side = if age_a <= age_b {
                UpliftSide::A
            } else {
                UpliftSide::B
            };
            return make(IslandArc, side, ISLAND_ARC_RATE, 1);
        }
        let side = if type_a == PlateType::Continental {
            UpliftSide::A
        } else {
            UpliftSide::B
        };
        return make(SubductionArc, side, SUBDUCTION_RATE, 1);
    }
    if both_oceanic {
        return make(MidOceanRidge, UpliftSide::Both, MID_OCEAN_RIDGE_RATE, 1);
    }
    make(RiftValley, UpliftSide::Both, RIFT_VALLEY_RATE, -1)
}
