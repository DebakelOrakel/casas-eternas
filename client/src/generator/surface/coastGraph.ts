import { SEA_LEVEL, elevationToMeters } from '../elevation/elevationScale'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'
import { SURFACE_TUNING } from './surfaceTuneParams'
import type { RiverGraph } from './riverGraph'
import { findShore, shoreExposure } from './coastal'

// THE COAST AS A FEATURE (ADAPTIVE_MESH_PLAN.md F5, docs/design/coast.md
// "Forerunner"): the shoreline cut into REACHES with attributes like a
// river's, and a coast TYPE per reach from them — a classification with no
// process behind it. The coast process (surface/coastal.ts, phase 7) runs on
// the same line in the history; this is the picture after the stop.
//
// On the terrain mesh since DEC-0036 phase 7b (it walked the 2048 raster
// before): a coast node is a land node with a sea node among its
// neighbours (coastal.findShore — the line the history's waves and drift
// work on), and reaches are walks from coast node to coast node along the
// mesh's edges, cut at river mouths and every `coastReachM` metres. Per
// node:
//
//   exposure  wave energy from the wind: speed² × fetch, the fetch being
//             the open water UPWIND of the node (the direction the waves
//             come from) up to `coastFetchCapKm`, marched in steps of
//             `coastGraphFetchStepM` (coastal.shoreExposure), normalised to
//             the world's 90th-percentile coast and clamped, so it is
//             relative (0..1; the top tenth reads 1). Measured 2026-09-22
//             on golden alpha against the maximum instead: the median
//             coast read 0.01 and nine of ten reaches came out rocky —
//             a few storm coasts set the scale for all.
//   relief    the highest land of the terrain's surface at the node and
//             at the eight compass points `coastReliefStepM` around it,
//             metres above the sea: a steep coast is what waves can cut a
//             cliff into.
//   hardness  the erodibility K factor (1 neutral, below 1 hard) from the
//             erosion forcing's field.
//   supply    river sediment reaching the node: every sea mouth's load
//             spread over `coastSupplyReachKm`, relative to the world's
//             90th-percentile fed coast like the exposure.
//
// From those the type, in this order (the first rule that fits): DELTA
// within `coastDeltaReachM` of a mouth whose course is one; MARSH where the
// water is calm, the land flat and river sediment arrives; CLIFF where the
// coast is steep and exposed and the rock not soft; BEACH where sediment
// arrives or the waves work a low coast; ROCKY for the sheltered, unfed,
// hard rest. A reach takes the type most of its nodes have.
export type CoastType = 'rocky' | 'cliff' | 'beach' | 'marsh' | 'delta'

// The type as the per-node field and the shader's raster carry it, one
// byte each (0 = not on the coast).
export const COAST_TYPE_CODE: Record<CoastType, number> = { rocky: 1, cliff: 2, beach: 3, marsh: 4, delta: 5 }
const CODE_TYPE: CoastType[] = ['rocky', 'rocky', 'cliff', 'beach', 'marsh', 'delta']

export interface CoastReach {
  id: number
  // The reach's coast nodes in walk order (CoastGraph.nodes).
  nodeStart: number
  nodeCount: number
  lengthKm: number
  // Means over the nodes (exposure, relief m, hardness) and the summed
  // relative supply.
  exposure: number
  reliefM: number
  hardness: number
  supply: number
  type: CoastType
  // The river reach that ends on this coast reach, -1 for none.
  mouthReach: number
}

export interface CoastGraph {
  reaches: CoastReach[]
  // The coast nodes of every reach, concatenated in reach order: vertex ids
  // of the mesh the graph was built on.
  nodes: Int32Array
  // The type per vertex slot (COAST_TYPE_CODE), 0 off the coast.
  type: Uint8Array
}

export interface CoastGraphInputs {
  mesh: PeriodicTriangulation
  // Heights per slot, elevation units.
  z: Float32Array
  // The wind per slot, east and south in the node's own frame (climate/
  // wind.ts's units): the climate's field mesh read at the nodes
  // (climate/climatePoints.ts).
  windE: ArrayLike<number>
  windS: ArrayLike<number>
  // The erodibility K factor per slot (erosionForcing.coarseForcingFields'
  // hardness at the nodes), or absent (neutral).
  hardness?: ArrayLike<number>
  // The river graph on the same mesh (its cells are vertex ids), or null.
  graph: RiverGraph | null
}

// Scale a per-node value over the coast nodes so its 90th percentile (of
// the positive values) is 1, clamped at 1; all zero stays all zero.
function normaliseToP90(field: Float32Array, coast: Int32Array): void {
  const values: number[] = []
  for (let i = 0; i < coast.length; i++) if (field[coast[i]] > 0) values.push(field[coast[i]])
  if (values.length === 0) return
  values.sort((a, b) => a - b)
  const p90 = values[Math.min(values.length - 1, Math.floor(0.9 * values.length))]
  if (p90 <= 0) return
  for (let i = 0; i < coast.length; i++) {
    const v = field[coast[i]] / p90
    field[coast[i]] = v > 1 ? 1 : v
  }
}

// The compass points of the relief's window: the raster's eight
// neighbours, a diagonal √2 steps out as it was.
const COMPASS: ReadonlyArray<readonly [number, number]> = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]

export function buildCoastGraph(input: CoastGraphInputs): CoastGraph {
  const { mesh, z, windE, windS, hardness, graph } = input
  const T = SURFACE_TUNING
  const domain = mesh.domain
  const slots = mesh.vertexSlots
  const metresPerUnit = domain.metresPerUnit
  const isSea = (v: number): boolean => z[v] <= SEA_LEVEL
  const distM = (a: number, b: number): number => Math.sqrt(domain.distanceSq(mesh.vx[a], mesh.vy[a], mesh.vx[b], mesh.vy[b])) * metresPerUnit
  const star = new Int32Array(256)

  // Coast nodes.
  const { shore: coast, isShore } = findShore(mesh, z)

  // The nearest coast node to `v` within `radiusM` along the mesh (a
  // breadth-first walk over the nodes within the radius, the nearest by
  // distance), or -1.
  const nearestCoast = (v: number, radiusM: number): number => {
    if (isShore[v]) return v
    const seen = new Set<number>([v])
    const queue = [v]
    let best = -1
    let bestM = Infinity
    for (let head = 0; head < queue.length; head++) {
      const n = mesh.neighbours(queue[head], star)
      for (let k = 0; k < n; k++) {
        const u = star[k]
        if (seen.has(u)) continue
        seen.add(u)
        const d = distM(v, u)
        if (d > radiusM) continue
        if (isShore[u] && d < bestM) { bestM = d; best = u }
        queue.push(u)
      }
    }
    return best
  }

  // Mouths: the last land node of every river reach that ends in the sea.
  const mouthAt = new Int32Array(slots).fill(-1)
  const deltaMouths: number[] = []
  if (graph) {
    const courseOf = new Map<number, boolean>()
    for (const c of graph.courses ?? []) courseOf.set(c.reach, c.lobeAges.length > 0)
    for (const r of graph.reaches) {
      const node = graph.nodes[r.to]
      if (node.kind !== 'mouth' || !isSea(node.cell)) continue
      const k = r.cellStart + r.cellCount - 2
      if (k < r.cellStart) continue
      // The reach's last land node need not be a coast node (the mesh's
      // last step may reach over one): the nearest within the radius.
      const last = nearestCoast(graph.cells[k], T.coastMouthReachM)
      if (last < 0) continue
      if (mouthAt[last] < 0 || graph.reaches[mouthAt[last]].dischargeOut < r.dischargeOut) mouthAt[last] = r.id
      if (courseOf.get(r.id)) deltaMouths.push(last)
    }
  }

  // Per-node attributes.
  const exposure = new Float32Array(slots)
  const relief = new Float32Array(slots)
  const hard = new Float32Array(slots)
  const supply = new Float32Array(slots)
  const fetchCap = Math.max(1, Math.round((T.coastFetchCapKm * 1000) / T.coastGraphFetchStepM))
  shoreExposure(mesh, z, coast, windE, windS, T.coastGraphFetchStepM / metresPerUnit, fetchCap, exposure)
  normaliseToP90(exposure, coast)
  const reliefStep = T.coastReliefStepM / metresPerUnit
  const at = { x: 0, y: 0 }
  const bary = new Float64Array(3)
  let hint = mesh.lastTri
  const groundAt = (x: number, y: number): number => {
    const t = mesh.locate(x, y, hint)
    hint = t
    mesh.barycentric(t, x, y, bary)
    return bary[0] * z[mesh.tris[3 * t]] + bary[1] * z[mesh.tris[3 * t + 1]] + bary[2] * z[mesh.tris[3 * t + 2]]
  }
  for (let i = 0; i < coast.length; i++) {
    const v = coast[i]
    let top = z[v]
    for (const [dx, dy] of COMPASS) {
      domain.advance(mesh.vx[v], mesh.vy[v], dx * reliefStep, dy * reliefStep, at)
      const g = groundAt(at.x, at.y)
      if (g > top) top = g
    }
    relief[v] = elevationToMeters(top - SEA_LEVEL)
    hard[v] = hardness ? hardness[v] : 1
  }

  // Sediment supply from the sea mouths, spread along the coast.
  const supplyReachM = T.coastSupplyReachKm * 1000
  const mouths: { v: number; load: number }[] = []
  if (graph) {
    for (let i = 0; i < coast.length; i++) {
      const v = coast[i]
      if (mouthAt[v] < 0) continue
      const r = graph.reaches[mouthAt[v]]
      if (r.sedimentM3 > 0) mouths.push({ v, load: r.sedimentM3 })
    }
  }
  if (mouths.length > 0) {
    for (let i = 0; i < coast.length; i++) {
      const v = coast[i]
      let s = 0
      for (const m of mouths) {
        const d = distM(v, m.v)
        if (d > supplyReachM) continue
        s += m.load * (1 - d / supplyReachM)
      }
      supply[v] = s
    }
    normaliseToP90(supply, coast)
  }

  // The type per node.
  const type = new Uint8Array(slots)
  const nearDelta = (v: number): boolean => {
    for (const m of deltaMouths) if (distM(v, m) <= T.coastDeltaReachM) return true
    return false
  }
  for (let i = 0; i < coast.length; i++) {
    const v = coast[i]
    let t: CoastType
    if (nearDelta(v)) t = 'delta'
    else if (exposure[v] < T.coastCalmExposure && relief[v] < T.coastMarshReliefM && supply[v] >= T.coastMarshSupply) t = 'marsh'
    else if (relief[v] >= T.coastCliffReliefM && exposure[v] >= T.coastCliffExposure && hard[v] <= T.coastCliffMaxK) t = 'cliff'
    else if (supply[v] >= T.coastBeachSupply || (exposure[v] >= T.coastCliffExposure && relief[v] < T.coastCliffReliefM)) t = 'beach'
    else t = 'rocky'
    type[v] = COAST_TYPE_CODE[t]
  }

  // Reaches: walks along the coast. Start at nodes with one coast
  // neighbour (the ends of a stretch) first, then anywhere unvisited; step
  // to the NEAREST unvisited coast neighbour (the raster stepped to a side
  // before a corner); cut at a mouth and once the walk is `coastReachM`
  // long.
  const visited = new Uint8Array(slots)
  const nodes: number[] = []
  const reaches: CoastReach[] = []
  const coastDegree = (v: number): number => {
    const n = mesh.neighbours(v, star)
    let d = 0
    for (let k = 0; k < n; k++) if (isShore[star[k]]) d++
    return d
  }
  const nextOf = (v: number): number => {
    const n = mesh.neighbours(v, star)
    let best = -1
    let bestM = Infinity
    for (let k = 0; k < n; k++) {
      const u = star[k]
      if (!isShore[u] || visited[u]) continue
      const d = distM(v, u)
      if (d < bestM) { bestM = d; best = u }
    }
    return best
  }
  const closeReach = (start: number, mouthReach: number): void => {
    const count = nodes.length - start
    if (count === 0) return
    let ex = 0, rl = 0, hd = 0, sp = 0
    const votes = new Int32Array(6)
    let m = 0
    for (let k = start; k < nodes.length; k++) {
      const v = nodes[k]
      ex += exposure[v]; rl += relief[v]; hd += hard[v]; sp += supply[v]
      votes[type[v]]++
      if (k > start) m += distM(nodes[k - 1], v)
    }
    let best = 1
    for (let t = 1; t < 6; t++) if (votes[t] > votes[best]) best = t
    reaches.push({
      id: reaches.length, nodeStart: start, nodeCount: count, lengthKm: m / 1000,
      exposure: ex / count, reliefM: rl / count, hardness: hd / count, supply: sp,
      type: CODE_TYPE[best], mouthReach,
    })
  }
  const walkFrom = (start: number): void => {
    let v = start
    let reachStart = nodes.length
    let walkedM = 0
    while (v >= 0) {
      visited[v] = 1
      if (nodes.length > reachStart) walkedM += distM(nodes[nodes.length - 1], v)
      nodes.push(v)
      const atMouth = mouthAt[v] >= 0
      if (atMouth || walkedM >= T.coastReachM) {
        closeReach(reachStart, atMouth ? mouthAt[v] : -1)
        reachStart = nodes.length
        walkedM = 0
      }
      v = nextOf(v)
    }
    closeReach(reachStart, -1)
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < coast.length; i++) {
      const v = coast[i]
      if (visited[v]) continue
      if (pass === 0 && coastDegree(v) !== 1) continue
      walkFrom(v)
    }
  }
  return { reaches, nodes: Int32Array.from(nodes), type }
}

// The invariants of a coast graph, as riverGraphInvariants: check name →
// violations. Every listed node a land node with a sea neighbour and a
// type, listed once, and each reach a walk along the mesh's edges.
export function coastGraphInvariants(coast: CoastGraph, mesh: PeriodicTriangulation, z: Float32Array): Record<string, number> {
  const out: Record<string, number> = { nodesOnCoast: 0, nodesOnce: 0, typeKnown: 0, reachesContiguous: 0 }
  const { isShore } = findShore(mesh, z)
  const seen = new Uint8Array(mesh.vertexSlots)
  const star = new Int32Array(256)
  for (const r of coast.reaches) {
    if (!(r.type in COAST_TYPE_CODE)) out.typeKnown++
    for (let k = 0; k < r.nodeCount; k++) {
      const v = coast.nodes[r.nodeStart + k]
      if (!isShore[v] || coast.type[v] === 0) out.nodesOnCoast++
      if (seen[v]) out.nodesOnce++
      seen[v] = 1
      if (k > 0) {
        const a = coast.nodes[r.nodeStart + k - 1]
        const n = mesh.neighbours(a, star)
        let adjacent = false
        for (let i = 0; i < n; i++) if (star[i] === v) adjacent = true
        if (!adjacent) out.reachesContiguous++
      }
    }
  }
  return out
}
