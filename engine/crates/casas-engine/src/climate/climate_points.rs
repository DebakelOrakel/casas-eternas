//! `climate/climatePoints.ts`: the climate at a point — the climate's cells
//! as its readers need them (the temperature reduced to sea level, the land
//! fields with their sea marks, the months, the wind), and their values at
//! any point set, linearly in the climate mesh's triangle, a land field over
//! the land corners only. The TypeScript file explains the island rule and
//! the monsoon's sign.

use crate::core::js;
use crate::elevation::elevation_scale::SEA_LEVEL;
use crate::fields::field_mesh::SharedFieldMesh;
use crate::mesh::periodic_delaunay::PeriodicTriangulation;

use super::climate_mesh::ClimateTerrain;
use super::climate_mesh::{ClimateMesh, zonal_mean};
use super::climate_tune_params::CLIMATE_TUNING;
use super::precipitation::OCEAN_PRECIP;
use super::refinement::{RefinedClimate, annual_from_months, refined_annual_wind};
use super::seasonality::OCEAN_AMPLITUDE;
use super::weather::WeatherMesh;

/// The months per cell, month-major: °C reduced to sea level and mm/yr at
/// the month's rate (OCEAN_PRECIP on the sea).
#[derive(Clone, Debug)]
pub struct ClimateMonthCells {
    pub count: usize,
    pub sea_level_temperature: Vec<f32>,
    pub precipitation: Vec<f32>,
}

/// The climate per cell of its field mesh, as its readers need it
/// (`ClimateCells` in TypeScript).
#[derive(Clone, Debug)]
pub struct ClimateCells {
    pub cm: ClimateMesh,
    pub sea_level_temperature: Vec<f32>,
    pub precipitation: Vec<f32>,
    pub seasonal_amplitude: Vec<f32>,
    pub monsoon_index: Vec<f32>,
    pub months: Option<ClimateMonthCells>,
    pub upwelling: Option<Vec<f32>>,
    pub rain_variability: Option<Vec<f32>>,
    pub wind_e: Vec<f32>,
    pub wind_s: Vec<f32>,
}

/// The lapse a height carries, °C.
pub fn lapse_at(height: f64, dry: bool) -> f64 {
    CLIMATE_TUNING.lapse_c_per_elevation
        * if dry {
            height - SEA_LEVEL
        } else {
            js::max(0.0, height - SEA_LEVEL)
        }
}

/// The static climate's cells.
pub fn climate_cells_from_weather(terrain: &ClimateTerrain, mesh: &WeatherMesh) -> ClimateCells {
    let n = terrain.z.len();
    let mut sea_level_temperature = vec![0f32; n];
    let mut precipitation = vec![0f32; n];
    let mut seasonal_amplitude = vec![0f32; n];
    let mut monsoon_index = vec![0f32; n];
    for i in 0..n {
        sea_level_temperature[i] =
            (mesh.temperature[i] + lapse_at(terrain.z[i], terrain.dry[i] == 1)) as f32;
        let land = terrain.land[i] == 1 && mesh.seasonal.annual[i] != OCEAN_PRECIP;
        precipitation[i] = if land {
            mesh.seasonal.annual[i]
        } else {
            OCEAN_PRECIP
        } as f32;
        seasonal_amplitude[i] = if land {
            mesh.seasonal_amplitude[i]
        } else {
            OCEAN_AMPLITUDE
        } as f32;
        monsoon_index[i] = if land {
            mesh.seasonal.index[i]
        } else {
            OCEAN_PRECIP
        } as f32;
    }
    ClimateCells {
        cm: terrain.cm.clone(),
        sea_level_temperature,
        precipitation,
        seasonal_amplitude,
        monsoon_index,
        months: None,
        upwelling: None,
        rain_variability: None,
        wind_e: mesh.wind.e.iter().map(|&v| v as f32).collect(),
        wind_s: mesh.wind.s.iter().map(|&v| v as f32).collect(),
    }
}

/// The refinement's cells, on the terrain it was computed on: the annual
/// fields from its months, the months, its upwelling, its rain's
/// reliability, its year's wind.
pub fn climate_cells_from_refined(r: &RefinedClimate, terrain: &ClimateTerrain) -> ClimateCells {
    let n = r.cells;
    let annual = annual_from_months(r.months, &r.temperature, &r.precipitation, n);
    let lapse: Vec<f32> = (0..n)
        .map(|i| lapse_at(terrain.z[i], terrain.dry[i] == 1) as f32)
        .collect();
    let sea_level_temperature = (0..n)
        .map(|i| (annual.temperature[i] as f64 + lapse[i] as f64) as f32)
        .collect();
    let mut months_t = vec![0f32; r.months * n];
    for m in 0..r.months {
        for i in 0..n {
            months_t[m * n + i] = (r.temperature[m * n + i] as f64 + lapse[i] as f64) as f32;
        }
    }
    let wind = refined_annual_wind(r);
    ClimateCells {
        cm: terrain.cm.clone(),
        sea_level_temperature,
        precipitation: annual.precipitation,
        seasonal_amplitude: annual.seasonal_amplitude,
        monsoon_index: annual.monsoon_index,
        months: Some(ClimateMonthCells {
            count: r.months,
            sea_level_temperature: months_t,
            precipitation: r.precipitation.clone(),
        }),
        upwelling: Some(r.upwelling.clone()),
        rain_variability: Some(r.reliability.rain_variability.clone()),
        wind_e: wind.e.iter().map(|&v| v as f32).collect(),
        wind_s: wind.s.iter().map(|&v| v as f32).collect(),
    }
}

/// The annual cells as values with the mesh they belong to: the save's
/// form.
#[derive(Clone, Debug)]
pub struct ClimateCellValues {
    pub cells: usize,
    pub spacing_m: f64,
    pub sea_level_temperature: Vec<f32>,
    pub precipitation: Vec<f32>,
    pub seasonal_amplitude: Vec<f32>,
    pub monsoon_index: Vec<f32>,
}

pub fn climate_cell_values(cells: &ClimateCells) -> ClimateCellValues {
    ClimateCellValues {
        cells: cells.cm.y_norm.len(),
        spacing_m: cells.cm.cell_m,
        sea_level_temperature: cells.sea_level_temperature.clone(),
        precipitation: cells.precipitation.clone(),
        seasonal_amplitude: cells.seasonal_amplitude.clone(),
        monsoon_index: cells.monsoon_index.clone(),
    }
}

/// The cells back from their values, on the climate's mesh `sh`; an error
/// when the values belong to another.
pub fn climate_cells_from_saved(
    sh: &SharedFieldMesh,
    saved: ClimateCellValues,
) -> Result<ClimateCells, String> {
    let cm = ClimateMesh::new(&sh.mesh);
    let count = sh.mesh.count;
    if saved.cells != count || saved.spacing_m != cm.cell_m {
        return Err(format!(
            "the climate's values belong to a mesh of {} cells at {} m, this world's has {} at {} m",
            saved.cells, saved.spacing_m, count, cm.cell_m
        ));
    }
    Ok(ClimateCells {
        cm,
        sea_level_temperature: saved.sea_level_temperature,
        precipitation: saved.precipitation,
        seasonal_amplitude: saved.seasonal_amplitude,
        monsoon_index: saved.monsoon_index,
        months: None,
        upwelling: None,
        rain_variability: None,
        wind_e: vec![0.0; count],
        wind_s: vec![0.0; count],
    })
}

/// The mean rain over the land, mm/yr, by area.
pub fn mean_land_runoff(sh: &SharedFieldMesh, cells: &ClimateCells) -> f64 {
    let area = &sh.mesh.area;
    let (mut sum, mut total) = (0.0, 0.0);
    for (i, &p) in cells.precipitation.iter().enumerate() {
        if p as f64 == OCEAN_PRECIP {
            continue;
        }
        sum += js::max(0.0, p as f64) * area[i];
        total += area[i];
    }
    if total > 0.0 { sum / total } else { 0.0 }
}

/// The points' heights as their stage holds them: a terrain mesh's z, or
/// the climate mesh's own cells' (`ClimateTerrain::z`, f64 in TypeScript
/// too).
#[derive(Clone, Copy)]
pub enum Heights<'a> {
    F32(&'a [f32]),
    F64(&'a [f64]),
}

impl Heights<'_> {
    pub fn at(&self, i: usize) -> f64 {
        match self {
            Heights::F32(h) => h[i] as f64,
            Heights::F64(h) => h[i],
        }
    }
}

/// Where a stage reads the climate (`ClimatePoints` in TypeScript).
pub struct ClimatePoints<'a> {
    pub count: usize,
    pub x: &'a [f64],
    pub y: &'a [f64],
    pub height: Heights<'a>,
    pub land: Vec<u8>,
    pub dry: Option<&'a [u8]>,
    pub alive: Option<&'a [u8]>,
}

/// A terrain mesh's nodes as points: land where z stands above the sea or
/// the node is a dry floor.
pub fn mesh_points<'a>(
    mesh: &'a PeriodicTriangulation,
    z: &'a [f32],
    dry: Option<&'a [u8]>,
) -> ClimatePoints<'a> {
    let n = mesh.vertex_slots();
    let land = (0..n)
        .map(|v| {
            u8::from(
                mesh.v_alive[v] != 0 && (z[v] as f64 > SEA_LEVEL || dry.is_some_and(|d| d[v] == 1)),
            )
        })
        .collect();
    ClimatePoints {
        count: n,
        x: &mesh.vx[..n],
        y: &mesh.vy[..n],
        height: Heights::F32(z),
        land,
        dry,
        alive: Some(&mesh.v_alive[..n]),
    }
}

/// The months at the points, month-major.
#[derive(Clone, Debug)]
pub struct PointMonths {
    pub count: usize,
    pub temperature: Vec<f32>,
    pub precipitation: Vec<f32>,
}

/// The climate at points (`PointClimate` in TypeScript).
#[derive(Clone, Debug)]
pub struct PointClimate {
    pub count: usize,
    pub sea_level_temperature: Vec<f32>,
    pub temperature: Vec<f32>,
    pub precipitation: Vec<f32>,
    pub seasonal_amplitude: Vec<f32>,
    pub monsoon_index: Vec<f32>,
    pub months: Option<PointMonths>,
    pub upwelling: Option<Vec<f32>>,
    pub rain_variability: Option<Vec<f32>>,
    pub wind_e: Option<Vec<f32>>,
    pub wind_s: Option<Vec<f32>>,
}

/// The islands' climate per cell: their latitude's land mean.
struct Islands {
    precipitation: Vec<f64>,
    amplitude: Vec<f64>,
    season: Vec<f64>,
    sign: Vec<f64>,
    variability: Option<Vec<f64>>,
    months: Vec<Vec<f64>>,
}

/// The climate at every point of `points`; `wind` also samples the year's
/// wind in each point's frame.
pub fn climate_at_points(
    sh: &mut SharedFieldMesh,
    cells: &ClimateCells,
    points: &ClimatePoints,
    wind: bool,
) -> PointClimate {
    let cm = &cells.cm;
    let n = points.count;
    let nc = sh.mesh.count;
    let is_land_cell = |i: usize| cells.precipitation[i] as f64 != OCEAN_PRECIP;
    let months = &cells.months;
    let mut out = PointClimate {
        count: n,
        sea_level_temperature: vec![0.0; n],
        temperature: vec![0.0; n],
        precipitation: vec![0.0; n],
        seasonal_amplitude: vec![0.0; n],
        monsoon_index: vec![0.0; n],
        months: months.as_ref().map(|m| PointMonths {
            count: m.count,
            temperature: vec![0.0; m.count * n],
            precipitation: vec![0.0; m.count * n],
        }),
        upwelling: cells.upwelling.as_ref().map(|_| vec![0.0; n]),
        rain_variability: cells.rain_variability.as_ref().map(|_| vec![0.0; n]),
        wind_e: wind.then(|| vec![0.0; n]),
        wind_s: wind.then(|| vec![0.0; n]),
    };
    let mut islands: Option<Islands> = None;
    let islands_of = |islands: &mut Option<Islands>, fm: &crate::fields::field_mesh::FieldMesh| {
        if islands.is_none() {
            let use_: &dyn Fn(usize) -> bool = &is_land_cell;
            let season: Vec<f32> = cells.monsoon_index.iter().map(|v| v.abs()).collect();
            *islands = Some(Islands {
                precipitation: zonal_mean(cm, fm, &cells.precipitation, Some(use_)),
                amplitude: zonal_mean(cm, fm, &cells.seasonal_amplitude, Some(use_)),
                season: zonal_mean(cm, fm, &season, Some(use_)),
                sign: zonal_mean(cm, fm, &cells.monsoon_index, Some(use_)),
                variability: cells
                    .rain_variability
                    .as_ref()
                    .map(|v| zonal_mean(cm, fm, v, Some(use_))),
                months: months.as_ref().map_or(Vec::new(), |mo| {
                    (0..mo.count)
                        .map(|m| {
                            zonal_mean(cm, fm, &mo.precipitation[m * nc..(m + 1) * nc], Some(use_))
                        })
                        .collect()
                }),
            });
        }
    };
    let wind_e: Vec<f64> = if wind {
        cells.wind_e.iter().map(|&v| v as f64).collect()
    } else {
        Vec::new()
    };
    let wind_s: Vec<f64> = if wind {
        cells.wind_s.iter().map(|&v| v as f64).collect()
    } else {
        Vec::new()
    };
    let tsl = &cells.sea_level_temperature;
    for p in 0..n {
        if let Some(alive) = points.alive
            && alive[p] == 0
        {
            continue;
        }
        let x = points.x[p];
        let y = points.y[p];
        let taps = sh.sampler.taps(&mut sh.mesh, x, y);
        let [c0, c1, c2] = taps.corners;
        let [w0, w1, w2] = taps.weights;
        if wind {
            let (we, ws) = sh
                .sampler
                .sample_vector(&mut sh.mesh, &wind_e, &wind_s, x, y, None);
            out.wind_e.as_mut().unwrap()[p] = we as f32;
            out.wind_s.as_mut().unwrap()[p] = ws as f32;
        }
        let l0 = if is_land_cell(c0) { w0 } else { 0.0 };
        let l1 = if is_land_cell(c1) { w1 } else { 0.0 };
        let l2 = if is_land_cell(c2) { w2 } else { 0.0 };
        let land_w = l0 + l1 + l2;
        let sea_w = w0 + w1 + w2 - land_w;
        let tri = |f: &[f32], o: usize| -> f64 {
            w0 * f[o + c0] as f64 + w1 * f[o + c1] as f64 + w2 * f[o + c2] as f64
        };
        if points.land[p] == 0 {
            let (s0, s1, s2) = (w0 - l0, w1 - l1, w2 - l2);
            let sea = |f: &[f32], o: usize| -> f64 {
                (s0 * f[o + c0] as f64 + s1 * f[o + c1] as f64 + s2 * f[o + c2] as f64) / sea_w
            };
            let sst = if sea_w > 0.0 {
                sea(tsl, 0)
            } else {
                tri(tsl, 0)
            };
            out.sea_level_temperature[p] = sst as f32;
            out.temperature[p] = sst as f32;
            out.precipitation[p] = OCEAN_PRECIP as f32;
            out.seasonal_amplitude[p] = OCEAN_AMPLITUDE as f32;
            out.monsoon_index[p] = OCEAN_PRECIP as f32;
            if let (Some(o), Some(u)) = (out.upwelling.as_mut(), cells.upwelling.as_ref()) {
                o[p] = if sea_w > 0.0 { sea(u, 0) } else { 0.0 } as f32;
            }
            if let (Some(om), Some(mo)) = (out.months.as_mut(), months.as_ref()) {
                for m in 0..mo.count {
                    let o = m * nc;
                    let v = if sea_w > 0.0 {
                        sea(&mo.sea_level_temperature, o)
                    } else {
                        tri(&mo.sea_level_temperature, o)
                    };
                    om.temperature[m * n + p] = v as f32;
                    om.precipitation[m * n + p] = OCEAN_PRECIP as f32;
                }
            }
            continue;
        }
        let sea_t = tri(tsl, 0);
        let lapse = lapse_at(points.height.at(p), points.dry.is_some_and(|d| d[p] == 1));
        out.sea_level_temperature[p] = sea_t as f32;
        out.temperature[p] = (sea_t - lapse) as f32;
        let island = if land_w > 0.0 {
            usize::MAX
        } else {
            sh.sampler.nearest_cell(&mut sh.mesh, x, y)
        };
        let over_land = |f: &[f32], o: usize| -> f64 {
            (l0 * f[o + c0] as f64 + l1 * f[o + c1] as f64 + l2 * f[o + c2] as f64) / land_w
        };
        if land_w > 0.0 {
            out.precipitation[p] = over_land(&cells.precipitation, 0) as f32;
            out.seasonal_amplitude[p] = over_land(&cells.seasonal_amplitude, 0) as f32;
        } else {
            islands_of(&mut islands, &sh.mesh);
            let isl = islands.as_ref().unwrap();
            out.precipitation[p] = isl.precipitation[island] as f32;
            out.seasonal_amplitude[p] = isl.amplitude[island] as f32;
        }
        let idx = &cells.monsoon_index;
        let (season, negative) = if land_w > 0.0 {
            let season = (l0 * (idx[c0] as f64).abs()
                + l1 * (idx[c1] as f64).abs()
                + l2 * (idx[c2] as f64).abs())
                / land_w;
            let heaviest = if l0 >= l1 && l0 >= l2 {
                c0
            } else if l1 >= l2 {
                c1
            } else {
                c2
            };
            (season, idx[heaviest] < 0.0)
        } else {
            let isl = islands.as_ref().unwrap();
            (isl.season[island], isl.sign[island] < 0.0)
        };
        out.monsoon_index[p] = if negative { -season } else { season } as f32;
        if let (Some(o), Some(v)) = (
            out.rain_variability.as_mut(),
            cells.rain_variability.as_ref(),
        ) {
            o[p] = if land_w > 0.0 {
                over_land(v, 0)
            } else {
                islands
                    .as_ref()
                    .unwrap()
                    .variability
                    .as_ref()
                    .map_or(0.0, |iv| iv[island])
            } as f32;
        }
        if let (Some(om), Some(mo)) = (out.months.as_mut(), months.as_ref()) {
            for m in 0..mo.count {
                let o = m * nc;
                om.temperature[m * n + p] = (tri(&mo.sea_level_temperature, o) - lapse) as f32;
                om.precipitation[m * n + p] = if land_w > 0.0 {
                    over_land(&mo.precipitation, o)
                } else {
                    islands.as_ref().unwrap().months[m][island]
                } as f32;
            }
        }
    }
    out
}
