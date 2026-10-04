import type { Domain } from '../core/domain'
import { hilbertOrder } from './hilbert'
import { buildFromTriangles, PeriodicTriangulation } from './periodicDelaunay'

// THE MESH AS BYTES (ADAPTIVE_MESH_PLAN.md phase 4.3: "the save is the
// mesh"). Two files: the node positions (f32 pairs) and the connectivity —
// per node, its neighbours counter-clockwise, as zigzag varint DELTAS from
// the node's own id. Nodes are numbered in HILBERT order before writing,
// so a neighbour's id is close to the node's own and a delta is one or two
// bytes; the triangulation comes back from the neighbour lists (a triangle
// is emitted once, at its smallest vertex).
//
// Why the connectivity is stored rather than rebuilt from the points: the
// Delaunay triangulation of the points is unique except where four are
// co-circular — and the bootstrap lattice's quads are exactly that, so a
// rebuild could flip a deep-ocean diagonal the session had the other way,
// and "reload, then erode" would not be "erode" any more. Twelve-odd bytes
// per node is the price of a mesh that reloads bit for bit.
//
// CANONICAL FORM: `compactMesh` renumbers the vertices in Hilbert order and
// rebuilds the triangulation through the same encode → decode the save
// goes through, so the session's mesh after a run IS the mesh a reload
// produces (positions are float32 already, periodicDelaunay.ts). The
// engine's node order and every summation in it then depend on the vertex
// numbering alone (meshErosion.ts starts each star at the smallest id),
// which is what makes a continued run and a reloaded run the same bytes.

export interface SerializedMesh {
  count: number
  // x, y interleaved, domain units.
  nodes: Float32Array
  connectivity: Uint8Array
}

// A mesh as a save carries it (`mesh/` in the archive): the codec's bytes,
// the heights and the sediment column. Here rather than in world/query,
// which reads it from the archive: the bake (pipeline/meshBakeStage) takes
// it, and the generator does not import world/.
export interface SavedMesh extends SerializedMesh {
  z: Float32Array
  // The sediment column's bytes (formatVersion 4, mesh/meshColumn.ts);
  // undefined in a save from before it.
  column?: Uint8Array
}

// Vertex ids of the mesh in Hilbert order (alive vertices only).
export function hilbertVertexOrder(mesh: PeriodicTriangulation): Int32Array {
  const alive: number[] = []
  for (let v = 0; v < mesh.vertexSlots; v++) if (mesh.vAlive[v]) alive.push(v)
  const xs = new Float64Array(alive.length)
  const ys = new Float64Array(alive.length)
  for (let i = 0; i < alive.length; i++) {
    xs[i] = mesh.vx[alive[i]]
    ys[i] = mesh.vy[alive[i]]
  }
  const order = hilbertOrder(xs, ys, alive.length, mesh.domain.width, mesh.domain.height)
  const result = new Int32Array(alive.length)
  for (let i = 0; i < alive.length; i++) result[i] = alive[order[i]]
  return result
}

// Vertex `v`'s neighbours counter-clockwise as new ids into `out`, starting
// at the smallest, so the list is a function of the numbering, not of the
// edge pointer: what the codec writes per node, and what the compaction
// builds from (one function, so the two cannot drift apart).
function canonicalStar(mesh: PeriodicTriangulation, v: number, newId: Int32Array, star: Int32Array, out: Int32Array): number {
  const n = mesh.neighbours(v, star)
  let first = 0
  for (let s = 1; s < n; s++) if (newId[star[s]] < newId[star[first]]) first = s
  for (let s = 0; s < n; s++) out[s] = newId[star[(first + s) % n]]
  return n
}

const newIds = (mesh: PeriodicTriangulation, order: Int32Array): Int32Array => {
  const newId = new Int32Array(mesh.vertexSlots).fill(-1)
  for (let i = 0; i < order.length; i++) newId[order[i]] = i
  return newId
}

// Encodes the mesh with vertex i of the output being `order[i]` of the
// input.
export function encodeMesh(mesh: PeriodicTriangulation, order: Int32Array): SerializedMesh {
  const count = order.length
  const newId = newIds(mesh, order)
  const nodes = new Float32Array(count * 2)
  const bytes: number[] = []
  const star = new Int32Array(256)
  const ring = new Int32Array(256)
  for (let i = 0; i < count; i++) {
    const v = order[i]
    nodes[2 * i] = mesh.vx[v]
    nodes[2 * i + 1] = mesh.vy[v]
    const n = canonicalStar(mesh, v, newId, star, ring)
    writeVarint(bytes, n)
    for (let s = 0; s < n; s++) writeVarint(bytes, zigzag(ring[s] - i))
  }
  return { count, nodes, connectivity: Uint8Array.from(bytes) }
}

// The triangulation from the bytes. Vertex i of the result is node i of
// the encoding.
export function decodeMesh(domain: Domain, serial: SerializedMesh): PeriodicTriangulation {
  const { count, nodes, connectivity } = serial
  const xs = new Float64Array(count)
  const ys = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    xs[i] = nodes[2 * i]
    ys[i] = nodes[2 * i + 1]
  }
  const cursor = { at: 0 }
  const tris: number[] = []
  const star: number[] = []
  for (let v = 0; v < count; v++) {
    const n = readVarint(connectivity, cursor)
    star.length = 0
    for (let s = 0; s < n; s++) star.push(v + unzigzag(readVarint(connectivity, cursor)))
    for (let s = 0; s < n; s++) {
      const a = star[s]
      const b = star[(s + 1) % n]
      if (v < a && v < b) tris.push(v, a, b)
    }
  }
  return buildFromTriangles(domain, xs, ys, count, Int32Array.from(tris))
}

// The mesh in canonical form: Hilbert-numbered, rebuilt as the codec
// rebuilds it. Returns the new mesh and, per new vertex, the old vertex id
// — the permutation for every per-node field (`permute`).
//
// decodeMesh(encodeMesh(mesh, order)) without the bytes: the same
// positions, the same canonical stars, the triangles emitted in the same
// order (each at its smallest vertex), so buildFromTriangles makes the
// same mesh. Writing and reading the varints back was over a third of the
// compaction, itself a fourteenth of a history epoch (profiled 2026-10-04).
export function compactMesh(mesh: PeriodicTriangulation): { mesh: PeriodicTriangulation; order: Int32Array } {
  const order = hilbertVertexOrder(mesh)
  const count = order.length
  const newId = newIds(mesh, order)
  const xs = new Float64Array(count)
  const ys = new Float64Array(count)
  const star = new Int32Array(256)
  const ring = new Int32Array(256)
  let tris = new Int32Array(count * 6 + 3)
  let length = 0
  for (let i = 0; i < count; i++) {
    const v = order[i]
    // Through float32, as the codec's node file carries them.
    xs[i] = Math.fround(mesh.vx[v])
    ys[i] = Math.fround(mesh.vy[v])
    const n = canonicalStar(mesh, v, newId, star, ring)
    for (let s = 0; s < n; s++) {
      const a = ring[s]
      const b = ring[(s + 1) % n]
      if (!(i < a && i < b)) continue
      if (length + 3 > tris.length) {
        const grown = new Int32Array(tris.length * 2)
        grown.set(tris)
        tris = grown
      }
      tris[length++] = i
      tris[length++] = a
      tris[length++] = b
    }
  }
  return { mesh: buildFromTriangles(mesh.domain, xs, ys, count, tris.slice(0, length)), order }
}

// A per-node field reordered: out[i] = field[order[i]].
export function permute(field: Float32Array, order: Int32Array): Float32Array {
  const out = new Float32Array(order.length)
  for (let i = 0; i < order.length; i++) out[i] = field[order[i]]
  return out
}

function zigzag(n: number): number {
  return n >= 0 ? n * 2 : -n * 2 - 1
}

function unzigzag(u: number): number {
  return u % 2 === 0 ? u / 2 : -(u + 1) / 2
}

function writeVarint(out: number[], value: number): void {
  let v = value
  while (v >= 128) {
    out.push((v % 128) + 128)
    v = Math.floor(v / 128)
  }
  out.push(v)
}

function readVarint(bytes: Uint8Array, cursor: { at: number }): number {
  let value = 0
  let scale = 1
  for (;;) {
    const b = bytes[cursor.at++]
    value += (b % 128) * scale
    if (b < 128) return value
    scale *= 128
  }
}
