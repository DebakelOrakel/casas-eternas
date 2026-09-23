import type { PeriodicTriangulation } from './periodicDelaunay'

// PER-NODE STATE that survives remeshing (decision 8 of
// docs/decisions/adaptive-mesh.md: "full state inheritance"). Fields are
// named Float32Arrays indexed by vertex id, grown in step with the
// triangulation's vertex slots. Two kinds, because insertion and removal
// treat them differently:
//
//   intensive  a value AT a point (height, age, provenance): a new node
//              interpolates it barycentrically from the triangle it lands
//              in; a removed node's value is simply gone.
//   extensive  an amount PER AREA (a sediment thickness): interpolated on
//              insertion like the other kind (near lossless, the columns
//              of the parents align), and on removal MERGED into the
//              neighbours weighted by how much of the removed cell each
//              one inherits — the neighbours' Voronoi cells grow into the
//              hole, and thickness times area is conserved exactly.
//
// Layer-wise inheritance (a column of epoch-indexed layers) waits for
// phase 5; until then a column is one thickness and this is the whole
// rule.
export type FieldKind = 'intensive' | 'extensive'

export interface MeshField {
  readonly name: string
  readonly kind: FieldKind
  data: Float32Array
}

export class MeshState {
  readonly fields: MeshField[] = []
  private byName = new Map<string, MeshField>()
  private capacity: number

  constructor(capacity: number) {
    this.capacity = Math.max(16, capacity)
  }

  add(name: string, kind: FieldKind): Float32Array {
    if (this.byName.has(name)) throw new Error(`MeshState: field ${name} exists`)
    const field: MeshField = { name, kind, data: new Float32Array(this.capacity) }
    this.fields.push(field)
    this.byName.set(name, field)
    return field.data
  }

  get(name: string): Float32Array {
    const f = this.byName.get(name)
    if (!f) throw new Error(`MeshState: no field ${name}`)
    return f.data
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  // Grows every field to cover the triangulation's vertex slots. Call after
  // any insertion, before reading; the arrays are replaced, so hold no
  // reference across it — read through `get`.
  ensure(mesh: PeriodicTriangulation): void {
    if (mesh.vertexSlots <= this.capacity) return
    let cap = this.capacity
    while (cap < mesh.vertexSlots) cap *= 2
    for (const f of this.fields) {
      const data = new Float32Array(cap)
      data.set(f.data)
      f.data = data
    }
    this.capacity = cap
  }

  // A new vertex v inside triangle (a, b, c) with barycentric weights.
  inheritInsert(v: number, a: number, b: number, c: number, wa: number, wb: number, wc: number): void {
    for (const f of this.fields) {
      const d = f.data
      d[v] = wa * d[a] + wb * d[b] + wc * d[c]
    }
  }

  // Vertex v is about to go: its `n` neighbours had Voronoi areas `before`
  // and will have `after`; v's own cell had `areaV`. Extensive fields are
  // redistributed in proportion to the area each neighbour gains.
  inheritRemove(v: number, neighbours: Int32Array, n: number, before: Float64Array, after: Float64Array, areaV: number): void {
    if (areaV <= 0) return
    for (const f of this.fields) {
      if (f.kind !== 'extensive') continue
      const d = f.data
      const amount = d[v] * areaV
      for (let i = 0; i < n; i++) {
        const gained = after[i] - before[i]
        if (gained <= 0 || after[i] <= 0) continue
        const u = neighbours[i]
        d[u] = (d[u] * before[i] + amount * (gained / areaV)) / after[i]
      }
    }
  }
}
