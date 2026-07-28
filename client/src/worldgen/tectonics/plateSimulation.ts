import { generateDetectionLattice } from './boundaryLattice'
import { generatePlateMotions } from './plateMotion'
import { createMantleField } from './mantleField'
import { generatePlateSeeds } from './plateSeeds'
import { hashSeedString, mulberry32 } from '../core/rng'
import { createOceanAgeField } from './oceanAge'
import { derivePlateTypes } from '../crust/raftField'
import { generateInitialRafts } from '../crust/raftGeneration'
import { DETECTION_LATTICE_RESOLUTION_X, DETECTION_LATTICE_RESOLUTION_Y, OCEAN_AGE_INIT, HOTSPOT_COUNT } from './tectonicsParams'
import { coupleMantleToPlates } from './epoch/mantleCoupling'
import { advancePlatesAndCrust } from './epoch/plateDrift'
import { runBoundaryPass } from './epoch/boundaryPass'
import { applyRaftEvents } from './epoch/raftEvents'
import { collectEventsAndApplyPlateChurn } from './epoch/plateChurn'
import { pruneSpentFeatures } from './epoch/featurePruning'
import type { PlateSimulation, PlateSimulationSnapshot, SimEvent } from './plateSimulationTypes'


// Building a world, persisting one, and running an epoch of it. The epoch's six
// phases live in epoch/ — stepEpoch at the bottom is now just their order, which
// is the one thing about them that has to be read top to bottom.
export type { PlateSimulation, PlateSimulationSnapshot, SimEvent, SimEventType } from './plateSimulationTypes'
export { eventCategory } from './plateSimulationTypes'


function generateHotspots(random: () => number, width: number, height: number): { x: number; y: number }[] {
  return Array.from({ length: HOTSPOT_COUNT }, () => ({ x: random() * width, y: random() * height }))
}

export function createPlateSimulation(seedString: string, plateCount: number, landFraction: number, clustering: number, cratonCount: number, width: number, height: number): PlateSimulation {
  const random = mulberry32(hashSeedString(seedString))
  // A distinctly-salted hash of the same seed string, not hashSeedString(seedString)
  // itself — keeps this fully deterministic per world seed without reusing
  // the exact numeric seed `random` was already built from for a
  // different purpose.
  const warpSeed = hashSeedString(`${seedString}:coastalWarp`)
  const seeds = generatePlateSeeds(plateCount, width, height, random)
  // Rafts are generated first — they're the source of truth for crust type;
  // plate `types` are then derived from raft coverage (see rafts.ts).
  const rafts = generateInitialRafts(random, landFraction, clustering, cratonCount, width, height)
  const types = derivePlateTypes(seeds, rafts, width, height)
  const motions = generatePlateMotions(seeds, width, height, random)
  const lattice = generateDetectionLattice(width, height, DETECTION_LATTICE_RESOLUTION_X, DETECTION_LATTICE_RESOLUTION_Y)

  return {
    width,
    height,
    initialPlateCount: plateCount,
    seeds,
    rafts,
    types,
    motions,
    ages: seeds.map(() => 0),
    features: [],
    epoch: 0,
    random,
    warpSeed,
    lattice,
    latticeAccumulated: new Float32Array(lattice.length),
    latticeLockedEpochs: new Int16Array(lattice.length),
    latticeLastClassCode: new Int8Array(lattice.length).fill(-1),
    oceanAge: createOceanAgeField(OCEAN_AGE_INIT),
    supercontinentActive: rafts.length <= 1,
    continentalRiftCooldownUntil: 0,
    mantle: createMantleField(random),
    hotspots: generateHotspots(random, width, height),
    sutures: [],
  }
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
