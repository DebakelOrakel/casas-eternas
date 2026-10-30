//! `tectonics/plumes.ts`: mantle plumes as persistent upwellings of the
//! mantle field, which creep toward the upwelling they sit on, retire when
//! it dies and appear where a strong one has none. The reasoning is in the
//! TypeScript file.

use crate::core::det_math::{det_hypot, sq};
use crate::core::domain::Domain;
use crate::core::js;
use crate::core::world_time::TECTONIC_MA_PER_EPOCH;
use crate::mantle::mantle_field::MantleMesh;

/// Mantle value a cell must reach to host a plume. Above the Archean's
/// nucleation threshold (0.70): a plume marks a strong upwelling, not only
/// one hot enough to make crust.
const PLUME_THRESHOLD: f64 = 0.85;
const PLUME_RETIRE_THRESHOLD: f64 = 0.55;
/// An upper bound only. The count comes from how many strong upwellings
/// the mantle makes, as the plate count comes from the convection cells.
const PLUME_MAX_COUNT: usize = 8;
/// Two plumes closer than this, metres, are one upwelling found twice. A
/// fraction of the chart's height until DEC-0036 phase 8f (0.14 × 1024
/// cells of the torus's 7.8 km; on the sphere's 10 000 km from pole to
/// pole it was 25 % longer).
const PLUME_MIN_SEPARATION_M: f64 = 1_118_208.0;
const PLUME_MAX_SPEED_KM_PER_MYR: f64 = 23.4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plume {
    pub x: f64,
    pub y: f64,
    pub id: i64,
    pub birth_epoch: f64,
}

/// The strongest upwellings, strongest first, thinned so each is a distinct
/// one; ids continue from those in `exclude`.
pub fn find_plume_sites(
    mantle: &[f64],
    mm: &MantleMesh,
    domain: &Domain,
    epoch: f64,
    exclude: &[Plume],
) -> Vec<Plume> {
    let mesh = &mm.mesh;
    let mut next_id = exclude.iter().fold(-1, |m, p| m.max(p.id)) + 1;
    let mut candidates: Vec<(f64, f64, f64)> = Vec::new();
    for i in 0..mesh.count {
        let v = mantle[i];
        if v < PLUME_THRESHOLD {
            continue;
        }
        // No neighbour higher (a NaN neighbour is not higher).
        let is_max = !mesh.edges(i).any(|e| mantle[mesh.nbr[e] as usize] > v);
        if !is_max {
            continue;
        }
        candidates.push((mesh.x[i], mesh.y[i], v));
    }
    // Stable, strongest first, as the comparator b − a.
    candidates.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let min_sep_sq = sq(PLUME_MIN_SEPARATION_M / domain.metres_per_unit);
    let mut chosen: Vec<(f64, f64)> = exclude.iter().map(|p| (p.x, p.y)).collect();
    let mut fresh = Vec::new();
    for &(x, y, _) in &candidates {
        if chosen.len() >= PLUME_MAX_COUNT {
            break;
        }
        if chosen
            .iter()
            .any(|&(sx, sy)| domain.distance_sq(sx, sy, x, y) < min_sep_sq)
        {
            continue;
        }
        chosen.push((x, y));
        fresh.push(Plume {
            x,
            y,
            id: next_id,
            birth_epoch: epoch,
        });
        next_id += 1;
    }
    fresh
}

/// One epoch of plume motion: a step uphill on the mesh's graph, capped
/// at the maximal speed; then the retired ones out, the new ones in.
pub fn advance_plumes(
    plumes: &mut Vec<Plume>,
    mantle: &[f64],
    mm: &mut MantleMesh,
    domain: &Domain,
    epoch: f64,
) {
    let max_step =
        (PLUME_MAX_SPEED_KM_PER_MYR * 1000.0 * TECTONIC_MA_PER_EPOCH) / domain.metres_per_unit;
    for plume in plumes.iter_mut() {
        let here = mm.sampler.nearest_cell(&mut mm.mesh, plume.x, plume.y);
        let mesh = &mm.mesh;
        let mut best = mantle[here];
        let mut target = None;
        for e in mesh.edges(here) {
            let n = mesh.nbr[e] as usize;
            let v = mantle[n];
            if v > best {
                best = v;
                target = Some(n);
            }
        }
        let Some(target) = target else {
            continue;
        };
        let t = domain.delta(mesh.x[target], mesh.y[target], plume.x, plume.y);
        let len = det_hypot(t.x, t.y);
        let len = if len == 0.0 || len.is_nan() { 1.0 } else { len };
        let step = js::min(max_step, len);
        let p = domain.advance(plume.x, plume.y, (t.x / len) * step, (t.y / len) * step);
        plume.x = p.x;
        plume.y = p.y;
    }
    for i in (0..plumes.len()).rev() {
        let c = mm
            .sampler
            .nearest_cell(&mut mm.mesh, plumes[i].x, plumes[i].y);
        if mantle[c] < PLUME_RETIRE_THRESHOLD {
            plumes.remove(i);
        }
    }
    let fresh = find_plume_sites(mantle, mm, domain, epoch, plumes);
    plumes.extend(fresh);
}
