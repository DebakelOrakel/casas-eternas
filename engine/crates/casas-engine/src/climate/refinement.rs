//! `climate/refinement.ts`: the climate step's refinement — the climate the
//! history left computed again with more physics on the final geography:
//! the year's cycle, the months' pressure and wind, the ocean with its
//! highs, upwelling, salt and overturning, the months' rain, fog and föhn,
//! the rain's reliability and the storms. One call, in its load-bearing
//! order; the TypeScript port
//! (`client/src/generator/climate/refinement.ts`, git history) explains
//! each step. Not ported: the progress callback.

use crate::core::det_math::{det_cos, det_hypot, det_sin};
use crate::core::js;
use crate::elevation::elevation_scale::{ELEVATION_METERS, SEA_LEVEL};
use crate::fields::field_mesh::SharedFieldMesh;
use crate::fields::field_operators::{SolveReport, smooth_gaussian};
use crate::planet::planet_forcing::{DEFAULT_PLANET_FORCING, hadley_edge};

use super::climate_field::{in_top_summer_half, latitude_of_norm, shifted_norm};
use super::climate_mesh::{ClimateMesh, ClimateTerrain, basin_rows};
use super::climate_tune_params::CLIMATE_TUNING;
use super::energy_balance::seasonal_cycle;
use super::ocean_currents::{
    apply_ocean_sst, carry_inland, compute_ocean_currents, compute_sink_inflow, compute_upwelling,
};
use super::phenomena::apply_phenomena;
use super::precipitation::{OCEAN_PRECIP, RefinedRain, compute_precipitation, earth_hadley_edge};
use super::pressure::{REFINED_MONTHS, compute_pressure_wind};
use super::reliability::compute_reliability;
use super::salinity::compute_salinity;
use super::seasonality::OCEAN_AMPLITUDE;
use super::storms::compute_storms;
use super::temperature::compute_temperature;
use super::weather::WeatherParams;
use super::wind::{CellVectors, compute_wind};

use std::f64::consts::PI;

/// The storms' fields, in the order the save writes them.
pub const REFINED_STORMS: [&str; 5] = ["cyclone", "tornado", "blizzard", "dust", "thunder"];

#[derive(Clone, Debug)]
pub struct RefinedStorms {
    pub cyclone: Vec<f32>,
    pub tornado: Vec<f32>,
    pub blizzard: Vec<f32>,
    pub dust: Vec<f32>,
    pub thunder: Vec<f32>,
}

#[derive(Clone, Debug)]
pub struct RefinedReliability {
    pub rain_variability: Vec<f32>,
    pub enso_pattern: Vec<f32>,
    pub enso_period_years: f64,
    pub enso_strength: f64,
}

#[derive(Clone, Debug)]
pub struct RefinedSolves {
    pub currents: SolveReport,
    pub inflow: SolveReport,
    pub cycle: Vec<SolveReport>,
}

/// The refinement per cell of the climate's field mesh, Float32: the
/// values the save writes (`RefinedClimate` in TypeScript, which explains
/// each field). Month fields are month-major.
#[derive(Clone, Debug)]
pub struct RefinedClimate {
    pub months: usize,
    pub cells: usize,
    pub spacing_m: f64,
    pub temperature: Vec<f32>,
    pub precipitation: Vec<f32>,
    pub pressure: Vec<f32>,
    pub wind_e: Vec<f32>,
    pub wind_s: Vec<f32>,
    pub current_e: Vec<f32>,
    pub current_s: Vec<f32>,
    pub current_anomaly: Vec<f32>,
    pub upwelling: Vec<f32>,
    pub salinity: Vec<f32>,
    pub deep_water: Vec<f32>,
    pub fog: Vec<f32>,
    pub foehn: Vec<f32>,
    pub reliability: RefinedReliability,
    pub storms: RefinedStorms,
    /// A diagnostic: a refinement read back from a save has none.
    pub solves: Option<RefinedSolves>,
}

/// Whether a refinement's values belong to the climate's mesh `sh`.
pub fn refinement_fits(sh: &SharedFieldMesh, cells: usize, spacing_m: f64) -> bool {
    cells == sh.mesh.count && spacing_m == ClimateMesh::new(&sh.mesh).cell_m
}

fn f32s(field: &[f64]) -> Vec<f32> {
    field.iter().map(|&v| v as f32).collect()
}

/// The refinement on `elevation`, a raster of one cell per unit over the
/// mesh's domain; `temperature` and `base_wind` the climate the step shows
/// (`compute_weather` on the same terrain), `params` its levers.
pub fn refine_climate(
    sh: &mut SharedFieldMesh,
    elevation: &[f32],
    params: &WeatherParams,
    temperature: &[f64],
    base_wind: &CellVectors,
) -> RefinedClimate {
    let t = &CLIMATE_TUNING;
    let width = sh.mesh.domain.width as usize;
    let height = sh.mesh.domain.height as usize;
    let planet = params.planet.unwrap_or(DEFAULT_PLANET_FORCING);
    let terrain = ClimateTerrain::new(sh, elevation, width, height, None);
    let land = terrain.land.clone();
    let n = sh.mesh.count;
    let months = REFINED_MONTHS;
    let mf = months as f64;
    let eq = params.equator_offset;
    let edge = hadley_edge(planet.rotation_hours);
    let lat_deg: Vec<f64> = (0..n)
        .map(|i| latitude_of_norm(shifted_norm(terrain.cm.y_norm[i], eq)) * 90.0)
        .collect();
    let sea_level_air = |air: &[f64]| -> Vec<f64> {
        (0..n)
            .map(|i| {
                let e = terrain.z[i];
                air[i]
                    + t.lapse_c_per_elevation
                        * if terrain.dry[i] != 0 {
                            e - SEA_LEVEL
                        } else {
                            js::max(0.0, e - SEA_LEVEL)
                        }
            })
            .collect()
    };

    let annual = temperature.to_vec();
    let cycle_result = seasonal_cycle(sh, &terrain, &annual, base_wind, &planet, eq, months);
    let cycle = cycle_result.cycle;
    let mut monthly = vec![0.0; months * n];
    for m in 0..months {
        for i in 0..n {
            monthly[m * n + i] = annual[i] + cycle[m * n + i];
        }
    }

    let plateau_km: Vec<f64> = terrain
        .mean_elevation(sh)
        .iter()
        .map(|&z| {
            js::max(
                0.0,
                z * ELEVATION_METERS / 1000.0 - t.pressure_plateau_from_km,
            )
        })
        .collect();
    let plateau_heat = |sh: &SharedFieldMesh, m: usize| -> Vec<f64> {
        let hpa: Vec<f64> = (0..n)
            .map(|i| -t.pressure_plateau_hpa_per_km_c * plateau_km[i] * cycle[m * n + i])
            .collect();
        smooth_gaussian(&sh.mesh, &hpa, t.pressure_smooth_sigma_m)
    };

    let mut belts = vec![0.0; months];
    let mut heats: Vec<Vec<f64>> = Vec::with_capacity(months);
    let mut annual_wind = CellVectors {
        e: vec![0.0; n],
        s: vec![0.0; n],
    };
    for m in 0..months {
        let belt = t.monsoon_itcz_seasonal_shift
            * det_cos(2.0 * PI * ((m as f64 + 0.5) / mf - t.refine_itcz_peak_year));
        belts[m] = belt;
        let band_wind = compute_wind(&terrain.cm, &sh.mesh, eq, planet.rotation_hours, belt);
        heats.push(plateau_heat(sh, m));
        let air = sea_level_air(&monthly[m * n..(m + 1) * n]);
        let result = compute_pressure_wind(
            sh,
            &terrain,
            &air,
            &band_wind,
            eq,
            planet.rotation_hours,
            belt,
            Some(&heats[m]),
        );
        for i in 0..n {
            annual_wind.e[i] += result.wind.e[i] / mf;
            annual_wind.s[i] += result.wind.s[i] / mf;
        }
    }

    let wind_currents = compute_ocean_currents(sh, &terrain, &annual_wind, eq);
    let base = compute_temperature(
        sh,
        &terrain,
        params.temperature_offset,
        params.temperature_contrast,
        eq,
        &planet,
    );
    let wind_anomaly = apply_ocean_sst(
        sh,
        &terrain,
        &mut base.clone(),
        &wind_currents.e,
        &wind_currents.s,
        &annual_wind,
    );

    let mut upwelling = compute_upwelling(sh, &terrain, &annual_wind, eq, planet.rotation_hours);
    let rows = basin_rows(sh, &terrain);
    let mut cooling = vec![0.0; n];
    for i in 0..n {
        if land[i] != 0 || upwelling[i] <= 0.0 {
            continue;
        }
        let equatorial = js::max(0.0, 1.0 - lat_deg[i] / t.upwelling_equator_band_deg);
        let reach = 1.0 - equatorial + equatorial * rows.eastward[i];
        upwelling[i] *= reach;
        cooling[i] = js::min(
            t.upwelling_max_cooling_c,
            upwelling[i] * t.upwelling_cooling_c,
        );
    }

    let high_shift = edge / earth_hadley_edge();
    let high_from_deg = t.ocean_high_from_deg * high_shift;
    let high_to_deg = t.ocean_high_to_deg * high_shift;
    let mut sea_anomaly = vec![0.0; n];
    let mut ocean_high = vec![0.0; n];
    let mut sea_share = vec![0.0; n];
    for i in 0..n {
        if land[i] != 0 {
            continue;
        }
        sea_anomaly[i] = wind_anomaly[i] - cooling[i];
        sea_share[i] = 1.0;
        let f = (lat_deg[i] - high_from_deg) / (high_to_deg - high_from_deg);
        if f <= 0.0 || f >= 1.0 || rows.run_points[i] < 2 {
            continue;
        }
        let flank =
            (2.0 * rows.eastward[i] - 1.0) * js::min(1.0, rows.run_m[i] / t.ocean_high_basin_m);
        ocean_high[i] = t.ocean_high_flank_hpa * flank * det_sin(PI * f);
    }
    let ocean_high = smooth_gaussian(&sh.mesh, &ocean_high, t.ocean_high_smooth_sigma_m);
    let sea_share = smooth_gaussian(&sh.mesh, &sea_share, t.ocean_high_smooth_sigma_m);
    let ocean_high: Vec<f64> = (0..n)
        .map(|i| {
            if sea_share[i] > t.ocean_high_min_sea_share {
                ocean_high[i] / sea_share[i]
            } else {
                0.0
            }
        })
        .collect();

    let mut pressure = vec![0.0; months * n];
    let mut winds: Vec<CellVectors> = Vec::with_capacity(months);
    for m in 0..months {
        let band_wind = compute_wind(&terrain.cm, &sh.mesh, eq, planet.rotation_hours, belts[m]);
        let extra = &mut heats[m];
        for i in 0..n {
            extra[i] += ocean_high[i];
        }
        let air = sea_level_air(&monthly[m * n..(m + 1) * n]);
        let result = compute_pressure_wind(
            sh,
            &terrain,
            &air,
            &band_wind,
            eq,
            planet.rotation_hours,
            belts[m],
            Some(&heats[m]),
        );
        pressure[m * n..(m + 1) * n].copy_from_slice(&result.pressure);
        winds.push(result.wind);
    }

    let mut precipitation = vec![0.0; months * n];
    let mut land_rain = vec![0.0; n];
    for m in 0..months {
        let sea_temperature: Vec<f64> = (0..n)
            .map(|i| base[i] + sea_anomaly[i] + cycle[m * n + i])
            .collect();
        let refined = RefinedRain {
            sea_temperature: &sea_temperature,
            sea_anomaly: &sea_anomaly,
            high_hpa: &ocean_high,
        };
        let rain = compute_precipitation(
            sh,
            &terrain,
            &monthly[m * n..(m + 1) * n],
            &winds[m],
            params.humidity,
            eq,
            belts[m],
            Some(&refined),
            edge,
        );
        precipitation[m * n..(m + 1) * n].copy_from_slice(&rain);
        for i in 0..n {
            if land[i] != 0 {
                land_rain[i] += rain[i] / mf;
            }
        }
    }

    let wind_cur = CellVectors {
        e: wind_currents.e.clone(),
        s: wind_currents.s.clone(),
    };
    let first = compute_salinity(
        sh,
        &terrain,
        &annual,
        &land_rain,
        &wind_cur,
        eq,
        params.humidity,
        edge,
    );
    let inflow = compute_sink_inflow(sh, &terrain, &first.deep_water);
    let mut currents = CellVectors {
        e: vec![0.0; n],
        s: vec![0.0; n],
    };
    let mut fastest = 0.0;
    for i in 0..n {
        currents.e[i] = wind_currents.e[i] + t.conveyor_flow * inflow.e[i];
        currents.s[i] = wind_currents.s[i] + t.conveyor_flow * inflow.s[i];
        fastest = js::max(fastest, det_hypot(currents.e[i], currents.s[i]));
    }
    if fastest > 1.0 {
        for i in 0..n {
            currents.e[i] /= fastest;
            currents.s[i] /= fastest;
        }
    }
    let salt = compute_salinity(
        sh,
        &terrain,
        &annual,
        &land_rain,
        &currents,
        eq,
        params.humidity,
        edge,
    );

    let anomaly = apply_ocean_sst(
        sh,
        &terrain,
        &mut base.clone(),
        &currents.e,
        &currents.s,
        &annual_wind,
    );
    let drift: Vec<f64> = (0..n)
        .map(|i| {
            if land[i] == 0 {
                anomaly[i] - wind_anomaly[i]
            } else {
                0.0
            }
        })
        .collect();
    let inland = carry_inland(sh, &terrain, &drift, &annual_wind);
    for i in 0..n {
        let warmth = if land[i] != 0 {
            t.currents_coastal_factor * inland[i]
        } else {
            drift[i]
        };
        for m in 0..months {
            monthly[m * n + i] += warmth;
        }
    }
    let current_anomaly: Vec<f64> = (0..n)
        .map(|i| {
            if land[i] == 0 {
                anomaly[i] - cooling[i]
            } else {
                0.0
            }
        })
        .collect();

    let phenomena = apply_phenomena(sh, &terrain, &mut monthly, months, &winds, &current_anomaly);
    let year = annual_from_months(months, &monthly, &precipitation, n);
    let reliability = compute_reliability(
        &sh.mesh,
        &terrain,
        &rows,
        &year.precipitation,
        &year.monsoon_index,
        &current_anomaly,
        eq,
    );
    let storms = compute_storms(sh, &terrain, &monthly, &precipitation, months, &winds, eq);

    let mut wind_e = vec![0f32; months * n];
    let mut wind_s = vec![0f32; months * n];
    for m in 0..months {
        for i in 0..n {
            wind_e[m * n + i] = winds[m].e[i] as f32;
            wind_s[m * n + i] = winds[m].s[i] as f32;
        }
    }
    RefinedClimate {
        months,
        cells: n,
        spacing_m: terrain.cm.cell_m,
        temperature: f32s(&monthly),
        precipitation: f32s(&precipitation),
        pressure: f32s(&pressure),
        wind_e,
        wind_s,
        current_e: f32s(&currents.e),
        current_s: f32s(&currents.s),
        current_anomaly: f32s(&current_anomaly),
        upwelling: f32s(&upwelling),
        salinity: f32s(&salt.salinity),
        deep_water: f32s(&salt.deep_water),
        fog: f32s(&phenomena.fog),
        foehn: f32s(&phenomena.foehn),
        reliability: RefinedReliability {
            rain_variability: f32s(&reliability.rain_variability),
            enso_pattern: f32s(&reliability.enso_pattern),
            enso_period_years: reliability.enso_period_years,
            enso_strength: reliability.enso_strength,
        },
        storms: RefinedStorms {
            cyclone: f32s(&storms.cyclone),
            tornado: f32s(&storms.tornado),
            blizzard: f32s(&storms.blizzard),
            dust: f32s(&storms.dust),
            thunder: f32s(&storms.thunder),
        },
        solves: Some(RefinedSolves {
            currents: wind_currents.solve,
            inflow: inflow.solve,
            cycle: cycle_result.solves,
        }),
    }
}

/// The year's mean wind of a refinement per cell.
pub fn refined_annual_wind(r: &RefinedClimate) -> CellVectors {
    let n = r.cells;
    let mf = r.months as f64;
    let mut out = CellVectors {
        e: vec![0.0; n],
        s: vec![0.0; n],
    };
    for m in 0..r.months {
        for i in 0..n {
            out.e[i] += r.wind_e[m * n + i] as f64 / mf;
            out.s[i] += r.wind_s[m * n + i] as f64 / mf;
        }
    }
    out
}

/// The annual fields of month fields, in the history's climate's forms.
pub struct AnnualFields {
    pub temperature: Vec<f32>,
    pub precipitation: Vec<f32>,
    pub seasonal_amplitude: Vec<f32>,
    pub monsoon_index: Vec<f32>,
}

pub fn annual_from_months<T: Copy + Into<f64>>(
    months: usize,
    temperature: &[T],
    precipitation: &[T],
    n: usize,
) -> AnnualFields {
    let mf = months as f64;
    let mut out = AnnualFields {
        temperature: vec![0.0; n],
        precipitation: vec![0.0; n],
        seasonal_amplitude: vec![0.0; n],
        monsoon_index: vec![0.0; n],
    };
    for i in 0..n {
        let mut mean = 0.0;
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for m in 0..months {
            let t: f64 = temperature[m * n + i].into();
            mean += t / mf;
            lo = js::min(lo, t);
            hi = js::max(hi, t);
        }
        out.temperature[i] = mean as f32;
        if Into::<f64>::into(precipitation[i]) < 0.0 {
            out.precipitation[i] = OCEAN_PRECIP as f32;
            out.seasonal_amplitude[i] = OCEAN_AMPLITUDE as f32;
            out.monsoon_index[i] = OCEAN_PRECIP as f32;
            continue;
        }
        let (mut top, mut bottom) = (0.0, 0.0);
        for m in 0..months {
            let p: f64 = precipitation[m * n + i].into();
            if in_top_summer_half(m as f64) {
                top += (2.0 * p) / mf;
            } else {
                bottom += (2.0 * p) / mf;
            }
        }
        out.precipitation[i] = ((top + bottom) / 2.0) as f32;
        out.seasonal_amplitude[i] = (hi - lo) as f32;
        out.monsoon_index[i] =
            ((top - bottom) / (top + bottom + CLIMATE_TUNING.monsoon_seasonality_floor)) as f32;
    }
    out
}
