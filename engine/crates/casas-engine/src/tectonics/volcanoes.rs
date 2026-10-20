//! `tectonics/volcanoes.ts`: the volcanoes a world shows, from its terrain
//! features.

use super::terrain_features::TerrainFeature;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VolcanoKind {
    Hotspot,
    Flood,
    Arc,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Volcano {
    pub x: f64,
    pub y: f64,
    pub thickness: f64,
    pub kind: VolcanoKind,
}

const ARC_MARKER_CELL: f64 = 60.0;

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
            && f.epochs_since_deposit < 8.0
            && f.thickness.abs() > 3.0
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
