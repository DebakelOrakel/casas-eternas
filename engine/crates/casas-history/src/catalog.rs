//! The catalogs (`data/catalog.json`, the client's plants.ts, trees.ts,
//! animals.ts read the same file): the plants, the trees and the animals
//! as niches over the habitat, and the herbivores' share of each biome.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// A niche over the habitat (plants.ts NicheSpec).
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Niche {
    pub id: String,
    /// The weight by Köppen code. A map in the file's order is not needed:
    /// it is read by code.
    pub climates: BTreeMap<String, f64>,
    #[serde(default)]
    pub oasis: Vec<String>,
    pub height: Option<[f64; 4]>,
    pub slope: Option<[f64; 4]>,
    pub wet: Option<f64>,
    pub floodplain: Option<f64>,
    pub coast: Option<f64>,
    pub cover: Option<String>,
    #[serde(default)]
    pub salt: bool,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Plant {
    #[serde(flatten)]
    pub niche: Niche,
    #[serde(rename = "use")]
    pub use_: String,
    pub domesticable: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Tree {
    #[serde(flatten)]
    pub niche: Niche,
    pub woods: Vec<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Animal {
    #[serde(flatten)]
    pub niche: Niche,
    pub uses: Vec<String>,
    pub role: String,
    #[serde(default)]
    pub upriver: bool,
    #[serde(default)]
    pub by_sea: bool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub plants: Vec<Plant>,
    pub trees: Vec<Tree>,
    pub animals: Vec<Animal>,
    /// By the biome's name (generator/climate/biomes.ts `Biome`).
    pub edible_share: BTreeMap<String, f64>,
    /// The big game and how vulnerable each is (settle.ts MEGAFAUNA).
    pub megafauna: BTreeMap<String, f64>,
    /// The herd animals the herders keep (incubatorWorker.ts HERD_ANIMALS).
    pub herd_animals: Vec<String>,
}

/// The catalog, read once.
pub fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../data/catalog.json")).expect("data/catalog.json")
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_catalog_reads() {
        let c = super::catalog();
        assert!(!c.plants.is_empty() && !c.trees.is_empty() && !c.animals.is_empty());
    }
}
