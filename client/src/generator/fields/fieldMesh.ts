import type { Domain } from '../core/domain'
import { globeFrame } from '../core/domain'
import { detAtan2 } from '../core/detMath'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'
import { centroidalGeodesicLattice, hexLattice } from '../mesh/lattice'
import { hintGrid } from '../mesh/meshSampler'

// THE FIELD MESH (DEC-0036, docs/decisions/fields-on-meshes.md, phase 0):
// a UNIFORM mesh over a Domain at one spacing in metres, for the coarse
// global fields (mantle, ocean age, climate, flexure). The values sit on
// the vertices of the bootstrap lattice's triangulation, and each vertex
// owns its Voronoi cell: on the sphere the Goldberg dual of the subdivided
// icosahedron relaxed into a centroidal tessellation (mesh/lattice.ts
// centroidalGeodesicLattice, since phase 3: 12 pentagons, the rest
// hexagons, the areas within × 1.5), on the torus the hexagonal lattice
// (hexLattice). The
// triangulation stays for locate and barycentric interpolation; the cells
// carry the finite volumes (fields/fieldOperators.ts).
//
// Everything a later stage asks of the geometry is computed once, here, in
// Float64 and in METRES:
//   centre   the chart point (x, y) and on the sphere the unit vector u;
//   area     the cell's true area (voronoiArea), m², summing to 4πR² or
//            W · H;
//   walls    per directed edge i → j (CSR, `nbrStart`): the wall between
//            the two cells (the arc between the circumcentres of the edge's
//            two triangles, SIGNED as the Voronoi area is: positive on a
//            Delaunay mesh) and the centre distance (the edge's arc);
//   offset   j's centre seen from i, in i's tangent frame (the log map:
//            direction × arc), metres;
//   turn     the parallel transport of a vector from j's frame into i's,
//            a rotation (cos, sin) — the identity on the torus;
//   gradient the least-squares weights per edge (fieldOperators.gradient).
//
// THE FRAME of a cell is the Domain's: east (+x) and SOUTH (+y, the
// chart's row direction), the frame `delta`, `advance` and `transport`
// read and write in — so a vector goes into Domain.advance without a sign.
// North is −south. On the sphere the frame is noise.frame's at the cell's
// chart point (no lattice node lies at a pole: geodesicLattice's tilt,
// which the relaxation moves by less than a spacing).
//
// Neighbour order is fixed: counter-clockwise (chart sense) around the
// cell, starting at the neighbour with the lowest id. The construction is
// single-threaded and reads only the domain and the spacing, so the same
// inputs give the same bytes (fields harness, determinism).
export interface FieldMesh {
  readonly domain: Domain
  readonly tri: PeriodicTriangulation
  // The spacing asked for, metres, and what the lattice made of it.
  readonly spacingM: number
  readonly count: number
  // Metres per domain unit (domain.metresPerUnit) and, on the sphere, the
  // globe's radius in metres (0 on the torus).
  readonly unitM: number
  readonly radiusM: number
  readonly globe: boolean
  // Per cell.
  readonly x: Float64Array
  readonly y: Float64Array
  // Unit vector, east axis, south axis (3D, interleaved xyz); empty on the
  // torus.
  readonly u: Float64Array
  readonly east: Float64Array
  readonly south: Float64Array
  readonly area: Float64Array
  // Per directed edge, CSR: the edges of cell i are nbrStart[i] ..
  // nbrStart[i + 1] − 1; `rev[e]` is the edge of the neighbour back to i.
  readonly nbrStart: Int32Array
  readonly nbr: Int32Array
  readonly rev: Int32Array
  readonly wall: Float64Array
  readonly dist: Float64Array
  // wall / dist, the finite-volume coupling (symmetric: k[e] = k[rev[e]]).
  readonly coupling: Float64Array
  readonly offE: Float64Array
  readonly offS: Float64Array
  readonly turnC: Float64Array
  readonly turnS: Float64Array
  readonly gradE: Float64Array
  readonly gradS: Float64Array
  // Cells with five neighbours (the sphere's twelve) and the largest degree.
  readonly pentagons: number
  readonly maxDegree: number
}

export function createFieldMesh(domain: Domain, spacingM: number): FieldMesh {
  const unitM = domain.metresPerUnit
  const tri = domain.kind === 'sphere' ? centroidalGeodesicLattice(domain, spacingM / unitM) : hexLattice(domain, spacingM / unitM)
  const count = tri.vertexSlots
  if (tri.aliveVertices !== count) throw new Error('createFieldMesh: the lattice has dead vertex slots')
  const globe = tri.globe
  const radiusUnits = domain.width / (2 * Math.PI)
  const radiusM = globe ? radiusUnits * unitM : 0
  const x = Float64Array.from(tri.vx.subarray(0, count))
  const y = Float64Array.from(tri.vy.subarray(0, count))
  const u = new Float64Array(globe ? 3 * count : 0)
  const east = new Float64Array(globe ? 3 * count : 0)
  const south = new Float64Array(globe ? 3 * count : 0)
  if (globe) {
    const noise = domain.noise
    if (noise.kind !== 'globe') throw new Error('createFieldMesh: a sphere domain without a globe')
    const gf = globeFrame()
    for (let i = 0; i < count; i++) {
      // The triangulation's own unit vector (the same formula as
      // noise.frame, from the same float32 chart point), so the geometry
      // here and the triangulation's predicates read one point.
      u[3 * i] = tri.vu[3 * i]
      u[3 * i + 1] = tri.vu[3 * i + 1]
      u[3 * i + 2] = tri.vu[3 * i + 2]
      noise.frame(x[i], y[i], gf)
      east[3 * i] = gf.ex
      east[3 * i + 1] = gf.ey
      east[3 * i + 2] = gf.ez
      south[3 * i] = gf.sx
      south[3 * i + 1] = gf.sy
      south[3 * i + 2] = gf.sz
    }
  }
  const area = new Float64Array(count)
  const areaUnit = unitM * unitM
  for (let i = 0; i < count; i++) area[i] = tri.voronoiArea(i) * areaUnit

  // The CSR table: each cell's outgoing halfedges, counter-clockwise,
  // rotated to start at the lowest neighbour id.
  const nbrStart = new Int32Array(count + 1)
  const scratch = new Int32Array(64)
  let pentagons = 0
  let maxDegree = 0
  for (let i = 0; i < count; i++) {
    const n = tri.degree(i)
    nbrStart[i + 1] = nbrStart[i] + n
    if (n === 5) pentagons++
    if (n > maxDegree) maxDegree = n
  }
  const edges = nbrStart[count]
  const halfedge = new Int32Array(edges)
  const nbr = new Int32Array(edges)
  for (let i = 0; i < count; i++) {
    const n = tri.outgoing(i, scratch)
    let first = 0
    for (let k = 1; k < n; k++) if (tri.to(scratch[k]) < tri.to(scratch[first])) first = k
    const base = nbrStart[i]
    for (let k = 0; k < n; k++) {
      const e = scratch[(first + k) % n]
      halfedge[base + k] = e
      nbr[base + k] = tri.to(e)
    }
  }
  const rev = new Int32Array(edges)
  for (let i = 0; i < count; i++) {
    for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) {
      const j = nbr[e]
      let back = -1
      for (let f = nbrStart[j]; f < nbrStart[j + 1]; f++) if (nbr[f] === i) back = f
      if (back < 0) throw new Error(`createFieldMesh: edge ${i}→${j} has no reverse`)
      rev[e] = back
    }
  }

  const wall = new Float64Array(edges)
  const dist = new Float64Array(edges)
  const offE = new Float64Array(edges)
  const offS = new Float64Array(edges)
  const turnC = new Float64Array(edges).fill(1)
  const turnS = new Float64Array(edges)
  const cL = new Float64Array(3)
  const cR = new Float64Array(3)
  const d = { x: 0, y: 0 }
  for (let i = 0; i < count; i++) {
    for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) {
      const h = halfedge[e]
      const j = nbr[e]
      const tL = tri.triangleOf(h)
      const tR = tri.triangleOf(tri.twin[h])
      dist[e] = tri.edgeLength(h) * unitM
      if (globe) {
        // The wall: the arc between the two circumcentres, signed by their
        // heights over the plane of the edge's great circle (chart-left
        // positive, as orientation is).
        tri.circumcentreOnGlobe(tL, cL)
        tri.circumcentreOnGlobe(tR, cR)
        const cx = cL[1] * cR[2] - cL[2] * cR[1]
        const cy = cL[2] * cR[0] - cL[0] * cR[2]
        const cz = cL[0] * cR[1] - cL[1] * cR[0]
        const arc = detAtan2(Math.sqrt(cx * cx + cy * cy + cz * cz), cL[0] * cR[0] + cL[1] * cR[1] + cL[2] * cR[2])
        // The chart-left normal of i → j: −(u_i × u_j) (east × south is
        // inward, so the chart's counter-clockwise is the clockwise turn
        // about the outward normal).
        const ui = 3 * i
        const uj = 3 * j
        const nx = -(u[ui + 1] * u[uj + 2] - u[ui + 2] * u[uj + 1])
        const ny = -(u[ui + 2] * u[uj] - u[ui] * u[uj + 2])
        const nz = -(u[ui] * u[uj + 1] - u[ui + 1] * u[uj])
        const side = (cL[0] - cR[0]) * nx + (cL[1] - cR[1]) * ny + (cL[2] - cR[2]) * nz
        wall[e] = (side >= 0 ? arc : -arc) * radiusM
        // The offset: u_j's direction in i's tangent plane, the arc long.
        const dot = u[uj] * u[ui] + u[uj + 1] * u[ui + 1] + u[uj + 2] * u[ui + 2]
        const tx = u[uj] - dot * u[ui]
        const ty = u[uj + 1] - dot * u[ui + 1]
        const tz = u[uj + 2] - dot * u[ui + 2]
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz)
        const k = dist[e] / tl
        offE[e] = (tx * east[ui] + ty * east[ui + 1] + tz * east[ui + 2]) * k
        offS[e] = (tx * south[ui] + ty * south[ui + 1] + tz * south[ui + 2]) * k
        // The turn: j's east axis carried to i along the great circle
        // (Rodrigues, as Domain.transport), read in i's frame.
        const wx = u[uj + 1] * u[ui + 2] - u[uj + 2] * u[ui + 1]
        const wy = u[uj + 2] * u[ui] - u[uj] * u[ui + 2]
        const wz = u[uj] * u[ui + 1] - u[uj + 1] * u[ui]
        const ex = east[uj]
        const ey = east[uj + 1]
        const ez = east[uj + 2]
        const q = (wx * ex + wy * ey + wz * ez) / (1 + dot)
        const rx = dot * ex + (wy * ez - wz * ey) + wx * q
        const ry = dot * ey + (wz * ex - wx * ez) + wy * q
        const rz = dot * ez + (wx * ey - wy * ex) + wz * q
        turnC[e] = rx * east[ui] + ry * east[ui + 1] + rz * east[ui + 2]
        turnS[e] = rx * south[ui] + ry * south[ui + 1] + rz * south[ui + 2]
      } else {
        // The torus: both circumcentres in i's frame, the wall their
        // separation along the edge's left normal.
        circumcentreNear(tri, tL, x[i], y[i], cL)
        circumcentreNear(tri, tR, x[i], y[i], cR)
        domain.delta(x[j], y[j], x[i], y[i], d)
        const len = Math.sqrt(d.x * d.x + d.y * d.y)
        // Left in the triangulation's counter-clockwise sense (the planar
        // orientation of (x, y)): of (dx, dy) it is (−dy, dx).
        wall[e] = (((cL[0] - cR[0]) * -d.y + (cL[1] - cR[1]) * d.x) / len) * unitM
        offE[e] = d.x * unitM
        offS[e] = d.y * unitM
      }
    }
  }
  const coupling = new Float64Array(edges)
  for (let e = 0; e < edges; e++) coupling[e] = wall[e] / dist[e]

  // Least-squares gradient weights: g = M⁻¹ Σ w_k o_k (φ_k − φ_i), with
  // w_k = 1 / |o_k|² and M = Σ w_k o_k o_kᵀ — exact for a linear field, and
  // on a centrally symmetric star (the torus's hexagons) second order.
  const gradE = new Float64Array(edges)
  const gradS = new Float64Array(edges)
  for (let i = 0; i < count; i++) {
    let mee = 0
    let mes = 0
    let mss = 0
    for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) {
      const w = 1 / (offE[e] * offE[e] + offS[e] * offS[e])
      mee += w * offE[e] * offE[e]
      mes += w * offE[e] * offS[e]
      mss += w * offS[e] * offS[e]
    }
    const det = mee * mss - mes * mes
    for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) {
      const w = 1 / (offE[e] * offE[e] + offS[e] * offS[e])
      gradE[e] = (w * (mss * offE[e] - mes * offS[e])) / det
      gradS[e] = (w * (mee * offS[e] - mes * offE[e])) / det
    }
  }

  return {
    domain, tri, spacingM, count, unitM, radiusM, globe,
    x, y, u, east, south, area,
    nbrStart, nbr, rev, wall, dist, coupling, offE, offS, turnC, turnS, gradE, gradS,
    pentagons, maxDegree,
  }
}

// The circumcentre of torus triangle t in the frame of the point (px, py):
// its position as px + offset, into out[0..1].
function circumcentreNear(tri: PeriodicTriangulation, t: number, px: number, py: number, out: Float64Array): void {
  const a = tri.tris[3 * t]
  const d = { x: 0, y: 0 }
  tri.domain.delta(tri.vx[a], tri.vy[a], px, py, d)
  const cc = new Float64Array(2)
  if (!tri.circumcentre(t, cc)) throw new Error(`createFieldMesh: degenerate triangle ${t}`)
  out[0] = d.x + cc[0]
  out[1] = d.y + cc[1]
}

// ------------------------------------------------------------- the sampler

// A field mesh read at any chart point: the triangle under it (a hint grid
// at the mesh's own spacing, then the triangulation's walk — one or two
// steps), its barycentric weights, and from those a scalar, a vector or
// the nearest cell. What later phases read a field through in place of
// grid indices. Linear within a triangle, as the terrain mesh's sampler
// and rasteriser.
export interface FieldSampler {
  readonly mesh: FieldMesh
  // The triangle under (x, y), its three corners into `corners` and their
  // weights into `weights`; returns the triangle.
  taps(x: number, y: number, corners: Int32Array, weights: Float64Array): number
  sample(field: ArrayLike<number>, x: number, y: number): number
  // A vector field (east, south per cell, each in its own frame) at
  // (x, y), read in the frame of cell `toCell` — the interpolated vector
  // carried along the great circle from (x, y) to that cell's centre — or
  // in (x, y)'s own frame when `toCell` is −1. Into out.x, out.y.
  sampleVector(fe: ArrayLike<number>, fs: ArrayLike<number>, x: number, y: number, toCell: number, out: { x: number; y: number }): void
  // The cell whose Voronoi cell holds (x, y): the nearest centre (geodesic
  // on the sphere), by a greedy descent from the nearest triangle corner —
  // on a Delaunay mesh the descent ends at the true nearest.
  nearestCell(x: number, y: number): number
}

// Hint cells per mesh spacing in each direction: two, so a walk starts
// within a triangle or one away.
const HINTS_PER_SPACING = 2

export function createFieldSampler(fm: FieldMesh): FieldSampler {
  const { tri, domain } = fm
  const step = fm.spacingM / fm.unitM / HINTS_PER_SPACING
  const cols = Math.max(4, Math.round(domain.width / step))
  const rows = Math.max(4, Math.round(domain.height / step))
  const sx = domain.width / cols
  const sy = domain.height / rows
  const hints = hintGrid(tri, 0, 0, cols, rows, sx, sy)
  const hintAt = (x: number, y: number): number => {
    const c = Math.min(cols - 1, Math.max(0, Math.floor(domain.wrapX(x) / sx)))
    const r = Math.min(rows - 1, Math.max(0, Math.floor(domain.wrapY(y) / sy)))
    return hints[r * cols + c]
  }
  const bary = new Float64Array(3)
  const corners = new Int32Array(3)
  const q = new Float64Array(3)
  const gf = globeFrame()
  const taps = (px: number, py: number, outCorners: Int32Array, outWeights: Float64Array): number => {
    const t = tri.locate(px, py, hintAt(px, py))
    tri.barycentric(t, px, py, outWeights)
    outCorners[0] = tri.tris[3 * t]
    outCorners[1] = tri.tris[3 * t + 1]
    outCorners[2] = tri.tris[3 * t + 2]
    return t
  }
  // The unit vector of a chart point on the sphere, into q.
  const unitAt = (px: number, py: number): void => {
    const noise = domain.noise
    if (noise.kind !== 'globe') return
    noise.frame(px, py, gf)
    const r = noise.radius
    q[0] = gf.px / r
    q[1] = gf.py / r
    q[2] = gf.pz / r
  }
  const closeness = (i: number, px: number, py: number): number => {
    if (fm.globe) return fm.u[3 * i] * q[0] + fm.u[3 * i + 1] * q[1] + fm.u[3 * i + 2] * q[2]
    return -domain.distanceSq(fm.x[i], fm.y[i], px, py)
  }
  return {
    mesh: fm,
    taps,
    sample(field, px, py) {
      taps(px, py, corners, bary)
      return bary[0] * field[corners[0]] + bary[1] * field[corners[1]] + bary[2] * field[corners[2]]
    },
    sampleVector(fe, fs, px, py, toCell, out) {
      taps(px, py, corners, bary)
      if (!fm.globe) {
        out.x = bary[0] * fe[corners[0]] + bary[1] * fe[corners[1]] + bary[2] * fe[corners[2]]
        out.y = bary[0] * fs[corners[0]] + bary[1] * fs[corners[1]] + bary[2] * fs[corners[2]]
        return
      }
      // In 3D: each corner's vector from its own frame, weighted.
      let vx = 0
      let vy = 0
      let vz = 0
      for (let k = 0; k < 3; k++) {
        const c = corners[k]
        const w = bary[k]
        const a = fe[c] * w
        const b = fs[c] * w
        vx += a * fm.east[3 * c] + b * fm.south[3 * c]
        vy += a * fm.east[3 * c + 1] + b * fm.south[3 * c + 1]
        vz += a * fm.east[3 * c + 2] + b * fm.south[3 * c + 2]
      }
      unitAt(px, py)
      if (toCell < 0) {
        // Read in the point's own frame (gf holds it).
        out.x = vx * gf.ex + vy * gf.ey + vz * gf.ez
        out.y = vx * gf.sx + vy * gf.sy + vz * gf.sz
        return
      }
      // Into the tangent plane at the point, then carried to the cell
      // (Rodrigues about q × u, as Domain.transport).
      const r = vx * q[0] + vy * q[1] + vz * q[2]
      vx -= r * q[0]
      vy -= r * q[1]
      vz -= r * q[2]
      const o = 3 * toCell
      const ux = fm.u[o]
      const uy = fm.u[o + 1]
      const uz = fm.u[o + 2]
      const c = q[0] * ux + q[1] * uy + q[2] * uz
      let rx = vx
      let ry = vy
      let rz = vz
      if (c > -1 + 1e-12) {
        const wx = q[1] * uz - q[2] * uy
        const wy = q[2] * ux - q[0] * uz
        const wz = q[0] * uy - q[1] * ux
        const k = (wx * vx + wy * vy + wz * vz) / (1 + c)
        rx = c * vx + (wy * vz - wz * vy) + wx * k
        ry = c * vy + (wz * vx - wx * vz) + wy * k
        rz = c * vz + (wx * vy - wy * vx) + wz * k
      }
      out.x = rx * fm.east[o] + ry * fm.east[o + 1] + rz * fm.east[o + 2]
      out.y = rx * fm.south[o] + ry * fm.south[o + 1] + rz * fm.south[o + 2]
    },
    nearestCell(px, py) {
      taps(px, py, corners, bary)
      if (fm.globe) unitAt(px, py)
      let best = corners[0]
      let bestC = closeness(best, px, py)
      for (let k = 1; k < 3; k++) {
        const c = closeness(corners[k], px, py)
        if (c > bestC) { bestC = c; best = corners[k] }
      }
      for (;;) {
        let moved = false
        for (let e = fm.nbrStart[best]; e < fm.nbrStart[best + 1]; e++) {
          const c = closeness(fm.nbr[e], px, py)
          if (c > bestC) { bestC = c; best = fm.nbr[e]; moved = true }
        }
        if (!moved) return best
      }
    },
  }
}

// One field mesh per domain and spacing, with its sampler, built once and
// shared by the stages that ask for the same one (the ocean age and the
// climate: the domain's width / 256). The sphere's relaxation makes a build
// dear (0.7 s at 78 km), so a stage never builds its own copy of a mesh
// another holds.
export interface SharedFieldMesh {
  readonly mesh: FieldMesh
  readonly sampler: FieldSampler
}

const shared = new Map<string, SharedFieldMesh>()

export function sharedFieldMesh(domain: Domain, spacingM: number): SharedFieldMesh {
  const key = `${domain.kind}:${domain.width}:${domain.height}:${domain.metresPerUnit}:${spacingM}`
  let made = shared.get(key)
  if (!made) {
    const mesh = createFieldMesh(domain, spacingM)
    made = { mesh, sampler: createFieldSampler(mesh) }
    shared.set(key, made)
  }
  return made
}

// ------------------------------------------------------- the save's form

// A field as a save holds it (DEC-0036 fork 5): the mesh's own values,
// Float64 per cell — the session's exact bytes, so a load continues bit for
// bit — with what identifies the mesh they belong to, its cell count and
// spacing in metres. The mesh itself is not saved: it is rebuilt from the
// domain and the spacing, deterministically. The mantle's and the ocean
// age's (mantle/mantleField.ts, tectonics/oceanAge.ts).
export interface SavedField {
  values: Float64Array
  cells: number
  spacingM: number
}

// ------------------------------------------------------- chart rasters

// A field rasterised onto a resX × resY chart raster in the DomainGrid's
// convention: cell (i, j) holds the field at its CENTRE, ((i + 0.5) ·
// W / resX, (j + 0.5) · H / resY) — the convention the raster stages and
// the save's coarse layers are read in (DomainGrid.sampleBilinearAt). For
// the terrain mesh's corner convention (cell i holds the field at x = i ·
// W / resX, a pole row a single point) call mesh/meshRaster.ts
// rasteriseNodeField on `fm.tri` directly. Scanline walk: each pixel's
// triangle is found from the previous one's.
export function rasteriseField(fm: FieldMesh, field: ArrayLike<number>, resX: number, resY: number, out?: Float32Array): Float32Array {
  const result = out ?? new Float32Array(resX * resY)
  const { tri, domain } = fm
  const sx = domain.width / resX
  const sy = domain.height / resY
  const bary = new Float64Array(3)
  let hint = tri.lastTri
  let rowStart = hint
  for (let py = 0; py < resY; py++) {
    const y = (py + 0.5) * sy
    hint = rowStart
    for (let px = 0; px < resX; px++) {
      const x = (px + 0.5) * sx
      const t = tri.locate(x, y, hint)
      hint = t
      if (px === 0) rowStart = t
      tri.barycentric(t, x, y, bary)
      result[py * resX + px] = bary[0] * field[tri.tris[3 * t]] + bary[1] * field[tri.tris[3 * t + 1]] + bary[2] * field[tri.tris[3 * t + 2]]
    }
  }
  return result
}

// The cell of the field mesh that owns each raster cell of a resX × resY
// chart raster: the Voronoi cell its centre lies in (FieldSampler.
// nearestCell). A locate per raster cell, so a reader that reduces one
// raster several ways (a mean and a maximum) finds the owners once.
export function rasterOwners(sampler: FieldSampler, resX: number, resY: number): Int32Array {
  const { domain } = sampler.mesh
  const owners = new Int32Array(resX * resY)
  const sx = domain.width / resX
  const sy = domain.height / resY
  for (let py = 0; py < resY; py++) {
    const y = (py + 0.5) * sy
    for (let px = 0; px < resX; px++) owners[py * resX + px] = sampler.nearestCell((px + 0.5) * sx, y)
  }
  return owners
}

// A chart raster onto the field mesh as the AREA-WEIGHTED mean of the
// raster cells whose centres lie in each Voronoi cell (each raster cell
// weighs its true area, DomainGrid.cellArea). For a raster FINER than the
// mesh — the 2048 elevation onto the climate's mesh, anything extensive or
// whose mean must be kept: Σ area · value over the mesh equals the
// raster's to the assignment of the straddling raster cells. A mesh cell
// that no raster centre falls in (a raster coarser than the mesh) takes
// the centre sample instead. `owners`: rasterOwners of the same raster
// size, when the caller has them (the same bits either way).
export function fieldFromRasterAreaWeighted(fm: FieldMesh, sampler: FieldSampler, raster: Float32Array, resX: number, resY: number, out?: Float64Array, owners?: Int32Array): Float64Array {
  const result = out ?? new Float64Array(fm.count)
  const weight = new Float64Array(fm.count)
  const sum = new Float64Array(fm.count)
  const grid = fm.domain.grid(resX, resY)
  const sx = fm.domain.width / resX
  const sy = fm.domain.height / resY
  for (let py = 0; py < resY; py++) {
    const w = grid.cellArea(py)
    const y = (py + 0.5) * sy
    for (let px = 0; px < resX; px++) {
      const i = owners ? owners[py * resX + px] : sampler.nearestCell((px + 0.5) * sx, y)
      sum[i] += w * raster[py * resX + px]
      weight[i] += w
    }
  }
  for (let i = 0; i < fm.count; i++) {
    result[i] = weight[i] > 0 ? sum[i] / weight[i] : grid.sampleBilinearAt(raster, fm.x[i], fm.y[i])
  }
  return result
}

// The MAXIMUM of the raster cells whose centres lie in each Voronoi cell
// (`owners`, rasterOwners) — the highest ground a cell holds, where a mean
// would flatten a range into its valleys. A mesh cell no raster centre
// falls in takes the centre sample.
export function fieldMaxFromRaster(fm: FieldMesh, raster: Float32Array, resX: number, resY: number, owners: Int32Array): Float64Array {
  const result = new Float64Array(fm.count).fill(-Infinity)
  for (let p = 0; p < owners.length; p++) {
    const i = owners[p]
    if (raster[p] > result[i]) result[i] = raster[p]
  }
  const grid = fm.domain.grid(resX, resY)
  for (let i = 0; i < fm.count; i++) if (result[i] === -Infinity) result[i] = grid.sampleBilinearAt(raster, fm.x[i], fm.y[i])
  return result
}
