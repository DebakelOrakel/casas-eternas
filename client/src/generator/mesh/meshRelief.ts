import type { PeriodicTriangulation } from './periodicDelaunay'

// Slope and curvature of a height field at a node, from its star — the two
// relief inputs of the density rule (meshDensity.ts), and later the
// hillslope kernel's stencil. Slope is the steepest descent over the
// neighbours (rise over run); curvature is the mean second difference
// along the incident edges, 2·Σ(z_j − z_i)/ℓ² over the degree — the
// Laplacian's edge form, positive in a hollow, negative on a crest.
//
// `unitsToM` converts the domain's coordinate unit to metres and `zToM`
// the height unit, so the results are m/m and 1/m whatever the mesh is
// laid out in.
export function reliefAt(
  mesh: PeriodicTriangulation, z: Float32Array, v: number,
  unitsToM: number, zToM: number, out: Float64Array,
): void {
  const zi = z[v] * zToM
  const start = mesh.vEdge[v]
  let e = start
  let slope = 0
  let lapl = 0
  let n = 0
  do {
    const u = mesh.to(e)
    const l = mesh.edgeLength(e) * unitsToM
    const dz = z[u] * zToM - zi
    const s = Math.abs(dz) / l
    if (s > slope) slope = s
    lapl += dz / (l * l)
    n++
    e = mesh.rotateCcw(e)
  } while (e !== start)
  out[0] = slope
  out[1] = n > 0 ? (2 * lapl) / n : 0
}
