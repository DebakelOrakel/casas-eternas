import { TECTONICS_TUNING } from '../tectonicsTuneParams'
import type { PlateSimulation } from '../plateSimulationTypes'



// Phase 6. Drop features that are both long-inactive and decayed to nothing —
// the actual fix for the simulation slowing down over a long run.
export function pruneSpentFeatures(sim: PlateSimulation): void {
  // Drop features that have been both inactive for a while AND decayed
  // to a negligible thickness, plus anything inactive long enough to hit
  // the hard cap regardless of thickness — see TECTONICS_TUNING.featurePruneThickness's
  // own comment for why this is the actual fix for the simulation
  // slowing down over a long run.
  sim.features = sim.features.filter((feature) => {
    if (feature.epochsSinceDeposit <= TECTONICS_TUNING.featurePruneInactivityEpochs) return true
    if (feature.epochsSinceDeposit > TECTONICS_TUNING.featurePruneMaxInactivityEpochs) return false
    return Math.abs(feature.thickness) >= TECTONICS_TUNING.featurePruneThickness
  })
}
