//! `surface/hydrology.ts`: rivers and lakes on the eroded terrain over the
//! flow substrate — the single-flow discharge with the terminal basins'
//! water balance, the lakes and terminal seas as water bodies, the flow
//! regime's climate inputs, the channel criterion, the watersheds and the
//! riparian moisture; and the water bodies read back on a raster. The
//! TypeScript port (`client/src/generator/surface/hydrology.ts`, git
//! history) explains each rule. The river polylines' type is the river
//! graph's (surface/river_graph.rs).

use crate::climate::precipitation::OCEAN_PRECIP;
use crate::core::det_math::{det_exp, det_log, det_pow};
use crate::core::domain::{Domain, DomainGrid};
use crate::core::js;
use crate::core::min_heap::MinHeap;
use crate::elevation::elevation_scale::{SEA_LEVEL, meters_to_elevation};

use super::flow_substrate::FlowSubstrate;
use super::surface_tune_params::SURFACE_TUNING;

/// The one density the model runs at.
pub const CANONICAL_RIVER_DENSITY: f64 = 55.0;

/// A stable sort's order under JavaScript's comparator `a − b`: equal for
/// a tie (−0 and +0 among them) and for NaN.
fn js_order(a: f64, b: f64) -> std::cmp::Ordering {
    a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
}

fn runoff_of(p: f64) -> f64 {
    if p > 0.0 { p } else { 0.0 }
}

pub const RUNOFF_COEFFICIENT: f64 = 0.35;
const SECONDS_PER_YEAR: f64 = 3.156e7;

pub fn discharge_to_m3s(discharge_units: f64, cell_m: f64) -> f64 {
    discharge_units * ((cell_m * cell_m * 1e-3) / SECONDS_PER_YEAR) * RUNOFF_COEFFICIENT
}

/// Potential evaporation from open water, mm/yr.
pub fn evaporation_potential(temp_c: f64) -> f64 {
    let t = &SURFACE_TUNING;
    let pet = t.pet_base_mm + t.pet_per_deg_c * temp_c;
    if pet < t.pet_min_mm {
        t.pet_min_mm
    } else if pet > t.pet_max_mm {
        t.pet_max_mm
    } else {
        pet
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaterKind {
    Lake,
    Terminal,
    Dry,
}

/// One standing water body, or a basin that failed to hold one
/// (`WaterBody` in TypeScript, which explains each field).
#[derive(Clone, Debug, PartialEq)]
pub struct WaterBody {
    pub id: usize,
    pub kind: WaterKind,
    pub level: f64,
    pub spill: f64,
    pub floor: f64,
    pub seed_x: f64,
    pub seed_y: f64,
    pub outlet_x: f64,
    pub outlet_y: f64,
    pub cells: f64,
    pub frozen: bool,
    /// Under an ice sheet (`mark_subglacial`): a basin, not a lake.
    pub subglacial: bool,
}

/// The lakes per element (`LakeFields` in TypeScript).
#[derive(Clone, Debug)]
pub struct LakeFields {
    pub depth: Vec<f32>,
    pub salt_flat: Vec<u8>,
    pub dry_basin: Vec<u8>,
    pub frozen: Vec<u8>,
    pub bodies: Vec<WaterBody>,
    pub level: Vec<f32>,
    pub body: Vec<i32>,
}

pub const SEA_WATER_LEVEL: f64 = SEA_LEVEL;

/// `a < b` in JavaScript: false when either is NaN.
fn below(a: f64, b: f64) -> bool {
    a < b
}

/// One basin's cells on a raster: the 4-connected region below its spill
/// around its seed.
pub fn basin_cells_below(elevation: &[f32], grid: &DomainGrid, body: &WaterBody) -> Vec<usize> {
    let width = grid.res_x;
    let seed = body.seed_y.floor() as usize * width + body.seed_x.floor() as usize;
    if !below(elevation[seed] as f64, body.spill) {
        return vec![seed];
    }
    let mut seen = vec![0u8; width * grid.res_y];
    let mut queue = vec![seed];
    seen[seed] = 1;
    let mut head = 0;
    while head < queue.len() {
        let c = queue[head];
        head += 1;
        let cx = (c % width) as i64;
        let cy = (c / width) as i64;
        for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
            let nb = grid.neighbour(cx, cy, dx, dy);
            if seen[nb] != 0 || !below(elevation[nb] as f64, body.spill) {
                continue;
            }
            seen[nb] = 1;
            queue.push(nb);
        }
    }
    queue
}

pub const SURFACE_SEA: u8 = 0;
pub const SURFACE_LAKE: u8 = 1;
pub const SURFACE_ICE: u8 = 2;

/// The level each raster cell's shore is drawn against, the body it
/// belongs to (−1 the sea) and the surface standing there.
pub struct WaterLevels {
    pub level: Vec<f32>,
    pub body: Vec<i32>,
    pub surface: Vec<u8>,
}

pub fn water_level_field(
    bodies: &[WaterBody],
    elevation: &[f32],
    grid: &DomainGrid,
) -> WaterLevels {
    let width = grid.res_x;
    let n = width * grid.res_y;
    let mut level = vec![SEA_WATER_LEVEL as f32; n];
    let mut body = vec![-1i32; n];
    let mut surface = vec![SURFACE_SEA; n];
    let mut rim: Vec<usize> = Vec::new();
    for b in bodies {
        let cells = basin_cells_below(elevation, grid, b);
        let kind = if b.frozen { SURFACE_ICE } else { SURFACE_LAKE };
        for &c in &cells {
            level[c] = b.level as f32;
            body[c] = b.id as i32;
            surface[c] = kind;
        }
        rim.clear();
        for &c in &cells {
            let cx = (c % width) as i64;
            let cy = (c / width) as i64;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let nb = grid.neighbour(cx, cy, dx, dy);
                    let e = elevation[nb] as f64;
                    if body[nb] == -1 && e > SEA_LEVEL && e >= b.level {
                        rim.push(nb);
                    }
                }
            }
        }
        for &c in &rim {
            if body[c] != -1 {
                continue;
            }
            level[c] = b.level as f32;
            body[c] = b.id as i32;
            surface[c] = kind;
        }
    }
    WaterLevels {
        level,
        body,
        surface,
    }
}

/// The depth raster from the list.
pub fn lake_depth_from_bodies(
    bodies: &[WaterBody],
    elevation: &[f32],
    grid: &DomainGrid,
) -> Vec<f32> {
    let mut depth = vec![0f32; grid.res_x * grid.res_y];
    for b in bodies {
        if b.kind == WaterKind::Dry {
            continue;
        }
        for c in basin_cells_below(elevation, grid, b) {
            let e = elevation[c] as f64;
            if e <= b.level {
                depth[c] = (b.level - e) as f32;
            }
        }
    }
    depth
}

/// A filled node's fill above its ground, below which it is not flooded.
pub(crate) const FLOOD_EPS: f64 = 1e-5;

/// The lakes over the substrate; `temperature` °C per element.
pub fn compute_lakes_on<S: FlowSubstrate>(
    sub: &S,
    discharge: &[f32],
    elevation: &[f32],
    temperature: &[f32],
    min_basin_relief_m: f64,
) -> LakeFields {
    let filled = sub.filled();
    let n = sub.count();
    let mut depth = vec![0f32; n];
    let mut salt_flat = vec![0u8; n];
    let mut dry_basin = vec![0u8; n];
    let mut frozen = vec![0u8; n];
    let mut body = vec![-1i32; n];
    let mut level = vec![SEA_WATER_LEVEL as f32; n];
    let flooded: Vec<u8> = (0..n)
        .map(|c| u8::from(filled[c] as f64 > elevation[c] as f64 + FLOOD_EPS))
        .collect();
    let mut bodies: Vec<WaterBody> = Vec::new();
    let mut seen = vec![0u8; n];
    let mut queue = vec![0usize; n];
    let mut nb: Vec<u32> = Vec::new();
    for s in 0..n {
        if flooded[s] == 0 || seen[s] != 0 {
            continue;
        }
        let (mut head, mut tail) = (0usize, 0usize);
        queue[tail] = s;
        tail += 1;
        seen[s] = 1;
        let mut region: Vec<usize> = Vec::new();
        let mut region_area = 0.0;
        let mut spill = f64::NEG_INFINITY;
        let mut pour = f64::INFINITY;
        let mut pour_cell = s;
        let mut inflow = 0.0;
        let mut temp_sum = 0.0;
        while head < tail {
            let c = queue[head];
            head += 1;
            region.push(c);
            region_area += sub.area(c);
            if filled[c] as f64 > spill {
                spill = filled[c] as f64;
            }
            if discharge[c] as f64 > inflow {
                inflow = discharge[c] as f64;
            }
            temp_sum += temperature[c] as f64 * sub.area(c);
            sub.facet_neighbours(c, &mut nb);
            for &o in &nb {
                let o = o as usize;
                if flooded[o] != 0 {
                    if seen[o] == 0 {
                        seen[o] = 1;
                        queue[tail] = o;
                        tail += 1;
                    }
                } else if (elevation[o] as f64) < pour {
                    pour = elevation[o] as f64;
                    pour_cell = o;
                }
            }
        }
        let mut basin_floor = f64::INFINITY;
        let mut floor_cell = s;
        for &c in &region {
            if (elevation[c] as f64) < basin_floor {
                basin_floor = elevation[c] as f64;
                floor_cell = c;
            }
        }
        let mean_temp = temp_sum / region_area;
        let pet = evaporation_potential(mean_temp);
        let is_frozen = mean_temp < SURFACE_TUNING.lake_frozen_below_c;
        let mut record = |kind: WaterKind, lvl: f64, body: &mut [i32], level: &mut [f32]| {
            let id = bodies.len();
            bodies.push(WaterBody {
                id,
                kind,
                level: lvl,
                spill: pour,
                floor: basin_floor,
                seed_x: sub.x(floor_cell),
                seed_y: sub.y(floor_cell),
                outlet_x: sub.x(pour_cell),
                outlet_y: sub.y(pour_cell),
                cells: region_area,
                frozen: is_frozen,
                subglacial: false,
            });
            for &c in &region {
                body[c] = id as i32;
                level[c] = lvl as f32;
            }
        };
        if basin_floor < SEA_LEVEL {
            inflow = 0.0;
            for &c in &region {
                inflow += discharge[c] as f64;
            }
            let mut lvl = spill;
            if inflow < pet * region_area {
                let mut sorted = region.clone();
                sorted.sort_by(|&a, &b| js_order(elevation[a] as f64, elevation[b] as f64));
                let mut area = 0.0;
                lvl = basin_floor;
                for &c in &sorted {
                    area += sub.area(c);
                    if pet * area >= inflow {
                        lvl = elevation[c] as f64;
                        break;
                    }
                }
            }
            let salt_band_top = lvl + meters_to_elevation(SURFACE_TUNING.salt_band_m);
            let mut wet = 0;
            for &c in &region {
                let e = elevation[c] as f64;
                if e <= lvl {
                    depth[c] = (lvl - e) as f32;
                    if is_frozen {
                        frozen[c] = 1;
                    }
                    wet += 1;
                } else if e <= SEA_LEVEL {
                    dry_basin[c] = 1;
                    if e <= salt_band_top {
                        salt_flat[c] = 1;
                    }
                }
            }
            let kind = if lvl > basin_floor && wet > 0 {
                WaterKind::Terminal
            } else {
                WaterKind::Dry
            };
            record(kind, lvl, &mut body, &mut level);
            continue;
        }
        if spill - basin_floor < meters_to_elevation(min_basin_relief_m) {
            continue;
        }
        if inflow < pet * region_area {
            continue;
        }
        for &c in &region {
            let e = elevation[c] as f64;
            if e <= spill {
                depth[c] = (spill - e) as f32;
                if is_frozen {
                    frozen[c] = 1;
                }
            }
        }
        record(WaterKind::Lake, spill, &mut body, &mut level);
    }
    LakeFields {
        depth,
        salt_flat,
        dry_basin,
        frozen,
        bodies,
        level,
        body,
    }
}

/// SUBGLACIAL BASINS (DES-0027 entry 15, TEG-63, 2026-10-30). The flood
/// fills every closed basin, also one under an ice sheet: on the torus
/// 3.7–7.2 points of the land were such basins, counted as lakes. The
/// user's decision (option C): a body whose wet area lies more than half
/// under ice at least `ice_min_thickness_m` thick is a subglacial basin. It
/// stays in the table with its level and extent, flagged, and counts as
/// no lake; where the ice goes (the incubator's deglaciation), it is the
/// proglacial lake. `ice` per element (m), `area` its area.
pub fn mark_subglacial(lakes: &mut LakeFields, ice: &[f32], area: &[f32]) {
    let mut wet = vec![0.0f64; lakes.bodies.len()];
    let mut iced = vec![0.0f64; lakes.bodies.len()];
    for c in 0..lakes.body.len() {
        let b = lakes.body[c];
        if b < 0 || lakes.depth[c] <= 0.0 {
            continue;
        }
        wet[b as usize] += area[c] as f64;
        if ice[c] as f64 >= SURFACE_TUNING.ice_min_thickness_m {
            iced[b as usize] += area[c] as f64;
        }
    }
    for (k, body) in lakes.bodies.iter_mut().enumerate() {
        body.subglacial = iced[k] > 0.5 * wet[k];
    }
}

/// The terminal basins: the flood's regions with a floor below sea level.
struct TerminalBasins {
    count: usize,
    region: Vec<i32>,
    area: Vec<f64>,
    exits: Vec<i32>,
    start: Vec<usize>,
    nodes: Vec<usize>,
}

fn terminal_basins<S: FlowSubstrate>(sub: &S, elevation: &[f32]) -> TerminalBasins {
    let filled = sub.filled();
    let flow_target = sub.flow_target();
    let n = sub.count();
    let flooded: Vec<bool> = (0..n)
        .map(|c| filled[c] as f64 > elevation[c] as f64 + FLOOD_EPS)
        .collect();
    let mut seen = vec![-1i64; n];
    let mut region = vec![-1i32; n];
    let mut queue = vec![0usize; n];
    let mut nb: Vec<u32> = Vec::new();
    let mut area = Vec::new();
    let mut exits = Vec::new();
    let mut start = vec![0usize];
    let mut nodes = Vec::new();
    let mut regions = 0usize;
    for s in 0..n {
        if !flooded[s] || seen[s] >= 0 {
            continue;
        }
        let (mut head, mut tail) = (0usize, 0usize);
        queue[tail] = s;
        tail += 1;
        seen[s] = s as i64;
        let mut floor = f64::INFINITY;
        while head < tail {
            let c = queue[head];
            head += 1;
            if (elevation[c] as f64) < floor {
                floor = elevation[c] as f64;
            }
            sub.facet_neighbours(c, &mut nb);
            for &o in &nb {
                let o = o as usize;
                if flooded[o] && seen[o] < 0 {
                    seen[o] = s as i64;
                    queue[tail] = o;
                    tail += 1;
                }
            }
        }
        // `!(floor < SEA_LEVEL)`.
        if floor.is_nan() || floor >= SEA_LEVEL {
            continue;
        }
        let id = regions;
        regions += 1;
        let mut a = 0.0;
        for &c in &queue[..tail] {
            region[c] = id as i32;
            a += sub.area(c);
            nodes.push(c);
        }
        let mut e = 0;
        for &c in &queue[..tail] {
            let t = flow_target[c];
            if t >= 0 && seen[t as usize] != s as i64 {
                e += 1;
            }
        }
        area.push(a);
        exits.push(e.max(1));
        start.push(nodes.len());
    }
    TerminalBasins {
        count: regions,
        region,
        area,
        exits,
        start,
        nodes,
    }
}

fn basin_evaporation<S: FlowSubstrate>(
    sub: &S,
    basins: &TerminalBasins,
    temperature: &[f32],
) -> Vec<f64> {
    (0..basins.count)
        .map(|r| {
            let mut temp_sum = 0.0;
            for &c in &basins.nodes[basins.start[r]..basins.start[r + 1]] {
                temp_sum += temperature[c] as f64 * sub.area(c);
            }
            evaporation_potential(temp_sum / basins.area[r]) * basins.area[r]
        })
        .collect()
}

/// Precipitation-weighted single-flow discharge per element, with the
/// terminal basins' water balance when `temperature` is given.
pub fn accumulate_discharge_on<S: FlowSubstrate>(
    sub: &S,
    elevation: &[f32],
    precip: &[f32],
    temperature: Option<&[f32]>,
) -> Vec<f32> {
    let flow_target = sub.flow_target();
    let pop_order = sub.pop_order();
    let count = sub.count();
    let mut discharge = vec![0f32; count];
    let basins = terminal_basins(sub, elevation);
    let region = &basins.region;
    for cell in 0..count {
        if elevation[cell] as f64 <= SEA_LEVEL && region[cell] < 0 {
            continue;
        }
        discharge[cell] = (runoff_of(precip[cell] as f64) * sub.area(cell)) as f32;
    }
    let keep = temperature.map(|t| basin_evaporation(sub, &basins, t));
    let mut gathered = vec![0.0; basins.count];
    for i in (0..sub.popped_count()).rev() {
        let cell = pop_order[i] as usize;
        let r = region[cell];
        let target = flow_target[cell];
        if r >= 0 {
            let r = r as usize;
            gathered[r] += discharge[cell] as f64;
            if target >= 0 && region[target as usize] != r as i32 {
                let total = gathered[r] / basins.exits[r] as f64;
                let kept = keep.as_ref().map_or(0.0, |k| k[r] / basins.exits[r] as f64);
                if total > kept {
                    let t = target as usize;
                    discharge[t] = (discharge[t] as f64 + (total - kept)) as f32;
                }
            }
            continue;
        }
        if elevation[cell] as f64 <= SEA_LEVEL {
            continue;
        }
        if target >= 0 {
            let t = target as usize;
            discharge[t] = (discharge[t] as f64 + discharge[cell] as f64) as f32;
        }
    }
    discharge
}

/// The flow regime's climate inputs, accumulated down the receivers.
pub struct RegimeInputs {
    pub loss: Vec<f32>,
    pub dry: Vec<f32>,
}

/// The climate step's months per element, month-major.
pub struct ClimateMonths<'a> {
    pub temperature: &'a [f32],
    pub precipitation: &'a [f32],
    pub count: usize,
}

pub fn accumulate_regime_inputs_on<S: FlowSubstrate>(
    sub: &S,
    elevation: &[f32],
    temperature: &[f32],
    precip: &[f32],
    monsoon_index: Option<&[f32]>,
    months: Option<&ClimateMonths>,
) -> RegimeInputs {
    let n = sub.count();
    let mut pet = vec![0f32; n];
    let mut dry_precip = vec![0f32; n];
    let mut water = vec![0.0; months.map_or(0, |m| m.count)];
    for i in 0..n {
        let p = precip[i] as f64;
        if p == OCEAN_PRECIP || p <= 0.0 {
            continue;
        }
        pet[i] = evaporation_potential(temperature[i] as f64) as f32;
        if let Some(m) = months
            && m.count > 0
        {
            dry_precip[i] = dry_water_from_months(m, i, n, &mut water) as f32;
            continue;
        }
        let s = monsoon_index.map_or(0.0, |mi| (mi[i] as f64).abs());
        dry_precip[i] = if s < 1.0 { p * (1.0 - s) } else { 0.0 } as f32;
    }
    RegimeInputs {
        loss: accumulate_discharge_on(sub, elevation, &pet, None),
        dry: accumulate_discharge_on(sub, elevation, &dry_precip, None),
    }
}

fn dry_water_from_months(months: &ClimateMonths, i: usize, n: usize, water: &mut [f64]) -> f64 {
    let count = months.count;
    let cf = count as f64;
    let mut pack = 0.0;
    for pass in 0..2 {
        for m in 0..count {
            let t = months.temperature[m * n + i] as f64;
            let rain = js::max(0.0, months.precipitation[m * n + i] as f64) / cf;
            let mut flow = 0.0;
            if t <= 0.0 {
                pack += rain;
            } else {
                let melt = js::min(pack, SURFACE_TUNING.snow_melt_mm_per_degree_month * t);
                pack -= melt;
                flow = rain + melt;
            }
            if pass == 1 {
                water[m] = flow * cf;
            }
        }
    }
    let mut thawed: Vec<f64> = Vec::new();
    let mut all = 0.0;
    for m in 0..count {
        all += water[m] / cf;
        if months.temperature[m * n + i] > 0.0 {
            thawed.push(water[m]);
        }
    }
    if thawed.is_empty() {
        return all;
    }
    thawed.sort_by(|&a, &b| js_order(a, b));
    let k = js::min(SURFACE_TUNING.regime_dry_months, thawed.len() as f64) as usize;
    let mut sum = 0.0;
    for &v in &thawed[..k] {
        sum += v;
    }
    sum / k as f64
}

/// The largest discharge anywhere on land.
pub fn max_discharge_over_land(discharge: &[f32], elevation: &[f32]) -> f64 {
    let mut max = 0.0;
    for i in 0..discharge.len() {
        if elevation[i] as f64 > SEA_LEVEL && discharge[i] as f64 > max {
            max = discharge[i] as f64;
        }
    }
    max
}

/// The density knob (0–100) as the critical drainage area, domain units².
pub fn density_to_critical_area(density: f64, domain: &Domain) -> f64 {
    let t = &SURFACE_TUNING;
    let d = js::min(100.0, js::max(0.0, density)) / 100.0;
    let unit_m2 = domain.metres_per_unit * domain.metres_per_unit;
    (t.channel_area_max_m2 / unit_m2) * det_pow(t.channel_area_min_m2 / t.channel_area_max_m2, d)
}

pub fn channel_threshold(critical_area: f64, mean_runoff: f64) -> f64 {
    critical_area * mean_runoff
}

pub const RIVER_MIN_WIDTH: f64 = 0.4;
pub const RIVER_MAX_WIDTH: f64 = 4.0;
pub const CHANNEL_SLOPE_EXPONENT: f64 = 0.5;

/// Rise over run to the receiver, elevation units per domain unit.
pub fn receiver_slope_on<S: FlowSubstrate>(sub: &S, elevation: &[f32], cell: usize) -> f64 {
    let target = sub.flow_target()[cell];
    if target < 0 || target as usize >= sub.count() {
        return 0.0;
    }
    let distance = sub.step(cell, target as usize);
    let drop = elevation[cell] as f64 - elevation[target as usize] as f64;
    if drop > 0.0 { drop / distance } else { 0.0 }
}

/// The median slope among the elements that are channels without the
/// boost.
pub fn channel_reference_slope_on<S: FlowSubstrate>(
    sub: &S,
    elevation: &[f32],
    discharge: &[f32],
    threshold: f64,
) -> f64 {
    let mut slopes: Vec<f64> = Vec::new();
    for cell in 0..sub.count() {
        if elevation[cell] as f64 <= SEA_LEVEL || (discharge[cell] as f64) < threshold {
            continue;
        }
        slopes.push(receiver_slope_on(sub, elevation, cell));
    }
    if slopes.is_empty() {
        return 1.0;
    }
    slopes.sort_by(|&a, &b| js_order(a, b));
    let median = slopes[slopes.len() >> 1];
    if median > 0.0 { median } else { 1.0 }
}

pub fn is_channel_cell_on<S: FlowSubstrate>(
    sub: &S,
    elevation: &[f32],
    discharge: &[f32],
    cell: usize,
    threshold: f64,
    reference_slope: f64,
) -> bool {
    if elevation[cell] as f64 <= SEA_LEVEL {
        return false;
    }
    let boost = det_pow(
        js::max(receiver_slope_on(sub, elevation, cell), 1e-7) / reference_slope,
        CHANNEL_SLOPE_EXPONENT,
    );
    discharge[cell] as f64 * boost >= threshold
}

/// The channel mask, closed downstream to the water it drains into.
pub fn build_channel_mask_on<S: FlowSubstrate>(
    sub: &S,
    elevation: &[f32],
    discharge: &[f32],
    threshold: f64,
) -> Vec<u8> {
    let reference_slope = channel_reference_slope_on(sub, elevation, discharge, threshold);
    let n = sub.count();
    let mut channel: Vec<u8> = (0..n)
        .map(|c| {
            u8::from(is_channel_cell_on(
                sub,
                elevation,
                discharge,
                c,
                threshold,
                reference_slope,
            ))
        })
        .collect();
    let pop_order = sub.pop_order();
    let flow_target = sub.flow_target();
    for k in (0..sub.popped_count()).rev() {
        let cell = pop_order[k] as usize;
        if channel[cell] == 0 {
            continue;
        }
        let t = flow_target[cell];
        if t >= 0 && (t as usize) < n && elevation[t as usize] as f64 > SEA_LEVEL {
            channel[t as usize] = 1;
        }
    }
    channel
}

/// The regime as the ribbons carry it.
pub const RIVER_REGIME_PERENNIAL: u8 = 0;
pub const RIVER_REGIME_INTERMITTENT: u8 = 1;
pub const RIVER_REGIME_EPHEMERAL: u8 = 2;

/// Watershed labels per element: 1.. largest first for basins of at least
/// `min_area_km2`, 0 elsewhere.
pub fn watersheds_on<S: FlowSubstrate>(sub: &S, elevation: &[f32], min_area_km2: f64) -> Vec<u16> {
    let flow_target = sub.flow_target();
    let pop_order = sub.pop_order();
    let n = sub.count();
    let km2_per_cell =
        (sub.domain().metres_per_unit / 1000.0) * (sub.domain().metres_per_unit / 1000.0);
    let mut label = vec![-1i64; n];
    let mut next_id = 0usize;
    for &v in &pop_order[..sub.popped_count()] {
        let v = v as usize;
        if elevation[v] as f64 <= SEA_LEVEL {
            continue;
        }
        let t = flow_target[v];
        if t >= 0 && elevation[t as usize] as f64 > SEA_LEVEL && label[t as usize] >= 0 {
            label[v] = label[t as usize];
        } else {
            label[v] = next_id as i64;
            next_id += 1;
        }
    }
    let mut areas = vec![0.0; next_id];
    for v in 0..n {
        if label[v] >= 0 {
            areas[label[v] as usize] += sub.area(v) * km2_per_cell;
        }
    }
    let mut order: Vec<usize> = (0..next_id)
        .filter(|&id| areas[id] >= min_area_km2)
        .collect();
    order.sort_by(|&a, &b| js_order(areas[b], areas[a]));
    order.truncate(65535);
    let mut remap = vec![0u16; next_id];
    for (rank, &id) in order.iter().enumerate() {
        remap[id] = (rank + 1) as u16;
    }
    (0..n)
        .map(|v| {
            if label[v] >= 0 {
                remap[label[v] as usize]
            } else {
                0
            }
        })
        .collect()
}

/// The riparian moisture bonus as the precipitation it adds to, per
/// element (`precip` mm/yr, OCEAN_PRECIP on the sea).
#[allow(clippy::too_many_arguments)]
pub fn riparian_precipitation_on<S: FlowSubstrate>(
    sub: &S,
    elevation: &[f32],
    discharge: &[f32],
    threshold: f64,
    max_discharge: f64,
    lake_depth: &[f32],
    frozen: Option<&[u8]>,
    precip: &[f32],
) -> Vec<f32> {
    let t = &SURFACE_TUNING;
    let n = sub.count();
    let scale = if max_discharge > 0.0 {
        max_discharge
    } else {
        1.0
    };
    let channel = build_channel_mask_on(sub, elevation, discharge, threshold);
    let k = -det_log(t.riparian_decay) / t.riparian_decay_length_m;
    let max_reach = t.riparian_reach_m * k;
    let mut cost = vec![f64::INFINITY; n];
    let mut reach = vec![0.0; n];
    let mut heap = MinHeap::new(js::max(16.0, (n >> 4) as f64) as usize);
    for c in 0..n {
        if elevation[c] as f64 <= SEA_LEVEL {
            continue;
        }
        let mut w = 0.0;
        if lake_depth[c] > 0.0 && !frozen.is_some_and(|f| f[c] != 0) {
            w = 1.0;
        } else if channel[c] != 0 {
            w = js::min(1.0, (discharge[c] as f64 / scale).sqrt());
        }
        if w <= 0.0 {
            continue;
        }
        cost[c] = -det_log(w);
        heap.push(cost[c], c as i32);
    }
    let metres_per_unit = sub.domain().metres_per_unit;
    let mut nb: Vec<u32> = Vec::new();
    while !heap.is_empty() {
        heap.pop();
        let c = heap.popped_index as usize;
        let here = heap.popped_key;
        if here > cost[c] {
            continue;
        }
        sub.rim_neighbours(c, &mut nb);
        for &o in &nb {
            let o = o as usize;
            let step = sub.step(c, o) * metres_per_unit * k;
            if reach[c] + step > max_reach {
                continue;
            }
            let next = here + step;
            if next >= cost[o] {
                continue;
            }
            cost[o] = next;
            reach[o] = reach[c] + step;
            heap.push(next, o as i32);
        }
    }
    (0..n)
        .map(|c| {
            let p = precip[c] as f64;
            if p == OCEAN_PRECIP {
                return p as f32;
            }
            if cost[c].is_finite() {
                (p + det_exp(-cost[c]) * t.max_riparian_mm) as f32
            } else {
                p as f32
            }
        })
        .collect()
}
