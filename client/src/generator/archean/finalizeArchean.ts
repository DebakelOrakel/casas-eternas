import type { ArcheanSimulation } from './archeanState'
import type { PlateSimulation } from '../tectonics/plateSimulationTypes'
import type { PlateSeed } from '../tectonics/plateSeeds'
import { generatePlateMotions } from '../tectonics/plateMotion'
import { buildBlobIndex, derivePlateTypes, raftFieldsIndexed } from '../crust/raftField'
import { marginParameter, marginProfile, ABYSSAL_FLOOR } from '../elevation/elevationScale'
import type { Raft } from '../crust/raftTypes'
import { generateDetectionLattice } from '../tectonics/boundaryLattice'
import { createOceanAgeField } from '../tectonics/oceanAge'
import { findPlumeSites } from '../tectonics/plumes'
import { mantleMesh } from '../mantle/mantleField'
import { domainArea, type Domain } from '../core/domain'
import { assignRaftNames } from '../crust/raftNames'
import { TECTONICS_TUNING } from '../tectonics/tectonicsTuneParams'
import { sq } from '../core/detMath'

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
// itself into, which in turn follows from the vigour knob (ArcheanParams.diffusion,
// the mantle's per-epoch mixing). A finer-grained mantle gives more, smaller cells and
// therefore more, smaller plates.
// Swept against the resulting plate count over 5 seeds. The pair below yields
// 9-12 plates, which brackets the hand-tuned slider default of 12 that this
// replaces — the emergent number landing on the value someone had chosen by eye is
// the strongest evidence available that the derivation is calibrated. Looser
// (0.12/0.18) gives 26-31; tighter (0.45/0.28) gives 4-8.
const EXTREMUM_PROMINENCE = 0.35
// Minimum separation between seeds, as a fraction of the smaller world dimension.
// Two extrema a couple of cells apart are one convection cell with a noisy centre,
// not two plates. The dimension is the torus's height read off the world's AREA
// (√(area / 2), on the 2:1 torus its height exactly) since DEC-0036 phase 8a: the
// sphere's chart is 1024 units high too, but there a unit is 9.8 km and the
// globe holds 64 % of the torus's units² — the plain min(width, height) spaced
// its plates 25 % further apart in metres, room for 36 % fewer.
const MIN_SEED_SEPARATION_FRAC = 0.22

// Exported so the Genesis panel can PREVIEW the plates a handover would produce
// while the Archean is paused. It is the same function finalizeArchean uses, so the
// preview is the answer, not an approximation of it.
//
// An extremum is a cell of the mantle's field mesh above (or below) every one
// of its Voronoi neighbours (DEC-0036), at the cell's centre.
export function convectionCellSeeds(mantle: Float64Array, domain: Domain): PlateSeed[] {
  const { mesh } = mantleMesh(domain)
  const candidates: { x: number; y: number; strength: number }[] = []

  for (let i = 0; i < mesh.count; i++) {
    const v = mantle[i]
    let isMax = true
    let isMin = true
    for (let e = mesh.nbrStart[i]; e < mesh.nbrStart[i + 1] && (isMax || isMin); e++) {
      const n = mantle[mesh.nbr[e]]
      if (n >= v) isMax = false
      if (n <= v) isMin = false
    }
    if (!isMax && !isMin) continue
    if (Math.abs(v) < EXTREMUM_PROMINENCE) continue
    candidates.push({ x: mesh.x[i], y: mesh.y[i], strength: Math.abs(v) })
  }

  // Strongest extrema win the space; weaker ones inside the exclusion radius are
  // the same cell seen twice.
  candidates.sort((a, b) => b.strength - a.strength)
  const minSepSq = sq(MIN_SEED_SEPARATION_FRAC * Math.sqrt(domainArea(domain) / 2))
  const seeds: PlateSeed[] = []
  for (const c of candidates) {
    if (seeds.some((s) => domain.distanceSq(s.x, s.y, c.x, c.y) < minSepSq)) continue
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

// Through a blob index (raftFieldsIndexed: the same fields as the scans
// over every blob and every raft's, which were a second of the sphere's
// hand-over, 2026-10-15).
function measureRaftLandAreas(rafts: Raft[], domain: Domain): number[] {
  const areas = new Array<number>(rafts.length).fill(0)
  const blobs = buildBlobIndex(rafts, domain)
  const perRaft = new Float64Array(rafts.length)
  for (let gy = 0; gy < LAND_MEASURE_RES_Y; gy++) {
    const wy = ((gy + 0.5) / LAND_MEASURE_RES_Y) * domain.height
    for (let gx = 0; gx < LAND_MEASURE_RES_X; gx++) {
      const wx = ((gx + 0.5) / LAND_MEASURE_RES_X) * domain.width
      if (marginProfile(marginParameter(raftFieldsIndexed(wx, wy, blobs, perRaft)), ABYSSAL_FLOOR) <= 0) continue
      let best = -1
      let bestField = 0
      for (let i = 0; i < rafts.length; i++) {
        const f = perRaft[i]
        if (f > bestField) { bestField = f; best = i }
      }
      if (best >= 0) areas[best] += 1
    }
  }
  return areas
}

// The land the Archean made is the land the plates take over: its target
// (archeanLand.ts) steered the crust, not the sea.
export function finalizeArchean(archean: ArcheanSimulation): PlateSimulation {
  const { width, height, domain, random } = archean
  // Continents are named HERE, not during the Archean. Proto-cratons merge and
  // fragment constantly — splitDisconnectedRafts hands out a name every time a
  // raft breaks in two — so naming during the phase produces a stream of names for
  // things that dissolve a few epochs later. A continent gets its name when it
  // becomes a continent, which is now.
  const named = assignRaftNames(archean.rafts, random, measureRaftLandAreas(archean.rafts, domain))
  const oceanAge = createOceanAgeField(TECTONICS_TUNING.oceanAgeInit, domain)
  const seeds = convectionCellSeeds(archean.mantle, domain)
  const lattice = generateDetectionLattice(domain, TECTONICS_TUNING.detectionLatticeResolutionX, TECTONICS_TUNING.detectionLatticeResolutionY)

  return {
    width,
    height,
    domain,
    // The count the plate-count homeostasis steers back toward is whatever the
    // convection produced, not a configured number.
    initialPlateCount: seeds.length,
    seeds,
    rafts: named,
    types: derivePlateTypes(seeds, named, domain),
    motions: generatePlateMotions(seeds, domain, random),
    ages: seeds.map(() => 0),
    features: [],
    // The tectonic clock starts at zero; the Archean's epochs are carried
    // separately so the world-age readout stays continuous (see core/worldTime).
    epoch: 0,
    archeanEpochs: archean.epoch,
    epochMa: 1,
    sedimentExportM3: 0,
    eustaticM: 0,
    climateHistory: [],
    lakeAges: [],
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
    hotspots: findPlumeSites(archean.mantle, domain),
    sutures: [],
  }
}
