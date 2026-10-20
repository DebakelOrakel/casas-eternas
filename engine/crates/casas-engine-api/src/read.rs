//! Value trees from TypeScript read back into the engine's types: a save's
//! state (`PlateSimulationSnapshot`, `ArcheanSnapshot`, `SavedField`, the
//! mesh payload, `RefinedClimate`) and a call's controls. The inverse of `forms`; a key a
//! save written before a field existed leaves out reads as the
//! TypeScript reader reads it (absent, or its default).

use casas_engine::archean::archean_snapshot::ArcheanSnapshot;
use casas_engine::climate::refinement::{RefinedClimate, RefinedReliability, RefinedStorms};
use casas_engine::climate::weather::WeatherParams;
use casas_engine::crust::raft_types::{Raft, RaftBlob, Suture};
use casas_engine::fields::field_mesh::SavedField;
use casas_engine::planet::planet_forcing::PlanetForcing;
use casas_engine::tectonics::plate_motion::{EulerMotion, PlateMotion, RigidMotion};
use casas_engine::tectonics::plate_seeds::PlateSeed;
use casas_engine::tectonics::plate_simulation_types::{
    ClimateEpochRecord, LakeAgeRecord, PlateSimulationSnapshot,
};
use casas_engine::tectonics::plumes::Plume;
use casas_engine::tectonics::terrain_features::{FeatureKind, MovesWith, TerrainFeature};

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
