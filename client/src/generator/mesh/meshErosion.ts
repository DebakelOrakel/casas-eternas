import {
  DEFAULT_ENGINE_PARAMS,
  type ErosionEngineParams,
} from '../surface/erosionEngine'
import { type EngineIndex } from '../surface/erosionEngineState'
import { MinHeap } from '../core/minHeap'
import type { PeriodicTriangulation } from './periodicDelaunay'

// The engine index over the mesh for a terrain z (per vertex slot).
//
// `reuse`: an index built on this same mesh, unchanged since (the epoch's
// erosion index, for the routing after it). The index is a function of the
// mesh and of which nodes are frozen, so where z freezes the same nodes it
// IS that index, and is returned as it is — only the frozen set is worked
// out again. A second full build per history epoch was a twentieth of its
// time (profiled 2026-10-04).
export function buildMeshEngineIndex(mesh: PeriodicTriangulation, z: Float32Array, params: ErosionEngineParams = DEFAULT_ENGINE_PARAMS, refM = mesh.domain.metresPerUnit, extraFrozen?: Uint8Array, reuse?: EngineIndex): EngineIndex {
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
    // The shared binary heap (core/minHeap.ts): the same comparisons and
    // placements as the arrays this kept itself, without their swaps.
    const heap = new MinHeap(slots)
    for (let v = 0; v < slots; v++) {
      if (!mesh.vAlive[v] || label[v] === oceanId) continue
      dist[v] = 0
      heap.push(0, v)
    }
    while (heap.length > 0) {
      heap.pop()
      const key = heap.poppedKey
      const v = heap.poppedIndex
      if (key > dist[v]) continue
      if (key >= bandUnits) continue
      const start = mesh.vEdge[v]
      let e = start
      do {
        const u = mesh.to(e)
        const d = key + mesh.edgeLength(e)
        if (d < dist[u]) {
          dist[u] = d
          heap.push(d, u)
        }
        e = mesh.rotateCcw(e)
      } while (e !== start)
    }
    // The first ring of ocean nodes around land is ALWAYS active, whatever
    // its distance: the deep ocean's nodes stand oceanSpacingM × budget
    // apart (160 km at budget 4), farther than the band is wide, so a
    // coast that drops straight into deep water had every ocean neighbour
    // frozen — a wall the flood could not drain through, and the coast
    // filled to its next land spill as a "lake" with a pour point on the
    // sea floor (134 of 5256 coastal nodes on seed 985192350, 2026-09-27;
    // the raster's band is at least one D8 step for the same reason).
    for (let v = 0; v < slots; v++) {
      if (!mesh.vAlive[v] || label[v] !== oceanId || dist[v] <= bandUnits) continue
      let touchesLand = false
      const start = mesh.vEdge[v]
      let e = start
      do {
        if (label[mesh.to(e)] !== oceanId) { touchesLand = true; break }
        e = mesh.rotateCcw(e)
      } while (e !== start)
      if (touchesLand) continue
      frozen[v] = 1
      frozenCount++
    }
  }
  if (extraFrozen) {
    for (let v = 0; v < slots; v++) {
      if (!mesh.vAlive[v] || frozen[v] || !extraFrozen[v]) continue
      frozen[v] = 1
      frozenCount++
    }
  }
  if (reuse && reuse.kind === 'mesh' && reuse.cellCount === slots && reuse.refM === refM && reuse.frozenCount === frozenCount) {
    let same = true
    for (let v = 0; v < slots && same; v++) same = (mesh.vAlive[v] && !frozen[v]) === (reuse.activeOf[v] >= 0)
    if (same) return reuse
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
  // Per active node the halfedge of each slot, and per halfedge its slot:
  // the reverse slot is the twin's (a scan of the neighbour's slots for it
  // was the hottest line of the index, profiled 2026-10-04).
  const slotEdge = new Int32Array(edgeCount)
  const slotOfEdge = new Int32Array(mesh.twin.length).fill(-1)
  // cot at each halfedge's apex, once: an edge's two slots both need both.
  // Kept with the mesh while its geometry is unchanged (apexCotangents).
  const cotAt = apexCotangent(mesh)
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
      slotOfEdge[e] = base + s
      nbr[base + s] = activeOf[u]
      const len = mesh.edgeLength(e)
      lenRel[base + s] = len
      // cot α + cot β over the two triangles on the edge: the apex of e's
      // triangle and of its twin's.
      const cot = cotAt(e) + cotAt(mesh.twin[e])
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
      const t = slotOfEdge[mesh.twin[slotEdge[s]]]
      if (t >= nbrStart[j] && t < nbrStart[j + 1]) edgeRev[s] = t
      if (edgeRev[s] < 0) throw new Error('buildMeshEngineIndex: reverse edge not found')
    }
  }
  return { kind: 'mesh', width: 0, height: 0, cellCount: slots, activeCount, active, activeOf, frozenCount, nbrStart, nbr, edgeCount, edgeRev, lenRel, diffFactor, mfdFactor, areaRel, refM }
}

// The cotangents at the halfedges' apexes as far as computed (NaN: not
// yet), kept per mesh for as long as its geometryVersion stands: the
// epoch's routing builds its index on the mesh the erosion's index was
// built on, a frozen set apart, and its cotangents were half of that
// second build on the sphere (profiled 2026-10-15). A kept value is the
// bits cotAtApex gives again.
const apexCotCache = new WeakMap<PeriodicTriangulation, { version: number; cot: Float64Array }>()

function apexCotangents(mesh: PeriodicTriangulation): Float64Array {
  const kept = apexCotCache.get(mesh)
  if (kept && kept.version === mesh.geometryVersion && kept.cot.length === mesh.twin.length) return kept.cot
  const cot = new Float64Array(mesh.twin.length).fill(NaN)
  apexCotCache.set(mesh, { version: mesh.geometryVersion, cot })
  return cot
}

// cotAtApex through that cache, for a sweep over the mesh while it does not
// change: a triangle's three at once, from one frame (the frame was most
// of the engine index's time on the sphere, three per triangle).
export function apexCotangent(mesh: PeriodicTriangulation): (e: number) => number {
  const cotOf = apexCotangents(mesh)
  const f = new Float64Array(6)
  return (e) => {
    let c = cotOf[e]
    if (Number.isNaN(c)) {
      const t = mesh.triangleOf(e)
      mesh.frame(t, f)
      for (let i = 0; i < 3; i++) cotOf[3 * t + i] = cotInFrame(f, i)
      c = cotOf[e]
    }
    return c
  }
}

// cotAtApex for the halfedge i (0..2) of a triangle whose frame `f` holds.
function cotInFrame(f: Float64Array, i: number): number {
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
