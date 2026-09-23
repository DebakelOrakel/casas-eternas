import { MinHeap } from '../core/minHeap'
import { MAP_WIDTH, METERS_PER_CELL } from '../core/mapConfig'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import {
  buildEngineIndex,
  createEngineViews,
  expandActive,
  gatherActive,
  FLAG_GRID8,
  FLAG_HAS_ACCUM_WEIGHTS,
  FLAG_HAS_COAST_MASK,
  FLAG_HAS_STATUS_MASK,
  type EngineIndex,
  type EngineViews,
  type TerrainViews,
} from './erosionEngineState'

export { FLAG_HAS_ACCUM_WEIGHTS, FLAG_HAS_COAST_MASK, FLAG_HAS_STATUS_MASK } from './erosionEngineState'

// EROSION V2 — the engine core (docs/design/erosion-v2.md, phase P2; the
// pipeline's erosion since the P2 switchover, the bake's since P3).
//
// A mass-conserving transient landscape engine: implicit stream power
// (Braun & Willett 2013, n=1, receiver-ordered), ξ–q sediment routing with
// discharge-dependent settling (Davy & Lague), Roering nonlinear hillslope
// diffusion, marine diffusion, and uplift toward a caller-supplied forcing
// field. Iterated for a FINITE number of steps — the landscape-age axis is
// the product (P0's central finding: a full equilibrium erases its initial
// condition; the transient from the real tectonic terrain is what keeps
// inherited relief).
//
// SHAPE: every parallelisable phase is an exported KERNEL over an
// EngineViews state (erosionEngineState.ts) and an explicit range of
// ACTIVE indices — per-cell deterministic, no cross-range accumulation, so
// output is byte-identical for ANY worker count including one. The
// ErosionEngine class below is the single-threaded driver over the same
// kernels; erosionEnginePool.ts drives them across workers. The routing
// walks (flood, λ, segments, accumulation) are serial on the coordinator;
// the pipelined refresh (erosionEnginePool.ts) moves them off the
// iteration path, which is why refreshRouting reads only z and stepPhysics
// never touches what the refresh writes. The fluvial and sediment walks
// run per SEGMENT (the receiver forest cut at the coast, see
// buildSegments): leaf segments in parallel, the fed ocean band and the
// enclosed basins in one serial stage each side of them — fluvial serial
// first (receivers first), sediment serial last (donors first). Per-cell
// arithmetic and the order every sum is taken in depend only on the
// routing, never on the worker split, which is what keeps every driver
// byte-identical to every other.
//
// THE ACTIVE SET (ADAPTIVE_MESH_PLAN.md phase 0): the engine computes on
// land, enclosed basins and a shelf band of ocean; the deep ocean is frozen
// and absent from the state (erosionEngineState.ts). A kernel never sees a
// coordinate — neighbours come from the index's table, and a frozen
// neighbour is no neighbour at all (slot -1). Two consequences the walks
// state explicitly below: the flood seeds from the band cells that touch
// the frozen ocean, and sediment that reaches the band's outer rim with
// nowhere lower to go is exported into it and tallied
// (CoordinatorScratch.exportedFlux).
//
// THE SUBSTRATE IS A GRAPH (phase 4.2): the raster and the adaptive mesh
// (mesh/meshErosion.ts) are two instances of one index, and every kernel
// below is written in FINITE-VOLUME form over it — a reach has a length
// and a facet, a node has an area, and nothing is counted in cells. Two
// rules differ between the instances, marked GRID8 where they sit, and
// both are the raster's OLD behaviour kept on purpose, not the mesh's:
// the raster's hillslope exchanges a pair when the lower-indexed endpoint
// is land (the east/south two-pass it replaces exchanged a land cell with
// any east/south neighbour but with a west/north one only if that was
// land too — a direction bias the mesh has no reason to inherit, so the
// mesh's rule is "either endpoint is land"), and the raster settles
// sediment over one cell on every reach where the mesh settles over the
// reach's own length. Changing the raster's two rules moved the golden
// metrics the coastline feeds (coast reaches −15 %, marsh −74 % on one
// seed) — a visible change that belongs to its own step, decided, not to
// the port. What the port does change for the raster is bits: the sums
// run in slot order over every neighbour, the reach factors are stored
// float32. The golden metrics gate it.

// ONE ITERATION IN YEARS (ADAPTIVE_MESH_PLAN.md F7, calibration). The
// engine's rates are per iteration and stay so; this names the iteration
// so the age axis reads in years and phase 5 can turn an epoch's length
// into iterations. Anchored on the uplift: at forcing 1 a cell rises
// upliftDt × 9000 m = 19.8 m per iteration, and 1 mm/yr is the canonical
// rate of an active orogen (0.1–10 mm/yr on Earth), so an iteration is
// 20 000 years. What the other constants then say, at m = 0.5 with the
// drainage area in m²:
//
//   stream power  kappaDt = K·Δt → K = 4.5e-7 /yr — inside the published
//                 range for n = 1 (Stock & Montgomery 1999: 1e-7 … 1e-5)
//   landscape age 40 iterations = 0.8 Myr, 400 = 8 Myr — the 1–10 Myr a
//                 range needs to reach flux steady state (Whipple 2001)
//   hillslope     hillDiffKm2 = D·Δt → D = 25 m²/yr, a thousand times a
//                 soil diffusivity: at 7.8 km cells the term smooths
//                 landscape-scale mass wasting, not soil creep — the known
//                 scale caveat, unchanged by naming the years
//
// Anchoring on the Cenozoic instead (age 400 = 66 Myr, 165 kyr per
// iteration) would make the uplift 0.12 mm/yr and K 5.5e-8, both at the
// slow end; the uplift anchor keeps the ratio physical where phase 5
// couples the two. Measured and chosen 2026-09-22; nothing in the engine
// reads it, so no golden moved.
export const ITERATION_YEARS = 20_000

export interface ErosionEngineParams {
  // Stream-power area exponent (with n=1: a scale-invariant pair).
  m: number
  // Fluvial coefficient per iteration ("dt·K" folded — time is arbitrary
  // to the engine; ITERATION_YEARS names it). Units: (km²)^-m per km of
  // reach.
  kappaDt: number
  // Sub-grid drainage closure: every cell is fed by this much unresolved
  // catchment, so headwater slopes stop depending on the cell size
  // (P0: without it the fine grid stood +156 m systematically higher).
  baseAreaKm2: number
  // Uplift per iteration at forcing = 1, in normalized-z units.
  upliftDt: number
  // Settling: L = max(floor, xi·√Q[km²]) km on land, a short constant under
  // water. Q-dependence is not optional — a constant length shorter than a
  // couple of cells makes everything transport-limited (measured: blobs).
  settleXiKm: number
  settleFloorKm: number
  settleMarineKm: number
  // A delta plain aggrades to just above the waterline, then progrades.
  marineFreeboardM: number
  // Per-iteration deposition caps, metres of column — numerics, not
  // physics: a prograding delta front otherwise advances one violent cell
  // per iteration.
  depositCapLandM: number
  depositCapMarineM: number
  // Roering hillslope: physical diffusivity (km²/iteration) — the per-pair
  // exchange fraction is D/dx², so the term is scale-invariant.
  hillDiffKm2: number
  criticalSlope: number
  // Marine smoothing of fresh deposits: the fraction of a water-to-water
  // height difference exchanged per pair per iteration.
  marineDiffDt: number
  // How far into the world ocean the engine stays active, km from the
  // nearest non-ocean cell (erosionEngineState.ts buildEngineIndex): room
  // for deltas to prograde and marine diffusion to reach, 5 × the marine
  // settling length. What crosses the rim is exported (see
  // CoordinatorScratch.exportedFlux). Scaled with the settle lengths by the
  // forcing assembly, so the alluvium control moves both together.
  shelfBandKm: number
  // Convergence: quasi-steady when the largest per-iteration change stays
  // under this (metres) for 3 consecutive iterations. The transient runs
  // to its AGE, not to convergence; this is the far end of the axis.
  epsM: number
}

// Function-argument defaults, like surface/'s other DEFAULT_*_PARAMS — not a
// tuning object; the forcing assembly derives the run's params from these
// and the sliders, and the bake hashes every field (AMPLIFY_CONSTANTS).
export const DEFAULT_ENGINE_PARAMS: ErosionEngineParams = {
  m: 0.5,
  kappaDt: 0.009,
  baseAreaKm2: 500,
  upliftDt: 2.2e-3,
  settleXiKm: 1.0,
  settleFloorKm: 20,
  settleMarineKm: 8,
  marineFreeboardM: 2,
  depositCapLandM: 10,
  depositCapMarineM: 30,
  hillDiffKm2: 0.5,
  criticalSlope: 0.65,
  // 0.25 × the 0.1 the marine kernel used to fold in — the same exchange
  // fraction, now one hashed number instead of a constant beside it.
  marineDiffDt: 0.025,
  shelfBandKm: 40,
  epsM: 0.35,
}

// The forcing is assembled by the CALLER (the tectonics exports — see
// elevation/upliftField.ts and elevation/erodibilityField.ts). The engine
// is a pure solver; it does not know which world is meant. Every array is
// on the FULL raster; the engine gathers its active subset once.
export interface ErosionForcing {
  // Uplift pattern, one value per cell, multiplied by params.upliftDt.
  uplift: Float32Array
  // Erodibility multiplier per cell (lognormal K-contrast × the smooth
  // crust-history factor; 1 = neutral).
  erodibility: Float32Array
  // Cells allowed to receive uplift — the coastline pin (the initial land
  // mask). Omit to run unpinned, which the engine-check harness does.
  coastMask?: Uint8Array
  // Per-cell drainage contribution (the climate-Q coupling; see
  // accumulateFlowV2). Omit for uniform area weighting.
  accumulationWeights?: Float32Array
  // Land/sea status rule (0 free, 1 keep land, 2 keep sea), enforced once
  // per iteration by kernelStatusClamp. The bake pins it to the macro
  // coastline with a river-mouth growth allowance; the generator omits it
  // (its erosion output BECOMES the macro — free coasts by decision, see
  // docs/design/erosion-v2.md "Coastlines must be pinned").
  statusMask?: Uint8Array
  // The provenance a cut hands to the sediment walk (phase 5.2): the
  // craton oldness and the crust-history hardness under every node. Omit
  // to record volumes alone (the raster drivers do).
  cratonAge?: Float32Array
  rockHard?: Float32Array
}

const EPSILON_FLOOD_STEP = 1e-7
const SQRT2 = Math.SQRT2
const QUARTER_TURN = Math.PI / 4
const NO_SLOT = 255
// The per-pair stability cap of the diffusive stencils: no node may hand
// more than this fraction of a height difference to one neighbour in one
// iteration (explicit diffusion; over ½ it overshoots, the margin is for
// the six-to-eight neighbours that move at once).
const DIFFUSION_PAIR_CAP = 0.2
// D8-LTD facets as [cardinal slot, diagonal slot, orientation] over the
// D8_OFFSETS slot order (flowRouting.ts): N, NE, E, SE, S, SW, W, NW. A
// diagonal slot is odd, which is how the walks tell a √2 reach from a
// unit one without any coordinate.
const LTD_FACETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, +1], [2, 1, -1], [2, 3, +1], [4, 3, -1],
  [4, 5, +1], [6, 5, -1], [6, 7, +1], [0, 7, -1],
]

// Where a status-clamped cell lands, in metres off sea level: a pinned land
// cell driven under resurfaces just above the line, a pinned sea cell built
// above it settles just below. Mechanism, not policy — the POLICY is the
// mask (who is pinned), built by the caller.
export const STATUS_CLAMP_M = 0.5

// The world's physical width is fixed (the macro raster's cells × their
// size); a grid only chooses how finely it samples it. Exported for callers
// that need a grid's cell size in the engine's own terms (the bake's
// delta-allowance radius).
export const WORLD_WIDTH_METERS = MAP_WIDTH * METERS_PER_CELL

// The subset of params the parallel kernels need (a plain object so the
// pool can structured-clone it to workers once). `cellM` is the index's
// reference length (EngineIndex.refM): the cell size on a raster, the
// macro cell on a mesh.
export interface KernelParams {
  upliftDt: number
  hillDiffKm2: number
  criticalSlope: number
  marineDiffDt: number
  cellM: number
}

export function kernelParamsFor(refM: number, params: ErosionEngineParams): KernelParams {
  return {
    upliftDt: params.upliftDt,
    hillDiffKm2: params.hillDiffKm2,
    criticalSlope: params.criticalSlope,
    marineDiffDt: params.marineDiffDt,
    cellM: refM,
  }
}

// A raster grid's cell size in metres.
export function rasterCellM(width: number): number {
  return WORLD_WIDTH_METERS / width
}

// The shelf band in cells for a grid — the index builder's unit.
export function shelfBandCells(width: number, params: ErosionEngineParams): number {
  return Math.max(1, Math.ceil((params.shelfBandKm * 1000) / (WORLD_WIDTH_METERS / width)))
}

// ------------------------------------------------------------------- scans

// Per-node receiver scan, active indices [a0, a1). On the raster
// (FLAG_GRID8) the LTD facet scan (Orlandini 2003, D8-LTD — same method as
// flowRouting.computeLtdFlowTargets, split scan/walk so the scan runs
// per-cell parallel): a facet with a frozen member is skipped, the
// steepest-descent fallback still considers every present neighbour. On a
// mesh, the steepest descent over the star, gradient per reach length —
// a random star has no eight directions to correct (design/adaptive-mesh.md),
// so mode 0 and the fallback IS the receiver.
export function kernelLtdScan(v: EngineViews, a0: number, a1: number): void {
  const { filled, nbr, nbrStart, lenRel, ltdFacet, ltdFallback, ltdDeltaC, ltdDeltaD, ltdMode, flags } = v
  if (flags[FLAG_GRID8] === 0) {
    for (let cell = a0; cell < a1; cell++) {
      const own = filled[cell]
      const start = nbrStart[cell]
      const end = nbrStart[cell + 1]
      let bestGradient = 0
      let fallback = NO_SLOT
      for (let e = start; e < end; e++) {
        const nb = nbr[e]
        if (nb < 0) continue
        const g = (own - filled[nb]) / lenRel[e]
        if (g > bestGradient) { bestGradient = g; fallback = e - start }
      }
      ltdFallback[cell] = fallback
      ltdFacet[cell] = NO_SLOT
      ltdMode[cell] = 0
    }
    return
  }
  for (let cell = a0; cell < a1; cell++) {
    const base = nbrStart[cell]
    const own = filled[cell]
    let bestSlope = 0
    let bestFacet = -1
    let bestS1 = 0
    let bestS2 = 0
    let bestGradient = 0
    let fallback = NO_SLOT
    let bestNc = -1
    let bestNd = -1
    for (let f = 0; f < 8; f++) {
      const facet = LTD_FACETS[f]
      const nc = nbr[base + facet[0]]
      const nd = nbr[base + facet[1]]
      if (nc >= 0) {
        const g1 = own - filled[nc]
        if (g1 > bestGradient) { bestGradient = g1; fallback = facet[0] }
      }
      if (f % 2 === 0 && nd >= 0) {
        const g2 = (own - filled[nd]) / SQRT2
        if (g2 > bestGradient) { bestGradient = g2; fallback = facet[1] }
      }
      if (nc < 0 || nd < 0) continue
      const s1 = own - filled[nc]
      const s2 = filled[nc] - filled[nd]
      let slope: number
      if (s2 <= 0) slope = s1
      else if (s2 >= s1) slope = (own - filled[nd]) / SQRT2
      else slope = Math.hypot(s1, s2)
      if (slope > bestSlope) { bestSlope = slope; bestFacet = f; bestS1 = s1; bestS2 = s2; bestNc = nc; bestNd = nd }
    }
    ltdFallback[cell] = fallback
    if (bestFacet >= 0) {
      const orient = LTD_FACETS[bestFacet][2]
      const alpha = bestS2 <= 0 ? 0 : bestS2 >= bestS1 ? QUARTER_TURN : Math.atan2(bestS2, bestS1)
      ltdFacet[cell] = bestFacet
      ltdDeltaC[cell] = -orient * Math.sin(alpha)
      ltdDeltaD[cell] = orient * SQRT2 * Math.sin(QUARTER_TURN - alpha)
      ltdMode[cell] = 4 | (filled[bestNc] < own ? 1 : 0) | (filled[bestNd] < own ? 2 : 0)
    } else {
      ltdFacet[cell] = NO_SLOT
      ltdMode[cell] = 0
    }
  }
}

// MFD edges over the node's run: weight = drop × mfdFactor — Freeman's
// drop over length on the raster, drop × facet / length (a flux through
// the Voronoi facet) on the mesh. Active indices [a0, a1).
export function kernelMfd(v: EngineViews, a0: number, a1: number): void {
  const { filled, nbr, nbrStart, mfdFactor, mfdDegree, mfdDirection, mfdWeight } = v
  for (let cell = a0; cell < a1; cell++) {
    const base = nbrStart[cell]
    const end = nbrStart[cell + 1]
    const own = filled[cell]
    let count = 0
    let weightSum = 0
    for (let e = base; e < end; e++) {
      const neighbor = nbr[e]
      if (neighbor < 0) continue
      const drop = own - filled[neighbor]
      if (drop <= 0) continue
      const weight = drop * mfdFactor[e]
      if (weight <= 0) continue
      mfdDirection[base + count] = e - base
      mfdWeight[base + count] = weight
      weightSum += weight
      count++
    }
    for (let i = 0; i < count; i++) mfdWeight[base + i] /= weightSum
    mfdDegree[cell] = count
  }
}

// ----------------------------------------------------------------- physics

// Uplift — the forcing half of the balance, pinned to the initial coast
// when the mask flag is set. Active indices [a0, a1).
//
// Capped at z = 1.0: the metre anchor (ELEVATION_METERS) is the world's
// REPRESENTATIONAL ceiling — the save quantizes to it, every consumer
// assumes it, and the golden invariants enforce it. In principle erosion
// bounds height; in practice mountain redistribution hands the engine
// input peaks already AT the ceiling, and forty iterations of uplift on
// top breached it by ~700 m on every golden seed (2026-08-17). Uplift
// saturates there instead — v1's envelope cap played the same role.
export function kernelUplift(v: EngineViews, a0: number, a1: number, kp: KernelParams): void {
  const { z, uplift, coastMask, flags } = v
  const hasMask = flags[FLAG_HAS_COAST_MASK] !== 0
  for (let i = a0; i < a1; i++) {
    if (z[i] > 0 && (!hasMask || coastMask[i])) z[i] = Math.min(1, z[i] + kp.upliftDt * uplift[i])
  }
}

// Roering hillslope diffusion, pass 1: the volume moved along every edge
// whose lower-indexed endpoint lies in [a0, a1), from that endpoint's
// side (positive = away from it). Finite volume over the Voronoi facet:
// V = D·Δt · (facet/length) · Δz, the height change at a node being
// V over its area — on the raster (facet = length, area = cell²) this is
// exactly the old per-pair fraction D·Δt/cell². Roering's nonlinear boost
// on the pair's slope; capped so neither endpoint hands more than
// DIFFUSION_PAIR_CAP of the difference across one edge. A pair exchanges
// when either endpoint is land — symmetric, the coast diffuses into the
// sea from both sides; on the raster (GRID8) when the lower-indexed
// endpoint is land, the old east/south rule (see the module comment).
export function kernelHillMoves(v: EngineViews, a0: number, a1: number, kp: KernelParams): void {
  const { z, nbr, nbrStart, diffFactor, lenRel, areaRel, edgeMove, flags } = v
  const grid8 = flags[FLAG_GRID8] !== 0
  const refM2 = kp.cellM * kp.cellM
  const diffM2 = kp.hillDiffKm2 * 1e6
  for (let cell = a0; cell < a1; cell++) {
    const start = nbrStart[cell]
    const end = nbrStart[cell + 1]
    const own = z[cell]
    const ownArea = areaRel[cell] * refM2
    for (let e = start; e < end; e++) {
      const nb = nbr[e]
      if (nb < cell) {
        edgeMove[e] = 0
        continue
      }
      const geom = diffFactor[e]
      if (geom === 0 || (grid8 ? own <= 0 : own <= 0 && z[nb] <= 0)) {
        edgeMove[e] = 0
        continue
      }
      const dz = own - z[nb]
      if (dz === 0) {
        edgeMove[e] = 0
        continue
      }
      const slope = (Math.abs(dz) * ELEVATION_METERS) / (kp.cellM * lenRel[e])
      const ratio = Math.min(0.95, slope / kp.criticalSlope)
      const boost = 1 / (1 - ratio * ratio)
      const coefficient = Math.min(diffM2 * geom * Math.min(boost, 12), DIFFUSION_PAIR_CAP * Math.min(ownArea, areaRel[nb] * refM2))
      edgeMove[e] = coefficient * dz
    }
  }
}

// Hillslope pass 2: a node's height changes by the volumes it handed out
// and received, over its area; the residual goes to the caller's maxStepW
// slot.
export function kernelHillApply(v: EngineViews, a0: number, a1: number, kp: KernelParams, workerId: number): void {
  const { z, nbr, nbrStart, edgeRev, areaRel, edgeMove, maxStepW } = v
  const refM2 = kp.cellM * kp.cellM
  let maxStep = 0
  for (let cell = a0; cell < a1; cell++) {
    const start = nbrStart[cell]
    const end = nbrStart[cell + 1]
    let volume = 0
    for (let e = start; e < end; e++) {
      const nb = nbr[e]
      if (nb < 0) continue
      volume += nb > cell ? -edgeMove[e] : edgeMove[edgeRev[e]]
    }
    if (volume !== 0) {
      const delta = volume / (areaRel[cell] * refM2)
      z[cell] += delta
      const step = Math.abs(delta)
      if (z[cell] > 0 && step > maxStep) maxStep = step
    }
  }
  maxStepW[workerId] = maxStep
}

// Marine diffusion, pass 1: water-to-water moves along every edge whose
// lower-indexed endpoint lies in [a0, a1). The exchange fraction
// `marineDiffDt` is per pair at the REFERENCE area (the raster's cell —
// what the constant was calibrated on), so on a mesh a fine shelf node
// moves the same volume per pair as a macro cell would and the cap keeps
// it stable. The frozen ocean beyond the band exchanges nothing (no
// neighbour, no move).
export function kernelMarineMoves(v: EngineViews, a0: number, a1: number, kp: KernelParams): void {
  const { z, nbr, nbrStart, diffFactor, areaRel, edgeMove } = v
  const refM2 = kp.cellM * kp.cellM
  for (let cell = a0; cell < a1; cell++) {
    const start = nbrStart[cell]
    const end = nbrStart[cell + 1]
    const own = z[cell]
    const ownArea = areaRel[cell] * refM2
    for (let e = start; e < end; e++) {
      const nb = nbr[e]
      if (nb < cell) {
        edgeMove[e] = 0
        continue
      }
      const geom = diffFactor[e]
      if (geom === 0 || own > 0 || z[nb] > 0) {
        edgeMove[e] = 0
        continue
      }
      const coefficient = Math.min(kp.marineDiffDt * geom * refM2, DIFFUSION_PAIR_CAP * Math.min(ownArea, areaRel[nb] * refM2))
      edgeMove[e] = coefficient * (own - z[nb])
    }
  }
}

// Marine pass 2: combine (no residual tracking — matches the P0 physics).
export function kernelMarineApply(v: EngineViews, a0: number, a1: number, kp: KernelParams): void {
  const { z, nbr, nbrStart, edgeRev, areaRel, edgeMove } = v
  const refM2 = kp.cellM * kp.cellM
  for (let cell = a0; cell < a1; cell++) {
    const start = nbrStart[cell]
    const end = nbrStart[cell + 1]
    let volume = 0
    for (let e = start; e < end; e++) {
      const nb = nbr[e]
      if (nb < 0) continue
      volume += nb > cell ? -edgeMove[e] : edgeMove[edgeRev[e]]
    }
    if (volume !== 0) z[cell] += volume / (areaRel[cell] * refM2)
  }
}

// The land/sea status rule — ONE rule, asked in one place, after every
// mechanism of an iteration has moved material (docs/design/erosion-v2.md:
// the coastline is a balance of ±1–2-point mechanisms and no physics-side
// cap holds it; enforcing STATUS is what makes it auditable). Runs only
// when the caller supplied a mask; excluded from the residual on purpose —
// a clamp is enforcement, not evolution.
export function kernelStatusClamp(v: EngineViews, a0: number, a1: number): void {
  const { z, statusMask, flags } = v
  if (flags[FLAG_HAS_STATUS_MASK] === 0) return
  const clamp = STATUS_CLAMP_M / ELEVATION_METERS
  for (let i = a0; i < a1; i++) {
    const status = statusMask[i]
    if (status === 1) {
      if (z[i] <= 0) z[i] = clamp
    } else if (status === 2) {
      if (z[i] > 0) z[i] = -clamp
    }
  }
}

// ------------------------------------------------- serial (coordinator) parts

// Scratch for everything that runs on the coordinator regardless of mode.
export interface CoordinatorScratch {
  componentLabel: Int32Array
  componentStack: Int32Array
  visited: Uint8Array
  floodHeap: MinHeap
  lambda: Float32Array
  contrib: Uint32Array
  bestInflow: Uint32Array
  segCursor: Int32Array
  // Two run-long tallies, m³: what the fluvial walk cut loose, and what
  // crossed the shelf band's rim into the frozen ocean (or reached any
  // other cell without a receiver). The export is not small — measured
  // 12 % of the eroded volume at 2048 over 20 iterations on the golden
  // world, 4 % at 512 — because marine deposition is capped per iteration
  // and a trunk river's load runs on as a submarine fan far past the
  // band; with the whole ocean active it spread over the abyss, which no
  // one sees and the land does not feel (land fraction and mean height
  // identical to 0.01 % / 0.1 m). It is the deep ocean's share of the
  // sediment budget, the crust sink's input once phase 5 keeps one.
  erodedFlux: Float64Array
  exportedFlux: Float64Array
}

export function createCoordinatorScratch(activeCount: number): CoordinatorScratch {
  const a = activeCount
  return {
    componentLabel: new Int32Array(a),
    componentStack: new Int32Array(a),
    visited: new Uint8Array(a),
    floodHeap: new MinHeap(a),
    lambda: new Float32Array(a),
    contrib: new Uint32Array(a),
    bestInflow: new Uint32Array(a),
    segCursor: new Int32Array(a),
    erodedFlux: new Float64Array(1),
    exportedFlux: new Float64Array(1),
  }
}

// The flood's seeds: the world ocean's active part. Every facet-connected
// component of active ≤ 0 nodes (4-connected on the raster: the cells that
// share a side) that touches the frozen ocean is world ocean (the frozen
// nodes ARE the ocean's interior, so any component connected to it is
// connected to all of it). With no frozen node at all — a world whose
// largest water body fits inside the band — the rule falls back to the
// largest component, which is what the raster flood seeded by (an
// enclosed basin is a depression, not a sea; same rule as flowRouting's
// largestWaterComponent, 2026-08-06).
export function computeOceanSeed(v: EngineViews, s: CoordinatorScratch): boolean {
  const { z, nbr, nbrStart, diffFactor, seedMask, activeCount } = v
  const label = s.componentLabel
  const stack = s.componentStack
  label.fill(-1)
  seedMask.fill(0)
  const sizes: number[] = []
  const touchesFrozen: boolean[] = []
  let sp = 0
  for (let start = 0; start < activeCount; start++) {
    if (z[start] > 0 || label[start] !== -1) continue
    const id = sizes.length
    let size = 0
    let touches = false
    stack[sp++] = start
    label[start] = id
    while (sp > 0) {
      const i = stack[--sp]
      size++
      const end = nbrStart[i + 1]
      for (let e = nbrStart[i]; e < end; e++) {
        const nb = nbr[e]
        if (nb < 0) {
          touches = true
          continue
        }
        if (diffFactor[e] === 0) continue
        if (z[nb] <= 0 && label[nb] === -1) {
          label[nb] = id
          stack[sp++] = nb
        }
      }
    }
    sizes.push(size)
    touchesFrozen.push(touches)
  }
  if (sizes.length === 0) return false
  let any = false
  for (let id = 0; id < sizes.length; id++) if (touchesFrozen[id]) any = true
  if (!any) {
    let best = 0
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i
    touchesFrozen[best] = true
  }
  for (let i = 0; i < activeCount; i++) if (label[i] >= 0 && touchesFrozen[label[i]]) seedMask[i] = 1
  return true
}

// Priority flood over the active set from the ocean seeds (Barnes 2014):
// pops in filled order, writes filled and the pop order — the topological
// order every walk consumes (receivers are STRICTLY lower in filled). A
// cell the flood never reaches (no path to a seed) gets filled = Infinity
// and no place in the order. Returns the popped count.
export function floodActive(v: EngineViews, s: CoordinatorScratch): number {
  const { z, nbr, nbrStart, lenRel, seedMask, filled, popOrder, activeCount } = v
  const visited = s.visited
  const heap = s.floodHeap
  visited.fill(0)
  while (heap.length > 0) heap.pop() // defensive; always drained below
  for (let a = 0; a < activeCount; a++) {
    if (!seedMask[a]) continue
    filled[a] = z[a]
    visited[a] = 1
    heap.push(filled[a], a)
  }
  let popped = 0
  while (heap.length > 0) {
    heap.pop()
    const current = heap.poppedIndex
    popOrder[popped++] = current
    const end = nbrStart[current + 1]
    for (let e = nbrStart[current]; e < end; e++) {
      const nb = nbr[e]
      if (nb < 0 || visited[nb]) continue
      visited[nb] = 1
      filled[nb] = Math.max(z[nb], filled[current]) + EPSILON_FLOOD_STEP * lenRel[e]
      heap.push(filled[nb], nb)
    }
  }
  for (let a = 0; a < activeCount; a++) if (!visited[a]) filled[a] = Infinity
  return popped
}

// The λ-walk: choose each cell's receiver to minimise the accumulated
// transverse deviation, inheriting λ from the largest contributor at
// confluences. Serial by nature (popOrder backward).
export function lambdaWalk(v: EngineViews, popped: number, s: CoordinatorScratch): void {
  const { nbr, nbrStart, flowTarget, flowDir, ltdFacet, ltdDeltaC, ltdDeltaD, ltdFallback, ltdMode, popOrder } = v
  const { lambda, contrib, bestInflow } = s
  flowTarget.fill(-1)
  flowDir.fill(NO_SLOT)
  lambda.fill(0)
  contrib.fill(0)
  bestInflow.fill(0)
  for (let i = popped - 1; i >= 0; i--) {
    const cell = popOrder[i]
    let slot = ltdFallback[cell]
    let delta = 0
    const mode = ltdMode[cell]
    if (mode & 4) {
      const facet = LTD_FACETS[ltdFacet[cell]]
      const cardinalDown = (mode & 1) !== 0
      const diagonalDown = (mode & 2) !== 0
      if (cardinalDown && diagonalDown) {
        const lam = lambda[cell]
        if (Math.abs(lam + ltdDeltaC[cell]) <= Math.abs(lam + ltdDeltaD[cell])) {
          slot = facet[0]
          delta = ltdDeltaC[cell]
        } else {
          slot = facet[1]
          delta = ltdDeltaD[cell]
        }
      } else if (cardinalDown) { slot = facet[0]; delta = ltdDeltaC[cell] }
      else if (diagonalDown) { slot = facet[1]; delta = ltdDeltaD[cell] }
    }
    if (slot === NO_SLOT) continue
    const target = nbr[nbrStart[cell] + slot]
    flowTarget[cell] = target
    flowDir[cell] = slot
    const area = contrib[cell] + 1
    contrib[target] += area
    if (area > bestInflow[target]) {
      bestInflow[target] = area
      lambda[target] = lambda[cell] + delta
    }
  }
}

// Drainage-area accumulation over the MFD edges, popOrder backward, in
// units of the reference area: each node contributes its own area
// (areaRel — 1 per cell on the raster). When FLAG_HAS_ACCUM_WEIGHTS is
// set, that contribution is scaled by views.accumulationWeights[i] — the
// hydrology merge's climate coupling: upsampled provisional precipitation
// makes the engine's Q water, not area (decided 2026-08-17: fixed
// default-parameter forcing at the switchover; live climate coupling is
// its own later stage-order step). In the views so every refresh path —
// single-threaded, pooled, and the pipelined refresh coordinator —
// applies it identically.
export function accumulateFlowV2(v: EngineViews, popped: number): void {
  const { nbr, nbrStart, areaRel, accumulation, mfdDegree, mfdDirection, mfdWeight, popOrder, flags, activeCount } = v
  if (flags[FLAG_HAS_ACCUM_WEIGHTS]) {
    const w = v.accumulationWeights
    for (let i = 0; i < activeCount; i++) accumulation[i] = w[i] * areaRel[i]
  } else accumulation.set(areaRel)
  for (let i = popped - 1; i >= 0; i--) {
    const cell = popOrder[i]
    const amount = accumulation[cell]
    const base = nbrStart[cell]
    const degree = mfdDegree[cell]
    for (let e = 0; e < degree; e++) {
      accumulation[nbr[base + mfdDirection[base + e]]] += amount * mfdWeight[base + e]
    }
  }
}

// Cut the receiver forest into segments (RoutingViews.segment and its
// tables) — at every land→sea edge of the z this routing was computed
// from, and at every terminal cell. Receiver-first over popOrder, so a
// cell's segment is its receiver's unless the edge to it is a cut. A
// segment is a LEAF when no cut edge points INTO it; leaf cells are the
// parallel stage of the walks, everything else the serial stage.
export function buildSegments(v: EngineViews, popped: number, s: CoordinatorScratch): void {
  const { z, flowTarget, popOrder, segment, segOrder, segStart, segLeaf, stage, routingMeta } = v
  const cursor = s.segCursor
  let count = 0
  for (let i = 0; i < popped; i++) {
    const cell = popOrder[i]
    const t = flowTarget[cell]
    if (t < 0 || (z[cell] > 0 && z[t] <= 0)) segment[cell] = count++
    else segment[cell] = segment[t]
  }
  segStart.fill(0, 0, count + 1)
  for (let i = 0; i < popped; i++) segStart[segment[popOrder[i]] + 1]++
  for (let seg = 0; seg < count; seg++) segStart[seg + 1] += segStart[seg]
  cursor.set(segStart.subarray(0, count))
  for (let i = 0; i < popped; i++) {
    const cell = popOrder[i]
    segOrder[cursor[segment[cell]]++] = cell
  }
  segLeaf.fill(1, 0, count)
  for (let i = 0; i < popped; i++) {
    const cell = popOrder[i]
    const t = flowTarget[cell]
    if (t >= 0 && segment[t] !== segment[cell]) segLeaf[segment[t]] = 0
  }
  let leafCells = 0
  for (let seg = 0; seg < count; seg++) if (segLeaf[seg]) leafCells += segStart[seg + 1] - segStart[seg]
  for (let i = 0; i < popped; i++) {
    const cell = popOrder[i]
    stage[cell] = segLeaf[segment[cell]] ? 0 : 1
  }
  routingMeta[0] = count
  routingMeta[1] = leafCells
}

// Which leaf segments worker `workerId` of `workerCount` walks: contiguous
// in segment id, balanced by cell count, and a function of the routing
// alone — so any worker count walks every cell exactly once and the
// per-cell result cannot depend on the split.
function leafRange(v: EngineViews, workerId: number, workerCount: number): [number, number] {
  const { segStart, segLeaf, routingMeta } = v
  const count = routingMeta[0]
  const total = routingMeta[1]
  const lo = Math.floor((workerId * total) / workerCount)
  const hi = Math.floor(((workerId + 1) * total) / workerCount)
  let from = count
  let to = count
  let cum = 0
  for (let seg = 0; seg < count; seg++) {
    if (!segLeaf[seg]) continue
    if (cum >= lo && from === count) from = seg
    if (cum >= hi) { to = seg; break }
    cum += segStart[seg + 1] - segStart[seg]
  }
  return [from, to]
}

// Implicit stream power for one cell, receiver-first: z' = (z +
// F·z'_receiver)/(1 + F), only where the receiver is LOWER in raw z —
// inside a filled depression routing runs uphill over the fill, and the
// implicit form would PULL the cell up: a lake bed does not erode. Returns
// the cut (normalized units).
function fluvialCell(v: EngineViews, cell: number, params: ErosionEngineParams, cellM: number, cellKm2: number): number {
  const { z, flowTarget, flowDir, nbrStart, lenRel, areaRel, accumulation, erodibility, erosionVolume } = v
  erosionVolume[cell] = 0
  const old = z[cell]
  if (old <= 0) return 0
  const target = flowTarget[cell]
  if (target < 0) return 0
  const zr = z[target]
  if (zr >= old) return 0
  const distKm = (cellM / 1000) * lenRel[nbrStart[cell] + flowDir[cell]]
  const dischargeKm2 = accumulation[cell] * cellKm2 + params.baseAreaKm2
  const F = (params.kappaDt * erodibility[cell] * Math.pow(dischargeKm2, params.m)) / distKm
  const znew = (old + F * zr) / (1 + F)
  const cut = old - znew
  z[cell] = znew
  erosionVolume[cell] = cut * ELEVATION_METERS * cellKm2 * areaRel[cell] * 1e6
  v.cutVolume[cell] += erosionVolume[cell]
  return cut
}

// The fluvial walk's serial stage: every serial-stage cell in popOrder
// (receiver-first). Runs BEFORE the leaf kernel, because a leaf root's
// receiver is a serial-stage cell and must hold its new z first. Returns
// the residual (normalized units).
export function fluvialSerial(v: EngineViews, popped: number, params: ErosionEngineParams, cellM: number): number {
  const { popOrder, stage } = v
  const cellKm2 = (cellM / 1000) * (cellM / 1000)
  let maxStep = 0
  for (let i = 0; i < popped; i++) {
    const cell = popOrder[i]
    if (stage[cell] !== 1) continue
    const cut = fluvialCell(v, cell, params, cellM, cellKm2)
    if (cut > maxStep) maxStep = cut
  }
  return maxStep
}

// The fluvial walk's parallel stage: this worker's leaf segments,
// receiver-first within each. Residual into the worker's maxStepW slot.
export function kernelFluvialLeaf(v: EngineViews, workerId: number, workerCount: number, params: ErosionEngineParams, cellM: number): void {
  const { segOrder, segStart, segLeaf, maxStepW } = v
  const cellKm2 = (cellM / 1000) * (cellM / 1000)
  const [from, to] = leafRange(v, workerId, workerCount)
  let maxStep = 0
  for (let seg = from; seg < to; seg++) {
    if (!segLeaf[seg]) continue
    for (let k = segStart[seg]; k < segStart[seg + 1]; k++) {
      const cut = fluvialCell(v, segOrder[k], params, cellM, cellKm2)
      if (cut > maxStep) maxStep = cut
    }
  }
  maxStepW[workerId] = maxStep
}

// ξ–q sediment routing for one cell, donor-first: the flux that arrived
// plus the cell's own cut hands downstream, a reach-integrated fraction
// settles, capped by the donor floor (no deposit may dam the valley that
// feeds it) and, under water, by the freeboard (a delta aggrades to the
// surface, then progrades). Returns what leaves the cell; the caller
// decides where it goes (the receiver, a mailbox, or the export tally).
// The provenance rides with the flux as products (fluxCraton/fluxHard, the
// cut adds its node's own); a deposit takes its share of both, the rest
// goes on. `carry` is the walk's scratch: [0] the residual, [1] and [2]
// the products leaving the cell — read by the caller right after.
function sedimentCell(v: EngineViews, cell: number, params: ErosionEngineParams, cellM: number, cellKm2: number, columnM3: number, capLandM3: number, capMarineM3: number, carry: Float64Array): number {
  const { z, flowTarget, flowDir, nbrStart, lenRel, areaRel, accumulation, erosionVolume, flux, donorMin, flags } = v
  let carrying = flux[cell] + erosionVolume[cell]
  let pCraton = v.fluxCraton[cell] + erosionVolume[cell] * v.cratonAge[cell]
  let pHard = v.fluxHard[cell] + erosionVolume[cell] * v.rockHard[cell]
  carry[1] = pCraton
  carry[2] = pHard
  if (carrying <= 0) return carrying
  const land = z[cell] > 0
  const settle = land
    ? Math.max(params.settleFloorKm, params.settleXiKm * Math.sqrt(accumulation[cell] * cellKm2 + params.baseAreaKm2))
    : params.settleMarineKm
  // Exact exponential integration over the reach — scale-consistent
  // for any dx/L, where a clamped linear fraction was not. A terminal
  // node (no receiver) settles over one reference length; so does every
  // raster cell (GRID8), diagonal or not — the old rule, see the module
  // comment.
  const reachKm = (cellM / 1000) * (flowTarget[cell] >= 0 && flags[FLAG_GRID8] === 0 ? lenRel[nbrStart[cell] + flowDir[cell]] : 1)
  const dropFraction = 1 - Math.exp(-reachKm / settle)
  let deposit = carrying * dropFraction
  const area = areaRel[cell]
  const column = columnM3 * area
  const donorCap = donorMin[cell] - 1e-5
  const cap = land ? donorCap : Math.min(donorCap, params.marineFreeboardM / ELEVATION_METERS)
  const room = (cap - z[cell]) * column
  if (deposit > room) deposit = Math.max(0, room)
  const capM3 = (land ? capLandM3 : capMarineM3) * area
  if (deposit > capM3) deposit = capM3
  if (deposit > 0) {
    const dz = deposit / column
    z[cell] += dz
    const share = deposit / carrying
    v.depositVolume[cell] += deposit
    v.depositCraton[cell] += pCraton * share
    v.depositHard[cell] += pHard * share
    pCraton -= pCraton * share
    pHard -= pHard * share
    carry[1] = pCraton
    carry[2] = pHard
    carrying -= deposit
    if (land && dz > carry[0]) carry[0] = dz
  }
  return carrying
}

// The sediment walk's parallel stage: this worker's leaf segments,
// donor-first within each; what leaves a segment's root goes into the
// segment's mailbox (mouthFlux/mouthZ) for the serial stage, or, with no
// receiver at all, is exported. Residual and tallies into the worker's
// slots.
export function kernelSedimentLeaf(v: EngineViews, workerId: number, workerCount: number, params: ErosionEngineParams, cellM: number): void {
  const { z, flowTarget, erosionVolume, flux, donorMin, mouthFlux, mouthZ, fluxCraton, fluxHard, mouthCraton, mouthHard, segOrder, segStart, segLeaf, maxStepW, erodedW, exportedW } = v
  const cellKm2 = (cellM / 1000) * (cellM / 1000)
  const columnM3 = ELEVATION_METERS * cellKm2 * 1e6
  const capLandM3 = params.depositCapLandM * cellKm2 * 1e6
  const capMarineM3 = params.depositCapMarineM * cellKm2 * 1e6
  const residual = new Float64Array(3)
  const [from, to] = leafRange(v, workerId, workerCount)
  let eroded = 0
  let exported = 0
  for (let seg = from; seg < to; seg++) {
    if (!segLeaf[seg]) continue
    const start = segStart[seg]
    const end = segStart[seg + 1]
    for (let k = start; k < end; k++) {
      const cell = segOrder[k]
      flux[cell] = 0
      fluxCraton[cell] = 0
      fluxHard[cell] = 0
      donorMin[cell] = Infinity
      eroded += erosionVolume[cell]
    }
    for (let k = end - 1; k > start; k--) {
      const cell = segOrder[k]
      const carrying = sedimentCell(v, cell, params, cellM, cellKm2, columnM3, capLandM3, capMarineM3, residual)
      const target = flowTarget[cell]
      flux[target] += carrying
      fluxCraton[target] += residual[1]
      fluxHard[target] += residual[2]
      if (z[cell] < donorMin[target]) donorMin[target] = z[cell]
    }
    const root = segOrder[start]
    const carrying = sedimentCell(v, root, params, cellM, cellKm2, columnM3, capLandM3, capMarineM3, residual)
    if (flowTarget[root] >= 0) {
      mouthFlux[seg] = carrying
      mouthCraton[seg] = residual[1]
      mouthHard[seg] = residual[2]
      mouthZ[seg] = z[root]
    } else {
      mouthFlux[seg] = 0
      mouthCraton[seg] = 0
      mouthHard[seg] = 0
      if (carrying > 0) exported += carrying
    }
  }
  maxStepW[workerId] = residual[0]
  erodedW[workerId] = eroded
  exportedW[workerId] = exported
}

// The sediment walk's serial stage, AFTER the leaf kernel: every leaf
// mailbox is delivered to its outlet (in segment order, so the sum is the
// same for any worker split), then the serial-stage cells walk donor-first
// in popOrder. Returns the residual; adds to the coordinator's tallies.
export function sedimentSerial(v: EngineViews, popped: number, params: ErosionEngineParams, cellM: number, s: CoordinatorScratch): number {
  const { z, flowTarget, erosionVolume, flux, donorMin, mouthFlux, mouthZ, fluxCraton, fluxHard, mouthCraton, mouthHard, popOrder, stage, segOrder, segStart, segLeaf, routingMeta } = v
  const cellKm2 = (cellM / 1000) * (cellM / 1000)
  const columnM3 = ELEVATION_METERS * cellKm2 * 1e6
  const capLandM3 = params.depositCapLandM * cellKm2 * 1e6
  const capMarineM3 = params.depositCapMarineM * cellKm2 * 1e6
  const residual = new Float64Array(3)
  let eroded = 0
  let exported = 0
  for (let i = 0; i < popped; i++) {
    const cell = popOrder[i]
    if (stage[cell] !== 1) continue
    flux[cell] = 0
    fluxCraton[cell] = 0
    fluxHard[cell] = 0
    donorMin[cell] = Infinity
    eroded += erosionVolume[cell]
  }
  const count = routingMeta[0]
  for (let seg = 0; seg < count; seg++) {
    if (!segLeaf[seg]) continue
    const target = flowTarget[segOrder[segStart[seg]]]
    if (target < 0) continue
    flux[target] += mouthFlux[seg]
    fluxCraton[target] += mouthCraton[seg]
    fluxHard[target] += mouthHard[seg]
    if (mouthZ[seg] < donorMin[target]) donorMin[target] = mouthZ[seg]
  }
  for (let i = popped - 1; i >= 0; i--) {
    const cell = popOrder[i]
    if (stage[cell] !== 1) continue
    const carrying = sedimentCell(v, cell, params, cellM, cellKm2, columnM3, capLandM3, capMarineM3, residual)
    const target = flowTarget[cell]
    if (target >= 0) {
      flux[target] += carrying
      fluxCraton[target] += residual[1]
      fluxHard[target] += residual[2]
      if (z[cell] < donorMin[target]) donorMin[target] = z[cell]
    } else if (carrying > 0) {
      exported += carrying
    }
  }
  s.erodedFlux[0] += eroded
  s.exportedFlux[0] += exported
  return residual[0]
}

// Fold the workers' per-iteration slots into the run-long tallies.
export function collectWalkTallies(v: EngineViews, workerCount: number, s: CoordinatorScratch): void {
  for (let w = 0; w < workerCount; w++) {
    s.erodedFlux[0] += v.erodedW[w]
    s.exportedFlux[0] += v.exportedW[w]
  }
}

// ------------------------------------------------------------------ driver

// The single-threaded engine: the same kernels the pool runs, called in
// sequence over the full active range. Byte-identical to any pooled run.
export class ErosionEngine {
  readonly width: number
  readonly height: number
  readonly params: ErosionEngineParams
  readonly index: EngineIndex
  readonly views: EngineViews
  poppedCount = 0
  // Global iteration cursor: run() may be called in chunks (the pass
  // adapter does, for progress redraws), and the refresh cadence must not
  // reset at chunk boundaries.
  private cursor = 0

  private readonly scratch: CoordinatorScratch
  private readonly kernelParams: KernelParams

  // On a raster: the index is built here from the initial terrain. On any
  // other substrate, build the index yourself and use `onIndex`.
  constructor(
    width: number,
    height: number,
    initial: Float32Array,
    forcing: ErosionForcing,
    params: ErosionEngineParams = DEFAULT_ENGINE_PARAMS,
    index?: EngineIndex,
  ) {
    const built = index ?? buildRasterIndex(width, height, initial, forcing, params)
    this.width = width
    this.height = height
    this.params = params
    this.index = built
    this.views = createEngineViews(built)
    loadTerrain(built, this.views, initial, forcing)
    this.scratch = createCoordinatorScratch(built.activeCount)
    this.kernelParams = kernelParamsFor(built.refM, params)
  }

  // The engine over a prepared index (a mesh, mesh/meshErosion.ts): the
  // initial terrain and the forcing are in the index's full layout
  // (cellCount entries or more), exactly as a raster caller's arrays are.
  static onIndex(index: EngineIndex, initial: Float32Array, forcing: ErosionForcing, params: ErosionEngineParams = DEFAULT_ENGINE_PARAMS): ErosionEngine {
    if (initial.length < index.cellCount || forcing.uplift.length < index.cellCount || forcing.erodibility.length < index.cellCount) {
      throw new Error('field size mismatch')
    }
    return new ErosionEngine(index.width, index.height, initial, forcing, params, index)
  }

  // The evolving terrain in ACTIVE space (normalized z, mutated in place by
  // stepPhysics). expandZ gives the raster.
  get z(): Float32Array {
    return this.views.z
  }

  get accumulation(): Float32Array {
    return this.views.accumulation
  }

  // Run-long tallies, m³: sediment the fluvial walk produced, and sediment
  // exported past the shelf band's rim.
  get erodedFluxM3(): number {
    return this.scratch.erodedFlux[0]
  }

  get exportedFluxM3(): number {
    return this.scratch.exportedFlux[0]
  }

  // The full raster: active cells from the engine, frozen cells from
  // `frozenFrom` (the initial terrain — frozen cells never move).
  expandZ(frozenFrom: Float32Array): Float32Array {
    return expandActive(this.index, this.views.z, frozenFrom)
  }

  // Recompute the whole routing state from the current z. Reads z only;
  // writes only routing state — the one-way split the pipelined refresh
  // depends on.
  refreshRouting(): void {
    const v = this.views
    const a = this.index.activeCount
    this.poppedCount = refreshRoutingOn(v, this.scratch, () => kernelLtdScan(v, 0, a), () => kernelMfd(v, 0, a))
  }

  // One physics iteration on the current routing. Returns the residual: the
  // largest land elevation change, in metres.
  stepPhysics(): number {
    const v = this.views
    const a = this.index.activeCount
    const cellM = this.kernelParams.cellM
    let maxStep = 0
    kernelUplift(v, 0, a, this.kernelParams)
    maxStep = Math.max(maxStep, fluvialSerial(v, this.poppedCount, this.params, cellM))
    kernelFluvialLeaf(v, 0, 1, this.params, cellM)
    maxStep = Math.max(maxStep, v.maxStepW[0])
    kernelSedimentLeaf(v, 0, 1, this.params, cellM)
    maxStep = Math.max(maxStep, v.maxStepW[0])
    collectWalkTallies(v, 1, this.scratch)
    maxStep = Math.max(maxStep, sedimentSerial(v, this.poppedCount, this.params, cellM, this.scratch))
    kernelHillMoves(v, 0, a, this.kernelParams)
    kernelHillApply(v, 0, a, this.kernelParams, 0)
    maxStep = Math.max(maxStep, v.maxStepW[0])
    kernelMarineMoves(v, 0, a, this.kernelParams)
    kernelMarineApply(v, 0, a, this.kernelParams)
    if (v.flags[FLAG_HAS_STATUS_MASK] !== 0) kernelStatusClamp(v, 0, a)
    return maxStep * ELEVATION_METERS
  }

  // Run the transient: `iterations` IS the landscape age. Routing refreshes
  // every `routingEvery` iterations (K ≤ 8 validated). Stops early only at
  // quasi-steady state (3 consecutive residuals under epsM) — the far end
  // of the age axis, not the goal.
  run(iterations: number, routingEvery = 4, onIteration?: (iteration: number, residualM: number) => void): number {
    let residual = Infinity
    let calmStreak = 0
    for (let i = 0; i < iterations; i++) {
      if (this.cursor % routingEvery === 0) this.refreshRouting()
      this.cursor++
      residual = this.stepPhysics()
      calmStreak = residual < this.params.epsM ? calmStreak + 1 : 0
      onIteration?.(i, residual)
      if (calmStreak >= 3) break
    }
    return residual
  }
}

// The raster index for a run: the size check and the shelf band in cells.
// One function for every driver.
export function buildRasterIndex(width: number, height: number, initial: Float32Array, forcing: ErosionForcing, params: ErosionEngineParams): EngineIndex {
  const n = width * height
  if (initial.length !== n || forcing.uplift.length !== n || forcing.erodibility.length !== n) {
    throw new Error('field size mismatch')
  }
  return buildEngineIndex(initial, width, height, shelfBandCells(width, params), rasterCellM(width))
}

// The terrain section's initial contents, gathered from the caller's full
// arrays — copied, never aliased, so the caller's arrays are not reshaped
// as a side effect. One function for every driver (single-threaded, pool,
// pipelined), so the three cannot disagree on what a flag means.
export function loadTerrain(index: EngineIndex, views: Omit<TerrainViews, 'buffer'>, initial: Float32Array, forcing: ErosionForcing): void {
  gatherActive(index, initial, views.z)
  gatherActive(index, forcing.uplift, views.uplift)
  gatherActive(index, forcing.erodibility, views.erodibility)
  if (forcing.coastMask) {
    gatherActive(index, forcing.coastMask, views.coastMask)
    views.flags[FLAG_HAS_COAST_MASK] = 1
  }
  if (forcing.accumulationWeights) {
    gatherActive(index, forcing.accumulationWeights, views.accumulationWeights)
    views.flags[FLAG_HAS_ACCUM_WEIGHTS] = 1
  }
  if (forcing.statusMask) {
    gatherActive(index, forcing.statusMask, views.statusMask)
    views.flags[FLAG_HAS_STATUS_MASK] = 1
  }
  if (forcing.cratonAge) gatherActive(index, forcing.cratonAge, views.cratonAge)
  if (forcing.rockHard) gatherActive(index, forcing.rockHard, views.rockHard)
}

// The routing refresh in one place for every driver: seeds, flood, the
// two parallel scans (handed to the caller, who runs them inline over the
// whole range or dispatches them to workers), the λ-walk and the
// accumulation. Returns the popped count; a world with no water at all
// gets no routing (flowTarget -1, accumulation 1) — the same graceful
// degradation as flowRouting.
export function refreshRoutingOn(v: EngineViews, s: CoordinatorScratch, runLtdScan: () => void, runMfd: () => void): number {
  if (!computeOceanSeed(v, s)) {
    v.flowTarget.fill(-1)
    v.flowDir.fill(NO_SLOT)
    v.accumulation.fill(1)
    return 0
  }
  const popped = floodActive(v, s)
  runLtdScan()
  lambdaWalk(v, popped, s)
  buildSegments(v, popped, s)
  runMfd()
  accumulateFlowV2(v, popped)
  return popped
}
