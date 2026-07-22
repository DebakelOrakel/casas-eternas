import { Vector3 } from '@babylonjs/core'

// Shared equirectangular-grid conventions for the elevation field
// (elevationField.ts) and the erosion solver (erosion.ts), so both agree
// on indexing/UV/wraparound instead of each inlining their own version —
// before this, texture.ts's per-texel loop and its 4-neighbor coastline
// check each had their own slightly different take on this math.

export const SEA_LEVEL = 0

export function cellIndex(x: number, y: number, width: number): number {
  return y * width + x
}

// Same u/v convention as texture.ts's per-texel loop: u = longitude/2pi,
// v = polar angle from the +Y pole / pi — matches Babylon's default
// CreateSphere UVs, so a grid built this way lines up with the render
// mesh with no extra alignment work.
export function pointForCell(x: number, y: number, width: number, height: number, out: Vector3): void {
  const v = (y + 0.5) / height
  const polar = v * Math.PI
  const sinPolar = Math.sin(polar)
  const cosPolar = Math.cos(polar)
  const u = (x + 0.5) / width
  const longitude = u * Math.PI * 2
  out.set(sinPolar * Math.cos(longitude), cosPolar, -sinPolar * Math.sin(longitude))
}

// Fixed N,NE,E,SE,S,SW,W,NW order — fillDepressionsAndRouteFlow and any
// future river tracing both walk neighbors in this order, so a stored
// direction index means the same thing everywhere it's used.
export const D8_OFFSETS: ReadonlyArray<readonly [dx: number, dy: number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
]

// Wraps x at the longitude seam (same rule texture.ts's crossesSeaLevel
// already uses for its horizontal neighbors), clamps y at the poles —
// there's no "wrap over the pole", a row above y=0 or below the last row
// simply doesn't exist. Returns -1 for that clamped-off-grid case.
export function d8Neighbor(x: number, y: number, dx: number, dy: number, width: number, height: number): number {
  const ny = y + dy
  if (ny < 0 || ny >= height) return -1
  const nx = (x + dx + width) % width
  return cellIndex(nx, ny, width)
}

// sin(polar angle at row y's cell center) — proportional to a cell's real
// physical surface area on the sphere (and to solid angle). Rows near the
// poles have the same *column count* as the equator but a fraction of
// the true area; flow accumulation must weight by this or drainage area
// gets inflated near the poles purely from an artifact of the
// equirectangular projection, not real geography.
export function cellAreaWeight(y: number, height: number): number {
  const v = (y + 0.5) / height
  return Math.sin(v * Math.PI)
}

// Physical east-west angular distance between adjacent-column cells at
// each row, precomputed once per erosion run (not per-cell-per-iteration
// — that would be width*height*8*iterations trig calls, far too slow).
// Longitude lines converge toward the poles, so this shrinks toward 0
// there — callers doing per-cell slope math need to guard against that
// (see erosion.ts).
export function buildRowHorizontalScale(width: number, height: number): Float32Array {
  const scale = new Float32Array(height)
  const perColumn = (2 * Math.PI) / width
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height
    scale[y] = Math.sin(v * Math.PI) * perColumn
  }
  return scale
}
