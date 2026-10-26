//! The WASM build of the incubator's history for the browser
//! (docs/decisions/incubator-history-engine.md, fork 3). `make engine` runs
//! wasm-bindgen over it into `engine/dist/history/`. One object, the
//! incubator's worker's state: the habitat made once a world, then what is
//! grown and run on it.

use casas_history::habitat::{CELL_ECOLOGY, CellInput, Habitat, build_cells};
use wasm_bindgen::prelude::*;

/// The history's version (`casas_history::HISTORY_VERSION`).
#[wasm_bindgen]
pub fn version() -> String {
    casas_history::HISTORY_VERSION.to_string()
}

#[wasm_bindgen]
pub struct Incubator {
    habitat: Habitat,
    owners: Vec<i32>,
}

#[wasm_bindgen]
impl Incubator {
    /// The habitat (habitat.rs build_cells). `ecology`: CELL_ECOLOGY's
    /// fields' fine codes, one after the other, those whose bit is set in
    /// `ecology_present`; the rivers' three arrays, or none.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        sphere: bool,
        spacing_km: f64,
        width: f64,
        height: f64,
        nodes: &[i32],
        node_w: usize,
        node_h: usize,
        land: &[u8],
        biome: &[u8],
        koppen: &[u8],
        z: &[f32],
        lake_depth: &[f32],
        ecology: &[u8],
        ecology_present: u32,
        river_points: Option<Vec<f32>>,
        river_lengths: Option<Vec<u32>>,
        river_regimes: Option<Vec<u8>>,
    ) -> Incubator {
        let nodes_count = land.len();
        let mut fields: [Option<&[u8]>; 8] = [None; 8];
        let mut at = 0;
        for (k, field) in fields.iter_mut().enumerate() {
            if ecology_present & (1 << k) != 0 {
                *field = Some(&ecology[at..at + nodes_count]);
                at += nodes_count;
            }
        }
        let rivers = match (&river_points, &river_lengths, &river_regimes) {
            (Some(p), Some(l), Some(r)) => Some((p.as_slice(), l.as_slice(), r.as_slice())),
            _ => None,
        };
        let input = CellInput {
            sphere,
            spacing_km,
            width,
            height,
            nodes,
            node_w,
            node_h,
            land,
            biome,
            koppen,
            z,
            lake_depth,
            ecology: fields,
            rivers,
        };
        let (habitat, owners) = build_cells(&input);
        Incubator { habitat, owners }
    }

    pub fn count(&self) -> usize {
        self.habitat.count
    }

    pub fn owners(&self) -> Vec<i32> {
        self.owners.clone()
    }

    /// The habitat's numbers: the land's cells, the landmasses, the globe's
    /// radius, the torus's width and height (km).
    pub fn scalars(&self) -> Vec<f64> {
        let h = &self.habitat;
        vec![
            h.land_count as f64,
            h.landmasses as f64,
            h.radius_km,
            h.width_km,
            h.height_km,
        ]
    }

    /// A habitat array by its TypeScript name (habitat.ts), as floats;
    /// `eco:<id>` for an ecology field.
    pub fn floats(&self, name: &str) -> Result<Vec<f32>, JsError> {
        let h = &self.habitat;
        Ok(match name {
            "areaKm2" => h.area_km2.clone(),
            "heightM" => h.height_m.clone(),
            "slope" => h.slope.clone(),
            "seaDepthM" => h.sea_depth_m.clone(),
            "riverSize" => h.river_size.clone(),
            "distKm" => h.dist_km.clone(),
            "u" => h.u.clone(),
            "v" => h.v.clone(),
            _ => {
                let id = name
                    .strip_prefix("eco:")
                    .ok_or_else(|| JsError::new(&format!("no habitat array {name}")))?;
                let k = CELL_ECOLOGY
                    .iter()
                    .position(|f| *f == id)
                    .ok_or_else(|| JsError::new(&format!("no ecology field {id}")))?;
                h.ecology[k]
                    .clone()
                    .ok_or_else(|| JsError::new(&format!("the level holds no {id}")))?
            }
        })
    }

    pub fn bytes(&self, name: &str) -> Result<Vec<u8>, JsError> {
        let h = &self.habitat;
        Ok(match name {
            "land" => h.land.clone(),
            "biome" => h.biome.clone(),
            "koppen" => h.koppen.clone(),
            "nearRiver" => h.near_river.clone(),
            "nearLake" => h.near_lake.clone(),
            "nearSea" => h.near_sea.clone(),
            _ => return Err(JsError::new(&format!("no habitat array {name}"))),
        })
    }

    pub fn ints(&self, name: &str) -> Result<Vec<i32>, JsError> {
        let h = &self.habitat;
        Ok(match name {
            "landmass" => h.landmass.clone(),
            "nbrStart" => h.nbr_start.iter().map(|&x| x as i32).collect(),
            "nbr" => h.nbr.iter().map(|&x| x as i32).collect(),
            _ => return Err(JsError::new(&format!("no habitat array {name}"))),
        })
    }

    #[wasm_bindgen(js_name = landmassKm2)]
    pub fn landmass_km2(&self) -> Vec<f64> {
        self.habitat.landmass_km2.clone()
    }
}
