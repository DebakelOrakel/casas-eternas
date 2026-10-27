//! The WASM build of the incubator for the browser
//! (docs/decisions/incubator-history-engine.md, fork 3). `make engine` runs
//! wasm-bindgen over it into `engine/dist/incubator/`. One object, the
//! incubator's worker's state: the habitat made once a world, then what is
//! grown and run on it.

use casas_incubator::climate_history::{ClimateHistory, ICE_REACH_KM, SEA_DROP_M};
use casas_incubator::flora::{Layer, grow_flora, populate};
use casas_incubator::habitat::{CELL_ECOLOGY, CellInput, Habitat, build_cells};
use casas_incubator::history::{RainChart, carrying_of, origin_of, run_history};
use casas_incubator::pack::{pack_history, pack_settled};
use casas_incubator::settle::settle_history;
use casas_incubator::simulation::{SPAN_YEARS, STEP_YEARS, SimulationResult, ice_distance};
use wasm_bindgen::prelude::*;

/// The incubator's version (`casas_incubator::tuning::incubator_version`).
#[wasm_bindgen]
pub fn version() -> String {
    casas_incubator::tuning::incubator_version()
}

/// The world's cold over the span (climate_history.rs), every STEP_YEARS
/// from the departure, for the chronicle and the ice's overlay.
#[wasm_bindgen(js_name = coldCurve)]
pub fn cold_curve(seed: f64) -> Vec<f32> {
    let climate = ClimateHistory::of(seed, SPAN_YEARS);
    let steps = (SPAN_YEARS / STEP_YEARS) as usize;
    (0..=steps)
        .map(|k| climate.cold(k as f64 * STEP_YEARS) as f32)
        .collect()
}

/// How far the ice reaches from today's glaciers at a cold of 1, km; how
/// far the sea then stands below today's, m.
#[wasm_bindgen(js_name = iceReachKm)]
pub fn ice_reach_km() -> f64 {
    ICE_REACH_KM
}
#[wasm_bindgen(js_name = seaDropM)]
pub fn sea_drop_m() -> f64 {
    SEA_DROP_M
}

#[wasm_bindgen]
pub struct Incubator {
    habitat: Habitat,
    owners: Vec<i32>,
    // The plants and the trees, the animals, in the catalog's order.
    flora: Vec<Layer>,
    fauna: Vec<Layer>,
    // The history run last.
    history: Option<SimulationResult>,
}

/// The layers' codes one after the other, and their shares of the land
/// ([suitable, reached, empty] a layer).
fn codes_of(layers: &[Layer]) -> Vec<u8> {
    layers
        .iter()
        .flat_map(|l| l.codes.iter().copied())
        .collect()
}
fn shares_of(layers: &[Layer]) -> Vec<f64> {
    layers
        .iter()
        .flat_map(|l| [l.suitable, l.reached, l.empty])
        .collect()
}

#[wasm_bindgen]
impl Incubator {
    /// The habitat (habitat.rs build_cells). `ecology`: CELL_ECOLOGY's
    /// fields' fine codes, one after the other, those whose bit is set in
    /// `ecology_present`; the rivers' three arrays, or none.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        sphere: bool,
        spacing_km: f64,
        width: f64,
        height: f64,
        nodes: &[i32],
        node_w: usize,
        node_h: usize,
        land: &[u8],
        biome: &[u8],
        koppen: &[u8],
        z: &[f32],
        lake_depth: &[f32],
        ecology: &[u8],
        ecology_present: u32,
        river_points: Option<Vec<f32>>,
        river_lengths: Option<Vec<u32>>,
        river_regimes: Option<Vec<u8>>,
    ) -> Incubator {
        let nodes_count = land.len();
        let mut fields: [Option<&[u8]>; 8] = [None; 8];
        let mut at = 0;
        for (k, field) in fields.iter_mut().enumerate() {
            if ecology_present & (1 << k) != 0 {
                *field = Some(&ecology[at..at + nodes_count]);
                at += nodes_count;
            }
        }
        let rivers = match (&river_points, &river_lengths, &river_regimes) {
            (Some(p), Some(l), Some(r)) => Some((p.as_slice(), l.as_slice(), r.as_slice())),
            _ => None,
        };
        let input = CellInput {
            sphere,
            spacing_km,
            width,
            height,
            nodes,
            node_w,
            node_h,
            land,
            biome,
            koppen,
            z,
            lake_depth,
            ecology: fields,
            rivers,
        };
        let (habitat, owners) = build_cells(&input);
        Incubator {
            habitat,
            owners,
            flora: Vec::new(),
            fauna: Vec::new(),
            history: None,
        }
    }

    /// The plants, then the trees (flora.rs grow_flora), kept.
    #[wasm_bindgen(js_name = growFlora)]
    pub fn grow_flora(&mut self, seed: f64) {
        let (plants, trees) = grow_flora(&self.habitat, seed);
        self.flora = plants.into_iter().chain(trees).collect();
    }

    /// The animals (flora.rs populate), kept.
    pub fn populate(&mut self, seed: f64) {
        self.fauna = populate(&self.habitat, seed);
    }

    /// The flora's codes, a layer after the other (`count` each), and its
    /// shares; the fauna's.
    #[wasm_bindgen(js_name = floraCodes)]
    pub fn flora_codes(&self) -> Vec<u8> {
        codes_of(&self.flora)
    }
    #[wasm_bindgen(js_name = floraShares)]
    pub fn flora_shares(&self) -> Vec<f64> {
        shares_of(&self.flora)
    }
    #[wasm_bindgen(js_name = faunaCodes)]
    pub fn fauna_codes(&self) -> Vec<u8> {
        codes_of(&self.fauna)
    }
    #[wasm_bindgen(js_name = faunaShares)]
    pub fn fauna_shares(&self) -> Vec<f64> {
        shares_of(&self.fauna)
    }

    pub fn count(&self) -> usize {
        self.habitat.count
    }

    pub fn owners(&self) -> Vec<i32> {
        self.owners.clone()
    }

    /// The habitat's numbers: the land's cells, the landmasses, the globe's
    /// radius, the torus's width and height (km).
    pub fn scalars(&self) -> Vec<f64> {
        let h = &self.habitat;
        vec![
            h.land_count as f64,
            h.landmasses as f64,
            h.radius_km,
            h.width_km,
            h.height_km,
        ]
    }

    /// A habitat array by its TypeScript name (habitat.ts), as floats;
    /// `eco:<id>` for an ecology field.
    pub fn floats(&self, name: &str) -> Result<Vec<f32>, JsError> {
        let h = &self.habitat;
        Ok(match name {
            "areaKm2" => h.area_km2.clone(),
            "heightM" => h.height_m.clone(),
            "slope" => h.slope.clone(),
            "seaDepthM" => h.sea_depth_m.clone(),
            "riverSize" => h.river_size.clone(),
            "distKm" => h.dist_km.clone(),
            "u" => h.u.clone(),
            "v" => h.v.clone(),
            _ => {
                let id = name
                    .strip_prefix("eco:")
                    .ok_or_else(|| JsError::new(&format!("no habitat array {name}")))?;
                let k = CELL_ECOLOGY
                    .iter()
                    .position(|f| *f == id)
                    .ok_or_else(|| JsError::new(&format!("no ecology field {id}")))?;
                h.ecology[k]
                    .clone()
                    .ok_or_else(|| JsError::new(&format!("the level holds no {id}")))?
            }
        })
    }

    pub fn bytes(&self, name: &str) -> Result<Vec<u8>, JsError> {
        let h = &self.habitat;
        Ok(match name {
            "land" => h.land.clone(),
            "biome" => h.biome.clone(),
            "koppen" => h.koppen.clone(),
            "nearRiver" => h.near_river.clone(),
            "nearLake" => h.near_lake.clone(),
            "nearSea" => h.near_sea.clone(),
            _ => return Err(JsError::new(&format!("no habitat array {name}"))),
        })
    }

    pub fn ints(&self, name: &str) -> Result<Vec<i32>, JsError> {
        let h = &self.habitat;
        Ok(match name {
            "landmass" => h.landmass.clone(),
            "nbrStart" => h.nbr_start.iter().map(|&x| x as i32).collect(),
            "nbr" => h.nbr.iter().map(|&x| x as i32).collect(),
            _ => return Err(JsError::new(&format!("no habitat array {name}"))),
        })
    }

    /// The history (history.rs run_history) from `origin` (-1: chosen), on
    /// the flora and the fauna grown, the rain's reliability charted
    /// `rain_width` × `rain_height` (none: no droughts); `progress` called
    /// with the share done. Kept; its packed bytes (pack.rs, the H1
    /// artifact's).
    #[allow(clippy::too_many_arguments)]
    pub fn simulate(
        &mut self,
        origin: i32,
        seed: f64,
        rain_width: usize,
        rain_height: usize,
        variability: Option<Vec<f32>>,
        enso: Option<Vec<f32>>,
        enso_strength: f64,
        progress: Option<js_sys::Function>,
    ) -> Result<Vec<u8>, JsError> {
        if self.flora.is_empty() || self.fauna.is_empty() {
            return Err(JsError::new(
                "the history needs the flora and the fauna first",
            ));
        }
        let rain = match (&variability, &enso) {
            (Some(v), Some(e)) => Some(RainChart {
                width: rain_width,
                height: rain_height,
                variability: v,
                enso: e,
                enso_strength,
            }),
            _ => None,
        };
        let mut report = |share: f64| {
            if let Some(p) = &progress {
                let _ = p.call1(&JsValue::NULL, &JsValue::from_f64(share));
            }
        };
        let (plants_and_trees, animals) = (&self.flora, &self.fauna);
        let result = run_history(
            &self.habitat,
            plants_and_trees,
            animals,
            origin,
            seed,
            rain.as_ref(),
            Some(&mut report),
        );
        let bytes = pack_history(&result);
        self.history = Some(result);
        Ok(bytes)
    }

    /// A history's settlement (settle.rs settle_history) on its spread,
    /// its fields' and herds' times and its villages and camps; packed
    /// (pack.rs pack_settled).
    #[wasm_bindgen(js_name = settleHistory)]
    pub fn settle_history(
        &self,
        arrival: &[f32],
        farm_at: &[f32],
        herd_at: &[f32],
        villages: &[i32],
        village_from: &[f32],
        village_to: &[f32],
    ) -> Vec<u8> {
        pack_settled(&settle_history(
            &self.habitat,
            arrival,
            farm_at,
            herd_at,
            villages,
            village_from,
            village_to,
        ))
    }

    /// Each cell's distance from today's glaciers over the cold climates,
    /// km (simulation.rs ice_distance).
    #[wasm_bindgen(js_name = iceKm)]
    pub fn ice_km(&self) -> Vec<f32> {
        ice_distance(&self.habitat)
    }

    /// The origin a history takes when none is given (history.rs
    /// origin_of).
    #[wasm_bindgen(js_name = originOf)]
    pub fn origin_of(&self) -> i32 {
        origin_of(&self.habitat, &carrying_of(&self.habitat))
    }

    #[wasm_bindgen(js_name = landmassKm2)]
    pub fn landmass_km2(&self) -> Vec<f64> {
        self.habitat.landmass_km2.clone()
    }
}
