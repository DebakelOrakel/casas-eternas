//! The WASM build of the engine for the browser. `make engine` runs
//! wasm-bindgen over it into `engine/dist/wasm/`. It wraps
//! `casas-engine-api` one for one (docs/decisions/rust-engine.md, fork 6).

mod tree;

use casas_engine_api::{EraError, Value};
use tree::{from_js, to_js};
use wasm_bindgen::prelude::*;

/// The engine's crate version.
#[wasm_bindgen]
pub fn version() -> String {
    casas_engine_api::version().to_string()
}

fn era(e: EraError) -> JsError {
    JsError::new(&e.0)
}

/// A value given as null or undefined as none.
fn given(v: &Value) -> Option<&Value> {
    (!matches!(v, Value::Null)).then_some(v)
}

/// A world in the engine.
#[wasm_bindgen]
pub struct World(casas_engine_api::World);

#[wasm_bindgen]
impl World {
    /// A new world in its Archean; `shape` "torus" or "sphere".
    pub fn genesis(
        seed: &str,
        width: u32,
        height: u32,
        shape: &str,
        diffusion: f64,
        land_share: f64,
    ) -> Result<World, JsError> {
        Ok(World(casas_engine_api::World::genesis(
            seed,
            width,
            height,
            shape_of(shape)?,
            diffusion,
            land_share,
        )))
    }

    #[wasm_bindgen(js_name = archeanStep)]
    pub fn archean_step(&mut self) -> Result<(), JsError> {
        self.0.archean_step().map_err(era)
    }

    #[wasm_bindgen(js_name = setArcheanControls)]
    pub fn set_archean_controls(&mut self, diffusion: f64, land_share: f64) {
        self.0.set_archean_controls(diffusion, land_share);
    }

    #[wasm_bindgen(getter, js_name = archeanEpoch)]
    pub fn archean_epoch(&self) -> Result<f64, JsError> {
        self.0.archean_epoch().map_err(era)
    }

    pub fn mantle(&self) -> Vec<f64> {
        self.0.mantle()
    }

    #[wasm_bindgen(getter, js_name = raftCount)]
    pub fn raft_count(&self) -> u32 {
        self.0.raft_count()
    }

    pub fn finalize(&mut self) -> Result<(), JsError> {
        self.0.finalize().map_err(era)
    }

    /// One coupled epoch under the history's controls; its events.
    pub fn epoch(&mut self, controls: &JsValue) -> Result<JsValue, JsError> {
        self.0.epoch(&from_js(controls)?).map(to_js).map_err(era)
    }

    /// The Archean as the save holds it: { snapshot, mantle, streak }.
    #[wasm_bindgen(js_name = archeanSave)]
    pub fn archean_save(&self) -> Result<JsValue, JsError> {
        self.0.archean_save().map(to_js).map_err(era)
    }

    /// A world restored in its Archean.
    #[wasm_bindgen(js_name = restoreArchean)]
    pub fn restore_archean(
        shape: &str,
        snapshot: &JsValue,
        mantle: &JsValue,
        streak: &[i16],
        diffusion: f64,
        land_share: f64,
    ) -> Result<World, JsError> {
        let mantle = from_js(mantle)?;
        casas_engine_api::World::restore_archean(
            shape_of(shape)?,
            &from_js(snapshot)?,
            given(&mantle),
            streak,
            diffusion,
            land_share,
        )
        .map(World)
        .map_err(era)
    }

    /// A world restored with its plates; `lattice` { accumulated,
    /// lockedEpochs, lastClassCode } and `mesh` the mesh payload, either
    /// null.
    #[wasm_bindgen(js_name = restorePlates)]
    pub fn restore_plates(
        shape: &str,
        snapshot: &JsValue,
        ocean_age: &JsValue,
        mantle: &JsValue,
        lattice: &JsValue,
        mesh: &JsValue,
    ) -> Result<World, JsError> {
        let (mantle, lattice, mesh) = (from_js(mantle)?, from_js(lattice)?, from_js(mesh)?);
        casas_engine_api::World::restore_plates(
            shape_of(shape)?,
            &from_js(snapshot)?,
            &from_js(ocean_age)?,
            given(&mantle),
            given(&lattice),
            given(&mesh),
        )
        .map(World)
        .map_err(era)
    }

    pub fn snapshot(&mut self) -> Result<JsValue, JsError> {
        self.0.snapshot().map(to_js).map_err(era)
    }

    /// The mantle's and the ocean age's saved values, as [mantle, ocean].
    pub fn lattice(&mut self) -> Result<JsValue, JsError> {
        self.0.lattice().map(to_js).map_err(era)
    }

    #[wasm_bindgen(js_name = savedFields)]
    pub fn saved_fields(&mut self) -> Result<JsValue, JsError> {
        let (m, o) = self.0.saved_fields().map_err(era)?;
        Ok(to_js(casas_engine_api::Value::List(vec![m, o])))
    }

    #[wasm_bindgen(js_name = meshPayload)]
    pub fn mesh_payload(&mut self) -> Result<JsValue, JsError> {
        self.0.mesh_payload().map(to_js).map_err(era)
    }

    #[wasm_bindgen(js_name = dropStage)]
    pub fn drop_stage(&mut self, stage: &str) -> Result<(), JsError> {
        self.0.drop_stage(stage).map_err(era)
    }

    #[wasm_bindgen(js_name = migrationInputs)]
    pub fn migration_inputs(&mut self) -> Result<JsValue, JsError> {
        self.0.migration_inputs().map(to_js).map_err(era)
    }

    #[wasm_bindgen(js_name = climatePayload)]
    pub fn climate_payload(&mut self) -> Result<JsValue, JsError> {
        self.0.climate_payload().map(to_js).map_err(era)
    }

    #[wasm_bindgen(js_name = landPayload)]
    pub fn land_payload(&mut self) -> Result<JsValue, JsError> {
        self.0.land_payload().map(to_js).map_err(era)
    }

    pub fn render(&mut self, scale: u32) -> Result<JsValue, JsError> {
        self.0.render(scale).map(to_js).map_err(era)
    }

    pub fn climate(&mut self, params: &JsValue) -> Result<JsValue, JsError> {
        self.0.climate(&from_js(params)?).map(to_js).map_err(era)
    }

    pub fn hydrology(&mut self, planet: &JsValue) -> Result<JsValue, JsError> {
        let planet = from_js(planet)?;
        self.0.hydrology(given(&planet)).map(to_js).map_err(era)
    }

    pub fn ecology(&mut self, params: &JsValue) -> Result<JsValue, JsError> {
        self.0.ecology(&from_js(params)?).map(to_js).map_err(era)
    }

    #[wasm_bindgen(js_name = ecologyMonth)]
    pub fn ecology_month(&mut self, field: &str, month: u32) -> Result<JsValue, JsError> {
        self.0.ecology_month(field, month).map(to_js).map_err(era)
    }

    #[wasm_bindgen(js_name = refineClimate)]
    pub fn refine_climate(&mut self, restored: &JsValue) -> Result<JsValue, JsError> {
        let restored = from_js(restored)?;
        self.0
            .refine_climate(given(&restored))
            .map(to_js)
            .map_err(era)
    }
}

/// A world's runs made again at a level's budget, one epoch at a time:
/// the runtime's replay at the history's own (level 0), whose end is the
/// session's world.
#[wasm_bindgen]
pub struct Replay(casas_engine_api::replay::Replay);

#[wasm_bindgen]
impl Replay {
    /// `plan` a `ReplayPlan`.
    pub fn start(plan: &JsValue, level: u32) -> Result<Replay, JsError> {
        casas_engine_api::replay::Replay::start(&from_js(plan)?, level, None, None)
            .map(Replay)
            .map_err(era)
    }

    pub fn progress(&mut self) -> Result<JsValue, JsError> {
        self.0.progress().map(to_js).map_err(era)
    }

    /// The next epoch; false past the last.
    pub fn step(&mut self) -> Result<bool, JsError> {
        self.0.step().map_err(era)
    }

    /// The world from the replay's end; the replay ends here.
    pub fn world(&mut self) -> Result<World, JsError> {
        self.0.world().map(World).map_err(era)
    }
}

/// The planet preview's climate on a sample world's raster.
#[wasm_bindgen]
pub struct Preview(casas_engine_api::preview::Preview);

#[wasm_bindgen]
impl Preview {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Preview {
        Preview(casas_engine_api::preview::Preview::new())
    }

    /// `elevation` a Float32Array of `width` × `height`, `params`
    /// `ClimateParams`.
    pub fn climate(
        &mut self,
        shape: &str,
        width: u32,
        height: u32,
        elevation: &JsValue,
        params: &JsValue,
    ) -> Result<JsValue, JsError> {
        self.0
            .climate(
                shape_of(shape)?,
                width,
                height,
                &from_js(elevation)?,
                &from_js(params)?,
            )
            .map(to_js)
            .map_err(era)
    }
}

impl Default for Preview {
    fn default() -> Self {
        Self::new()
    }
}

fn shape_of(shape: &str) -> Result<casas_engine_api::Shape, JsError> {
    match shape {
        "torus" => Ok(casas_engine_api::Shape::Torus),
        "sphere" => Ok(casas_engine_api::Shape::Sphere),
        _ => Err(JsError::new(&format!("no world shape {shape}"))),
    }
}
