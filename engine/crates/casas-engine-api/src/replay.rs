//! A world's runs made again through the boundary (`world/replay.ts` over
//! `pipeline/replayRuns.ts`, as the job worker calls them for level 1):
//! the replay one epoch at a time, so that TypeScript reports, writes the
//! checkpoints and stops between two, and the level's waters on its end.

use casas_engine::climate::climate_points::{
    climate_at_points, climate_cells_from_weather, mean_land_runoff, mesh_points,
};
use casas_engine::climate::weather::WeatherParams;
use casas_engine::pipeline::coupled_epoch::CoupledTerrainBytes;
use casas_engine::pipeline::mesh_bake_stage::{
    LevelClimate, LevelSpec, level_budget, level_hydrology,
};
use casas_engine::pipeline::replay_runs::{
    GenesisRun, Replay as Runs, ReplayPlan, ReplayPosition, ReplaySnapshot, TectonicsRun,
};
use casas_engine::surface::erosion_forcing_fields::ErosionControls;

use crate::value::ObjBuilder;
use crate::{EraError, Value, World, forms, read, wrong};

/// `ReplayPlan`: `{ seed, width, height, shape?, genesis: [{ epochs,
/// diffusion, landShare }], tectonics: [{ epochs, controls: { alluvium?,
/// rockContrast? }, weather, restored? }] }`.
fn plan_of(v: &Value) -> Result<ReplayPlan, EraError> {
    let f = read::Fields::of(v, "the replay's plan")?;
    let seed = match f.get("seed") {
        Some(Value::Str(s)) => s.clone(),
        _ => return Err(wrong("the replay's plan has no seed")),
    };
    let genesis = f
        .list("genesis")?
        .iter()
        .map(|g| {
            let g = read::Fields::of(g, "a genesis run")?;
            Ok(GenesisRun {
                epochs: g.num("epochs")? as u32,
                diffusion: g.num("diffusion")?,
                land_share: g.num("landShare")?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let tectonics = f
        .list("tectonics")?
        .iter()
        .map(|t| {
            let t = read::Fields::of(t, "a tectonics run")?;
            let c = read::Fields::of(
                t.get("controls")
                    .ok_or_else(|| "a tectonics run has no controls".to_string())?,
                "a run's controls",
            )?;
            let weather: WeatherParams = read::weather(
                t.get("weather")
                    .ok_or_else(|| "a tectonics run has no weather".to_string())?,
            )?;
            Ok(TectonicsRun {
                epochs: t.num("epochs")? as u32,
                controls: ErosionControls {
                    alluvium: c.opt_num("alluvium")?,
                    rock_contrast: c.opt_num("rockContrast")?,
                },
                weather,
                restored: t.opt_bool("restored")?.unwrap_or(false),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(ReplayPlan {
        seed,
        width: f.num("width")?,
        height: f.num("height")?,
        sphere: f.opt_str("shape")?.as_deref() == Some("sphere"),
        genesis,
        tectonics,
    })
}

fn position_of(v: &Value) -> Result<ReplayPosition, EraError> {
    let f = read::Fields::of(v, "a replay's position")?;
    Ok(ReplayPosition {
        run: f.num("run")? as usize,
        epoch: f.num("epoch")? as u32,
    })
}

fn position(p: ReplayPosition) -> Value {
    ObjBuilder::new()
        .num("run", p.run as f64)
        .num("epoch", p.epoch)
        .build()
}

/// `ReplaySnapshot` back from TypeScript (a checkpoint read from disk).
fn snapshot_of(v: &Value) -> Result<ReplaySnapshot, EraError> {
    let f = read::Fields::of(v, "a replay's snapshot")?;
    let need = |k: &str| {
        f.get(k)
            .ok_or_else(|| wrong(&format!("the snapshot has no {k}")))
    };
    let m = read::Fields::of(need("mesh")?, "the snapshot's mesh")?;
    let mesh = |k: &str| {
        m.get(k)
            .ok_or_else(|| wrong(&format!("the snapshot's mesh has no {k}")))
    };
    let typed = |v: &Value, what: &str| match v {
        Value::I16s(a) => Ok(a.clone()),
        _ => Err(wrong(&format!("{what} is not an Int16Array"))),
    };
    Ok(ReplaySnapshot {
        state: read::snapshot(need("state")?)?,
        ocean_age: read::saved_field(need("oceanAge")?)?,
        mantle: read::saved_field(need("mantle")?)?,
        lattice_accumulated: read::f32s(need("latticeAccumulated")?, "latticeAccumulated")?
            .to_vec(),
        lattice_locked_epochs: typed(need("latticeLockedEpochs")?, "latticeLockedEpochs")?,
        lattice_last_class_code: match need("latticeLastClassCode")? {
            Value::I8s(a) => a.clone(),
            _ => return Err(wrong("latticeLastClassCode is not an Int8Array")),
        },
        mesh: CoupledTerrainBytes {
            nodes: read::f32s(mesh("nodes")?, "nodes")?.to_vec(),
            connectivity: read::u8s(mesh("connectivity")?, "connectivity")?.to_vec(),
            z: read::f32s(mesh("z")?, "z")?.to_vec(),
            column: read::u8s(mesh("column")?, "column")?.to_vec(),
            ice: read::f32s(mesh("ice")?, "ice")?.to_vec(),
        },
    })
}

/// `ReplaySnapshot` for TypeScript, in its key order.
fn snapshot(s: &ReplaySnapshot) -> Value {
    ObjBuilder::new()
        .put("state", forms::snapshot(&s.state))
        .put("oceanAge", forms::saved_field(&s.ocean_age))
        .put("mantle", forms::saved_field(&s.mantle))
        .put(
            "latticeAccumulated",
            Value::F32s(s.lattice_accumulated.clone()),
        )
        .put(
            "latticeLockedEpochs",
            Value::I16s(s.lattice_locked_epochs.clone()),
        )
        .put(
            "latticeLastClassCode",
            Value::I8s(s.lattice_last_class_code.clone()),
        )
        .put(
            "mesh",
            ObjBuilder::new()
                .put("nodes", Value::F32s(s.mesh.nodes.clone()))
                .put("connectivity", Value::U8s(s.mesh.connectivity.clone()))
                .put("z", Value::F32s(s.mesh.z.clone()))
                .put("column", Value::U8s(s.mesh.column.clone()))
                .put("ice", Value::F32s(s.mesh.ice.clone()))
                .build(),
        )
        .build()
}

/// A replay in the engine, at a level's budget.
pub struct Replay {
    runs: Option<Runs>,
    level: u32,
    /// The plan's seed text and width: the level's detail seed and raster
    /// width (`level`).
    seed: String,
    width: f64,
}

impl Replay {
    /// The replay of `plan` (`ReplayPlan`) at `level`'s budget, from the
    /// beginning or from a checkpoint (`{ position, snapshot }`), its
    /// epochs on `leaf_workers` threads of the engine pool when given
    /// (the bytes are the same).
    pub fn start(
        plan: &Value,
        level: u32,
        resume: Option<&Value>,
        leaf_workers: Option<u32>,
    ) -> Result<Replay, EraError> {
        let plan = plan_of(plan)?;
        let (seed, width) = (plan.seed.clone(), plan.width);
        let resume = resume
            .map(|r| -> Result<_, EraError> {
                let f = read::Fields::of(r, "the replay's resume")?;
                let p = f
                    .get("position")
                    .ok_or_else(|| wrong("the resume has no position"))?;
                let s = f
                    .get("snapshot")
                    .ok_or_else(|| wrong("the resume has no snapshot"))?;
                Ok((position_of(p)?, snapshot_of(s)?))
            })
            .transpose()?;
        let runs = Runs::start(
            plan,
            level_budget(level),
            leaf_workers.map(|w| w as usize),
            resume.as_ref().map(|(p, s)| (*p, s)),
        )?;
        Ok(Replay {
            runs: Some(runs),
            level,
            seed,
            width,
        })
    }

    fn runs(&mut self) -> Result<&mut Runs, EraError> {
        self.runs
            .as_mut()
            .ok_or_else(|| wrong("the replay has ended"))
    }

    /// The epochs done and their total: `{ done, total }`.
    pub fn progress(&mut self) -> Result<Value, EraError> {
        let r = self.runs()?;
        Ok(ObjBuilder::new()
            .num("done", r.done())
            .num("total", r.total())
            .build())
    }

    /// Where a checkpoint taken now restores to the same bytes
    /// (`ReplayPosition`), or null.
    pub fn checkpoint_due(&mut self) -> Result<Value, EraError> {
        Ok(self.runs()?.checkpoint_due()?.map_or(Value::Null, position))
    }

    /// The state now, as a checkpoint holds it (`ReplaySnapshot`).
    pub fn snapshot(&mut self) -> Result<Value, EraError> {
        Ok(snapshot(&self.runs()?.snapshot()))
    }

    /// The next epoch; false past the last.
    pub fn step(&mut self) -> Result<bool, EraError> {
        Ok(self.runs()?.step()?)
    }

    /// The world from the replay's end (the runtime's `handleReplayRuns`):
    /// its terrain routed, no stage run on it. The replay ends here.
    pub fn world(&mut self) -> Result<World, EraError> {
        let runs = self
            .runs
            .take()
            .ok_or_else(|| wrong("the replay has ended"))?;
        let (sim, terrain) = runs.into_world();
        Ok(World::replayed(sim, terrain))
    }

    /// The level from the replay's end as the job worker made it until
    /// 2026-10-25: the last epoch's climate at the nodes, the level's
    /// waters, as the artifact holds them (`MeshLevelArtifact`), on the
    /// plan's width and its seed's detail seed. The replay ends here. The
    /// job worker now runs the stages on `world` and takes its
    /// `level_artifact` (docs/decisions/level-waters.md); this stays for
    /// comparing the artifacts made before (`engine/scripts/realWorld.mjs`).
    pub fn level(&mut self) -> Result<Value, EraError> {
        let (width, detail_seed) = (self.width as u32, crate::detail_seed(&self.seed));
        let runs = self
            .runs
            .take()
            .ok_or_else(|| wrong("the replay has ended"))?;
        let (mut sim, terrain) = runs.into_world();
        let (Some(routing), Some(weather)) = (terrain.routing.as_ref(), terrain.weather.as_ref())
        else {
            return Err(wrong("the replay ended without its last epoch's state"));
        };
        let shared = &mut sim.meshes.shared;
        let cells = climate_cells_from_weather(&weather.terrain, &weather.mesh);
        let at_nodes = climate_at_points(
            shared,
            &cells,
            &mesh_points(&terrain.mesh, &terrain.z, None),
            false,
        );
        let water = level_hydrology(
            &terrain.mesh,
            &terrain.z,
            routing,
            &terrain.areas,
            &terrain.sediment_flux,
            &LevelClimate {
                precipitation: &at_nodes.precipitation,
                temperature: &at_nodes.temperature,
                monsoon_index: Some(&at_nodes.monsoon_index),
                mean_runoff: mean_land_runoff(shared, &cells),
            },
            &LevelSpec {
                width: width as usize,
                budget: level_budget(self.level),
                detail_seed,
            },
        );
        Ok(forms::mesh_level_artifact(
            self.level,
            &terrain.mesh,
            &terrain.z,
            &water.water_bodies,
            Some(&water.graph),
            Some(&water.rivers),
            None,
        ))
    }
}
