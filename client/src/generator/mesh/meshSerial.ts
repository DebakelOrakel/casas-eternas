import type { Domain } from '../core/domain'
import { buildFromTriangles, PeriodicTriangulation } from './periodicDelaunay'

// THE MESH AS BYTES (ADAPTIVE_MESH_PLAN.md phase 4.3: "the save is the
// mesh"), the read side: the engine writes them (mesh/mesh_serial.rs,
// DEC-0044 fork 7b), this module decodes them. Two files: the node positions (f32 pairs) and the connectivity —
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
// CANONICAL FORM: the engine's `compact_mesh` renumbers the vertices in Hilbert order and
// rebuilds the triangulation through the same encode → decode the save
// goes through, so the session's mesh after a run IS the mesh a reload
// produces (positions are float32 already, periodicDelaunay.ts). The
// engine's node order and every summation in it then depend on the vertex
// numbering alone (the engine's mesh_erosion.rs starts each star at the smallest id),
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
  // The sediment column's bytes (formatVersion 4, the engine's mesh/mesh_column.rs);
  // undefined in a save from before it.
  column?: Uint8Array
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

function unzigzag(u: number): number {
  return u % 2 === 0 ? u / 2 : -(u + 1) / 2
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
