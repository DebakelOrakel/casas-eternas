//! The planet preview's climate through the boundary (the runtime's
//! `handlePlanetPreview`): the climate on a sample world's raster, which
//! has no plates and no terrain mesh. The raster and its colours stay the
//! runtime's.

use std::collections::HashMap;

use casas_engine::climate::biomes::{biome, classify_points};
use casas_engine::climate::climate_mesh::climate_cell_m;
use casas_engine::climate::climate_points::{ClimatePoints, Heights, climate_at_points};
use casas_engine::fields::field_mesh::{SharedFieldMesh, shared_field_mesh};
use casas_engine::mesh::mesh_raster::{TriangleRaster, rasterise_node_part, triangle_raster};
use casas_engine::pipeline::world_stages::{climate_chain, pixel_land_of, refined_climate_of};

use crate::forms::{self, ClimateData};
use crate::{EraError, Shape, Value, domain_of, read, wrong};

/// The climate mesh of one preview size and shape, and its pixels'
/// triangles: kept between the previews, as TypeScript keeps them
/// (`sharedFieldMesh`, the runtime's `pixelTriangles`), so that the
/// meshes' walks go on from the last preview.
struct Sample {
    shared: SharedFieldMesh,
    triangles: Option<TriangleRaster>,
}

/// The previews of one generator.
#[derive(Default)]
pub struct Preview {
    samples: HashMap<(Shape, u32, u32), Sample>,
}

impl Preview {
    pub fn new() -> Self {
        Self::default()
    }

    /// The climate on `elevation` (the sample's raster, `width` ×
    /// `height`) under `params` (`ClimateParams`): the body of a
    /// `climateData` without its flags and resolution. The biomes and the
    /// Köppen classes are the climate mesh's own cells' (their centres'
    /// heights), each pixel the heaviest land corner's.
    pub fn climate(
        &mut self,
        shape: Shape,
        width: u32,
        height: u32,
        elevation: &Value,
        params: &Value,
    ) -> Result<Value, EraError> {
        let elevation = read::f32s(elevation, "the preview's elevation")?;
        let size = (width as usize, height as usize);
        if elevation.len() != size.0 * size.1 {
            return Err(wrong("the preview's elevation is not of its size"));
        }
        let params = read::weather(params)?;
        let sample = self
            .samples
            .entry((shape, width, height))
            .or_insert_with(|| {
                let domain = domain_of(shape, width as f64, height as f64);
                Sample {
                    shared: shared_field_mesh(&domain, climate_cell_m(&domain)),
                    triangles: None,
                }
            });
        let sh = &mut sample.shared;
        let chain = climate_chain(sh, elevation, &params, None);
        let terrain = &chain.terrain;
        let (x, y) = (sh.mesh.x.clone(), sh.mesh.y.clone());
        let points = ClimatePoints {
            count: sh.mesh.count,
            x: &x,
            y: &y,
            height: Heights::F64(&terrain.z),
            land: terrain.land.clone(),
            dry: Some(&terrain.dry),
            alive: None,
        };
        let at = climate_at_points(sh, &chain.cells, &points, false);
        let domain = sh.mesh.domain.clone();
        let classes = classify_points(&at, &points, &domain, None);
        let pixel_land = pixel_land_of(elevation, None);
        let tri = &mut sh.mesh.tri;
        let plan = sample
            .triangles
            .get_or_insert_with(|| triangle_raster(tri, size.0, size.1));
        let raster = |tri: &mut _, ids: &[u8], sea: f64| -> Vec<u8> {
            rasterise_node_part(
                tri,
                ids,
                &terrain.land,
                Some(&pixel_land),
                sea,
                size.0,
                size.1,
                true,
                Some(plan),
            )
            .into_iter()
            .map(|v| v as u8)
            .collect()
        };
        let koppen = raster(tri, &classes.koppen, 0.0);
        let biomes = raster(tri, &classes.biome, biome::OCEAN as f64);
        let spacing_m = terrain.cm.cell_m;
        let w = &chain.weather;
        let c = &chain.chart;
        Ok(forms::climate_data(
            &ClimateData {
                temperature: &c.temperature,
                wind: &c.wind,
                currents: &c.currents,
                current_anomaly: &c.current_anomaly,
                precipitation: &c.precipitation,
                seasonal_amplitude: &c.seasonal_amplitude,
                monsoon_index: &c.monsoon_index,
            },
            forms::mesh_vectors(spacing_m, &w.wind.e, &w.wind.s),
            forms::mesh_vectors(spacing_m, &w.currents.e, &w.currents.s),
            koppen,
            biomes,
        ))
    }

    /// The refined climate at given points of a raster's relief: a
    /// measurement, not a world's stage (engine/scripts/earthClimate.mjs
    /// runs it on Earth's relief, 2026-10-29). The cheap climate on
    /// `elevation` (as `climate` makes it), its refinement (as a world's
    /// is made, `refined_climate_of`, no restored state), then the
    /// climate at the points (`x`, `y` in raster units, `heights` in
    /// elevation units, `land` 1 or 0) and their classes.
    /// `{ koppen, T, mT, mP }`: the Köppen–Geiger class per point, the
    /// annual mean temperature, and the twelve months' temperature and
    /// rain, month-major (`m × count + point`).
    #[allow(clippy::too_many_arguments)]
    pub fn refined_climate_at(
        &mut self,
        shape: Shape,
        width: u32,
        height: u32,
        elevation: &Value,
        params: &Value,
        x: &Value,
        y: &Value,
        heights: &Value,
        land: &Value,
    ) -> Result<Value, EraError> {
        let elevation = read::f32s(elevation, "the relief")?;
        if elevation.len() != width as usize * height as usize {
            return Err(wrong("the relief is not of its size"));
        }
        let params = read::weather(params)?;
        let x = read::f64s(x, "the points' x")?;
        let y = read::f64s(y, "the points' y")?;
        let heights = read::f32s(heights, "the points' heights")?;
        let land = read::u8s(land, "the points' land")?.to_vec();
        if y.len() != x.len() || heights.len() != x.len() || land.len() != x.len() {
            return Err(wrong("the points' fields differ in length"));
        }
        let sh = &mut self
            .samples
            .entry((shape, width, height))
            .or_insert_with(|| {
                let domain = domain_of(shape, width as f64, height as f64);
                Sample {
                    shared: shared_field_mesh(&domain, climate_cell_m(&domain)),
                    triangles: None,
                }
            })
            .shared;
        let chain = climate_chain(sh, elevation, &params, None);
        let (temperature, wind) = (
            chain.weather.temperature.clone(),
            chain.weather.wind.clone(),
        );
        drop(chain);
        let refined = refined_climate_of(sh, elevation, &params, &temperature, &wind, None);
        let points = ClimatePoints {
            count: x.len(),
            x: &x,
            y: &y,
            height: Heights::F32(heights),
            land,
            dry: None,
            alive: None,
        };
        let at = climate_at_points(sh, &refined.cells, &points, false);
        let domain = sh.mesh.domain.clone();
        let classes = classify_points(&at, &points, &domain, None);
        let months = at
            .months
            .as_ref()
            .ok_or_else(|| wrong("the refined climate has no months"))?;
        Ok(crate::value::ObjBuilder::new()
            .put("koppen", Value::U8s(classes.koppen))
            .put("T", Value::F32s(at.temperature.clone()))
            .put("mT", Value::F32s(months.temperature.clone()))
            .put("mP", Value::F32s(months.precipitation.clone()))
            .build())
    }
}
