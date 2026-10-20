//! `surface/erosionEngineState.ts`: the erosion engine's graph index and
//! its state. The TypeScript file explains the active set, the graph and
//! the two sections; here the sections are plain structs; the shared
//! buffers the worker pool needs for them have no counterpart.

use crate::core::domain::DomainGrid;
use crate::core::shared::SharedF32;

use super::flow_routing::{D8_OFFSETS, largest_water_component};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndexKind {
    Raster,
    Mesh,
}

/// The engine's substrate: a CSR neighbour table over the active nodes,
/// with a reach length, a facet factor and a reverse edge per directed
/// edge and an area per node (`EngineIndex` in TypeScript, which explains
/// each field).
#[derive(Clone, Debug)]
pub struct EngineIndex {
    pub kind: IndexKind,
    /// The raster's dimensions; 0 for a mesh.
    pub width: u32,
    pub height: u32,
    /// The cells or vertex slots the full arrays are laid out for.
    pub cell_count: u32,
    pub active_count: u32,
    pub active: Vec<i32>,
    pub active_of: Vec<i32>,
    pub frozen_count: u32,
    pub nbr_start: Vec<i32>,
    pub nbr: Vec<i32>,
    pub edge_count: u32,
    pub edge_rev: Vec<i32>,
    pub len_rel: Vec<f32>,
    pub diff_factor: Vec<f32>,
    pub mfd_factor: Vec<f32>,
    pub area_rel: Vec<f32>,
    /// The reference length in metres.
    pub ref_m: f64,
}

/// The raster's active set: everything that is not deep world ocean, with
/// `band_cells` D8 steps of world ocean kept around every other cell.
pub fn build_engine_index(
    z: &[f32],
    grid: &DomainGrid,
    band_cells: f64,
    cell_m: f64,
) -> EngineIndex {
    let width = grid.res_x;
    let height = grid.res_y;
    let n = width * height;
    let ocean = largest_water_component(z, grid, 0.0);
    let mut frozen = vec![0u8; n];
    let mut frozen_count = 0u32;
    if let Some(ocean) = &ocean {
        let mut depth = vec![-1i32; n];
        let mut queue = vec![0usize; n];
        let (mut head, mut tail) = (0usize, 0usize);
        for i in 0..n {
            if ocean[i] == 0 {
                depth[i] = 0;
                queue[tail] = i;
                tail += 1;
            }
        }
        let limit = band_cells.floor().max(1.0) as i32;
        while head < tail {
            let cell = queue[head];
            head += 1;
            let d = depth[cell];
            if d >= limit {
                continue;
            }
            let x = (cell % width) as i64;
            let y = (cell / width) as i64;
            for (dx, dy) in D8_OFFSETS {
                let nb = grid.neighbour(x, y, dx, dy);
                if depth[nb] == -1 {
                    depth[nb] = d + 1;
                    queue[tail] = nb;
                    tail += 1;
                }
            }
        }
        for i in 0..n {
            if ocean[i] != 0 && depth[i] == -1 {
                frozen[i] = 1;
                frozen_count += 1;
            }
        }
    }
    let active_count = n - frozen_count as usize;
    let mut active = vec![0i32; active_count];
    let mut active_of = vec![-1i32; n];
    let mut a = 0usize;
    for i in 0..n {
        if frozen[i] != 0 {
            continue;
        }
        active_of[i] = a as i32;
        active[a] = i as i32;
        a += 1;
    }
    let edge_count = 8 * active_count;
    let mut nbr_start = vec![0i32; active_count + 1];
    let mut nbr = vec![0i32; edge_count];
    let mut edge_rev = vec![0i32; edge_count];
    let mut len_rel = vec![0f32; edge_count];
    let mut diff_factor = vec![0f32; edge_count];
    let mut mfd_factor = vec![0f32; edge_count];
    for k in 0..active_count {
        nbr_start[k] = (k * 8) as i32;
        let cell = active[k] as usize;
        let x = (cell % width) as i64;
        let y = (cell / width) as i64;
        for (slot, &(dx, dy)) in D8_OFFSETS.iter().enumerate() {
            let e = k * 8 + slot;
            let j = active_of[grid.neighbour(x, y, dx, dy)];
            nbr[e] = j;
            // The opposite slot of the same pair sits in the neighbour's run.
            edge_rev[e] = if j >= 0 {
                j * 8 + ((slot + 4) % 8) as i32
            } else {
                -1
            };
            let diagonal = slot & 1 == 1;
            len_rel[e] = if diagonal {
                std::f64::consts::SQRT_2 as f32
            } else {
                1.0
            };
            diff_factor[e] = if diagonal { 0.0 } else { 1.0 };
            mfd_factor[e] = if diagonal {
                (1.0 / std::f64::consts::SQRT_2) as f32
            } else {
                1.0
            };
        }
    }
    nbr_start[active_count] = edge_count as i32;
    EngineIndex {
        kind: IndexKind::Raster,
        width: width as u32,
        height: height as u32,
        cell_count: n as u32,
        active_count: active_count as u32,
        active,
        active_of,
        frozen_count,
        nbr_start,
        nbr,
        edge_count: edge_count as u32,
        edge_rev,
        len_rel,
        diff_factor,
        mfd_factor,
        area_rel: vec![1.0; active_count],
        ref_m: cell_m,
    }
}

/// Active-space array → the caller's full layout; frozen entries from
/// `fill` (the first `cell_count` entries of it).
pub fn expand_active(index: &EngineIndex, src: &[f32], fill: &[f32]) -> Vec<f32> {
    let mut result = fill[..index.cell_count as usize].to_vec();
    for (a, &cell) in index.active.iter().enumerate() {
        result[cell as usize] = src[a];
    }
    result
}

/// Active-space array → the caller's full layout; frozen entries `fill`.
pub fn expand_active_with(index: &EngineIndex, src: &[f32], fill: f32) -> Vec<f32> {
    let mut result = vec![fill; index.cell_count as usize];
    for (a, &cell) in index.active.iter().enumerate() {
        result[cell as usize] = src[a];
    }
    result
}

/// The caller's full layout → active-space array.
pub fn gather_active<T: Copy>(index: &EngineIndex, src: &[T], out: &mut [T]) {
    for (a, &cell) in index.active.iter().enumerate() {
        out[a] = src[cell as usize];
    }
}

/// The terrain section, per active node unless named per edge
/// (`TerrainViews` in TypeScript, which explains each field). The graph
/// tables stay in the `EngineIndex`.
#[derive(Clone, Debug)]
pub struct Terrain {
    pub z: Vec<f32>,
    pub uplift: Vec<f32>,
    pub erodibility: Vec<f32>,
    pub coast_mask: Vec<u8>,
    pub status_mask: Vec<u8>,
    pub pinned_z: Vec<f32>,
    /// Per directed edge.
    pub edge_move: Vec<f32>,
    pub erosion_volume: Vec<f32>,
    pub accumulation_weights: Vec<f32>,
    pub flux: Vec<f32>,
    pub donor_min: Vec<f32>,
    /// Per segment.
    pub mouth_flux: Vec<f32>,
    pub mouth_z: Vec<f32>,
    pub cut_volume: Vec<f32>,
    pub deposit_volume: Vec<f32>,
    pub deposit_craton: Vec<f32>,
    pub deposit_hard: Vec<f32>,
    pub flux_craton: Vec<f32>,
    pub flux_hard: Vec<f32>,
    pub mouth_craton: Vec<f32>,
    pub mouth_hard: Vec<f32>,
    pub craton_age: Vec<f32>,
    pub rock_hard: Vec<f32>,
    pub erosion_coarse: Vec<f32>,
    pub flux_coarse: Vec<f32>,
    pub mouth_coarse: Vec<f32>,
    pub deposit_coarse: Vec<f32>,
    pub slope_scale: Vec<f32>,
    pub diff_scale: Vec<f32>,
    pub hill_net: Vec<f32>,
    pub uplift_net: Vec<f32>,
    pub flags: [i32; 16],
}

impl Terrain {
    pub fn new(index: &EngineIndex) -> Self {
        let a = index.active_count as usize;
        let e = index.edge_count as usize;
        let mut flags = [0; 16];
        flags[FLAG_GRID8] = i32::from(index.kind == IndexKind::Raster);
        Terrain {
            z: vec![0.0; a],
            uplift: vec![0.0; a],
            erodibility: vec![0.0; a],
            coast_mask: vec![0; a],
            status_mask: vec![0; a],
            pinned_z: vec![0.0; a],
            edge_move: vec![0.0; e],
            erosion_volume: vec![0.0; a],
            accumulation_weights: vec![0.0; a],
            flux: vec![0.0; a],
            donor_min: vec![0.0; a],
            mouth_flux: vec![0.0; a],
            mouth_z: vec![0.0; a],
            cut_volume: vec![0.0; a],
            deposit_volume: vec![0.0; a],
            deposit_craton: vec![0.0; a],
            deposit_hard: vec![0.0; a],
            flux_craton: vec![0.0; a],
            flux_hard: vec![0.0; a],
            mouth_craton: vec![0.0; a],
            mouth_hard: vec![0.0; a],
            craton_age: vec![0.0; a],
            rock_hard: vec![0.0; a],
            erosion_coarse: vec![0.0; a],
            flux_coarse: vec![0.0; a],
            mouth_coarse: vec![0.0; a],
            deposit_coarse: vec![0.0; a],
            slope_scale: vec![0.0; a],
            diff_scale: vec![0.0; a],
            hill_net: vec![0.0; a],
            uplift_net: vec![0.0; a],
            flags,
        }
    }
}

/// The terrain section as a stage's blocks see it: the arrays the physics
/// writes shared (core/shared.rs), the forcing read-only. Each kernel and
/// walk states which nodes a block writes.
pub struct TerrainView<'a> {
    pub z: SharedF32<'a>,
    pub uplift: &'a [f32],
    pub erodibility: &'a [f32],
    pub coast_mask: &'a [u8],
    pub status_mask: &'a [u8],
    pub pinned_z: &'a [f32],
    pub edge_move: SharedF32<'a>,
    pub erosion_volume: SharedF32<'a>,
    pub accumulation_weights: &'a [f32],
    pub flux: SharedF32<'a>,
    pub donor_min: SharedF32<'a>,
    pub mouth_flux: SharedF32<'a>,
    pub mouth_z: SharedF32<'a>,
    pub cut_volume: SharedF32<'a>,
    pub deposit_volume: SharedF32<'a>,
    pub deposit_craton: SharedF32<'a>,
    pub deposit_hard: SharedF32<'a>,
    pub flux_craton: SharedF32<'a>,
    pub flux_hard: SharedF32<'a>,
    pub mouth_craton: SharedF32<'a>,
    pub mouth_hard: SharedF32<'a>,
    pub craton_age: &'a [f32],
    pub rock_hard: &'a [f32],
    pub erosion_coarse: SharedF32<'a>,
    pub flux_coarse: SharedF32<'a>,
    pub mouth_coarse: SharedF32<'a>,
    pub deposit_coarse: SharedF32<'a>,
    pub slope_scale: &'a [f32],
    pub diff_scale: &'a [f32],
    pub hill_net: SharedF32<'a>,
    pub uplift_net: SharedF32<'a>,
    pub flags: [i32; 16],
}

impl Terrain {
    pub fn view(&mut self) -> TerrainView<'_> {
        TerrainView {
            z: SharedF32::new(&mut self.z),
            uplift: &self.uplift,
            erodibility: &self.erodibility,
            coast_mask: &self.coast_mask,
            status_mask: &self.status_mask,
            pinned_z: &self.pinned_z,
            edge_move: SharedF32::new(&mut self.edge_move),
            erosion_volume: SharedF32::new(&mut self.erosion_volume),
            accumulation_weights: &self.accumulation_weights,
            flux: SharedF32::new(&mut self.flux),
            donor_min: SharedF32::new(&mut self.donor_min),
            mouth_flux: SharedF32::new(&mut self.mouth_flux),
            mouth_z: SharedF32::new(&mut self.mouth_z),
            cut_volume: SharedF32::new(&mut self.cut_volume),
            deposit_volume: SharedF32::new(&mut self.deposit_volume),
            deposit_craton: SharedF32::new(&mut self.deposit_craton),
            deposit_hard: SharedF32::new(&mut self.deposit_hard),
            flux_craton: SharedF32::new(&mut self.flux_craton),
            flux_hard: SharedF32::new(&mut self.flux_hard),
            mouth_craton: SharedF32::new(&mut self.mouth_craton),
            mouth_hard: SharedF32::new(&mut self.mouth_hard),
            craton_age: &self.craton_age,
            rock_hard: &self.rock_hard,
            erosion_coarse: SharedF32::new(&mut self.erosion_coarse),
            flux_coarse: SharedF32::new(&mut self.flux_coarse),
            mouth_coarse: SharedF32::new(&mut self.mouth_coarse),
            deposit_coarse: SharedF32::new(&mut self.deposit_coarse),
            slope_scale: &self.slope_scale,
            diff_scale: &self.diff_scale,
            hill_net: SharedF32::new(&mut self.hill_net),
            uplift_net: SharedF32::new(&mut self.uplift_net),
            flags: self.flags,
        }
    }
}

/// The routing section (`RoutingViews` in TypeScript, which explains each
/// field).
#[derive(Clone, Debug)]
pub struct Routing {
    pub z_snapshot: Vec<f32>,
    pub filled: Vec<f32>,
    pub flow_target: Vec<i32>,
    pub flow_dir: Vec<u8>,
    pub accumulation: Vec<f32>,
    pub pop_order: Vec<i32>,
    pub ltd_facet: Vec<u8>,
    pub ltd_fallback: Vec<u8>,
    pub ltd_delta_c: Vec<f32>,
    pub ltd_delta_d: Vec<f32>,
    pub ltd_mode: Vec<u8>,
    pub mfd_degree: Vec<u8>,
    /// Per directed edge.
    pub mfd_direction: Vec<u8>,
    pub mfd_weight: Vec<f32>,
    pub seed_mask: Vec<u8>,
    pub segment: Vec<i32>,
    pub seg_order: Vec<i32>,
    pub seg_start: Vec<i32>,
    pub seg_leaf: Vec<u8>,
    pub stage: Vec<u8>,
    /// [0] the segment count, [1] the nodes in leaf segments.
    pub routing_meta: [i32; 2],
}

impl Routing {
    pub fn new(index: &EngineIndex) -> Self {
        let a = index.active_count as usize;
        let e = index.edge_count as usize;
        Routing {
            z_snapshot: vec![0.0; a],
            filled: vec![0.0; a],
            flow_target: vec![0; a],
            flow_dir: vec![0; a],
            accumulation: vec![0.0; a],
            pop_order: vec![0; a],
            ltd_facet: vec![0; a],
            ltd_fallback: vec![0; a],
            ltd_delta_c: vec![0.0; a],
            ltd_delta_d: vec![0.0; a],
            ltd_mode: vec![0; a],
            mfd_degree: vec![0; a],
            mfd_direction: vec![0; e],
            mfd_weight: vec![0.0; e],
            seed_mask: vec![0; a],
            segment: vec![0; a],
            seg_order: vec![0; a],
            seg_start: vec![0; a + 1],
            seg_leaf: vec![0; a],
            stage: vec![0; a],
            routing_meta: [0; 2],
        }
    }
}

/// Flag slots of `Terrain::flags`. FLAG_GRID8 marks the raster substrate:
/// eight neighbours per node in D8 slot order, which the LTD scan needs and
/// nothing else may assume.
pub const FLAG_HAS_COAST_MASK: usize = 0;
pub const FLAG_HAS_ACCUM_WEIGHTS: usize = 1;
pub const FLAG_HAS_STATUS_MASK: usize = 2;
pub const FLAG_GRID8: usize = 3;
pub const FLAG_HAS_PINNED: usize = 4;
