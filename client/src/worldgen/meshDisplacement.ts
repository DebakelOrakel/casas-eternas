// Babylon-agnostic (raw typed arrays in/out, no Mesh/Scene dependency) —
// same testability rationale texture.ts gives for its own split from the
// worker/screen. Called from WorldGenScreen.ts once erosion finishes.

// Bilinear sample of an equirectangular elevation grid at normalized
// (u, v) — u wraps at the longitude seam, v clamps at the poles. Uses the
// exact same u/v convention as grid.ts's pointForCell (u = longitude/2pi,
// v = polar angle from the +Y pole / pi), which is also Babylon's default
// CreateSphere UV convention — so sampling with a mesh's own UV buffer
// (see displaceSphereVertices) lines up with the grid with no extra
// alignment math.
export function sampleElevationBilinear(elevations: Float32Array, width: number, height: number, u: number, v: number): number {
  const wrappedU = u - Math.floor(u)
  const clampedV = Math.min(1, Math.max(0, v))

  const fx = wrappedU * width - 0.5
  const fy = clampedV * height - 0.5

  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0

  const wrapX = (x: number) => ((x % width) + width) % width
  const clampY = (y: number) => Math.min(height - 1, Math.max(0, y))

  const xa = wrapX(x0)
  const xb = wrapX(x0 + 1)
  const ya = clampY(y0)
  const yb = clampY(y0 + 1)

  const v00 = elevations[ya * width + xa]
  const v10 = elevations[ya * width + xb]
  const v01 = elevations[yb * width + xa]
  const v11 = elevations[yb * width + xb]

  const top = v00 + (v10 - v00) * tx
  const bottom = v01 + (v11 - v01) * tx
  return top + (bottom - top) * ty
}

// A displaced radius can't be allowed to collapse to (or through) the
// origin or balloon absurdly from one outlier elevation value — this
// floor/ceiling (as a fraction of planetRadius) is the safety clamp, not
// a tuned "realistic relief" limit.
const MIN_RADIUS_FACTOR = 0.5
const MAX_RADIUS_FACTOR = 2

// positions/uvs are the mesh's own flat interleaved vertex buffers
// (positions already on a sphere of radius planetRadius, centered at the
// origin — so each vertex's own normalized position doubles as its
// outward/normal direction, no separate normal buffer needed here).
// Writes the displaced result into outPositions (same length as
// positions) rather than mutating in place, so the caller can decide
// when/whether to hand it to the mesh.
export function displaceSphereVertices(
  positions: Float32Array,
  uvs: Float32Array,
  elevations: Float32Array,
  gridWidth: number,
  gridHeight: number,
  planetRadius: number,
  displacementScale: number,
  outPositions: Float32Array,
): void {
  const vertexCount = positions.length / 3
  const minRadius = planetRadius * MIN_RADIUS_FACTOR
  const maxRadius = planetRadius * MAX_RADIUS_FACTOR

  for (let i = 0; i < vertexCount; i++) {
    const px = positions[i * 3]
    const py = positions[i * 3 + 1]
    const pz = positions[i * 3 + 2]
    const length = Math.sqrt(px * px + py * py + pz * pz) || 1
    const nx = px / length
    const ny = py / length
    const nz = pz / length

    const u = uvs[i * 2]
    const v = uvs[i * 2 + 1]
    const elevation = sampleElevationBilinear(elevations, gridWidth, gridHeight, u, v)
    const radius = Math.min(maxRadius, Math.max(minRadius, planetRadius + elevation * displacementScale))

    outPositions[i * 3] = nx * radius
    outPositions[i * 3 + 1] = ny * radius
    outPositions[i * 3 + 2] = nz * radius
  }
}
