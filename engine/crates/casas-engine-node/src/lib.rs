//! The native build of the engine for the Node job worker. `make engine`
//! copies it to `engine/dist/casas-engine.node`. It wraps
//! `casas-engine-api` one for one (docs/decisions/rust-engine.md, fork 6).

mod tree;

use casas_engine_api::{EraError, Value};
use napi::bindgen_prelude::Float64Array;
use napi_derive::napi;
use tree::Tree;

/// The engine's crate version.
#[napi]
pub fn version() -> String {
    casas_engine_api::version().to_string()
}

fn era(e: EraError) -> napi::Error {
    napi::Error::from_reason(e.0)
}

/// A value given as null or undefined as none.
fn given(v: &Value) -> Option<&Value> {
    (!matches!(v, Value::Null)).then_some(v)
}

/// A world in the engine.
#[napi]
pub struct World(casas_engine_api::World);

#[napi]
impl World {
    /// A new world in its Archean; `shape` "torus" or "sphere".
    #[napi(factory)]
    pub fn genesis(
        seed: String,
        width: u32,
        height: u32,
        shape: String,
        diffusion: f64,
        land_share: f64,
    ) -> napi::Result<World> {
        Ok(World(casas_engine_api::World::genesis(
            &seed,
            width,
            height,
            shape_of(&shape)?,
            diffusion,
            land_share,
        )))
    }

    #[napi]
    pub fn archean_step(&mut self) -> napi::Result<()> {
        self.0.archean_step().map_err(era)
    }

    #[napi(getter)]
    pub fn archean_epoch(&self) -> napi::Result<f64> {
        self.0.archean_epoch().map_err(era)
    }

    #[napi]
    pub fn mantle(&self) -> Float64Array {
        Float64Array::new(self.0.mantle())
    }

    #[napi(getter)]
    pub fn raft_count(&self) -> u32 {
        self.0.raft_count()
    }

    #[napi]
    pub fn finalize(&mut self) -> napi::Result<()> {
        self.0.finalize().map_err(era)
    }

    /// One coupled epoch under the history's controls; its events.
    #[napi(ts_args_type = "controls: unknown")]
    pub fn epoch(&mut self, controls: Tree) -> napi::Result<Tree> {
        self.0.epoch(&controls.0).map(Tree).map_err(era)
    }

    /// The Archean as the save holds it: { snapshot, mantle, streak }.
    #[napi]
    pub fn archean_save(&self) -> napi::Result<Tree> {
        self.0.archean_save().map(Tree).map_err(era)
    }

    /// A world restored in its Archean.
    #[napi(
        factory,
        ts_args_type = "shape: string, snapshot: unknown, mantle: unknown, streak: Int16Array, diffusion: number, landShare: number"
    )]
    pub fn restore_archean(
        shape: String,
        snapshot: Tree,
        mantle: Tree,
        streak: Tree,
        diffusion: f64,
        land_share: f64,
    ) -> napi::Result<World> {
        let Value::I16s(streak) = streak.0 else {
            return Err(napi::Error::from_reason("the streak is not an Int16Array"));
        };
        casas_engine_api::World::restore_archean(
            shape_of(&shape)?,
            &snapshot.0,
            given(&mantle.0),
            &streak,
            diffusion,
            land_share,
        )
        .map(World)
        .map_err(era)
    }

    /// A world restored with its plates; `lattice` { accumulated,
    /// lockedEpochs, lastClassCode } and `mesh` the mesh payload, either
    /// null.
    #[napi(
        factory,
        ts_args_type = "shape: string, snapshot: unknown, oceanAge: unknown, mantle: unknown, lattice: unknown, mesh: unknown"
    )]
    pub fn restore_plates(
        shape: String,
        snapshot: Tree,
        ocean_age: Tree,
        mantle: Tree,
        lattice: Tree,
        mesh: Tree,
    ) -> napi::Result<World> {
        casas_engine_api::World::restore_plates(
            shape_of(&shape)?,
            &snapshot.0,
            &ocean_age.0,
            given(&mantle.0),
            given(&lattice.0),
            given(&mesh.0),
        )
        .map(World)
        .map_err(era)
    }

    #[napi]
    pub fn snapshot(&mut self) -> napi::Result<Tree> {
        self.0.snapshot().map(Tree).map_err(era)
    }

    /// The mantle's and the ocean age's saved values, as [mantle, ocean].
    #[napi]
    pub fn saved_fields(&mut self) -> napi::Result<Vec<Tree>> {
        let (m, o) = self.0.saved_fields().map_err(era)?;
        Ok(vec![Tree(m), Tree(o)])
    }

    #[napi]
    pub fn mesh_payload(&mut self) -> napi::Result<Tree> {
        self.0.mesh_payload().map(Tree).map_err(era)
    }
}

fn shape_of(shape: &str) -> napi::Result<casas_engine_api::Shape> {
    match shape {
        "torus" => Ok(casas_engine_api::Shape::Torus),
        "sphere" => Ok(casas_engine_api::Shape::Sphere),
        _ => Err(napi::Error::from_reason(format!("no world shape {shape}"))),
    }
}
