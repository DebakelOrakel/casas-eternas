//! `surface/erosionEngine.ts` and the drivers of `erosionEnginePool.ts`:
//! the erosion solver (in TypeScript still `ErosionEngine`, see DEC-0044's
//! vocabulary) — implicit stream power, ξ–q sediment routing with two
//! grain classes, Roering hillslope diffusion, marine diffusion and uplift,
//! on the solver's graph (erosion_engine_state.rs). The TypeScript port
//! (`client/src/generator/surface/erosionEngine.ts` and
//! `erosionEnginePool.ts` beside it, git history) explains the physics, the
//! walks and the schemes; this port keeps their arithmetic, step for step.
//!
//! Every value the TypeScript engine holds in a Float32Array is f32 here,
//! and every expression over them is taken in f64 and stored back as f32,
//! as JavaScript does.
//!
//! The drivers: `ErosionSolver` is the single solver (a routing every
//! `routing_every` iterations, from the live z); `PipelinedErosionSolver`
//! is the pool's pipelined scheme (two routings, the swap on a fixed
//! cadence, the routing a cadence stale), with its synchronous variant.
//! The per-node kernels run in blocks of nodes, the walks' leaf stage in
//! blocks of leaf segments, in parallel with the `parallel` feature: each
//! block writes only its own nodes (see each kernel), so the bits do not
//! depend on the blocks or the threads. The run's two tallies (eroded and
//! exported m³) are summed afterwards over the TypeScript pool's worker
//! ranges, `leaf_workers` of them: its sums are grouped that way.

use crate::core::det_math::{det_atan2, det_exp, det_hypot, det_pow, det_sin};
use crate::core::domain::{Domain, DomainGrid};
use crate::core::js;
use crate::core::min_heap::MinHeap;
use crate::core::shared::{SharedF32, SharedF64, SharedU8, block_ranges, for_ranges};
use crate::elevation::elevation_scale::ELEVATION_METERS;
use serde::Serialize;

use super::erosion_engine_state::{
    EngineIndex, FLAG_GRID8, FLAG_HAS_ACCUM_WEIGHTS, FLAG_HAS_COAST_MASK, FLAG_HAS_PINNED,
    FLAG_HAS_STATUS_MASK, Routing, Terrain, TerrainView, build_engine_index, expand_active,
    gather_active,
};
use super::hydrology::FLOOD_EPS;
use std::ops::Range;

/// One iteration in years (the TypeScript constant explains the anchor).
pub const ITERATION_YEARS: f64 = 20_000.0;

/// The solver's parameters (`ErosionEngineParams` in TypeScript, which
/// explains each).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErosionSolverParams {
    pub m: f64,
    pub kappa_dt: f64,
    pub base_area_rel: f64,
    pub channel_head_km2: f64,
    pub uplift_dt: f64,
    pub settle_xi_km: f64,
    pub settle_floor_km: f64,
    pub settle_marine_km: f64,
    pub settle_width_ref_km: f64,
    pub settle_coarse_km: f64,
    pub coarse_slope: f64,
    pub abrasion_km: f64,
    pub marine_freeboard_m: f64,
    pub deposit_cap_land_m: f64,
    pub deposit_cap_marine_m: f64,
    pub hill_diff_km2: f64,
    pub hill_ref_km2: f64,
    pub hill_scale_exponent: f64,
    pub critical_slope: f64,
    pub marine_diff_dt: f64,
    pub shelf_band_km: f64,
    pub eps_m: f64,
}

pub const DEFAULT_SOLVER_PARAMS: ErosionSolverParams = ErosionSolverParams {
    m: 0.5,
    kappa_dt: 0.009,
    base_area_rel: 3.94,
    channel_head_km2: 5.0,
    uplift_dt: 2.2e-3,
    settle_xi_km: 1.0,
    settle_floor_km: 20.0,
    settle_marine_km: 8.0,
    settle_coarse_km: 8.0,
    settle_width_ref_km: 11.25,
    coarse_slope: 0.05,
    abrasion_km: 200.0,
    marine_freeboard_m: 2.0,
    deposit_cap_land_m: 10.0,
    deposit_cap_marine_m: 30.0,
    hill_diff_km2: 0.5,
    hill_ref_km2: 127.0,
    hill_scale_exponent: 0.5,
    critical_slope: 0.65,
    marine_diff_dt: 0.025,
    shelf_band_km: 40.0,
    eps_m: 0.35,
};

/// The forcing, every array on the caller's full layout (`ErosionForcing`
/// in TypeScript, which explains each).
#[derive(Clone, Copy, Debug, Default)]
pub struct ErosionForcing<'a> {
    pub uplift: &'a [f32],
    pub erodibility: &'a [f32],
    pub coast_mask: Option<&'a [u8]>,
    pub accumulation_weights: Option<&'a [f32]>,
    pub status_mask: Option<&'a [u8]>,
    pub pinned_z: Option<&'a [f32]>,
    pub craton_age: Option<&'a [f32]>,
    pub rock_hard: Option<&'a [f32]>,
    pub slope_scale: Option<&'a [f32]>,
    pub diff_scale: Option<&'a [f32]>,
}

pub const EPSILON_FLOOD_STEP: f64 = 1e-7;
const SQRT2: f64 = std::f64::consts::SQRT_2;
const QUARTER_TURN: f64 = std::f64::consts::PI / 4.0;
const NO_SLOT: u8 = 255;
/// The per-pair stability cap of the diffusive stencils.
pub const DIFFUSION_PAIR_CAP: f64 = 0.2;
/// D8-LTD facets as [cardinal slot, diagonal slot, orientation].
const LTD_FACETS: [(usize, usize, f64); 8] = [
    (0, 1, 1.0),
    (2, 1, -1.0),
    (2, 3, 1.0),
    (4, 3, -1.0),
    (4, 5, 1.0),
    (6, 5, -1.0),
    (6, 7, 1.0),
    (0, 7, -1.0),
];

/// The nodes of a block of the per-node kernels, and the leaf nodes of a
/// block of the walks' leaf stage: the units of the parallel stages, the
/// same for any number of threads (core/shared.rs).
const ENGINE_BLOCK: usize = 4096;
const LEAF_BLOCK: i32 = 8192;

/// Where a status-clamped cell lands, in metres off sea level.
pub const STATUS_CLAMP_M: f64 = 0.5;

/// The subset of params the per-node kernels need; `cell_m` is the index's
/// reference length.
#[derive(Clone, Copy, Debug)]
pub struct KernelParams {
    pub uplift_dt: f64,
    pub hill_diff_km2: f64,
    pub hill_ref_km2: f64,
    pub hill_scale_exponent: f64,
    pub critical_slope: f64,
    pub marine_diff_dt: f64,
    pub cell_m: f64,
}

pub fn kernel_params_for(ref_m: f64, params: &ErosionSolverParams) -> KernelParams {
    KernelParams {
        uplift_dt: params.uplift_dt,
        hill_diff_km2: params.hill_diff_km2,
        hill_ref_km2: params.hill_ref_km2,
        hill_scale_exponent: params.hill_scale_exponent,
        critical_slope: params.critical_slope,
        marine_diff_dt: params.marine_diff_dt,
        cell_m: ref_m,
    }
}

/// A raster grid's cell size in metres.
pub fn raster_cell_m(domain: &Domain, width: usize) -> f64 {
    domain.metres_around / width as f64
}

/// The shelf band in cells for a grid.
pub fn shelf_band_cells(domain: &Domain, width: usize, params: &ErosionSolverParams) -> f64 {
    ((params.shelf_band_km * 1000.0) / (domain.metres_around / width as f64))
        .ceil()
        .max(1.0)
}

#[inline]
fn edge_range(g: &EngineIndex, cell: usize) -> std::ops::Range<usize> {
    g.nbr_start[cell] as usize..g.nbr_start[cell + 1] as usize
}

// ------------------------------------------------------------------- scans

/// What the receiver scan writes per node.
pub struct LtdOut<'a> {
    pub facet: SharedU8<'a>,
    pub fallback: SharedU8<'a>,
    pub delta_c: SharedF32<'a>,
    pub delta_d: SharedF32<'a>,
    pub mode: SharedU8<'a>,
}

/// What the MFD scan writes: per node the degree, per edge of its run the
/// target slots and weights.
pub struct MfdOut<'a> {
    pub degree: SharedU8<'a>,
    pub direction: SharedU8<'a>,
    pub weight: SharedF32<'a>,
}

/// Per-node receiver scan over the active indices `cells`: D8-LTD's facets
/// on the raster, the steepest descent per reach length on a mesh. A block
/// writes its own nodes.
pub fn kernel_ltd_scan(
    g: &EngineIndex,
    grid8: bool,
    filled: &[f32],
    out: &LtdOut,
    cells: Range<usize>,
) {
    if !grid8 {
        for cell in cells {
            let own = filled[cell] as f64;
            let start = g.nbr_start[cell] as usize;
            let mut best_gradient = 0.0;
            let mut fallback = NO_SLOT;
            for e in edge_range(g, cell) {
                let nb = g.nbr[e];
                if nb < 0 {
                    continue;
                }
                let gr = (own - filled[nb as usize] as f64) / g.len_rel[e] as f64;
                if gr > best_gradient {
                    best_gradient = gr;
                    fallback = (e - start) as u8;
                }
            }
            out.fallback.set(cell, fallback);
            out.facet.set(cell, NO_SLOT);
            out.mode.set(cell, 0);
        }
        return;
    }
    for cell in cells {
        let base = g.nbr_start[cell] as usize;
        let own = filled[cell] as f64;
        let mut best_slope = 0.0;
        let mut best_facet: i32 = -1;
        let (mut best_s1, mut best_s2) = (0.0, 0.0);
        let mut best_gradient = 0.0;
        let mut fallback = NO_SLOT;
        let (mut best_nc, mut best_nd) = (0usize, 0usize);
        for (f, &(cs, ds, _)) in LTD_FACETS.iter().enumerate() {
            let nc = g.nbr[base + cs];
            let nd = g.nbr[base + ds];
            if nc >= 0 {
                let g1 = own - filled[nc as usize] as f64;
                if g1 > best_gradient {
                    best_gradient = g1;
                    fallback = cs as u8;
                }
            }
            if f % 2 == 0 && nd >= 0 {
                let g2 = (own - filled[nd as usize] as f64) / SQRT2;
                if g2 > best_gradient {
                    best_gradient = g2;
                    fallback = ds as u8;
                }
            }
            if nc < 0 || nd < 0 {
                continue;
            }
            let fc = filled[nc as usize] as f64;
            let fd = filled[nd as usize] as f64;
            let s1 = own - fc;
            let s2 = fc - fd;
            let slope = if s2 <= 0.0 {
                s1
            } else if s2 >= s1 {
                (own - fd) / SQRT2
            } else {
                det_hypot(s1, s2)
            };
            if slope > best_slope {
                best_slope = slope;
                best_facet = f as i32;
                best_s1 = s1;
                best_s2 = s2;
                best_nc = nc as usize;
                best_nd = nd as usize;
            }
        }
        out.fallback.set(cell, fallback);
        if best_facet >= 0 {
            let orient = LTD_FACETS[best_facet as usize].2;
            let alpha = if best_s2 <= 0.0 {
                0.0
            } else if best_s2 >= best_s1 {
                QUARTER_TURN
            } else {
                det_atan2(best_s2, best_s1)
            };
            out.facet.set(cell, best_facet as u8);
            out.delta_c.set(cell, (-orient * det_sin(alpha)) as f32);
            out.delta_d.set(
                cell,
                (orient * SQRT2 * det_sin(QUARTER_TURN - alpha)) as f32,
            );
            out.mode.set(
                cell,
                4 | u8::from((filled[best_nc] as f64) < own)
                    | (u8::from((filled[best_nd] as f64) < own) << 1),
            );
        } else {
            out.facet.set(cell, NO_SLOT);
            out.mode.set(cell, 0);
        }
    }
}

/// MFD edges over the node's run, over the active indices `cells`. A block
/// writes its own nodes and their runs.
pub fn kernel_mfd(g: &EngineIndex, filled: &[f32], out: &MfdOut, cells: Range<usize>) {
    for cell in cells {
        let base = g.nbr_start[cell] as usize;
        let own = filled[cell] as f64;
        let mut count = 0usize;
        let mut weight_sum = 0.0;
        for e in edge_range(g, cell) {
            let neighbor = g.nbr[e];
            if neighbor < 0 {
                continue;
            }
            let drop = own - filled[neighbor as usize] as f64;
            if drop <= 0.0 {
                continue;
            }
            let weight = drop * g.mfd_factor[e] as f64;
            if weight <= 0.0 {
                continue;
            }
            out.direction.set(base + count, (e - base) as u8);
            out.weight.set(base + count, weight as f32);
            weight_sum += weight;
            count += 1;
        }
        for i in 0..count {
            out.weight.set(
                base + i,
                (out.weight.get(base + i) as f64 / weight_sum) as f32,
            );
        }
        out.degree.set(cell, count as u8);
    }
}

/// The two scans over every active node, in blocks.
fn run_scans(g: &EngineIndex, grid8: bool, r: &mut Routing) {
    let blocks = block_ranges(g.active_count as usize, ENGINE_BLOCK);
    let filled = &r.filled;
    let ltd = LtdOut {
        facet: SharedU8::new(&mut r.ltd_facet),
        fallback: SharedU8::new(&mut r.ltd_fallback),
        delta_c: SharedF32::new(&mut r.ltd_delta_c),
        delta_d: SharedF32::new(&mut r.ltd_delta_d),
        mode: SharedU8::new(&mut r.ltd_mode),
    };
    for_ranges(&blocks, |cells| {
        kernel_ltd_scan(g, grid8, filled, &ltd, cells)
    });
    let mfd = MfdOut {
        degree: SharedU8::new(&mut r.mfd_degree),
        direction: SharedU8::new(&mut r.mfd_direction),
        weight: SharedF32::new(&mut r.mfd_weight),
    };
    for_ranges(&blocks, |cells| kernel_mfd(g, filled, &mfd, cells));
}

// ----------------------------------------------------------------- physics

/// Uplift over `cells`, pinned to the coast mask when its flag is set; the
/// volume goes into the uplift ledger. A block writes its own nodes.
pub fn kernel_uplift(g: &EngineIndex, t: &TerrainView, cells: Range<usize>, kp: &KernelParams) {
    let has_mask = t.flags[FLAG_HAS_COAST_MASK] != 0;
    let ref_m2 = kp.cell_m * kp.cell_m;
    for i in cells {
        let z = t.z.get(i);
        if z > 0.0 && (!has_mask || t.coast_mask[i] != 0) {
            let dz = kp.uplift_dt * t.uplift[i] as f64;
            t.z.set(i, (z as f64 + dz) as f32);
            t.uplift_net.set(
                i,
                (t.uplift_net.get(i) as f64 + dz * g.area_rel[i] as f64 * ref_m2 * ELEVATION_METERS)
                    as f32,
            );
        }
    }
}

/// Roering hillslope diffusion, pass 1: the volume moved along every edge
/// whose lower-indexed endpoint lies in `cells`. A block writes its nodes'
/// runs and reads z, which no block writes in this pass.
pub fn kernel_hill_moves(g: &EngineIndex, t: &TerrainView, cells: Range<usize>, kp: &KernelParams) {
    let grid8 = t.flags[FLAG_GRID8] != 0;
    let ref_m2 = kp.cell_m * kp.cell_m;
    let diff_m2 = kp.hill_diff_km2 * 1e6;
    for cell in cells {
        let own = t.z.get(cell) as f64;
        let own_area = g.area_rel[cell] as f64 * ref_m2;
        for e in edge_range(g, cell) {
            let nb = g.nbr[e];
            if nb < cell as i32 {
                t.edge_move.set(e, 0.0);
                continue;
            }
            let nb = nb as usize;
            let geom = g.diff_factor[e] as f64;
            let other = t.z.get(nb) as f64;
            if geom == 0.0
                || (if grid8 {
                    own <= 0.0
                } else {
                    own <= 0.0 && other <= 0.0
                })
            {
                t.edge_move.set(e, 0.0);
                continue;
            }
            let dz = own - other;
            if dz == 0.0 {
                t.edge_move.set(e, 0.0);
                continue;
            }
            let slope = (dz.abs() * ELEVATION_METERS) / (kp.cell_m * g.len_rel[e] as f64);
            let ratio = js::min(
                0.95,
                slope / (kp.critical_slope * t.slope_scale[cell] as f64),
            );
            let boost = 1.0 / (1.0 - ratio * ratio);
            let size_scale = det_pow(
                (0.5 * (g.area_rel[cell] as f64 + g.area_rel[nb] as f64) * ref_m2)
                    / 1e6
                    / kp.hill_ref_km2,
                kp.hill_scale_exponent,
            );
            let coefficient = js::min(
                diff_m2 * size_scale * t.diff_scale[cell] as f64 * geom * js::min(boost, 12.0),
                DIFFUSION_PAIR_CAP * js::min(own_area, g.area_rel[nb] as f64 * ref_m2),
            );
            t.edge_move.set(e, (coefficient * dz) as f32);
        }
    }
}

/// The volume a node handed out and received along its edges.
#[inline]
fn edge_volume(g: &EngineIndex, t: &TerrainView, cell: usize) -> f64 {
    let mut volume = 0.0;
    for e in edge_range(g, cell) {
        let nb = g.nbr[e];
        if nb < 0 {
            continue;
        }
        volume += if nb > cell as i32 {
            -(t.edge_move.get(e) as f64)
        } else {
            t.edge_move.get(g.edge_rev[e] as usize) as f64
        };
    }
    volume
}

/// Hillslope pass 2 over `cells`; returns their residual. A block writes
/// its own nodes and reads the moves, which no block writes in this pass.
pub fn kernel_hill_apply(
    g: &EngineIndex,
    t: &TerrainView,
    cells: Range<usize>,
    kp: &KernelParams,
) -> f64 {
    let ref_m2 = kp.cell_m * kp.cell_m;
    let mut max_step = 0.0;
    for cell in cells {
        let volume = edge_volume(g, t, cell);
        if volume != 0.0 {
            let delta = volume / (g.area_rel[cell] as f64 * ref_m2);
            let z = (t.z.get(cell) as f64 + delta) as f32;
            t.z.set(cell, z);
            t.hill_net.set(
                cell,
                (t.hill_net.get(cell) as f64 + volume * ELEVATION_METERS) as f32,
            );
            let step = delta.abs();
            if z > 0.0 && step > max_step {
                max_step = step;
            }
        }
    }
    max_step
}

/// Marine diffusion, pass 1: water-to-water moves along every edge whose
/// lower-indexed endpoint lies in `cells` (the blocks as in the hillslope's).
pub fn kernel_marine_moves(
    g: &EngineIndex,
    t: &TerrainView,
    cells: Range<usize>,
    kp: &KernelParams,
) {
    let ref_m2 = kp.cell_m * kp.cell_m;
    for cell in cells {
        let own = t.z.get(cell) as f64;
        let own_area = g.area_rel[cell] as f64 * ref_m2;
        for e in edge_range(g, cell) {
            let nb = g.nbr[e];
            if nb < cell as i32 {
                t.edge_move.set(e, 0.0);
                continue;
            }
            let nb = nb as usize;
            let geom = g.diff_factor[e] as f64;
            let other = t.z.get(nb) as f64;
            if geom == 0.0 || own > 0.0 || other > 0.0 {
                t.edge_move.set(e, 0.0);
                continue;
            }
            let coefficient = js::min(
                kp.marine_diff_dt * geom * ref_m2,
                DIFFUSION_PAIR_CAP * js::min(own_area, g.area_rel[nb] as f64 * ref_m2),
            );
            t.edge_move.set(e, (coefficient * (own - other)) as f32);
        }
    }
}

/// Marine pass 2 over `cells`.
pub fn kernel_marine_apply(
    g: &EngineIndex,
    t: &TerrainView,
    cells: Range<usize>,
    kp: &KernelParams,
) {
    let ref_m2 = kp.cell_m * kp.cell_m;
    for cell in cells {
        let volume = edge_volume(g, t, cell);
        if volume != 0.0 {
            t.z.set(
                cell,
                (t.z.get(cell) as f64 + volume / (g.area_rel[cell] as f64 * ref_m2)) as f32,
            );
        }
    }
}

/// The land/sea status rule over `cells`, then the pinned heights.
pub fn kernel_status_clamp(t: &TerrainView, cells: Range<usize>) {
    if t.flags[FLAG_HAS_STATUS_MASK] == 0 {
        return;
    }
    let clamp = (STATUS_CLAMP_M / ELEVATION_METERS) as f32;
    for i in cells.clone() {
        let z = t.z.get(i);
        match t.status_mask[i] {
            1 if z <= 0.0 => t.z.set(i, clamp),
            2 if z > 0.0 => t.z.set(i, -clamp),
            _ => {}
        }
    }
    if t.flags[FLAG_HAS_PINNED] == 0 {
        return;
    }
    for i in cells {
        if !t.pinned_z[i].is_nan() {
            t.z.set(i, t.pinned_z[i]);
        }
    }
}

// ------------------------------------------------- serial (coordinator) parts

/// The routing refresh's scratch (`CoordinatorScratch` in TypeScript, less
/// its two tallies, which `Tallies` holds: the pipelined scheme's refresh
/// has a scratch of its own and no tallies).
pub struct RoutingScratch {
    component_label: Vec<i32>,
    component_stack: Vec<i32>,
    visited: Vec<u8>,
    flood_heap: MinHeap,
    lambda: Vec<f32>,
    contrib: Vec<u32>,
    best_inflow: Vec<u32>,
    seg_cursor: Vec<i32>,
}

impl RoutingScratch {
    pub fn new(active_count: usize) -> Self {
        RoutingScratch {
            component_label: vec![0; active_count],
            component_stack: vec![0; active_count],
            visited: vec![0; active_count],
            flood_heap: MinHeap::new(active_count),
            lambda: vec![0.0; active_count],
            contrib: vec![0; active_count],
            best_inflow: vec![0; active_count],
            seg_cursor: vec![0; active_count],
        }
    }
}

/// The run-long tallies, m³: what the fluvial walk cut loose, and what was
/// exported past the shelf band's rim.
#[derive(Clone, Copy, Debug, Default)]
pub struct Tallies {
    pub eroded: f64,
    pub exported: f64,
}

/// The flood's seeds: the world ocean's active part, and the pinned nodes.
/// Returns whether there is any seed.
pub fn compute_ocean_seed(
    g: &EngineIndex,
    z: &[f32],
    t: &Terrain,
    r: &mut Routing,
    s: &mut RoutingScratch,
) -> bool {
    let active_count = g.active_count as usize;
    let pinned = t.flags[FLAG_HAS_PINNED] != 0;
    let label = &mut s.component_label;
    let stack = &mut s.component_stack;
    label.fill(-1);
    r.seed_mask.fill(0);
    let mut sizes: Vec<u32> = Vec::new();
    let mut touches_frozen: Vec<bool> = Vec::new();
    let mut sp = 0usize;
    for start in 0..active_count {
        if z[start] > 0.0 || label[start] != -1 {
            continue;
        }
        let id = sizes.len() as i32;
        let mut size = 0u32;
        let mut touches = false;
        stack[sp] = start as i32;
        sp += 1;
        label[start] = id;
        while sp > 0 {
            sp -= 1;
            let i = stack[sp] as usize;
            size += 1;
            for e in edge_range(g, i) {
                let nb = g.nbr[e];
                if nb < 0 {
                    touches = true;
                    continue;
                }
                if g.diff_factor[e] == 0.0 {
                    continue;
                }
                let nb = nb as usize;
                if z[nb] <= 0.0 && label[nb] == -1 {
                    label[nb] = id;
                    stack[sp] = nb as i32;
                    sp += 1;
                }
            }
        }
        sizes.push(size);
        touches_frozen.push(touches);
    }
    let mut any_pinned = false;
    if pinned {
        for i in 0..active_count {
            if t.pinned_z[i].is_nan() {
                continue;
            }
            r.seed_mask[i] = 1;
            any_pinned = true;
        }
    }
    if sizes.is_empty() {
        return any_pinned;
    }
    let any = any_pinned || touches_frozen.iter().any(|&b| b);
    if !any {
        let mut best = 0;
        for i in 1..sizes.len() {
            if sizes[i] > sizes[best] {
                best = i;
            }
        }
        touches_frozen[best] = true;
    }
    for i in 0..active_count {
        if label[i] >= 0 && touches_frozen[label[i] as usize] {
            r.seed_mask[i] = 1;
        }
    }
    true
}

/// Priority flood over the active set from the seeds: writes `filled` and
/// the pop order; returns the popped count.
pub fn flood_active(g: &EngineIndex, z: &[f32], r: &mut Routing, s: &mut RoutingScratch) -> usize {
    let active_count = g.active_count as usize;
    let visited = &mut s.visited;
    let heap = &mut s.flood_heap;
    visited.fill(0);
    while !heap.is_empty() {
        heap.pop();
    }
    for a in 0..active_count {
        if r.seed_mask[a] == 0 {
            continue;
        }
        r.filled[a] = z[a];
        visited[a] = 1;
        heap.push(r.filled[a] as f64, a as i32);
    }
    let mut popped = 0usize;
    while !heap.is_empty() {
        heap.pop();
        let current = heap.popped_index as usize;
        r.pop_order[popped] = current as i32;
        popped += 1;
        for e in edge_range(g, current) {
            let nb = g.nbr[e];
            if nb < 0 || visited[nb as usize] != 0 {
                continue;
            }
            let nb = nb as usize;
            visited[nb] = 1;
            r.filled[nb] = flood_step(
                z[nb],
                r.filled[current],
                EPSILON_FLOOD_STEP * g.len_rel[e] as f64,
            );
            heap.push(r.filled[nb] as f64, nb as i32);
        }
    }
    for a in 0..active_count {
        if visited[a] == 0 {
            r.filled[a] = f32::INFINITY;
        }
    }
    popped
}

/// A flooded node's level: its own height or the level it was reached from
/// plus the step, and strictly above that level in f32.
fn flood_step(own: f32, from: f32, step: f64) -> f32 {
    let level = js::max(own as f64, from as f64) + step;
    if js::fround(level) > from as f64 {
        return level as f32;
    }
    if from == 0.0 {
        return f32::from_bits(1);
    }
    let bits = from.to_bits() as i32;
    f32::from_bits(if from >= 0.0 { bits + 1 } else { bits - 1 } as u32)
}

/// The λ-walk: each node's receiver, popOrder backward.
pub fn lambda_walk(g: &EngineIndex, r: &mut Routing, popped: usize, s: &mut RoutingScratch) {
    r.flow_target.fill(-1);
    r.flow_dir.fill(NO_SLOT);
    s.lambda.fill(0.0);
    s.contrib.fill(0);
    s.best_inflow.fill(0);
    for i in (0..popped).rev() {
        let cell = r.pop_order[i] as usize;
        let mut slot = r.ltd_fallback[cell];
        let mut delta = 0.0f32;
        let mode = r.ltd_mode[cell];
        if mode & 4 != 0 {
            let facet = LTD_FACETS[r.ltd_facet[cell] as usize];
            let cardinal_down = mode & 1 != 0;
            let diagonal_down = mode & 2 != 0;
            if cardinal_down && diagonal_down {
                let lam = s.lambda[cell] as f64;
                if (lam + r.ltd_delta_c[cell] as f64).abs()
                    <= (lam + r.ltd_delta_d[cell] as f64).abs()
                {
                    slot = facet.0 as u8;
                    delta = r.ltd_delta_c[cell];
                } else {
                    slot = facet.1 as u8;
                    delta = r.ltd_delta_d[cell];
                }
            } else if cardinal_down {
                slot = facet.0 as u8;
                delta = r.ltd_delta_c[cell];
            } else if diagonal_down {
                slot = facet.1 as u8;
                delta = r.ltd_delta_d[cell];
            }
        }
        if slot == NO_SLOT {
            continue;
        }
        let target = g.nbr[g.nbr_start[cell] as usize + slot as usize];
        r.flow_target[cell] = target;
        r.flow_dir[cell] = slot;
        let target = target as usize;
        let area = s.contrib[cell] as u64 + 1;
        s.contrib[target] = (s.contrib[target] as u64 + area) as u32;
        if area > s.best_inflow[target] as u64 {
            s.best_inflow[target] = area as u32;
            s.lambda[target] = (s.lambda[cell] as f64 + delta as f64) as f32;
        }
    }
}

/// Drainage-area accumulation over the MFD edges, popOrder backward.
pub fn accumulate_flow_v2(g: &EngineIndex, t: &Terrain, r: &mut Routing, popped: usize) {
    if t.flags[FLAG_HAS_ACCUM_WEIGHTS] != 0 {
        for i in 0..g.active_count as usize {
            r.accumulation[i] = (t.accumulation_weights[i] as f64 * g.area_rel[i] as f64) as f32;
        }
    } else {
        r.accumulation.copy_from_slice(&g.area_rel);
    }
    for i in (0..popped).rev() {
        let cell = r.pop_order[i] as usize;
        let amount = r.accumulation[cell] as f64;
        let base = g.nbr_start[cell] as usize;
        for e in 0..r.mfd_degree[cell] as usize {
            let target = g.nbr[base + r.mfd_direction[base + e] as usize] as usize;
            r.accumulation[target] =
                (r.accumulation[target] as f64 + amount * r.mfd_weight[base + e] as f64) as f32;
        }
    }
}

/// Cut the receiver forest into segments at every land→sea edge of `z` and
/// at every terminal node.
pub fn build_segments(z: &[f32], r: &mut Routing, popped: usize, s: &mut RoutingScratch) {
    let mut count = 0usize;
    for i in 0..popped {
        let cell = r.pop_order[i] as usize;
        let t = r.flow_target[cell];
        if t < 0 || (z[cell] > 0.0 && z[t as usize] <= 0.0) {
            r.segment[cell] = count as i32;
            count += 1;
        } else {
            r.segment[cell] = r.segment[t as usize];
        }
    }
    r.seg_start[..count + 1].fill(0);
    for i in 0..popped {
        r.seg_start[r.segment[r.pop_order[i] as usize] as usize + 1] += 1;
    }
    for seg in 0..count {
        r.seg_start[seg + 1] += r.seg_start[seg];
    }
    s.seg_cursor[..count].copy_from_slice(&r.seg_start[..count]);
    for i in 0..popped {
        let cell = r.pop_order[i];
        let seg = r.segment[cell as usize] as usize;
        r.seg_order[s.seg_cursor[seg] as usize] = cell;
        s.seg_cursor[seg] += 1;
    }
    r.seg_leaf[..count].fill(1);
    for i in 0..popped {
        let cell = r.pop_order[i] as usize;
        let t = r.flow_target[cell];
        if t >= 0 && r.segment[t as usize] != r.segment[cell] {
            r.seg_leaf[r.segment[t as usize] as usize] = 0;
        }
    }
    let mut leaf_cells = 0;
    for seg in 0..count {
        if r.seg_leaf[seg] != 0 {
            leaf_cells += r.seg_start[seg + 1] - r.seg_start[seg];
        }
    }
    for i in 0..popped {
        let cell = r.pop_order[i] as usize;
        r.stage[cell] = if r.seg_leaf[r.segment[cell] as usize] != 0 {
            0
        } else {
            1
        };
    }
    r.routing_meta[0] = count as i32;
    r.routing_meta[1] = leaf_cells;
}

/// Which leaf segments worker `worker_id` of `worker_count` walks in the
/// TypeScript pool: here only what the tallies are summed over.
fn leaf_range(r: &Routing, worker_id: usize, worker_count: usize) -> (usize, usize) {
    let count = r.routing_meta[0] as usize;
    let total = r.routing_meta[1] as f64;
    let lo = ((worker_id as f64 * total) / worker_count as f64).floor();
    let hi = (((worker_id + 1) as f64 * total) / worker_count as f64).floor();
    let (mut from, mut to) = (count, count);
    let mut cum = 0.0;
    for seg in 0..count {
        if r.seg_leaf[seg] == 0 {
            continue;
        }
        if cum >= lo && from == count {
            from = seg;
        }
        if cum >= hi {
            to = seg;
            break;
        }
        cum += (r.seg_start[seg + 1] - r.seg_start[seg]) as f64;
    }
    (from, to)
}

/// The leaf stage's blocks: runs of segment ids holding about LEAF_BLOCK
/// leaf nodes each, a function of the routing alone. A leaf segment's
/// walks write only its own nodes (every donor of a leaf node is in the
/// node's segment, or the segment would not be a leaf) and its mailbox,
/// and read z only there and at the root's receiver, which is a
/// serial-stage node no block writes.
pub fn leaf_blocks(r: &Routing) -> Vec<Range<usize>> {
    let count = r.routing_meta[0] as usize;
    let mut blocks = Vec::new();
    let (mut from, mut cells) = (0usize, 0i32);
    for seg in 0..count {
        if r.seg_leaf[seg] == 0 {
            continue;
        }
        cells += r.seg_start[seg + 1] - r.seg_start[seg];
        if cells >= LEAF_BLOCK {
            blocks.push(from..seg + 1);
            from = seg + 1;
            cells = 0;
        }
    }
    if from < count {
        blocks.push(from..count);
    }
    blocks
}

/// Implicit stream power for one node, receiver-first; returns the cut.
fn fluvial_cell(
    g: &EngineIndex,
    t: &TerrainView,
    r: &Routing,
    cell: usize,
    params: &ErosionSolverParams,
    cell_m: f64,
    cell_km2: f64,
) -> f64 {
    t.erosion_volume.set(cell, 0.0);
    t.erosion_coarse.set(cell, 0.0);
    let old = t.z.get(cell) as f64;
    if old <= 0.0 {
        return 0.0;
    }
    // A node under a lake cuts nothing: still water has no stream power
    // (TEG-65; DES-0027 entry 18, 2026-10-30). The lake is the routing's,
    // its fill over the z it was routed on, as the hydrology reads it.
    if r.filled[cell] as f64 > r.z_snapshot[cell] as f64 + FLOOD_EPS {
        return 0.0;
    }
    let target = r.flow_target[cell];
    if target < 0 {
        return 0.0;
    }
    let zr = t.z.get(target as usize) as f64;
    if zr >= old {
        return 0.0;
    }
    let acc = r.accumulation[cell] as f64;
    if acc * cell_km2 < params.channel_head_km2 {
        return 0.0;
    }
    let dist_km = (cell_m / 1000.0)
        * g.len_rel[g.nbr_start[cell] as usize + r.flow_dir[cell] as usize] as f64;
    let area = g.area_rel[cell] as f64;
    let discharge_km2 = acc * cell_km2 + params.base_area_rel * area * cell_km2;
    let f =
        (params.kappa_dt * t.erodibility[cell] as f64 * det_pow(discharge_km2, params.m)) / dist_km;
    let znew = (old + f * zr) / (1.0 + f);
    let cut = old - znew;
    t.z.set(cell, znew as f32);
    let volume = (cut * ELEVATION_METERS * cell_km2 * area * 1e6) as f32;
    t.erosion_volume.set(cell, volume);
    let volume = volume as f64;
    t.cut_volume
        .set(cell, (t.cut_volume.get(cell) as f64 + volume) as f32);
    let slope = ((old - zr) * ELEVATION_METERS) / (dist_km * 1000.0);
    t.erosion_coarse.set(
        cell,
        (volume * js::min(1.0, slope / params.coarse_slope)) as f32,
    );
    cut
}

/// The fluvial walk's serial stage; returns the residual.
pub fn fluvial_serial(
    g: &EngineIndex,
    t: &TerrainView,
    r: &Routing,
    popped: usize,
    params: &ErosionSolverParams,
    cell_m: f64,
) -> f64 {
    let cell_km2 = (cell_m / 1000.0) * (cell_m / 1000.0);
    let mut max_step = 0.0;
    for i in 0..popped {
        let cell = r.pop_order[i] as usize;
        if r.stage[cell] != 1 {
            continue;
        }
        let cut = fluvial_cell(g, t, r, cell, params, cell_m, cell_km2);
        if cut > max_step {
            max_step = cut;
        }
    }
    max_step
}

/// The fluvial walk's leaf stage over the segments `segs`, receiver-first
/// within each; returns their residual.
pub fn kernel_fluvial_leaf(
    g: &EngineIndex,
    t: &TerrainView,
    r: &Routing,
    segs: Range<usize>,
    params: &ErosionSolverParams,
    cell_m: f64,
) -> f64 {
    let cell_km2 = (cell_m / 1000.0) * (cell_m / 1000.0);
    let mut max_step = 0.0;
    for seg in segs {
        if r.seg_leaf[seg] == 0 {
            continue;
        }
        for k in r.seg_start[seg] as usize..r.seg_start[seg + 1] as usize {
            let cut = fluvial_cell(g, t, r, r.seg_order[k] as usize, params, cell_m, cell_km2);
            if cut > max_step {
                max_step = cut;
            }
        }
    }
    max_step
}

/// What the sediment walk reads of the run's units.
struct SedimentUnits {
    cell_m: f64,
    cell_km2: f64,
    column_m3: f64,
    cap_land_m3: f64,
    cap_marine_m3: f64,
}

impl SedimentUnits {
    fn new(params: &ErosionSolverParams, cell_m: f64) -> Self {
        let cell_km2 = (cell_m / 1000.0) * (cell_m / 1000.0);
        SedimentUnits {
            cell_m,
            cell_km2,
            column_m3: ELEVATION_METERS * cell_km2 * 1e6,
            cap_land_m3: params.deposit_cap_land_m * cell_km2 * 1e6,
            cap_marine_m3: params.deposit_cap_marine_m * cell_km2 * 1e6,
        }
    }
}

#[inline]
fn add_f32(a: &SharedF32, i: usize, v: f64) {
    a.set(i, (a.get(i) as f64 + v) as f32);
}

/// ξ–q sediment routing for one node, donor-first. Returns the total
/// leaving the node; `carry` is [the residual, the two provenance products
/// leaving, the coarse part leaving].
fn sediment_cell(
    g: &EngineIndex,
    t: &TerrainView,
    r: &Routing,
    cell: usize,
    params: &ErosionSolverParams,
    u: &SedimentUnits,
    carry: &mut [f64; 4],
) -> f64 {
    let ev = t.erosion_volume.get(cell) as f64;
    let ec = t.erosion_coarse.get(cell) as f64;
    let mut fine = js::max(0.0, t.flux.get(cell) as f64 + ev - ec);
    let mut coarse = js::max(0.0, t.flux_coarse.get(cell) as f64 + ec);
    let mut carrying = fine + coarse;
    let mut p_craton = t.flux_craton.get(cell) as f64 + ev * t.craton_age[cell] as f64;
    let mut p_hard = t.flux_hard.get(cell) as f64 + ev * t.rock_hard[cell] as f64;
    carry[1] = p_craton;
    carry[2] = p_hard;
    carry[3] = coarse;
    if carrying <= 0.0 {
        return carrying;
    }
    let zc = t.z.get(cell) as f64;
    let land = zc > 0.0;
    let grid8 = t.flags[FLAG_GRID8] != 0;
    let area = g.area_rel[cell] as f64;
    let settle = if land {
        js::max(
            params.settle_floor_km,
            params.settle_xi_km
                * (r.accumulation[cell] as f64 * u.cell_km2
                    + params.base_area_rel * area * u.cell_km2)
                    .sqrt(),
        )
    } else {
        params.settle_marine_km
    };
    let width_scale = if land {
        params.settle_width_ref_km / ((area.sqrt() * u.cell_m) / 1000.0)
    } else {
        1.0
    };
    let reach_km = (u.cell_m / 1000.0)
        * if r.flow_target[cell] >= 0 && !grid8 {
            g.len_rel[g.nbr_start[cell] as usize + r.flow_dir[cell] as usize] as f64
        } else {
            1.0
        };
    if coarse > 0.0 {
        let abraded = coarse * (1.0 - det_exp(-reach_km / params.abrasion_km));
        coarse -= abraded;
        fine += abraded;
    }
    let deposit_fine = fine * (1.0 - det_exp(-reach_km / (settle * width_scale)));
    let mut deposit_coarse =
        coarse * (1.0 - det_exp(-reach_km / (params.settle_coarse_km * width_scale)));
    let mut deposit = deposit_fine + deposit_coarse;
    let column = u.column_m3 * area;
    let freeboard = params.marine_freeboard_m / ELEVATION_METERS;
    let donor_min = t.donor_min.get(cell) as f64;
    let cap = if grid8 {
        let donor_cap = donor_min - 1e-5;
        if land {
            donor_cap
        } else {
            js::min(donor_cap, freeboard)
        }
    } else if land {
        let filled = r.filled[cell] as f64;
        if filled > zc + 1e-6 {
            filled + freeboard
        } else {
            f64::INFINITY
        }
    } else if r.seed_mask[cell] == 0 {
        // A basin below the sea that the world ocean does not reach fills
        // to its own spill level, as a lake does (TEG-57; DES-0027 entry 9,
        // 2026-10-30).
        js::min(
            donor_min - 1e-5,
            js::max(freeboard, r.filled[cell] as f64 + freeboard),
        )
    } else {
        js::min(donor_min - 1e-5, freeboard)
    };
    let room = (cap - zc) * column;
    let cap_m3 = (if land { u.cap_land_m3 } else { u.cap_marine_m3 }) * area;
    let allowed = js::min(js::max(0.0, room), cap_m3);
    if deposit > allowed {
        let scale = if deposit > 0.0 {
            allowed / deposit
        } else {
            0.0
        };
        deposit_coarse *= scale;
        deposit = allowed;
    }
    if deposit > 0.0 {
        let dz = deposit / column;
        t.z.set(cell, (zc + dz) as f32);
        let share = js::min(1.0, deposit / carrying);
        add_f32(&t.deposit_volume, cell, deposit);
        add_f32(&t.deposit_coarse, cell, deposit_coarse);
        add_f32(&t.deposit_craton, cell, p_craton * share);
        add_f32(&t.deposit_hard, cell, p_hard * share);
        p_craton -= p_craton * share;
        p_hard -= p_hard * share;
        carry[1] = p_craton;
        carry[2] = p_hard;
        coarse -= deposit_coarse;
        carrying -= deposit;
        if land && dz > carry[0] {
            carry[0] = dz;
        }
    }
    carry[3] = coarse;
    carrying
}

/// Hands what leaves `cell` to its receiver `target`.
#[inline]
fn hand_down(t: &TerrainView, cell: usize, target: usize, carrying: f64, carry: &[f64; 4]) {
    add_f32(&t.flux, target, carrying - carry[3]);
    add_f32(&t.flux_coarse, target, carry[3]);
    add_f32(&t.flux_craton, target, carry[1]);
    add_f32(&t.flux_hard, target, carry[2]);
    let z = t.z.get(cell);
    if z < t.donor_min.get(target) {
        t.donor_min.set(target, z);
    }
}

#[inline]
fn reset_walk(t: &TerrainView, cell: usize) {
    t.flux.set(cell, 0.0);
    t.flux_coarse.set(cell, 0.0);
    t.flux_craton.set(cell, 0.0);
    t.flux_hard.set(cell, 0.0);
    t.donor_min.set(cell, f32::INFINITY);
}

/// The sediment walk's leaf stage over the segments `segs`: what leaves a
/// segment's root goes into the segment's mailbox, or, with no receiver,
/// into `exported` at the segment. Returns the residual.
pub fn kernel_sediment_leaf(
    g: &EngineIndex,
    t: &TerrainView,
    r: &Routing,
    segs: Range<usize>,
    params: &ErosionSolverParams,
    cell_m: f64,
    exported: &SharedF64,
) -> f64 {
    let u = SedimentUnits::new(params, cell_m);
    let mut carry = [0.0; 4];
    for seg in segs {
        if r.seg_leaf[seg] == 0 {
            continue;
        }
        let start = r.seg_start[seg] as usize;
        let end = r.seg_start[seg + 1] as usize;
        for k in start..end {
            reset_walk(t, r.seg_order[k] as usize);
        }
        for k in (start + 1..end).rev() {
            let cell = r.seg_order[k] as usize;
            let carrying = sediment_cell(g, t, r, cell, params, &u, &mut carry);
            hand_down(t, cell, r.flow_target[cell] as usize, carrying, &carry);
        }
        let root = r.seg_order[start] as usize;
        let carrying = sediment_cell(g, t, r, root, params, &u, &mut carry);
        if r.flow_target[root] >= 0 {
            t.mouth_flux.set(seg, (carrying - carry[3]) as f32);
            t.mouth_coarse.set(seg, carry[3] as f32);
            t.mouth_craton.set(seg, carry[1] as f32);
            t.mouth_hard.set(seg, carry[2] as f32);
            t.mouth_z.set(seg, t.z.get(root));
            exported.set(seg, 0.0);
        } else {
            t.mouth_flux.set(seg, 0.0);
            t.mouth_coarse.set(seg, 0.0);
            t.mouth_craton.set(seg, 0.0);
            t.mouth_hard.set(seg, 0.0);
            exported.set(seg, carrying);
        }
    }
    carry[0]
}

/// The leaf stage's two tallies, summed per worker range of the TypeScript
/// pool and then over the workers in order: the grouping its sums have.
fn leaf_tallies(
    t: &TerrainView,
    r: &Routing,
    exported: &[f64],
    leaf_workers: usize,
    tallies: &mut Tallies,
) {
    for w in 0..leaf_workers {
        let (from, to) = leaf_range(r, w, leaf_workers);
        let mut eroded = 0.0;
        let mut out = 0.0;
        for seg in from..to {
            if r.seg_leaf[seg] == 0 {
                continue;
            }
            let start = r.seg_start[seg] as usize;
            for k in start..r.seg_start[seg + 1] as usize {
                eroded += t.erosion_volume.get(r.seg_order[k] as usize) as f64;
            }
            if r.flow_target[r.seg_order[start] as usize] < 0 && exported[seg] > 0.0 {
                out += exported[seg];
            }
        }
        tallies.eroded += eroded;
        tallies.exported += out;
    }
}

/// The sediment walk's serial stage, after the leaf stage: the mailboxes
/// to their outlets, then the serial-stage nodes donor-first. Returns the
/// residual; adds to the tallies.
pub fn sediment_serial(
    g: &EngineIndex,
    t: &TerrainView,
    r: &Routing,
    popped: usize,
    params: &ErosionSolverParams,
    cell_m: f64,
    tallies: &mut Tallies,
) -> f64 {
    let u = SedimentUnits::new(params, cell_m);
    let mut carry = [0.0; 4];
    let mut eroded = 0.0;
    let mut exported = 0.0;
    for i in 0..popped {
        let cell = r.pop_order[i] as usize;
        if r.stage[cell] != 1 {
            continue;
        }
        reset_walk(t, cell);
        eroded += t.erosion_volume.get(cell) as f64;
    }
    let count = r.routing_meta[0] as usize;
    for seg in 0..count {
        if r.seg_leaf[seg] == 0 {
            continue;
        }
        let target = r.flow_target[r.seg_order[r.seg_start[seg] as usize] as usize];
        if target < 0 {
            continue;
        }
        let target = target as usize;
        add_f32(&t.flux, target, t.mouth_flux.get(seg) as f64);
        add_f32(&t.flux_coarse, target, t.mouth_coarse.get(seg) as f64);
        add_f32(&t.flux_craton, target, t.mouth_craton.get(seg) as f64);
        add_f32(&t.flux_hard, target, t.mouth_hard.get(seg) as f64);
        let mouth_z = t.mouth_z.get(seg);
        if mouth_z < t.donor_min.get(target) {
            t.donor_min.set(target, mouth_z);
        }
    }
    for i in (0..popped).rev() {
        let cell = r.pop_order[i] as usize;
        if r.stage[cell] != 1 {
            continue;
        }
        let carrying = sediment_cell(g, t, r, cell, params, &u, &mut carry);
        let target = r.flow_target[cell];
        if target >= 0 {
            hand_down(t, cell, target as usize, carrying, &carry);
        } else if carrying > 0.0 {
            exported += carrying;
        }
    }
    tallies.eroded += eroded;
    tallies.exported += exported;
    carry[0]
}

// ------------------------------------------------------------------ driver

/// The raster index for a run.
pub fn build_raster_index(
    grid: &DomainGrid,
    initial: &[f32],
    forcing: &ErosionForcing,
    params: &ErosionSolverParams,
) -> EngineIndex {
    let n = grid.res_x * grid.res_y;
    assert!(
        initial.len() == n && forcing.uplift.len() == n && forcing.erodibility.len() == n,
        "field size mismatch"
    );
    build_engine_index(
        initial,
        grid,
        shelf_band_cells(&grid.domain, grid.res_x, params),
        raster_cell_m(&grid.domain, grid.res_x),
    )
}

/// The terrain section's initial contents, gathered from the caller's full
/// arrays.
pub fn load_terrain(
    index: &EngineIndex,
    t: &mut Terrain,
    initial: &[f32],
    forcing: &ErosionForcing,
) {
    gather_active(index, initial, &mut t.z);
    gather_active(index, forcing.uplift, &mut t.uplift);
    gather_active(index, forcing.erodibility, &mut t.erodibility);
    if let Some(mask) = forcing.coast_mask {
        gather_active(index, mask, &mut t.coast_mask);
        t.flags[FLAG_HAS_COAST_MASK] = 1;
    }
    if let Some(w) = forcing.accumulation_weights {
        gather_active(index, w, &mut t.accumulation_weights);
        t.flags[FLAG_HAS_ACCUM_WEIGHTS] = 1;
    }
    if let Some(mask) = forcing.status_mask {
        gather_active(index, mask, &mut t.status_mask);
        t.flags[FLAG_HAS_STATUS_MASK] = 1;
    }
    if let Some(p) = forcing.pinned_z {
        gather_active(index, p, &mut t.pinned_z);
        t.flags[FLAG_HAS_PINNED] = 1;
        t.flags[FLAG_HAS_STATUS_MASK] = 1;
    }
    if let Some(c) = forcing.craton_age {
        gather_active(index, c, &mut t.craton_age);
    }
    if let Some(h) = forcing.rock_hard {
        gather_active(index, h, &mut t.rock_hard);
    }
    match forcing.slope_scale {
        Some(s) => gather_active(index, s, &mut t.slope_scale),
        None => t.slope_scale.fill(1.0),
    }
    match forcing.diff_scale {
        Some(s) => gather_active(index, s, &mut t.diff_scale),
        None => t.diff_scale.fill(1.0),
    }
}

/// The routing refresh for every driver, routed on `z` (the live terrain,
/// or a snapshot of it). Returns the popped count; a world with no water at
/// all gets no routing.
pub fn refresh_routing_on(
    g: &EngineIndex,
    z: &[f32],
    t: &Terrain,
    r: &mut Routing,
    s: &mut RoutingScratch,
) -> usize {
    if !compute_ocean_seed(g, z, t, r, s) {
        r.flow_target.fill(-1);
        r.flow_dir.fill(NO_SLOT);
        r.accumulation.fill(1.0);
        return 0;
    }
    let popped = flood_active(g, z, r, s);
    run_scans(g, t.flags[FLAG_GRID8] != 0, r);
    lambda_walk(g, r, popped, s);
    build_segments(z, r, popped, s);
    accumulate_flow_v2(g, t, r, popped);
    popped
}

/// One physics iteration on routing `r`; returns the residual, metres.
#[allow(clippy::too_many_arguments)]
fn step_physics(
    g: &EngineIndex,
    t: &mut Terrain,
    r: &Routing,
    popped: usize,
    params: &ErosionSolverParams,
    kp: &KernelParams,
    leaf_workers: usize,
    tallies: &mut Tallies,
    seg_exported: &mut [f64],
) -> f64 {
    let blocks = block_ranges(g.active_count as usize, ENGINE_BLOCK);
    let leaves = leaf_blocks(r);
    let cell_m = kp.cell_m;
    let has_status = t.flags[FLAG_HAS_STATUS_MASK] != 0;
    let v = t.view();
    let most = |steps: Vec<f64>| steps.into_iter().fold(0.0, js::max);
    for_ranges(&blocks, |cells| kernel_uplift(g, &v, cells, kp));
    let mut max_step = js::max(0.0, fluvial_serial(g, &v, r, popped, params, cell_m));
    max_step = js::max(
        max_step,
        most(for_ranges(&leaves, |segs| {
            kernel_fluvial_leaf(g, &v, r, segs, params, cell_m)
        })),
    );
    {
        let exported = SharedF64::new(seg_exported);
        max_step = js::max(
            max_step,
            most(for_ranges(&leaves, |segs| {
                kernel_sediment_leaf(g, &v, r, segs, params, cell_m, &exported)
            })),
        );
    }
    leaf_tallies(&v, r, seg_exported, leaf_workers, tallies);
    max_step = js::max(
        max_step,
        sediment_serial(g, &v, r, popped, params, cell_m, tallies),
    );
    for_ranges(&blocks, |cells| kernel_hill_moves(g, &v, cells, kp));
    max_step = js::max(
        max_step,
        most(for_ranges(&blocks, |cells| {
            kernel_hill_apply(g, &v, cells, kp)
        })),
    );
    for_ranges(&blocks, |cells| kernel_marine_moves(g, &v, cells, kp));
    for_ranges(&blocks, |cells| kernel_marine_apply(g, &v, cells, kp));
    if has_status {
        for_ranges(&blocks, |cells| kernel_status_clamp(&v, cells));
    }
    max_step * ELEVATION_METERS
}

/// The single solver (`ErosionEngine` in TypeScript): a routing every
/// `routing_every` iterations, from the live terrain.
pub struct ErosionSolver {
    pub params: ErosionSolverParams,
    pub index: EngineIndex,
    pub terrain: Terrain,
    pub routing: Routing,
    pub popped_count: usize,
    /// The TypeScript pool's worker count, for the tallies' sums.
    pub leaf_workers: usize,
    pub tallies: Tallies,
    cursor: u64,
    scratch: RoutingScratch,
    /// What each leaf segment's root exported this iteration.
    seg_exported: Vec<f64>,
    kernel_params: KernelParams,
}

impl ErosionSolver {
    /// The solver on a raster: the index is built from the initial terrain.
    pub fn on_raster(
        grid: &DomainGrid,
        initial: &[f32],
        forcing: &ErosionForcing,
        params: ErosionSolverParams,
    ) -> Self {
        let index = build_raster_index(grid, initial, forcing, &params);
        Self::new(index, initial, forcing, params)
    }

    /// The solver over a prepared index (a mesh's).
    pub fn on_index(
        index: EngineIndex,
        initial: &[f32],
        forcing: &ErosionForcing,
        params: ErosionSolverParams,
    ) -> Self {
        let n = index.cell_count as usize;
        assert!(
            initial.len() >= n && forcing.uplift.len() >= n && forcing.erodibility.len() >= n,
            "field size mismatch"
        );
        Self::new(index, initial, forcing, params)
    }

    fn new(
        index: EngineIndex,
        initial: &[f32],
        forcing: &ErosionForcing,
        params: ErosionSolverParams,
    ) -> Self {
        let mut terrain = Terrain::new(&index);
        load_terrain(&index, &mut terrain, initial, forcing);
        let a = index.active_count as usize;
        ErosionSolver {
            params,
            kernel_params: kernel_params_for(index.ref_m, &params),
            routing: Routing::new(&index),
            scratch: RoutingScratch::new(a),
            seg_exported: vec![0.0; a],
            index,
            terrain,
            popped_count: 0,
            leaf_workers: 1,
            tallies: Tallies::default(),
            cursor: 0,
        }
    }

    /// The full layout: active nodes from the solver, frozen ones from
    /// `frozen_from`.
    pub fn expand_z(&self, frozen_from: &[f32]) -> Vec<f32> {
        expand_active(&self.index, &self.terrain.z, frozen_from)
    }

    /// Recompute the whole routing state from the current z, kept as the
    /// routing's snapshot (the fluvial walk reads the lakes from it).
    pub fn refresh_routing(&mut self) {
        let r = &mut self.routing;
        r.z_snapshot.copy_from_slice(&self.terrain.z);
        let snapshot = std::mem::take(&mut r.z_snapshot);
        self.popped_count =
            refresh_routing_on(&self.index, &snapshot, &self.terrain, r, &mut self.scratch);
        r.z_snapshot = snapshot;
    }

    /// One physics iteration on the current routing; returns the residual,
    /// metres.
    pub fn step_physics(&mut self) -> f64 {
        step_physics(
            &self.index,
            &mut self.terrain,
            &self.routing,
            self.popped_count,
            &self.params,
            &self.kernel_params,
            self.leaf_workers,
            &mut self.tallies,
            &mut self.seg_exported,
        )
    }

    /// Run the transient: `iterations` is the landscape age; stops early at
    /// quasi-steady state (3 consecutive residuals under eps_m).
    pub fn run(
        &mut self,
        iterations: u32,
        routing_every: u32,
        mut on_iteration: impl FnMut(u32, f64),
    ) -> f64 {
        let mut residual = f64::INFINITY;
        let mut calm_streak = 0;
        for i in 0..iterations {
            if self.cursor.is_multiple_of(routing_every as u64) {
                self.refresh_routing();
            }
            self.cursor += 1;
            residual = self.step_physics();
            calm_streak = if residual < self.params.eps_m {
                calm_streak + 1
            } else {
                0
            };
            on_iteration(i, residual);
            if calm_streak >= 3 {
                break;
            }
        }
        residual
    }
}

/// The pool's pipelined scheme (`PipelinedErosionEngine` in TypeScript,
/// which explains it): the routing during [kD, (k+1)D) is the routing of
/// the z at (k−1)D — at 0 for k = 0 —, or, `synchronous`, of the z at kD.
/// Here each refresh runs where TypeScript starts it, which gives the same
/// routing: it reads only its snapshot.
pub struct PipelinedErosionSolver {
    pub params: ErosionSolverParams,
    pub index: EngineIndex,
    pub terrain: Terrain,
    pub popped_count: usize,
    pub pipeline_depth: u32,
    pub synchronous: bool,
    /// The TypeScript pool's stencil worker count, for the tallies' sums.
    pub leaf_workers: usize,
    pub tallies: Tallies,
    routing: [Routing; 2],
    popped: [usize; 2],
    active_index: Option<usize>,
    in_flight: Option<usize>,
    cursor: u64,
    scratch: RoutingScratch,
    /// What each leaf segment's root exported this iteration.
    seg_exported: Vec<f64>,
    kernel_params: KernelParams,
}

impl PipelinedErosionSolver {
    pub fn new(
        index: EngineIndex,
        initial: &[f32],
        forcing: &ErosionForcing,
        params: ErosionSolverParams,
        pipeline_depth: u32,
        synchronous: bool,
        leaf_workers: usize,
    ) -> Self {
        let n = index.cell_count as usize;
        assert!(
            initial.len() >= n && forcing.uplift.len() >= n && forcing.erodibility.len() >= n,
            "field size mismatch"
        );
        assert!(
            pipeline_depth >= 1 && (1..=64).contains(&leaf_workers),
            "pipeline options out of range"
        );
        let mut terrain = Terrain::new(&index);
        load_terrain(&index, &mut terrain, initial, forcing);
        let a = index.active_count as usize;
        PipelinedErosionSolver {
            params,
            kernel_params: kernel_params_for(index.ref_m, &params),
            routing: [Routing::new(&index), Routing::new(&index)],
            popped: [0; 2],
            scratch: RoutingScratch::new(a),
            seg_exported: vec![0.0; a],
            index,
            terrain,
            popped_count: 0,
            pipeline_depth,
            synchronous,
            leaf_workers,
            tallies: Tallies::default(),
            active_index: None,
            in_flight: None,
            cursor: 0,
        }
    }

    /// The routing the walks currently run on.
    pub fn active_routing(&self) -> &Routing {
        &self.routing[self.active_index.expect("no routing adopted yet")]
    }

    pub fn expand_z(&self, frozen_from: &[f32]) -> Vec<f32> {
        expand_active(&self.index, &self.terrain.z, frozen_from)
    }

    fn start_refresh(&mut self, target: usize) {
        let r = &mut self.routing[target];
        r.z_snapshot.copy_from_slice(&self.terrain.z);
        let snapshot = std::mem::take(&mut r.z_snapshot);
        self.popped[target] =
            refresh_routing_on(&self.index, &snapshot, &self.terrain, r, &mut self.scratch);
        r.z_snapshot = snapshot;
        self.in_flight = Some(target);
    }

    fn wait_and_adopt(&mut self) {
        let target = self.in_flight.take().expect("no refresh in flight");
        self.active_index = Some(target);
        self.popped_count = self.popped[target];
    }

    fn other(&self) -> usize {
        self.active_index.map_or(0, |a| 1 - a)
    }

    /// One synchronous refresh of the current terrain, adopted at once;
    /// returns the popped count.
    pub fn finalize_routing(&mut self) -> usize {
        if self.in_flight.is_some() {
            self.wait_and_adopt();
        }
        self.start_refresh(self.other());
        self.wait_and_adopt();
        self.popped_count
    }

    fn boundary(&mut self) {
        if self.synchronous {
            if self.in_flight.is_some() {
                self.wait_and_adopt();
            }
            self.start_refresh(self.other());
            self.wait_and_adopt();
            return;
        }
        if self.active_index.is_none() {
            self.start_refresh(0);
            self.wait_and_adopt();
            self.start_refresh(1);
            return;
        }
        self.wait_and_adopt();
        self.start_refresh(self.other());
    }

    pub fn step_physics(&mut self) -> f64 {
        let active = self.active_index.expect("no routing adopted yet");
        step_physics(
            &self.index,
            &mut self.terrain,
            &self.routing[active],
            self.popped_count,
            &self.params,
            &self.kernel_params,
            self.leaf_workers,
            &mut self.tallies,
            &mut self.seg_exported,
        )
    }

    pub fn run(&mut self, iterations: u32, mut on_iteration: impl FnMut(u32, f64)) -> f64 {
        let mut residual = f64::INFINITY;
        let mut calm_streak = 0;
        for i in 0..iterations {
            if self.cursor.is_multiple_of(self.pipeline_depth as u64) {
                self.boundary();
            }
            self.cursor += 1;
            residual = self.step_physics();
            calm_streak = if residual < self.params.eps_m {
                calm_streak + 1
            } else {
                0
            };
            on_iteration(i, residual);
            if calm_streak >= 3 {
                break;
            }
        }
        residual
    }
}
