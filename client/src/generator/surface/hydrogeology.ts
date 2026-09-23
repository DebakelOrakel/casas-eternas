import { ELEVATION_METERS, SEA_LEVEL } from '../elevation/elevationScale'
import { COLUMN_DEPTH, COLUMN_VALUES, type SedimentColumn } from '../mesh/meshColumn'
import { OCEAN_PRECIP } from '../climate/precipitation'
import type { FlowSubstrate } from './flowSubstrate'
import { evaporationPotential, type RegimeInputs } from './hydrology'
import type { RiverGraph, RiverRegime } from './riverGraph'
import { SURFACE_TUNING } from './surfaceTuneParams'

// HYDROGEOLOGY AS A CLASSIFICATION (ADAPTIVE_MESH_PLAN.md phase 5a): what
// the game needs of the water under the ground — springs, wells, oases,
// which valleys run dry — read off the terrain, the sediment column, the
// climate and the river graph that already exist. No process: nothing here
// moves water over time; it says where the water stands and comes out,
// once, on the terrain the history left.
//
// Three readings from one permeability per node — the column's top
// material (coarse fill is gravel and sand, fine fill is mud, the bedrock
// by its hardness), held down by the cover:
//
//   THE REGIME (F6 upgraded): rain that infiltrates does not run off the
//   day it falls, it comes back as baseflow the year round — a permeable
//   catchment keeps its river flowing through the dry season, an
//   impermeable one runs dry. So the dry-season flow the regime is judged
//   on is the dry season's quick runoff PLUS the year's infiltration, and
//   a reach a spring feeds is perennial.
//
//   SPRINGS: where the surface cuts a permeable layer lying on an
//   impermeable one — a coarse top over a fine layer or over hard bedrock
//   — with a neighbour below the contact and enough recharge from above,
//   the water comes out. A spring in an arid climate is an oasis. Springs
//   are features of the river graph (RiverGraph.springs), and the reaches
//   downstream of one are spring-fed.
//
//   THE WATER TABLE: a Dupuit estimate between the channels — the table
//   rises from the nearest channel's level with the flow distance, steeply
//   where the ground is tight (the head has nowhere to drain) and gently
//   where it is permeable, scaled by the recharge. One value per node,
//   metres below the surface: the depth of a well.

export interface SpringFeature {
  id: number
  cell: number
  x: number
  y: number
  // Elevation units.
  elevation: number
  // A spring in an arid climate.
  oasis: boolean
}

export interface HydrogeologyInputs {
  sub: FlowSubstrate
  elevation: Float32Array
  graph: RiverGraph
  // The mesh's column (null on the raster: bedrock everywhere).
  column: SedimentColumn | null
  // The crust-history hardness on the climate grid (null: uniform).
  hardness: Float32Array | null
  climateResX: number
  climateResY: number
  precipitation: Float32Array
  temperature: Float32Array
  monsoonIndex?: Float32Array
  // The vegetation's hold per climate cell (surface/cover.ts).
  cover: Float32Array
  // The regime's accumulated inputs the graph was built with.
  regime: RegimeInputs
  discharge: Float32Array
  // Metres per substrate unit of distance.
  cellM: number
}

export interface HydrogeologyResult {
  // Per element: the top material's permeability in [0, 1].
  permeability: Float32Array
  // Per element: the water table's depth below the surface, metres; 0 at a
  // channel or where the table reaches the surface; −1 under water and
  // off the routing.
  waterTableDepthM: Float32Array
  springs: SpringFeature[]
}

const COARSE = 1
const FINE = 0

function sampleCoarse(field: Float32Array, resX: number, resY: number, x: number, y: number, width: number, height: number): number {
  const cx = Math.min(resX - 1, Math.max(0, Math.floor((x / width) * resX)))
  const cy = Math.min(resY - 1, Math.max(0, Math.floor((y / height) * resY)))
  return field[cy * resX + cx]
}

// The top material's permeability and the thickness of the permeable top
// (metres) at a node: the column's top layer when there is one, the
// bedrock by its hardness otherwise.
function topMaterial(column: SedimentColumn | null, v: number, bedrockPermeability: number, out: Float64Array): void {
  const T = SURFACE_TUNING
  if (column) {
    const base = v * COLUMN_DEPTH
    for (let layer = column.epochs.length - 1; layer >= 0; layer--) {
      const at = base + layer * COLUMN_VALUES
      const coarse = column.data[at + COARSE]
      const fine = column.data[at + FINE]
      if (coarse + fine < T.hydrogeologyLayerMinM) continue
      // The top layer that is thick enough to be a material: its class by
      // the larger part.
      if (coarse >= fine) { out[0] = T.permeabilityCoarse; out[1] = coarse; out[2] = 1 } else { out[0] = T.permeabilityFine; out[1] = fine; out[2] = 0 }
      // What lies under it: the next layer thick enough, or the bedrock.
      out[3] = bedrockPermeability
      for (let below = layer - 1; below >= 0; below--) {
        const b = base + below * COLUMN_VALUES
        const c2 = column.data[b + COARSE]
        const f2 = column.data[b + FINE]
        if (c2 + f2 < T.hydrogeologyLayerMinM) continue
        out[3] = c2 >= f2 ? T.permeabilityCoarse : T.permeabilityFine
        break
      }
      return
    }
  }
  out[0] = bedrockPermeability
  out[1] = 0
  out[2] = 0
  out[3] = bedrockPermeability
}

export function computeHydrogeology(input: HydrogeologyInputs): HydrogeologyResult {
  const { sub, elevation, graph, column, climateResX: RX, climateResY: RY, precipitation, temperature, monsoonIndex, cover, regime, discharge, cellM } = input
  const { width, height, flowTarget, popOrder, poppedCount, count: n } = sub
  const T = SURFACE_TUNING
  const permeability = new Float32Array(n)
  const topThicknessM = new Float32Array(n)
  const topIsCoarse = new Uint8Array(n)
  const belowPermeability = new Float32Array(n)
  const infiltration = new Float32Array(n)
  const mat = new Float64Array(4)
  for (let c = 0; c < n; c++) {
    if (elevation[c] <= SEA_LEVEL) continue
    const x = sub.x(c)
    const y = sub.y(c)
    const hard = input.hardness ? sampleCoarse(input.hardness, RX, RY, x, y, width, height) : 1
    const bedrock = Math.min(T.permeabilityBedrockMax, Math.max(T.permeabilityBedrockMin, T.permeabilityBedrock / Math.max(0.25, hard)))
    topMaterial(column, c, bedrock, mat)
    permeability[c] = mat[0]
    topThicknessM[c] = mat[1]
    topIsCoarse[c] = mat[2]
    belowPermeability[c] = mat[3]
    const cv = sampleCoarse(cover, RX, RY, x, y, width, height)
    infiltration[c] = Math.min(T.infiltrationMax, mat[0] * (T.infiltrationBare + (1 - T.infiltrationBare) * cv))
  }

  // The accumulations the regime needs beyond the discharge: the baseflow
  // (the year's infiltration) and the dry season's quick runoff, both over
  // the catchment like the discharge (hydrology.accumulateDischargeOn's
  // rule: an element contributes its precipitation over its area).
  const base = new Float32Array(n)
  const dryQuick = new Float32Array(n)
  for (let c = 0; c < n; c++) {
    if (elevation[c] <= SEA_LEVEL) continue
    const x = sub.x(c)
    const y = sub.y(c)
    const p = sampleCoarse(precipitation, RX, RY, x, y, width, height)
    if (p === OCEAN_PRECIP || p <= 0) continue
    const s = monsoonIndex ? Math.abs(sampleCoarse(monsoonIndex, RX, RY, x, y, width, height)) : 0
    const dry = s < 1 ? p * (1 - s) : 0
    const area = sub.area(c)
    base[c] = p * infiltration[c] * area
    dryQuick[c] = dry * (1 - infiltration[c]) * area
  }
  for (let i = poppedCount - 1; i >= 0; i--) {
    const c = popOrder[i]
    const t = flowTarget[c]
    if (t < 0 || elevation[c] <= SEA_LEVEL) continue
    base[t] += base[c]
    dryQuick[t] += dryQuick[c]
  }

  // The channels: every reach cell, mapped to its reach.
  const reachOf = new Int32Array(n).fill(-1)
  for (const r of graph.reaches) {
    for (let k = r.cellStart; k < r.cellStart + r.cellCount; k++) reachOf[graph.cells[k]] = r.id
  }

  // SPRINGS.
  const springs: SpringFeature[] = []
  const nbrs = new Int32Array(64)
  for (let c = 0; c < n; c++) {
    if (elevation[c] <= SEA_LEVEL || reachOf[c] >= 0) continue
    if (!topIsCoarse[c] || permeability[c] < T.springPermeableAbove || belowPermeability[c] > T.springSealedBelow) continue
    if (base[c] < T.springMinBaseflow) continue
    // The contact outcrops: a neighbour stands below the permeable top's base.
    const contact = elevation[c] - topThicknessM[c] / ELEVATION_METERS
    const count = sub.facetNeighbours(c, nbrs)
    let outcrops = false
    for (let k = 0; k < count; k++) if (elevation[nbrs[k]] < contact) { outcrops = true; break }
    if (!outcrops) continue
    const x = sub.x(c)
    const y = sub.y(c)
    const p = sampleCoarse(precipitation, RX, RY, x, y, width, height)
    const pet = evaporationPotential(sampleCoarse(temperature, RX, RY, x, y, width, height))
    const oasis = pet > 0 && p > 0 && p / pet < T.regimeAridBelow
    springs.push({ id: springs.length, cell: c, x, y, elevation: elevation[c], oasis })
  }

  // SPRING-FED REACHES: from every spring down its flow path to the first
  // channel, then down the graph. And THE REGIME, re-judged with the
  // baseflow.
  const outOf = new Map<number, number[]>()
  for (const r of graph.reaches) {
    const list = outOf.get(r.from)
    if (list) list.push(r.id)
    else outOf.set(r.from, [r.id])
  }
  const springFed = new Uint8Array(graph.reaches.length)
  for (const s of springs) {
    let c = s.cell
    let guard = 0
    while (c >= 0 && reachOf[c] < 0 && ++guard < n) c = flowTarget[c]
    if (c < 0 || reachOf[c] < 0) continue
    let id = reachOf[c]
    let steps = 0
    while (id >= 0 && !springFed[id] && ++steps <= graph.reaches.length) {
      springFed[id] = 1
      const next = outOf.get(graph.reaches[id].to)
      id = next && next.length > 0 ? next[0] : -1
    }
  }
  for (const r of graph.reaches) {
    const last = graph.cells[r.cellStart + r.cellCount - 2]
    r.runoffOut = dryQuick[last] + base[last]
    r.springFed = springFed[r.id] === 1
    r.regime = classifyRegimeWithBaseflow(r.springFed, discharge[last], regime.loss[last], r.runoffOut)
  }
  graph.springs = springs

  // THE WATER TABLE: receivers first, so every element reads its receiver's
  // distance to the nearest channel or water and that channel's level.
  const waterTableDepthM = new Float32Array(n).fill(-1)
  const distM = new Float32Array(n)
  const headZ = new Float32Array(n)
  for (let i = 0; i < poppedCount; i++) {
    const c = popOrder[i]
    const t = flowTarget[c]
    const atWater = elevation[c] <= SEA_LEVEL || reachOf[c] >= 0 || sub.filled[c] > elevation[c] + 1e-6
    if (atWater || t < 0) {
      distM[c] = 0
      headZ[c] = elevation[c]
      waterTableDepthM[c] = elevation[c] <= SEA_LEVEL ? -1 : 0
      continue
    }
    distM[c] = distM[t] + sub.step(c, t) * cellM
    headZ[c] = headZ[t]
    const x = sub.x(c)
    const y = sub.y(c)
    const p = Math.max(0, sampleCoarse(precipitation, RX, RY, x, y, width, height))
    const recharge = Math.min(T.aquiferRechargeCap, p / T.aquiferRechargeRefMm)
    const rise = T.aquiferRiseBase * (1 - T.aquiferRisePermeableDrop * permeability[c]) * recharge
    const tableZ = headZ[c] + (rise * distM[c]) / ELEVATION_METERS
    waterTableDepthM[c] = Math.max(0, (elevation[c] - tableZ) * ELEVATION_METERS)
  }
  return { permeability, waterTableDepthM, springs }
}

// The regime with the ground's word: arid catchments are ephemeral as
// before; the dry season is judged on its quick runoff plus the baseflow;
// a spring-fed reach is perennial.
export function classifyRegimeWithBaseflow(springFed: boolean, discharge: number, loss: number, dryFlow: number): RiverRegime {
  if (springFed) return 'perennial'
  if (loss <= 0) return 'perennial'
  if (discharge / loss < SURFACE_TUNING.regimeAridBelow) return 'ephemeral'
  if (dryFlow / loss < SURFACE_TUNING.regimeDrySeasonBelow) return 'intermittent'
  return 'perennial'
}

// The invariants: a spring sits off the channels on land; an ephemeral
// reach is not spring-fed (the rule); the table is never above the
// surface and never negative on routed land.
export function hydrogeologyInvariants(result: HydrogeologyResult, graph: RiverGraph, elevation: Float32Array): Record<string, number> {
  const out: Record<string, number> = { springOnWater: 0, springOnChannel: 0, ephemeralSpringFed: 0, tableOutOfRange: 0 }
  const channel = new Uint8Array(elevation.length)
  for (let k = 0; k < graph.cells.length; k++) channel[graph.cells[k]] = 1
  for (const s of result.springs) {
    if (elevation[s.cell] <= SEA_LEVEL) out.springOnWater++
    if (channel[s.cell]) out.springOnChannel++
  }
  for (const r of graph.reaches) if (r.springFed && r.regime === 'ephemeral') out.ephemeralSpringFed++
  for (let c = 0; c < result.waterTableDepthM.length; c++) {
    const d = result.waterTableDepthM[c]
    if (d !== -1 && !(d >= 0 && Number.isFinite(d))) out.tableOutOfRange++
  }
  return out
}
