import type { Domain } from '../core/domain'
import { detAsin, detAtan2, detCos, detSin, sq } from '../core/detMath'

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
// the domain's `delta`, and a query point is unwrapped into the
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
// THE SPHERE (DEC-0035, step 4d4) shares everything above but the
// geometry. The halfedges, the splits, the flips, the ear clipping of a
// removal, the Lawson stack and the walk are one code; only what a
// predicate, an area or a circumcentre computes differs, and each of those
// methods takes its globe path first (`globe`, from domain.kind). On the
// sphere a node keeps its chart position (x, y) — the address the save and
// the codec carry — and its unit vector u on the globe, derived from the
// stored (float32) chart position and cached per slot (`vu`), so the
// geometry is a function of the stored bits and a reload rebuilds it
// exactly. The predicates are exact in 3D, not a projection:
//   orientation  the sign of det[a, b, c]: three unit vectors, so the
//                spherical triangle's winding about the centre;
//   in-circle    which side of the plane through a, b, c the point d lies
//                on — the spherical Delaunay triangulation is the convex
//                hull of its points, and the cap beyond that plane is the
//                circumcircle's inside;
//   circumcentre (b − a) × (c − a) normalised, the plane's normal;
//   areas        spherical (Van Oosterom–Strackee per triangle), in domain
//                units² on the globe of radius R = W / 2π, so the nodes'
//                Voronoi cells sum to 4πR².
// The winding is the chart's on both shapes: a triangle is stored
// counter-clockwise in the east/south frame of its corners, which on the
// globe is det[a, b, c] < 0 (east × south is the INWARD normal). Every
// globe predicate below is signed so that this is positive, so the shared
// code reads one sign convention. The walk needs no carried image there:
// the globe has no period, only one sheet.
//
// `frame(t)` stays the log map into the first corner's tangent plane on
// both shapes — what a caller that wants a local picture of a triangle
// reads (the sampler's normals, the erosion index's cotangents). It is
// exact on the torus and close on the globe (an edge's length and angles
// to O(ℓ²/R²)); no predicate of the triangulation reads it there.
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

// The globe's in-circle has a second, absolute part. A unit vector is
// exact only to its last bit, so a point's height over the plane through
// three others carries an error of a few 1e-16 against a signal of the
// order of ℓ² (the cap's sagitta, ℓ the chord): relative to the triangle's
// scale that is ~1e-16 / ℓ², 1e-10 at the macro mesh's finest spacing on
// a 2048-wide world. The tolerance takes it per test: this times |n|₁,
// the normal's size (≈ ℓ²), on top of INCIRCLE_EPS × scale — far above
// the rounding, so a flip can never be undone by the reverse test.
const GLOBE_RADIAL_EPS = 1e-14

// asin of a half chord: its Taylor series to x⁷ below 0.01 (the next
// term is under 4e-18 of x there, below the last bit), detAsin above — an
// edge's arc from its chord at a quarter of detAsin's cost, in exact
// operations only.
function halfChordAsin(x: number): number {
  if (x >= 0.01) return detAsin(x)
  const x2 = x * x
  return x + x * x2 * (1 / 6 + x2 * (3 / 40 + x2 * (15 / 336)))
}

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
  // The sphere's geometry (see the header): true on a sphere domain. `vu`
  // holds each slot's unit vector (x, y, z interleaved) there, and is empty
  // on the torus.
  readonly globe: boolean
  vu: Float64Array
  private readonly toLon: number
  private readonly toColat: number
  // The globe's radius in domain units, W / 2π.
  private readonly radius: number
  // Walks on the globe that gave up and scanned every triangle instead —
  // the harness reads it; 0 is expected.
  walkFallbacks = 0

  constructor(domain: Domain, vertexCapacity = 1024) {
    this.domain = domain
    const vc = Math.max(4, vertexCapacity)
    this.globe = domain.kind === 'sphere'
    this.vu = new Float64Array(this.globe ? vc * 3 : 0)
    this.toLon = (2 * Math.PI) / domain.width
    this.toColat = Math.PI / domain.height
    this.radius = domain.width / (2 * Math.PI)
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
    const d = this.d
    this.domain.delta(this.vx[b], this.vy[b], ax, ay, d)
    out[2] = ax + d.x
    out[3] = ay + d.y
    this.domain.delta(this.vx[c], this.vy[c], ax, ay, d)
    out[4] = ax + d.x
    out[5] = ay + d.y
  }

  private readonly f = new Float64Array(6)
  // The one offset `domain.delta` writes into, so no call allocates.
  private readonly d = { x: 0, y: 0 }

  // Squared length of halfedge e.
  edgeLengthSq(e: number): number {
    const a = this.tris[e]
    const b = this.tris[next(e)]
    if (this.globe) {
      // The arc from the cached unit vectors, 2R · asin(chord / 2): the
      // Domain's distance without its trig per point (a third of a sphere
      // build was the Domain's distance, 2026-10-10).
      const arc = this.radius * 2 * halfChordAsin(Math.sqrt(this.chordSq(a, b)) / 2)
      return arc * arc
    }
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
  // returns false for a degenerate triangle. The torus's: on the globe the
  // circumcentre is a point of the sphere, not an offset in a plane
  // (`circumcentreOnGlobe`).
  circumcentre(t: number, out: Float64Array): boolean {
    if (this.globe) throw new Error('PeriodicTriangulation.circumcentre: a plane offset; on the globe use circumcentreOnGlobe')
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
    if (this.globe) return this.voronoiAreaOnGlobe(v)
    const vx = this.vx[v]
    const vy = this.vy[v]
    const d = this.d
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
      this.domain.delta(this.vx[a], this.vy[a], vx, vy, d)
      const ax = vx + d.x
      const ay = vy + d.y
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

  // Barycentric weights of (x, y) in triangle t, clamped to the simplex,
  // into out[0..2] — the linear interpolation within a triangle that the
  // remesh, the rasteriser and the sampler use. The torus: in the
  // triangle's unwrapped frame. The globe: the weights of the point where
  // the ray from the centre through (x, y) meets the flat triangle, the
  // three determinants det[p, b, c], det[a, p, c], det[a, b, p] — exact,
  // and linear along each edge as the flat triangle is.
  barycentric(t: number, x: number, y: number, out: Float64Array): void {
    if (this.globe) {
      this.barycentricOnGlobe(t, x, y, out)
      return
    }
    const frame = this.bf
    this.frame(t, frame)
    this.domain.delta(x, y, frame[0], frame[1], this.bd)
    const px = frame[0] + this.bd.x
    const py = frame[1] + this.bd.y
    const v0x = frame[2] - frame[0]
    const v0y = frame[3] - frame[1]
    const v1x = frame[4] - frame[0]
    const v1y = frame[5] - frame[1]
    const v2x = px - frame[0]
    const v2y = py - frame[1]
    const den = v0x * v1y - v1x * v0y
    let wb = (v2x * v1y - v1x * v2y) / den
    let wc = (v0x * v2y - v2x * v0y) / den
    wb = Math.min(1, Math.max(0, wb))
    wc = Math.min(1, Math.max(0, wc))
    const wa = Math.max(0, 1 - wb - wc)
    const s = wa + wb + wc
    out[0] = wa / s
    out[1] = wb / s
    out[2] = wc / s
  }

  // barycentric's own scratch: it is called between other operations that
  // hold `f` and `d`.
  private readonly bf = new Float64Array(6)
  private readonly bd = { x: 0, y: 0 }

  // ---------------------------------------------------------- the globe

  // The unit vector of chart point (x, y) into out[o..o + 2]: (sin θ cos λ,
  // sin θ sin λ, cos θ), the Domain's globe frame (core/domain.ts) without
  // its radius. At a pole sin θ is exactly 0: one point for every x.
  private unitOf(x: number, y: number, out: Float64Array, o: number): void {
    const t = y * this.toColat
    const l = x * this.toLon
    const st = detSin(t)
    out[o] = st * detCos(l)
    out[o + 1] = st * detSin(l)
    out[o + 2] = detCos(t)
  }

  // The chart point a vertex is stored at, from any (x, y): the point
  // brought into the chart, rounded to float32 (the save's precision, as
  // on the torus), the longitude wrapped once more in case it rounded up
  // to the width. Into `this.cp`.
  private readonly cp = { x: 0, y: 0 }

  private chartPoint(x: number, y: number): void {
    const p = this.cp
    this.domain.wrapPoint(x, y, p)
    p.x = this.domain.wrapX(Math.fround(p.x))
    p.y = Math.fround(p.y)
  }

  // The orientation of three unit vectors, chart-positive: −det[a, b, c],
  // in the form a · ((b − a) × (c − a)) negated — the differences first, so
  // that a small triangle keeps its precision. Linear in each argument, so
  // with c a query point it is the side of the great circle through a, b.
  private static orientG(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
    const ux = bx - ax
    const uy = by - ay
    const uz = bz - az
    const wx = cx - ax
    const wy = cy - ay
    const wz = cz - az
    return -(ax * (uy * wz - uz * wy) + ay * (uz * wx - ux * wz) + az * (ux * wy - uy * wx))
  }

  // True when d lies strictly inside the circumcircle of the chart-
  // counter-clockwise spherical triangle abc: beyond the plane through a,
  // b, c, on the side away from the centre. n = (b − a) × (c − a) points
  // inward for such a triangle, so inside is (d − a) · n < 0.
  private static inCircleG(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number): boolean {
    const ux = bx - ax
    const uy = by - ay
    const uz = bz - az
    const wx = cx - ax
    const wy = cy - ay
    const wz = cz - az
    const nx = uy * wz - uz * wy
    const ny = uz * wx - ux * wz
    const nz = ux * wy - uy * wx
    const det = -((dx - ax) * nx + (dy - ay) * ny + (dz - az) * nz)
    // The planar test's tolerance in squared chords (the same length⁴
    // order), plus the radial part (GLOBE_RADIAL_EPS).
    const ad = sq(ax - dx) + sq(ay - dy) + sq(az - dz)
    const bd = sq(bx - dx) + sq(by - dy) + sq(bz - dz)
    const cd = sq(cx - dx) + sq(cy - dy) + sq(cz - dz)
    const scale = ad * bd + bd * cd + cd * ad
    return det > INCIRCLE_EPS * scale + GLOBE_RADIAL_EPS * (Math.abs(nx) + Math.abs(ny) + Math.abs(nz))
  }

  // orientG and inCircleG over vertex ids.
  private orientIds(a: number, b: number, c: number): number {
    const u = this.vu
    return PeriodicTriangulation.orientG(u[3 * a], u[3 * a + 1], u[3 * a + 2], u[3 * b], u[3 * b + 1], u[3 * b + 2], u[3 * c], u[3 * c + 1], u[3 * c + 2])
  }

  private inCircleIds(a: number, b: number, c: number, d: number): boolean {
    const u = this.vu
    return PeriodicTriangulation.inCircleG(u[3 * a], u[3 * a + 1], u[3 * a + 2], u[3 * b], u[3 * b + 1], u[3 * b + 2], u[3 * c], u[3 * c + 1], u[3 * c + 2], u[3 * d], u[3 * d + 1], u[3 * d + 2])
  }

  // Squared chord between two vertices on the unit sphere.
  private chordSq(a: number, b: number): number {
    const u = this.vu
    const i = 3 * a
    const j = 3 * b
    const dx = u[i] - u[j]
    const dy = u[i + 1] - u[j + 1]
    const dz = u[i + 2] - u[j + 2]
    return dx * dx + dy * dy + dz * dz
  }

  // The flip margin of the torus's orient checks, in squared chords.
  private orientMarginIds(a: number, d: number, p: number): number {
    return ORIENT_EPS * (this.chordSq(d, a) + this.chordSq(p, a))
  }

  // Circumcentre of triangle t on the unit sphere, into out[0..2]: the
  // outward normal of the plane through its corners. False when degenerate.
  circumcentreOnGlobe(t: number, out: Float64Array): boolean {
    const u = this.vu
    const a = 3 * this.tris[3 * t]
    const b = 3 * this.tris[3 * t + 1]
    const c = 3 * this.tris[3 * t + 2]
    const ux = u[b] - u[a]
    const uy = u[b + 1] - u[a + 1]
    const uz = u[b + 2] - u[a + 2]
    const wx = u[c] - u[a]
    const wy = u[c + 1] - u[a + 1]
    const wz = u[c + 2] - u[a + 2]
    // n points inward for a chart-counter-clockwise triangle: negate.
    const nx = uz * wy - uy * wz
    const ny = ux * wz - uz * wx
    const nz = uy * wx - ux * wy
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (l === 0) return false
    out[0] = nx / l
    out[1] = ny / l
    out[2] = nz / l
    return true
  }

  // The Voronoi cell of v on the globe: the spherical polygon of its star's
  // circumcentres, as a fan of spherical triangles (v, c_i, c_i+1), each by
  // Van Oosterom–Strackee, tan(E / 2) = det / (1 + v·c_i + c_i·c_i+1 +
  // c_i+1·v), signed as the planar shoelace is (an obtuse triangle's
  // circumcentre lies outside it, and its slice counts negative). The sum
  // over all nodes is the sphere's area exactly in exact arithmetic: each
  // edge's two slices make the quadrilateral of its two triangles' pieces.
  private readonly ccA = new Float64Array(3)
  private readonly ccB = new Float64Array(3)
  private readonly ccFirst = new Float64Array(3)

  private voronoiAreaOnGlobe(v: number): number {
    const u = this.vu
    const vx = u[3 * v]
    const vy = u[3 * v + 1]
    const vz = u[3 * v + 2]
    const start = this.vEdge[v]
    let e = start
    let prev = this.ccA
    let cur = this.ccB
    let first = true
    let excess = 0
    const slice = (p: Float64Array, q: Float64Array): number => {
      const num = PeriodicTriangulation.orientG(vx, vy, vz, p[0], p[1], p[2], q[0], q[1], q[2])
      const den = 1 + (vx * p[0] + vy * p[1] + vz * p[2]) + (p[0] * q[0] + p[1] * q[1] + p[2] * q[2]) + (q[0] * vx + q[1] * vy + q[2] * vz)
      return 2 * detAtan2(num, den)
    }
    do {
      const t = this.triangleOf(e)
      if (!this.circumcentreOnGlobe(t, cur)) {
        cur[0] = vx
        cur[1] = vy
        cur[2] = vz
      }
      if (first) {
        this.ccFirst.set(cur)
        first = false
      } else {
        excess += slice(prev, cur)
      }
      const swap = prev
      prev = cur
      cur = swap
      e = this.rotateCcw(e)
    } while (e !== start)
    excess += slice(prev, this.ccFirst)
    return excess * this.radius * this.radius
  }

  private readonly bq = new Float64Array(3)

  private barycentricOnGlobe(t: number, x: number, y: number, out: Float64Array): void {
    const q = this.bq
    this.unitOf(x, y, q, 0)
    const u = this.vu
    const a = 3 * this.tris[3 * t]
    const b = 3 * this.tris[3 * t + 1]
    const c = 3 * this.tris[3 * t + 2]
    // Each weight is the sub-triangle opposite its corner, chart-signed.
    let wa = PeriodicTriangulation.orientG(u[b], u[b + 1], u[b + 2], u[c], u[c + 1], u[c + 2], q[0], q[1], q[2])
    let wb = PeriodicTriangulation.orientG(u[c], u[c + 1], u[c + 2], u[a], u[a + 1], u[a + 2], q[0], q[1], q[2])
    let wc = PeriodicTriangulation.orientG(u[a], u[a + 1], u[a + 2], u[b], u[b + 1], u[b + 2], q[0], q[1], q[2])
    wa = Math.max(0, wa)
    wb = Math.max(0, wb)
    wc = Math.max(0, wc)
    const s = wa + wb + wc
    if (s === 0) {
      out[0] = out[1] = out[2] = 1 / 3
      return
    }
    out[0] = wa / s
    out[1] = wb / s
    out[2] = wc / s
  }

  // The walk on the globe: the torus's straight walk with the 3D
  // orientation and nothing carried (one sheet). A visibility walk on a
  // Delaunay triangulation of the sphere moves into the hemisphere of the
  // query at every step; should one ever circle, it gives up after the
  // torus's step bound and scans every triangle (`walkFallbacks`), which is
  // slow and still deterministic.
  private readonly q = new Float64Array(3)

  private locateOnGlobe(x: number, y: number, hint: number): number {
    let t = this.tAlive[hint] ? hint : this.anyAliveTriangle()
    const q = this.q
    this.unitOf(x, y, q, 0)
    const u = this.vu
    const maxSteps = this.triSlots * 2 + 16
    let steps = 0
    for (;;) {
      const a = 3 * this.tris[3 * t]
      const b = 3 * this.tris[3 * t + 1]
      const c = 3 * this.tris[3 * t + 2]
      const o0 = PeriodicTriangulation.orientG(u[a], u[a + 1], u[a + 2], u[b], u[b + 1], u[b + 2], q[0], q[1], q[2])
      const o1 = PeriodicTriangulation.orientG(u[b], u[b + 1], u[b + 2], u[c], u[c + 1], u[c + 2], q[0], q[1], q[2])
      const o2 = PeriodicTriangulation.orientG(u[c], u[c + 1], u[c + 2], u[a], u[a + 1], u[a + 2], q[0], q[1], q[2])
      let cross = -1
      let worst = 0
      if (o0 < worst) { worst = o0; cross = 0 }
      if (o1 < worst) { worst = o1; cross = 1 }
      if (o2 < worst) { worst = o2; cross = 2 }
      if (cross < 0) {
        this.classifyOnGlobe(t, o0, o1, o2)
        this.walkSteps += steps
        this.lastTri = t
        return t
      }
      t = this.triangleOf(this.twin[3 * t + cross])
      if (++steps > maxSteps) {
        this.walkFallbacks++
        return this.scanOnGlobe()
      }
    }
  }

  // Every triangle, the one whose least orientation toward the query is
  // largest: the containing one (its least is ≥ 0), the first of equals.
  private scanOnGlobe(): number {
    const q = this.q
    const u = this.vu
    let best = -1
    let bestMin = -Infinity
    let b0 = 0
    let b1 = 0
    let b2 = 0
    for (let t = 0; t < this.triSlots; t++) {
      if (!this.tAlive[t]) continue
      const a = 3 * this.tris[3 * t]
      const b = 3 * this.tris[3 * t + 1]
      const c = 3 * this.tris[3 * t + 2]
      const o0 = PeriodicTriangulation.orientG(u[a], u[a + 1], u[a + 2], u[b], u[b + 1], u[b + 2], q[0], q[1], q[2])
      const o1 = PeriodicTriangulation.orientG(u[b], u[b + 1], u[b + 2], u[c], u[c + 1], u[c + 2], q[0], q[1], q[2])
      const o2 = PeriodicTriangulation.orientG(u[c], u[c + 1], u[c + 2], u[a], u[a + 1], u[a + 2], q[0], q[1], q[2])
      const m = Math.min(o0, o1, o2)
      if (m > bestMin) {
        bestMin = m
        best = t
        b0 = o0
        b1 = o1
        b2 = o2
      }
    }
    if (best < 0) throw new Error('PeriodicTriangulation: no triangles')
    this.classifyOnGlobe(best, b0, b1, b2)
    this.lastTri = best
    return best
  }

  // classify's rule with the squared chords as the edge scale.
  private classifyOnGlobe(t: number, o0: number, o1: number, o2: number): void {
    this.onEdge = -1
    this.atVertex = -1
    const a = this.tris[3 * t]
    const b = this.tris[3 * t + 1]
    const c = this.tris[3 * t + 2]
    const e0 = o0 <= ON_EDGE_EPS * this.chordSq(a, b)
    const e1 = o1 <= ON_EDGE_EPS * this.chordSq(b, c)
    const e2 = o2 <= ON_EDGE_EPS * this.chordSq(c, a)
    if (e0 && e2) this.atVertex = 0
    else if (e0 && e1) this.atVertex = 1
    else if (e1 && e2) this.atVertex = 2
    else if (e0) this.onEdge = 0
    else if (e1) this.onEdge = 1
    else if (e2) this.onEdge = 2
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
    if (this.globe) return this.locateOnGlobe(x, y, hint)
    let t = this.tAlive[hint] ? hint : this.anyAliveTriangle()
    const f = this.f
    const d = this.d
    const maxSteps = this.triSlots * 2 + 16
    let steps = 0
    const { width, height } = this.domain
    // The image of the query the walk follows, carried from triangle to
    // triangle through the corner they share. Each triangle unwraps the
    // query against its own first corner as before, and keeps that image
    // only while it is the carried one: half a period away, two
    // neighbours whose first corners straddle the half-period line each
    // saw the other image, and handed the walk back and forth until it
    // gave up (2026-10-01: 2 in 20 000 far-hinted locates on 2048×1024,
    // 13 in 20 000 on a tile-sized torus).
    this.frame(t, f)
    this.domain.delta(x, y, f[0], f[1], d)
    let carriedX = f[0] + d.x
    let carriedY = f[1] + d.y
    for (;;) {
      this.domain.delta(x, y, f[0], f[1], d)
      let px = f[0] + d.x
      let py = f[1] + d.y
      if (Math.abs(px - carriedX) > width / 2) px = carriedX
      if (Math.abs(py - carriedY) > height / 2) py = carriedY
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
      // Across the edge: its end corner is the next triangle's corner `j`
      // (halfedge e starts at tris[e]; the twin runs the other way).
      const end = 2 * ((cross + 1) % 3)
      const oldX = f[end]
      const oldY = f[end + 1]
      const e2 = this.twin[3 * t + cross]
      t = this.triangleOf(e2)
      const j = 2 * (e2 - 3 * t)
      this.frame(t, f)
      carriedX = px + (f[j] - oldX)
      carriedY = py + (f[j + 1] - oldY)
      if (++steps > maxSteps) throw new Error('PeriodicTriangulation.locate: walk did not terminate')
    }
  }

  private classify(f: Float64Array, px: number, py: number, o0: number, o1: number, o2: number): void {
    this.onEdge = -1
    this.atVertex = -1
    const l0 = sq(f[2] - f[0]) + sq(f[3] - f[1])
    const l1 = sq(f[4] - f[2]) + sq(f[5] - f[3])
    const l2 = sq(f[0] - f[4]) + sq(f[1] - f[5])
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
    if (this.globe) {
      const vu = new Float64Array(cap * 3)
      vu.set(this.vu)
      this.vu = vu
    }
  }

  // Sizes the globe's unit-vector cache to the vertex arrays and fills
  // slots 0..count − 1 from their chart positions (buildFromTriangles).
  fillUnitVectors(count: number): void {
    if (!this.globe) return
    if (this.vu.length < this.vx.length * 3) {
      const vu = new Float64Array(this.vx.length * 3)
      vu.set(this.vu)
      this.vu = vu
    }
    for (let v = 0; v < count; v++) this.unitOf(this.vx[v], this.vy[v], this.vu, 3 * v)
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
    if (this.globe) {
      this.chartPoint(x, y)
      this.vx[v] = this.cp.x
      this.vy[v] = this.cp.y
      this.unitOf(this.cp.x, this.cp.y, this.vu, 3 * v)
    } else {
      this.vx[v] = this.domain.wrapX(Math.fround(this.domain.wrapX(x)))
      this.vy[v] = this.domain.wrapY(Math.fround(this.domain.wrapY(y)))
    }
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
    // On the globe the point is located where it will be stored (its
    // float32 chart position), so the triangle it splits is the one that
    // holds its stored self.
    if (this.globe) {
      this.chartPoint(x, y)
      x = this.cp.x
      y = this.cp.y
    }
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
    if (this.globe) {
      this.legaliseOnGlobe()
      return
    }
    const f = this.f
    const d = this.d
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
      this.domain.delta(this.vx[dv], this.vy[dv], ax, ay, d)
      const dx = ax + d.x
      const dy = ay + d.y
      if (!PeriodicTriangulation.inCircle(ax, ay, bx, by, px, py, dx, dy)) continue
      // Both triangles of the flip must be strictly counter-clockwise, by
      // a margin: a sliver flipped into existence is a sliver the next
      // removal trips over.
      const scale = sq(dx - ax) + sq(dy - ay) + sq(px - ax) + sq(py - ay)
      if (PeriodicTriangulation.orient(ax, ay, dx, dy, px, py) <= ORIENT_EPS * scale) continue
      if (PeriodicTriangulation.orient(dx, dy, bx, by, px, py) <= ORIENT_EPS * scale) continue
      const t2 = this.triangleOf(this.twin[e])
      this.flip(e)
      stack.push(3 * t, 3 * t + 2, 3 * t2, 3 * t2 + 1)
    }
  }

  // legalise with the globe's predicates, the same stack and flips.
  private legaliseOnGlobe(): void {
    const stack = this.stack
    while (stack.length > 0) {
      const e = stack.pop() as number
      const t = this.triangleOf(e)
      if (!this.tAlive[t]) continue
      const a = this.tris[e]
      const b = this.to(e)
      const p = this.apex(e)
      const dv = this.apex(this.twin[e])
      if (!this.inCircleIds(a, b, p, dv)) continue
      const margin = this.orientMarginIds(a, dv, p)
      if (this.orientIds(a, dv, p) <= margin) continue
      if (this.orientIds(dv, b, p) <= margin) continue
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
    const maxLenSq = sq(Math.min(this.domain.width, this.domain.height) * MAX_EDGE_FRACTION)
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
    if (this.globe) {
      if (this.orientIds(r, u, l) <= this.orientMarginIds(r, u, l)) return false
      for (let j = 0; j < n; j++) {
        const w = this.to(this.star[j])
        if (w === u || w === r || w === l) continue
        if (this.orientIds(r, u, w) >= 0 && this.orientIds(u, l, w) >= 0 && this.orientIds(l, r, w) >= 0) return false
      }
      return true
    }
    const rx = this.vx[r]
    const ry = this.vy[r]
    const d = this.d
    this.domain.delta(this.vx[u], this.vy[u], rx, ry, d)
    const ux = rx + d.x
    const uy = ry + d.y
    this.domain.delta(this.vx[l], this.vy[l], rx, ry, d)
    const lx = rx + d.x
    const ly = ry + d.y
    const area = PeriodicTriangulation.orient(rx, ry, ux, uy, lx, ly)
    const scale = sq(ux - rx) + sq(uy - ry) + sq(lx - rx) + sq(ly - ry)
    if (area <= ORIENT_EPS * scale) return false
    for (let j = 0; j < n; j++) {
      const w = this.to(this.star[j])
      if (w === u || w === r || w === l) continue
      this.domain.delta(this.vx[w], this.vy[w], rx, ry, d)
      const wx = rx + d.x
      const wy = ry + d.y
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
    if (this.globe) {
      for (let i = 0; i < n; i++) {
        const w = this.to(this.star[i])
        if (w === u || w === l || w === r) continue
        if (this.inCircleIds(r, u, l, w)) return false
      }
      return true
    }
    const rx = this.vx[r]
    const ry = this.vy[r]
    const d = this.d
    this.domain.delta(this.vx[u], this.vy[u], rx, ry, d)
    const ux = rx + d.x
    const uy = ry + d.y
    this.domain.delta(this.vx[l], this.vy[l], rx, ry, d)
    const lx = rx + d.x
    const ly = ry + d.y
    for (let i = 0; i < n; i++) {
      const w = this.to(this.star[i])
      if (w === u || w === l || w === r) continue
      this.domain.delta(this.vx[w], this.vy[w], rx, ry, d)
      const wx = rx + d.x
      const wy = ry + d.y
      if (PeriodicTriangulation.inCircle(rx, ry, ux, uy, lx, ly, wx, wy)) return false
    }
    return true
  }

  // The orientation of triangle t as stored, chart-positive: the planar
  // one in its frame on the torus (`f` the caller's scratch), the 3D one
  // on the globe. buildFromTriangles' orientation fix reads it.
  orientOf(t: number, f: Float64Array): number {
    if (this.globe) return this.orientIds(this.tris[3 * t], this.tris[3 * t + 1], this.tris[3 * t + 2])
    this.frame(t, f)
    return (f[2] - f[0]) * (f[5] - f[1]) - (f[3] - f[1]) * (f[4] - f[0])
  }

  // ------------------------------------------------------------ validation

  // Structural check for the harness: twins consistent, every triangle
  // counter-clockwise and alive-referencing, every vertex's edge current,
  // Euler's formula (the torus F = 2V, E = 3V; the sphere F = 2V − 4), the
  // edge margin, and (sampled or full) the empty-circumcircle property; on
  // the sphere also the Voronoi cells summing to 4πR² within 1e-9. Returns
  // the list of violations, empty when sound.
  validate(checkDelaunay = true): string[] {
    const errors: string[] = []
    const f = this.f
    const d = this.d
    let aliveT = 0
    const maxLenSq = sq(Math.min(this.domain.width, this.domain.height) * MAX_EDGE_FRACTION)
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
      if (this.globe) {
        const a = this.tris[3 * t]
        const b = this.tris[3 * t + 1]
        const c = this.tris[3 * t + 2]
        if (this.orientIds(a, b, c) <= 0) errors.push(`triangle ${t} not counter-clockwise on the globe`)
        if (checkDelaunay) {
          for (let i = 0; i < 3; i++) {
            const e = 3 * t + i
            if (this.inCircleIds(this.tris[e], this.to(e), this.apex(e), this.apex(this.twin[e]))) nonDelaunay++
          }
        }
        continue
      }
      this.frame(t, f)
      if (PeriodicTriangulation.orient(f[0], f[1], f[2], f[3], f[4], f[5]) <= 0) errors.push(`triangle ${t} not counter-clockwise`)
      if (checkDelaunay) {
        for (let i = 0; i < 3; i++) {
          const e = 3 * t + i
          const dv = this.apex(this.twin[e])
          this.domain.delta(this.vx[dv], this.vy[dv], f[0], f[1], d)
          const dx = f[0] + d.x
          const dy = f[1] + d.y
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
    if (this.globe) {
      // Euler's formula for the sphere, V − E + F = 2 with E = 3F / 2, and
      // the Voronoi cells tiling the globe.
      if (aliveT !== 2 * aliveV - 4) errors.push(`Euler: ${aliveT} triangles for ${aliveV} vertices (the sphere needs 2V − 4)`)
      let area = 0
      for (let v = 0; v < this.vertexSlots; v++) if (this.vAlive[v]) area += this.voronoiArea(v)
      const sphere = (this.domain.width * this.domain.width) / Math.PI
      if (!(Math.abs(area - sphere) <= 1e-9 * sphere)) errors.push(`Voronoi areas sum to ${area} against the sphere's ${sphere}`)
    } else if (aliveT !== 2 * aliveV) errors.push(`Euler: ${aliveT} triangles for ${aliveV} vertices (torus needs 2V)`)
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
  if (mesh.globe) {
    // The sphere's chart point, as insert stores it (a wrapY alone would not
    // turn the longitude of a point past a pole).
    const p = { x: 0, y: 0 }
    for (let v = 0; v < count; v++) {
      domain.wrapPoint(xs[v], ys[v], p)
      mesh.vx[v] = domain.wrapX(Math.fround(p.x))
      mesh.vy[v] = Math.fround(p.y)
    }
    mesh.fillUnitVectors(count)
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
    const o = mesh.orientOf(t, f)
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
