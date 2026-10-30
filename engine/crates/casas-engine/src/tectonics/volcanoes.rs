//! The volcanoes a world shows, from its terrain features; the volcanoes
//! the ecology reads (`ecology_volcanoes`); and their settings, which
//! level 1 keeps for the eruptions (`ecology_volcano_settings`).

use crate::core::domain::Domain;
use crate::crust::raft_field::raft_field;
use crate::crust::raft_types::Raft;

use super::tectonics_tune_params::TECTONICS_TUNING;
use super::terrain_features::TerrainFeature;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VolcanoKind {
    Hotspot,
    Flood,
    Arc,
    /// An arc no longer fed (`epochs_since_deposit` ≥ ARC_ACTIVE_EPOCHS):
    /// only the ecology's list has it, for the copper (DEC-0053).
    ExtinctArc,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Volcano {
    pub x: f64,
    pub y: f64,
    pub thickness: f64,
    pub kind: VolcanoKind,
}

/// World-cell size for thinning the arcs' markers: a long subduction zone
/// has one range feature every ~312 km (MERGE_RADIUS_M), so hundreds
/// accumulate. One cone (the tallest) per cell of this size keeps the arc a
/// dotted chain. Hotspots and flood basalts are few and never thinned.
const ARC_MARKER_CELL: f64 = 60.0;

/// An arc feature fed within this many epochs is active; it builds its
/// volcanoes as long (volcanic_build.rs).
pub const ARC_ACTIVE_EPOCHS: f64 = 8.0;

/// An active arc carries a volcano from this relative thickness on.
const ARC_ACTIVE_THICKNESS: f64 = 3.0;

/// Hotspots and flood basalts, all; active volcanic arcs, the tallest per
/// cell, in the order their cells were first met.
pub fn collect_volcanoes(features: &[TerrainFeature]) -> Vec<Volcano> {
    let mut out = Vec::new();
    let mut cells: Vec<(f64, usize)> = Vec::new();
    let mut by_cell: std::collections::HashMap<u64, usize> = std::collections::HashMap::new();
    for (i, f) in features.iter().enumerate() {
        let volcano = |kind| Volcano {
            x: f.x,
            y: f.y,
            thickness: f.thickness.abs(),
            kind,
        };
        if f.plate_b == -1 {
            out.push(volcano(VolcanoKind::Hotspot));
        } else if f.plate_b == -2 {
            out.push(volcano(VolcanoKind::Flood));
        } else if f.volcanic == Some(true)
            && f.epochs_since_deposit < ARC_ACTIVE_EPOCHS
            && f.thickness.abs() > ARC_ACTIVE_THICKNESS
        {
            let key = (f.y / ARC_MARKER_CELL).floor() * 100000.0 + (f.x / ARC_MARKER_CELL).floor();
            // `+ 0`: a Map key, where −0 and +0 are one.
            let key = key + 0.0;
            match by_cell.get(&key.to_bits()) {
                Some(&slot) => {
                    let cur = cells[slot].1;
                    if f.thickness.abs() > features[cur].thickness.abs() {
                        cells[slot].1 = i;
                    }
                }
                None => {
                    by_cell.insert(key.to_bits(), cells.len());
                    cells.push((key, i));
                }
            }
        }
    }
    for (_, i) in cells {
        let f = &features[i];
        out.push(Volcano {
            x: f.x,
            y: f.y,
            thickness: f.thickness.abs(),
            kind: VolcanoKind::Arc,
        });
    }
    out
}

/// The volcanoes the ecology reads (DEC-0053, 2026-10-29): hotspots and
/// flood basalts as `collect_volcanoes` has them; EVERY active arc feature
/// above ARC_ACTIVE_THICKNESS, not the map's tallest per ARC_MARKER_CELL
/// (a display rule: it kept 108 of 163 active thick arcs on Morvane, 89 of
/// 188 on Thalassor, 126 of 209 on Zephyra); and the extinct arcs, of any
/// thickness, as `ExtinctArc` (949, 532 and 164 on these worlds: an arc's
/// porphyry copper stays where the arc was, its volcanoes do not). In the
/// features' order.
pub fn ecology_volcanoes(features: &[TerrainFeature]) -> Vec<Volcano> {
    ecology_features(features)
        .map(|(f, kind)| Volcano {
            x: f.x,
            y: f.y,
            thickness: f.thickness.abs(),
            kind,
        })
        .collect()
}

fn ecology_features(
    features: &[TerrainFeature],
) -> impl Iterator<Item = (&TerrainFeature, VolcanoKind)> {
    features.iter().filter_map(|f| {
        let kind = if f.plate_b == -1 {
            VolcanoKind::Hotspot
        } else if f.plate_b == -2 {
            VolcanoKind::Flood
        } else if f.volcanic != Some(true) {
            return None;
        } else if f.epochs_since_deposit >= ARC_ACTIVE_EPOCHS {
            VolcanoKind::ExtinctArc
        } else if f.thickness.abs() > ARC_ACTIVE_THICKNESS {
            VolcanoKind::Arc
        } else {
            return None;
        };
        Some((f, kind))
    })
}

/// What an eruption reads of a volcano (TEG-21): the crust it stands on
/// and whether it erupts now. Level 1 keeps it, for the incubator's
/// eruptions; the engine does not read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VolcanoSetting {
    /// On continental crust. An arc: a subduction arc under a continent's
    /// edge, not an island arc (the boundary's character: an island arc's
    /// feature subsides). A hotspot or a flood basalt: inside the rafts,
    /// the metaball field over 0.5 (as the flexure reads the crust).
    pub continental: bool,
    /// Fed now. An arc: fed within ARC_ACTIVE_EPOCHS (`Arc`, not
    /// `ExtinctArc`). A hotspot or a flood basalt: fed within the plume's
    /// interval (`hotspot_epoch_interval`), as the build reads a hotspot
    /// (volcanic_build.rs).
    pub active: bool,
}

/// The settings of `ecology_volcanoes(features)`, in its order.
pub fn ecology_volcano_settings(
    features: &[TerrainFeature],
    rafts: &[Raft],
    domain: &Domain,
) -> Vec<VolcanoSetting> {
    let interval = TECTONICS_TUNING.hotspot_epoch_interval;
    ecology_features(features)
        .map(|(f, kind)| match kind {
            VolcanoKind::Arc | VolcanoKind::ExtinctArc => VolcanoSetting {
                continental: !f.subsides,
                active: kind == VolcanoKind::Arc,
            },
            VolcanoKind::Hotspot | VolcanoKind::Flood => VolcanoSetting {
                continental: raft_field(f.x, f.y, rafts, domain) > 0.5,
                active: f.epochs_since_deposit < interval,
            },
        })
        .collect()
}
