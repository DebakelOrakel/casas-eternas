import type { Domain } from '../core/domain'
import { detCos, detSin } from '../core/detMath'
import { buildFromTriangles, type PeriodicTriangulation } from './periodicDelaunay'

// The bootstrap of a domain's mesh at one spacing: the torus's hex lattice
// or the sphere's geodesic one. The one place the two shapes' meshes start
// differently — the torus is closed by its period, the sphere by its own
// surface — after it both are the same insertions and removals.
export function bootstrapLattice(domain: Domain, spacing: number): PeriodicTriangulation {
  return domain.kind === 'sphere' ? geodesicLattice(domain, spacing) : hexLattice(domain, spacing)
}

// The bootstrap: a hexagonal lattice over the whole domain at one spacing,
// already a closed periodic triangulation. Everything finer is inserted
// into it (meshBuild.ts), and its own points are ordinary vertices the
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
// triangulatePoints removes its lattice afterwards. The corners in detMath,
// so the lattice is the same bits in every engine. An edge's interior
// points are computed once, from its lower corner, so the two faces that
// share it share them; a face's own interior points are its alone.
const TILT = 0.4
const SPIN = 0.3

export function geodesicLattice(domain: Domain, spacing: number): PeriodicTriangulation {
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
  // In the chart, as the Domain names a point of the globe.
  const xs = new Float64Array(count)
  const ys = new Float64Array(count)
  const p = { x: 0, y: 0 }
  for (let v = 0; v < count; v++) {
    noise.locate(px[v], py[v], pz[v], p)
    xs[v] = p.x
    ys[v] = p.y
  }
  const mesh = buildFromTriangles(domain, xs, ys, count, Int32Array.from(tris))
  mesh.legaliseAll()
  return mesh
}
