import { globeFrame, type GlobeFrame } from '../core/domain'
import { detAsin, detExp } from '../core/detMath'
import { apexCotangent } from './meshErosion'
import type { PeriodicTriangulation } from './periodicDelaunay'

// NEIGHBOURHOODS IN METRES ON A TERRAIN MESH (DEC-0036 phase 7, docs/
// decisions/fields-on-meshes.md fork 2): what the ecology's windows became
// when it left the 2048 raster — "is there water within reach", "how much
// of the land around is sea", a deposit's halo, a node's slope — on the
// adaptive mesh's nodes, every length in metres, both shapes (the distance
// the globe's arc on the sphere, the chart's on the torus).
//
// A node stands for its Voronoi cell, which on this mesh may be anything
// from 2 to 160 km across, so a neighbourhood is not "the nodes within r":
// it is the CELLS the disc of radius r about the node reaches, each cell
// taken as the disc of its own area (radius ρ = √(a / π)), and a mean
// weighs each by the area of that disc inside the reach (the lens of the
// two circles). On a raster of 7.8 km pixels a reach of one pixel is then
// the pixel's eight neighbours, the window the raster's maxWithin took; on
// a coarse land node a reach of 8 km is the node itself, the water the
// mesh resolves. The cells are gathered by a walk over the triangulation
// from the node, through the cells that touch the reach.

// The mesh's cells and stars in metres: what a neighbourhood walks.
export interface MeshStar {
  readonly mesh: PeriodicTriangulation
  // Metres per domain unit.
  readonly unitM: number
  // Per slot: the Voronoi area, m², and the radius of a disc of that area, m.
  readonly areaM2: Float64Array
  readonly rho: Float64Array
  // The Delaunay star per slot as a CSR table: the neighbour.
  readonly starStart: Int32Array
  readonly star: Int32Array
  // The distance between two slots, and from a slot to a point, metres.
  distanceM(a: number, b: number): number
  distanceToPointM(v: number, x: number, y: number): number
}

// The star with its edges measured: per entry of the star, the edge's
// length (m) and its Voronoi wall (m).
export interface MeshGeometry extends MeshStar {
  readonly lengthM: Float64Array
  readonly wallM: Float64Array
}

// The cells and stars alone, without the edges' lengths and walls: what
// the neighbourhoods need (the column's balance in pipeline/coupledEpoch
// reads it every epoch; the walls were 2/3 of its time, DEC-0036 phase
// 8g-2).
export function meshStar(mesh: PeriodicTriangulation, unitM: number): MeshStar {
  const slots = mesh.vertexSlots
  const { domain } = mesh
  const areaM2 = new Float64Array(slots)
  const rho = new Float64Array(slots)
  for (let v = 0; v < slots; v++) {
    if (!mesh.vAlive[v]) continue
    areaM2[v] = mesh.voronoiArea(v) * unitM * unitM
    rho[v] = Math.sqrt(areaM2[v] / Math.PI)
  }
  const starStart = new Int32Array(slots + 1)
  const out = new Int32Array(256)
  let edges = 0
  for (let v = 0; v < slots; v++) {
    starStart[v] = edges
    if (mesh.vAlive[v]) edges += mesh.degree(v)
  }
  starStart[slots] = edges
  const star = new Int32Array(edges)
  for (let v = 0; v < slots; v++) {
    if (!mesh.vAlive[v]) continue
    const n = mesh.outgoing(v, out)
    const base = starStart[v]
    for (let k = 0; k < n; k++) star[base + k] = mesh.to(out[k])
  }
  // The distance: on the sphere the arc between the unit vectors, R · 2
  // asin(chord / 2) (the triangulation's own cache, PeriodicTriangulation.vu);
  // on the torus the Domain's.
  const globe = mesh.globe && domain.noise.kind === 'globe'
  const radiusM = (domain.width / (2 * Math.PI)) * unitM
  const vu = mesh.vu
  const frame: GlobeFrame = globeFrame()
  const arcOf = (dx: number, dy: number, dz: number): number => radiusM * 2 * detAsin(Math.min(1, Math.sqrt(dx * dx + dy * dy + dz * dz) / 2))
  return {
    mesh, unitM, areaM2, rho, starStart, star,
    distanceM: globe
      ? (a, b) => arcOf(vu[3 * a] - vu[3 * b], vu[3 * a + 1] - vu[3 * b + 1], vu[3 * a + 2] - vu[3 * b + 2])
      : (a, b) => Math.sqrt(domain.distanceSq(mesh.vx[a], mesh.vy[a], mesh.vx[b], mesh.vy[b])) * unitM,
    distanceToPointM: globe
      ? (v, x, y) => {
        const noise = domain.noise
        if (noise.kind !== 'globe') return 0
        noise.frame(x, y, frame)
        const r = noise.radius
        return arcOf(vu[3 * v] - frame.px / r, vu[3 * v + 1] - frame.py / r, vu[3 * v + 2] - frame.pz / r)
      }
      : (v, x, y) => Math.sqrt(domain.distanceSq(mesh.vx[v], mesh.vy[v], x, y)) * unitM,
  }
}

export function meshGeometry(mesh: PeriodicTriangulation, unitM: number): MeshGeometry {
  const cells = meshStar(mesh, unitM)
  const { starStart } = cells
  const edges = starStart[mesh.vertexSlots]
  const out = new Int32Array(256)
  const lengthM = new Float64Array(edges)
  const wallM = new Float64Array(edges)
  const cotAt = apexCotangent(mesh)
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v]) continue
    const n = mesh.outgoing(v, out)
    const base = starStart[v]
    for (let k = 0; k < n; k++) {
      const e = out[k]
      const len = mesh.edgeLength(e)
      lengthM[base + k] = len * unitM
      wallM[base + k] = len * unitM * Math.max(0, (cotAt(e) + cotAt(mesh.twin[e])) / 2)
    }
  }
  return { ...cells, lengthM, wallM }
}

// The area of the lens two discs of radii r and R share at distance d.
function lensArea(r: number, R: number, d: number): number {
  if (d >= r + R) return 0
  if (d <= Math.abs(r - R)) {
    const m = Math.min(r, R)
    return Math.PI * m * m
  }
  const acos = (x: number): number => Math.PI / 2 - detAsin(Math.max(-1, Math.min(1, x)))
  const a = r * r * acos((d * d + r * r - R * R) / (2 * d * r))
  const b = R * R * acos((d * d + R * R - r * r) / (2 * d * R))
  const c = 0.5 * Math.sqrt(Math.max(0, (-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R)))
  return a + b - c
}

// The cells within `radiusM` of each node `centre` admits (all alive nodes
// when null), with their lens weights, m²: a CSR table per slot (an
// unadmitted slot has none). Every centre holds itself.
export interface Neighbourhoods {
  readonly start: Int32Array
  readonly member: Int32Array
  readonly weight: Float32Array
}

export function neighbourhoods(geo: MeshStar, radiusM: number, centre: Uint8Array | null = null): Neighbourhoods {
  const { mesh, rho, starStart, star } = geo
  const slots = mesh.vertexSlots
  const start = new Int32Array(slots + 1)
  let member = new Int32Array(Math.max(16, slots * 8))
  let weight = new Float32Array(member.length)
  let count = 0
  const stamp = new Int32Array(slots).fill(-1)
  const queue: number[] = []
  for (let i = 0; i < slots; i++) {
    start[i] = count
    if (!mesh.vAlive[i] || (centre && !centre[i])) continue
    queue.length = 0
    queue.push(i)
    stamp[i] = i
    for (let q = 0; q < queue.length; q++) {
      const j = queue[q]
      const d = j === i ? 0 : geo.distanceM(i, j)
      const w = lensArea(radiusM, rho[j], d)
      if (w <= 0 && j !== i) continue
      if (count === member.length) {
        const grownM = new Int32Array(member.length * 2)
        grownM.set(member)
        member = grownM
        const grownW = new Float32Array(weight.length * 2)
        grownW.set(weight)
        weight = grownW
      }
      member[count] = j
      weight[count] = w
      count++
      for (let e = starStart[j]; e < starStart[j + 1]; e++) {
        const k = star[e]
        if (stamp[k] === i) continue
        stamp[k] = i
        queue.push(k)
      }
    }
  }
  start[slots] = count
  return { start, member: member.subarray(0, count), weight: weight.subarray(0, count) }
}

// The largest value over each neighbourhood ("is there water within
// reach"); 0 where a slot has none.
export function maxWithin(nb: Neighbourhoods, field: ArrayLike<number>): Float32Array {
  const slots = nb.start.length - 1
  const out = new Float32Array(slots)
  for (let i = 0; i < slots; i++) {
    let m = -Infinity
    for (let k = nb.start[i]; k < nb.start[i + 1]; k++) {
      const v = field[nb.member[k]]
      if (v > m) m = v
    }
    out[i] = m === -Infinity ? 0 : m
  }
  return out
}

// The lens-weighted mean over each neighbourhood ("how much of the land
// around is sea"); 0 where a slot has none.
export function meanWithin(nb: Neighbourhoods, field: ArrayLike<number>): Float32Array {
  const slots = nb.start.length - 1
  const out = new Float32Array(slots)
  for (let i = 0; i < slots; i++) {
    let sum = 0
    let total = 0
    for (let k = nb.start[i]; k < nb.start[i + 1]; k++) {
      sum += nb.weight[k] * field[nb.member[k]]
      total += nb.weight[k]
    }
    out[i] = total > 0 ? sum / total : 0
  }
  return out
}

// The node under a point: the heaviest corner of the triangle it lies in.
export function nodeAt(mesh: PeriodicTriangulation, x: number, y: number, scratch: Float64Array = new Float64Array(3)): number {
  const t = mesh.locate(x, y)
  mesh.barycentric(t, x, y, scratch)
  const k = scratch[0] >= scratch[1] && scratch[0] >= scratch[2] ? 0 : scratch[1] >= scratch[2] ? 1 : 2
  return mesh.tris[3 * t + k]
}

// The nodes whose cells a disc of `reachM` about a point reaches, each with
// its distance to the point (metres), from the node under the point
// outward over the triangulation: `visit(v, d)`.
export function aroundPoint(geo: MeshStar, x: number, y: number, reachM: number, visit: (v: number, distanceM: number) => void, stamp: Int32Array, mark: number): void {
  const { mesh, rho, starStart, star } = geo
  const first = nodeAt(mesh, x, y)
  const queue = [first]
  stamp[first] = mark
  for (let q = 0; q < queue.length; q++) {
    const j = queue[q]
    const d = geo.distanceToPointM(j, x, y)
    if (d - rho[j] > reachM && j !== first) continue
    visit(j, d)
    for (let e = starStart[j]; e < starStart[j + 1]; e++) {
      const k = star[e]
      if (stamp[k] === mark) continue
      stamp[k] = mark
      queue.push(k)
    }
  }
}

// A soft Gaussian halo (0..1, union-max) about each point, σ `sigmaM`, out
// to three σ: a deposit's influence (the ecology's copper, tin, obsidian,
// volcanic soil …). Per slot.
export function gaussianHalos(geo: MeshGeometry, points: readonly { x: number; y: number }[], sigmaM: number): Float32Array {
  const slots = geo.mesh.vertexSlots
  const field = new Float32Array(slots)
  if (points.length === 0 || sigmaM <= 0) return field
  const reach = 3 * sigmaM
  const inv2s2 = 1 / (2 * sigmaM * sigmaM)
  const stamp = new Int32Array(slots).fill(-1)
  for (let p = 0; p < points.length; p++) {
    aroundPoint(geo, points[p].x, points[p].y, reach, (v, d) => {
      if (d > reach) return
      const bump = detExp(-(d * d) * inv2s2)
      if (bump > field[v]) field[v] = bump
    }, stamp, p)
  }
  return field
}

// 1 on the cells a disc of `reachM` about each point reaches (an oasis's
// gardens). Per slot.
export function discsAround(geo: MeshGeometry, points: readonly { x: number; y: number }[], reachM: number): Float32Array {
  const slots = geo.mesh.vertexSlots
  const field = new Float32Array(slots)
  const stamp = new Int32Array(slots).fill(-1)
  for (let p = 0; p < points.length; p++) aroundPoint(geo, points[p].x, points[p].y, reachM, (v) => { field[v] = 1 }, stamp, p)
  return field
}

// The slope per node, |∇z| in z's units per metre: Green–Gauss over the
// Voronoi cell — Σ wall · (z_j − z_i) / 2 · n̂_ij / area, n̂ the unit
// offset to the neighbour in the node's own frame (Domain.delta).
export function slopeOf(geo: MeshGeometry, z: ArrayLike<number>): Float32Array {
  const { mesh, starStart, star, wallM, areaM2 } = geo
  const { domain } = mesh
  const slots = mesh.vertexSlots
  const out = new Float32Array(slots)
  const d = { x: 0, y: 0 }
  for (let v = 0; v < slots; v++) {
    if (!mesh.vAlive[v] || areaM2[v] <= 0) continue
    let gx = 0
    let gy = 0
    for (let e = starStart[v]; e < starStart[v + 1]; e++) {
      const u = star[e]
      domain.delta(mesh.vx[u], mesh.vy[u], mesh.vx[v], mesh.vy[v], d)
      const len = Math.sqrt(d.x * d.x + d.y * d.y)
      if (len === 0) continue
      const k = (wallM[e] * (z[u] - z[v])) / 2 / len
      gx += k * d.x
      gy += k * d.y
    }
    out[v] = Math.sqrt(gx * gx + gy * gy) / areaM2[v]
  }
  return out
}

// The share of a node's Voronoi boundary that faces a neighbour `differs`
// from, per unit of its area and scaled by `lengthM` / 4: a biome
// boundary's length per area, in the unit a raster of `lengthM` pixels
// counted it in (the share of a pixel's four sides) — so a mean of it is
// the same figure whatever the mesh's spacing. 0 off `use`.
export function boundaryDensity(geo: MeshGeometry, use: Uint8Array, differs: (a: number, b: number) => boolean, lengthM: number): Float32Array {
  const { mesh, starStart, star, wallM, areaM2 } = geo
  const slots = mesh.vertexSlots
  const out = new Float32Array(slots)
  for (let v = 0; v < slots; v++) {
    if (!use[v] || areaM2[v] <= 0) continue
    let wall = 0
    for (let e = starStart[v]; e < starStart[v + 1]; e++) if (differs(v, star[e])) wall += wallM[e]
    out[v] = (wall * lengthM) / (4 * areaM2[v])
  }
  return out
}
