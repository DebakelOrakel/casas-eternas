import type { Domain } from '../core/domain'

// PERIODIC DELAUNAY TRIANGULATION on a domain — the mesh's substrate
// (decision 11 of docs/decisions/adaptive-mesh.md: the topology is the
// domain's, the triangulation never sees a period).
//
// Representation: the compact triangle/halfedge layout (Delaunator's):
// triangle t owns halfedges 3t, 3t+1, 3t+2; halfedge e runs from
// `tris[e]` to `tris[next(e)]`, and `twin[e]` is the halfedge running the
// other way. On a closed surface every halfedge has a twin, which is what
// makes the torus SIMPLER than the plane: there is no hull and no
// super-triangle, the bootstrap lattice (`buildFromTriangles`) is already
// closed. Every triangle is stored counter-clockwise.
//
// Periodicity is handled at exactly one place: `frame(t)` unwraps a
// triangle's second and third corner into the frame of its first through
// the domain's `deltaX`/`deltaY`, and a query point is unwrapped into the
// same frame. Every predicate (orientation, in-circle, circumcentre) is
// then the planar one. This is sound as long as every triangle is small
// against the period — the one-sheeted-cover condition of periodic
// triangulations — which `MAX_EDGE_FRACTION` keeps (`remove` refuses a
// removal that would breach it, and the bootstrap lattice starts far
// below it).
//
// Operations, all incremental and deterministic:
//   insert(x, y)  point location by a straight walk from a hint, then a
//                 1→3 (or 2→4 on an edge) split and Lawson legalisation;
//   remove(v)     clip ears off the link polygon by flips down to degree
//                 three, merge, legalise the hole (Devillers' scheme);
//   legalise      Lawson flips over a stack of halfedges.
// Determinism is by construction: single-threaded, no hashing of
// positions, the free lists are plain stacks — the same operations in the
// same order give the same arrays byte for byte, which the mesh harness
// checks. Insertion ORDER is the caller's (Hilbert, see hilbert.ts).
//
// Positions are stored ROUNDED TO FLOAT32 (`Math.fround` on every insert):
// the save carries them as f32 (mesh/meshSerial.ts), and a mesh that
// continues in the session must be the mesh a reload rebuilds, bit for
// bit — so the session never holds a position the save cannot.
//
// Robustness: predicates are plain doubles. A configuration too close to
// degenerate may leave a locally non-Delaunay edge (the in-circle test has
// a relative tolerance so two rounding-equal circles cannot flip back and
// forth), never an invalid triangulation: splits and flips keep every
// triangle counter-clockwise by construction, and a flip is applied only
// when both resulting triangles are strictly so.

// Edges longer than this fraction of the shorter period are refused — the
// one-sheeted-cover margin (the strict bound is 1/2; the quarter leaves
// room for the flips a removal legalises with).
export const MAX_EDGE_FRACTION = 0.25

// In-circle tolerance, relative to the fourth power of the local scale:
// a determinant below it counts as co-circular and does not flip.
const INCIRCLE_EPS = 1e-12

// Orientation tolerance for "on the edge", relative to the squared edge
// length: a point this close to an edge splits the edge (2→4) rather than
// producing a sliver.
const ON_EDGE_EPS = 1e-10

// Orientation margin for a flip's new triangles, relative to the squared
// local scale: below it a triangle counts as degenerate and the flip is
// not made.
const ORIENT_EPS = 1e-12

const next = (e: number): number => (e % 3 === 2 ? e - 2 : e + 1)
const prev = (e: number): number => (e % 3 === 0 ? e + 2 : e - 1)

export class PeriodicTriangulation {
  readonly domain: Domain
  // Vertices. `vx`/`vy` in domain coordinates, wrapped. `vEdge` is one
  // outgoing halfedge (-1 when dead), kept current by every operation that
  // creates a triangle. Slots are reused through `freeVertices`.
  vx: Float64Array
  vy: Float64Array
  vEdge: Int32Array
  vAlive: Uint8Array
  // High-water mark of vertex slots ever used; iterate 0..vertexSlots and
  // test `vAlive`.
  vertexSlots = 0
  aliveVertices = 0
  private freeVertices: number[] = []
  // Triangles. Three vertex ids per triangle, one twin per halfedge.
  tris: Int32Array
  twin: Int32Array
  tAlive: Uint8Array
  triSlots = 0
  aliveTriangles = 0
  private freeTris: number[] = []
  // The last triangle touched, the default walk start (Hilbert order makes
  // it a neighbour of the next query).
  lastTri = 0
  // Counters the harness reads: how far walks go, how many flips happen.
  walkSteps = 0
  flips = 0
  private stack: number[] = []

  constructor(domain: Domain, vertexCapacity = 1024) {
    this.domain = domain
    const vc = Math.max(4, vertexCapacity)
    this.vx = new Float64Array(vc)
    this.vy = new Float64Array(vc)
    this.vEdge = new Int32Array(vc).fill(-1)
    this.vAlive = new Uint8Array(vc)
    const tc = vc * 2 + 4
    this.tris = new Int32Array(tc * 3).fill(-1)
    this.twin = new Int32Array(tc * 3).fill(-1)
    this.tAlive = new Uint8Array(tc)
  }

  // ---------------------------------------------------------------- frames

  // The triangle's three corners unwrapped into the frame of its first:
  // writes ax ay bx by cx cy into `out`.
  frame(t: number, out: Float64Array): void {
    const a = this.tris[3 * t]
    const b = this.tris[3 * t + 1]
    const c = this.tris[3 * t + 2]
    const ax = this.vx[a]
    const ay = this.vy[a]
    out[0] = ax
    out[1] = ay
    out[2] = ax + this.domain.deltaX(this.vx[b], ax)
    out[3] = ay + this.domain.deltaY(this.vy[b], ay)
    out[4] = ax + this.domain.deltaX(this.vx[c], ax)
    out[5] = ay + this.domain.deltaY(this.vy[c], ay)
  }

  private readonly f = new Float64Array(6)

  // Squared length of halfedge e.
  edgeLengthSq(e: number): number {
    const a = this.tris[e]
    const b = this.tris[next(e)]
    return this.domain.distanceSq(this.vx[a], this.vy[a], this.vx[b], this.vy[b])
  }

  edgeLength(e: number): number {
    return Math.sqrt(this.edgeLengthSq(e))
  }

  triangleOf(e: number): number {
    return (e / 3) | 0
  }

  // The halfedge after e around the same origin, counter-clockwise.
  rotateCcw(e: number): number {
    return this.twin[prev(e)]
  }

  // Origin and destination of a halfedge.
  from(e: number): number {
    return this.tris[e]
  }

  to(e: number): number {
    return this.tris[next(e)]
  }

  // The vertex of e's triangle that is not on e.
  apex(e: number): number {
    return this.tris[prev(e)]
  }

  degree(v: number): number {
    const start = this.vEdge[v]
    let e = start
    let n = 0
    do {
      n++
      e = this.rotateCcw(e)
    } while (e !== start)
    return n
  }

  // Neighbour vertex ids of v, counter-clockwise, into `out` (returns the
  // count; `out` must be long enough — degrees rarely exceed 16).
  neighbours(v: number, out: Int32Array): number {
    const start = this.vEdge[v]
    let e = start
    let n = 0
    do {
      out[n++] = this.to(e)
      e = this.rotateCcw(e)
    } while (e !== start)
    return n
  }

  // Outgoing halfedges of v, counter-clockwise.
  outgoing(v: number, out: Int32Array): number {
    const start = this.vEdge[v]
    let e = start
    let n = 0
    do {
      out[n++] = e
      e = this.rotateCcw(e)
    } while (e !== start)
    return n
  }

  // Circumcentre of triangle t relative to its first corner, into out[0..1];
  // returns false for a degenerate triangle.
  circumcentre(t: number, out: Float64Array): boolean {
    const f = this.f
    this.frame(t, f)
    const bx = f[2] - f[0]
    const by = f[3] - f[1]
    const cx = f[4] - f[0]
    const cy = f[5] - f[1]
    const d = 2 * (bx * cy - by * cx)
    if (d === 0) return false
    const b2 = bx * bx + by * by
    const c2 = cx * cx + cy * cy
    out[0] = (cy * b2 - by * c2) / d
    out[1] = (bx * c2 - cx * b2) / d
    return true
  }

  // Voronoi cell area of v: the polygon of the circumcentres of its star,
  // in the frame of v. Sums to the domain's area over all vertices.
  private readonly cc = new Float64Array(2)

  voronoiArea(v: number): number {
    const vx = this.vx[v]
    const vy = this.vy[v]
    const start = this.vEdge[v]
    let e = start
    let area = 0
    let firstX = 0
    let firstY = 0
    let prevX = 0
    let prevY = 0
    let first = true
    do {
      const t = this.triangleOf(e)
      // The circumcentre comes out relative to the triangle's first corner;
      // bring it into v's frame.
      const a = this.tris[3 * t]
      this.circumcentre(t, this.cc)
      const ax = vx + this.domain.deltaX(this.vx[a], vx)
      const ay = vy + this.domain.deltaY(this.vy[a], vy)
      const x = ax + this.cc[0] - vx
      const y = ay + this.cc[1] - vy
      if (first) {
        firstX = x
        firstY = y
        first = false
      } else {
        area += prevX * y - x * prevY
      }
      prevX = x
      prevY = y
      e = this.rotateCcw(e)
    } while (e !== start)
    area += prevX * firstY - firstX * prevY
    return area / 2
  }

  // ------------------------------------------------------------ predicates

  private static orient(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax)
  }

  // > 0 when d lies strictly inside the circumcircle of the counter-
  // clockwise triangle abc, all in one frame.
  private static inCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
    const adx = ax - dx
    const ady = ay - dy
    const bdx = bx - dx
    const bdy = by - dy
    const cdx = cx - dx
    const cdy = cy - dy
    const ad = adx * adx + ady * ady
    const bd = bdx * bdx + bdy * bdy
    const cd = cdx * cdx + cdy * cdy
    const det = ad * (bdx * cdy - cdx * bdy) - bd * (adx * cdy - cdx * ady) + cd * (adx * bdy - bdx * ady)
    // Tolerance in the determinant's own units (length⁴).
    const scale = ad * bd + bd * cd + cd * ad
    return det > INCIRCLE_EPS * scale
  }

  // -------------------------------------------------------------- location

  // The triangle containing (x, y), by a straight walk from `hint`.
  // Returns the triangle; `onEdge` (0..2 or -1) tells whether the point
  // lies on that edge of it, `atVertex` (0..2 or -1) whether it coincides
  // with a corner.
  onEdge = -1
  atVertex = -1

  locate(x: number, y: number, hint = this.lastTri): number {
    let t = this.tAlive[hint] ? hint : this.anyAliveTriangle()
    const f = this.f
    const maxSteps = this.triSlots * 2 + 16
    let steps = 0
    for (;;) {
      this.frame(t, f)
      const px = f[0] + this.domain.deltaX(x, f[0])
      const py = f[1] + this.domain.deltaY(y, f[1])
      const o0 = PeriodicTriangulation.orient(f[0], f[1], f[2], f[3], px, py)
      const o1 = PeriodicTriangulation.orient(f[2], f[3], f[4], f[5], px, py)
      const o2 = PeriodicTriangulation.orient(f[4], f[5], f[0], f[1], px, py)
      // Cross the edge the point is most clearly outside of.
      let cross = -1
      let worst = 0
      if (o0 < worst) { worst = o0; cross = 0 }
      if (o1 < worst) { worst = o1; cross = 1 }
      if (o2 < worst) { worst = o2; cross = 2 }
      if (cross < 0) {
        this.classify(f, px, py, o0, o1, o2)
        this.walkSteps += steps
        this.lastTri = t
        return t
      }
      t = this.triangleOf(this.twin[3 * t + cross])
      if (++steps > maxSteps) throw new Error('PeriodicTriangulation.locate: walk did not terminate')
    }
  }

  private classify(f: Float64Array, px: number, py: number, o0: number, o1: number, o2: number): void {
    this.onEdge = -1
    this.atVertex = -1
    const l0 = (f[2] - f[0]) ** 2 + (f[3] - f[1]) ** 2
    const l1 = (f[4] - f[2]) ** 2 + (f[5] - f[3]) ** 2
    const l2 = (f[0] - f[4]) ** 2 + (f[1] - f[5]) ** 2
    const e0 = o0 <= ON_EDGE_EPS * l0
    const e1 = o1 <= ON_EDGE_EPS * l1
    const e2 = o2 <= ON_EDGE_EPS * l2
    if (e0 && e2) this.atVertex = 0
    else if (e0 && e1) this.atVertex = 1
    else if (e1 && e2) this.atVertex = 2
    else if (e0) this.onEdge = 0
    else if (e1) this.onEdge = 1
    else if (e2) this.onEdge = 2
    void px
    void py
  }

  private anyAliveTriangle(): number {
    for (let t = 0; t < this.triSlots; t++) if (this.tAlive[t]) return t
    throw new Error('PeriodicTriangulation: no triangles')
  }

  // -------------------------------------------------------------- capacity

  private ensureVertexCapacity(count: number): void {
    if (count <= this.vx.length) return
    let cap = this.vx.length
    while (cap < count) cap *= 2
    const vx = new Float64Array(cap)
    vx.set(this.vx)
    const vy = new Float64Array(cap)
    vy.set(this.vy)
    const vEdge = new Int32Array(cap).fill(-1)
    vEdge.set(this.vEdge)
    const vAlive = new Uint8Array(cap)
    vAlive.set(this.vAlive)
    this.vx = vx
    this.vy = vy
    this.vEdge = vEdge
    this.vAlive = vAlive
  }

  private ensureTriCapacity(count: number): void {
    if (count * 3 <= this.tris.length) return
    let cap = this.tris.length / 3
    while (cap < count) cap *= 2
    const tris = new Int32Array(cap * 3).fill(-1)
    tris.set(this.tris)
    const twin = new Int32Array(cap * 3).fill(-1)
    twin.set(this.twin)
    const tAlive = new Uint8Array(cap)
    tAlive.set(this.tAlive)
    this.tris = tris
    this.twin = twin
    this.tAlive = tAlive
  }

  private newVertex(x: number, y: number): number {
    let v: number
    if (this.freeVertices.length > 0) v = this.freeVertices.pop() as number
    else {
      this.ensureVertexCapacity(this.vertexSlots + 1)
      v = this.vertexSlots++
    }
    this.vx[v] = this.domain.wrapX(Math.fround(this.domain.wrapX(x)))
    this.vy[v] = this.domain.wrapY(Math.fround(this.domain.wrapY(y)))
    this.vAlive[v] = 1
    this.aliveVertices++
    return v
  }

  private newTriangle(): number {
    let t: number
    if (this.freeTris.length > 0) t = this.freeTris.pop() as number
    else {
      this.ensureTriCapacity(this.triSlots + 1)
      t = this.triSlots++
    }
    this.tAlive[t] = 1
    this.aliveTriangles++
    return t
  }

  private freeTriangle(t: number): void {
    this.tAlive[t] = 0
    this.aliveTriangles--
    this.tris[3 * t] = this.tris[3 * t + 1] = this.tris[3 * t + 2] = -1
    this.twin[3 * t] = this.twin[3 * t + 1] = this.twin[3 * t + 2] = -1
    this.freeTris.push(t)
  }

  private setTriangle(t: number, a: number, b: number, c: number): void {
    const base = 3 * t
    this.tris[base] = a
    this.tris[base + 1] = b
    this.tris[base + 2] = c
    this.vEdge[a] = base
    this.vEdge[b] = base + 1
    this.vEdge[c] = base + 2
  }

  private pair(e1: number, e2: number): void {
    this.twin[e1] = e2
    this.twin[e2] = e1
  }

  // ------------------------------------------------------------- insertion

  // Inserts a point and returns its vertex id. A point coinciding with an
  // existing vertex returns that vertex and inserts nothing.
  insert(x: number, y: number, hint = this.lastTri): number {
    const t = this.locate(x, y, hint)
    if (this.atVertex >= 0) return this.tris[3 * t + this.atVertex]
    const p = this.newVertex(x, y)
    if (this.onEdge >= 0) this.splitEdge(3 * t + this.onEdge, p)
    else this.splitTriangle(t, p)
    this.legalise()
    this.lastTri = this.triangleOf(this.vEdge[p])
    return p
  }

  private splitTriangle(t: number, p: number): void {
    const a = this.tris[3 * t]
    const b = this.tris[3 * t + 1]
    const c = this.tris[3 * t + 2]
    const tab = this.twin[3 * t]
    const tbc = this.twin[3 * t + 1]
    const tca = this.twin[3 * t + 2]
    const t1 = this.newTriangle()
    const t2 = this.newTriangle()
    this.setTriangle(t, a, b, p)
    this.setTriangle(t1, b, c, p)
    this.setTriangle(t2, c, a, p)
    this.pair(3 * t, tab)
    this.pair(3 * t1, tbc)
    this.pair(3 * t2, tca)
    this.pair(3 * t + 1, 3 * t1 + 2)
    this.pair(3 * t1 + 1, 3 * t2 + 2)
    this.pair(3 * t2 + 1, 3 * t + 2)
    this.stack.push(3 * t, 3 * t1, 3 * t2)
  }

  private splitEdge(e: number, p: number): void {
    const t = this.triangleOf(e)
    const e2 = this.twin[e]
    const t2 = this.triangleOf(e2)
    const a = this.tris[e]
    const b = this.to(e)
    const c = this.apex(e)
    const d = this.apex(e2)
    const tca = this.twin[prev(e)]
    const tbc = this.twin[next(e)]
    const tdb = this.twin[prev(e2)]
    const tad = this.twin[next(e2)]
    const t3 = this.newTriangle()
    const t4 = this.newTriangle()
    this.setTriangle(t, a, p, c)
    this.setTriangle(t2, b, p, d)
    this.setTriangle(t3, p, b, c)
    this.setTriangle(t4, p, a, d)
    this.pair(3 * t + 2, tca)
    this.pair(3 * t2 + 2, tdb)
    this.pair(3 * t3 + 1, tbc)
    this.pair(3 * t4 + 1, tad)
    this.pair(3 * t, 3 * t4)
    this.pair(3 * t + 1, 3 * t3 + 2)
    this.pair(3 * t3, 3 * t2)
    this.pair(3 * t2 + 1, 3 * t4 + 2)
    this.stack.push(3 * t + 2, 3 * t2 + 2, 3 * t3 + 1, 3 * t4 + 1)
  }

  // Flips halfedge e (a→b, apex p; twin b→a, apex d) into p–d. The two
  // triangle slots are rewritten in place as (a, d, p) and (d, b, p).
  private flip(e: number): void {
    const t = this.triangleOf(e)
    const e2 = this.twin[e]
    const t2 = this.triangleOf(e2)
    const a = this.tris[e]
    const b = this.to(e)
    const p = this.apex(e)
    const d = this.apex(e2)
    const tbp = this.twin[next(e)]
    const tpa = this.twin[prev(e)]
    const tad = this.twin[next(e2)]
    const tdb = this.twin[prev(e2)]
    this.setTriangle(t, a, d, p)
    this.setTriangle(t2, d, b, p)
    this.pair(3 * t, tad)
    this.pair(3 * t + 2, tpa)
    this.pair(3 * t2, tdb)
    this.pair(3 * t2 + 1, tbp)
    this.pair(3 * t + 1, 3 * t2 + 2)
    this.flips++
  }

  // Lawson legalisation over the stack: pop a halfedge, flip it when the
  // twin's apex lies in its triangle's circumcircle, push the flipped
  // pair's outer edges. Stale entries (a triangle freed meanwhile) are
  // skipped; a rewritten slot holds a valid halfedge and is simply
  // rechecked.
  private legalise(): void {
    const f = this.f
    const stack = this.stack
    while (stack.length > 0) {
      const e = stack.pop() as number
      const t = this.triangleOf(e)
      if (!this.tAlive[t]) continue
      const i = e - 3 * t
      this.frame(t, f)
      const ax = f[(2 * i) % 6]
      const ay = f[(2 * i + 1) % 6]
      const bx = f[(2 * i + 2) % 6]
      const by = f[(2 * i + 3) % 6]
      const px = f[(2 * i + 4) % 6]
      const py = f[(2 * i + 5) % 6]
      const dv = this.apex(this.twin[e])
      const dx = ax + this.domain.deltaX(this.vx[dv], ax)
      const dy = ay + this.domain.deltaY(this.vy[dv], ay)
      if (!PeriodicTriangulation.inCircle(ax, ay, bx, by, px, py, dx, dy)) continue
      // Both triangles of the flip must be strictly counter-clockwise, by
      // a margin: a sliver flipped into existence is a sliver the next
      // removal trips over.
      const scale = (dx - ax) ** 2 + (dy - ay) ** 2 + (px - ax) ** 2 + (py - ay) ** 2
      if (PeriodicTriangulation.orient(ax, ay, dx, dy, px, py) <= ORIENT_EPS * scale) continue
      if (PeriodicTriangulation.orient(dx, dy, bx, by, px, py) <= ORIENT_EPS * scale) continue
      const t2 = this.triangleOf(this.twin[e])
      this.flip(e)
      stack.push(3 * t, 3 * t + 2, 3 * t2, 3 * t2 + 1)
    }
  }

  // Legalises every edge of the triangulation — after `buildFromTriangles`
  // on a lattice whose diagonals were not chosen by the Delaunay rule.
  legaliseAll(): void {
    for (let t = 0; t < this.triSlots; t++) {
      if (!this.tAlive[t]) continue
      this.stack.push(3 * t, 3 * t + 1, 3 * t + 2)
    }
    this.legalise()
  }

  // --------------------------------------------------------------- removal

  private readonly star = new Int32Array(64)

  // Removes vertex v. Returns false, and changes nothing, when the removal
  // would leave an edge longer than the one-sheet margin or the mesh has
  // too few vertices to stay a triangulation.
  remove(v: number): boolean {
    if (!this.vAlive[v] || this.aliveVertices <= 4) return false
    const maxLenSq = (Math.min(this.domain.width, this.domain.height) * MAX_EDGE_FRACTION) ** 2
    // Refuse when any two link vertices are further apart than the margin:
    // every edge the hole's triangulation can contain joins two of them.
    let n = this.outgoing(v, this.star)
    for (let i = 0; i < n; i++) {
      const a = this.to(this.star[i])
      for (let j = i + 1; j < n; j++) {
        const b = this.to(this.star[j])
        if (this.domain.distanceSq(this.vx[a], this.vy[a], this.vx[b], this.vy[b]) > maxLenSq) return false
      }
    }
    const touched: number[] = []
    // Clip ears off the link polygon until three vertices remain. An ear
    // is a link vertex u, convex between its neighbours r and l, whose
    // triangle (r, u, l) holds no other link vertex; the flip of v→u into
    // r–l cuts it off. The triangle (v, r, l) the flip leaves on v's side
    // may be inverted — the polygon that remains around v need not be
    // star-shaped from v any more — and that is fine: nothing reads its
    // geometry, and it is consumed by the merge at the end. (A flip-only
    // scheme that also required (v, r, l) to be proper got stuck on a
    // node at the centre of a rectangle, where every such triangle is
    // degenerate — the hex lattice produces exactly that.) Among the ears
    // the one whose circumcircle holds no other link vertex is preferred
    // (Devillers' rule), so the hole comes out nearly Delaunay and the
    // final legalisation is short.
    while (n > 3) {
      let chosen = -1
      let fallback = -1
      for (let i = 0; i < n && chosen < 0; i++) {
        if (!this.isEar(i, n)) continue
        if (fallback < 0) fallback = i
        if (this.earIsDelaunay(this.star[i], n)) chosen = i
      }
      if (chosen < 0) chosen = fallback
      if (chosen < 0) throw new Error('PeriodicTriangulation.remove: the link polygon has no ear')
      const e = this.star[chosen]
      const t2 = this.triangleOf(this.twin[e])
      this.flip(e)
      touched.push(this.triangleOf(e), t2)
      n = this.outgoing(v, this.star)
    }
    // Merge the three triangles of the star into one.
    const e0 = this.star[0]
    const e1 = this.star[1]
    const e2 = this.star[2]
    const t0 = this.triangleOf(e0)
    const t1 = this.triangleOf(e1)
    const t2 = this.triangleOf(e2)
    // Around v counter-clockwise: e0 = v→u0 in (v, u0, u1), e1 = v→u1 in
    // (v, u1, u2), e2 = v→u2 in (v, u2, u0). The hole (u0, u1, u2) is CCW.
    const u0 = this.to(e0)
    const u1 = this.to(e1)
    const u2 = this.to(e2)
    const t01 = this.twin[next(e0)]
    const t12 = this.twin[next(e1)]
    const t20 = this.twin[next(e2)]
    this.freeTriangle(t1)
    this.freeTriangle(t2)
    this.setTriangle(t0, u0, u1, u2)
    this.pair(3 * t0, t01)
    this.pair(3 * t0 + 1, t12)
    this.pair(3 * t0 + 2, t20)
    this.vAlive[v] = 0
    this.vEdge[v] = -1
    this.aliveVertices--
    this.freeVertices.push(v)
    this.stack.push(3 * t0, 3 * t0 + 1, 3 * t0 + 2)
    for (const t of touched) if (this.tAlive[t]) this.stack.push(3 * t, 3 * t + 1, 3 * t + 2)
    this.legalise()
    this.lastTri = t0
    return true
  }

  // Whether link vertex i (of n, counter-clockwise) is an ear of the link
  // polygon: strictly convex between its neighbours, and its triangle
  // empty of the other link vertices.
  private isEar(i: number, n: number): boolean {
    const u = this.to(this.star[i])
    const r = this.to(this.star[(i + n - 1) % n])
    const l = this.to(this.star[(i + 1) % n])
    const rx = this.vx[r]
    const ry = this.vy[r]
    const ux = rx + this.domain.deltaX(this.vx[u], rx)
    const uy = ry + this.domain.deltaY(this.vy[u], ry)
    const lx = rx + this.domain.deltaX(this.vx[l], rx)
    const ly = ry + this.domain.deltaY(this.vy[l], ry)
    const area = PeriodicTriangulation.orient(rx, ry, ux, uy, lx, ly)
    const scale = (ux - rx) ** 2 + (uy - ry) ** 2 + (lx - rx) ** 2 + (ly - ry) ** 2
    if (area <= ORIENT_EPS * scale) return false
    for (let j = 0; j < n; j++) {
      const w = this.to(this.star[j])
      if (w === u || w === r || w === l) continue
      const wx = rx + this.domain.deltaX(this.vx[w], rx)
      const wy = ry + this.domain.deltaY(this.vy[w], ry)
      if (PeriodicTriangulation.orient(rx, ry, ux, uy, wx, wy) >= 0
        && PeriodicTriangulation.orient(ux, uy, lx, ly, wx, wy) >= 0
        && PeriodicTriangulation.orient(lx, ly, rx, ry, wx, wy) >= 0) return false
    }
    return true
  }

  // Whether the triangle a flip of star edge e would create outside v
  // (right apex, neighbour, left apex) has none of the other link vertices
  // in its circumcircle.
  private earIsDelaunay(e: number, n: number): boolean {
    const u = this.to(e)
    const l = this.apex(e)
    const r = this.apex(this.twin[e])
    const rx = this.vx[r]
    const ry = this.vy[r]
    const ux = rx + this.domain.deltaX(this.vx[u], rx)
    const uy = ry + this.domain.deltaY(this.vy[u], ry)
    const lx = rx + this.domain.deltaX(this.vx[l], rx)
    const ly = ry + this.domain.deltaY(this.vy[l], ry)
    for (let i = 0; i < n; i++) {
      const w = this.to(this.star[i])
      if (w === u || w === l || w === r) continue
      const wx = rx + this.domain.deltaX(this.vx[w], rx)
      const wy = ry + this.domain.deltaY(this.vy[w], ry)
      if (PeriodicTriangulation.inCircle(rx, ry, ux, uy, lx, ly, wx, wy)) return false
    }
    return true
  }

  // ------------------------------------------------------------ validation

  // Structural check for the harness: twins consistent, every triangle
  // counter-clockwise and alive-referencing, every vertex's edge current,
  // Euler's formula for the torus (F = 2V, E = 3V), the edge margin, and
  // (sampled or full) the empty-circumcircle property. Returns the list of
  // violations, empty when sound.
  validate(checkDelaunay = true): string[] {
    const errors: string[] = []
    const f = this.f
    let aliveT = 0
    const maxLenSq = (Math.min(this.domain.width, this.domain.height) * MAX_EDGE_FRACTION) ** 2
    let maxEdgeSq = 0
    let nonDelaunay = 0
    for (let t = 0; t < this.triSlots; t++) {
      if (!this.tAlive[t]) continue
      aliveT++
      for (let i = 0; i < 3; i++) {
        const e = 3 * t + i
        const v = this.tris[e]
        if (v < 0 || !this.vAlive[v]) errors.push(`triangle ${t} references dead vertex ${v}`)
        const w = this.twin[e]
        if (w < 0 || !this.tAlive[this.triangleOf(w)]) errors.push(`halfedge ${e} has no live twin`)
        else if (this.twin[w] !== e) errors.push(`halfedge ${e} twin mismatch`)
        else if (this.tris[w] !== this.to(e) || this.to(w) !== this.tris[e]) errors.push(`halfedge ${e} twin runs the wrong way`)
        const lsq = this.edgeLengthSq(e)
        if (lsq > maxEdgeSq) maxEdgeSq = lsq
      }
      this.frame(t, f)
      if (PeriodicTriangulation.orient(f[0], f[1], f[2], f[3], f[4], f[5]) <= 0) errors.push(`triangle ${t} not counter-clockwise`)
      if (checkDelaunay) {
        for (let i = 0; i < 3; i++) {
          const e = 3 * t + i
          const dv = this.apex(this.twin[e])
          const dx = f[0] + this.domain.deltaX(this.vx[dv], f[0])
          const dy = f[1] + this.domain.deltaY(this.vy[dv], f[1])
          if (PeriodicTriangulation.inCircle(f[0], f[1], f[2], f[3], f[4], f[5], dx, dy)) nonDelaunay++
        }
      }
    }
    if (nonDelaunay > 0) errors.push(`${nonDelaunay} halfedges violate the empty-circumcircle property`)
    if (maxEdgeSq > maxLenSq) errors.push(`longest edge ${Math.sqrt(maxEdgeSq).toFixed(2)} exceeds the one-sheet margin ${Math.sqrt(maxLenSq).toFixed(2)}`)
    let aliveV = 0
    for (let v = 0; v < this.vertexSlots; v++) {
      if (!this.vAlive[v]) continue
      aliveV++
      const e = this.vEdge[v]
      if (e < 0 || !this.tAlive[this.triangleOf(e)] || this.tris[e] !== v) errors.push(`vertex ${v} edge pointer stale`)
      else if (this.degree(v) < 3) errors.push(`vertex ${v} has degree ${this.degree(v)}`)
    }
    if (aliveT !== this.aliveTriangles) errors.push(`triangle count ${this.aliveTriangles} vs ${aliveT} alive`)
    if (aliveV !== this.aliveVertices) errors.push(`vertex count ${this.aliveVertices} vs ${aliveV} alive`)
    if (aliveT !== 2 * aliveV) errors.push(`Euler: ${aliveT} triangles for ${aliveV} vertices (torus needs 2V)`)
    return errors
  }
}

// A triangulation from an explicit triangle list — the bootstrap lattice,
// and later a mesh read back from a save. Triangles may come in either
// orientation; they are stored counter-clockwise. Every edge must have
// exactly two sides (a closed surface), and no two distinct edges may join
// the same vertex pair (true for any lattice at least three cells wide).
export function buildFromTriangles(domain: Domain, xs: ArrayLike<number>, ys: ArrayLike<number>, count: number, triangles: ArrayLike<number>): PeriodicTriangulation {
  const mesh = new PeriodicTriangulation(domain, count)
  mesh.vertexSlots = count
  mesh.aliveVertices = count
  for (let v = 0; v < count; v++) {
    mesh.vx[v] = domain.wrapX(Math.fround(domain.wrapX(xs[v])))
    mesh.vy[v] = domain.wrapY(Math.fround(domain.wrapY(ys[v])))
    mesh.vAlive[v] = 1
  }
  const triCount = (triangles.length / 3) | 0
  // Reach into the capacity path through a throwaway growth: triSlots is
  // set explicitly below.
  const cap = mesh.tris.length / 3
  if (cap < triCount) {
    let c = cap
    while (c < triCount) c *= 2
    mesh.tris = new Int32Array(c * 3).fill(-1)
    mesh.twin = new Int32Array(c * 3).fill(-1)
    mesh.tAlive = new Uint8Array(c)
  }
  const f = new Float64Array(6)
  for (let t = 0; t < triCount; t++) {
    let a = triangles[3 * t]
    let b = triangles[3 * t + 1]
    const c = triangles[3 * t + 2]
    mesh.tris[3 * t] = a
    mesh.tris[3 * t + 1] = b
    mesh.tris[3 * t + 2] = c
    mesh.tAlive[t] = 1
    mesh.frame(t, f)
    const o = (f[2] - f[0]) * (f[5] - f[1]) - (f[3] - f[1]) * (f[4] - f[0])
    if (o === 0) throw new Error(`buildFromTriangles: degenerate triangle ${t}`)
    if (o < 0) {
      const tmp = a
      a = b
      b = tmp
      mesh.tris[3 * t] = a
      mesh.tris[3 * t + 1] = b
    }
    mesh.vEdge[a] = 3 * t
    mesh.vEdge[b] = 3 * t + 1
    mesh.vEdge[c] = 3 * t + 2
  }
  mesh.triSlots = triCount
  mesh.aliveTriangles = triCount
  // Twins by a per-vertex table of outgoing halfedges (counting sort) —
  // not a Map keyed by the pair, which tops out at 2^24 entries and a
  // world mesh has more directed edges than that.
  const edgeCount = triCount * 3
  const outStart = new Int32Array(count + 1)
  for (let e = 0; e < edgeCount; e++) outStart[mesh.tris[e] + 1]++
  for (let v = 0; v < count; v++) outStart[v + 1] += outStart[v]
  const outEdges = new Int32Array(edgeCount)
  const cursor = outStart.slice(0, count)
  for (let e = 0; e < edgeCount; e++) outEdges[cursor[mesh.tris[e]]++] = e
  const dest = (e: number): number => mesh.tris[e % 3 === 2 ? e - 2 : e + 1]
  for (let e = 0; e < edgeCount; e++) {
    const from = mesh.tris[e]
    const to = dest(e)
    let w = -1
    for (let k = outStart[to]; k < outStart[to + 1]; k++) {
      if (dest(outEdges[k]) === from) {
        if (w >= 0) throw new Error(`buildFromTriangles: edge ${to}→${from} appears twice`)
        w = outEdges[k]
      }
    }
    if (w < 0) throw new Error(`buildFromTriangles: edge ${from}→${to} has no twin`)
    mesh.twin[e] = w
  }
  mesh.lastTri = 0
  return mesh
}
