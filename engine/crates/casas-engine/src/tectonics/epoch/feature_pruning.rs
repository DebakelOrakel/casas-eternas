//! `tectonics/epoch/featurePruning.ts`, phase 6: the features both long
//! inactive and decayed to nothing go.

use crate::tectonics::plate_simulation_types::PlateSimulation;
use crate::tectonics::tectonics_tune_params::TECTONICS_TUNING as T;

pub fn prune_spent_features(sim: &mut PlateSimulation) {
    sim.features.retain(|f| {
        if f.epochs_since_deposit <= T.feature_prune_inactivity_epochs {
            return true;
        }
        if f.epochs_since_deposit > T.feature_prune_max_inactivity_epochs {
            return false;
        }
        f.thickness.abs() >= T.feature_prune_thickness
    });
}
