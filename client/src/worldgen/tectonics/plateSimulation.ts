import { generateDetectionLattice } from './boundaryLattice'
import { createMantleField } from './mantleField'
import { mulberry32 } from '../core/rng'
import { derivePlateTypes } from '../crust/raftField'
import { DETECTION_LATTICE_RESOLUTION_X, DETECTION_LATTICE_RESOLUTION_Y, HOTSPOT_COUNT } from './tectonicsParams'
import { coupleMantleToPlates } from './epoch/mantleCoupling'
import { advancePlatesAndCrust } from './epoch/plateDrift'
import { runBoundaryPass } from './epoch/boundaryPass'
import { applyRaftEvents } from './epoch/raftEvents'
import { collectEventsAndApplyPlateChurn } from './epoch/plateChurn'
import { pruneSpentFeatures } from './epoch/featurePruning'
import type { PlateSimulation, PlateSimulationSnapshot, SimEvent } from './plateSimulationTypes'


// Persisting a world and running an epoch of it. The epoch's six phases live in
// epoch/ — stepEpoch at the bottom is now just their order, which is the one thing
// about them that has to be read top to bottom.
//
// BUILDING a world is no longer here. It happens in archean/, which runs the Archean
// and then hands over through finalizeArchean; this module's createPlateSimulation
// took the four Genesis sliders (plate count, land fraction, clustering, craton
// count) that the panel replaced with an emergent simulation, and nothing had called
// it since.
export type { PlateSimulation, PlateSimulationSnapshot, SimEvent, SimEventType } from './plateSimulationTypes'
export { eventCategory } from './plateSimulationTypes'


export function createHotspots(random: () => number, width: number, height: number): { x: number; y: number }[] {
  return Array.from({ length: HOTSPOT_COUNT }, () => ({ x: random() * width, y: random() * height }))
}


export function serializePlateSimulation(sim: PlateSimulation): PlateSimulationSnapshot {
  return {
    width: sim.width,
    height: sim.height,
    initialPlateCount: sim.initialPlateCount,
    seeds: sim.seeds,
    motions: sim.motions,
    ages: sim.ages,
    rafts: sim.rafts,
    features: sim.features,
    epoch: sim.epoch,
    archeanEpochs: sim.archeanEpochs,
    seaLevelOffset: sim.seaLevelOffset,
    warpSeed: sim.warpSeed,
    supercontinentActive: sim.supercontinentActive,
    continentalRiftCooldownUntil: sim.continentalRiftCooldownUntil,
    hotspots: sim.hotspots,
    sutures: sim.sutures,
    rngState: sim.random.state(),
  }
}

export function deserializePlateSimulation(snap: PlateSimulationSnapshot, oceanAge: Float32Array): PlateSimulation {
  const lattice = generateDetectionLattice(snap.width, snap.height, DETECTION_LATTICE_RESOLUTION_X, DETECTION_LATTICE_RESOLUTION_Y)
  return {
    width: snap.width,
    height: snap.height,
    initialPlateCount: snap.initialPlateCount,
    seeds: snap.seeds,
    rafts: snap.rafts,
    types: derivePlateTypes(snap.seeds, snap.rafts, snap.width, snap.height),
    motions: snap.motions,
    ages: snap.ages,
    features: snap.features,
    epoch: snap.epoch,
    archeanEpochs: snap.archeanEpochs ?? 0,
    seaLevelOffset: snap.seaLevelOffset ?? 0,
    random: mulberry32(snap.rngState),
    warpSeed: snap.warpSeed,
    lattice,
    latticeAccumulated: new Float32Array(lattice.length),
    latticeLockedEpochs: new Int16Array(lattice.length),
    latticeLastClassCode: new Int8Array(lattice.length).fill(-1),
    oceanAge,
    supercontinentActive: snap.supercontinentActive,
    continentalRiftCooldownUntil: snap.continentalRiftCooldownUntil,
    // Regenerated fresh on restore (not serialized) — like the detection lattice,
    // it re-evolves toward the current crust config over a few epochs. Uses an
    // independent RNG so it doesn't disturb the bit-identical continuation RNG.
    mantle: createMantleField(mulberry32((snap.warpSeed ^ 0x5bd1e995) >>> 0)),
    hotspots: snap.hotspots ?? [],
    // Old saves predate the suture cache — start empty; sutures re-accumulate as
    // the restored world keeps colliding continents (deep-time record is lost for
    // pre-existing saves, but never crashes). See P1.
    sutures: snap.sutures ?? [],
  }
}

export function getInitialPlateEvents(_sim: PlateSimulation): SimEvent[] {
  // Phase 1: initial continent notifications dropped (user's call). In the
  // raft model a continent is a raft spanning several plates, so the old
  // per-continental-plate "created" event no longer maps; real continent
  // events (raft birth/split/merge) arrive with the raft lifecycle in a
  // later phase.
  return []
}

export function stepEpoch(sim: PlateSimulation): SimEvent[] {
  const membership = coupleMantleToPlates(sim)
  advancePlatesAndCrust(sim, membership)
  const pass = runBoundaryPass(sim)
  const rafts = applyRaftEvents(sim, pass)
  const events = collectEventsAndApplyPlateChurn(sim, pass, rafts)
  pruneSpentFeatures(sim)
  sim.epoch += 1
  return events
}
