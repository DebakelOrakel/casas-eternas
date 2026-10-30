//! The water under the ground as a classification — one permeability per
//! node, the regime re-judged with the baseflow, the springs and oases,
//! and the water table's depth. The TypeScript port
//! (`client/src/generator/surface/hydrogeology.ts`, git history)
//! explains each rule.

use crate::climate::precipitation::OCEAN_PRECIP;
use crate::core::js;
use crate::elevation::elevation_scale::{ELEVATION_METERS, SEA_LEVEL};
use crate::mesh::mesh_column::{COLUMN_DEPTH, COLUMN_VALUES, SedimentColumn};

use super::flow_substrate::FlowSubstrate;
use super::hydrology::{RegimeInputs, evaporation_potential};
use super::river_graph::{RiverGraph, RiverRegime};
use super::surface_tune_params::SURFACE_TUNING;

#[derive(Clone, Debug, PartialEq)]
pub struct SpringFeature {
    pub id: usize,
    pub cell: usize,
    pub x: f64,
    pub y: f64,
    /// Elevation units.
    pub elevation: f64,
    pub oasis: bool,
}

pub struct HydrogeologyInputs<'a, S: FlowSubstrate> {
    pub sub: &'a S,
    pub elevation: &'a [f32],
    pub column: Option<&'a SedimentColumn>,
    pub hardness: Option<&'a [f32]>,
    pub precipitation: &'a [f32],
    pub temperature: &'a [f32],
    pub monsoon_index: Option<&'a [f32]>,
    pub cover: &'a [f32],
    pub regime: &'a RegimeInputs,
    pub discharge: &'a [f32],
    /// Metres per substrate unit of distance.
    pub cell_m: f64,
}

#[derive(Clone, Debug)]
pub struct HydrogeologyResult {
    pub permeability: Vec<f32>,
    pub water_table_depth_m: Vec<f32>,
    pub springs: Vec<SpringFeature>,
}

const COARSE: usize = 1;
const FINE: usize = 0;

/// The top material at a node: [permeability, the permeable top's
/// thickness in metres, 1 when it is coarse, the permeability below].
fn top_material(column: Option<&SedimentColumn>, v: usize, bedrock: f64) -> [f64; 4] {
    let t = &SURFACE_TUNING;
    if let Some(column) = column {
        let base = v * COLUMN_DEPTH;
        for layer in (0..column.epochs.len()).rev() {
            let at = base + layer * COLUMN_VALUES;
            let coarse = column.data[at + COARSE] as f64;
            let fine = column.data[at + FINE] as f64;
            if coarse + fine < t.hydrogeology_layer_min_m {
                continue;
            }
            let mut out = if coarse >= fine {
                [t.permeability_coarse, coarse, 1.0, bedrock]
            } else {
                [t.permeability_fine, fine, 0.0, bedrock]
            };
            for below in (0..layer).rev() {
                let b = base + below * COLUMN_VALUES;
                let c2 = column.data[b + COARSE] as f64;
                let f2 = column.data[b + FINE] as f64;
                if c2 + f2 < t.hydrogeology_layer_min_m {
                    continue;
                }
                out[3] = if c2 >= f2 {
                    t.permeability_coarse
                } else {
                    t.permeability_fine
                };
                break;
            }
            return out;
        }
    }
    [bedrock, 0.0, 0.0, bedrock]
}

/// The hydrogeology over the graph; re-judges the graph's regimes and
/// sets its springs.
pub fn compute_hydrogeology<S: FlowSubstrate>(
    input: &HydrogeologyInputs<'_, S>,
    graph: &mut RiverGraph,
) -> HydrogeologyResult {
    let sub = input.sub;
    let elevation = input.elevation;
    let precipitation = input.precipitation;
    let flow_target = sub.flow_target();
    let pop_order = sub.pop_order();
    let popped = sub.popped_count();
    let n = sub.count();
    let t = &SURFACE_TUNING;
    let land = |c: usize| elevation[c] as f64 > SEA_LEVEL;
    let mut permeability = vec![0f32; n];
    let mut top_thickness_m = vec![0f32; n];
    let mut top_is_coarse = vec![0u8; n];
    let mut below_permeability = vec![0f32; n];
    let mut infiltration = vec![0f32; n];
    for c in 0..n {
        if !land(c) {
            continue;
        }
        let hard = input.hardness.map_or(1.0, |h| h[c] as f64);
        let bedrock = js::min(
            t.permeability_bedrock_max,
            js::max(
                t.permeability_bedrock_min,
                t.permeability_bedrock / js::max(0.25, hard),
            ),
        );
        let mat = top_material(input.column, c, bedrock);
        permeability[c] = mat[0] as f32;
        top_thickness_m[c] = mat[1] as f32;
        top_is_coarse[c] = mat[2] as u8;
        below_permeability[c] = mat[3] as f32;
        let cv = input.cover[c] as f64;
        infiltration[c] = js::min(
            t.infiltration_max,
            mat[0] * (t.infiltration_bare + (1.0 - t.infiltration_bare) * cv),
        ) as f32;
    }

    // The baseflow and the dry season's quick runoff over the catchment.
    let mut base = vec![0f32; n];
    let mut dry_quick = vec![0f32; n];
    for c in 0..n {
        if !land(c) {
            continue;
        }
        let p = precipitation[c] as f64;
        if p == OCEAN_PRECIP || p <= 0.0 {
            continue;
        }
        let s = input.monsoon_index.map_or(0.0, |m| (m[c] as f64).abs());
        let dry = if s < 1.0 { p * (1.0 - s) } else { 0.0 };
        let area = sub.area(c);
        let inf = infiltration[c] as f64;
        base[c] = (p * inf * area) as f32;
        dry_quick[c] = (dry * (1.0 - inf) * area) as f32;
    }
    for i in (0..popped).rev() {
        let c = pop_order[i] as usize;
        let tg = flow_target[c];
        if tg < 0 || !land(c) {
            continue;
        }
        let tg = tg as usize;
        base[tg] = (base[tg] as f64 + base[c] as f64) as f32;
        dry_quick[tg] = (dry_quick[tg] as f64 + dry_quick[c] as f64) as f32;
    }

    // The channels: every reach cell, mapped to its reach.
    let mut reach_of = vec![-1i32; n];
    for r in &graph.reaches {
        for k in r.cell_start..r.cell_start + r.cell_count {
            reach_of[graph.cells[k] as usize] = r.id as i32;
        }
    }

    // Springs.
    let mut springs: Vec<SpringFeature> = Vec::new();
    let mut nbrs: Vec<u32> = Vec::with_capacity(64);
    for c in 0..n {
        if !land(c) || reach_of[c] >= 0 {
            continue;
        }
        if top_is_coarse[c] == 0
            || (permeability[c] as f64) < t.spring_permeable_above
            || below_permeability[c] as f64 > t.spring_sealed_below
        {
            continue;
        }
        if (base[c] as f64) < t.spring_min_baseflow {
            continue;
        }
        let contact = elevation[c] as f64 - top_thickness_m[c] as f64 / ELEVATION_METERS;
        nbrs.clear();
        sub.facet_neighbours(c, &mut nbrs);
        if !nbrs
            .iter()
            .any(|&k| (elevation[k as usize] as f64) < contact)
        {
            continue;
        }
        let p = precipitation[c] as f64;
        let pet = evaporation_potential(input.temperature[c] as f64);
        let oasis = pet > 0.0 && p > 0.0 && p / pet < t.regime_arid_below;
        springs.push(SpringFeature {
            id: springs.len(),
            cell: c,
            x: sub.x(c),
            y: sub.y(c),
            elevation: elevation[c] as f64,
            oasis,
        });
    }

    // Spring-fed reaches, and the regime re-judged with the baseflow.
    let mut out_of: Vec<Vec<usize>> = vec![Vec::new(); graph.nodes.len()];
    for r in &graph.reaches {
        out_of[r.from].push(r.id);
    }
    let mut spring_fed = vec![false; graph.reaches.len()];
    for s in &springs {
        let mut c = s.cell as i32;
        let mut guard = 0;
        while c >= 0 && reach_of[c as usize] < 0 {
            guard += 1;
            if guard >= n {
                break;
            }
            c = flow_target[c as usize];
        }
        if c < 0 || reach_of[c as usize] < 0 {
            continue;
        }
        let mut id = reach_of[c as usize];
        let mut steps = 0;
        while id >= 0 && !spring_fed[id as usize] {
            steps += 1;
            if steps > graph.reaches.len() {
                break;
            }
            spring_fed[id as usize] = true;
            id = out_of[graph.reaches[id as usize].to]
                .first()
                .map_or(-1, |&r| r as i32);
        }
    }
    for r in &mut graph.reaches {
        let last = graph.cells[r.cell_start + r.cell_count - 2] as usize;
        r.runoff_out = dry_quick[last] as f64 + base[last] as f64;
        r.spring_fed = spring_fed[r.id];
        r.regime = classify_regime_with_baseflow(
            r.spring_fed,
            input.discharge[last] as f64,
            input.regime.loss[last] as f64,
            r.runoff_out,
        );
    }
    graph.springs = Some(springs.clone());

    // The water table, receivers first.
    let filled = sub.filled();
    let mut depth = vec![-1f32; n];
    let mut dist_m = vec![0f32; n];
    let mut head_z = vec![0f32; n];
    for i in 0..popped {
        let c = pop_order[i] as usize;
        let tg = flow_target[c];
        let at_water =
            !land(c) || reach_of[c] >= 0 || filled[c] as f64 > elevation[c] as f64 + 1e-6;
        if at_water || tg < 0 {
            dist_m[c] = 0.0;
            head_z[c] = elevation[c];
            depth[c] = if land(c) { 0.0 } else { -1.0 };
            continue;
        }
        let tg = tg as usize;
        dist_m[c] = (dist_m[tg] as f64 + sub.step(c, tg) * input.cell_m) as f32;
        head_z[c] = head_z[tg];
        let p = js::max(0.0, precipitation[c] as f64);
        let recharge = js::min(t.aquifer_recharge_cap, p / t.aquifer_recharge_ref_mm);
        let rise = t.aquifer_rise_base
            * (1.0 - t.aquifer_rise_permeable_drop * permeability[c] as f64)
            * recharge;
        let table_z = head_z[c] as f64 + (rise * dist_m[c] as f64) / ELEVATION_METERS;
        depth[c] = js::max(0.0, (elevation[c] as f64 - table_z) * ELEVATION_METERS) as f32;
    }
    HydrogeologyResult {
        permeability,
        water_table_depth_m: depth,
        springs,
    }
}

/// The regime with the ground's word: a spring-fed reach is perennial, the
/// dry season is judged on its quick runoff plus the baseflow.
pub fn classify_regime_with_baseflow(
    spring_fed: bool,
    discharge: f64,
    loss: f64,
    dry_flow: f64,
) -> RiverRegime {
    if spring_fed || loss <= 0.0 {
        return RiverRegime::Perennial;
    }
    if discharge / loss < SURFACE_TUNING.regime_arid_below {
        return RiverRegime::Ephemeral;
    }
    if dry_flow / loss < SURFACE_TUNING.regime_dry_season_below {
        return RiverRegime::Intermittent;
    }
    RiverRegime::Perennial
}

/// The invariants: check name and violations, in the TypeScript order.
pub fn hydrogeology_invariants(
    result: &HydrogeologyResult,
    graph: &RiverGraph,
    elevation: &[f32],
) -> Vec<(&'static str, usize)> {
    let mut channel = vec![false; elevation.len()];
    for &c in &graph.cells {
        channel[c as usize] = true;
    }
    let on_water = result
        .springs
        .iter()
        .filter(|s| elevation[s.cell] as f64 <= SEA_LEVEL)
        .count();
    let on_channel = result.springs.iter().filter(|s| channel[s.cell]).count();
    let ephemeral = graph
        .reaches
        .iter()
        .filter(|r| r.spring_fed && r.regime == RiverRegime::Ephemeral)
        .count();
    let out_of_range = result
        .water_table_depth_m
        .iter()
        .filter(|&&d| d != -1.0 && !(d >= 0.0 && d.is_finite()))
        .count();
    vec![
        ("springOnWater", on_water),
        ("springOnChannel", on_channel),
        ("ephemeralSpringFed", ephemeral),
        ("tableOutOfRange", out_of_range),
    ]
}
