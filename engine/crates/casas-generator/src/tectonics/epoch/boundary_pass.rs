//! Phases 2 and 3: the epoch's boundaries detected and classified, uplift
//! and subsidence laid on the terrain features (at the Voronoi boundaries
//! and at the carriers' margins), accretion at subduction arcs, and the
//! decision which plate rift, plate merge and continental rift the epoch
//! has earned. The reasoning and the measurements are in the TypeScript
//! port (`client/src/generator/tectonics/epoch/boundaryPass.ts`, git
//! history).

use std::collections::HashMap;

use crate::core::det_math::det_pow;
use crate::core::domain::Domain;
use crate::core::js;
use crate::core::world_time::{TECTONIC_MA_PER_EPOCH, world_epoch};
use crate::crust::raft_field::{
    BlobIndex, build_blob_index, nearest_raft_indexed, raft_field_indexed, raft_membership,
};
use crate::crust::raft_lifecycle::{
    RAFT_CARRY_REACH, accrete_to_nearest_raft, carrier_plate_at, raft_host_plates,
};
use crate::tectonics::boundary_classification::{
    BoundaryCharacter, BoundaryClassification, UpliftSide, classify_boundary,
};
use crate::tectonics::boundary_detection::{BoundaryPoint, detect_boundaries};
use crate::tectonics::plate_motion::km_per_myr;
use crate::tectonics::plate_seeds::PlateSeed;
use crate::tectonics::plate_simulation_types::{MergeEvent, PlateSimulation, RiftEvent};
use crate::tectonics::plate_types::PlateType;
use crate::tectonics::plate_velocity_decomposition::{
    BoundaryMotionClass, classify_boundary_motion,
};
use crate::tectonics::tectonics_tune_params::TECTONICS_TUNING as T;
use crate::tectonics::terrain_features::{
    FeatureKind, MovesWith, TerrainFeature, find_or_create_feature_index,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContinentalRift {
    pub x: f64,
    pub y: f64,
    pub plate_a: usize,
    pub plate_b: usize,
    pub index: usize,
}

pub struct BoundaryPassResult {
    pub boundaries: Vec<BoundaryPoint>,
    pub rift_event: Option<RiftEvent>,
    pub merge_event: Option<MergeEvent>,
    pub continental_rift: Option<ContinentalRift>,
}

fn unit(x: f64, y: f64) -> (f64, f64) {
    let len = (x * x + y * y).sqrt();
    let len = if len == 0.0 || len.is_nan() { 1.0 } else { len };
    (x / len, y / len)
}

/// The epoch's deposits per feature, summed and counted, in the order the
/// features were first deposited onto.
#[derive(Default)]
struct Deposits {
    order: Vec<usize>,
    at: HashMap<usize, (f64, f64)>,
}

impl Deposits {
    fn add(&mut self, feature: usize, amount: f64) {
        match self.at.get_mut(&feature) {
            Some(e) => {
                e.0 += amount;
                e.1 += 1.0;
            }
            None => {
                self.order.push(feature);
                self.at.insert(feature, (amount, 1.0));
            }
        }
    }
}

/// Lays down a boundary's relief at (x, y) between plates A and B: the
/// range (an arc's flagged volcanic) and, at an arc, the trench toward the
/// subducting side.
#[allow(clippy::too_many_arguments)]
fn lay_relief(
    features: &mut Vec<TerrainFeature>,
    deposits: &mut Deposits,
    domain: &Domain,
    x: f64,
    y: f64,
    plate_a: usize,
    plate_b: usize,
    relief: &BoundaryClassification,
    amount: f64,
    nx: f64,
    ny: f64,
    trench_dir_x: f64,
    trench_dir_y: f64,
) {
    let (tangent_x, tangent_y) = (-ny, nx);
    let moves = match relief.uplift_side {
        UpliftSide::Both => MovesWith::Both,
        UpliftSide::A => MovesWith::Plate(plate_a as u32),
        UpliftSide::B => MovesWith::Plate(plate_b as u32),
    };
    let subsides = matches!(
        relief.character,
        BoundaryCharacter::IslandArc | BoundaryCharacter::MidOceanRidge
    );
    let range = find_or_create_feature_index(
        features,
        x,
        y,
        plate_a as i32,
        plate_b as i32,
        moves,
        tangent_x,
        tangent_y,
        FeatureKind::Range,
        subsides,
        domain,
    );
    let arc = matches!(
        relief.character,
        BoundaryCharacter::SubductionArc | BoundaryCharacter::IslandArc
    );
    if arc {
        features[range].volcanic = Some(true);
    }
    deposits.add(range, amount);
    if arc {
        let subducting = if relief.uplift_side == UpliftSide::A {
            plate_b
        } else {
            plate_a
        };
        let trench_offset = T.trench_offset_m / domain.metres_per_unit;
        let p = domain.advance(
            x,
            y,
            trench_dir_x * trench_offset,
            trench_dir_y * trench_offset,
        );
        let trench = find_or_create_feature_index(
            features,
            p.x,
            p.y,
            plate_a as i32,
            plate_b as i32,
            MovesWith::Plate(subducting as u32),
            tangent_x,
            tangent_y,
            FeatureKind::Trench,
            true,
            domain,
        );
        deposits.add(trench, -amount.abs() * T.trench_depth_fraction);
    }
}

/// The carriers' margins: every lattice edge (one step east, one south)
/// across which the plate that carries the crust changes next to a raft
/// lays down its relief at the overriding side's coast.
fn deposit_carrier_margins(
    sim: &mut PlateSimulation,
    deposits: &mut Deposits,
    epoch_ma: f64,
    blobs: &BlobIndex,
    hosts: &[Option<usize>],
) {
    let domain = &sim.domain;
    let step = domain.width / T.detection_lattice_resolution_x as f64;
    let search_steps = (T.coast_search_m / domain.metres_per_unit / (step / 2.0)).ceil() as i64;
    let coast_along = |x: f64, y: f64, dx: f64, dy: f64| -> f64 {
        for k in 0..=search_steps {
            let d = k as f64 * (step / 2.0);
            let p = domain.advance(x, y, dx * d, dy * d);
            if raft_field_indexed(p.x, p.y, blobs) > 0.5 {
                return d;
            }
        }
        -1.0
    };
    for li in 0..sim.lattice.len() {
        let point = sim.lattice[li];
        let near_on_raft =
            nearest_raft_indexed(point.x, point.y, blobs, RAFT_CARRY_REACH).is_some();
        let mut near: Option<usize> = None;
        for d in 0..2 {
            let (dx, dy) = if d == 0 { (step, 0.0) } else { (0.0, step) };
            let far_end = domain.advance(point.x, point.y, dx, dy);
            if !near_on_raft
                && nearest_raft_indexed(far_end.x, far_end.y, blobs, RAFT_CARRY_REACH).is_none()
            {
                continue;
            }
            let near_plate = *near.get_or_insert_with(|| {
                carrier_plate_at(point.x, point.y, blobs, hosts, &sim.seeds, domain)
            });
            let far = carrier_plate_at(far_end.x, far_end.y, blobs, hosts, &sim.seeds, domain);
            if far == near_plate {
                continue;
            }
            let mid = domain.advance(point.x, point.y, dx / 2.0, dy / 2.0);
            let o = domain.delta(far_end.x, far_end.y, mid.x, mid.y);
            let (nx, ny) = unit(o.x, o.y);
            let coast_a = coast_along(mid.x, mid.y, nx, ny);
            let coast_b = coast_along(mid.x, mid.y, -nx, -ny);
            if coast_a < 0.0 && coast_b < 0.0 {
                continue;
            }
            let crust_a = if coast_a >= 0.0 {
                PlateType::Continental
            } else {
                PlateType::Oceanic
            };
            let crust_b = if coast_b >= 0.0 {
                PlateType::Continental
            } else {
                PlateType::Oceanic
            };
            let mid_seed = PlateSeed { x: mid.x, y: mid.y };
            let far_seed = PlateSeed {
                x: far_end.x,
                y: far_end.y,
            };
            let point_seed = PlateSeed {
                x: point.x,
                y: point.y,
            };
            let convergence = classify_boundary_motion(
                &mid_seed,
                &far_seed,
                &sim.motions[far],
                &point_seed,
                &sim.motions[near_plate],
                domain,
            );
            if convergence.motion_class == BoundaryMotionClass::Transform {
                continue;
            }
            if convergence.motion_class == BoundaryMotionClass::Divergent
                && (crust_a == PlateType::Oceanic || crust_b == PlateType::Oceanic)
            {
                continue;
            }
            let relief = classify_boundary(
                crust_a,
                sim.ages[far],
                crust_b,
                sim.ages[near_plate],
                convergence.motion_class,
            );
            if relief.elevation_sign == 0 {
                continue;
            }
            let amount = (km_per_myr(convergence.normal, domain) * epoch_ma * T.uplift_per_km)
                .abs()
                * relief.rate
                * relief.elevation_sign as f64;
            let (mut x, mut y) = (mid.x, mid.y);
            if relief.uplift_side != UpliftSide::Both {
                let to_a = relief.uplift_side == UpliftSide::A;
                let along = if to_a { coast_a } else { coast_b };
                let s = if to_a { 1.0 } else { -1.0 };
                let p = domain.advance(mid.x, mid.y, s * nx * along, s * ny * along);
                x = p.x;
                y = p.y;
            }
            let towards = if relief.uplift_side == UpliftSide::A {
                -1.0
            } else {
                1.0
            };
            lay_relief(
                &mut sim.features,
                deposits,
                domain,
                x,
                y,
                far,
                near_plate,
                &relief,
                amount,
                nx,
                ny,
                towards * nx,
                towards * ny,
            );
        }
    }
}

fn motion_class_code(c: BoundaryMotionClass) -> i8 {
    match c {
        BoundaryMotionClass::Convergent => 0,
        BoundaryMotionClass::Divergent => 1,
        BoundaryMotionClass::Transform => 2,
    }
}

pub fn run_boundary_pass(sim: &mut PlateSimulation) -> BoundaryPassResult {
    let boundaries = detect_boundaries(&sim.lattice, &sim.seeds, &sim.domain);
    let pressure = js::max(
        -T.plate_count_pressure_clamp,
        js::min(
            T.plate_count_pressure_clamp,
            (sim.initial_plate_count - sim.seeds.len() as f64) * T.plate_count_pressure_strength,
        ),
    );
    let effective_rift = T.rift_accumulator_threshold * (1.0 - pressure);
    let effective_merge = T.merge_accumulator_threshold * (1.0 + pressure);
    let mut rift_event = None;
    let mut merge_event = None;
    let mut continental_rift = None;
    let mut deposits = Deposits::default();
    let rafts = sim.rafts.clone();
    let domain = sim.domain.clone();
    let carrier_blobs = build_blob_index(&rafts, &domain, RAFT_CARRY_REACH);
    let raft_hosts = raft_host_plates(&rafts, &sim.seeds, &domain);
    let crust_side = T.crust_side_m / domain.metres_per_unit;
    let epoch_ma = if sim.epoch_ma == 0.0 || sim.epoch_ma.is_nan() {
        TECTONIC_MA_PER_EPOCH
    } else {
        sim.epoch_ma
    };

    for boundary in &boundaries {
        let (pa, pb) = (boundary.plate_a as usize, boundary.plate_b as usize);
        let seed_a = sim.seeds[pa];
        let seed_b = sim.seeds[pb];
        let at = PlateSeed {
            x: boundary.x,
            y: boundary.y,
        };
        let convergence = classify_boundary_motion(
            &at,
            &seed_a,
            &sim.motions[pa],
            &seed_b,
            &sim.motions[pb],
            &domain,
        );
        // The crust beside the point on each side, crustSideM into it, and
        // the plate that carries it. The relief, the events and the lattice's
        // accumulation all read this (TEG-72; DES-0027 entry 27, 2026-10-29),
        // not the type of the crust under a plate's seed.
        let o = domain.delta(seed_a.x, seed_a.y, seed_b.x, seed_b.y);
        let o = domain.transport(o.x, o.y, seed_b.x, seed_b.y, boundary.x, boundary.y);
        let (nx, ny) = unit(o.x, o.y);
        let side = |sx: f64| {
            let p = domain.advance(
                boundary.x,
                boundary.y,
                sx * nx * crust_side,
                sx * ny * crust_side,
            );
            let crust = if raft_field_indexed(p.x, p.y, &carrier_blobs) > 0.5 {
                PlateType::Continental
            } else {
                PlateType::Oceanic
            };
            let carrier =
                carrier_plate_at(p.x, p.y, &carrier_blobs, &raft_hosts, &sim.seeds, &domain);
            (crust, carrier)
        };
        let (crust_a, carrier_a) = side(1.0);
        let (crust_b, carrier_b) = side(-1.0);
        let classification = classify_boundary(
            crust_a,
            sim.ages[pa],
            crust_b,
            sim.ages[pb],
            convergence.motion_class,
        );
        let code = motion_class_code(convergence.motion_class);
        let index = boundary.lattice_index as usize;
        if sim.lattice_last_class_code[index] == code {
            sim.lattice_locked_epochs[index] = sim.lattice_locked_epochs[index].wrapping_add(1);
        } else {
            sim.lattice_locked_epochs[index] = 0;
            sim.lattice_last_class_code[index] = code;
        }
        let epoch_convergence =
            km_per_myr(convergence.normal, &domain) * epoch_ma * T.uplift_per_km;
        sim.lattice_accumulated[index] = (sim.lattice_accumulated[index] as f64
            + epoch_convergence * classification.rate)
            as f32;

        if classification.elevation_sign != 0 {
            let continental =
                crust_a == PlateType::Continental || crust_b == PlateType::Continental;
            let intraplate = if convergence.motion_class == BoundaryMotionClass::Convergent {
                T.intraplate_shortening
            } else {
                0.0
            };
            let deformation = if carrier_a == carrier_b {
                if continental { intraplate } else { 0.0 }
            } else if continental {
                0.0
            } else {
                1.0
            };
            if deformation > 0.0 {
                let relief = &classification;
                let age_multiplier = T.age_multiplier_floor
                    + T.age_multiplier_range
                        * det_pow(
                            2.0,
                            -(sim.lattice_locked_epochs[index] as f64)
                                / T.age_multiplier_half_life_epochs,
                        );
                let amount = epoch_convergence.abs()
                    * relief.rate
                    * age_multiplier
                    * relief.elevation_sign as f64
                    * deformation;
                let subducting = if relief.uplift_side == UpliftSide::A {
                    seed_b
                } else {
                    seed_a
                };
                let t = domain.delta(subducting.x, subducting.y, boundary.x, boundary.y);
                let (tx, ty) = unit(t.x, t.y);
                lay_relief(
                    &mut sim.features,
                    &mut deposits,
                    &domain,
                    boundary.x,
                    boundary.y,
                    pa,
                    pb,
                    relief,
                    amount,
                    nx,
                    ny,
                    tx,
                    ty,
                );
            }
            if classification.character == BoundaryCharacter::SubductionArc
                && sim.epoch % T.accretion_epoch_interval == 0.0
            {
                // Inset into the continental side, along the boundary's normal.
                let (ix, iy) = if classification.uplift_side == UpliftSide::A {
                    (nx, ny)
                } else {
                    (-nx, -ny)
                };
                let unit_m = domain.metres_per_unit;
                let inset = T.accretion_inset_m / unit_m;
                let min_gap = T.accretion_min_gap_m / unit_m;
                let max_attach = T.accretion_max_attach_m / unit_m;
                let p = domain.advance(boundary.x, boundary.y, ix * inset, iy * inset);
                accrete_to_nearest_raft(
                    &mut sim.rafts,
                    p.x,
                    p.y,
                    T.accretion_blob_radius_m / unit_m,
                    world_epoch(sim.archean_epochs, sim.epoch),
                    min_gap * min_gap,
                    max_attach * max_attach,
                    &domain,
                );
            }
        }

        if continental_rift.is_none()
            && sim.epoch >= sim.continental_rift_cooldown_until
            && convergence.motion_class == BoundaryMotionClass::Divergent
            && sim.lattice_locked_epochs[index] as f64 >= T.cont_rift_lock_epochs
            && sim.lattice_accumulated[index] as f64
                <= effective_rift * T.cont_rift_threshold_factor
            && raft_membership(boundary.x, boundary.y, &sim.rafts, &domain) > 0.5
        {
            continental_rift = Some(ContinentalRift {
                x: boundary.x,
                y: boundary.y,
                plate_a: pa,
                plate_b: pb,
                index,
            });
        }

        if (sim.lattice_locked_epochs[index] as f64) < T.lock_epochs_required {
            continue;
        }
        let accumulated = sim.lattice_accumulated[index] as f64;
        if rift_event.is_none()
            && convergence.motion_class == BoundaryMotionClass::Divergent
            && accumulated <= effective_rift
        {
            rift_event = Some(RiftEvent {
                x: boundary.x,
                y: boundary.y,
                plate_a: pa,
                plate_b: pb,
            });
        } else if merge_event.is_none()
            && sim.seeds.len() > T.min_plate_count
            && accumulated >= effective_merge
        {
            // The removed plate's side is oceanic unless both are continental.
            let removed_oceanic = classification.character != BoundaryCharacter::FoldMountains;
            let make = |keep, remove| MergeEvent {
                x: boundary.x,
                y: boundary.y,
                keep_index: keep,
                remove_index: remove,
                removed_oceanic,
            };
            merge_event = match classification.character {
                BoundaryCharacter::FoldMountains => Some(make(pa.min(pb), pa.max(pb))),
                BoundaryCharacter::SubductionArc => {
                    let a_oceanic = crust_a == PlateType::Oceanic;
                    Some(if a_oceanic {
                        make(pb, pa)
                    } else {
                        make(pa, pb)
                    })
                }
                BoundaryCharacter::IslandArc => {
                    Some(if classification.uplift_side == UpliftSide::A {
                        make(pa, pb)
                    } else {
                        make(pb, pa)
                    })
                }
                _ => None,
            };
        }
    }

    deposit_carrier_margins(sim, &mut deposits, epoch_ma, &carrier_blobs, &raft_hosts);

    let shortening_keep = det_pow(2.0, -epoch_ma / T.shortening_half_life_ma);
    for &fi in &deposits.order {
        let (sum, count) = deposits.at[&fi];
        let f = &mut sim.features[fi];
        f.thickness += sum / count;
        f.epochs_since_deposit = 0.0;
        if f.shortening_km_per_myr.is_none() && f.volcanic.is_none() {
            f.shortening_first = true;
        }
        f.shortening_km_per_myr = Some(
            f.shortening_km_per_myr.unwrap_or(0.0)
                + (1.0 - shortening_keep) * (sum / count) / (T.uplift_per_km * epoch_ma),
        );
        if f.kind == FeatureKind::Range && f.thickness < T.rift_basin_floor_thickness {
            f.thickness = T.rift_basin_floor_thickness;
            if f.shortening_km_per_myr.unwrap_or(0.0) < 0.0 {
                f.shortening_km_per_myr = Some(0.0);
            }
        }
    }
    BoundaryPassResult {
        boundaries,
        rift_event,
        merge_event,
        continental_rift,
    }
}
