import { mulberry32 } from '../core/rng'
import { hilbertOrder } from './hilbert'
import { MESH_TUNING } from './meshDensity'
import type { MeshState } from './meshState'
import type { PeriodicTriangulation } from './periodicDelaunay'
import { sq } from '../core/detMath'

// REMESHING with hysteresis (decision 8 of docs/decisions/adaptive-mesh.md).
// Between epochs — and, from a bare lattice, as the way the mesh is built
// in the first place — nodes are inserted where an edge is longer than
// `insertRatio` times the target spacing and removed where a node's
// spacing has fallen under `removeRatio` times it. The target is the
// caller's function of the vertex (the density rule over the node's
// state); the two operations only compare lengths to it.
//
// Determinism: candidates are collected per round and inserted (removed)
// in Hilbert order; a candidate's jitter comes from a generator seeded per
// round; the triangulation is single-threaded. The same mesh, state, seed
// and target function give the same mesh.
//
// Insertion places a node near the midpoint of a long edge, jittered
// across it by a fraction of its length: exactly on the edge would split
// the lattice into a lattice (a regular mesh has the direction bias the
// TIN exists to remove — design/adaptive-mesh.md), and the jitter is what
// makes the six neighbours point in random directions. A candidate is
// dropped when its edge no longer exists by insertion time (a neighbour's
// insertion flipped it) or when it would land within `removeRatio` of the
// target from an existing node — which is what keeps a refine from
// producing nodes the next coarsen removes.
//
// State inheritance (meshState.ts): a new node interpolates from its
// triangle before `sample` (if given) overwrites what is sampled from a
// field; a removed node hands its extensive fields to its neighbours.

export interface RefineOptions {
  seed: number
  // Called for every inserted vertex after its state was interpolated —
  // the place to set sampled fields (height from a field function). `a`,
  // `b`, `c` are the corners it was interpolated from.
  sample?: (v: number, x: number, y: number, a: number, b: number, c: number) => void
  maxRounds?: number
  // Jitter across the edge, as a fraction of its length.
  jitter?: number
}

export interface RemeshStats {
  rounds: number
  inserted: number
  removed: number
  // Per round, how many nodes went in (refine, positive) or out (coarsen,
  // negative in a combined trace) — the convergence trace the harness
  // reads.
  perRound: number[]
}

// A target spacing per vertex in DOMAIN units, recomputed by the caller
// whenever the state changed (the refine calls it once per round).
export type TargetSpacing = (mesh: PeriodicTriangulation, targets: Float64Array) => void

const scratch = new Int32Array(256)

// Inserts until no edge exceeds the insertion threshold (or `maxRounds`).
export function refine(mesh: PeriodicTriangulation, state: MeshState, target: TargetSpacing, options: RefineOptions): RemeshStats {
  const maxRounds = options.maxRounds ?? 24
  const jitter = options.jitter ?? 0.25
  const insertRatio = MESH_TUNING.insertRatio
  const removeRatio = MESH_TUNING.removeRatio
  let targets = new Float64Array(mesh.vx.length)
  let inserted = 0
  let round = 0
  const perRound: number[] = []
  const bary = new Float64Array(3)
  for (; round < maxRounds; round++) {
    state.ensure(mesh)
    if (targets.length < mesh.vertexSlots) targets = new Float64Array(mesh.vx.length)
    target(mesh, targets)
    // Candidates: one per long edge (each undirected edge once — the
    // halfedge with the smaller id).
    const cx: number[] = []
    const cy: number[] = []
    const ca: number[] = []
    const cb: number[] = []
    const d = mesh.domain
    for (let t = 0; t < mesh.triSlots; t++) {
      if (!mesh.tAlive[t]) continue
      for (let i = 0; i < 3; i++) {
        const e = 3 * t + i
        if (mesh.twin[e] < e) continue
        const a = mesh.tris[e]
        const b = mesh.to(e)
        const h = Math.min(targets[a], targets[b])
        const lsq = mesh.edgeLengthSq(e)
        if (lsq <= sq(insertRatio * h)) continue
        const ax = mesh.vx[a]
        const ay = mesh.vy[a]
        cx.push(ax + d.deltaX(mesh.vx[b], ax) / 2)
        cy.push(ay + d.deltaY(mesh.vy[b], ay) / 2)
        ca.push(a)
        cb.push(b)
      }
    }
    if (cx.length === 0) break
    const order = hilbertOrder(cx, cy, cx.length, d.width, d.height)
    const rng = mulberry32((options.seed ^ Math.imul(round + 1, 0x9e3779b1)) >>> 0)
    let insertedThisRound = 0
    for (let k = 0; k < order.length; k++) {
      const c = order[k]
      const a = ca[c]
      const b = cb[c]
      // The edge must still exist.
      if (!mesh.vAlive[a] || !mesh.vAlive[b] || !adjacent(mesh, a, b)) continue
      const ax = mesh.vx[a]
      const ay = mesh.vy[a]
      const ex = d.deltaX(mesh.vx[b], ax)
      const ey = d.deltaY(mesh.vy[b], ay)
      // Across the edge (its left normal), a symmetric jitter; along it a
      // smaller one so the split is not always exactly halfway.
      const across = (rng() * 2 - 1) * jitter
      const along = 0.5 + (rng() * 2 - 1) * jitter * 0.5
      let px = d.wrapX(ax + ex * along - ey * across)
      let py = d.wrapY(ay + ey * along + ex * across)
      let t = mesh.locate(px, py, mesh.triangleOf(mesh.vEdge[a]))
      if (mesh.atVertex >= 0) continue
      let ta = mesh.tris[3 * t]
      let tb = mesh.tris[3 * t + 1]
      let tc = mesh.tris[3 * t + 2]
      // Too close to a corner of the triangle — the coarsen would undo it:
      // fall back to the plain midpoint, which sits half an edge from
      // both ends by construction; if even that is crowded (a sliver),
      // the edge stays long and the harness counts it.
      if (tooClose(mesh, px, py, ta, tb, tc, removeRatio, targets)) {
        px = d.wrapX(ax + ex / 2)
        py = d.wrapY(ay + ey / 2)
        t = mesh.locate(px, py, t)
        if (mesh.atVertex >= 0) continue
        ta = mesh.tris[3 * t]
        tb = mesh.tris[3 * t + 1]
        tc = mesh.tris[3 * t + 2]
        if (tooClose(mesh, px, py, ta, tb, tc, removeRatio, targets)) continue
      }
      barycentric(mesh, t, px, py, bary)
      const v = mesh.insert(px, py, t)
      state.ensure(mesh)
      if (targets.length < mesh.vertexSlots) {
        const grown = new Float64Array(mesh.vx.length)
        grown.set(targets)
        targets = grown
      }
      state.inheritInsert(v, ta, tb, tc, bary[0], bary[1], bary[2])
      // A new node's target until the next round: its parents' finest.
      targets[v] = Math.min(targets[ta], targets[tb], targets[tc])
      options.sample?.(v, mesh.vx[v], mesh.vy[v], ta, tb, tc)
      insertedThisRound++
    }
    inserted += insertedThisRound
    perRound.push(insertedThisRound)
    if (insertedThisRound === 0) break
  }
  return { rounds: round, inserted, removed: 0, perRound }
}

export interface CoarsenOptions {
  maxRounds?: number
}

// Removes nodes whose spacing (mean incident edge length) is below the
// removal threshold, in Hilbert order, re-reading the live lengths so
// that of two crowded neighbours only one goes.
//
// The threshold is against the node's EFFECTIVE target: the finest of its
// own and its neighbours'. Insertion bounds every edge by the finer of
// its two endpoints, so a plain node next to a mountain node must keep
// that edge short whatever its own target says — the mesh is graded, and
// a removal judged against the node's own coarse target would take the
// grading out and the next refine would put it back. Measured on the
// first build: 6 % of the nodes churned per remesh on an unchanged state
// with the node's own target, none with the effective one.
export function coarsen(mesh: PeriodicTriangulation, state: MeshState, target: TargetSpacing, options: CoarsenOptions = {}): RemeshStats {
  const maxRounds = options.maxRounds ?? 4
  const removeRatio = MESH_TUNING.removeRatio
  let targets = new Float64Array(mesh.vx.length)
  let removed = 0
  let round = 0
  const perRound: number[] = []
  const before = new Float64Array(256)
  const after = new Float64Array(256)
  for (; round < maxRounds; round++) {
    state.ensure(mesh)
    if (targets.length < mesh.vertexSlots) targets = new Float64Array(mesh.vx.length)
    target(mesh, targets)
    const order = hilbertOrder(mesh.vx, mesh.vy, mesh.vertexSlots, mesh.domain.width, mesh.domain.height)
    let removedThisRound = 0
    for (let k = 0; k < order.length; k++) {
      const v = order[k]
      if (!mesh.vAlive[v]) continue
      const n = mesh.neighbours(v, scratch)
      if (n > before.length) continue
      let h = targets[v]
      for (let i = 0; i < n; i++) if (targets[scratch[i]] < h) h = targets[scratch[i]]
      if (meanSpacing(mesh, v) >= removeRatio * h) continue
      const areaV = mesh.voronoiArea(v)
      for (let i = 0; i < n; i++) before[i] = mesh.voronoiArea(scratch[i])
      // The neighbour list must survive the removal for the merge: copy.
      const nbrs = scratch.slice(0, n)
      if (!mesh.remove(v)) continue
      for (let i = 0; i < n; i++) after[i] = mesh.voronoiArea(nbrs[i])
      state.inheritRemove(v, nbrs, n, before, after, areaV)
      removedThisRound++
    }
    removed += removedThisRound
    perRound.push(removedThisRound)
    if (removedThisRound === 0) break
  }
  return { rounds: round, inserted: 0, removed, perRound }
}

// Coarsen, then refine: the between-epochs step.
export function remesh(mesh: PeriodicTriangulation, state: MeshState, target: TargetSpacing, options: RefineOptions & CoarsenOptions): RemeshStats {
  const c = coarsen(mesh, state, target, options)
  const r = refine(mesh, state, target, options)
  return { rounds: c.rounds + r.rounds, inserted: r.inserted, removed: c.removed, perRound: [...c.perRound, ...r.perRound] }
}

export function meanSpacing(mesh: PeriodicTriangulation, v: number): number {
  const start = mesh.vEdge[v]
  let e = start
  let sum = 0
  let n = 0
  do {
    sum += mesh.edgeLength(e)
    n++
    e = mesh.rotateCcw(e)
  } while (e !== start)
  return sum / n
}

function tooClose(mesh: PeriodicTriangulation, px: number, py: number, a: number, b: number, c: number, ratio: number, targets: Float64Array): boolean {
  const d = mesh.domain
  const h = ratio * Math.min(targets[a], targets[b], targets[c])
  const hsq = h * h
  return d.distanceSq(px, py, mesh.vx[a], mesh.vy[a]) < hsq
    || d.distanceSq(px, py, mesh.vx[b], mesh.vy[b]) < hsq
    || d.distanceSq(px, py, mesh.vx[c], mesh.vy[c]) < hsq
}

function adjacent(mesh: PeriodicTriangulation, a: number, b: number): boolean {
  const start = mesh.vEdge[a]
  let e = start
  do {
    if (mesh.to(e) === b) return true
    e = mesh.rotateCcw(e)
  } while (e !== start)
  return false
}

const frame = new Float64Array(6)

// Barycentric weights of (x, y) in triangle t, clamped to the simplex.
export function barycentric(mesh: PeriodicTriangulation, t: number, x: number, y: number, out: Float64Array): void {
  mesh.frame(t, frame)
  const px = frame[0] + mesh.domain.deltaX(x, frame[0])
  const py = frame[1] + mesh.domain.deltaY(y, frame[1])
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
