import { BAKE_ENGINE_OVERRIDES, amplifyElevation } from './amplify'
import { runErosionPassV2 } from './erosionPassV2'
import { assembleFineForcing } from './erosionForcingFields'
import { fillDepressionsAndRouteFlow } from './flowRouting'
import { ABYSSAL_FLOOR, SEA_LEVEL } from '../elevation/elevationScale'
import { accumulateDischarge, channelThreshold, computeLakes, densityToCriticalArea, extractRiverPolylines, maxDischargeOverLand, meanLandRunoff } from './hydrology'
import type { RiverPolylines } from './hydrology'

// The amplification bake itself: upsample, seed roughness, erode, re-run
// hydrology (docs/decisions/worldmap-amplification.md).
//
// Lifted out of amplificationWorker when the SERVER learned to bake. The
// worker is now a thin postMessage wrapper around this, and the Node baker
// calls it directly — which is the point: an artifact carries a key derived
// from its inputs, so a browser bake and a server bake of the same world MUST
// produce the same bytes. Two copies of this function would be two pipelines
// that agree only until someone edits one.
//
// No DOM, no worker globals, no Babylon — that is what lets it run in both
// places, and it is a rule worth keeping rather than a coincidence.

export type AmplifyPhase = 'seed' | 'erosion' | 'hydrology'

// The slice of the world one bake is responsible for
// (docs/design/splitting-the-bake.md, step 3a).
//
// A region is expressed by DROWNING the land outside it rather than by teaching
// every loop to skip: erosion already skips cells that are not land, so land
// that is not this job's simply stops existing, and the priority flood drains to
// it the way it drains to any sea. No inner loop changes, which matters — those
// loops are 92 % of a bake and are guarded by hashes, not by reasoning.
//
// N = 1 IS TODAY'S BAKE, byte for byte, and the design leans on that: give
// `owned` every land cell and nothing is outside it to drown. So there is no
// split mode and no unsplit mode, no threshold between them and no second code
// path that only the cluster exercises — the plan's budget chooses N, and N = 1
// is the ordinary case rather than a special one.
export interface BakeRegion {
  // 1 for a cell this bake owns, on the AMPLIFIED grid. Only these cells of the
  // result mean anything; the rest is scaffolding this job needed to compute
  // them and is left visibly wrong (drowned) rather than plausibly wrong.
  owned: Uint8Array
  // Fine cells of context around the owned set: computed, then discarded.
  //
  // Erosion is local but not pointwise — thermal transport moves material across
  // a divide, and a cell's incision reads its neighbours — so a job that saw
  // only its own cells would put a seam along every ridge, which is the one
  // place the eye is naturally drawn.
  //
  // 8 is what the measurement says, not what looks safe: on the harness world
  // the mean error falls 211 m → 0.27 m from halo 0 to halo 8, and 16 buys
  // nothing (0.21 m). See the measurement table in the design doc, including
  // what does NOT converge and why.
  haloCells: number
}

export const DEFAULT_HALO_CELLS = 8

export interface AmplifyRequest {
  // The authoritative macro elevation raster — the only terrain a save carries.
  elevation: Float32Array
  macroWidth: number
  macroHeight: number
  // Linear refinement factor: 2 → 4096x2048, 4 → 8192x4096.
  factor: number
  // Derived from the world so a given world always bakes identically.
  seed: number
  // Engine iterations on the amplified field — the bake's own transient dose,
  // NOT the world's landscapeAge (that one shaped the macro; this one only
  // refines it). 0 skips erosion, which is still useful for isolating the
  // seed layer. Kept under the historical name because it is the wire name
  // the Go bake module speaks.
  erosionRounds: number
  // Seed of the engine's lithology lattice (world/query.ts derives it from
  // the recipe) — world-space and grid-fixed, so the bake carves the same
  // rock bands the generator carved.
  lithoSeed: number
  // The WORLD'S OWN erosion settings, as recorded in its save. A world tuned
  // for soft alluvium must not come back carved like a hard-rock one.
  // Undefined falls back to the declared defaults (older saves).
  alluvium?: number
  rockContrast?: number
  // The engine's coarse forcing from the save's forcing layers, bilinearly
  // upsampled onto the amplified grid. Absent for an old save: the bake then
  // erodes with neutral forcing (no uplift, lithology-only rock contrast) —
  // the accepted hard break.
  upliftCoarse?: Float32Array
  erodibilityCoarse?: Float32Array
  forcingResX?: number
  forcingResY?: number
  // Climate for the hydrology re-run. Coarse by nature and simply sampled
  // onto the fine grid — precipitation is a regional quantity. Absent for a
  // world saved before climate was computed; the bake then stops after erosion.
  precipitation?: Float32Array
  // Needed for LAKES only (evaporation decides which basins stay wet); rivers
  // run without it. Same coarse climate grid as precipitation.
  temperature?: Float32Array
  climateResX?: number
  climateResY?: number
  riverDensity?: number
  // The slice this bake owns. Absent means the whole world, which is what every
  // caller does today.
  region?: BakeRegion
  // The channel threshold's two world-wide inputs, from the macro plan
  // (`bakePlan.planBake`). Absent, they are derived from this bake's own field —
  // correct for a whole world and WRONG for a region, which sees only part of
  // the drainage and would pick a threshold nobody else picked. Every boundary
  // between two jobs would then show a step in river density.
  maxDischarge?: number
  meanRunoff?: number
}

export interface AmplifyResult {
  elevation: Float32Array
  width: number
  height: number
  rivers: RiverPolylines
  // Lake depth on the amplified grid, or null when the bake had no
  // temperature (or owns only a region). Null means "the consumer keeps the
  // macro layer the save carries" — not "there are no lakes".
  lakeDepth: Float32Array | null
}

export async function runAmplification(
  request: AmplifyRequest,
  onProgress: (phase: AmplifyPhase, fraction: number) => void = () => {},
): Promise<AmplifyResult> {
  const result = amplifyElevation(
    request.elevation, request.macroWidth, request.macroHeight,
    request.factor, request.seed,
    (fraction) => onProgress('seed', fraction),
  )

  let field = request.region
    ? drownForeignLand(result.data, result.width, result.height, request.region)
    : result.data
  if (request.erosionRounds > 0) {
    // The v2 engine on the seeded field (docs/design/erosion-v2.md, P3). The
    // engine's physical parameters (settling lengths in km, diffusivity in
    // km², slopes as gradients) read the grid through cellM, so a finer grid
    // needs no per-cell rescaling — the scale bugs that forced v1's
    // scaleErosionParamsForCellSize were rebuilt out of the model.
    //
    // The forcing mirrors the generator's assembly with the save standing in
    // for the sim: U and the crust hardness from the save's forcing layers,
    // the lithology noise from the world's own seed on its fixed lattice, and
    // the save's REAL precipitation as the water contrast where the generator
    // could only use its provisional climate. One deliberate override:
    // upliftDt 0 — amplification refines a finished macro, and uplift would
    // push interfluves above the authoritative shape (the same reasoning as
    // v1's upliftRate 0, kept beside the bake's other policy in amplify.ts
    // where the cache key hashes it).
    const { forcing, params } = assembleFineForcing({
      uplift: request.upliftCoarse ?? null,
      hardness: request.erodibilityCoarse ?? null,
      forcingResX: request.forcingResX ?? 1,
      forcingResY: request.forcingResY ?? 1,
      water: request.precipitation ?? null,
      waterResX: request.climateResX ?? 1,
      waterResY: request.climateResY ?? 1,
      lithoSeed: request.lithoSeed,
    }, field, result.width, result.height, { alluvium: request.alluvium, rockContrast: request.rockContrast })
    const eroded = await runErosionPassV2(field, result.width, result.height, forcing, {
      age: request.erosionRounds,
      params: { ...params, upliftDt: BAKE_ENGINE_OVERRIDES.upliftDt },
      onProgress: (fraction) => onProgress('erosion', fraction),
    })
    field = eroded.elevations
  }

  // Hydrology RE-RUN on the amplified field: the save's rivers were routed on
  // the macro raster and would now lie beside the fine valleys this bake just
  // carved, so they are re-derived rather than carried over.
  let rivers: RiverPolylines = { points: new Float32Array(0), lengths: new Uint32Array(0) }
  let lakeDepth: Float32Array | null = null
  if (request.precipitation && request.climateResX && request.climateResY) {
    onProgress('hydrology', 0)
    const derived = await deriveRivers(
      field, result.width, result.height,
      request.precipitation, request.climateResX, request.climateResY,
      request.riverDensity,
      {
        maxDischarge: request.maxDischarge,
        meanRunoff: request.meanRunoff,
        // Lakes only for a WHOLE-world bake. A region sees part of the
        // drainage, and a basin straddling two jobs would be flooded twice
        // from two different catchments — the same reasoning that hands a
        // split bake its discharge inputs instead of letting it derive them.
        temperature: request.region ? undefined : request.temperature,
      },
      (fraction) => onProgress('hydrology', fraction),
    )
    rivers = derived.rivers
    lakeDepth = derived.lakeDepth
    if (request.region) rivers = ownedRivers(rivers, request.region.owned, result.width)
    onProgress('hydrology', 1)
  }

  return { elevation: field, width: result.width, height: result.height, rivers, lakeDepth }
}

// Route, accumulate and extract the river network of ONE elevation field —
// the hydrology stage above, shared with the worldmap's macro tier: a freshly
// loaded save shows the rivers its own raster carries before any bake lands,
// and because both callers run this same function, the macro network and a
// baked one differ only by their grid, never by their rules.
//
// (The save deliberately carries a discharge RASTER and no polylines — the
// client re-derives deterministically from elevation + precipitation +
// riverDensity, which is exactly this call. See the save writer's comment.)
export async function deriveRivers(
  field: Float32Array,
  width: number,
  height: number,
  precipitation: Float32Array,
  climateResX: number,
  climateResY: number,
  riverDensity: number | undefined,
  // Handed in by a split bake, derived here by a whole one — see the two
  // request fields' own comment. `??` and not a truthiness test: 0 is a
  // legitimate value for a world with no land, and would silently fall back.
  //
  // `temperature` is what turns this into rivers AND lakes: computeLakes needs
  // it (evaporation decides which basins stay wet), and everything else it
  // needs — the routing and the discharge — this function already has in hand.
  // Absent, the lake half is skipped and the caller keeps whatever it had.
  options: { maxDischarge?: number; meanRunoff?: number; temperature?: Float32Array } = {},
  onProgress: (fraction: number) => void = () => {},
): Promise<{ rivers: RiverPolylines; lakeDepth: Float32Array | null }> {
  const routing = await fillDepressionsAndRouteFlow(field, width, height, 0)
  onProgress(0.6)
  const discharge = accumulateDischarge(routing, field, precipitation, climateResX, climateResY)
  const maxDischarge = options.maxDischarge ?? maxDischargeOverLand(discharge, field)
  const meanRunoff = options.meanRunoff ?? meanLandRunoff(precipitation, field, width, height, climateResX, climateResY)
  // The channel criterion is a cell COUNT and is used as one, at every
  // stage — NOT rescaled to a constant physical catchment the way the
  // erosion constants are. That is what makes a finer bake produce a richer
  // river network rather than the same one with more vertices; amplify.ts
  // carries the measurements behind the decision.
  const criticalArea = densityToCriticalArea(riverDensity ?? 55)
  const threshold = channelThreshold(criticalArea, meanRunoff)
  const rivers = extractRiverPolylines(routing, discharge, field, threshold, maxDischarge)
  const lakeDepth = options.temperature
    ? computeLakes(routing, discharge, field, options.temperature, precipitation, climateResX, climateResY).depth
    : null
  return { rivers, lakeDepth }
}

// The rivers this region owns, by the HEAD of each polyline.
//
// Elevation composes disjointly because a cell belongs to one job. Rivers do
// not, and it is easy to miss: a job extracts channels over its whole drowned
// field, halo included, so two neighbours each emit the stretch of the other's
// river that fell inside their margin. The composite would then carry every
// boundary river twice, drawn twice, which reads as a thicker river rather than
// as a bug.
//
// The head decides, and can: `extractRiverPolylines` starts each line at a
// headwater and walks downstream, and a river never leaves its catchment. So a
// line whose head is not ours belongs to whoever owns that head — exactly one
// job, since every land cell is owned by exactly one. A line of ours that runs
// out over the sea near its mouth is still ours; ownership is decided once, at
// the top, not per vertex.
function ownedRivers(rivers: RiverPolylines, owned: Uint8Array, width: number): RiverPolylines {
  const points: number[] = []
  const lengths: number[] = []
  let read = 0
  for (const length of rivers.lengths) {
    const head = Math.floor(rivers.points[read + 1]) * width + Math.floor(rivers.points[read])
    if (owned[head]) {
      for (let i = 0; i < length * 3; i++) points.push(rivers.points[read + i])
      lengths.push(length)
    }
    read += length * 3
  }
  return { points: Float32Array.from(points), lengths: Uint32Array.from(lengths) }
}

// Everything the region does: land outside it is replaced by deep sea.
//
// LAND ONLY, and the distinction is not a detail. The experiment that measured
// the halo drowned the ocean too, and that flattens the shelf in front of the
// region's OWN coast — `gradedSeaCap` keys the delta freeboard on the tectonic
// depth at the cell, so a synthetic abyss where a shelf was changes deposition
// inside the region rather than outside it. Real bathymetry is kept for the same
// reason it is kept in a whole bake: it is the outlet, not the neighbour's work.
//
// Abyssal rather than just-below-sea-level for the other half of that argument:
// a cell barely under the line is a cell deposition can build back above it, and
// foreign land quietly resurfacing inside a job would be a delta made of a
// neighbour's mountain.
function drownForeignLand(seeded: Float32Array, width: number, height: number, region: BakeRegion): Float32Array {
  const active = dilateMask(region.owned, width, height, region.haloCells)
  const field = seeded.slice()
  const floor = SEA_LEVEL + ABYSSAL_FLOOR
  for (let i = 0; i < field.length; i++) {
    if (!active[i] && field[i] > SEA_LEVEL) field[i] = floor
  }
  return field
}

// Chebyshev dilation on the torus, separably and in linear time: a square
// structuring element is the same thing as dilating along x and then along y, so
// this is two O(cells) sweeps rather than the O(cells × radius × 9) of repeating
// an 8-neighbour pass. At 16384² with a radius of 8 that is the difference
// between a moment and ten billion operations.
//
// Exported only so `npm run harness:amplify` can hold it against the naive
// version it replaces. It is worth the export: a halo silently one cell short,
// or one that stops at the seam, changes nothing any other check in that harness
// looks at — N = 1 drowns nothing, and a composite stays total and disjoint
// whatever the halo does. The fast algorithm is the one thing here that has to
// be checked against the slow one directly.
export function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask
  const rows = new Uint8Array(mask.length)
  const scratch = new Int32Array(Math.max(width, height))
  for (let y = 0; y < height; y++) spread(mask, rows, y * width, 1, width, radius, scratch)
  const out = new Uint8Array(mask.length)
  for (let x = 0; x < width; x++) spread(rows, out, x, width, height, radius, scratch)
  return out
}

// One wrapping line: a slot is set in `to` when `from` has a set slot within
// `radius` of it. Two sweeps carrying the distance since the last set slot, each
// run twice round so a run that wraps is seen whole.
function spread(from: Uint8Array, to: Uint8Array, offset: number, stride: number, size: number, radius: number, distance: Int32Array): void {
  const far = size + radius + 1
  for (let i = 0; i < size; i++) distance[i] = far
  let since = far
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i < size; i++) {
      since = from[offset + i * stride] ? 0 : since + 1
      if (since < distance[i]) distance[i] = since
    }
  }
  since = far
  for (let lap = 0; lap < 2; lap++) {
    for (let i = size - 1; i >= 0; i--) {
      since = from[offset + i * stride] ? 0 : since + 1
      if (since < distance[i]) distance[i] = since
    }
  }
  for (let i = 0; i < size; i++) to[offset + i * stride] = distance[i] <= radius ? 1 : 0
}
