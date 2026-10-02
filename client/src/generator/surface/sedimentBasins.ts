import { SEA_LEVEL, elevationToMeters } from '../elevation/elevationScale'
import { SURFACE_TUNING } from './surfaceTuneParams'
import type { FlowRouting } from './flowRouting'
import { rasterCellAt, type RiverGraph } from './riverGraph'
import { detAtan2, detCos, detSin } from '../core/detMath'

// SEDIMENT BASINS AS FEATURES (ADAPTIVE_MESH_PLAN.md F1, decision 4a of
// adaptive-mesh.md): where the erosion pass left material — the
// floodplains, fans and marine wedges the ξ–q routing deposited — as a
// list with provenance, so the resource layer can ask "what rock is this
// sediment made of" without the coupled model's layers (phase 5).
//
// A basin is an 8-connected region where the eroded terrain stands at
// least `sedimentBasinMinThicknessM` above the pre-erosion terrain, of at
// least `sedimentBasinMinCells` cells; marine when most of it lies under
// the sea. Its PROVENANCE is the rock of the catchments that feed it: every
// river reach whose mouth or last cell lies in the basin contributes its
// catchment, and over those cells the craton oldness (crust/raftField, 1 =
// ancient core) and the erodibility K are averaged — old hard crust
// shedding into a basin is what makes placer gold and banded iron
// plausible there. Basins no river reaches (marine wedges off a cliff
// coast, deposits of hillslope creep) carry the mean over their own cells.
export interface SedimentBasin {
  id: number
  kind: 'alluvial' | 'marine'
  cells: number
  areaKm2: number
  volumeKm3: number
  meanThicknessM: number
  maxThicknessM: number
  // Centroid in texel coordinates (toroidal mean).
  x: number
  y: number
  // The river reaches ending in this basin.
  mouthReaches: number[]
  // Provenance over the feeding catchments (own cells when none).
  catchmentCells: number
  cratonAge: number
  hardness: number
}

export interface SedimentBasinInputs {
  before: Float32Array
  after: Float32Array
  width: number
  height: number
  routing: FlowRouting
  graph: RiverGraph | null
  cellM: number
  // Coarse fields (climate resolution), optional.
  cratonAge?: Float32Array
  hardness?: Float32Array
  coarseResX?: number
  coarseResY?: number
}

export interface SedimentBasinResult {
  basins: SedimentBasin[]
  // Basin id + 1 per cell, 0 outside every basin.
  label: Uint16Array
}

export function findSedimentBasins(input: SedimentBasinInputs): SedimentBasinResult {
  const { before, after, width, height, routing, graph, cellM } = input
  const n = width * height
  const minThickness = SURFACE_TUNING.sedimentBasinMinThicknessM
  const thickness = new Float32Array(n)
  for (let c = 0; c < n; c++) {
    const t = elevationToMeters(after[c] - before[c])
    if (t >= minThickness) thickness[c] = t
  }
  // Components.
  const label = new Uint16Array(n)
  const at = (x: number, y: number): number => ((y + height) % height) * width + ((x + width) % width)
  const stack: number[] = []
  const basins: SedimentBasin[] = []
  const cellAreaKm2 = (cellM / 1000) * (cellM / 1000)
  const coarse = (field: Float32Array | undefined, c: number): number => {
    if (!field || !input.coarseResX || !input.coarseResY) return field ? 1 : 0
    const x = c % width
    const y = (c - x) / width
    const gx = Math.min(input.coarseResX - 1, Math.floor((x / width) * input.coarseResX))
    const gy = Math.min(input.coarseResY - 1, Math.floor((y / height) * input.coarseResY))
    return field[gy * input.coarseResX + gx]
  }
  for (let s = 0; s < n; s++) {
    if (thickness[s] <= 0 || label[s] !== 0) continue
    const id = basins.length + 1
    if (id > 65535) break
    label[s] = id
    stack.push(s)
    const members: number[] = []
    while (stack.length) {
      const c = stack.pop()!
      members.push(c)
      const x = c % width
      const y = (c - x) / width
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nb = at(x + dx, y + dy)
          if (thickness[nb] > 0 && label[nb] === 0) {
            label[nb] = id
            stack.push(nb)
          }
        }
      }
    }
    if (members.length < SURFACE_TUNING.sedimentBasinMinCells) {
      for (const c of members) label[c] = 0
      continue
    }
    let volume = 0
    let max = 0
    let marine = 0
    let sx = 0, sy = 0, cx = 0, cy = 0
    let craton = 0, hard = 0
    for (const c of members) {
      const t = thickness[c]
      volume += t
      if (t > max) max = t
      if (after[c] <= SEA_LEVEL) marine++
      const x = c % width
      const y = (c - x) / width
      const ax = (x / width) * Math.PI * 2
      const ay = (y / height) * Math.PI * 2
      sx += detSin(ax); cx += detCos(ax); sy += detSin(ay); cy += detCos(ay)
      craton += coarse(input.cratonAge, c)
      hard += coarse(input.hardness, c)
    }
    const mx = ((detAtan2(sx, cx) / (Math.PI * 2)) + 1) % 1
    const my = ((detAtan2(sy, cy) / (Math.PI * 2)) + 1) % 1
    basins.push({
      id: id - 1,
      kind: marine * 2 > members.length ? 'marine' : 'alluvial',
      cells: members.length,
      areaKm2: members.length * cellAreaKm2,
      volumeKm3: (volume * cellAreaKm2) / 1000,
      meanThicknessM: volume / members.length,
      maxThicknessM: max,
      x: mx * width,
      y: my * height,
      mouthReaches: [],
      catchmentCells: members.length,
      cratonAge: craton / members.length,
      hardness: hard / members.length,
    })
  }

  // Provenance: label every land cell by the graph mouth it drains to
  // (popOrder forward hands a cell its receiver's label), then sum the
  // coarse fields per mouth and hand each basin its mouths' catchments.
  if (graph && basins.length > 0) {
    const { flowTarget, popOrder, poppedCount } = routing
    // Graph places as raster cells: the graph may be the mesh's (phase
    // 4.3), so its ids are read through their positions.
    const mouthAt = new Int32Array(n).fill(-1)
    for (const node of graph.nodes) if (node.kind === 'mouth') mouthAt[rasterCellAt(node.x, node.y, width, height)] = node.id
    const drainsTo = new Int32Array(n).fill(-1)
    for (let k = 0; k < poppedCount; k++) {
      const c = popOrder[k]
      if (after[c] <= SEA_LEVEL) continue
      const t = flowTarget[c]
      if (t < 0) { drainsTo[c] = mouthAt[c]; continue }
      drainsTo[c] = after[t] > SEA_LEVEL && mouthAt[t] < 0 ? drainsTo[t] : mouthAt[t]
    }
    const count = new Float64Array(graph.nodes.length)
    const cratonSum = new Float64Array(graph.nodes.length)
    const hardSum = new Float64Array(graph.nodes.length)
    for (let c = 0; c < n; c++) {
      const m = drainsTo[c]
      if (m < 0) continue
      count[m]++
      cratonSum[m] += coarse(input.cratonAge, c)
      hardSum[m] += coarse(input.hardness, c)
    }
    const fed = basins.map(() => ({ cells: 0, craton: 0, hard: 0 }))
    for (const r of graph.reaches) {
      const node = graph.nodes[r.to]
      if (node.kind !== 'mouth') continue
      const k = r.cellStart + r.cellCount - 2
      const last = k >= r.cellStart ? rasterCellAt(graph.cellX[k], graph.cellY[k], width, height) : undefined
      const b = label[rasterCellAt(node.x, node.y, width, height)] || (last !== undefined ? label[last] : 0)
      if (!b) continue
      basins[b - 1].mouthReaches.push(r.id)
      fed[b - 1].cells += count[node.id]
      fed[b - 1].craton += cratonSum[node.id]
      fed[b - 1].hard += hardSum[node.id]
    }
    for (let i = 0; i < basins.length; i++) {
      if (fed[i].cells <= 0) continue
      basins[i].catchmentCells = fed[i].cells
      basins[i].cratonAge = fed[i].craton / fed[i].cells
      basins[i].hardness = fed[i].hard / fed[i].cells
    }
  }
  return { basins, label }
}

// Invariants, as the graphs': check name → violations.
export function sedimentBasinInvariants(result: SedimentBasinResult, before: Float32Array, after: Float32Array): Record<string, number> {
  const out: Record<string, number> = { thicknessPositive: 0, labelsMatch: 0, finite: 0 }
  const counts = new Int32Array(result.basins.length + 1)
  for (let c = 0; c < result.label.length; c++) {
    const b = result.label[c]
    if (b === 0) continue
    counts[b]++
    if (after[c] - before[c] <= 0) out.thicknessPositive++
  }
  for (const b of result.basins) {
    if (counts[b.id + 1] !== b.cells) out.labelsMatch++
    if (!Number.isFinite(b.volumeKm3) || !Number.isFinite(b.cratonAge) || !Number.isFinite(b.hardness) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) out.finite++
  }
  return out
}
