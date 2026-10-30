//! Value trees from TypeScript read back into the engine's types: a save's
//! state (`PlateSimulationSnapshot`, `ArcheanSnapshot`, `SavedField`, the
//! mesh payload, `RefinedClimate`, a level's `RiverGraph`, the saved
//! climate) and a call's controls. The inverse of `forms`; a key a
//! save written before a field existed leaves out reads as the
//! TypeScript reader reads it (absent, or its default).

use casas_generator::archean::archean_snapshot::ArcheanSnapshot;
use casas_generator::climate::climate_points::ClimateCellValues;
use casas_generator::climate::refinement::{RefinedClimate, RefinedReliability, RefinedStorms};
use casas_generator::climate::weather::WeatherParams;
use casas_generator::crust::raft_types::{Raft, RaftBlob, Suture};
use casas_generator::fields::field_mesh::SavedField;
use casas_generator::mesh::mesh_tile::TileId;
use casas_generator::planet::planet_forcing::PlanetForcing;
use casas_generator::surface::coast_graph::{CoastGraph, CoastReach, CoastType};
use casas_generator::surface::hydrogeology::SpringFeature;
use casas_generator::surface::hydrology::{WaterBody, WaterKind};
use casas_generator::surface::river_course::{RiverCourse, RiverPattern};
use casas_generator::surface::river_graph::{
    RiverGraph, RiverNode, RiverNodeKind, RiverReach, RiverReachKind, RiverRegime,
};
use casas_generator::tectonics::plate_motion::{EulerMotion, PlateMotion, RigidMotion};
use casas_generator::tectonics::plate_seeds::PlateSeed;
use casas_generator::tectonics::plate_simulation_types::{
    ClimateEpochRecord, LakeAgeRecord, PlateSimulationSnapshot,
};
use casas_generator::tectonics::plumes::Plume;
use casas_generator::tectonics::terrain_features::{FeatureKind, MovesWith, TerrainFeature};

use crate::value::Value;

/// What a value tree did not hold that its reader needed.
pub type ReadResult<T> = Result<T, String>;

/// An object's fields, by key.
#[derive(Clone, Copy)]
pub struct Fields<'a>(&'a [(std::borrow::Cow<'static, str>, Value)], &'static str);

impl<'a> Fields<'a> {
    pub fn of(v: &'a Value, what: &'static str) -> ReadResult<Self> {
        match v {
            Value::Obj(f) => Ok(Fields(f, what)),
            _ => Err(format!("{what} is not an object")),
        }
    }

    pub fn get(&self, key: &str) -> Option<&'a Value> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
            .filter(|v| !matches!(v, Value::Null))
    }

    /// The object's keys, in order.
    pub fn keys(&self) -> impl Iterator<Item = &'a str> {
        self.0.iter().map(|(k, _)| k.as_ref())
    }

    fn need(&self, key: &str) -> ReadResult<&'a Value> {
        self.get(key)
            .ok_or_else(|| format!("{} has no {key}", self.1))
    }

    pub fn num(&self, key: &str) -> ReadResult<f64> {
        match self.need(key)? {
            Value::Num(n) => Ok(*n),
            _ => Err(format!("{}.{key} is not a number", self.1)),
        }
    }

    pub fn opt_num(&self, key: &str) -> ReadResult<Option<f64>> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::Num(n)) => Ok(Some(*n)),
            Some(_) => Err(format!("{}.{key} is not a number", self.1)),
        }
    }

    pub fn bool(&self, key: &str) -> ReadResult<bool> {
        match self.need(key)? {
            Value::Bool(b) => Ok(*b),
            _ => Err(format!("{}.{key} is not a boolean", self.1)),
        }
    }

    pub fn opt_bool(&self, key: &str) -> ReadResult<Option<bool>> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(format!("{}.{key} is not a boolean", self.1)),
        }
    }

    pub fn opt_str(&self, key: &str) -> ReadResult<Option<String>> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::Str(s)) => Ok(Some(s.clone())),
            Some(_) => Err(format!("{}.{key} is not a string", self.1)),
        }
    }

    pub fn list(&self, key: &str) -> ReadResult<&'a [Value]> {
        match self.need(key)? {
            Value::List(l) => Ok(l),
            _ => Err(format!("{}.{key} is not an array", self.1)),
        }
    }

    pub fn opt_list(&self, key: &str) -> ReadResult<Option<&'a [Value]>> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::List(l)) => Ok(Some(l)),
            Some(_) => Err(format!("{}.{key} is not an array", self.1)),
        }
    }
}

fn each<T>(items: &[Value], read: impl Fn(&Value) -> ReadResult<T>) -> ReadResult<Vec<T>> {
    items.iter().map(read).collect()
}

/// A typed array (or a plain array of numbers) as f64s.
pub fn f64s(v: &Value, what: &str) -> ReadResult<Vec<f64>> {
    match v {
        Value::F64s(a) => Ok(a.clone()),
        Value::F32s(a) => Ok(a.iter().map(|&x| x as f64).collect()),
        Value::List(l) => l
            .iter()
            .map(|x| match x {
                Value::Num(n) => Ok(*n),
                _ => Err(format!("{what} holds a value that is not a number")),
            })
            .collect(),
        _ => Err(format!("{what} is not an array of numbers")),
    }
}

pub fn f32s<'a>(v: &'a Value, what: &str) -> ReadResult<&'a [f32]> {
    match v {
        Value::F32s(a) => Ok(a),
        _ => Err(format!("{what} is not a Float32Array")),
    }
}

pub fn u8s<'a>(v: &'a Value, what: &str) -> ReadResult<&'a [u8]> {
    match v {
        Value::U8s(a) => Ok(a),
        _ => Err(format!("{what} is not a Uint8Array")),
    }
}

fn motion(v: &Value) -> ReadResult<PlateMotion> {
    let f = Fields::of(v, "a motion")?;
    if f.get("poleX").is_some() {
        return Ok(PlateMotion::Euler(EulerMotion {
            pole_x: f.num("poleX")?,
            pole_y: f.num("poleY")?,
            pole_z: f.num("poleZ")?,
            rate: f.num("rate")?,
        }));
    }
    Ok(PlateMotion::Rigid(RigidMotion {
        drift_x: f.num("driftX")?,
        drift_y: f.num("driftY")?,
        spin: f.num("spin")?,
        centroid_x: f.num("centroidX")?,
        centroid_y: f.num("centroidY")?,
    }))
}

fn raft(v: &Value) -> ReadResult<Raft> {
    let f = Fields::of(v, "a raft")?;
    Ok(Raft {
        id: f.num("id")? as u32,
        name: f.opt_str("name")?,
        blobs: each(f.list("blobs")?, |b| {
            let b = Fields::of(b, "a blob")?;
            Ok(RaftBlob {
                x: b.num("x")?,
                y: b.num("y")?,
                radius: b.num("radius")?,
                birth_epoch: b.opt_num("birthEpoch")?,
            })
        })?,
        no_merge_until_epoch: f.opt_num("noMergeUntilEpoch")?,
    })
}

fn feature(v: &Value) -> ReadResult<TerrainFeature> {
    let f = Fields::of(v, "a feature")?;
    let kind = match f.opt_str("kind")?.as_deref() {
        Some("range") => FeatureKind::Range,
        Some("trench") => FeatureKind::Trench,
        other => return Err(format!("no feature kind {other:?}")),
    };
    let moves_with = match f.get("movesWithPlate") {
        Some(Value::Num(p)) => MovesWith::Plate(*p as u32),
        Some(Value::Str(s)) if s == "both" => MovesWith::Both,
        _ => return Err("a feature moves with no plate".into()),
    };
    Ok(TerrainFeature {
        x: f.num("x")?,
        y: f.num("y")?,
        thickness: f.num("thickness")?,
        tangent_x: f.num("tangentX")?,
        tangent_y: f.num("tangentY")?,
        kind,
        plate_a: f.num("plateA")? as i32,
        plate_b: f.num("plateB")? as i32,
        moves_with,
        subsides: f.bool("subsides")?,
        epochs_since_deposit: f.num("epochsSinceDeposit")?,
        volcanic: f.opt_bool("volcanic")?,
        shortening_km_per_myr: f.opt_num("shorteningKmPerMyr")?,
        shortening_first: f
            .keys()
            .find(|&k| k == "volcanic" || k == "shorteningKmPerMyr")
            == Some("shorteningKmPerMyr"),
    })
}

fn plume(v: &Value) -> ReadResult<Plume> {
    let f = Fields::of(v, "a hotspot")?;
    Ok(Plume {
        x: f.num("x")?,
        y: f.num("y")?,
        id: f.num("id")? as i64,
        birth_epoch: f.num("birthEpoch")?,
    })
}

fn suture(v: &Value) -> ReadResult<Suture> {
    let f = Fields::of(v, "a suture")?;
    Ok(Suture {
        x: f.num("x")?,
        y: f.num("y")?,
        tangent_x: f.num("tangentX")?,
        tangent_y: f.num("tangentY")?,
        epoch: f.num("epoch")?,
    })
}

/// `PlateSimulationSnapshot`.
pub fn snapshot(v: &Value) -> ReadResult<PlateSimulationSnapshot> {
    let f = Fields::of(v, "the snapshot")?;
    Ok(PlateSimulationSnapshot {
        epoch_ma: f.opt_num("epochMa")?,
        sediment_export_m3: f.opt_num("sedimentExportM3")?,
        eustatic_m: f.opt_num("eustaticM")?,
        climate_history: f
            .opt_list("climateHistory")?
            .map(|l| {
                each(l, |r| {
                    let r = Fields::of(r, "a climate record")?;
                    Ok(ClimateEpochRecord {
                        epoch: r.num("epoch")?,
                        mean_land_temp_c: r.num("meanLandTempC")?,
                        ice_volume_km3: r.num("iceVolumeKm3")?,
                        sea_level_m: r.num("seaLevelM")?,
                    })
                })
            })
            .transpose()?,
        lake_ages: f
            .opt_list("lakeAges")?
            .map(|l| {
                each(l, |r| {
                    let r = Fields::of(r, "a lake age")?;
                    Ok(LakeAgeRecord {
                        x: r.num("x")?,
                        y: r.num("y")?,
                        level: r.num("level")?,
                        age_ma: r.num("ageMa")?,
                    })
                })
            })
            .transpose()?,
        archean_epochs: f.opt_num("archeanEpochs")?,
        width: f.num("width")?,
        height: f.num("height")?,
        initial_plate_count: f.num("initialPlateCount")?,
        seeds: each(f.list("seeds")?, |p| {
            let p = Fields::of(p, "a seed")?;
            Ok(PlateSeed {
                x: p.num("x")?,
                y: p.num("y")?,
            })
        })?,
        motions: each(f.list("motions")?, motion)?,
        ages: f64s(f.need("ages")?, "the ages")?,
        rafts: each(f.list("rafts")?, raft)?,
        features: each(f.list("features")?, feature)?,
        epoch: f.num("epoch")?,
        warp_seed: f.num("warpSeed")?,
        supercontinent_active: f.bool("supercontinentActive")?,
        continental_rift_cooldown_until: f.num("continentalRiftCooldownUntil")?,
        hotspots: f
            .opt_list("hotspots")?
            .map(|l| each(l, plume))
            .transpose()?,
        sutures: f
            .opt_list("sutures")?
            .map(|l| each(l, suture))
            .transpose()?,
        rng_state: f.num("rngState")? as u32,
    })
}

/// `ArcheanSnapshot`.
pub fn archean_snapshot(v: &Value) -> ReadResult<ArcheanSnapshot> {
    let f = Fields::of(v, "the Archean snapshot")?;
    Ok(ArcheanSnapshot {
        width: f.num("width")?,
        height: f.num("height")?,
        epoch: f.num("epoch")?,
        warp_seed: f.num("warpSeed")?,
        nucleation_credit: f.opt_num("nucleationCredit")?,
        rafts: each(f.list("rafts")?, raft)?,
        rng_state: f.num("rngState")? as u32,
    })
}

/// `SavedField`.
pub fn saved_field(v: &Value) -> ReadResult<SavedField> {
    let f = Fields::of(v, "a saved field")?;
    Ok(SavedField {
        values: f64s(f.need("values")?, "a saved field's values")?,
        cells: f.num("cells")? as usize,
        spacing_m: f.num("spacingM")?,
    })
}

/// `PlanetForcing`.
pub fn planet(v: &Value) -> ReadResult<PlanetForcing> {
    let f = Fields::of(v, "the planet")?;
    Ok(PlanetForcing {
        obliquity_deg: f.num("obliquityDeg")?,
        eccentricity: f.num("eccentricity")?,
        precession_deg: f.num("precessionDeg")?,
        solar_constant: f.num("solarConstant")?,
        rotation_hours: f.num("rotationHours")?,
        land_plants_from_ma: f.num("landPlantsFromMa")?,
    })
}

/// `ClimateParams` (`WeatherParams`): the climate's levers and the planet.
pub fn weather(v: &Value) -> ReadResult<WeatherParams> {
    let f = Fields::of(v, "the weather")?;
    Ok(WeatherParams {
        temperature_offset: f.num("temperatureOffset")?,
        temperature_contrast: f.num("temperatureContrast")?,
        humidity: f.num("humidity")?,
        equator_offset: f.num("equatorOffset")?,
        planet: f.get("planet").map(planet).transpose()?,
    })
}

/// `RefinedClimate` as a save reads it back: no solves.
pub fn refined_climate(v: &Value) -> ReadResult<RefinedClimate> {
    let f = Fields::of(v, "the refinement")?;
    let a = |key: &str| -> ReadResult<Vec<f32>> {
        Ok(f32s(f.need(key)?, "a refinement's field")?.to_vec())
    };
    let r = Fields::of(f.need("reliability")?, "the refinement's reliability")?;
    let ra = |key: &str| -> ReadResult<Vec<f32>> {
        Ok(f32s(r.need(key)?, "a reliability field")?.to_vec())
    };
    let st = Fields::of(f.need("storms")?, "the refinement's storms")?;
    let sa =
        |key: &str| -> ReadResult<Vec<f32>> { Ok(f32s(st.need(key)?, "a storm field")?.to_vec()) };
    Ok(RefinedClimate {
        months: f.num("months")? as usize,
        cells: f.num("cells")? as usize,
        spacing_m: f.num("spacingM")?,
        temperature: a("temperature")?,
        precipitation: a("precipitation")?,
        pressure: a("pressure")?,
        wind_e: a("windE")?,
        wind_s: a("windS")?,
        current_e: a("currentE")?,
        current_s: a("currentS")?,
        current_anomaly: a("currentAnomaly")?,
        upwelling: a("upwelling")?,
        salinity: a("salinity")?,
        deep_water: a("deepWater")?,
        fog: a("fog")?,
        foehn: a("foehn")?,
        reliability: RefinedReliability {
            rain_variability: ra("rainVariability")?,
            enso_pattern: ra("ensoPattern")?,
            enso_period_years: r.num("ensoPeriodYears")?,
            enso_strength: r.num("ensoStrength")?,
        },
        storms: RefinedStorms {
            cyclone: sa("cyclone")?,
            tornado: sa("tornado")?,
            blizzard: sa("blizzard")?,
            dust: sa("dust")?,
            thunder: sa("thunder")?,
        },
        solves: None,
    })
}

fn str_of<'a>(f: &Fields<'a>, key: &str) -> ReadResult<&'a str> {
    match f.need(key)? {
        Value::Str(s) => Ok(s),
        _ => Err(format!("{}.{key} is not a string", f.1)),
    }
}

/// A list of numbers.
fn nums(v: &[Value], what: &str) -> ReadResult<Vec<f64>> {
    v.iter()
        .map(|x| match x {
            Value::Num(n) => Ok(*n),
            _ => Err(format!("{what} holds a value that is not a number")),
        })
        .collect()
}

/// `WaterBody`.
pub fn water_body(v: &Value) -> ReadResult<WaterBody> {
    let f = Fields::of(v, "a water body")?;
    Ok(WaterBody {
        id: f.num("id")? as usize,
        kind: match str_of(&f, "kind")? {
            "lake" => WaterKind::Lake,
            "terminal" => WaterKind::Terminal,
            "dry" => WaterKind::Dry,
            k => return Err(format!("no water body kind {k}")),
        },
        level: f.num("level")?,
        spill: f.num("spill")?,
        floor: f.num("floor")?,
        seed_x: f.num("seedX")?,
        seed_y: f.num("seedY")?,
        outlet_x: f.num("outletX")?,
        outlet_y: f.num("outletY")?,
        cells: f.num("cells")?,
        frozen: f.bool("frozen")?,
        // A save made before the flag (2026-10-30) has no subglacial basin.
        subglacial: f.opt_bool("subglacial")?.unwrap_or(false),
    })
}

fn river_node(v: &Value) -> ReadResult<RiverNode> {
    let f = Fields::of(v, "a river node")?;
    Ok(RiverNode {
        id: f.num("id")? as usize,
        kind: match str_of(&f, "kind")? {
            "source" => RiverNodeKind::Source,
            "junction" => RiverNodeKind::Junction,
            "mouth" => RiverNodeKind::Mouth,
            "inlet" => RiverNodeKind::Inlet,
            "outlet" => RiverNodeKind::Outlet,
            k => return Err(format!("no river node kind {k}")),
        },
        cell: f.num("cell")? as usize,
        x: f.num("x")?,
        y: f.num("y")?,
        body: f.num("body")? as i32,
        catchment_cells: f.num("catchmentCells")?,
    })
}

fn river_reach(v: &Value) -> ReadResult<RiverReach> {
    let f = Fields::of(v, "a river reach")?;
    Ok(RiverReach {
        id: f.num("id")? as usize,
        kind: match str_of(&f, "kind")? {
            "river" => RiverReachKind::River,
            "lake" => RiverReachKind::Lake,
            k => return Err(format!("no river reach kind {k}")),
        },
        from: f.num("from")? as usize,
        to: f.num("to")? as usize,
        cell_start: f.num("cellStart")? as usize,
        cell_count: f.num("cellCount")? as usize,
        discharge_in: f.num("dischargeIn")?,
        discharge_out: f.num("dischargeOut")?,
        width_px: f.num("widthPx")?,
        length_km: f.num("lengthKm")?,
        drop_m: f.num("dropM")?,
        slope: f.num("slope")?,
        sediment_m3: f.num("sedimentM3")?,
        bank: f.num("bank")? as i32,
        order: f.num("order")? as i32,
        regime: match str_of(&f, "regime")? {
            "perennial" => RiverRegime::Perennial,
            "intermittent" => RiverRegime::Intermittent,
            "ephemeral" => RiverRegime::Ephemeral,
            k => return Err(format!("no river regime {k}")),
        },
        runoff_out: f.num("runoffOut")?,
        spring_fed: f.bool("springFed")?,
    })
}

fn spring(v: &Value) -> ReadResult<SpringFeature> {
    let f = Fields::of(v, "a spring")?;
    Ok(SpringFeature {
        id: f.num("id")? as usize,
        cell: f.num("cell")? as usize,
        x: f.num("x")?,
        y: f.num("y")?,
        elevation: f.num("elevation")?,
        oasis: f.bool("oasis")?,
    })
}

fn course(v: &Value) -> ReadResult<RiverCourse> {
    let f = Fields::of(v, "a river course")?;
    let lines = |key: &str| -> ReadResult<Vec<Vec<f32>>> {
        f.list(key)?
            .iter()
            .map(|l| Ok(f32s(l, "a course's line")?.to_vec()))
            .collect()
    };
    Ok(RiverCourse {
        reach: f.num("reach")? as usize,
        pattern: match str_of(&f, "pattern")? {
            "straight" => RiverPattern::Straight,
            "meandering" => RiverPattern::Meandering,
            "braided" => RiverPattern::Braided,
            "anastomosing" => RiverPattern::Anastomosing,
            k => return Err(format!("no river pattern {k}")),
        },
        discharge_m3s: f.num("dischargeM3s")?,
        width_m: f.num("widthM")?,
        depth_m: f.num("depthM")?,
        slope: f.num("slope")?,
        bank_strength: f.num("bankStrength")?,
        lines: lines("lines")?,
        line_width: nums(f.list("lineWidth")?, "a course's line widths")?,
        sinuosity: f.num("sinuosity")?,
        belt_width_m: f.num("beltWidthM")?,
        oxbows: lines("oxbows")?,
        lobe_ages: nums(f.list("lobeAges")?, "a course's lobe ages")?
            .into_iter()
            .map(|a| a as u32)
            .collect(),
    })
}

/// `RiverGraph` on the mesh, as `deserializeRiverGraph` gives it.
pub fn river_graph(v: &Value) -> ReadResult<RiverGraph> {
    let f = Fields::of(v, "a river graph")?;
    if f.opt_str("substrate")?.as_deref() != Some("mesh") {
        return Err("the river graph is not on the mesh".into());
    }
    Ok(RiverGraph {
        width: f.num("width")?,
        height: f.num("height")?,
        nodes: each(f.list("nodes")?, river_node)?,
        reaches: each(f.list("reaches")?, river_reach)?,
        cells: match f.need("cells")? {
            Value::I32s(a) => a.clone(),
            _ => return Err("the river graph's cells are not an Int32Array".into()),
        },
        cell_x: f32s(f.need("cellX")?, "the river graph's cellX")?.to_vec(),
        cell_y: f32s(f.need("cellY")?, "the river graph's cellY")?.to_vec(),
        bodies: each(f.list("bodies")?, water_body)?,
        courses: f
            .opt_list("courses")?
            .map(|c| each(c, course))
            .transpose()?,
        springs: f
            .opt_list("springs")?
            .map(|s| each(s, spring))
            .transpose()?,
    })
}

fn coast_reach(v: &Value) -> ReadResult<CoastReach> {
    let f = Fields::of(v, "a coast reach")?;
    Ok(CoastReach {
        id: f.num("id")? as usize,
        node_start: f.num("nodeStart")? as usize,
        node_count: f.num("nodeCount")? as usize,
        length_km: f.num("lengthKm")?,
        exposure: f.num("exposure")?,
        relief_m: f.num("reliefM")?,
        hardness: f.num("hardness")?,
        supply: f.num("supply")?,
        coast_type: match str_of(&f, "type")? {
            "rocky" => CoastType::Rocky,
            "cliff" => CoastType::Cliff,
            "beach" => CoastType::Beach,
            "marsh" => CoastType::Marsh,
            "delta" => CoastType::Delta,
            k => return Err(format!("no coast type {k}")),
        },
        mouth_reach: f.num("mouthReach")? as i32,
    })
}

/// `CoastGraph` as the save holds it (`layers/coast.json`): `{ reaches,
/// nodes }`. The type per vertex slot is not saved: it comes from the
/// reaches' walk, over `slots` vertex slots.
pub fn coast_graph(v: &Value, slots: usize) -> ReadResult<CoastGraph> {
    let f = Fields::of(v, "a coast graph")?;
    let reaches = each(f.list("reaches")?, coast_reach)?;
    let nodes = match f.need("nodes")? {
        Value::I32s(a) => a.clone(),
        _ => return Err("the coast graph's nodes are not an Int32Array".into()),
    };
    let mut coast_type = vec![0u8; slots];
    for r in &reaches {
        for k in 0..r.node_count {
            let v = *nodes
                .get(r.node_start + k)
                .ok_or("a coast reach runs past the coast's nodes")?;
            *coast_type
                .get_mut(v as usize)
                .ok_or("a coast node is not a vertex of the mesh")? = r.coast_type.code();
        }
    }
    Ok(CoastGraph {
        reaches,
        nodes,
        coast_type,
    })
}

/// `ClimateCellValues`: the save's climate per cell of its field mesh.
pub fn climate_cell_values(v: &Value) -> ReadResult<ClimateCellValues> {
    let f = Fields::of(v, "the saved climate")?;
    let a = |k: &str| -> ReadResult<Vec<f32>> { Ok(f32s(f.need(k)?, "a climate field")?.to_vec()) };
    Ok(ClimateCellValues {
        cells: f.num("cells")? as usize,
        spacing_m: f.num("spacingM")?,
        sea_level_temperature: a("seaLevelTemperature")?,
        precipitation: a("precipitation")?,
        seasonal_amplitude: a("seasonalAmplitude")?,
        monsoon_index: a("monsoonIndex")?,
    })
}

/// `TileId`: `{ level, x, y }`.
pub fn tile_id(v: &Value) -> ReadResult<TileId> {
    let f = Fields::of(v, "a tile")?;
    Ok(TileId {
        level: f.num("level")? as u32,
        x: f.num("x")? as usize,
        y: f.num("y")? as usize,
    })
}
