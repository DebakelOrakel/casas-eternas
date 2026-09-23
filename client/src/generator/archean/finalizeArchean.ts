import type { ArcheanSimulation } from './archeanState'
import type { PlateSimulation } from '../tectonics/plateSimulationTypes'
import type { PlateSeed } from '../tectonics/plateSeeds'
import { generatePlateMotions } from '../tectonics/plateMotion'
import { derivePlateTypes, raftField } from '../crust/raftField'
import { marginParameter, marginProfile, ABYSSAL_FLOOR } from '../elevation/elevationScale'
import type { Raft } from '../crust/raftTypes'
import { generateDetectionLattice } from '../tectonics/boundaryLattice'
import { createOceanAgeField } from '../tectonics/oceanAge'
import { findPlumeSites } from '../tectonics/plumes'
import { MANTLE_RES_X, MANTLE_RES_Y } from '../mantle/mantleField'
import { toroidalDistanceSq } from '../core/toroidal'
import { assignRaftNames } from '../crust/raftNames'
import { TECTONICS_TUNING } from '../tectonics/tectonicsTuneParams'

// Plate tectonics begins: the Archean world becomes a PlateSimulation.
//
// This is where plates first exist. Everything before it ran without them, which
// is the physically correct order — plate tectonics initiates somewhere around
// 3.0-2.5 Ga, and the Archean is what happens before that.

// A plate seed is placed at each local extremum of the mantle field, upwellings
// and downwellings alike. Plate BOUNDARIES are where the flow diverges (ridges) or
// converges (trenches), so the cell centres are plate interiors — which is what a
// Voronoi seed should mark.
//
// **This is what makes the plate count emergent.** It is not a slider any more: the
// number of plates falls out of how many convection cells the mantle organised
// itself into, which in turn follows from the vigour knob (createMantleField's
// initial smoothing). A finer-grained mantle gives more, smaller cells and
// therefore more, smaller plates.
// Swept against the resulting plate count over 5 seeds. The pair below yields
// 9-12 plates, which brackets the hand-tuned slider default of 12 that this
// replaces — the emergent number landing on the value someone had chosen by eye is
// the strongest evidence available that the derivation is calibrated. Looser
// (0.12/0.18) gives 26-31; tighter (0.45/0.28) gives 4-8.
const EXTREMUM_PROMINENCE = 0.35
// Minimum separation between seeds, as a fraction of the smaller world dimension.
// Two extrema a couple of cells apart are one convection cell with a noisy centre,
// not two plates.
const MIN_SEED_SEPARATION_FRAC = 0.22

// Exported so the Genesis panel can PREVIEW the plates a handover would produce
// while the Archean is paused. It is the same function finalizeArchean uses, so the
// preview is the answer, not an approximation of it.
export function convectionCellSeeds(mantle: Float32Array, width: number, height: number): PlateSeed[] {
  const candidates: { x: number; y: number; strength: number }[] = []
  const at = (gx: number, gy: number): number =>
    mantle[(((gy % MANTLE_RES_Y) + MANTLE_RES_Y) % MANTLE_RES_Y) * MANTLE_RES_X + (((gx % MANTLE_RES_X) + MANTLE_RES_X) % MANTLE_RES_X)]

  for (let gy = 0; gy < MANTLE_RES_Y; gy++) {
    for (let gx = 0; gx < MANTLE_RES_X; gx++) {
      const v = at(gx, gy)
      let isMax = true
      let isMin = true
      for (let dy = -1; dy <= 1 && (isMax || isMin); dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const n = at(gx + dx, gy + dy)
          if (n >= v) isMax = false
          if (n <= v) isMin = false
        }
      }
      if (!isMax && !isMin) continue
      if (Math.abs(v) < EXTREMUM_PROMINENCE) continue
      candidates.push({ x: ((gx + 0.5) / MANTLE_RES_X) * width, y: ((gy + 0.5) / MANTLE_RES_Y) * height, strength: Math.abs(v) })
    }
  }

  // Strongest extrema win the space; weaker ones inside the exclusion radius are
  // the same cell seen twice.
  candidates.sort((a, b) => b.strength - a.strength)
  const minSepSq = (MIN_SEED_SEPARATION_FRAC * Math.min(width, height)) ** 2
  const seeds: PlateSeed[] = []
  for (const c of candidates) {
    if (seeds.some((s) => toroidalDistanceSq(s.x, s.y, c.x, c.y, width, height) < minSepSq)) continue
    seeds.push({ x: c.x, y: c.y })
  }
  return seeds
}

// Land area per raft, off the same coastline the renderer draws: a cell counts as land
// where the SUMMED metaball field clears sea level, and is credited to whichever raft
// contributes most of the field there.
//
// Coarse on purpose. It runs once, at the hand-off, and only ever feeds a ratio — which
// continent is big enough to be called one. The masses that decide that question are
// tens of cells across at this resolution, so the odd boundary cell changes nothing.
const LAND_MEASURE_RES_X = 512
const LAND_MEASURE_RES_Y = 256

function measureRaftLandAreas(rafts: Raft[], width: number, height: number): number[] {
  const areas = new Array<number>(rafts.length).fill(0)
  for (let gy = 0; gy < LAND_MEASURE_RES_Y; gy++) {
    const wy = ((gy + 0.5) / LAND_MEASURE_RES_Y) * height
    for (let gx = 0; gx < LAND_MEASURE_RES_X; gx++) {
      const wx = ((gx + 0.5) / LAND_MEASURE_RES_X) * width
      if (marginProfile(marginParameter(raftField(wx, wy, rafts, width, height)), ABYSSAL_FLOOR) <= 0) continue
      let best = -1
      let bestField = 0
      for (let i = 0; i < rafts.length; i++) {
        const f = raftField(wx, wy, [rafts[i]], width, height)
        if (f > bestField) { bestField = f; best = i }
      }
      if (best >= 0) areas[best] += 1
    }
  }
  return areas
}

// The Archean's sea-level offset carries over unchanged. (A land-fraction
// target the offset would be solved for existed as dead code until
// 2026-09-22 — BUG_BOUNTY 12; wiring one is a decision of its own.)
export function finalizeArchean(archean: ArcheanSimulation): PlateSimulation {
  const { width, height, random } = archean
  // Continents are named HERE, not during the Archean. Proto-cratons merge and
  // fragment constantly — splitDisconnectedRafts hands out a name every time a
  // raft breaks in two — so naming during the phase produces a stream of names for
  // things that dissolve a few epochs later. A continent gets its name when it
  // becomes a continent, which is now.
  const named = assignRaftNames(archean.rafts, random, measureRaftLandAreas(archean.rafts, width, height))
  const oceanAge = createOceanAgeField(TECTONICS_TUNING.oceanAgeInit)
  const seaLevelOffset = archean.seaLevelOffset
  const seeds = convectionCellSeeds(archean.mantle, width, height)
  const lattice = generateDetectionLattice(width, height, TECTONICS_TUNING.detectionLatticeResolutionX, TECTONICS_TUNING.detectionLatticeResolutionY)

  return {
    width,
    height,
    // The count the plate-count homeostasis steers back toward is whatever the
    // convection produced, not a configured number.
    initialPlateCount: seeds.length,
    seeds,
    rafts: named,
    types: derivePlateTypes(seeds, named, width, height),
    motions: generatePlateMotions(seeds, width, height, random),
    ages: seeds.map(() => 0),
    features: [],
    // The tectonic clock starts at zero; the Archean's epochs are carried
    // separately so the world-age readout stays continuous (see core/worldTime).
    epoch: 0,
    archeanEpochs: archean.epoch,
    epochMa: 1,
    seaLevelOffset,
    random,
    warpSeed: archean.warpSeed,
    lattice,
    latticeAccumulated: new Float32Array(lattice.length),
    latticeLockedEpochs: new Int16Array(lattice.length),
    latticeLastClassCode: new Int8Array(lattice.length).fill(-1),
    // No ocean age is carried over: without ridges or subduction the Archean
    // seafloor would only have aged uniformly, which carries no information, and
    // all of it would have been recycled long before the eon closed anyway.
    oceanAge,
    supercontinentActive: named.length <= 1,
    continentalRiftCooldownUntil: 0,
    mantle: archean.mantle,
    // Derived from the mantle field the world just spent a whole eon shaping, not
    // scattered at random — see plumes.ts. They keep moving with it from here on.
    hotspots: findPlumeSites(archean.mantle, width, height),
    sutures: [],
  }
}
