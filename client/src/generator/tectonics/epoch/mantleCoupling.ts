import { computeMembershipField } from '../../crust/raftField'
import { MANTLE_RES_X, MANTLE_RES_Y, computeMantleFlow, evolveMantleField } from '../../mantle/mantleField'
import { fitMotionsToFlow, relaxMotionToward } from '../plateMotion'
import { TECTONICS_TUNING } from '../tectonicsTuneParams'
import type { PlateSimulation } from '../plateSimulationTypes'



// Phase 0. The mantle drives the plates: evolve the field under the current
// crust, derive its surface flow, and relax each plate's motion toward the
// flow-fitted rigid motion. Returns the continental-membership raster the
// ocean-age sink reads (phase 1 of the epoch).
export function coupleMantleToPlates(sim: PlateSimulation): Float32Array {
  // 0. The mantle drives the plates. Evolve the field under the current crust
  // (continents insulate → upwelling; ocean cools → downwelling), derive its
  // surface flow, and relax each plate's motion toward the flow-fitted rigid
  // motion (inertia). This is what makes assembly AND breakup emerge — plates
  // drift to downwellings and assemble, an assembled continent then insulates an
  // upwelling beneath it that pushes its plates apart. See mantleField.ts.
  //
  // The continental-membership raster is the ocean-age sink's, on the
  // mantle's former 128 × 64 chart ("is this under a continent" is a broad
  // question). The mantle itself asks the rafts at its own cells' centres
  // since it moved onto the field mesh (DEC-0036 phase 1, evolveMantleField):
  // two sweeps until the ocean age follows it (phase 2), the mantle's of a
  // few thousand points.
  const membership = computeMembershipField(sim.rafts, MANTLE_RES_X, MANTLE_RES_Y, sim.domain)
  sim.mantle = evolveMantleField(sim.mantle, sim.rafts, sim.domain)
  const flow = computeMantleFlow(sim.mantle, sim.domain)
  const fitted = fitMotionsToFlow(sim.seeds, flow, sim.domain)
  for (let i = 0; i < sim.motions.length; i++) relaxMotionToward(sim.motions[i], fitted[i], TECTONICS_TUNING.mantleCouplingRate)
  return membership
}
