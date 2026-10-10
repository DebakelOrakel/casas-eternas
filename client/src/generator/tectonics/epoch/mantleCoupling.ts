import { computeMembershipField } from '../../crust/raftField'
import { MANTLE_RES_X, MANTLE_RES_Y, computeMantleFlow, evolveMantleField } from '../../mantle/mantleField'
import { fitMotionsToFlow, relaxMotionToward } from '../plateMotion'
import { TECTONICS_TUNING } from '../tectonicsTuneParams'
import type { PlateSimulation } from '../plateSimulationTypes'



// Phase 0. The mantle drives the plates: evolve the field under the current
// crust, derive its surface flow, and relax each plate's motion toward the
// flow-fitted rigid motion. Returns the continental-membership field, which
// phase 1 reuses rather than recomputing.
export function coupleMantleToPlates(sim: PlateSimulation): Float32Array {
  // 0. The mantle drives the plates. Evolve the field under the current crust
  // (continents insulate → upwelling; ocean cools → downwelling), derive its
  // surface flow, and relax each plate's motion toward the flow-fitted rigid
  // motion (inertia). This is what makes assembly AND breakup emerge — plates
  // drift to downwellings and assemble, an assembled continent then insulates an
  // upwelling beneath it that pushes its plates apart. See mantleField.ts.
  // One continental-membership sweep for the whole epoch, shared by the mantle
  // coupling and the ocean-age sink below — raftMembership is O(blobs) per query
  // and blob counts grow through a run, so two independent full-surface sweeps
  // would be the expensive way to ask the same question twice.
  //
  // Computed at the MANTLE resolution, not the finer ocean-age one, specifically
  // so the mantle sees the same values as the raftMembership calls it used to make
  // itself. Sampling a finer field at the mantle's cell centres lands half a fine
  // cell off, which can flip a cell across the > 0.5 insulation threshold — and the
  // mantle drives plate motion, so that is enough to send a chaotic system down a
  // different path. The ocean-age sink is a new consumer with no behaviour to
  // preserve, and "is this under a continent" is a broad question, so the coarser
  // grid is fine for it.
  const membership = computeMembershipField(sim.rafts, MANTLE_RES_X, MANTLE_RES_Y, sim.domain)
  sim.mantle = evolveMantleField(sim.mantle, membership, MANTLE_RES_X, MANTLE_RES_Y, sim.domain)
  const flow = computeMantleFlow(sim.mantle, sim.domain)
  const fitted = fitMotionsToFlow(sim.seeds, flow, sim.domain)
  for (let i = 0; i < sim.motions.length; i++) relaxMotionToward(sim.motions[i], fitted[i], TECTONICS_TUNING.mantleCouplingRate)
  return membership
}
