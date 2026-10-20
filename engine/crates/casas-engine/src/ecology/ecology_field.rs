//! `ecology/ecologyField.ts`: the ecology layer — the finished climate and
//! terrain turned into resource and suitability fields per node of the
//! terrain mesh, the carrying capacity through its two knobs, a field's
//! months, and the fields' rasters for the chart. A function, not a
//! simulation; the TypeScript file explains each rule.

use crate::climate::biomes::biome;
use crate::climate::climate_field::{CLIMATE_RES_X, CLIMATE_RES_Y};
use crate::climate::climate_points::{PointClimate, PointMonths};
use crate::core::det_math::{det_exp, det_pow};
use crate::core::domain::{Domain, DomainGrid};
use crate::core::interpolation::{clamp01, smoothstep};
use crate::core::js;
use crate::elevation::elevation_scale::{SEA_LEVEL, meters_to_elevation};
use crate::elevation::globe_noise::globe_octave_on;
use crate::mesh::mesh_neighbourhood::{
    MeshGeometry, Neighbourhoods, boundary_density, discs_around, gaussian_halos, max_within,
    mean_within, mesh_geometry, neighbourhoods, slope_of,
};
use crate::mesh::mesh_raster::{TriangleRaster, rasterise_node_part, triangle_raster};
use crate::mesh::periodic_delaunay::PeriodicTriangulation;
use crate::tectonics::volcanoes::{Volcano, VolcanoKind};

use super::ecology_tune_params::{ECOLOGY_TUNING, pasture_by_biome, timber_by_biome};

/// A node the layer does not score (open water).
pub const ECOLOGY_OCEAN: f32 = -1.0;

/// The fields, in the save's layer order (`ECOLOGY_FIELD_IDS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EcologyField {
    CarryingCapacity,
    Arable,
    Fish,
    Game,
    Pasture,
    Timber,
    Salt,
    ToolStone,
    Copper,
    Tin,
    Iron,
    Gold,
    Silver,
    Gems,
}

pub const ECOLOGY_FIELDS: [EcologyField; 14] = [
    EcologyField::CarryingCapacity,
    EcologyField::Arable,
    EcologyField::Fish,
    EcologyField::Game,
    EcologyField::Pasture,
    EcologyField::Timber,
    EcologyField::Salt,
    EcologyField::ToolStone,
    EcologyField::Copper,
    EcologyField::Tin,
    EcologyField::Iron,
    EcologyField::Gold,
    EcologyField::Silver,
    EcologyField::Gems,
];

impl EcologyField {
    pub fn index(self) -> usize {
        self as usize
    }
}

/// A fine field's byte for the sea, and the step of the others.
pub const ECOLOGY_FINE_OCEAN: u8 = 255;
pub const ECOLOGY_FINE_STEP: f64 = 3.0 / 254.0;

pub fn encode_fine_field(field: &[f32]) -> Vec<u8> {
    field
        .iter()
        .map(|&v| {
            if v == ECOLOGY_OCEAN {
                ECOLOGY_FINE_OCEAN
            } else {
                js::min(254.0, js::max(0.0, js::round(v as f64 / ECOLOGY_FINE_STEP))) as u8
            }
        })
        .collect()
}

pub fn decode_fine_value(code: u8) -> f64 {
    if code == ECOLOGY_FINE_OCEAN {
        ECOLOGY_OCEAN as f64
    } else {
        code as f64 * ECOLOGY_FINE_STEP
    }
}

/// The step's knobs (`EcologyParams` in TypeScript).
#[derive(Clone, Debug, Default)]
pub struct EcologyParams {
    pub carrying_capacity: f64,
    pub concentration: f64,
    pub province_strength: f64,
    /// Per-field abundance multipliers; None is 1.
    pub weights: [Option<f64>; 14],
    pub tin_rarity: Option<f64>,
}

/// Everything the step reads, per vertex slot of the terrain mesh.
pub struct EcologyInputs<'a> {
    pub z: &'a [f32],
    pub land: &'a [u8],
    pub climate: &'a PointClimate,
    pub biomes: &'a [u8],
    pub discharge: Option<&'a [f32]>,
    pub max_discharge: f64,
    pub lake_depth: Option<&'a [f32]>,
    pub salt_flat: Option<&'a [u8]>,
    pub water_table: Option<&'a [f32]>,
    pub oases: &'a [(f64, f64)],
    pub volcanoes: &'a [Volcano],
    pub orogen_points: &'a [(f64, f64)],
    pub craton_age: &'a [f32],
    pub warp_seed: u32,
}

fn productivity(temp_c: f64, precip_mm: f64) -> f64 {
    let npp_temp = 1.0 / (1.0 + det_exp(1.315 - 0.119 * temp_c));
    let npp_precip = 1.0 - det_exp(-0.000664 * js::max(0.0, precip_mm));
    js::min(npp_temp, npp_precip)
}

fn sea_mixing(temp_c: f64) -> f64 {
    let t = &ECOLOGY_TUNING;
    if temp_c < t.fish_mix_ice_c {
        return clamp01(1.0 - (t.fish_mix_ice_c - temp_c) / t.fish_mix_ice_span_c);
    }
    clamp01((t.fish_mix_warm_c - temp_c) / (t.fish_mix_warm_c - t.fish_mix_full_c))
}

fn arid_warm(temp_c: f64, precip_mm: f64) -> f64 {
    clamp01(1.0 - precip_mm / ECOLOGY_TUNING.salt_arid_precip) * clamp01(temp_c / 25.0)
}

/// The fields per node before the sliders (indices as `EcologyField`).
pub struct EcologyRaw {
    pub arable: Vec<f32>,
    pub fish: Vec<f32>,
    pub game: Vec<f32>,
    pub pasture: Vec<f32>,
    pub timber: Vec<f32>,
    pub salt: Vec<f32>,
    pub tool_stone: Vec<f32>,
    pub copper: Vec<f32>,
    pub iron: Vec<f32>,
    pub gold: Vec<f32>,
    pub silver: Vec<f32>,
}

/// What a month's fields need.
pub struct EcologySeasons {
    pub months: PointMonths,
    pub arable_factor: Vec<f32>,
    pub field_water: Vec<f32>,
    pub edge_factor: Vec<f32>,
    pub pasture_year: Vec<f32>,
    pub npp_year: Vec<f32>,
    pub salt_coast: Vec<f32>,
    pub salt_flat: Option<Vec<u8>>,
    pub sea_rich_static: Vec<f32>,
    pub access: Vec<f32>,
    pub freshwater: Vec<f32>,
    pub coast: Neighbourhoods,
}

/// The physics of the ecology, every field before the sliders
/// (`EcologyBase` in TypeScript). The mesh is the caller's.
pub struct EcologyBase {
    pub geo: MeshGeometry,
    pub slots: usize,
    pub land: Vec<u8>,
    pub sea: Vec<u8>,
    pub raw: EcologyRaw,
    pub gem_belt: Vec<f32>,
    pub aridity: Vec<f32>,
    pub tin_points: Vec<(f64, f64)>,
    pub province_deviation: Vec<f32>,
    pub seasonal: Option<EcologySeasons>,
    pub raster: Option<TriangleRaster>,
}

/// The seasonal fields.
pub const SEASONAL_ECOLOGY_FIELDS: [EcologyField; 5] = [
    EcologyField::Arable,
    EcologyField::Fish,
    EcologyField::Game,
    EcologyField::Pasture,
    EcologyField::Salt,
];

pub fn is_seasonal_ecology_field(id: EcologyField) -> bool {
    SEASONAL_ECOLOGY_FIELDS.contains(&id)
}

pub fn compute_ecology(
    mesh: &mut PeriodicTriangulation,
    inputs: &EcologyInputs<'_>,
    params: &EcologyParams,
) -> Vec<Vec<f32>> {
    let eco = prepare_ecology(mesh, inputs);
    apply_ecology(&eco, mesh, params)
}

pub fn prepare_ecology(
    mesh: &mut PeriodicTriangulation,
    inputs: &EcologyInputs<'_>,
) -> EcologyBase {
    let (z, land, climate) = (inputs.z, inputs.land, inputs.climate);
    let t = &ECOLOGY_TUNING;
    let n = mesh.vertex_slots();
    let domain = mesh.domain.clone();
    let geo = mesh_geometry(mesh, domain.metres_per_unit);
    let mut sea = vec![0u8; n];
    let mut sea_f = vec![0f32; n];
    for v in 0..n {
        if mesh.v_alive[v] != 0 && land[v] == 0 {
            sea[v] = 1;
            sea_f[v] = 1.0;
        }
    }
    let months = climate.months.as_ref();
    let month_count = months.map_or(1, |m| m.count);

    let biome_at: Vec<u8> = (0..n)
        .map(|v| {
            if land[v] != 0 {
                inputs.biomes[v]
            } else {
                biome::OCEAN
            }
        })
        .collect();

    // Water and sea within reach.
    let coast = neighbourhoods(&geo.cells, mesh, t.coast_reach_m, None);
    let water = neighbourhoods(&geo.cells, mesh, t.water_reach_m, Some(land));
    let placer = neighbourhoods(&geo.cells, mesh, t.placer_reach_m, Some(land));
    let ecotone = neighbourhoods(&geo.cells, mesh, t.ecotone_reach_m, Some(land));

    let shelf_floor = SEA_LEVEL - meters_to_elevation(t.fish_shelf_depth_m);
    let shallow: Vec<f32> = (0..n)
        .map(|v| f32::from(u8::from(sea[v] != 0 && z[v] as f64 > shelf_floor)))
        .collect();
    let shelf_share = mean_within(&coast, &shallow);
    let mut sea_rich = vec![0f32; n];
    let mut sea_rich_static = vec![0f32; n];
    for v in 0..n {
        if sea[v] == 0 {
            continue;
        }
        let rising = climate
            .upwelling
            .as_ref()
            .map_or(0.0, |u| clamp01(u[v] as f64 / t.fish_upwelling_full));
        let cool = sea_mixing(climate.temperature[v] as f64);
        sea_rich_static[v] = (t.fish_sea_base
            + t.fish_shelf_w * shelf_share[v] as f64
            + t.fish_upwelling_w * rising) as f32;
        sea_rich[v] = (sea_rich_static[v] as f64 + t.fish_mixing_w * cool) as f32;
    }
    let rich_sea_near = max_within(&coast, &sea_rich);
    let sea_share = mean_within(&coast, &sea_f);

    // A big river's water per land node, and what lies within reach of it.
    let has_hydrology = inputs.discharge.is_some() && inputs.max_discharge > 0.0;
    let mut river = vec![0f32; n];
    let mut river_root = vec![0f32; n];
    let mut river_wet = vec![0f32; n];
    let mut lake = vec![0f32; n];
    if let Some(discharge) = inputs.discharge.filter(|_| inputs.max_discharge > 0.0) {
        for v in 0..n {
            if land[v] == 0 {
                continue;
            }
            let share = js::max(0.0, discharge[v] as f64) / inputs.max_discharge;
            river_root[v] = share.sqrt() as f32;
            river[v] = js::min(
                1.0,
                js::max(0.0, river_root[v] as f64 - t.river_floor) * 2.0,
            ) as f32;
            river_wet[v] = js::min(1.0, share * 4.0) as f32;
        }
    }
    if let Some(depth) = inputs.lake_depth {
        for v in 0..n {
            if depth[v] > 0.0 {
                lake[v] = 1.0;
            }
        }
    }
    let river_near = max_within(&water, &river);
    let river_root_near = max_within(&placer, &river_root);
    let river_wet_near = max_within(&water, &river_wet);
    let lake_near = max_within(&water, &lake);
    let well_near = inputs.water_table.map(|table| {
        let shallow_table: Vec<f32> = (0..n)
            .map(|v| {
                f32::from(u8::from(
                    table[v] >= 0.0 && table[v] as f64 <= t.well_depth_m,
                ))
            })
            .collect();
        max_within(&water, &shallow_table)
    });
    let mut waterlogged = vec![0f32; n];
    if let Some(table) = inputs.water_table {
        for v in 0..n {
            if table[v] >= 0.0 && table[v] as f64 <= t.wetland_table_m {
                waterlogged[v] = 1.0;
            }
        }
    }
    let oasis = discs_around(&geo, mesh, inputs.oases, t.water_reach_m);

    // Game's edges.
    let differs = |a: usize, b: usize| land[b] == 1 && biome_at[a] != biome_at[b];
    let edge_density = boundary_density(&geo, mesh, land, &differs, t.ecotone_counted_on_m);
    let edges = mean_within(&ecotone, &edge_density);

    let slope = slope_of(&geo, mesh, z);

    // Per node.
    let mut arable = vec![0f32; n];
    let mut fish = vec![0f32; n];
    let mut game = vec![0f32; n];
    let mut pasture = vec![0f32; n];
    let mut salt = vec![0f32; n];
    let mut timber = vec![0f32; n];
    let mut flatness = vec![0f32; n];
    let mut wetland = vec![0f32; n];
    let mut aridity = vec![0f32; n];
    let mut craton = vec![0f32; n];
    let keep_months = months.is_some();
    let mut k_arable_factor = vec![0f32; if keep_months { n } else { 0 }];
    let mut k_field_water = k_arable_factor.clone();
    let mut k_edge_factor = k_arable_factor.clone();
    let mut k_npp_year = k_arable_factor.clone();
    let mut k_salt_coast = k_arable_factor.clone();
    let mut k_access = k_arable_factor.clone();
    let mut k_freshwater = k_arable_factor.clone();
    let mc = month_count as f64;
    for v in 0..n {
        if land[v] == 0 {
            continue;
        }
        let flat = 1.0 / (1.0 + t.slope_k * slope[v] as f64 * t.flatness_run_m);
        flatness[v] = flat as f32;

        let field_water = js::max(river_near[v] as f64, t.oasis_w * oasis[v] as f64);
        let herd_water = if has_hydrology || well_near.is_some() {
            js::max(
                river_near[v] as f64,
                well_near.as_ref().map_or(0.0, |w| t.well_w * w[v] as f64),
            )
        } else {
            1.0
        };

        let (mut growing, mut npp, mut arid) = (0.0, 0.0, 0.0);
        for m in 0..month_count {
            let (tc, p) = match months {
                Some(ms) => (
                    ms.temperature[m * n + v] as f64,
                    js::max(0.0, ms.precipitation[m * n + v] as f64),
                ),
                None => (
                    climate.temperature[v] as f64,
                    js::max(0.0, climate.precipitation[v] as f64),
                ),
            };
            if tc >= t.arable_frost_c || months.is_none() {
                growing += productivity(tc, p + t.arable_irrigation_mm * field_water) / mc;
            }
            npp += productivity(tc, p) / mc;
            arid += arid_warm(tc, p) / mc;
        }
        let year_t = climate.temperature[v] as f64;
        let year_p = js::max(0.0, climate.precipitation[v] as f64);

        let risk = climate
            .rain_variability
            .as_ref()
            .map_or(0.0, |r| t.arable_risk_w * r[v] as f64 * (1.0 - field_water));
        arable[v] = (growing * flat * js::max(0.0, 1.0 - risk)) as f32;
        let edge_factor = 1.0 + t.ecotone_bonus * clamp01(edges[v] as f64 / t.ecotone_full_share);
        let salt_coast = t.salt_interior_w
            + (t.salt_coast_w - t.salt_interior_w)
                * js::min(1.0, sea_share[v] as f64 / t.fish_full_sea_share);

        let access = js::min(1.0, sea_share[v] as f64 / t.fish_full_sea_share);
        let freshwater = js::min(
            1.0,
            t.fish_river_w * river_near[v] as f64 + t.fish_lake_w * lake_near[v] as f64,
        );
        fish[v] = (1.0 - det_exp(-(access * rich_sea_near[v] as f64 + freshwater))) as f32;

        game[v] = (npp * edge_factor) as f32;

        let b = biome_at[v];
        let dry = if has_hydrology || well_near.is_some() {
            clamp01((t.pasture_dry_mm - year_p) / (t.pasture_dry_mm - t.pasture_dry_full_mm))
        } else {
            0.0
        };
        pasture[v] = (pasture_by_biome(b).unwrap_or(0.1) * (1.0 - dry * (1.0 - herd_water))) as f32;
        timber[v] = timber_by_biome(b).unwrap_or(0.05) as f32;

        let flat_salt = if inputs.salt_flat.is_some_and(|s| s[v] != 0) {
            t.salt_flat_w
        } else {
            0.0
        };
        salt[v] = clamp01(js::max(flat_salt, arid * salt_coast)) as f32;
        if keep_months {
            k_arable_factor[v] = (flat * js::max(0.0, 1.0 - risk)) as f32;
            k_field_water[v] = field_water as f32;
            k_edge_factor[v] = edge_factor as f32;
            k_npp_year[v] = npp as f32;
            k_salt_coast[v] = salt_coast as f32;
            k_access[v] = access as f32;
            k_freshwater[v] = freshwater as f32;
        }

        let wet = if lake_near[v] > 0.0 {
            1.0
        } else {
            js::max(
                river_wet_near[v] as f64,
                t.wetland_table_w * waterlogged[v] as f64,
            )
        };
        wetland[v] = (flat * wet * clamp01(year_p / 600.0)) as f32;
        aridity[v] = arid_warm(year_t, year_p) as f32;
        craton[v] = js::max(0.0, inputs.craton_age[v] as f64) as f32;
    }

    // The fishing grounds.
    for v in 0..n {
        if sea[v] != 0 {
            fish[v] = (1.0 - det_exp(-(sea_rich[v] as f64))) as f32;
        }
    }

    let seed = inputs.warp_seed as i32;
    let all: Vec<(f64, f64)> = inputs.volcanoes.iter().map(|p| (p.x, p.y)).collect();
    let arc: Vec<(f64, f64)> = inputs
        .volcanoes
        .iter()
        .filter(|p| p.kind == VolcanoKind::Arc)
        .map(|p| (p.x, p.y))
        .collect();
    let obsidian = gaussian_halos(
        &geo,
        mesh,
        &thin_points(&all, t.obsidian_keep, seed ^ 0x0b51_d1a2),
        t.obsidian_radius_m,
    );
    let mut tool_stone = vec![0f32; n];
    for v in 0..n {
        if land[v] != 0 {
            tool_stone[v] = js::max(obsidian[v] as f64, t.flint_base * flatness[v] as f64) as f32;
        }
    }
    let copper = mask_to_land(
        gaussian_halos(
            &geo,
            mesh,
            &thin_points(&arc, t.copper_keep, seed ^ 0xc0bb_e401u32 as i32),
            t.copper_radius_m,
        ),
        land,
    );
    let mut iron = vec![0f32; n];
    let iron_noise = NoiseSampler::new(
        &domain,
        t.iron_deposit_freq_x,
        t.iron_deposit_freq_y,
        (seed ^ 0x51ed_2701) as f64,
    );
    for v in 0..n {
        if land[v] == 0 {
            continue;
        }
        let noise01 = (iron_noise.at(mesh.vx[v], mesh.vy[v]) + 1.0) / 2.0;
        let deposit = t.iron_deposit_floor + (1.0 - t.iron_deposit_floor) * noise01;
        iron[v] = clamp01(js::max(
            t.iron_craton_w * craton[v] as f64 * deposit,
            t.iron_bog_w * wetland[v] as f64,
        )) as f32;
    }
    let lode = gaussian_halos(
        &geo,
        mesh,
        &thin_points(inputs.orogen_points, t.gold_lode_keep, seed ^ 0x601d_feed),
        t.gold_lode_radius_m,
    );
    let arc_halo = gaussian_halos(
        &geo,
        mesh,
        &thin_points(&arc, t.silver_keep, seed ^ 0x5117_e201),
        t.silver_radius_m,
    );
    let gem_belt = gaussian_halos(
        &geo,
        mesh,
        &thin_points(
            inputs.orogen_points,
            t.gem_keep,
            seed ^ 0x9e35_c0deu32 as i32,
        ),
        t.gem_radius_m,
    );
    let mut gold = vec![0f32; n];
    let mut silver = vec![0f32; n];
    for v in 0..n {
        if land[v] == 0 {
            continue;
        }
        let placer_gold = js::min(
            1.0,
            js::max(0.0, river_root_near[v] as f64 - t.gold_placer_sqrt_floor) * t.gold_placer_gain,
        );
        gold[v] = clamp01(t.gold_placer_w * placer_gold + t.gold_lode_w * lode[v] as f64) as f32;
        silver[v] = clamp01(t.silver_w * arc_halo[v] as f64) as f32;
    }

    // The province layer.
    let volcanic = gaussian_halos(&geo, mesh, &all, t.volcanic_province_radius_m);
    let mut province_deviation = vec![0f32; n];
    let province_noise = NoiseSampler::new(
        &domain,
        t.province_noise_freq_x,
        t.province_noise_freq_y,
        inputs.warp_seed as f64,
    );
    for v in 0..n {
        if land[v] == 0 {
            continue;
        }
        province_deviation[v] = (t.volcanic_weight * volcanic[v] as f64
            + t.noise_weight * province_noise.at(mesh.vx[v], mesh.vy[v]))
            as f32;
    }

    let tin_points = thin_points(inputs.orogen_points, t.tin_keep, seed ^ 0x71b2_a903);
    let seasonal = months.map(|ms| EcologySeasons {
        months: ms.clone(),
        arable_factor: k_arable_factor,
        field_water: k_field_water,
        edge_factor: k_edge_factor,
        pasture_year: pasture.clone(),
        npp_year: k_npp_year,
        salt_coast: k_salt_coast,
        salt_flat: inputs.salt_flat.map(|s| s.to_vec()),
        sea_rich_static,
        access: k_access,
        freshwater: k_freshwater,
        coast,
    });
    EcologyBase {
        geo,
        slots: n,
        land: land.to_vec(),
        sea,
        raw: EcologyRaw {
            arable,
            fish,
            game,
            pasture,
            timber,
            salt,
            tool_stone,
            copper,
            iron,
            gold,
            silver,
        },
        gem_belt,
        aridity,
        tin_points,
        province_deviation,
        seasonal,
        raster: None,
    }
}

/// One month (1..12) of a seasonal field, with its abundance slider; None
/// when the climate has no months or the field is not seasonal.
pub fn ecology_month(
    eco: &EcologyBase,
    field: EcologyField,
    month: usize,
    weight: f64,
) -> Option<Vec<f32>> {
    let s = eco.seasonal.as_ref()?;
    if !is_seasonal_ecology_field(field) {
        return None;
    }
    let t = &ECOLOGY_TUNING;
    let (n, land, sea) = (eco.slots, &eco.land, &eco.sea);
    let m = (month.max(1) - 1).min(s.months.count - 1) * n;
    let mut out = vec![ECOLOGY_OCEAN; n];
    if field == EcologyField::Fish {
        let mut rich = vec![0f32; n];
        for v in 0..n {
            if sea[v] == 0 {
                continue;
            }
            rich[v] = (s.sea_rich_static[v] as f64
                + t.fish_mixing_w * sea_mixing(s.months.temperature[m + v] as f64))
                as f32;
            out[v] = (weight * (1.0 - det_exp(-(rich[v] as f64)))) as f32;
        }
        let near = max_within(&s.coast, &rich);
        for v in 0..n {
            if land[v] != 0 {
                out[v] = (weight
                    * (1.0
                        - det_exp(-(s.access[v] as f64 * near[v] as f64 + s.freshwater[v] as f64))))
                    as f32;
            }
        }
        return Some(out);
    }
    for v in 0..n {
        if land[v] == 0 {
            continue;
        }
        if field == EcologyField::Salt && s.salt_flat.as_ref().is_some_and(|f| f[v] != 0) {
            out[v] = (weight * clamp01(t.salt_flat_w)) as f32;
            continue;
        }
        let tc = s.months.temperature[m + v] as f64;
        let p = js::max(0.0, s.months.precipitation[m + v] as f64);
        let value = match field {
            EcologyField::Arable => {
                (if tc >= t.arable_frost_c {
                    productivity(tc, p + t.arable_irrigation_mm * s.field_water[v] as f64)
                } else {
                    0.0
                }) * s.arable_factor[v] as f64
            }
            EcologyField::Game => productivity(tc, p) * s.edge_factor[v] as f64,
            EcologyField::Pasture => {
                if s.npp_year[v] > 0.0 {
                    s.pasture_year[v] as f64 * productivity(tc, p) / s.npp_year[v] as f64
                } else {
                    0.0
                }
            }
            _ => clamp01(arid_warm(tc, p) * s.salt_coast[v] as f64),
        };
        out[v] = (weight * value) as f32;
    }
    Some(out)
}

/// The sliders on the physics: the fields in `ECOLOGY_FIELDS` order.
pub fn apply_ecology(
    eco: &EcologyBase,
    mesh: &mut PeriodicTriangulation,
    params: &EcologyParams,
) -> Vec<Vec<f32>> {
    let t = &ECOLOGY_TUNING;
    let (n, land, raw) = (eco.slots, &eco.land, &eco.raw);
    let scaled = |arr: &[f32], id: EcologyField| -> Vec<f32> {
        let mut out = arr.to_vec();
        let m = params.weights[id.index()].unwrap_or(1.0);
        if m != 1.0 {
            for v in 0..n {
                if land[v] != 0 || (id == EcologyField::Fish && eco.sea[v] != 0) {
                    out[v] = (out[v] as f64 * m) as f32;
                }
            }
        }
        out
    };
    let arable = scaled(&raw.arable, EcologyField::Arable);
    let fish = scaled(&raw.fish, EcologyField::Fish);
    let game = scaled(&raw.game, EcologyField::Game);
    let pasture = scaled(&raw.pasture, EcologyField::Pasture);
    let salt = scaled(&raw.salt, EcologyField::Salt);

    let mut base = vec![0f32; n];
    for v in 0..n {
        if land[v] == 0 {
            continue;
        }
        base[v] = (1.0
            - det_exp(
                -(t.w_arable * arable[v] as f64
                    + t.w_fish * fish[v] as f64
                    + t.w_game * game[v] as f64
                    + t.w_pasture * pasture[v] as f64
                    + t.w_salt_cc * salt[v] as f64),
            )) as f32;
    }
    let carrying = concentration_pipeline(
        &base,
        land,
        &eco.province_deviation,
        params,
        &eco.geo.cells.area_m2,
    );

    let timber = scaled(&raw.timber, EcologyField::Timber);
    let tool_stone = scaled(&raw.tool_stone, EcologyField::ToolStone);
    let copper = scaled(&raw.copper, EcologyField::Copper);
    let tin_radius =
        t.tin_radius_m * (1.0 - 0.6 * js::max(0.0, js::min(1.0, params.tin_rarity.unwrap_or(0.0))));
    let tin = scaled(
        &mask_to_land(
            gaussian_halos(&eco.geo, mesh, &eco.tin_points, tin_radius),
            land,
        ),
        EcologyField::Tin,
    );
    let iron = scaled(&raw.iron, EcologyField::Iron);
    let gold = scaled(&raw.gold, EcologyField::Gold);
    let silver = scaled(&raw.silver, EcologyField::Silver);
    let mut gems_raw = vec![0f32; n];
    for v in 0..n {
        if land[v] != 0 {
            gems_raw[v] = clamp01(
                t.gem_orogen_w * eco.gem_belt[v] as f64
                    + t.gem_arid_w * eco.aridity[v] as f64 * copper[v] as f64,
            ) as f32;
        }
    }
    let gems = scaled(&gems_raw, EcologyField::Gems);

    let mut fields = vec![
        carrying, arable, fish, game, pasture, timber, salt, tool_stone, copper, tin, iron, gold,
        silver, gems,
    ];
    for (id, f) in ECOLOGY_FIELDS.iter().zip(fields.iter_mut()) {
        for v in 0..n {
            if land[v] == 0 && !(*id == EcologyField::Fish && eco.sea[v] != 0) {
                f[v] = ECOLOGY_OCEAN;
            }
        }
    }
    fields
}

/// The fields as the chart reads them: per pixel of the world raster and
/// per climate cell, for the fields given (None skips one).
pub struct EcologyRasters {
    pub res_x: usize,
    pub res_y: usize,
    pub fields: Vec<Option<Vec<f32>>>,
    pub fine_res_x: usize,
    pub fine_res_y: usize,
    pub fine: Vec<Option<Vec<f32>>>,
}

pub fn ecology_rasters(
    eco: &mut EcologyBase,
    mesh: &mut PeriodicTriangulation,
    fields: &[Option<&[f32]>],
    pixel_land: &[u8],
    grid: &DomainGrid,
) -> EcologyRasters {
    let (w, h) = (grid.res_x, grid.res_y);
    let mut fine = Vec::with_capacity(fields.len());
    let mut coarse = Vec::with_capacity(fields.len());
    for (k, f) in fields.iter().enumerate() {
        match f {
            Some(f) => {
                let id = ECOLOGY_FIELDS[k];
                let fi = ecology_fine(eco, mesh, f, pixel_land, w, h, id == EcologyField::Fish);
                coarse.push(Some(to_climate_cells(&fi, pixel_land, grid)));
                fine.push(Some(fi));
            }
            None => {
                fine.push(None);
                coarse.push(None);
            }
        }
    }
    EcologyRasters {
        res_x: CLIMATE_RES_X,
        res_y: CLIMATE_RES_Y,
        fields: coarse,
        fine_res_x: w,
        fine_res_y: h,
        fine,
    }
}

/// One field per pixel; the pixels' triangles are made once and kept.
pub fn ecology_fine(
    eco: &mut EcologyBase,
    mesh: &mut PeriodicTriangulation,
    field: &[f32],
    pixel_land: &[u8],
    width: usize,
    height: usize,
    with_sea: bool,
) -> Vec<f32> {
    if eco
        .raster
        .as_ref()
        .is_none_or(|r| r.width != width || r.height != height)
    {
        eco.raster = Some(triangle_raster(mesh, width, height));
    }
    let plan = eco.raster.as_ref();
    let mut out = rasterise_node_part(
        mesh,
        field,
        &eco.land,
        Some(pixel_land),
        ECOLOGY_OCEAN as f64,
        width,
        height,
        false,
        plan,
    );
    if !with_sea {
        return out;
    }
    let pixel_sea: Vec<u8> = pixel_land.iter().map(|&l| u8::from(l == 0)).collect();
    let sea_part = rasterise_node_part(
        mesh,
        field,
        &eco.sea,
        Some(&pixel_sea),
        ECOLOGY_OCEAN as f64,
        width,
        height,
        false,
        plan,
    );
    for p in 0..out.len() {
        if pixel_sea[p] != 0 {
            out[p] = sea_part[p];
        }
    }
    out
}

fn to_climate_cells(field: &[f32], land: &[u8], grid: &DomainGrid) -> Vec<f32> {
    let (w, h) = (grid.res_x, grid.res_y);
    let nc = CLIMATE_RES_X * CLIMATE_RES_Y;
    let mut sum = vec![0.0; nc];
    let mut count = vec![0.0; nc];
    for y in 0..h {
        let gy = (CLIMATE_RES_Y - 1)
            .min(((y as f64 / h as f64) * CLIMATE_RES_Y as f64).floor() as usize);
        let a = grid.cell_area(y as f64);
        for x in 0..w {
            let i = y * w + x;
            if land[i] == 0 {
                continue;
            }
            let c = gy * CLIMATE_RES_X
                + (CLIMATE_RES_X - 1)
                    .min(((x as f64 / w as f64) * CLIMATE_RES_X as f64).floor() as usize);
            sum[c] += field[i] as f64 * a;
            count[c] += a;
        }
    }
    let mut out = vec![0f32; nc];
    for gy in 0..CLIMATE_RES_Y {
        let cy =
            (h - 1).min((((gy as f64 + 0.5) / CLIMATE_RES_Y as f64) * h as f64).floor() as usize);
        for gx in 0..CLIMATE_RES_X {
            let c = gy * CLIMATE_RES_X + gx;
            let centre = cy * w
                + (w - 1)
                    .min((((gx as f64 + 0.5) / CLIMATE_RES_X as f64) * w as f64).floor() as usize);
            out[c] = if land[centre] == 0 {
                ECOLOGY_OCEAN
            } else if count[c] > 0.0 {
                (sum[c] / count[c]) as f32
            } else {
                0.0
            };
        }
    }
    out
}

/// The mineralisation lottery: a point kept by a hash of its integer
/// position, the seed and a per-resource salt.
fn thin_points(points: &[(f64, f64)], keep_fraction: f64, salt: i32) -> Vec<(f64, f64)> {
    if keep_fraction >= 1.0 {
        return points.to_vec();
    }
    points
        .iter()
        .copied()
        .filter(|&(x, y)| {
            let mixed = x.floor() * 374_761_393.0 + y.floor() * 668_265_263.0;
            let mut h = js::to_int32(mixed) ^ salt;
            h = js::imul((h ^ ((h as u32 >> 13) as i32)) as f64, 1_274_126_177.0);
            let h = (h ^ ((h as u32 >> 16) as i32)) as u32;
            (h as f64 / 4_294_967_296.0) < keep_fraction
        })
        .collect()
}

fn mask_to_land(mut field: Vec<f32>, land: &[u8]) -> Vec<f32> {
    for (f, &l) in field.iter_mut().zip(land) {
        if l == 0 {
            *f = 0.0;
        }
    }
    field
}

/// By area.
fn land_mean(field: &[f32], land: &[u8], area: &[f64]) -> f64 {
    let (mut sum, mut total) = (0.0, 0.0);
    for v in 0..field.len() {
        if land[v] != 0 {
            sum += field[v] as f64 * area[v];
            total += area[v];
        }
    }
    if total > 0.0 { sum / total } else { 0.0 }
}

/// The province noise's lattice hash, in JavaScript's number arithmetic.
fn hash_lattice(ix: f64, iy: f64, seed: f64) -> f64 {
    let h = js::to_int32(ix * 374_761_393.0 + iy * 668_265_263.0 + seed * 1_442_695_040.0);
    let h = ((h ^ ((h as u32 >> 13) as i32)) as f64) * 1_274_126_177.0;
    let h = js::to_int32(h) ^ ((js::to_uint32(h) >> 16) as i32);
    (h as u32) as f64 / 4_294_967_295.0
}

/// A seeded noise in [-1, 1] at a lattice of freq_x × freq_y cells over
/// the world: the chart's on the torus, the globe's on the sphere.
struct NoiseSampler {
    domain: Domain,
    lattice: Option<DomainGrid>,
    freq_x: f64,
    seed: f64,
}

impl NoiseSampler {
    fn new(domain: &Domain, freq_x: f64, freq_y: f64, seed: f64) -> Self {
        NoiseSampler {
            domain: domain.clone(),
            lattice: (!domain.is_sphere()).then(|| domain.grid(freq_x as usize, freq_y as usize)),
            freq_x,
            seed,
        }
    }

    fn at(&self, x: f64, y: f64) -> f64 {
        match &self.lattice {
            Some(lattice) => province_noise(
                x / self.domain.width,
                y / self.domain.height,
                lattice,
                self.seed,
            ),
            None => {
                let frame = self.domain.globe_frame(x, y);
                globe_octave_on(&frame, self.freq_x, &self.domain, self.seed) * 2.0 - 1.0
            }
        }
    }
}

fn province_noise(u: f64, v: f64, lattice: &DomainGrid, seed: f64) -> f64 {
    let gx = u * lattice.res_x as f64;
    let gy = v * lattice.res_y as f64;
    let x0 = gx.floor();
    let y0 = gy.floor();
    let fx = smoothstep(gx - x0);
    let fy = smoothstep(gy - y0);
    let c00 = hash_lattice(lattice.wrap_col(x0), lattice.wrap_row(y0), seed);
    let c10 = hash_lattice(lattice.wrap_col(x0 + 1.0), lattice.wrap_row(y0), seed);
    let c01 = hash_lattice(lattice.wrap_col(x0), lattice.wrap_row(y0 + 1.0), seed);
    let c11 = hash_lattice(lattice.wrap_col(x0 + 1.0), lattice.wrap_row(y0 + 1.0), seed);
    let top = c00 + (c10 - c00) * fx;
    let bottom = c01 + (c11 - c01) * fx;
    (top + (bottom - top) * fy) * 2.0 - 1.0
}

/// The base through normalise → L1 gamma → L2 province → gain.
fn concentration_pipeline(
    base: &[f32],
    land: &[u8],
    dev: &[f32],
    params: &EcologyParams,
    area: &[f64],
) -> Vec<f32> {
    let n = base.len();
    let mut max_base = 0.0f32;
    for i in 0..n {
        if land[i] != 0 && base[i] > max_base {
            max_base = base[i];
        }
    }
    let mut norm = vec![0f32; n];
    if max_base > 0.0 {
        for i in 0..n {
            if land[i] != 0 {
                norm[i] = (base[i] as f64 / max_base as f64) as f32;
            }
        }
    }
    let mean_norm = land_mean(&norm, land, area);

    let gamma = det_pow(2.0, params.concentration / 100.0);
    let mut shaped = vec![0f32; n];
    for i in 0..n {
        if land[i] != 0 {
            shaped[i] = det_pow(norm[i] as f64, gamma) as f32;
        }
    }
    let mean_shaped = land_mean(&shaped, land, area);
    let l1_scale = if mean_shaped > 0.0 {
        mean_norm / mean_shaped
    } else {
        1.0
    };
    for i in 0..n {
        if land[i] != 0 {
            shaped[i] = (shaped[i] as f64 * l1_scale) as f32;
        }
    }

    let strength = params.province_strength;
    let mean_dev = land_mean(dev, land, area);
    let mut provincial = vec![0f32; n];
    for i in 0..n {
        if land[i] == 0 {
            continue;
        }
        provincial[i] =
            (shaped[i] as f64 * js::max(0.1, 1.0 + strength * (dev[i] as f64 - mean_dev))) as f32;
    }
    let mean_prov = land_mean(&provincial, land, area);
    let l2_scale = if mean_prov > 0.0 {
        mean_norm / mean_prov
    } else {
        1.0
    };

    let gain = params.carrying_capacity / 100.0;
    (0..n)
        .map(|i| {
            if land[i] != 0 {
                (provincial[i] as f64 * l2_scale * gain) as f32
            } else {
                ECOLOGY_OCEAN
            }
        })
        .collect()
}
