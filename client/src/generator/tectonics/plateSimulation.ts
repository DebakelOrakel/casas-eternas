import { generateDetectionLattice } from './boundaryLattice'
import { createMantleField } from '../mantle/mantleField'
import { mulberry32 } from '../core/rng'
import { derivePlateTypes } from '../crust/raftField'
import { TECTONICS_TUNING } from './tectonicsTuneParams'
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


// NOTE: the array fields come back BY REFERENCE — `rafts`, `features`, `seeds`,
// `motions` and `ages` are the simulation's own arrays, not copies. That is fine for
// what this is for, because the result is posted or written out immediately and
// structured-cloned on the way. It is NOT safe to hold: stepEpoch keeps mutating
// those same arrays, so a snapshot kept as stored state quietly follows the world
// forward. Copy it (structuredClone) if you intend to keep it — the tectonics reset
// learned this the hard way, restoring epoch 0 with a 60-epoch-old world's continents.
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
    epochMa: sim.epochMa,
    warpSeed: sim.warpSeed,
    supercontinentActive: sim.supercontinentActive,
    continentalRiftCooldownUntil: sim.continentalRiftCooldownUntil,
    hotspots: sim.hotspots,
    sutures: sim.sutures,
    rngState: sim.random.state(),
  }
}

export function deserializePlateSimulation(snap: PlateSimulationSnapshot, oceanAge: Float32Array, mantle?: Float32Array): PlateSimulation {
  const lattice = generateDetectionLattice(snap.width, snap.height, TECTONICS_TUNING.detectionLatticeResolutionX, TECTONICS_TUNING.detectionLatticeResolutionY)
  // COPIED out of the snapshot, not adopted from it. serializePlateSimulation
  // hands back the sim's own arrays and says so; this is the mirror half, and it
  // was missing. A snapshot read from a file is usually thrown away immediately,
  // which is why it went unnoticed — but the tectonics reset keeps ONE snapshot in
  // memory and restores from it repeatedly, so the sim built by the first reset
  // went on writing its own drift into the state it was meant to be able to return
  // to. Measured 2026-08-09: the first resetTectonics landed on the hand-over
  // exactly, every later one on a world drifted by however far tectonics had run
  // since the previous reset — and differently each time.
  //
  // One structuredClone rather than a hand-written field list: a copy list is a
  // second place to remember when a field is added, and the field that gets
  // forgotten is the one that reintroduces this.
  const owned = structuredClone({
    seeds: snap.seeds,
    motions: snap.motions,
    ages: snap.ages,
    rafts: snap.rafts,
    features: snap.features,
    // Old saves predate these two — see the notes at their use below.
    hotspots: snap.hotspots ?? [],
    sutures: snap.sutures ?? [],
  })
  return {
    width: snap.width,
    height: snap.height,
    initialPlateCount: snap.initialPlateCount,
    seeds: owned.seeds,
    rafts: owned.rafts,
    types: derivePlateTypes(owned.seeds, owned.rafts, snap.width, snap.height),
    motions: owned.motions,
    ages: owned.ages,
    features: owned.features,
    epoch: snap.epoch,
    archeanEpochs: snap.archeanEpochs ?? 0,
    seaLevelOffset: snap.seaLevelOffset ?? 0,
    epochMa: snap.epochMa ?? 1,
    random: mulberry32(snap.rngState),
    warpSeed: snap.warpSeed,
    lattice,
    latticeAccumulated: new Float32Array(lattice.length),
    latticeLockedEpochs: new Int16Array(lattice.length),
    latticeLastClassCode: new Int8Array(lattice.length).fill(-1),
    oceanAge,
    supercontinentActive: snap.supercontinentActive,
    continentalRiftCooldownUntil: snap.continentalRiftCooldownUntil,
    // Restored when the save carries one. It used to be regenerated unconditionally,
    // on the reasoning that it re-evolves toward the current crust config within a few
    // epochs — but the plate motions were FITTED to the saved field, and the plate
    // positions themselves came from its extrema at the Archean handover. Continuing
    // from a fresh random field therefore refitted every plate to a mantle that had
    // never produced them.
    //
    // Saves written before the field was persisted still land here, and still get a
    // regenerated one. The fallback RNG is independent of `random` so it cannot
    // disturb the bit-identical continuation.
    mantle: mantle ?? createMantleField(mulberry32((snap.warpSeed ^ 0x5bd1e995) >>> 0)),
    hotspots: owned.hotspots,
    // Old saves predate the suture cache — start empty; sutures re-accumulate as
    // the restored world keeps colliding continents (deep-time record is lost for
    // pre-existing saves, but never crashes). See P1.
    sutures: owned.sutures,
  }
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
