import type { Raft } from '../crust/raftTypes'
import type { SeededRandom } from '../core/rng'
import { mulberry32, hashSeedString } from '../core/rng'
import { createMantleField, MANTLE_RES_X, MANTLE_RES_Y } from '../tectonics/mantleField'

// The Archean world state — see docs/decisions/archean-genesis.md.
//
// A separate type rather than a PlateSimulation with empty plate arrays, because
// in the Archean there genuinely are no plates: plate tectonics initiates around
// 3.0-2.5 Ga, and everything before that is crust riding the mantle convection
// directly. Reusing PlateSimulation would mean poking holes in derivePlateTypes,
// advectOceanAge and the Voronoi rasteriser, all of which assume at least one
// plate seed exists.
//
// Note what is NOT here:
//   - **No ocean age.** Without ridges or subduction the seafloor would just age
//     uniformly, which carries no information. It is initialised at the handover
//     (finalizeArchean) with OCEAN_AGE_INIT, the same value the removed
//     createPlateSimulation used to start a world with.
//   - **No terrain features.** The Archean produces crust extent and crust age,
//     nothing else. Elevation already derives from raft membership through the
//     margin profile, so land appears without any relief machinery.
export interface ArcheanSimulation {
  width: number
  height: number
  epoch: number
  random: SeededRandom
  // Carried through to the PlateSimulation so the coastline warp is stable for a
  // given seed across the whole pipeline.
  warpSeed: number
  rafts: Raft[]
  mantle: Float32Array
  // Per mantle cell: how many consecutive epochs it has been above the nucleation
  // threshold. Crust only forms where an upwelling has PERSISTED, which is what
  // stops single hot epochs from speckling the map (see crustNucleation).
  upwellingStreak: Int16Array
  // Rolling count of blobs recycled per epoch, for the panel's readout.
  lastRecycled: number
  // New rafts produced by the last split — the break-up rate, which is what raft
  // rigidity trades against (see ArcheanParams.raftRigidity).
  lastSplits: number
  // Water offset in elevation units — carried through the handover unchanged.
  seaLevelOffset: number
}

export function createArcheanSimulation(seedString: string, width: number, height: number, seaLevelOffset = 0): ArcheanSimulation {
  const random = mulberry32(hashSeedString(seedString))
  return {
    width,
    height,
    epoch: 0,
    random,
    // Same salted derivation the old createPlateSimulation used, so a seed produces
    // the same coastline warp as it did before the Archean replaced that path.
    warpSeed: hashSeedString(`${seedString}:coastalWarp`),
    // The Archean starts with a wet planet and no land: Jack Hills zircons put
    // liquid water at the surface by ~4.4 Ga, well before the Archean begins.
    rafts: [],
    mantle: createMantleField(random),
    upwellingStreak: new Int16Array(MANTLE_RES_X * MANTLE_RES_Y),
    lastRecycled: 0,
    lastSplits: 0,
    seaLevelOffset,
  }
}
