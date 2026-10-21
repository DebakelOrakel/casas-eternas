//! `mesh/meshColumn.ts`: the sediment column per node (phase 5.2) — the
//! deposits as epoch-indexed layers over the bedrock, six extensive values
//! a layer, cut from the top. The TypeScript file explains the layout.

use crate::mesh::mesh_state::{FieldKind, MeshState};
use crate::mesh::periodic_delaunay::PeriodicTriangulation;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnTuning {
    /// Layers per node; when full the two oldest merge.
    pub layer_cap: usize,
    pub soft_min_m: f64,
    pub sediment_erodibility: f64,
}

pub const COLUMN_TUNING: ColumnTuning = ColumnTuning {
    layer_cap: 8,
    soft_min_m: 1.0,
    sediment_erodibility: 3.0,
};

pub const MESH_COLUMN: &str = "column";
pub const COLUMN_VALUES: usize = 6;
pub const COLUMN_DEPTH: usize = COLUMN_TUNING.layer_cap * COLUMN_VALUES;

const T_FINE: usize = 0;
const T_COARSE: usize = 1;
const P_CRATON: usize = 2;
const P_HARD: usize = 3;
const P_TEMP: usize = 4;
const P_PRECIP: usize = 5;

/// The column over a mesh: the stacked field (node-major, COLUMN_DEPTH per
/// slot) and the epoch of every layer in use, oldest first.
#[derive(Clone, Debug, PartialEq)]
pub struct SedimentColumn {
    pub data: Vec<f32>,
    pub epochs: Vec<f64>,
}

pub fn create_column(slots: usize) -> SedimentColumn {
    SedimentColumn {
        data: vec![0.0; slots * COLUMN_DEPTH],
        epochs: Vec::new(),
    }
}

/// The column's stacked field in a MeshState, for the remesh.
pub fn add_column_field(state: &mut MeshState) -> &mut Vec<f32> {
    state.add(MESH_COLUMN, FieldKind::Extensive, COLUMN_DEPTH)
}

/// The stacked field permuted to a canonical order.
pub fn permute_column(data: &[f32], order: &[i32]) -> Vec<f32> {
    let mut out = vec![0f32; order.len() * COLUMN_DEPTH];
    for (i, &o) in order.iter().enumerate() {
        let src = o as usize * COLUMN_DEPTH;
        out[i * COLUMN_DEPTH..(i + 1) * COLUMN_DEPTH]
            .copy_from_slice(&data[src..src + COLUMN_DEPTH]);
    }
    out
}

/// Opens the layer of a new epoch; at the cap the two oldest merge first.
pub fn open_layer(column: &mut SedimentColumn, epoch: f64, slots: usize) {
    let layers = column.epochs.len();
    let data = &mut column.data;
    if layers >= COLUMN_TUNING.layer_cap {
        for v in 0..slots {
            let base = v * COLUMN_DEPTH;
            for k in 0..COLUMN_VALUES {
                data[base + k] =
                    (data[base + k] as f64 + data[base + COLUMN_VALUES + k] as f64) as f32;
            }
            for layer in 1..layers - 1 {
                let to = base + layer * COLUMN_VALUES;
                let from = to + COLUMN_VALUES;
                for k in 0..COLUMN_VALUES {
                    data[to + k] = data[from + k];
                }
            }
            let top = base + (layers - 1) * COLUMN_VALUES;
            for k in 0..COLUMN_VALUES {
                data[top + k] = 0.0;
            }
        }
        column.epochs.remove(1);
    }
    column.epochs.push(epoch);
    let layer = column.epochs.len() - 1;
    for v in 0..slots {
        let top = v * COLUMN_DEPTH + layer * COLUMN_VALUES;
        for k in 0..COLUMN_VALUES {
            column.data[top + k] = 0.0;
        }
    }
}

/// The whole column's thickness at a node, metres.
pub fn column_thickness(data: &[f32], v: usize, layers: usize) -> f64 {
    let mut t = 0.0;
    let base = v * COLUMN_DEPTH;
    for layer in 0..layers {
        t += data[base + layer * COLUMN_VALUES + T_FINE] as f64
            + data[base + layer * COLUMN_VALUES + T_COARSE] as f64;
    }
    t
}

/// The erodibility the solver runs a node with: the sediment's under a fill
/// of at least soft_min_m, else the bedrock's.
pub fn erodibility_over(data: &[f32], v: usize, layers: usize, bedrock: f64) -> f64 {
    if column_thickness(data, v, layers) >= COLUMN_TUNING.soft_min_m {
        COLUMN_TUNING.sediment_erodibility
    } else {
        bedrock
    }
}

#[inline]
fn add_to(d: &mut [f32], i: usize, v: f64) {
    d[i] = (d[i] as f64 + v) as f32;
}

/// A deposit of `thickness_m` into the top layer, with its provenance.
#[allow(clippy::too_many_arguments)]
pub fn deposit(
    column: &mut SedimentColumn,
    v: usize,
    thickness_m: f64,
    craton: f64,
    hard: f64,
    temp_c: f64,
    precip: f64,
    coarse: bool,
) {
    // `!(thickness > 0)`: NaN too.
    if thickness_m.is_nan() || thickness_m <= 0.0 {
        return;
    }
    let top = v * COLUMN_DEPTH + (column.epochs.len() - 1) * COLUMN_VALUES;
    let d = &mut column.data;
    add_to(d, top + if coarse { T_COARSE } else { T_FINE }, thickness_m);
    add_to(d, top + P_CRATON, thickness_m * craton);
    add_to(d, top + P_HARD, thickness_m * hard);
    add_to(d, top + P_TEMP, thickness_m * temp_c);
    add_to(d, top + P_PRECIP, thickness_m * precip);
}

/// A cut of `thickness_m` from the top down; returns the part that came
/// out of sediment.
pub fn cut(column: &mut SedimentColumn, v: usize, thickness_m: f64) -> f64 {
    if thickness_m.is_nan() || thickness_m <= 0.0 {
        return 0.0;
    }
    let d = &mut column.data;
    let mut remaining = thickness_m;
    let mut taken = 0.0;
    let mut layer = column.epochs.len();
    while layer > 0 && remaining > 0.0 {
        layer -= 1;
        let base = v * COLUMN_DEPTH + layer * COLUMN_VALUES;
        let t = d[base + T_FINE] as f64 + d[base + T_COARSE] as f64;
        if t <= 0.0 {
            continue;
        }
        if t <= remaining {
            remaining -= t;
            taken += t;
            for k in 0..COLUMN_VALUES {
                d[base + k] = 0.0;
            }
        } else {
            let keep = (t - remaining) / t;
            for k in 0..COLUMN_VALUES {
                d[base + k] = (d[base + k] as f64 * keep) as f32;
            }
            taken += remaining;
            remaining = 0.0;
        }
    }
    taken
}

/// The column's volume over the mesh, m³.
pub fn column_volume_m3<T: Copy + Into<f64>>(
    column: &SedimentColumn,
    mesh: &PeriodicTriangulation,
    area_m2: &[T],
) -> f64 {
    let mut sum = 0.0;
    for v in 0..mesh.vertex_slots() {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        sum += column_thickness(&column.data, v, column.epochs.len()) * area_m2[v].into();
    }
    sum
}

/// The column's bytes for the save (`mesh/column.bin`).
pub fn encode_column(column: &SedimentColumn, count: usize) -> Vec<u8> {
    let layers = column.epochs.len();
    let values = layers * COLUMN_VALUES;
    let mut bytes = Vec::with_capacity(4 + 4 * layers + 4 * count * values);
    bytes.extend_from_slice(&(layers as u32).to_le_bytes());
    for &e in &column.epochs {
        bytes.extend_from_slice(&crate::core::js::to_int32(e).to_le_bytes());
    }
    for v in 0..count {
        let src = v * COLUMN_DEPTH;
        for k in 0..values {
            bytes.extend_from_slice(&column.data[src + k].to_le_bytes());
        }
    }
    bytes
}

/// The column from its bytes; a save of four values a layer restores with
/// the climate products at zero.
pub fn decode_column(bytes: &[u8], count: usize, slots: usize) -> Result<SedimentColumn, String> {
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let layers = u32_at(0) as usize;
    if layers > COLUMN_TUNING.layer_cap {
        return Err(format!("column: {layers} layers over the cap"));
    }
    let mut column = create_column(slots);
    for k in 0..layers {
        column.epochs.push(u32_at(4 + 4 * k) as i32 as f64);
    }
    if layers == 0 || count == 0 {
        return Ok(column);
    }
    let body = bytes.len() - 4 - 4 * layers;
    let per = 4 * count * layers;
    let per_layer = if body.is_multiple_of(per) {
        body / per
    } else {
        0
    };
    if per_layer != 4 && per_layer != COLUMN_VALUES {
        return Err("column: byte length does not match the node count".into());
    }
    let values = layers * per_layer;
    let at = 4 + 4 * layers;
    for v in 0..count {
        let dst = v * COLUMN_DEPTH;
        for layer in 0..layers {
            for k in 0..per_layer {
                let o = at + 4 * (v * values + layer * per_layer + k);
                column.data[dst + layer * COLUMN_VALUES + k] =
                    f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
            }
        }
    }
    Ok(column)
}
