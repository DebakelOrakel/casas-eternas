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
use casas_engine::pipeline::world_stages::{climate_chain, pixel_land_of};

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
}
