import { SEA_LEVEL, elevationToMeters } from '../elevation/elevationScale'
import { SURFACE_TUNING } from './surfaceTuneParams'
import type { FlowSubstrate } from './flowSubstrate'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'
import type { RiverGraph } from './riverGraph'
import { detAtan2, detCos, detSin } from '../core/detMath'
import { globeFrame } from '../core/domain'

// SEDIMENT BASINS AS FEATURES (ADAPTIVE_MESH_PLAN.md F1, decision 4a of
// adaptive-mesh.md): where the erosion pass left material — the
// floodplains, fans and marine wedges the ξ–q routing deposited — as a
// list with provenance, so the resource layer can ask "what rock is this
// sediment made of" without the coupled model's layers (phase 5).
//
// On the terrain mesh since DEC-0036 phase 7b (the 2048 raster before):
// a basin is a connected set of nodes where the eroded terrain stands at
// least `sedimentBasinMinThicknessM` above the terrain the last epoch's
// erosion started from, covering at least `sedimentBasinMinAreaKm2`;
// marine when most of its area lies under the sea. Its PROVENANCE is the
// rock of the catchments that feed it: every river reach whose mouth or
// last node lies in the basin contributes its catchment, and over those
// nodes the craton oldness (crust/raftField, 1 = ancient core) and the
// erodibility K are averaged — old hard crust shedding into a basin is
// what makes placer gold and banded iron plausible there. Basins no river
// reaches (marine wedges off a cliff coast, deposits of hillslope creep)
// carry the mean over their own nodes.
//
// Every sum is by area — a node weighs its Voronoi cell, in km² through
// the Domain's metres per unit — so a basin's area, volume and means are
// the world's on either shape; `nodes` is the count.
export interface SedimentBasin {
  id: number
  kind: 'alluvial' | 'marine'
  nodes: number
  areaKm2: number
  volumeKm3: number
  meanThicknessM: number
  maxThicknessM: number
  // Centroid in world units (texel coordinates): the torus's circular mean
  // per axis, the sphere's mean position on the globe, both by area.
  x: number
  y: number
  // The river reaches ending in this basin.
  mouthReaches: number[]
  // Provenance over the feeding catchments (own nodes when none); the
  // catchment's area.
  catchmentKm2: number
  cratonAge: number
  hardness: number
}

export interface SedimentBasinInputs {
  mesh: PeriodicTriangulation
  // Heights per slot, elevation units: before the last epoch's erosion
  // (CoupledTerrain.preErosionZ) and now.
  before: Float32Array
  after: Float32Array
  // The routing the graph was built on (the mesh's flow substrate) and the
  // graph itself, or null (no provenance from catchments).
  substrate: FlowSubstrate
  graph: RiverGraph | null
  // Coarse fields read at the nodes (the forcing's raster, nearest cell),
  // optional.
  cratonAge?: ArrayLike<number>
  hardness?: ArrayLike<number>
}

export interface SedimentBasinResult {
  basins: SedimentBasin[]
  // Basin id + 1 per vertex slot, 0 outside every basin.
  label: Int32Array
}

export function findSedimentBasins(input: SedimentBasinInputs): SedimentBasinResult {
  const { mesh, before, after, substrate: sub, graph } = input
  const { domain } = mesh
  const n = mesh.vertexSlots
  const km2PerUnit = (domain.metresPerUnit / 1000) * (domain.metresPerUnit / 1000)
  const areaOf = (v: number): number => sub.area(v) * km2PerUnit
  const width = domain.width
  const height = domain.height
  // The centroid on the globe when the domain is one (Domain.noise names the
  // space its points lie in): the mean of the nodes' positions, put back
  // on the surface. The torus's points have no such space, and keep the
  // circular mean per axis.
  const globe = domain.noise.kind === 'globe' ? domain.noise : null
  const frame = globeFrame()
  const centre = { x: 0, y: 0 }
  const minThickness = SURFACE_TUNING.sedimentBasinMinThicknessM
  const thickness = new Float32Array(n)
  for (let v = 0; v < n; v++) {
    if (!mesh.vAlive[v]) continue
    const t = elevationToMeters(after[v] - before[v])
    if (t >= minThickness) thickness[v] = t
  }
  const field = (f: ArrayLike<number> | undefined, v: number, absent: number): number => (f ? f[v] : absent)
  // Components over the mesh's edges.
  const label = new Int32Array(n)
  const star = new Int32Array(256)
  const stack: number[] = []
  const basins: SedimentBasin[] = []
  for (let s = 0; s < n; s++) {
    if (thickness[s] <= 0 || label[s] !== 0) continue
    const id = basins.length + 1
    label[s] = id
    stack.push(s)
    const members: number[] = []
    while (stack.length) {
      const v = stack.pop()!
      members.push(v)
      const k = mesh.neighbours(v, star)
      for (let i = 0; i < k; i++) {
        const u = star[i]
        if (thickness[u] > 0 && label[u] === 0) {
          label[u] = id
          stack.push(u)
        }
      }
    }
    let area = 0
    for (const v of members) area += areaOf(v)
    if (area < SURFACE_TUNING.sedimentBasinMinAreaKm2) {
      for (const v of members) label[v] = -1
      continue
    }
    let volume = 0
    let max = 0
    let marine = 0
    let sx = 0, sy = 0, cx = 0, cy = 0
    let gx = 0, gy = 0, gz = 0
    let craton = 0, hard = 0
    for (const v of members) {
      const t = thickness[v]
      const w = areaOf(v)
      volume += t * w
      if (t > max) max = t
      if (after[v] <= SEA_LEVEL) marine += w
      const x = mesh.vx[v]
      const y = mesh.vy[v]
      if (globe) {
        globe.frame(x, y, frame)
        gx += frame.px * w; gy += frame.py * w; gz += frame.pz * w
      } else {
        const ax = (x / width) * Math.PI * 2
        const ay = (y / height) * Math.PI * 2
        sx += detSin(ax) * w; cx += detCos(ax) * w; sy += detSin(ay) * w; cy += detCos(ay) * w
      }
      craton += Math.max(0, field(input.cratonAge, v, 0)) * w
      hard += field(input.hardness, v, 1) * w
    }
    let mx = ((detAtan2(sx, cx) / (Math.PI * 2)) + 1) % 1
    let my = ((detAtan2(sy, cy) / (Math.PI * 2)) + 1) % 1
    if (globe) {
      globe.locate(gx, gy, gz, centre)
      mx = centre.x / width
      my = centre.y / height
    }
    basins.push({
      id: id - 1,
      kind: marine * 2 > area ? 'marine' : 'alluvial',
      nodes: members.length,
      areaKm2: area,
      // m × km² → km³.
      volumeKm3: volume / 1000,
      meanThicknessM: volume / area,
      maxThicknessM: max,
      x: mx * width,
      y: my * height,
      mouthReaches: [],
      catchmentKm2: area,
      cratonAge: craton / area,
      hardness: hard / area,
    })
  }
  // The components too small to be a basin were marked −1 so the search
  // above did not walk them again; outside every basin is 0.
  for (let v = 0; v < n; v++) if (label[v] < 0) label[v] = 0

  // Provenance: label every land node by the graph mouth it drains to
  // (popOrder forward hands a node its receiver's label), then sum the
  // fields per mouth by area and hand each basin its mouths' catchments.
  // The graph's cells are this mesh's vertex ids.
  if (graph && basins.length > 0) {
    const { flowTarget, popOrder, poppedCount } = sub
    const mouthAt = new Int32Array(n).fill(-1)
    for (const node of graph.nodes) if (node.kind === 'mouth') mouthAt[node.cell] = node.id
    const drainsTo = new Int32Array(n).fill(-1)
    for (let k = 0; k < poppedCount; k++) {
      const v = popOrder[k]
      if (after[v] <= SEA_LEVEL) continue
      const t = flowTarget[v]
      if (t < 0) { drainsTo[v] = mouthAt[v]; continue }
      drainsTo[v] = after[t] > SEA_LEVEL && mouthAt[t] < 0 ? drainsTo[t] : mouthAt[t]
    }
    const count = new Float64Array(graph.nodes.length)
    const cratonSum = new Float64Array(graph.nodes.length)
    const hardSum = new Float64Array(graph.nodes.length)
    for (let v = 0; v < n; v++) {
      const m = drainsTo[v]
      if (m < 0) continue
      const w = areaOf(v)
      count[m] += w
      cratonSum[m] += Math.max(0, field(input.cratonAge, v, 0)) * w
      hardSum[m] += field(input.hardness, v, 1) * w
    }
    const fed = basins.map(() => ({ area: 0, craton: 0, hard: 0 }))
    for (const r of graph.reaches) {
      const node = graph.nodes[r.to]
      if (node.kind !== 'mouth') continue
      const k = r.cellStart + r.cellCount - 2
      const b = label[node.cell] || (k >= r.cellStart ? label[graph.cells[k]] : 0)
      if (!b) continue
      basins[b - 1].mouthReaches.push(r.id)
      fed[b - 1].area += count[node.id]
      fed[b - 1].craton += cratonSum[node.id]
      fed[b - 1].hard += hardSum[node.id]
    }
    for (let i = 0; i < basins.length; i++) {
      if (fed[i].area <= 0) continue
      basins[i].catchmentKm2 = fed[i].area
      basins[i].cratonAge = fed[i].craton / fed[i].area
      basins[i].hardness = fed[i].hard / fed[i].area
    }
  }
  return { basins, label }
}

// Invariants, as the graphs': check name → violations.
export function sedimentBasinInvariants(result: SedimentBasinResult, before: Float32Array, after: Float32Array): Record<string, number> {
  const out: Record<string, number> = { thicknessPositive: 0, labelsMatch: 0, finite: 0 }
  const counts = new Int32Array(result.basins.length + 1)
  for (let v = 0; v < result.label.length; v++) {
    const b = result.label[v]
    if (b === 0) continue
    counts[b]++
    if (after[v] - before[v] <= 0) out.thicknessPositive++
  }
  for (const b of result.basins) {
    if (counts[b.id + 1] !== b.nodes) out.labelsMatch++
    if (!Number.isFinite(b.volumeKm3) || !Number.isFinite(b.cratonAge) || !Number.isFinite(b.hardness) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) out.finite++
  }
  return out
}
