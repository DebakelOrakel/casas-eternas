import { METERS_PER_CELL } from '../core/mapConfig'
import {
  DEFAULT_ENGINE_PARAMS,
  ErosionEngine,
  type ErosionEngineParams,
  type ErosionForcing,
} from '../surface/erosionEngine'
import { expandActive, type EngineIndex } from '../surface/erosionEngineState'
import { PipelinedErosionEngine, type PipelineOptions, type WorkerLike } from '../surface/erosionEnginePool'
import type { PeriodicTriangulation } from './periodicDelaunay'

// EROSION ON THE MESH (ADAPTIVE_MESH_PLAN.md phase 4.2): the engine of
// surface/erosionEngine.ts over the triangulation. Nothing here is physics
// — the kernels are the engine's, in their finite-volume form — this file
// only builds the engine's graph INDEX from the mesh and adapts the
// engine's active-space result back to node arrays.
//
// The index (erosionEngineState.EngineIndex): a node's neighbours are its
// Delaunay star, counter-clockwise; a reach is the edge's length; the facet
// over a reach is the dual Voronoi edge, taken in the cotangent form
// (facet/length = (cot α + cot β)/2 over the two angles opposite the edge,
// non-negative on a Delaunay triangulation); a node's area is its Voronoi
// cell. Lengths are in domain units, and the reference length is the
// macro cell, METERS_PER_CELL — a domain unit IS a macro cell, so every
// length-bearing constant of the engine (settling lengths, diffusivity,
// the shelf band) reads on the mesh exactly as it does on the 2048
// raster. The frozen deep ocean and the shelf band follow the raster's
// rule with a distance in place of a step count: ocean is the largest
// facet-connected component of z ≤ 0, and the band is what lies within
// shelfBandKm of a non-ocean node along the edges.
//
// Full arrays (the initial z, the forcing, every result) are laid out by
// VERTEX SLOT (0..vertexSlots), dead slots ignored — the mesh's own
// layout, so a MeshState field passes straight through.

export interface MeshRouting {
  // Per vertex slot: the single-flow receiver (vertex id, -1 when none),
  // the flood-filled height, the accumulated drainage area in macro
  // cells (water-weighted when the forcing weights it).
  flowTarget: Int32Array
  filled: Float32Array
  accumulation: Float32Array
  // Vertex ids in the flood's pop order — a topological order of the
  // receiver graph; poppedCount entries valid.
  popOrder: Int32Array
  poppedCount: number
}

export interface MeshErosionResult {
  // The eroded heights per vertex slot (the initial array is not touched).
  z: Float32Array
  routing: MeshRouting
  // The ξ–q sediment flux through every node in the last iteration, m³.
  sedimentFlux: Float32Array
  erodedFluxM3: number
  exportedFluxM3: number
  index: EngineIndex
  // THE SEDIMENT RECORD of the run per vertex slot (phase 5.2, the
  // engine's per-node tallies): the fluvial cut and the deposit in m³,
  // and the deposit's provenance as products (m³ × craton oldness, m³ ×
  // source hardness) — the column's input (mesh/meshColumn.ts).
  cutM3: Float32Array
  depositM3: Float32Array
  depositCraton: Float32Array
  depositHard: Float32Array
}

export interface MeshErosionOptions {
  age: number
  routingEvery?: number
  params?: ErosionEngineParams
  pool?: { createWorker: () => WorkerLike } & PipelineOptions
  onProgress?: (fraction: number) => void
  // The node heights every ~eighth of the run (a copy), for a redraw —
  // the pass adapter's cadence (erosionPassV2.ts).
  onChunkComplete?: (z: Float32Array, chunk: number) => void | Promise<void>
  // Checked between chunks; true stops early with the partial result.
  shouldCancel?: () => boolean
}

const PROGRESS_CHUNKS = 8

// The engine index over the mesh for a terrain z (per vertex slot).
export function buildMeshEngineIndex(mesh: PeriodicTriangulation, z: Float32Array, params: ErosionEngineParams = DEFAULT_ENGINE_PARAMS, refM = METERS_PER_CELL): EngineIndex {
  const slots = mesh.vertexSlots
  const star = new Int32Array(256)
  // The world ocean: the largest component of z ≤ 0 over alive vertices.
  const label = new Int32Array(slots).fill(-1)
  const stack = new Int32Array(slots)
  const sizes: number[] = []
  for (let v = 0; v < slots; v++) {
    if (!mesh.vAlive[v] || z[v] > 0 || label[v] !== -1) continue
    const id = sizes.length
    let size = 0
    let sp = 0
    stack[sp++] = v
    label[v] = id
    while (sp > 0) {
      const i = stack[--sp]
      size++
      const n = mesh.neighbours(i, star)
      for (let k = 0; k < n; k++) {
        const u = star[k]
        if (z[u] <= 0 && label[u] === -1) {
          label[u] = id
          stack[sp++] = u
        }
      }
    }
    sizes.push(size)
  }
  let oceanId = -1
  for (let id = 0; id < sizes.length; id++) if (oceanId < 0 || sizes[id] > sizes[oceanId]) oceanId = id
  // The band: multi-source Dijkstra from every non-ocean node along the
  // edges, in domain units; ocean nodes beyond it are frozen.
  const frozen = new Uint8Array(slots)
  let frozenCount = 0
  if (oceanId >= 0) {
    const bandUnits = (params.shelfBandKm * 1000) / refM
    const dist = new Float64Array(slots).fill(Infinity)
    const heap: number[] = []
    const keys: number[] = []
    const push = (key: number, v: number): void => {
      let i = heap.length
      heap.push(v)
      keys.push(key)
      while (i > 0) {
        const p = (i - 1) >> 1
        if (keys[p] <= keys[i]) break
        ;[keys[p], keys[i]] = [keys[i], keys[p]]
        ;[heap[p], heap[i]] = [heap[i], heap[p]]
        i = p
      }
    }
    const pop = (): number => {
      const top = heap[0]
      const lastV = heap.pop() as number
      const lastK = keys.pop() as number
      if (heap.length > 0) {
        heap[0] = lastV
        keys[0] = lastK
        let i = 0
        for (;;) {
          const l = 2 * i + 1
          const r = l + 1
          let m = i
          if (l < heap.length && keys[l] < keys[m]) m = l
          if (r < heap.length && keys[r] < keys[m]) m = r
          if (m === i) break
          ;[keys[m], keys[i]] = [keys[i], keys[m]]
          ;[heap[m], heap[i]] = [heap[i], heap[m]]
          i = m
        }
      }
      return top
    }
    for (let v = 0; v < slots; v++) {
      if (!mesh.vAlive[v] || label[v] === oceanId) continue
      dist[v] = 0
      push(0, v)
    }
    while (heap.length > 0) {
      const key = keys[0]
      const v = pop()
      if (key > dist[v]) continue
      if (key >= bandUnits) continue
      const start = mesh.vEdge[v]
      let e = start
      do {
        const u = mesh.to(e)
        const d = key + mesh.edgeLength(e)
        if (d < dist[u]) {
          dist[u] = d
          push(d, u)
        }
        e = mesh.rotateCcw(e)
      } while (e !== start)
    }
    for (let v = 0; v < slots; v++) {
      if (mesh.vAlive[v] && label[v] === oceanId && dist[v] > bandUnits) {
        frozen[v] = 1
        frozenCount++
      }
    }
  }
  // Active indices in vertex order.
  let activeCount = 0
  for (let v = 0; v < slots; v++) if (mesh.vAlive[v] && !frozen[v]) activeCount++
  const active = new Int32Array(activeCount)
  const activeOf = new Int32Array(slots).fill(-1)
  let a = 0
  for (let v = 0; v < slots; v++) {
    if (!mesh.vAlive[v] || frozen[v]) continue
    activeOf[v] = a
    active[a++] = v
  }
  // The CSR tables.
  const nbrStart = new Int32Array(activeCount + 1)
  const outgoing = new Int32Array(256)
  let edgeCount = 0
  for (let k = 0; k < activeCount; k++) {
    nbrStart[k] = edgeCount
    const degree = mesh.degree(active[k])
    if (degree > 254) throw new Error(`buildMeshEngineIndex: degree ${degree} exceeds the slot range`)
    edgeCount += degree
  }
  nbrStart[activeCount] = edgeCount
  const nbr = new Int32Array(edgeCount)
  const edgeRev = new Int32Array(edgeCount).fill(-1)
  const lenRel = new Float32Array(edgeCount)
  const diffFactor = new Float32Array(edgeCount)
  const mfdFactor = new Float32Array(edgeCount)
  const areaRel = new Float32Array(activeCount)
  // Per active node the halfedge of each slot, to find reverse slots.
  const slotEdge = new Int32Array(edgeCount)
  const f = new Float64Array(6)
  for (let k = 0; k < activeCount; k++) {
    const v = active[k]
    const n = mesh.outgoing(v, outgoing)
    // The run starts at the neighbour with the smallest vertex id, so the
    // order every kernel sums in is a function of the mesh's vertex
    // numbering alone — not of which triangle happens to hold the
    // vertex's edge pointer, which a rebuild from a save need not repeat.
    let first = 0
    for (let s = 1; s < n; s++) if (mesh.to(outgoing[s]) < mesh.to(outgoing[first])) first = s
    const base = nbrStart[k]
    areaRel[k] = mesh.voronoiArea(v)
    for (let s = 0; s < n; s++) {
      const e = outgoing[(first + s) % n]
      const u = mesh.to(e)
      slotEdge[base + s] = e
      nbr[base + s] = activeOf[u]
      const len = mesh.edgeLength(e)
      lenRel[base + s] = len
      // cot α + cot β over the two triangles on the edge: the apex of e's
      // triangle and of its twin's.
      const cot = cotAtApex(mesh, e, f) + cotAtApex(mesh, mesh.twin[e], f)
      const geom = Math.max(0, cot / 2)
      diffFactor[base + s] = geom
      mfdFactor[base + s] = geom
    }
  }
  for (let k = 0; k < activeCount; k++) {
    const base = nbrStart[k]
    const end = nbrStart[k + 1]
    for (let s = base; s < end; s++) {
      const j = nbr[s]
      if (j < 0) continue
      const twin = mesh.twin[slotEdge[s]]
      const jBase = nbrStart[j]
      const jEnd = nbrStart[j + 1]
      for (let t = jBase; t < jEnd; t++) {
        if (slotEdge[t] === twin) {
          edgeRev[s] = t
          break
        }
      }
      if (edgeRev[s] < 0) throw new Error('buildMeshEngineIndex: reverse edge not found')
    }
  }
  return { kind: 'mesh', width: 0, height: 0, cellCount: slots, activeCount, active, activeOf, frozenCount, nbrStart, nbr, edgeCount, edgeRev, lenRel, diffFactor, mfdFactor, areaRel, refM }
}

// Cotangent of the angle at the apex of halfedge e's triangle (the corner
// opposite e).
function cotAtApex(mesh: PeriodicTriangulation, e: number, f: Float64Array): number {
  const t = mesh.triangleOf(e)
  const i = e - 3 * t
  mesh.frame(t, f)
  const ax = f[(2 * i) % 6]
  const ay = f[(2 * i + 1) % 6]
  const bx = f[(2 * i + 2) % 6]
  const by = f[(2 * i + 3) % 6]
  const px = f[(2 * i + 4) % 6]
  const py = f[(2 * i + 5) % 6]
  const ux = ax - px
  const uy = ay - py
  const wx = bx - px
  const wy = by - py
  const cross = ux * wy - uy * wx
  if (cross === 0) return 0
  return (ux * wx + uy * wy) / Math.abs(cross)
}

// Erodes the mesh's terrain: `initial` per vertex slot, the forcing per
// vertex slot (surface/erosionForcingFields.assembleNodeForcing). Pooled
// and pipelined when the caller supplies workers, single-threaded
// otherwise — the same kernels either way.
export async function runMeshErosion(mesh: PeriodicTriangulation, initial: Float32Array, forcing: ErosionForcing, options: MeshErosionOptions): Promise<MeshErosionResult> {
  const params = options.params ?? DEFAULT_ENGINE_PARAMS
  const index = buildMeshEngineIndex(mesh, initial, params)
  const chunkSize = Math.max(1, Math.ceil(options.age / PROGRESS_CHUNKS))
  const chunks = async (run: (step: number, done: number) => void, expand: () => Float32Array): Promise<void> => {
    let done = 0
    while (done < options.age) {
      const step = Math.min(chunkSize, options.age - done)
      run(step, done)
      done += step
      if (options.onChunkComplete) await options.onChunkComplete(expand(), done / chunkSize)
      if (options.shouldCancel?.()) break
    }
  }
  const report = (done: number, iteration: number): void => options.onProgress?.((done + iteration + 1) / options.age)
  if (options.pool) {
    const { createWorker, ...pipeline } = options.pool
    const engine = await PipelinedErosionEngine.create(0, 0, initial, forcing, createWorker, pipeline, params, index)
    try {
      await chunks((step, done) => engine.run(step, (iteration) => report(done, iteration)), () => engine.expandZ(initial))
      const popped = engine.finalizeRouting()
      return collect(engine.activeEngineViews, index, popped, initial, engine.erodedFluxM3, engine.exportedFluxM3)
    } finally {
      await engine.close()
    }
  }
  const engine = ErosionEngine.onIndex(index, initial, forcing, params)
  const routingEvery = options.routingEvery ?? 4
  await chunks((step, done) => engine.run(step, routingEvery, (iteration) => report(done, iteration)), () => engine.expandZ(initial))
  engine.refreshRouting()
  return collect(engine.views, index, engine.poppedCount, initial, engine.erodedFluxM3, engine.exportedFluxM3)
}

function collect(views: { z: Float32Array; filled: Float32Array; flowTarget: Int32Array; accumulation: Float32Array; popOrder: Int32Array; flux: Float32Array; cutVolume: Float32Array; depositVolume: Float32Array; depositCraton: Float32Array; depositHard: Float32Array }, index: EngineIndex, popped: number, initial: Float32Array, eroded: number, exported: number): MeshErosionResult {
  const { active, activeCount } = index
  const flowTarget = new Int32Array(index.cellCount).fill(-1)
  for (let a = 0; a < activeCount; a++) {
    const t = views.flowTarget[a]
    if (t >= 0) flowTarget[active[a]] = active[t]
  }
  const popOrder = new Int32Array(popped)
  for (let i = 0; i < popped; i++) popOrder[i] = active[views.popOrder[i]]
  return {
    z: expandActive(index, views.z, initial),
    routing: {
      flowTarget,
      filled: expandActive(index, views.filled, initial),
      accumulation: expandActive(index, views.accumulation, 0),
      popOrder,
      poppedCount: popped,
    },
    sedimentFlux: expandActive(index, views.flux, 0),
    erodedFluxM3: eroded,
    exportedFluxM3: exported,
    index,
    cutM3: expandActive(index, views.cutVolume, 0),
    depositM3: expandActive(index, views.depositVolume, 0),
    depositCraton: expandActive(index, views.depositCraton, 0),
    depositHard: expandActive(index, views.depositHard, 0),
  }
}
