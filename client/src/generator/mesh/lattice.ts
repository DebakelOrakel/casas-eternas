import type { Domain } from '../core/domain'
import { detCos, detSin } from '../core/detMath'
import { buildFromTriangles, type PeriodicTriangulation } from './periodicDelaunay'

// The bootstrap: a hexagonal lattice over the whole domain at one spacing,
// already a closed periodic triangulation. Everything finer is inserted
// into it (the engine's mesh/mesh_build.rs), and its own points are ordinary vertices the
// density rule may later remove. Rows alternate a half-cell offset, which
// needs an even row count to close over the seam; the columns and rows
// are rounded so the lattice tiles the domain exactly. The minimum of
// eight in each direction keeps every edge far inside the one-sheet
// margin of periodicDelaunay.ts.
export function hexLattice(domain: Domain, spacing: number): PeriodicTriangulation {
  if (domain.kind === 'sphere') throw new Error('hexLattice tiles a torus; a sphere starts from geodesicLattice (bootstrapLattice)')
  const cols = Math.max(8, Math.round(domain.width / spacing))
  let rows = Math.max(8, Math.round(domain.height / (spacing * Math.sqrt(3) / 2)))
  if (rows % 2 === 1) rows++
  const dx = domain.width / cols
  const dy = domain.height / rows
  const count = cols * rows
  const xs = new Float64Array(count)
  const ys = new Float64Array(count)
  for (let j = 0; j < rows; j++) {
    const offset = j % 2 === 0 ? 0 : 0.5
    for (let i = 0; i < cols; i++) {
      xs[j * cols + i] = (i + offset) * dx
      ys[j * cols + i] = (j + 0.5) * dy
    }
  }
  const id = (i: number, j: number): number => ((j + rows) % rows) * cols + ((i + cols) % cols)
  const tris = new Int32Array(count * 2 * 3)
  let n = 0
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (j % 2 === 0) {
        // Even row: the row above is shifted right by half a cell.
        tris[n++] = id(i, j); tris[n++] = id(i + 1, j); tris[n++] = id(i, j + 1)
        tris[n++] = id(i + 1, j); tris[n++] = id(i + 1, j + 1); tris[n++] = id(i, j + 1)
      } else {
        tris[n++] = id(i, j); tris[n++] = id(i + 1, j); tris[n++] = id(i + 1, j + 1)
        tris[n++] = id(i, j); tris[n++] = id(i + 1, j + 1); tris[n++] = id(i, j + 1)
      }
    }
  }
  const mesh = buildFromTriangles(domain, xs, ys, count, tris)
  mesh.legaliseAll()
  return mesh
}

// The sphere's bootstrap (DEC-0035, step 4d4): the icosahedron, each face
// cut into n² triangles by its barycentric grid and the points pushed out
// onto the globe — 10n² + 2 nodes, already a closed triangulation of the
// sphere, legalised into the Delaunay one. n is chosen so that a node's
// area matches the hex lattice's at the same spacing (√3/2 · s²), at
// least 4 (edges of ~16°, far inside the one-sheet margin).
//
// The icosahedron is turned off the poles and the seam (TILT, SPIN): every
// chart point (x, 0) is the north pole, so a lattice node there would be
// the image of every point a later stage puts at the pole, and
// the engine's `triangulate_points` removes its lattice afterwards. The corners in detMath,
// so the lattice is the same bits in every engine. An edge's interior
// points are computed once, from its lower corner, so the two faces that
// share it share them; a face's own interior points are its alone.
const TILT = 0.4
const SPIN = 0.3

function geodesicPoints(domain: Domain, spacing: number): GeodesicPoints {
  const noise = domain.noise
  if (noise.kind !== 'globe') throw new Error('geodesicLattice needs a sphere domain')
  const radius = noise.radius
  const sphereArea = 4 * Math.PI * radius * radius
  const n = Math.max(4, Math.round(Math.sqrt(sphereArea / ((Math.sqrt(3) / 2) * spacing * spacing) / 10)))
  // The twelve corners: the poles and two rings of five at z = ±1/√5, the
  // lower ring turned by 36°, then tilted about x and spun about z.
  const corner = new Float64Array(36)
  const z5 = 1 / Math.sqrt(5)
  const r5 = 2 / Math.sqrt(5)
  const put = (k: number, x: number, y: number, z: number): void => {
    const ct = detCos(TILT)
    const st = detSin(TILT)
    const y1 = y * ct - z * st
    const z1 = y * st + z * ct
    const cs = detCos(SPIN)
    const ss = detSin(SPIN)
    corner[3 * k] = x * cs - y1 * ss
    corner[3 * k + 1] = x * ss + y1 * cs
    corner[3 * k + 2] = z1
  }
  put(0, 0, 0, 1)
  for (let k = 0; k < 5; k++) {
    const up = (2 * Math.PI * k) / 5
    const down = up + Math.PI / 5
    put(1 + k, r5 * detCos(up), r5 * detSin(up), z5)
    put(6 + k, r5 * detCos(down), r5 * detSin(down), -z5)
  }
  put(11, 0, 0, -1)
  const faces: number[] = []
  for (let k = 0; k < 5; k++) {
    const k1 = (k + 1) % 5
    faces.push(0, 1 + k, 1 + k1)
    faces.push(1 + k, 6 + k, 1 + k1)
    faces.push(1 + k1, 6 + k, 6 + k1)
    faces.push(11, 6 + k1, 6 + k)
  }
  const count = 10 * n * n + 2
  const px = new Float64Array(count)
  const py = new Float64Array(count)
  const pz = new Float64Array(count)
  let next = 0
  // The point Σ w_i · corner_i, normalised, as the node `next`.
  const emit = (weights: [number, number][]): number => {
    let x = 0
    let y = 0
    let z = 0
    for (const [k, w] of weights) {
      x += corner[3 * k] * w
      y += corner[3 * k + 1] * w
      z += corner[3 * k + 2] * w
    }
    const l = Math.sqrt(x * x + y * y + z * z)
    px[next] = x / l
    py[next] = y / l
    pz[next] = z / l
    return next++
  }
  for (let k = 0; k < 12; k++) emit([[k, 1]])
  // Edge points, t = 1..n − 1 from the lower corner.
  const edgeBase = new Map<number, number>()
  for (let f = 0; f < 20; f++) {
    for (let s = 0; s < 3; s++) {
      const a = Math.min(faces[3 * f + s], faces[3 * f + (s + 1) % 3])
      const b = Math.max(faces[3 * f + s], faces[3 * f + (s + 1) % 3])
      if (edgeBase.has(a * 12 + b)) continue
      edgeBase.set(a * 12 + b, next)
      for (let t = 1; t < n; t++) emit([[a, n - t], [b, t]])
    }
  }
  // The point t steps from corner p toward corner q along their edge.
  const onEdge = (p: number, q: number, t: number): number => {
    if (t === 0) return p
    if (t === n) return q
    const base = edgeBase.get(Math.min(p, q) * 12 + Math.max(p, q)) as number
    return p < q ? base + t - 1 : base + (n - t) - 1
  }
  const tris: number[] = []
  const id = new Int32Array((n + 1) * (n + 1))
  for (let f = 0; f < 20; f++) {
    const A = faces[3 * f]
    const B = faces[3 * f + 1]
    const C = faces[3 * f + 2]
    // Node of grid point (i, j): A · (n − i − j) + B · i + C · j.
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        let v: number
        if (j === 0) v = onEdge(A, B, i)
        else if (i === 0) v = onEdge(A, C, j)
        else if (i + j === n) v = onEdge(B, C, j)
        else v = emit([[A, n - i - j], [B, i], [C, j]])
        id[i * (n + 1) + j] = v
      }
    }
    const at = (i: number, j: number): number => id[i * (n + 1) + j]
    for (let i = 0; i < n; i++) {
      for (let j = 0; i + j < n; j++) {
        tris.push(at(i, j), at(i + 1, j), at(i, j + 1))
        if (i + j < n - 1) tris.push(at(i + 1, j), at(i + 1, j + 1), at(i, j + 1))
      }
    }
  }
  if (next !== count) throw new Error(`geodesicLattice: ${next} nodes, expected ${count}`)
  return { count, px, py, pz, tris: Int32Array.from(tris) }
}

// The geodesic points in the chart, triangulated as the lattice's faces
// say and legalised into the Delaunay triangulation.
function latticeOnGlobe(domain: Domain, g: GeodesicPoints): PeriodicTriangulation {
  const noise = domain.noise
  if (noise.kind !== 'globe') throw new Error('geodesicLattice needs a sphere domain')
  const { count, px, py, pz } = g
  // In the chart, as the Domain names a point of the globe.
  const xs = new Float64Array(count)
  const ys = new Float64Array(count)
  const p = { x: 0, y: 0 }
  for (let v = 0; v < count; v++) {
    noise.locate(px[v], py[v], pz[v], p)
    xs[v] = p.x
    ys[v] = p.y
  }
  const mesh = buildFromTriangles(domain, xs, ys, count, g.tris)
  mesh.legaliseAll()
  return mesh
}

interface GeodesicPoints {
  count: number
  // Unit vectors.
  px: Float64Array
  py: Float64Array
  pz: Float64Array
  tris: Int32Array
}

// THE FIELD MESH'S SPHERE (DEC-0036 phase 3): the geodesic lattice relaxed
// toward a centroidal Voronoi tessellation (SCVT, Du, Gunzburger & Ju
// 2003; the MPAS meshes) by Lloyd's iteration — each node moved to the
// centroid of its Voronoi cell on the globe — over-relaxed by
// CENTROIDAL_OVERRELAX (the plain iteration's slowest modes need some
// thousand steps; at 1.8 the areas after 300 are within 3 % of the
// converged ones). A fixed count, no tolerance: the same lattice in every
// run and engine. The terrain mesh keeps the plain lattice
// (bootstrapLattice): its nodes are inserted into and removed at once.
//
// What it does (fields harness, 2026-10-11): the plain grid's cell areas
// vary × 2.04 at 78 km (small about the pentagons, large along the
// icosahedron's edges), the relaxed × 1.52 (the twelve pentagons at 0.69
// of the mean, the hexagons 0.85–1.04); the least-squares gradient
// converges at second order in L2 (1.55–1.84 on the plain grid) and above
// first in L∞; the elliptic solves, the diffusion and the transport come
// out slightly more accurate. The one thing it does not mend: the finite-
// volume Laplacian's POINTWISE truncation error at the hexagons next to a
// pentagon is of order 1 on a centroidal grid (Peixoto 2016, J. Comput.
// Phys. 310) — about 1 % of the field's Laplacian there at every spacing —
// where the plain grid's falls at first order. No stage reads ∇² by
// itself: it enters through a solve or a diffusion step, whose result
// converges at second order on either grid (supraconvergence).
//
// The cell of node a is cut into kites, one per corner of each triangle
// at a: (a, the edge midpoint to b, the triangle's circumcentre, the edge
// midpoint to c), each kite as two planar triangles whose signed areas and
// centroids sum to the cell's; the centroid is that sum pushed back onto
// the globe. The midpoint of a and b is (a + b) normalised (the
// bisecting great circle passes through it). The connectivity is the
// lattice's throughout (a geodesic grid's stays Delaunay under the
// relaxation); the triangulation is legalised once at the end. Only
// +, −, ×, ÷ and √: the same bits in every engine (core/detMath.ts).
const CENTROIDAL_ITERATIONS = 300
const CENTROIDAL_OVERRELAX = 1.8

// The icosahedron's lattice as it is cut, not relaxed: at fine spacings
// the relaxation's 300 steps take tens of seconds and no longer even out
// the cells (2026-10-26, 10 km on a 20 000 km globe: 43 s and areas 40 to
// 104 km², against 2.4 s and 50 to 105 km² unrelaxed). The incubator's
// cells (screens/incubator/cells.ts).
export function geodesicLattice(domain: Domain, spacing: number): PeriodicTriangulation {
  return latticeOnGlobe(domain, geodesicPoints(domain, spacing))
}

export function centroidalGeodesicLattice(domain: Domain, spacing: number): PeriodicTriangulation {
  const g = geodesicPoints(domain, spacing)
  relaxCentroidal(g, CENTROIDAL_ITERATIONS, CENTROIDAL_OVERRELAX)
  return latticeOnGlobe(domain, g)
}

// Lloyd's iteration on the globe, in place, each move × `omega`; returns
// the largest centroid offset of the last iteration (radians).
function relaxCentroidal(g: { count: number; px: Float64Array; py: Float64Array; pz: Float64Array; tris: Int32Array }, iterations: number, omega = 1): number {
  const { count, px, py, pz, tris } = g
  const sx = new Float64Array(count)
  const sy = new Float64Array(count)
  const sz = new Float64Array(count)
  const triCount = tris.length / 3
  let lastMove = 0
  // The signed area × centroid of the planar triangle (p, q, r), about
  // the outward direction n, added to node k's sums.
  const piece = (k: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void => {
    const ux = bx - ax
    const uy = by - ay
    const uz = bz - az
    const vx = cx - ax
    const vy = cy - ay
    const vz = cz - az
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    // Twice the area, signed by the outward normal (the node itself).
    const area2 = nx * ax + ny * ay + nz * az
    sx[k] += area2 * (ax + bx + cx)
    sy[k] += area2 * (ay + by + cy)
    sz[k] += area2 * (az + bz + cz)
  }
  for (let it = 0; it < iterations; it++) {
    sx.fill(0)
    sy.fill(0)
    sz.fill(0)
    for (let t = 0; t < triCount; t++) {
      const a = tris[3 * t]
      // Counter-clockwise about the outward normal, whichever way the
      // lattice listed it.
      let b = tris[3 * t + 1]
      let c = tris[3 * t + 2]
      {
        const ux = px[b] - px[a], uy = py[b] - py[a], uz = pz[b] - pz[a]
        const vx = px[c] - px[a], vy = py[c] - py[a], vz = pz[c] - pz[a]
        const turn = (uy * vz - uz * vy) * px[a] + (uz * vx - ux * vz) * py[a] + (ux * vy - uy * vx) * pz[a]
        if (turn < 0) { const k = b; b = c; c = k }
      }
      const ax = px[a], ay = py[a], az = pz[a]
      const bx = px[b], by = py[b], bz = pz[b]
      const cx = px[c], cy = py[c], cz = pz[c]
      // The circumcentre on the globe: the normal of the plane through the
      // three, outward.
      let ox = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
      let oy = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
      let oz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      let ol = Math.sqrt(ox * ox + oy * oy + oz * oz)
      if (ox * (ax + bx + cx) + oy * (ay + by + cy) + oz * (az + bz + cz) < 0) ol = -ol
      ox /= ol
      oy /= ol
      oz /= ol
      // The three edge midpoints on the globe.
      let mx = ax + bx, my = ay + by, mz = az + bz
      let ml = Math.sqrt(mx * mx + my * my + mz * mz)
      const abx = mx / ml, aby = my / ml, abz = mz / ml
      mx = bx + cx; my = by + cy; mz = bz + cz
      ml = Math.sqrt(mx * mx + my * my + mz * mz)
      const bcx = mx / ml, bcy = my / ml, bcz = mz / ml
      mx = cx + ax; my = cy + ay; mz = cz + az
      ml = Math.sqrt(mx * mx + my * my + mz * mz)
      const cax = mx / ml, cay = my / ml, caz = mz / ml
      // Each corner's kite, counter-clockwise about the outward normal.
      piece(a, ax, ay, az, abx, aby, abz, ox, oy, oz)
      piece(a, ax, ay, az, ox, oy, oz, cax, cay, caz)
      piece(b, bx, by, bz, bcx, bcy, bcz, ox, oy, oz)
      piece(b, bx, by, bz, ox, oy, oz, abx, aby, abz)
      piece(c, cx, cy, cz, cax, cay, caz, ox, oy, oz)
      piece(c, cx, cy, cz, ox, oy, oz, bcx, bcy, bcz)
    }
    lastMove = 0
    for (let k = 0; k < count; k++) {
      const l = Math.sqrt(sx[k] * sx[k] + sy[k] * sy[k] + sz[k] * sz[k])
      const dx = sx[k] / l - px[k]
      const dy = sy[k] / l - py[k]
      const dz = sz[k] / l - pz[k]
      const move = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (move > lastMove) lastMove = move
      const nx = px[k] + omega * dx
      const ny = py[k] + omega * dy
      const nz = pz[k] + omega * dz
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz)
      px[k] = nx / nl
      py[k] = ny / nl
      pz[k] = nz / nl
    }
  }
  return lastMove
}

