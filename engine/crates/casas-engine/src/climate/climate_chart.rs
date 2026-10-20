//! `climate/climateChart.ts`: the climate's field-mesh fields on the
//! CLIMATE_RES_X × CLIMATE_RES_Y chart raster, for the screen and a save's
//! readers. No stage reads it. A land field keeps its sea mark on the
//! chart's sea pixels and mixes only the land corners on its land pixels;
//! a sea field is 0 on the chart's land; a vector is each pixel's in its
//! own frame. The TypeScript file explains the conventions.

use crate::core::domain::Domain;
use crate::core::js;
use crate::elevation::elevation_scale::is_land_at;
use crate::fields::field_mesh::{SharedFieldMesh, rasterise_field, rasterise_vector_field};

use super::climate_field::{CLIMATE_RES_X, CLIMATE_RES_Y};
use super::climate_mesh::{ClimateMesh, ClimateTerrain, zonal_mean};
use super::climate_points::{ClimateCells, lapse_at};
use super::precipitation::OCEAN_PRECIP;
use super::refinement::{RefinedClimate, RefinedReliability, RefinedStorms};
use super::seasonality::OCEAN_AMPLITUDE;
use super::weather::WeatherMesh;

/// A field on the chart.
pub fn chart_field<T: Copy + Into<f64>>(
    sh: &mut SharedFieldMesh,
    field: &[T],
    res_x: usize,
    res_y: usize,
) -> Vec<f32> {
    rasterise_field(&mut sh.mesh, field, res_x, res_y)
}

/// A vector field on the chart, interleaved [east, south].
pub fn chart_vector_field<T: Copy + Into<f64>>(
    sh: &mut SharedFieldMesh,
    fe: &[T],
    fs: &[T],
    res_x: usize,
    res_y: usize,
) -> Vec<f32> {
    let fe: Vec<f64> = fe.iter().map(|&v| v.into()).collect();
    let fs: Vec<f64> = fs.iter().map(|&v| v.into()).collect();
    rasterise_vector_field(&sh.sampler, &mut sh.mesh, &fe, &fs, res_x, res_y)
}

/// The terrain a chart's land is read off.
pub struct ChartTerrain<'a> {
    pub domain: &'a Domain,
    pub elevation: &'a [f32],
    pub res_x: usize,
    pub res_y: usize,
    pub dry_land: Option<&'a [u8]>,
}

impl<'a> ChartTerrain<'a> {
    pub fn of(t: &'a ClimateTerrain) -> Self {
        ChartTerrain {
            domain: &t.domain,
            elevation: &t.elevation,
            res_x: t.res_x,
            res_y: t.res_y,
            dry_land: t.dry_land.as_deref(),
        }
    }

    fn texel(&self, gx: usize, gy: usize, res_x: usize, res_y: usize) -> usize {
        let kx = self.res_x as f64 / self.domain.width;
        let ky = self.res_y as f64 / self.domain.height;
        let ty = js::min(
            (self.res_y - 1) as f64,
            (((gy as f64 + 0.5) / res_y as f64) * self.domain.height * ky).floor(),
        ) as usize;
        let tx = js::min(
            (self.res_x - 1) as f64,
            (((gx as f64 + 0.5) / res_x as f64) * self.domain.width * kx).floor(),
        ) as usize;
        ty * self.res_x + tx
    }
}

/// The land test of a res_x × res_y chart: the texel under each pixel's
/// centre.
pub fn chart_land(terrain: &ChartTerrain, res_x: usize, res_y: usize) -> Vec<u8> {
    let d = terrain.domain;
    let kx = terrain.res_x as f64 / d.width;
    let ky = terrain.res_y as f64 / d.height;
    let mut out = vec![0u8; res_x * res_y];
    for gy in 0..res_y {
        let y = ((gy as f64 + 0.5) / res_y as f64) * d.height;
        let ty = js::min((terrain.res_y - 1) as f64, (y * ky).floor()) as usize;
        for gx in 0..res_x {
            let x = ((gx as f64 + 0.5) / res_x as f64) * d.width;
            let t =
                ty * terrain.res_x + js::min((terrain.res_x - 1) as f64, (x * kx).floor()) as usize;
            let dry = terrain.dry_land.is_some_and(|dl| dl[t] == 1);
            out[gy * res_x + gx] = u8::from(is_land_at(terrain.elevation[t] as f64, dry));
        }
    }
    out
}

/// A sea field, 0 on the chart's land.
pub fn chart_sea_field<T: Copy + Into<f64>>(
    sh: &mut SharedFieldMesh,
    field: &[T],
    land_pixels: &[u8],
    res_x: usize,
    res_y: usize,
) -> Vec<f32> {
    let mut out = rasterise_field(&mut sh.mesh, field, res_x, res_y);
    for (o, &l) in out.iter_mut().zip(land_pixels) {
        if l != 0 {
            *o = 0.0;
        }
    }
    out
}

pub fn chart_sea_vector_field<T: Copy + Into<f64>>(
    sh: &mut SharedFieldMesh,
    fe: &[T],
    fs: &[T],
    land_pixels: &[u8],
    res_x: usize,
    res_y: usize,
) -> Vec<f32> {
    let mut out = chart_vector_field(sh, fe, fs, res_x, res_y);
    for (p, &l) in land_pixels.iter().enumerate() {
        if l != 0 {
            out[2 * p] = 0.0;
            out[2 * p + 1] = 0.0;
        }
    }
    out
}

/// A land field: `is_land(i)` the cells it holds a value on, `sea_value` on
/// the chart's sea.
#[allow(clippy::too_many_arguments)]
pub fn chart_land_field<T: Copy + Into<f64>>(
    sh: &mut SharedFieldMesh,
    cm: &ClimateMesh,
    field: &[T],
    is_land: &dyn Fn(usize) -> bool,
    sea_value: f64,
    land_pixels: &[u8],
    res_x: usize,
    res_y: usize,
) -> Vec<f32> {
    let islands = zonal_mean(cm, &sh.mesh, field, Some(is_land));
    let sx = sh.mesh.domain.width / res_x as f64;
    let sy = sh.mesh.domain.height / res_y as f64;
    let mut out = vec![0f32; res_x * res_y];
    for gy in 0..res_y {
        let y = (gy as f64 + 0.5) * sy;
        for gx in 0..res_x {
            let p = gy * res_x + gx;
            if land_pixels[p] == 0 {
                out[p] = sea_value as f32;
                continue;
            }
            let x = (gx as f64 + 0.5) * sx;
            let taps = sh.sampler.taps(&mut sh.mesh, x, y);
            let (mut s, mut w) = (0.0, 0.0);
            for k in 0..3 {
                let c = taps.corners[k];
                if !is_land(c) {
                    continue;
                }
                s += taps.weights[k] * field[c].into();
                w += taps.weights[k];
            }
            out[p] = if w > 0.0 {
                s / w
            } else {
                islands[sh.sampler.nearest_cell(&mut sh.mesh, x, y)]
            } as f32;
        }
    }
    out
}

/// The static climate as the screen's textures.
pub struct WeatherChart {
    pub temperature: Vec<f32>,
    pub wind: Vec<f32>,
    pub seasonal_amplitude: Vec<f32>,
    pub precipitation: Vec<f32>,
    pub monsoon_index: Vec<f32>,
    pub currents: Vec<f32>,
    pub current_anomaly: Vec<f32>,
}

pub fn weather_chart(
    sh: &mut SharedFieldMesh,
    terrain: &ClimateTerrain,
    mesh: &WeatherMesh,
) -> WeatherChart {
    let (rx, ry) = (CLIMATE_RES_X, CLIMATE_RES_Y);
    let cm = &terrain.cm;
    let land_pixels = chart_land(&ChartTerrain::of(terrain), rx, ry);
    let land = &terrain.land;
    let temperature = chart_field(sh, &mesh.temperature, rx, ry);
    let wind = chart_vector_field(sh, &mesh.wind.e, &mesh.wind.s, rx, ry);
    let amp = &mesh.seasonal_amplitude;
    let seasonal_amplitude = chart_land_field(
        sh,
        cm,
        amp,
        &|i| land[i] == 1 && amp[i] != OCEAN_AMPLITUDE,
        OCEAN_AMPLITUDE,
        &land_pixels,
        rx,
        ry,
    );
    let annual = &mesh.seasonal.annual;
    let precipitation = chart_land_field(
        sh,
        cm,
        annual,
        &|i| land[i] == 1 && annual[i] != OCEAN_PRECIP,
        OCEAN_PRECIP,
        &land_pixels,
        rx,
        ry,
    );
    let index = &mesh.seasonal.index;
    let monsoon_index = chart_land_field(
        sh,
        cm,
        index,
        &|i| land[i] == 1 && index[i] != OCEAN_PRECIP,
        OCEAN_PRECIP,
        &land_pixels,
        rx,
        ry,
    );
    let currents =
        chart_sea_vector_field(sh, &mesh.currents.e, &mesh.currents.s, &land_pixels, rx, ry);
    let current_anomaly = chart_sea_field(sh, &mesh.current_anomaly, &land_pixels, rx, ry);
    WeatherChart {
        temperature,
        wind,
        seasonal_amplitude,
        precipitation,
        monsoon_index,
        currents,
        current_anomaly,
    }
}

/// A climate's annual cells as charts: the temperature at each pixel's
/// texel height, the land fields with their marks, the land mask.
pub struct CellsChart {
    pub temperature: Vec<f32>,
    pub precipitation: Vec<f32>,
    pub seasonal_amplitude: Vec<f32>,
    pub monsoon_index: Vec<f32>,
    pub land_mask: Vec<f32>,
}

pub fn cells_chart(
    sh: &mut SharedFieldMesh,
    cells: &ClimateCells,
    terrain: &ChartTerrain,
    res_x: usize,
    res_y: usize,
) -> CellsChart {
    let cm = &cells.cm;
    let land_pixels = chart_land(terrain, res_x, res_y);
    let is_land = |i: usize| cells.precipitation[i] as f64 != OCEAN_PRECIP;
    let mut temperature = chart_field(sh, &cells.sea_level_temperature, res_x, res_y);
    for gy in 0..res_y {
        for gx in 0..res_x {
            let t = terrain.texel(gx, gy, res_x, res_y);
            let dry = terrain.dry_land.is_some_and(|dl| dl[t] == 1);
            let p = gy * res_x + gx;
            temperature[p] =
                (temperature[p] as f64 - lapse_at(terrain.elevation[t] as f64, dry)) as f32;
        }
    }
    let land_mask = land_pixels.iter().map(|&l| l as f32).collect();
    CellsChart {
        temperature,
        precipitation: chart_land_field(
            sh,
            cm,
            &cells.precipitation,
            &is_land,
            OCEAN_PRECIP,
            &land_pixels,
            res_x,
            res_y,
        ),
        seasonal_amplitude: chart_land_field(
            sh,
            cm,
            &cells.seasonal_amplitude,
            &is_land,
            OCEAN_AMPLITUDE,
            &land_pixels,
            res_x,
            res_y,
        ),
        monsoon_index: chart_land_field(
            sh,
            cm,
            &cells.monsoon_index,
            &is_land,
            OCEAN_PRECIP,
            &land_pixels,
            res_x,
            res_y,
        ),
        land_mask,
    }
}

/// The refinement as the screen's textures, the months month-major, the
/// vectors interleaved.
pub struct RefinedClimateChart {
    pub months: usize,
    pub temperature: Vec<f32>,
    pub precipitation: Vec<f32>,
    pub pressure: Vec<f32>,
    pub wind: Vec<f32>,
    pub currents: Vec<f32>,
    pub current_anomaly: Vec<f32>,
    pub upwelling: Vec<f32>,
    pub salinity: Vec<f32>,
    pub deep_water: Vec<f32>,
    pub fog: Vec<f32>,
    pub foehn: Vec<f32>,
    pub reliability: RefinedReliability,
    pub storms: RefinedStorms,
}

pub fn refined_chart(
    sh: &mut SharedFieldMesh,
    r: &RefinedClimate,
    terrain: &ClimateTerrain,
) -> RefinedClimateChart {
    let (rx, ry) = (CLIMATE_RES_X, CLIMATE_RES_Y);
    let cm = &terrain.cm;
    let land = &terrain.land;
    let px = rx * ry;
    let n = r.cells;
    let months = r.months;
    let land_pixels = chart_land(&ChartTerrain::of(terrain), rx, ry);
    let mut temperature = vec![0f32; months * px];
    let mut precipitation = vec![0f32; months * px];
    let mut pressure = vec![0f32; months * px];
    let mut wind = vec![0f32; months * px * 2];
    for m in 0..months {
        let at = |f: &[f32]| -> Vec<f32> { f[m * n..(m + 1) * n].to_vec() };
        let rain = at(&r.precipitation);
        temperature[m * px..(m + 1) * px].copy_from_slice(&chart_field(
            sh,
            &at(&r.temperature),
            rx,
            ry,
        ));
        let p = chart_land_field(
            sh,
            cm,
            &rain,
            &|i| land[i] == 1 && rain[i] as f64 != OCEAN_PRECIP,
            OCEAN_PRECIP,
            &land_pixels,
            rx,
            ry,
        );
        precipitation[m * px..(m + 1) * px].copy_from_slice(&p);
        pressure[m * px..(m + 1) * px].copy_from_slice(&chart_field(sh, &at(&r.pressure), rx, ry));
        let w = chart_vector_field(sh, &at(&r.wind_e), &at(&r.wind_s), rx, ry);
        wind[m * px * 2..(m + 1) * px * 2].copy_from_slice(&w);
    }
    let currents = chart_sea_vector_field(sh, &r.current_e, &r.current_s, &land_pixels, rx, ry);
    let mut sea = |f: &[f32]| chart_sea_field(sh, f, &land_pixels, rx, ry);
    let current_anomaly = sea(&r.current_anomaly);
    let upwelling = sea(&r.upwelling);
    let salinity = sea(&r.salinity);
    let deep_water = sea(&r.deep_water);
    let land_only = |sh: &mut SharedFieldMesh, f: &[f32]| {
        chart_land_field(sh, cm, f, &|i| land[i] == 1, 0.0, &land_pixels, rx, ry)
    };
    let fog = land_only(sh, &r.fog);
    let foehn = land_only(sh, &r.foehn);
    let rain_variability = land_only(sh, &r.reliability.rain_variability);
    let enso_pattern = land_only(sh, &r.reliability.enso_pattern);
    let cyclone = chart_field(sh, &r.storms.cyclone, rx, ry);
    let tornado = land_only(sh, &r.storms.tornado);
    let blizzard = land_only(sh, &r.storms.blizzard);
    let dust = chart_field(sh, &r.storms.dust, rx, ry);
    let thunder = chart_field(sh, &r.storms.thunder, rx, ry);
    RefinedClimateChart {
        months,
        temperature,
        precipitation,
        pressure,
        wind,
        currents,
        current_anomaly,
        upwelling,
        salinity,
        deep_water,
        fog,
        foehn,
        reliability: RefinedReliability {
            rain_variability,
            enso_pattern,
            enso_period_years: r.reliability.enso_period_years,
            enso_strength: r.reliability.enso_strength,
        },
        storms: RefinedStorms {
            cyclone,
            tornado,
            blizzard,
            dust,
            thunder,
        },
    }
}
