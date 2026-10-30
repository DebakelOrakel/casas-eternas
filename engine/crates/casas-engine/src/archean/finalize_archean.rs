//! Plate tectonics begins. A plate seed at each prominent extremum of
//! the mantle, the continents named by their land, the plumes from the
//! field. The reasoning is in the TypeScript port
//! (`client/src/generator/archean/finalizeArchean.ts`, git history).

use crate::core::det_math::sq;
use crate::core::domain::{Domain, domain_area};
use crate::crust::raft_field::{build_blob_index, derive_plate_types, raft_fields_indexed};
use crate::crust::raft_names::assign_raft_names;
use crate::crust::raft_types::Raft;
use crate::elevation::elevation_scale::{ABYSSAL_FLOOR, margin_parameter, margin_profile};
use crate::mantle::mantle_field::MantleMesh;
use crate::tectonics::boundary_lattice::generate_detection_lattice;
use crate::tectonics::ocean_age::create_ocean_age_field;
use crate::tectonics::plate_motion::generate_plate_motions;
use crate::tectonics::plate_seeds::PlateSeed;
use crate::tectonics::plate_simulation_types::PlateSimulation;
use crate::tectonics::plumes::find_plume_sites;
use crate::tectonics::tectonics_tune_params::TECTONICS_TUNING;

use super::archean_state::ArcheanSimulation;

const EXTREMUM_PROMINENCE: f64 = 0.35;
const MIN_SEED_SEPARATION_FRAC: f64 = 0.22;

/// A seed at each cell above or below all its neighbours by the
/// prominence, the strongest first, thinned by the separation.
pub fn convection_cell_seeds(mantle: &[f64], mm: &MantleMesh, domain: &Domain) -> Vec<PlateSeed> {
    let mesh = &mm.mesh;
    let mut candidates: Vec<(f64, f64, f64)> = Vec::new();
    for i in 0..mesh.count {
        let v = mantle[i];
        let (mut is_max, mut is_min) = (true, true);
        for e in mesh.edges(i) {
            if !(is_max || is_min) {
                break;
            }
            let n = mantle[mesh.nbr[e] as usize];
            if n >= v {
                is_max = false;
            }
            if n <= v {
                is_min = false;
            }
        }
        if !is_max && !is_min {
            continue;
        }
        if v.abs() < EXTREMUM_PROMINENCE {
            continue;
        }
        candidates.push((mesh.x[i], mesh.y[i], v.abs()));
    }
    candidates.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let min_sep_sq = sq(MIN_SEED_SEPARATION_FRAC * (domain_area(domain) / 2.0).sqrt());
    let mut seeds: Vec<PlateSeed> = Vec::new();
    for &(x, y, _) in &candidates {
        if seeds
            .iter()
            .any(|s| domain.distance_sq(s.x, s.y, x, y) < min_sep_sq)
        {
            continue;
        }
        seeds.push(PlateSeed { x, y });
    }
    seeds
}

const LAND_MEASURE_RES_X: usize = 512;
const LAND_MEASURE_RES_Y: usize = 256;

/// Land cells per raft, each to the raft contributing most of its field.
fn measure_raft_land_areas(rafts: &[Raft], domain: &Domain) -> Vec<f64> {
    let mut areas = vec![0.0; rafts.len()];
    let blobs = build_blob_index(rafts, domain, 1.0);
    let mut per_raft = vec![0.0; rafts.len()];
    for gy in 0..LAND_MEASURE_RES_Y {
        let wy = ((gy as f64 + 0.5) / LAND_MEASURE_RES_Y as f64) * domain.height;
        for gx in 0..LAND_MEASURE_RES_X {
            let wx = ((gx as f64 + 0.5) / LAND_MEASURE_RES_X as f64) * domain.width;
            let field = raft_fields_indexed(wx, wy, &blobs, &mut per_raft);
            if margin_profile(margin_parameter(field), ABYSSAL_FLOOR) <= 0.0 {
                continue;
            }
            let (mut best, mut best_field) = (None, 0.0);
            for (i, &f) in per_raft.iter().enumerate() {
                if f > best_field {
                    best_field = f;
                    best = Some(i);
                }
            }
            if let Some(b) = best {
                areas[b] += 1.0;
            }
        }
    }
    areas
}

/// The Archean world as a plate simulation; its meshes go with it.
pub fn finalize_archean(archean: ArcheanSimulation) -> PlateSimulation {
    let ArcheanSimulation {
        width,
        height,
        domain,
        meshes,
        epoch,
        mut random,
        warp_seed,
        rafts,
        mantle,
        ..
    } = archean;
    let areas = measure_raft_land_areas(&rafts, &domain);
    let named = assign_raft_names(&rafts, &mut || random.next(), &areas);
    let ocean_age = create_ocean_age_field(TECTONICS_TUNING.ocean_age_init, &meshes.shared);
    let seeds = convection_cell_seeds(&mantle, &meshes.mantle, &domain);
    let lattice = generate_detection_lattice(
        &domain,
        TECTONICS_TUNING.detection_lattice_resolution_x,
        TECTONICS_TUNING.detection_lattice_resolution_y,
    );
    let n = lattice.len();
    let types = derive_plate_types(&seeds, &named, &domain);
    let motions = generate_plate_motions(&seeds, &domain, &mut || random.next());
    let hotspots = find_plume_sites(&mantle, &meshes.mantle, &domain, 0.0, &[]);
    PlateSimulation {
        width,
        height,
        initial_plate_count: seeds.len() as f64,
        ages: vec![0.0; seeds.len()],
        seeds,
        supercontinent_active: named.len() <= 1,
        rafts: named,
        types,
        motions,
        features: Vec::new(),
        epoch: 0.0,
        archean_epochs: epoch,
        epoch_ma: 1.0,
        sediment_export_m3: 0.0,
        eustatic_m: 0.0,
        climate_history: Vec::new(),
        lake_ages: Vec::new(),
        random,
        warp_seed,
        lattice,
        lattice_accumulated: vec![0.0; n],
        lattice_locked_epochs: vec![0; n],
        lattice_last_class_code: vec![-1; n],
        ocean_age,
        continental_rift_cooldown_until: 0.0,
        mantle,
        hotspots,
        sutures: Vec::new(),
        domain,
        meshes,
    }
}
