//! The native build of the incubator for the Node job worker
//! (docs/decisions/incubator-history-engine.md, fork 3 B). `make engine`
//! copies it to `engine/dist/casas-incubator.node`. The same object as the
//! WASM build's (`casas-incubator-wasm`), and the same bits.

use casas_incubator::chart::{ChartPass, PeriodicTriangulation, chart_pass, level_mesh, raster};
use casas_incubator::climate_history::{ClimateHistory, ICE_REACH_KM, SEA_DROP_M};
use casas_incubator::flora::{Layer, grow_flora, populate};
use casas_incubator::habitat::{CELL_ECOLOGY, CellInput, Habitat, build_cells};
use casas_incubator::history::{
    RainChart, carrying_of, origin_of, run_history, run_history_keeping,
};
use casas_incubator::log::LogEvent;
use casas_incubator::pack::{pack_history, pack_settled};
use casas_incubator::peoples::{TRAITS, peoples_of};
use casas_incubator::peopling::{Peopling, people};
use casas_incubator::settle::settle_history;
use casas_incubator::simulation::{
    KEEP_YEARS, PEOPLE_FRAME_STEP, SPAN_YEARS, STEP_YEARS, ice_distance,
};
use napi::bindgen_prelude::{Float32Array, Float64Array, Int32Array, Uint8Array, Uint32Array};
use napi_derive::napi;

/// The incubator's version (`casas_incubator::tuning::incubator_version`).
#[napi]
pub fn version() -> String {
    casas_incubator::tuning::incubator_version()
}

/// The world's cold over the span, every STEP_YEARS.
#[napi]
pub fn cold_curve(seed: f64) -> Float32Array {
    let climate = ClimateHistory::of(seed, SPAN_YEARS);
    let steps = (SPAN_YEARS / STEP_YEARS) as usize;
    Float32Array::new(
        (0..=steps)
            .map(|k| climate.cold(k as f64 * STEP_YEARS) as f32)
            .collect(),
    )
}

#[napi]
pub fn ice_reach_km() -> f64 {
    ICE_REACH_KM
}

#[napi]
pub fn sea_drop_m() -> f64 {
    SEA_DROP_M
}

fn error(message: String) -> napi::Error {
    napi::Error::from_reason(message)
}

#[napi]
pub struct Incubator {
    habitat: Habitat,
    owners: Vec<i32>,
    flora: Vec<Layer>,
    fauna: Vec<Layer>,
    peopling: Option<Peopling>,
    debug_traits: Option<DebugTraits>,
}

// DEBUG (THE PEOPLES' measure, 2026-10-29): the traits and the people at
// each kept state of the last `debug_simulate_traits`.
struct DebugTraits {
    times: Vec<f64>,
    traits: Vec<Vec<u16>>,
    people: Vec<Vec<f32>>,
    // The replacements and splits. THE TREE is in the pack since v3
    // (pack.rs; its DEBUG reads went, 2026-10-29).
    counts: [u32; 3],
}

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

#[napi]
impl Incubator {
    /// The habitat, as the WASM build's constructor takes it.
    #[napi(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        sphere: bool,
        spacing_km: f64,
        width: f64,
        height: f64,
        nodes: Int32Array,
        node_w: u32,
        node_h: u32,
        land: Uint8Array,
        biome: Uint8Array,
        koppen: Uint8Array,
        z: Float32Array,
        lake_depth: Float32Array,
        ecology: Uint8Array,
        ecology_present: u32,
        river_points: Option<Float32Array>,
        river_lengths: Option<Uint32Array>,
        river_regimes: Option<Uint8Array>,
    ) -> Self {
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
            (Some(p), Some(l), Some(r)) => Some((&p[..], &l[..], &r[..])),
            _ => None,
        };
        let input = CellInput {
            sphere,
            spacing_km,
            width,
            height,
            nodes: &nodes,
            node_w: node_w as usize,
            node_h: node_h as usize,
            land: &land,
            biome: &biome,
            koppen: &koppen,
            z: &z,
            lake_depth: &lake_depth,
            ecology: fields,
            rivers,
        };
        let (habitat, owners) = build_cells(&input);
        Incubator {
            habitat,
            owners,
            flora: Vec::new(),
            fauna: Vec::new(),
            peopling: None,
            debug_traits: None,
        }
    }

    #[napi]
    pub fn count(&self) -> u32 {
        self.habitat.count as u32
    }

    #[napi]
    pub fn owners(&self) -> Int32Array {
        Int32Array::new(self.owners.clone())
    }

    #[napi]
    pub fn scalars(&self) -> Float64Array {
        let h = &self.habitat;
        Float64Array::new(vec![
            h.land_count as f64,
            h.landmasses as f64,
            h.radius_km,
            h.width_km,
            h.height_km,
        ])
    }

    #[napi]
    pub fn floats(&self, name: String) -> napi::Result<Float32Array> {
        let h = &self.habitat;
        Ok(Float32Array::new(match name.as_str() {
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
                    .ok_or_else(|| error(format!("no habitat array {name}")))?;
                let k = CELL_ECOLOGY
                    .iter()
                    .position(|f| *f == id)
                    .ok_or_else(|| error(format!("no ecology field {id}")))?;
                h.ecology[k]
                    .clone()
                    .ok_or_else(|| error(format!("the level holds no {id}")))?
            }
        }))
    }

    #[napi]
    pub fn bytes(&self, name: String) -> napi::Result<Uint8Array> {
        let h = &self.habitat;
        Ok(Uint8Array::new(match name.as_str() {
            "land" => h.land.clone(),
            "biome" => h.biome.clone(),
            "koppen" => h.koppen.clone(),
            "nearRiver" => h.near_river.clone(),
            "nearLake" => h.near_lake.clone(),
            "nearSea" => h.near_sea.clone(),
            _ => return Err(error(format!("no habitat array {name}"))),
        }))
    }

    #[napi]
    pub fn ints(&self, name: String) -> napi::Result<Int32Array> {
        let h = &self.habitat;
        Ok(Int32Array::new(match name.as_str() {
            "landmass" => h.landmass.clone(),
            "nbrStart" => h.nbr_start.iter().map(|&x| x as i32).collect(),
            "nbr" => h.nbr.iter().map(|&x| x as i32).collect(),
            _ => return Err(error(format!("no habitat array {name}"))),
        }))
    }

    #[napi]
    pub fn landmass_km2(&self) -> Float64Array {
        Float64Array::new(self.habitat.landmass_km2.clone())
    }

    #[napi]
    pub fn ice_km(&self) -> Float32Array {
        Float32Array::new(ice_distance(&self.habitat))
    }

    #[napi]
    pub fn origin_of(&self) -> i32 {
        origin_of(&self.habitat, &carrying_of(&self.habitat))
    }

    #[napi]
    pub fn grow_flora(&mut self, seed: f64) {
        let (plants, trees) = grow_flora(&self.habitat, seed);
        self.flora = plants.into_iter().chain(trees).collect();
    }

    #[napi]
    pub fn populate(&mut self, seed: f64) {
        self.fauna = populate(&self.habitat, seed);
    }

    #[napi]
    pub fn flora_codes(&self) -> Uint8Array {
        Uint8Array::new(codes_of(&self.flora))
    }
    #[napi]
    pub fn flora_shares(&self) -> Float64Array {
        Float64Array::new(shares_of(&self.flora))
    }
    #[napi]
    pub fn fauna_codes(&self) -> Uint8Array {
        Uint8Array::new(codes_of(&self.fauna))
    }
    #[napi]
    pub fn fauna_shares(&self) -> Float64Array {
        Float64Array::new(shares_of(&self.fauna))
    }

    /// The history, packed (the H1 artifact's bytes), as the WASM build's
    /// `simulate` gives it; no progress here.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn simulate(
        &self,
        origin: i32,
        seed: f64,
        rain_width: u32,
        rain_height: u32,
        variability: Option<Float32Array>,
        enso: Option<Float32Array>,
        enso_strength: f64,
    ) -> napi::Result<Uint8Array> {
        if self.flora.is_empty() || self.fauna.is_empty() {
            return Err(error(
                "the history needs the flora and the fauna first".into(),
            ));
        }
        let rain = match (&variability, &enso) {
            (Some(v), Some(e)) => Some(RainChart {
                width: rain_width as usize,
                height: rain_height as usize,
                variability: v,
                enso: e,
                enso_strength,
            }),
            _ => None,
        };
        let result = run_history(
            &self.habitat,
            &self.flora,
            &self.fauna,
            origin,
            seed,
            rain.as_ref(),
            None,
        );
        Ok(Uint8Array::new(pack_history(&result)))
    }

    /// DEBUG: `simulate`, keeping the traits and the people at each kept
    /// state for `debug_peoples`. Not used by the job worker.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn debug_simulate_traits(
        &mut self,
        origin: i32,
        seed: f64,
        rain_width: u32,
        rain_height: u32,
        variability: Option<Float32Array>,
        enso: Option<Float32Array>,
        enso_strength: f64,
    ) -> napi::Result<Uint8Array> {
        let rain = match (&variability, &enso) {
            (Some(v), Some(e)) => Some(RainChart {
                width: rain_width as usize,
                height: rain_height as usize,
                variability: v,
                enso: e,
                enso_strength,
            }),
            _ => None,
        };
        let result = run_history_keeping(
            &self.habitat,
            &self.flora,
            &self.fauna,
            origin,
            seed,
            rain.as_ref(),
            None,
            true,
        );
        let mut times: Vec<f64> = (0..result.kept.len())
            .map(|k| result.start + k as f64 * KEEP_YEARS)
            .collect();
        if let Some(last) = times.last_mut() {
            *last = last.min(result.end);
        }
        let people = result
            .kept
            .iter()
            .map(|f| {
                f.people
                    .iter()
                    .map(|&p| (p as f64 * PEOPLE_FRAME_STEP) as f32)
                    .collect()
            })
            .collect();
        let packed = pack_history(&result);
        self.debug_traits = Some(DebugTraits {
            times,
            traits: result.trait_frames,
            people,
            counts: [result.replaced, result.herd_replaced, result.splits],
        });
        Ok(Uint8Array::new(packed))
    }

    /// DEBUG: the kept states' times of `debug_simulate_traits`.
    #[napi]
    pub fn debug_trait_times(&self) -> Float64Array {
        Float64Array::new(
            self.debug_traits
                .as_ref()
                .map(|d| d.times.clone())
                .unwrap_or_default(),
        )
    }

    /// DEBUG: the traits (TRAITS a cell, 0 … 1) and the people a km² at
    /// kept state `frame`.
    #[napi]
    pub fn debug_traits(&self, frame: u32) -> napi::Result<Float32Array> {
        let d = self
            .debug_traits
            .as_ref()
            .ok_or_else(|| error("no debug_simulate_traits yet".into()))?;
        let f = d
            .traits
            .get(frame as usize)
            .ok_or_else(|| error(format!("no frame {frame}")))?;
        Ok(Float32Array::new(
            f.iter().map(|&x| x as f32 / 65535.0).collect(),
        ))
    }

    #[napi]
    pub fn debug_people(&self, frame: u32) -> napi::Result<Float32Array> {
        let d = self
            .debug_traits
            .as_ref()
            .ok_or_else(|| error("no debug_simulate_traits yet".into()))?;
        let f = d
            .people
            .get(frame as usize)
            .ok_or_else(|| error(format!("no frame {frame}")))?;
        Ok(Float32Array::new(f.clone()))
    }

    /// DEBUG: the peoples at kept state `frame` (peoples.rs peoples_of):
    /// each cell's, -1 where no one lives.
    #[napi]
    pub fn debug_peoples(&self, frame: u32, distance: f64) -> napi::Result<Int32Array> {
        let values: Vec<f32> = self.debug_traits(frame)?.to_vec();
        let people: Vec<f32> = self.debug_people(frame)?.to_vec();
        debug_assert_eq!(values.len(), people.len() * TRAITS);
        let (label, _) = peoples_of(
            &self.habitat.nbr_start,
            &self.habitat.nbr,
            &values,
            &people,
            distance,
        );
        Ok(Int32Array::new(label))
    }

    /// DEBUG: the cells whose traits the fields replaced, the herds', and
    /// the branches' splits (peoples.rs).
    #[napi]
    pub fn debug_people_counts(&self) -> Uint32Array {
        Uint32Array::new(
            self.debug_traits
                .as_ref()
                .map(|d| d.counts.to_vec())
                .unwrap_or_default(),
        )
    }

    /// Step 1 of the prehistory (peopling.rs) from the given origins, kept
    /// for the `peopling_*` reads; its span in years.
    #[napi]
    pub fn people(&mut self, origins: Int32Array, seed: f64) -> f64 {
        let origins: Vec<usize> = origins.iter().map(|&o| o as usize).collect();
        let p = people(&self.habitat, &carrying_of(&self.habitat), &origins, seed);
        let span = p.span;
        self.peopling = Some(p);
        span
    }

    #[napi]
    pub fn peopling_floats(&self, name: String) -> napi::Result<Float32Array> {
        let p = self
            .peopling
            .as_ref()
            .ok_or_else(|| error("no peopling yet".into()))?;
        Ok(Float32Array::new(match name.as_str() {
            "arrival" => p.arrival.clone(),
            "density" => p.density.clone(),
            _ => return Err(error(format!("no peopling array {name}"))),
        }))
    }

    #[napi]
    pub fn peopling_ints(&self, name: String) -> napi::Result<Int32Array> {
        let p = self
            .peopling
            .as_ref()
            .ok_or_else(|| error("no peopling yet".into()))?;
        Ok(Int32Array::new(match name.as_str() {
            "from" => p.from.clone(),
            "root" => p.root.clone(),
            "group" => p.group.clone(),
            _ => return Err(error(format!("no peopling array {name}"))),
        }))
    }

    /// The landings after open sea: [at, cell, landmass, km] each.
    #[napi]
    pub fn peopling_landings(&self) -> napi::Result<Float64Array> {
        let p = self
            .peopling
            .as_ref()
            .ok_or_else(|| error("no peopling yet".into()))?;
        Ok(Float64Array::new(
            p.log
                .iter()
                .flat_map(|e| match *e {
                    LogEvent::Crossing {
                        at,
                        cell,
                        landmass,
                        km,
                        ..
                    } => vec![at, cell, landmass, km],
                    _ => vec![],
                })
                .collect(),
        ))
    }

    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn settle_history(
        &self,
        arrival: Float32Array,
        farm_at: Float32Array,
        herd_at: Float32Array,
        villages: Int32Array,
        village_from: Float32Array,
        village_to: Float32Array,
        village_town: Float32Array,
        end: f64,
    ) -> Uint8Array {
        Uint8Array::new(pack_settled(&settle_history(
            &self.habitat,
            &arrival,
            &farm_at,
            &herd_at,
            &villages,
            &village_from,
            &village_to,
            &village_town,
            end,
        )))
    }
}

/// Level 1's chart (chart.rs), as the WASM build's.
#[napi]
pub struct Chart {
    mesh: PeriodicTriangulation,
    pass: Option<ChartPass>,
}

#[napi]
impl Chart {
    #[napi(constructor)]
    pub fn new(
        sphere: bool,
        width: f64,
        height: f64,
        count: u32,
        nodes: Float32Array,
        connectivity: Uint8Array,
    ) -> napi::Result<Chart> {
        let mesh = level_mesh(sphere, width, height, count as usize, &nodes, &connectivity)
            .map_err(error)?;
        Ok(Chart { mesh, pass: None })
    }

    #[napi]
    pub fn raster(&mut self, z: Float32Array, w: u32, h: u32) -> Float32Array {
        Float32Array::new(raster(&mut self.mesh, &z, w as usize, h as usize))
    }

    #[napi]
    pub fn pass(&mut self, z: Float32Array, land: Uint8Array, biome: Uint8Array, w: u32, h: u32) {
        self.pass = Some(chart_pass(
            &mut self.mesh,
            &z,
            &land,
            &biome,
            w as usize,
            h as usize,
        ));
    }

    #[napi]
    pub fn take_elevation(&mut self) -> Float32Array {
        Float32Array::new(
            self.pass
                .as_mut()
                .map(|p| std::mem::take(&mut p.elevation))
                .unwrap_or_default(),
        )
    }

    #[napi]
    pub fn take_biome(&mut self) -> Uint8Array {
        Uint8Array::new(
            self.pass
                .as_mut()
                .map(|p| std::mem::take(&mut p.biome))
                .unwrap_or_default(),
        )
    }

    #[napi]
    pub fn take_nodes(&mut self) -> Int32Array {
        Int32Array::new(
            self.pass
                .as_mut()
                .map(|p| std::mem::take(&mut p.nodes))
                .unwrap_or_default(),
        )
    }
}
