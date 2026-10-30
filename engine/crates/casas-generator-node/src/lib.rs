//! The native build of the engine for the Node job worker. `make engine`
//! copies it to `engine/dist/casas-generator.node`. It wraps
//! `casas-generator-api` one for one (docs/decisions/rust-engine.md, fork 6).

mod tree;

use casas_generator_api::{EraError, Value};
use napi::bindgen_prelude::Float64Array;
use napi_derive::napi;
use tree::Tree;

/// The engine's crate version.
#[napi]
pub fn version() -> String {
    casas_generator_api::version().to_string()
}

/// The erosion's coarse forcing of a save's snapshot, `{ uplift,
/// hardness }` (`casas_generator_api::forcing_of_snapshot`).
#[napi(ts_args_type = "shape: string, snapshot: unknown")]
pub fn forcing_of_snapshot(shape: String, snapshot: Tree) -> napi::Result<Tree> {
    casas_generator_api::forcing_of_snapshot(shape_of(&shape)?, &snapshot.0)
        .map(Tree)
        .map_err(era)
}

/// The volcanoes the map marks of a save's snapshot
/// (`casas_generator_api::volcanoes_of_snapshot`).
#[napi(ts_args_type = "snapshot: unknown")]
pub fn volcanoes_of_snapshot(snapshot: Tree) -> napi::Result<Tree> {
    casas_generator_api::volcanoes_of_snapshot(&snapshot.0)
        .map(Tree)
        .map_err(era)
}

/// The sea-level temperature per row of the climate's chart, °C
/// (`casas_generator_api::sea_level_temperature_band`); `planet` null or
/// undefined is the default planet.
#[napi(ts_args_type = "offsetC: number, contrast: number, planet: unknown, shape: string")]
pub fn sea_level_temperature_band(
    offset_c: f64,
    contrast: f64,
    planet: Tree,
    shape: String,
) -> napi::Result<Tree> {
    casas_generator_api::sea_level_temperature_band(
        offset_c,
        contrast,
        given(&planet.0),
        shape_of(&shape)?,
    )
    .map(Tree)
    .map_err(era)
}

/// A level's files, `{ name: bytes }` (`casas_generator_api::formats`).
#[napi(ts_args_type = "artifact: unknown")]
pub fn level_files(artifact: Tree) -> napi::Result<Tree> {
    casas_generator_api::formats::level_files(&artifact.0)
        .map(Tree)
        .map_err(era)
}

/// A tile's files, `{ name: bytes }`.
#[napi(ts_args_type = "artifact: unknown")]
pub fn tile_files(artifact: Tree) -> napi::Result<Tree> {
    casas_generator_api::formats::tile_files(&artifact.0)
        .map(Tree)
        .map_err(era)
}

/// A river graph as a level and a save keep it, `{ json, cells,
/// coursePoints, positions? }`.
#[napi(ts_args_type = "graph: unknown")]
pub fn river_graph_parts(graph: Tree) -> napi::Result<Tree> {
    casas_generator_api::formats::river_graph_parts(&graph.0)
        .map(Tree)
        .map_err(era)
}

/// A level's arrays and waters from its files.
#[napi(ts_args_type = "files: unknown")]
pub fn level_of_files(files: Tree) -> napi::Result<Tree> {
    casas_generator_api::formats::level_of_files(&files.0)
        .map(Tree)
        .map_err(era)
}

/// A tile's arrays from its files.
#[napi(ts_args_type = "files: unknown")]
pub fn tile_of_files(files: Tree) -> napi::Result<Tree> {
    casas_generator_api::formats::tile_of_files(&files.0)
        .map(Tree)
        .map_err(era)
}

/// The bootstrap mesh of a domain in canonical form, `{ count, nodes,
/// connectivity }` (`casas_generator_api::bootstrap_mesh`).
#[napi(ts_args_type = "shape: string, width: number, height: number, spacing: number")]
pub fn bootstrap_mesh(shape: String, width: f64, height: f64, spacing: f64) -> napi::Result<Tree> {
    Ok(Tree(casas_generator_api::bootstrap_mesh(
        shape_of(&shape)?,
        width,
        height,
        spacing,
    )))
}

/// The invariants of a river graph, `{ check: violations }`
/// (`casas_generator_api::river_graph_invariants`).
#[napi(ts_args_type = "parts: unknown, elevation: Float32Array")]
pub fn river_graph_invariants(parts: Tree, elevation: Tree) -> napi::Result<Tree> {
    casas_generator_api::river_graph_invariants(&parts.0, &elevation.0)
        .map(Tree)
        .map_err(era)
}

/// The invariants of a coast graph, `{ check: violations }`
/// (`casas_generator_api::coast_graph_invariants`).
#[napi(
    ts_args_type = "shape: string, width: number, height: number, mesh: unknown, z: Float32Array, coast: unknown"
)]
pub fn coast_graph_invariants(
    shape: String,
    width: f64,
    height: f64,
    mesh: Tree,
    z: Tree,
    coast: Tree,
) -> napi::Result<Tree> {
    casas_generator_api::coast_graph_invariants(
        shape_of(&shape)?,
        width,
        height,
        &mesh.0,
        &z.0,
        &coast.0,
    )
    .map(Tree)
    .map_err(era)
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
pub struct World(casas_generator_api::World);

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
        Ok(World(casas_generator_api::World::genesis(
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

    #[napi]
    pub fn set_archean_controls(&mut self, diffusion: f64, land_share: f64) {
        self.0.set_archean_controls(diffusion, land_share);
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
        casas_generator_api::World::restore_archean(
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
        casas_generator_api::World::restore_plates(
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

    #[napi]
    pub fn forcing(&mut self) -> napi::Result<Tree> {
        self.0.forcing().map(Tree).map_err(era)
    }

    #[napi]
    pub fn lattice(&mut self) -> napi::Result<Tree> {
        self.0.lattice().map(Tree).map_err(era)
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

    #[napi]
    pub fn drop_stage(&mut self, stage: String) -> napi::Result<()> {
        self.0.drop_stage(&stage).map_err(era)
    }

    #[napi]
    pub fn climate_payload(&mut self) -> napi::Result<Tree> {
        self.0.climate_payload().map(Tree).map_err(era)
    }

    #[napi]
    pub fn land_payload(&mut self) -> napi::Result<Tree> {
        self.0.land_payload().map(Tree).map_err(era)
    }

    #[napi]
    pub fn render(&mut self, scale: u32) -> napi::Result<Tree> {
        self.0.render(scale).map(Tree).map_err(era)
    }

    #[napi(ts_args_type = "params: unknown")]
    pub fn climate(&mut self, params: Tree) -> napi::Result<Tree> {
        self.0.climate(&params.0).map(Tree).map_err(era)
    }

    #[napi(ts_args_type = "planet?: unknown")]
    pub fn hydrology(&mut self, planet: Tree) -> napi::Result<Tree> {
        self.0.hydrology(given(&planet.0)).map(Tree).map_err(era)
    }

    #[napi(ts_args_type = "params: unknown")]
    pub fn ecology(&mut self, params: Tree) -> napi::Result<Tree> {
        self.0.ecology(&params.0).map(Tree).map_err(era)
    }

    #[napi]
    pub fn ecology_month(&mut self, field: String, month: u32) -> napi::Result<Tree> {
        self.0.ecology_month(&field, month).map(Tree).map_err(era)
    }

    #[napi(ts_args_type = "restored?: unknown")]
    pub fn refine_climate(&mut self, restored: Tree) -> napi::Result<Tree> {
        self.0
            .refine_climate(given(&restored.0))
            .map(Tree)
            .map_err(era)
    }

    /// The world as a mesh level's artifact, its land fields included.
    #[napi]
    pub fn level_artifact(&mut self, level: u32) -> napi::Result<Tree> {
        self.0.level_artifact(level).map(Tree).map_err(era)
    }
}

fn shape_of(shape: &str) -> napi::Result<casas_generator_api::Shape> {
    match shape {
        "torus" => Ok(casas_generator_api::Shape::Torus),
        "sphere" => Ok(casas_generator_api::Shape::Sphere),
        _ => Err(napi::Error::from_reason(format!("no world shape {shape}"))),
    }
}

/// A world's runs made again at a level's budget, one epoch at a time:
/// the job worker's level 1, and the runtime's replay at level 0, whose end
/// is a world.
#[napi]
pub struct Replay(casas_generator_api::replay::Replay);

#[napi]
impl Replay {
    /// `plan` a `ReplayPlan`, `resume` `{ position, snapshot }` or null,
    /// `leafWorkers` the engine pool's threads or null.
    #[napi(
        factory,
        ts_args_type = "plan: unknown, level: number, resume?: unknown, leafWorkers?: number | null"
    )]
    pub fn start(
        plan: Tree,
        level: u32,
        resume: Tree,
        leaf_workers: Option<u32>,
    ) -> napi::Result<Replay> {
        casas_generator_api::replay::Replay::start(&plan.0, level, given(&resume.0), leaf_workers)
            .map(Replay)
            .map_err(era)
    }

    #[napi]
    pub fn progress(&mut self) -> napi::Result<Tree> {
        self.0.progress().map(Tree).map_err(era)
    }

    #[napi]
    pub fn checkpoint_due(&mut self) -> napi::Result<Tree> {
        self.0.checkpoint_due().map(Tree).map_err(era)
    }

    #[napi]
    pub fn snapshot(&mut self) -> napi::Result<Tree> {
        self.0.snapshot().map(Tree).map_err(era)
    }

    #[napi]
    pub fn step(&mut self) -> napi::Result<bool> {
        self.0.step().map_err(era)
    }

    #[napi]
    pub fn level(&mut self) -> napi::Result<Tree> {
        self.0.level().map(Tree).map_err(era)
    }

    /// The world from the replay's end; the replay ends here.
    #[napi]
    pub fn world(&mut self) -> napi::Result<World> {
        self.0.world().map(World).map_err(era)
    }
}

/// The planet preview's climate on a sample world's raster.
#[napi]
pub struct Preview(casas_generator_api::preview::Preview);

#[napi]
impl Preview {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Preview {
        Preview(casas_generator_api::preview::Preview::new())
    }

    #[napi(
        ts_args_type = "shape: string, width: number, height: number, elevation: Float32Array, params: unknown"
    )]
    pub fn climate(
        &mut self,
        shape: String,
        width: u32,
        height: u32,
        elevation: Tree,
        params: Tree,
    ) -> napi::Result<Tree> {
        self.0
            .climate(shape_of(&shape)?, width, height, &elevation.0, &params.0)
            .map(Tree)
            .map_err(era)
    }

    /// The refined climate at points of a raster's relief, for the
    /// measurement scripts (engine/scripts/earthClimate.mjs); native only.
    #[napi(
        ts_args_type = "shape: string, width: number, height: number, elevation: Float32Array, params: unknown, x: Float64Array, y: Float64Array, heights: Float32Array, land: Uint8Array"
    )]
    #[allow(clippy::too_many_arguments)]
    pub fn refined_climate_at(
        &mut self,
        shape: String,
        width: u32,
        height: u32,
        elevation: Tree,
        params: Tree,
        x: Tree,
        y: Tree,
        heights: Tree,
        land: Tree,
    ) -> napi::Result<Tree> {
        self.0
            .refined_climate_at(
                shape_of(&shape)?,
                width,
                height,
                &elevation.0,
                &params.0,
                &x.0,
                &y.0,
                &heights.0,
                &land.0,
            )
            .map(Tree)
            .map_err(era)
    }
}

/// The tile levels' plan from level 1's artifact and the world's save,
/// whose raster says which tiles hold land. Native only.
#[napi(ts_args_type = "artifact: unknown, save: unknown")]
pub fn plan_tiles(artifact: Tree, save: Tree) -> napi::Result<Tree> {
    casas_generator_api::tiles::plan(&artifact.0, &save.0)
        .map(Tree)
        .map_err(era)
}

/// A worker's tile bakes on one world's level 1. Native only.
#[napi]
pub struct TileBaker(casas_generator_api::tiles::TileBaker);

#[napi]
impl TileBaker {
    #[napi(
        factory,
        ts_args_type = "artifact: unknown, inputs: unknown, leafWorkers?: number | null"
    )]
    pub fn open(
        artifact: Tree,
        inputs: Tree,
        leaf_workers: Option<u32>,
    ) -> napi::Result<TileBaker> {
        casas_generator_api::tiles::TileBaker::open(&artifact.0, &inputs.0, leaf_workers)
            .map(TileBaker)
            .map_err(era)
    }

    #[napi(ts_args_type = "tile: unknown, pieces: unknown, upstream: unknown, rounds: number")]
    pub fn bake(
        &mut self,
        tile: Tree,
        pieces: Tree,
        upstream: Tree,
        rounds: u32,
    ) -> napi::Result<Tree> {
        self.0
            .bake(&tile.0, given(&pieces.0), &upstream.0, rounds)
            .map(Tree)
            .map_err(era)
    }
}
