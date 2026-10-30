//! The engine's state as the TypeScript types the world layer writes and
//! the screen reads (`PlateSimulationSnapshot`, `SimEvent`, `SavedField`,
//! the mesh payload, the climate's and the hydrology's messages,
//! `RefinedClimate`, `RiverGraph`), as value trees. Keys and shapes are the TypeScript
//! types'; their order is the TypeScript serializer's.

use std::borrow::Cow;

use casas_engine::climate::climate_chart::RefinedClimateChart;
use casas_engine::climate::refinement::RefinedClimate;
use casas_engine::crust::raft_types::{Raft, Suture};
use casas_engine::fields::field_mesh::SavedField;
use casas_engine::mesh::mesh_column::encode_column;
use casas_engine::mesh::mesh_serial::encode_mesh;
use casas_engine::mesh::periodic_delaunay::PeriodicTriangulation;
use casas_engine::pipeline::coupled_epoch::CoupledTerrain;
use casas_engine::surface::coast_graph::{CoastReach, CoastType};
use casas_engine::surface::hydrogeology::SpringFeature;
use casas_engine::surface::hydrology::{WaterBody, WaterKind};
use casas_engine::surface::river_course::{RiverCourse, RiverPattern};
use casas_engine::surface::river_graph::{
    RiverGraph, RiverNode, RiverNodeKind, RiverPolylines, RiverReach, RiverReachKind, RiverRegime,
};
use casas_engine::surface::sediment_basins::{BasinKind, SedimentBasin};
use casas_engine::tectonics::plate_motion::PlateMotion;
use casas_engine::tectonics::plate_simulation_types::{
    PlateSimulationSnapshot, SimEvent, SimEventType,
};
use casas_engine::tectonics::plumes::Plume;
use casas_engine::tectonics::terrain_features::{FeatureKind, MovesWith, TerrainFeature};
use casas_engine::tectonics::volcanoes::{Volcano, VolcanoKind};

use crate::value::{ObjBuilder, Value};

fn motion(m: &PlateMotion) -> Value {
    match m {
        PlateMotion::Rigid(r) => ObjBuilder::new()
            .num("driftX", r.drift_x)
            .num("driftY", r.drift_y)
            .num("spin", r.spin)
            .num("centroidX", r.centroid_x)
            .num("centroidY", r.centroid_y)
            .build(),
        PlateMotion::Euler(e) => ObjBuilder::new()
            .num("poleX", e.pole_x)
            .num("poleY", e.pole_y)
            .num("poleZ", e.pole_z)
            .num("rate", e.rate)
            .build(),
    }
}

pub fn raft(r: &Raft) -> Value {
    let blobs = r
        .blobs
        .iter()
        .map(|b| {
            ObjBuilder::new()
                .num("x", b.x)
                .num("y", b.y)
                .num("radius", b.radius)
                .opt_num("birthEpoch", b.birth_epoch)
                .build()
        })
        .collect();
    ObjBuilder::new()
        .num("id", r.id)
        .put("name", Value::str_or_null(&r.name))
        .put("blobs", Value::List(blobs))
        .opt_num("noMergeUntilEpoch", r.no_merge_until_epoch)
        .build()
}

fn feature(f: &TerrainFeature) -> Value {
    let b = ObjBuilder::new()
        .num("x", f.x)
        .num("y", f.y)
        .num("thickness", f.thickness)
        .num("tangentX", f.tangent_x)
        .num("tangentY", f.tangent_y)
        .put(
            "kind",
            Value::Str(
                match f.kind {
                    FeatureKind::Range => "range",
                    FeatureKind::Trench => "trench",
                }
                .into(),
            ),
        )
        .put("subsides", Value::Bool(f.subsides))
        .num("plateA", f.plate_a)
        .num("plateB", f.plate_b)
        .put(
            "movesWithPlate",
            match f.moves_with {
                MovesWith::Plate(p) => Value::num(p),
                MovesWith::Both => Value::Str("both".into()),
            },
        )
        .num("epochsSinceDeposit", f.epochs_since_deposit);
    // The optional keys in the order TypeScript gave them.
    let volcanic = |b: ObjBuilder| b.opt("volcanic", f.volcanic.map(Value::Bool));
    let shortening = |b: ObjBuilder| b.opt_num("shorteningKmPerMyr", f.shortening_km_per_myr);
    if f.shortening_first {
        volcanic(shortening(b)).build()
    } else {
        shortening(volcanic(b)).build()
    }
}

pub fn plume(p: &Plume) -> Value {
    ObjBuilder::new()
        .num("x", p.x)
        .num("y", p.y)
        .num("id", p.id as f64)
        .num("birthEpoch", p.birth_epoch)
        .build()
}

/// A volcano the map marks (`Volcano` of tectonics/volcanoes.ts until
/// 2026-10-30): `{ x, y, thickness, kind }`, the kind `hotspot`, `flood` or
/// `arc`.
pub fn volcano(v: &Volcano) -> Value {
    let kind = match v.kind {
        VolcanoKind::Hotspot => "hotspot",
        VolcanoKind::Flood => "flood",
        VolcanoKind::Arc => "arc",
        VolcanoKind::ExtinctArc => "extinctArc",
    };
    ObjBuilder::new()
        .num("x", v.x)
        .num("y", v.y)
        .num("thickness", v.thickness)
        .put("kind", Value::Str(kind.to_string()))
        .build()
}

fn suture(s: &Suture) -> Value {
    ObjBuilder::new()
        .num("x", s.x)
        .num("y", s.y)
        .num("tangentX", s.tangent_x)
        .num("tangentY", s.tangent_y)
        .num("epoch", s.epoch)
        .build()
}

/// `serializePlateSimulation`'s object, its keys in its order.
pub fn snapshot(s: &PlateSimulationSnapshot) -> Value {
    let list = |v: Vec<Value>| Value::List(v);
    ObjBuilder::new()
        .num("width", s.width)
        .num("height", s.height)
        .num("initialPlateCount", s.initial_plate_count)
        .put(
            "seeds",
            list(
                s.seeds
                    .iter()
                    .map(|p| ObjBuilder::new().num("x", p.x).num("y", p.y).build())
                    .collect(),
            ),
        )
        .put("motions", list(s.motions.iter().map(motion).collect()))
        .put("ages", Value::nums(&s.ages))
        .put("rafts", list(s.rafts.iter().map(raft).collect()))
        .put("features", list(s.features.iter().map(feature).collect()))
        .num("epoch", s.epoch)
        .opt_num("archeanEpochs", s.archean_epochs)
        .opt_num("epochMa", s.epoch_ma)
        .opt_num("sedimentExportM3", s.sediment_export_m3)
        .opt_num("eustaticM", s.eustatic_m)
        .opt(
            "climateHistory",
            s.climate_history.as_ref().map(|h| {
                list(
                    h.iter()
                        .map(|r| {
                            ObjBuilder::new()
                                .num("epoch", r.epoch)
                                .num("meanLandTempC", r.mean_land_temp_c)
                                .num("iceVolumeKm3", r.ice_volume_km3)
                                .num("seaLevelM", r.sea_level_m)
                                .build()
                        })
                        .collect(),
                )
            }),
        )
        .opt(
            "lakeAges",
            s.lake_ages.as_ref().map(|a| {
                list(
                    a.iter()
                        .map(|r| {
                            ObjBuilder::new()
                                .num("x", r.x)
                                .num("y", r.y)
                                .num("level", r.level)
                                .num("ageMa", r.age_ma)
                                .build()
                        })
                        .collect(),
                )
            }),
        )
        .num("warpSeed", s.warp_seed)
        .put("supercontinentActive", Value::Bool(s.supercontinent_active))
        .num(
            "continentalRiftCooldownUntil",
            s.continental_rift_cooldown_until,
        )
        .opt(
            "hotspots",
            s.hotspots
                .as_ref()
                .map(|h| list(h.iter().map(plume).collect())),
        )
        .opt(
            "sutures",
            s.sutures
                .as_ref()
                .map(|h| list(h.iter().map(suture).collect())),
        )
        .num("rngState", s.rng_state)
        .build()
}

fn event_type(t: SimEventType) -> &'static str {
    match t {
        SimEventType::ContinentCollided => "continent_collided",
        SimEventType::ContinentBrokeUp => "continent_broke_up",
        SimEventType::SupercontinentFormed => "supercontinent_formed",
        SimEventType::OceanicCreated => "oceanic_created",
        SimEventType::OceanicSubducted => "oceanic_subducted",
    }
}

/// A `SimEvent`.
pub fn event(e: &SimEvent) -> Value {
    let s = |v: &Option<String>| v.as_ref().map(|s| Value::Str(s.clone()));
    ObjBuilder::new()
        .put("type", Value::Str(event_type(e.kind).into()))
        .opt("name", s(&e.name))
        .opt("nameA", s(&e.name_a))
        .opt("nameB", s(&e.name_b))
        .opt_num("x", e.x)
        .opt_num("y", e.y)
        .opt_num("dirX", e.dir_x)
        .opt_num("dirY", e.dir_y)
        .opt_num("plateIndex", e.plate_index.map(|i| i as f64))
        .opt_num("otherPlateIndex", e.other_plate_index.map(|i| i as f64))
        .build()
}

/// A field mesh's values as the save holds them (`SavedField`).
pub fn saved_field(f: &SavedField) -> Value {
    ObjBuilder::new()
        .put("values", Value::F64s(f.values.clone()))
        .num("cells", f.cells as f64)
        .num("spacingM", f.spacing_m)
        .build()
}

/// The coupled terrain as the save's bytes (the runtime's
/// `serializeMeshTerrain` over the coupled terrain): the mesh's codec,
/// the heights, the column, and what the last epoch left.
pub fn mesh_payload(t: &CoupledTerrain) -> Value {
    let order: Vec<i32> = (0..t.mesh.alive_vertices as i32).collect();
    let serial = encode_mesh(&t.mesh, &order);
    let count = serial.count;
    let z = t.z[..count].to_vec();
    let per_node = |values: &[f32], fallback: &[f32]| -> Vec<f32> {
        if values.len() >= count {
            values[..count].to_vec()
        } else {
            fallback.to_vec()
        }
    };
    let zeros = vec![0f32; count];
    ObjBuilder::new()
        .num("count", count as f64)
        .put("nodes", Value::F32s(serial.nodes))
        .put("connectivity", Value::U8s(serial.connectivity))
        .put("z", Value::F32s(z.clone()))
        .put("column", Value::U8s(encode_column(&t.column, count)))
        .put(
            "sedimentFlux",
            Value::F32s(per_node(&t.sediment_flux, &zeros)),
        )
        .put("preErosionZ", Value::F32s(per_node(&t.pre_erosion_z, &z)))
        .opt(
            "ice",
            (t.ice.len() >= count).then(|| Value::F32s(t.ice[..count].to_vec())),
        )
        .build()
}

/// A vector field on the climate's field mesh for the screen's marks
/// (`meshVectorPayload`): `{ cells, spacingM, e, s }`, Float64.
pub fn mesh_vectors(spacing_m: f64, e: &[f64], s: &[f64]) -> Value {
    ObjBuilder::new()
        .num("cells", e.len() as f64)
        .num("spacingM", spacing_m)
        .put("e", Value::F64s(e.to_vec()))
        .put("s", Value::F64s(s.to_vec()))
        .build()
}

/// The chart's fields of a climate for the screen
/// (`WorkerClimateDataMessage` less its type, flags and resolution).
pub struct ClimateData<'a> {
    pub temperature: &'a [f32],
    pub wind: &'a [f32],
    pub currents: &'a [f32],
    pub current_anomaly: &'a [f32],
    pub precipitation: &'a [f32],
    pub seasonal_amplitude: &'a [f32],
    pub monsoon_index: &'a [f32],
}

pub fn climate_data(
    c: &ClimateData,
    wind_mesh: Value,
    currents_mesh: Value,
    koppen: Vec<u8>,
    biomes: Vec<u8>,
) -> Value {
    ObjBuilder::new()
        .put("temperature", Value::F32s(c.temperature.to_vec()))
        .put("wind", Value::F32s(c.wind.to_vec()))
        .put("windMesh", wind_mesh)
        .put("currentsMesh", currents_mesh)
        .put("currents", Value::F32s(c.currents.to_vec()))
        .put("currentAnomaly", Value::F32s(c.current_anomaly.to_vec()))
        .put("precipitation", Value::F32s(c.precipitation.to_vec()))
        .put(
            "seasonalAmplitude",
            Value::F32s(c.seasonal_amplitude.to_vec()),
        )
        .put("monsoonIndex", Value::F32s(c.monsoon_index.to_vec()))
        .put("koppen", Value::U8s(koppen))
        .put("biomes", Value::U8s(biomes))
        .build()
}

/// `RefinedClimate` without its solves (the runtime's `structuredCopy`).
pub fn refined_climate(r: &RefinedClimate) -> Value {
    let f = |a: &[f32]| Value::F32s(a.to_vec());
    ObjBuilder::new()
        .num("months", r.months as f64)
        .num("cells", r.cells as f64)
        .num("spacingM", r.spacing_m)
        .put("temperature", f(&r.temperature))
        .put("precipitation", f(&r.precipitation))
        .put("pressure", f(&r.pressure))
        .put("windE", f(&r.wind_e))
        .put("windS", f(&r.wind_s))
        .put("currentE", f(&r.current_e))
        .put("currentS", f(&r.current_s))
        .put("currentAnomaly", f(&r.current_anomaly))
        .put("upwelling", f(&r.upwelling))
        .put("salinity", f(&r.salinity))
        .put("deepWater", f(&r.deep_water))
        .put("fog", f(&r.fog))
        .put("foehn", f(&r.foehn))
        .put(
            "reliability",
            ObjBuilder::new()
                .put("rainVariability", f(&r.reliability.rain_variability))
                .put("ensoPattern", f(&r.reliability.enso_pattern))
                .num("ensoPeriodYears", r.reliability.enso_period_years)
                .num("ensoStrength", r.reliability.enso_strength)
                .build(),
        )
        .put(
            "storms",
            ObjBuilder::new()
                .put("cyclone", f(&r.storms.cyclone))
                .put("tornado", f(&r.storms.tornado))
                .put("blizzard", f(&r.storms.blizzard))
                .put("dust", f(&r.storms.dust))
                .put("thunder", f(&r.storms.thunder))
                .build(),
        )
        .build()
}

/// The refinement for the screen (`WorkerClimateRefinedMessage` less its
/// type and resolution): the chart's months and fields, the values, the
/// Köppen classes per pixel.
pub fn climate_refined(chart: &RefinedClimateChart, r: &RefinedClimate, koppen: Vec<u8>) -> Value {
    let f = |a: &[f32]| Value::F32s(a.to_vec());
    ObjBuilder::new()
        .num("months", chart.months as f64)
        .put("refined", refined_climate(r))
        .put("temperature", f(&chart.temperature))
        .put("precipitation", f(&chart.precipitation))
        .put("koppen", Value::U8s(koppen))
        .put("fog", f(&chart.fog))
        .put("foehn", f(&chart.foehn))
        .put("rainVariability", f(&chart.reliability.rain_variability))
        .put("ensoPattern", f(&chart.reliability.enso_pattern))
        .num("ensoPeriodYears", chart.reliability.enso_period_years)
        .num("ensoStrength", chart.reliability.enso_strength)
        .put("salinity", f(&chart.salinity))
        .put("deepWater", f(&chart.deep_water))
        .put("cyclone", f(&chart.storms.cyclone))
        .put("tornado", f(&chart.storms.tornado))
        .put("blizzard", f(&chart.storms.blizzard))
        .put("dust", f(&chart.storms.dust))
        .put("thunder", f(&chart.storms.thunder))
        .put("pressure", f(&chart.pressure))
        .put("wind", f(&chart.wind))
        .put("currents", f(&chart.currents))
        .put("currentAnomaly", f(&chart.current_anomaly))
        .put("upwelling", f(&chart.upwelling))
        .build()
}

/// `WaterBody`, in the key order `computeLakesOn` writes.
pub fn water_body(b: &WaterBody) -> Value {
    let kind = match b.kind {
        WaterKind::Lake => "lake",
        WaterKind::Terminal => "terminal",
        WaterKind::Dry => "dry",
    };
    ObjBuilder::new()
        .num("id", b.id as f64)
        .put("kind", Value::Str(kind.into()))
        .num("level", b.level)
        .num("spill", b.spill)
        .num("floor", b.floor)
        .num("seedX", b.seed_x)
        .num("seedY", b.seed_y)
        .num("outletX", b.outlet_x)
        .num("outletY", b.outlet_y)
        .num("cells", b.cells)
        .put("frozen", Value::Bool(b.frozen))
        .put("subglacial", Value::Bool(b.subglacial))
        .build()
}

fn river_node(n: &RiverNode) -> Value {
    let kind = match n.kind {
        RiverNodeKind::Source => "source",
        RiverNodeKind::Junction => "junction",
        RiverNodeKind::Mouth => "mouth",
        RiverNodeKind::Inlet => "inlet",
        RiverNodeKind::Outlet => "outlet",
    };
    ObjBuilder::new()
        .num("id", n.id as f64)
        .put("kind", Value::Str(kind.into()))
        .num("cell", n.cell as f64)
        .num("x", n.x)
        .num("y", n.y)
        .num("body", n.body)
        .num("catchmentCells", n.catchment_cells)
        .build()
}

fn river_reach(r: &RiverReach) -> Value {
    let kind = match r.kind {
        RiverReachKind::River => "river",
        RiverReachKind::Lake => "lake",
    };
    let regime = match r.regime {
        RiverRegime::Perennial => "perennial",
        RiverRegime::Intermittent => "intermittent",
        RiverRegime::Ephemeral => "ephemeral",
    };
    ObjBuilder::new()
        .num("id", r.id as f64)
        .put("kind", Value::Str(kind.into()))
        .num("from", r.from as f64)
        .num("to", r.to as f64)
        .num("cellStart", r.cell_start as f64)
        .num("cellCount", r.cell_count as f64)
        .num("dischargeIn", r.discharge_in)
        .num("dischargeOut", r.discharge_out)
        .num("widthPx", r.width_px)
        .num("lengthKm", r.length_km)
        .num("dropM", r.drop_m)
        .num("slope", r.slope)
        .num("sedimentM3", r.sediment_m3)
        .num("bank", r.bank)
        .num("order", r.order)
        .put("regime", Value::Str(regime.into()))
        .num("runoffOut", r.runoff_out)
        .put("springFed", Value::Bool(r.spring_fed))
        .build()
}

/// `SpringFeature`.
pub fn spring(s: &SpringFeature) -> Value {
    ObjBuilder::new()
        .num("id", s.id as f64)
        .num("cell", s.cell as f64)
        .num("x", s.x)
        .num("y", s.y)
        .num("elevation", s.elevation)
        .put("oasis", Value::Bool(s.oasis))
        .build()
}

fn course(c: &RiverCourse) -> Value {
    let pattern = match c.pattern {
        RiverPattern::Straight => "straight",
        RiverPattern::Meandering => "meandering",
        RiverPattern::Braided => "braided",
        RiverPattern::Anastomosing => "anastomosing",
    };
    let lines = |l: &[Vec<f32>]| Value::List(l.iter().map(|x| Value::F32s(x.clone())).collect());
    ObjBuilder::new()
        .num("reach", c.reach as f64)
        .put("pattern", Value::Str(pattern.into()))
        .num("dischargeM3s", c.discharge_m3s)
        .num("widthM", c.width_m)
        .num("depthM", c.depth_m)
        .num("slope", c.slope)
        .num("bankStrength", c.bank_strength)
        .put("lines", lines(&c.lines))
        .put("lineWidth", Value::nums(&c.line_width))
        .num("sinuosity", c.sinuosity)
        .num("beltWidthM", c.belt_width_m)
        .put("oxbows", lines(&c.oxbows))
        .put("lobeAges", Value::nums(&c.lobe_ages))
        .build()
}

/// `RiverGraph` on the mesh, in the key order `buildRiverGraph` writes,
/// the springs and the courses after as the features add them: the world
/// layer's `serializeRiverGraph` makes the save's JSON of it.
pub fn river_graph(g: &RiverGraph) -> Value {
    ObjBuilder::new()
        .num("width", g.width)
        .num("height", g.height)
        .put("substrate", Value::Str("mesh".into()))
        .put(
            "nodes",
            Value::List(g.nodes.iter().map(river_node).collect()),
        )
        .put(
            "reaches",
            Value::List(g.reaches.iter().map(river_reach).collect()),
        )
        .put("cells", Value::I32s(g.cells.clone()))
        .put("cellX", Value::F32s(g.cell_x.clone()))
        .put("cellY", Value::F32s(g.cell_y.clone()))
        .put(
            "bodies",
            Value::List(g.bodies.iter().map(water_body).collect()),
        )
        .opt(
            "springs",
            g.springs
                .as_ref()
                .map(|s| Value::List(s.iter().map(spring).collect())),
        )
        .opt(
            "courses",
            g.courses
                .as_ref()
                .map(|c| Value::List(c.iter().map(course).collect())),
        )
        .build()
}

/// `CoastReach`.
pub fn coast_reach(r: &CoastReach) -> Value {
    let kind = match r.coast_type {
        CoastType::Rocky => "rocky",
        CoastType::Cliff => "cliff",
        CoastType::Beach => "beach",
        CoastType::Marsh => "marsh",
        CoastType::Delta => "delta",
    };
    ObjBuilder::new()
        .num("id", r.id as f64)
        .num("nodeStart", r.node_start as f64)
        .num("nodeCount", r.node_count as f64)
        .num("lengthKm", r.length_km)
        .num("exposure", r.exposure)
        .num("reliefM", r.relief_m)
        .num("hardness", r.hardness)
        .num("supply", r.supply)
        .put("type", Value::Str(kind.into()))
        .num("mouthReach", r.mouth_reach)
        .build()
}

/// `SedimentBasin`.
pub fn sediment_basin(b: &SedimentBasin) -> Value {
    let kind = match b.kind {
        BasinKind::Alluvial => "alluvial",
        BasinKind::Marine => "marine",
    };
    ObjBuilder::new()
        .num("id", b.id as f64)
        .put("kind", Value::Str(kind.into()))
        .num("nodes", b.nodes as f64)
        .num("areaKm2", b.area_km2)
        .num("volumeKm3", b.volume_km3)
        .num("meanThicknessM", b.mean_thickness_m)
        .num("maxThicknessM", b.max_thickness_m)
        .num("x", b.x)
        .num("y", b.y)
        .put(
            "mouthReaches",
            Value::List(
                b.mouth_reaches
                    .iter()
                    .map(|&m| Value::num(m as f64))
                    .collect(),
            ),
        )
        .num("catchmentKm2", b.catchment_km2)
        .num("cratonAge", b.craton_age)
        .num("hardness", b.hardness)
        .build()
}

/// `RiverPolylines`.
pub fn river_polylines(r: &RiverPolylines) -> Value {
    ObjBuilder::new()
        .put("points", Value::F32s(r.points.clone()))
        .put("lengths", Value::U32s(r.lengths.clone()))
        .put("regimes", Value::U8s(r.regimes.clone()))
        .build()
}

/// A mesh level as its artifact holds it (`meshLevelToArtifact`): the
/// mesh's codec in its own numbering, the heights, the waters, and the
/// land fields when given (`LevelLand`, docs/decisions/level-waters.md).
pub fn mesh_level_artifact(
    level: u32,
    mesh: &PeriodicTriangulation,
    z: &[f32],
    bodies: &[WaterBody],
    graph: Option<&RiverGraph>,
    rivers: Option<&RiverPolylines>,
    land: Option<&LevelLand<'_>>,
) -> Value {
    let order: Vec<i32> = (0..mesh.alive_vertices as i32).collect();
    let serial = encode_mesh(mesh, &order);
    let count = serial.count;
    ObjBuilder::new()
        .num("level", level)
        .num("count", count as f64)
        .put("nodes", Value::F32s(serial.nodes))
        .put("connectivity", Value::U8s(serial.connectivity))
        .put("z", Value::F32s(z[..count].to_vec()))
        .put(
            "waterBodies",
            Value::List(bodies.iter().map(water_body).collect()),
        )
        .put("graph", graph.map_or(Value::Null, river_graph))
        .put("rivers", rivers.map_or(Value::Null, river_polylines))
        .put("land", land.map_or(Value::Null, |l| level_land(l, count)))
        .build()
}

/// What the ecology reads of a level's land, per node in the mesh's
/// numbering, besides the heights and the climate (`EcologyInputs`): the
/// hydrology's products on the level's mesh, and the world's features.
pub struct LevelLand<'a> {
    pub land: &'a [u8],
    /// The map's biome (the save's `mesh/biome.u8`: with the ice model's
    /// glaciers), and the one the ecology reads (without them).
    pub biome: &'a [u8],
    pub ecology_biome: &'a [u8],
    pub koppen: &'a [u8],
    pub discharge: &'a [f32],
    pub lake_depth: &'a [f32],
    pub salt_flat: &'a [u8],
    pub water_table: Option<&'a [f32]>,
    /// The temperature at the nodes, °C (TEG-109): the year's mean, and
    /// the months, month-major (`PointMonths`: the month count, then its
    /// values, `values.len() / months` a month). No months for a climate
    /// without the refinement.
    pub temperature: &'a [f32],
    pub temperature_months: Option<(usize, &'a [f32])>,
    pub craton_age: &'a [f32],
    pub oases: &'a [(f64, f64)],
    pub volcanoes: &'a [Volcano],
    pub orogen_points: &'a [(f64, f64)],
    pub max_discharge: f64,
    /// The ecology's fields by id, a byte a node as the screen's fine
    /// fields are coded (`encode_fine_field`); empty before an ecology run.
    pub ecology: &'a [(&'static str, Vec<u8>)],
    /// The same fields with the dry shelf as land (`shelf_ecology`, TEG-13):
    /// a byte a node, ECOLOGY_FINE_OCEAN off the shelf; empty before an
    /// ecology run.
    pub shelf_ecology: &'a [(&'static str, Vec<u8>)],
}

/// A level's temperature as its files give it back (`land_codes`):
/// the year's mean and the swing in their steps, each month a code of
/// the swing about the mean.
struct LevelTemperature {
    mean: Value,
    swing: Value,
    months: Value,
}

/// The temperature per node in its codes (TEG-109): the mean a step 0.1
/// °C, the swing (the months' largest distance from the mean) a step 0.5
/// °C up, each month as 127ths of the swing about the mean. The values
/// are the codes' values, so a level read back from its files is the
/// same level.
fn level_temperature(l: &LevelLand<'_>, count: usize) -> LevelTemperature {
    use crate::formats::land_codes;
    let mean: Vec<f32> = l.temperature[..count]
        .iter()
        .map(|&t| land_codes::temperature_of(land_codes::temperature(t)))
        .collect();
    let Some((months, values)) = l.temperature_months.filter(|&(m, _)| m > 0) else {
        return LevelTemperature {
            mean: Value::F32s(mean),
            swing: Value::Null,
            months: Value::Null,
        };
    };
    let stride = values.len() / months;
    let swing: Vec<f32> = (0..count)
        .map(|v| {
            let far = (0..months)
                .map(|m| (values[m * stride + v] as f64 - mean[v] as f64).abs())
                .fold(0.0, f64::max);
            land_codes::temperature_swing_of(land_codes::temperature_swing(far))
        })
        .collect();
    let codes = (0..months)
        .flat_map(|m| (0..count).map(move |v| (m, v)))
        .map(|(m, v)| land_codes::temperature_month(values[m * stride + v], mean[v], swing[v]))
        .collect();
    LevelTemperature {
        mean: Value::F32s(mean),
        swing: Value::F32s(swing),
        months: Value::I8s(codes),
    }
}

/// `LevelLand` as the artifact holds it: the per-node fields cut to the
/// mesh's `count` nodes, the points as `[x, y, …]`, the volcanoes as
/// `[x, y, thickness, kind, …]` (kind 0 hotspot, 1 flood, 2 arc, 3 extinct
/// arc; DEC-0053).
fn level_land(l: &LevelLand<'_>, count: usize) -> Value {
    let temperature = level_temperature(l, count);
    let cut_u8 = |v: &[u8]| Value::U8s(v[..count].to_vec());
    let cut_f32 = |v: &[f32]| Value::F32s(v[..count].to_vec());
    let points = |p: &[(f64, f64)]| Value::F64s(p.iter().flat_map(|&(x, y)| [x, y]).collect());
    let volcanoes = l
        .volcanoes
        .iter()
        .flat_map(|v| {
            let kind = match v.kind {
                VolcanoKind::Hotspot => 0.0,
                VolcanoKind::Flood => 1.0,
                VolcanoKind::Arc => 2.0,
                VolcanoKind::ExtinctArc => 3.0,
            };
            [v.x, v.y, v.thickness, kind]
        })
        .collect();
    ObjBuilder::new()
        .put("land", cut_u8(l.land))
        .put("biome", cut_u8(l.biome))
        .put("ecologyBiome", cut_u8(l.ecology_biome))
        .put("koppen", cut_u8(l.koppen))
        .put("discharge", cut_f32(l.discharge))
        .put("lakeDepth", cut_f32(l.lake_depth))
        .put("saltFlat", cut_u8(l.salt_flat))
        .put("waterTable", l.water_table.map_or(Value::Null, cut_f32))
        .put("temperature", temperature.mean)
        .put("temperatureSwing", temperature.swing)
        .put("temperatureMonths", temperature.months)
        .put("cratonAge", cut_f32(l.craton_age))
        .put("oases", points(l.oases))
        .put("volcanoes", Value::F64s(volcanoes))
        .put("orogenPoints", points(l.orogen_points))
        .num("maxDischarge", l.max_discharge)
        .put(
            "ecology",
            Value::Obj(
                l.ecology
                    .iter()
                    .map(|(id, codes)| (Cow::Borrowed(*id), Value::U8s(codes[..count].to_vec())))
                    .collect(),
            ),
        )
        .put(
            "shelfEcology",
            Value::Obj(
                l.shelf_ecology
                    .iter()
                    .map(|(id, codes)| (Cow::Borrowed(*id), Value::U8s(codes[..count].to_vec())))
                    .collect(),
            ),
        )
        .build()
}
