import { sampleBilinearGrid, sampleBilinearWorld, sampleNearestWorld, upscaleBilinearToroidal, wrapValue } from './field'
import { rotateAroundCenter, wrappedDelta } from './toroidal'

// THE DOMAIN (decision 11 of docs/decisions/adaptive-mesh.md, born with the
// Planet stage): the world's topology behind one interface — what a point
// set is periodic in, how far two points are apart, and what "latitude"
// means there. The torus is a declared mapping: the horizontal midline is
// the equator, the glued top/bottom seam the pole, both hemispheres
// mirror-symmetric; a sphere is a second domain with real latitude
// (docs/design/two-topologies.md). The planetary forcing acts on
// latitude(p) either way.
//
// The mesh (phase 4) reads only `delta*`, `wrap*` and `distanceSq`: every
// triangle is unwrapped into the frame of one of its own corners through
// `deltaX`/`deltaY`, so the triangulation code never sees a period. That is
// what makes the sphere a second implementation of THIS interface rather
// than a second triangulation. The neighbour search over a point set lives
// beside the mesh (`mesh/pointBuckets.ts`) because it needs the domain's
// extent, not its topology.
export interface Domain {
  readonly kind: 'torus'
  readonly width: number
  readonly height: number
  // Latitude 0..1 of a normalised row position y in 0..1: 0 at the equator,
  // 1 at the pole.
  latitude(yNorm: number): number
  // Which hemisphere a row lies in: true for the top ("north").
  north(yNorm: number): boolean
  // Shortest signed offset from b to a along each axis (the minimum-image
  // convention of core/toroidal.ts): `bx + deltaX(ax, bx)` is a's image
  // nearest to b.
  deltaX(ax: number, bx: number): number
  deltaY(ay: number, by: number): number
  // A coordinate brought back into [0, width) × [0, height).
  wrapX(x: number): number
  wrapY(y: number): number
  distanceSq(ax: number, ay: number, bx: number, by: number): number
  // (x, y) turned by `angle` radians about (centerX, centerY), the result
  // brought back into the domain — the plates' rigid rotation
  // (core/toroidal.ts rotateAroundCenter).
  rotateAround(x: number, y: number, centerX: number, centerY: number, angle: number): { x: number; y: number }
  // A raster of resX × resY cells laid over the whole domain. Make it once
  // per field or per call, never inside a per-cell loop.
  grid(resX: number, resY: number): DomainGrid
  // The same domain measured in other units: width × height of them (a
  // coarse raster that is its own frame, one cell per unit).
  scaledTo(width: number, height: number): Domain
}

// A raster over the domain: cell (i, j) covers [i, i + 1) × [j, j + 1) in
// grid units, that is (width / resX) × (height / resY) domain units. Every
// raster wrap in the generator goes through this interface, so the sphere
// can give rasters its own rule: longitude wraps, latitude reflects over
// the pole, and a row's cells narrow as cos φ (rowScale, cellArea). On the
// torus both axes simply wrap.
export interface DomainGrid {
  // The domain the grid lies over.
  readonly domain: Domain
  readonly resX: number
  readonly resY: number
  // A column or row, an index or a fractional grid coordinate, brought into
  // [0, resX) or [0, resY). On the torus this is exactly wrapValue.
  wrapCol(x: number): number
  wrapRow(y: number): number
  // The cell index of integer (x, y), wrapped first.
  index(x: number, y: number): number
  // The cell index (dx, dy) steps from cell (x, y).
  neighbour(x: number, y: number, dx: number, dy: number): number
  // For hot loops, where a call per neighbour costs time: the wrapped column
  // of every x in [-margin, resX + margin), at [x + margin], and the start
  // index (row · resX) of every wrapped row y in [-margin, resY + margin),
  // at [y + margin]. The torus wraps the axes apart; a grid that does not
  // (the sphere, across the pole) needs a different form here.
  colTable(margin: number): Int32Array
  rowTable(margin: number): Int32Array
  // A row's cell width against the equator's, and a cell's area against an
  // equator cell's. 1 everywhere on the torus; cos φ on the sphere.
  rowScale(y: number): number
  cellArea(y: number): number
  // Bilinear sample at fractional GRID coordinates, cell centres at
  // integers (core/field.ts sampleBilinearGrid).
  sampleBilinear(field: Float32Array, gx: number, gy: number): number
  // Bilinear sample at DOMAIN coordinates, cell centres at (i + 0.5) cells
  // (core/field.ts sampleBilinearWorld).
  sampleBilinearAt(field: Float32Array, x: number, y: number): number
  // The cell that holds domain point (x, y), and its value.
  cellAt(x: number, y: number): number
  sampleNearestAt(field: Float32Array, x: number, y: number): number
  // The whole raster resampled bilinearly onto a finer grid of the same
  // domain (core/field.ts upscaleBilinearToroidal).
  upscale(field: Float32Array, toResX: number, toResY: number): Float32Array
}

// The torus's grid: both axes wrap, every cell is the same size. A class,
// so that every call site sees one shape and the calls inline.
class TorusGrid implements DomainGrid {
  readonly domain: Domain
  readonly resX: number
  readonly resY: number
  private readonly width: number
  private readonly height: number

  constructor(domain: Domain, resX: number, resY: number) {
    this.domain = domain
    this.resX = resX
    this.resY = resY
    this.width = domain.width
    this.height = domain.height
  }

  wrapCol(x: number): number {
    return wrapValue(x, this.resX)
  }

  wrapRow(y: number): number {
    return wrapValue(y, this.resY)
  }

  index(x: number, y: number): number {
    return wrapValue(y, this.resY) * this.resX + wrapValue(x, this.resX)
  }

  neighbour(x: number, y: number, dx: number, dy: number): number {
    return wrapValue(y + dy, this.resY) * this.resX + wrapValue(x + dx, this.resX)
  }

  colTable(margin: number): Int32Array {
    const out = new Int32Array(this.resX + 2 * margin)
    for (let k = 0; k < out.length; k++) out[k] = wrapValue(k - margin, this.resX)
    return out
  }

  rowTable(margin: number): Int32Array {
    const out = new Int32Array(this.resY + 2 * margin)
    for (let k = 0; k < out.length; k++) out[k] = wrapValue(k - margin, this.resY) * this.resX
    return out
  }

  rowScale(_y: number): number {
    return 1
  }

  cellArea(_y: number): number {
    return 1
  }

  sampleBilinear(field: Float32Array, gx: number, gy: number): number {
    return sampleBilinearGrid(field, this.resX, this.resY, gx, gy)
  }

  sampleBilinearAt(field: Float32Array, x: number, y: number): number {
    return sampleBilinearWorld(field, this.resX, this.resY, x, y, this.width, this.height)
  }

  cellAt(x: number, y: number): number {
    const gx = Math.min(this.resX - 1, Math.floor((wrapValue(x, this.width) / this.width) * this.resX))
    const gy = Math.min(this.resY - 1, Math.floor((wrapValue(y, this.height) / this.height) * this.resY))
    return gy * this.resX + gx
  }

  sampleNearestAt(field: Float32Array, x: number, y: number): number {
    return sampleNearestWorld(field, this.resX, this.resY, x, y, this.width, this.height)
  }

  upscale(field: Float32Array, toResX: number, toResY: number): Float32Array {
    return upscaleBilinearToroidal(field, this.resX, this.resY, toResX, toResY)
  }
}

// The torus, with the thermal equator slid by `equatorOffset` (fraction of
// the height, positive toward the bottom) — the climate's one "move the
// equator" knob, applied once here.
export function torusDomain(width: number, height: number, equatorOffset = 0): Domain {
  const shifted = (yNorm: number): number => {
    const y = yNorm - equatorOffset
    return y - Math.floor(y)
  }
  const deltaX = (ax: number, bx: number): number => wrappedDelta(ax, bx, width)
  const deltaY = (ay: number, by: number): number => wrappedDelta(ay, by, height)
  const domain: Domain = {
    kind: 'torus',
    width,
    height,
    latitude: (yNorm) => Math.abs(shifted(yNorm) - 0.5) * 2,
    north: (yNorm) => shifted(yNorm) < 0.5,
    deltaX,
    deltaY,
    wrapX: (x) => wrapValue(x, width),
    wrapY: (y) => wrapValue(y, height),
    distanceSq: (ax, ay, bx, by) => {
      const dx = deltaX(ax, bx)
      const dy = deltaY(ay, by)
      return dx * dx + dy * dy
    },
    rotateAround: (x, y, centerX, centerY, angle) => rotateAroundCenter(x, y, centerX, centerY, angle, width, height),
    grid: (resX, resY) => new TorusGrid(domain, resX, resY),
    scaledTo: (w, h) => torusDomain(w, h, equatorOffset),
  }
  return domain
}
