import type { Raft } from '../crust/raftTypes'
import type { SeededRandom } from '../core/rng'
import type { Domain } from '../core/domain'
import { domainOfKind } from '../core/domain'
import { mulberry32, hashSeedString } from '../core/rng'
import { createMantleField, mantleMesh } from '../mantle/mantleField'

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
  // The world's topology on width × height (core/domain.ts); handed on to
  // the PlateSimulation, never serialised.
  domain: Domain
  epoch: number
  random: SeededRandom
  // Carried through to the PlateSimulation so the coastline warp is stable for a
  // given seed across the whole pipeline.
  warpSeed: number
  rafts: Raft[]
  // The mantle field, one value per cell of its field mesh (mantleField.ts).
  mantle: Float64Array
  // Per mantle cell: how many consecutive epochs it has been above the nucleation
  // threshold. Crust only forms where an upwelling has PERSISTED, which is what
  // stops single hot epochs from speckling the map (see crustNucleation).
  upwellingStreak: Int16Array
  // Rolling count of blobs recycled per epoch, for the panel's readout.
  lastRecycled: number
  // New rafts produced by the last split — the break-up rate, which is what raft
  // rigidity trades against (see ArcheanParams.raftRigidity).
  lastSplits: number
  // Nuclei placed by the last step, for the readout and the calibration.
  lastNucleated: number
  // The land share controller's credit: nuclei granted and not yet placed,
  // fractional (archeanLand.nucleationBudget). State, so it is saved.
  nucleationCredit: number
}

// The world's coastline-warp seed, the one salted derivation every reader
// of the fine-detail field family shares (the generator's warp, the
// amplification bake's roughness seed, the queryable save's detail seed —
// world/query.ts). Changing the salt changes baked terrain for an unchanged
// world under an unchanged key, so it is one function, not one string in
// three files.
export const coastalWarpSeed = (seedString: string): number => hashSeedString(`${seedString}:coastalWarp`)

// `shape`: the world's (DEC-0035) — the torus, or the sphere over the same
// 2:1 chart. Everything the Archean computes reaches it through the domain.
export function createArcheanSimulation(seedString: string, width: number, height: number, shape: Domain['kind'] = 'torus'): ArcheanSimulation {
  const random = mulberry32(hashSeedString(seedString))
  const domain = domainOfKind(shape, width, height)
  return {
    width,
    height,
    domain,
    epoch: 0,
    random,
    // Same salted derivation the old createPlateSimulation used, so a seed produces
    // the same coastline warp as it did before the Archean replaced that path.
    warpSeed: coastalWarpSeed(seedString),
    // The Archean starts with a wet planet and no land: Jack Hills zircons put
    // liquid water at the surface by ~4.4 Ga, well before the Archean begins.
    rafts: [],
    mantle: createMantleField(random, domain),
    upwellingStreak: new Int16Array(mantleMesh(domain).mesh.count),
    lastRecycled: 0,
    lastSplits: 0,
    lastNucleated: 0,
    nucleationCredit: 0,
  }
}
