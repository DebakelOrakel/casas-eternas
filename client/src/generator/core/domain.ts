import { sampleBilinearGrid, sampleBilinearWorld, sampleNearestWorld, upscaleBilinearToroidal, wrapValue } from './field'
import { rotateAroundCenter, wrappedDelta } from './toroidal'
import { detAsin, detAtan2, detCos, detSin } from './detMath'
import { MAP_WIDTH, SPHERE_EQUATOR_METERS, TORUS_METERS_PER_CELL } from './mapConfig'

// THE DOMAIN (decision 11 of docs/decisions/adaptive-mesh.md, born with the
// Planet stage): the world's topology behind one interface — what a point
// set is periodic in, how far two points are apart, and what "latitude"
// means there. The torus is a declared mapping: the horizontal midline is
// the equator, the glued top/bottom seam the pole, both hemispheres
// mirror-symmetric; a sphere is a second domain with real latitude
// (docs/design/two-topologies.md). The planetary forcing acts on
// latitude(p) either way.
//
// The mesh (phase 4) reads `delta`, `wrap*`, `distanceSq` and, to place a
// node, `advance`/`displace`/`transport`: on the torus every triangle is
// unwrapped into the frame of one of its own corners through `delta`, so
// the triangulation code never sees a period. On the sphere the same
// triangulation takes its predicates from the nodes' unit vectors on the
// globe (mesh/periodicDelaunay.ts, step 4d4) — the topology code is one,
// only the geometry is the shape's. The neighbour search over a point set lives
// beside the mesh (`mesh/pointBuckets.ts`) because it needs the domain's
// extent, not its topology.
//
// Two implementations: `torusDomain` and `sphereDomain` (DEC-0035,
// docs/decisions/two-shapes.md). Both keep their points in one 2:1 chart;
// on the sphere the chart is an ADDRESS (longitude, colatitude), and every
// answer below is computed on the globe.
export interface Domain {
  readonly kind: 'torus' | 'sphere'
  readonly width: number
  readonly height: number
  // What a length IS on this shape (DEC-0035 fork 6): both shapes keep the
  // 2048 × 1024 raster, the sphere's cell is the larger (core/mapConfig.ts).
  // `metresPerUnit`: metres per domain unit, at the equator on the sphere
  // (one unit of arc). A domain made by torusDomain / sphereDomain counts in
  // macro cells whatever its width — a harness world of 512 units is a
  // smaller world, not coarser cells; scaledTo makes the unit larger.
  // `metresAround`: the world's extent east-west at the equator, fixed for
  // the shape whatever raster samples it — a grid of w cells has cells
  // metresAround / w wide. At the world raster's width (MAP_WIDTH) the two
  // agree; in a narrower harness world they do not, and the generator
  // carries both readings from before the fork (the mesh counted in
  // macro cells, the raster stages in the fixed world).
  readonly metresPerUnit: number
  readonly metresAround: number
  // Latitude 0..1 of a normalised row position y in 0..1: 0 at the equator,
  // 1 at the pole.
  latitude(yNorm: number): number
  // Which hemisphere a row lies in: true for the top ("north").
  north(yNorm: number): boolean
  // The offset from b to a, in domain units, in b's local frame: written
  // into `out`, which the caller holds (one per loop, so a hot loop does
  // not allocate). The two axes are one call because on a sphere the
  // east-west offset depends on latitude: the offset lies in b's LOCAL
  // TANGENT PLANE. On the torus it is the minimum-image offset per axis
  // (core/toroidal.ts wrappedDelta): `bx + out.x` is a's image nearest to b.
  delta(ax: number, ay: number, bx: number, by: number, out: { x: number; y: number }): void
  // The inverse of delta: the point reached from (x, y) by the offset
  // (dx, dy) in (x, y)'s local frame, brought into the domain and written
  // into `out` (which may be the moved point itself). After
  // `delta(ax, ay, bx, by, d)`, `advance(bx, by, d.x, d.y, out)` is a again.
  // The torus: wrapX(x + dx), wrapY(y + dy) — the same operations a caller
  // that moves a point by hand does, so a move through it is byte-identical.
  // The sphere: the exp map, along the great circle from (x, y) in the
  // offset's direction for its length in arc.
  advance(x: number, y: number, dx: number, dy: number, out: { x: number; y: number }): void
  // advance without bringing the result back into the domain: for a caller
  // that keeps a point unwrapped as the torus code always could (a centroid,
  // a jitter, the first of two offsets). The torus: x + dx, y + dy, the
  // addition the caller did by hand, so its bits stay. The sphere: the same
  // as advance (its coordinates name a point anywhere, so there is nothing
  // to keep unwrapped).
  displace(x: number, y: number, dx: number, dy: number, out: { x: number; y: number }): void
  // A point of the plane about a reference point brought back to the
  // domain (step 4e): the plane is the one `refX + delta(…).x`,
  // `refY + delta(…).y` builds about (refX, refY), so a caller can draw a
  // short figure (a river's bends) in it with planar arithmetic and put
  // the result back. The torus: the plane is the chart unwrapped, and the
  // point is wrapPoint(px, py) — the reference is not read, so a caller
  // that wrapped by hand keeps its bits. The sphere: the azimuthal-
  // equidistant plane about the reference, advance(ref, px − refX, py −
  // refY).
  fromPlane(px: number, py: number, refX: number, refY: number, out: { x: number; y: number }): void
  // A coordinate brought back into [0, width) × [0, height) ([0, height]
  // on the sphere). One axis at a time: on the sphere wrapX is the
  // longitude wrap and wrapY a reflection over the pole, which alone is NOT
  // where a moved point lands (crossing a pole also turns the longitude by
  // half a turn). A moved POINT goes through wrapPoint, or advance.
  wrapX(x: number): number
  wrapY(y: number): number
  // A point brought back into the domain, both axes at once, written into
  // `out`. The torus: wrapX and wrapY. The sphere: y beyond a pole is
  // reflected and x moved by width / 2.
  wrapPoint(x: number, y: number, out: { x: number; y: number }): void
  distanceSq(ax: number, ay: number, bx: number, by: number): number
  // (x, y) turned by `angle` radians about (centerX, centerY), the result
  // brought back into the domain — the plates' rigid rotation
  // (core/toroidal.ts rotateAroundCenter).
  rotateAround(x: number, y: number, centerX: number, centerY: number, angle: number): { x: number; y: number }
  // A tangent vector (vx, vy) in the frame of (fromX, fromY) carried to the
  // frame of (toX, toY), written into `out`: for a direction found at one
  // point and used at another (a boundary normal from the seeds, a rift
  // normal at a blob, a feature's axis after it moved). The torus: the same
  // two numbers, since its frame is the same everywhere. The sphere: parallel
  // transport along the great circle between the two points (the rotation
  // that takes one to the other about their common normal), so the length is
  // kept and a direction along the circle stays along it.
  transport(vx: number, vy: number, fromX: number, fromY: number, toX: number, toY: number, out: { x: number; y: number }): void
  // A raster of resX × resY cells laid over the whole domain. Make it once
  // per field or per call, never inside a per-cell loop.
  grid(resX: number, resY: number): DomainGrid
  // The same domain measured in other units: width × height of them (a
  // coarse raster that is its own frame, one cell per unit).
  scaledTo(width: number, height: number): Domain
  // Where the coordinate noise is sampled (DEC-0035, fork 1): the noise
  // lattices (elevation/ridgedNoise, domainWarp, hypsometry) ask this, not
  // the shape. The torus: the chart itself, a 2D lattice periodic in both
  // axes. The sphere: the point's place on the globe, a 3D lattice.
  readonly noise: NoiseSpace
}

// How a Domain's coordinate noise is sampled (Domain.noise).
export type NoiseSpace = ChartNoise | GlobeNoise

// The torus: the noise lattices tile the chart, periodic at its width and
// height. There is nothing to compute here; the lattice does it.
export interface ChartNoise {
  readonly kind: 'chart'
}

// The sphere: the noise is a 3D field sampled at the point's position on
// the globe, so it is isotropic, has no seam at the longitude wrap and has
// one value at a pole.
export interface GlobeNoise {
  readonly kind: 'globe'
  // The globe's radius in domain units, width / 2π.
  readonly radius: number
  // The point (x, y) on the globe: its position R · u in domain units, and
  // its east and south unit axes — the frame `delta` and `advance` write
  // and read offsets in (at a pole the limit along x's meridian). A 3D
  // vector v at the point is the tangent offset (v · east, v · south).
  frame(x: number, y: number, out: GlobeFrame): void
  // The inverse of frame's position: the chart point (x, y) of the globe's
  // point in the direction (px, py, pz) from its centre (any length but 0),
  // written into `out`. At a pole x is 0, as rotateAround writes it. For a
  // caller that moves a point in 3D (a plate's Euler rotation,
  // tectonics/plateMotion.ts) and must name it in the chart again.
  locate(px: number, py: number, pz: number, out: { x: number; y: number }): void
}

export interface GlobeFrame {
  px: number
  py: number
  pz: number
  ex: number
  ey: number
  ez: number
  sx: number
  sy: number
  sz: number
}

// A GlobeFrame to hold, one per caller, so a hot loop does not allocate.
export function globeFrame(): GlobeFrame {
  return { px: 0, py: 0, pz: 0, ex: 0, ey: 0, ez: 0, sx: 0, sy: 0, sz: 0 }
}

const CHART_NOISE: ChartNoise = { kind: 'chart' }

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
  // A row's cell width against the equator's, and a cell's area against a
  // chart cell's ((width / resX) · (height / resY) domain units²), so that
  // the sum of cellArea over all cells, times a chart cell, is the domain's
  // area (4πR² on the sphere). 1 everywhere on the torus; on the sphere
  // rowScale is cos φ at the row centre and cellArea the row's exact
  // spherical band, ≈ cos φ.
  rowScale(y: number): number
  cellArea(y: number): number
  // The width of the edge between row y − 1 and row y (y in 0..resY)
  // against the equator's cell width: 1 on the torus; on the sphere sin of
  // the edge's colatitude, 0 at a pole. With rowScale and cellArea it gives
  // a raster stage the finite-volume weights of a diffusion or a Laplacian:
  // the flux across a face is its width over the distance of the two
  // centres, divided by the cell's area.
  edgeScale(y: number): number
  // The cells a disc of `radius` (domain units, measured on the domain)
  // about (x, y) can reach: every cell that holds a point of the disc lies
  // in columns out.x0..x1 and rows out.y0..y1 — integer grid indices,
  // unwrapped, to be read through `index(col, row)`, each cell met at most
  // once. A box, so it may hold cells the disc does not reach. The torus: the square
  // ±radius about the point, floor and ceil, as the scatter loops always
  // computed it (whole axes when it is wider than the grid). The sphere:
  // the rows of the cap, clamped at the poles (never across one), and the
  // columns of its widest longitude span, asin(sin α / sin θ) — every
  // column when the cap holds a pole.
  discBox(x: number, y: number, radius: number, out: CellBox): void
  // Each pole row made one value, its area-weighted mean, in place: on the
  // sphere a pole row is in truth one point, and a raster stage that leaves
  // its cells apart draws a star at the pole (DEC-0035, fork 5). The torus
  // has no pole: nothing happens. A stage calls it without asking the shape.
  // `mask`: only the cells it marks (non-zero) take part and take the mean —
  // the sea of a pole row that also holds land, for a field that has a
  // value only there.
  averagePoleRows(field: Float32Array, mask?: Uint8Array): void
  // Bilinear sample at fractional GRID coordinates, cell centres at
  // integers (core/field.ts sampleBilinearGrid).
  sampleBilinear(field: Float32Array, gx: number, gy: number): number
  // The same sample in the form the erosion forcing's reader was written
  // in (step 4d5): the fraction taken from the coordinate as given, not
  // from its wrapped copy. On the torus that is a different rounding from
  // sampleBilinear's (wrapValue's subtraction costs the fraction its last
  // bits), and that reader keeps its own; on
  // the sphere it is sampleBilinear, across the pole as there. The caller
  // keeps (gx, gy) within one period of the grid.
  interpolate(field: Float32Array, gx: number, gy: number): number
  // A semi-Lagrangian departure (step 4d5): the bilinear taps of the point
  // reached from cell (gx, gy)'s centre by (dx, dy) cells — equator cells,
  // so a length — in that cell's local frame, written into `out` for
  // sampleTaps. The torus: sampleBilinear's taps at (gx + dx, gy + dy), so a
  // sample through them is that sample's bits. The sphere: the point
  // reached along the great circle (Domain.advance), so an east-west step
  // near a pole is the distance it says and not 1 / cos φ of it, and a step
  // across a pole lands on the far side. Taps once per cell, read every
  // iteration: an advection's departure stays where its wind put it.
  tapsAt(gx: number, gy: number, dx: number, dy: number, out: BilinearTaps, at: number): void
  // The cell reached from cell (gx, gy)'s centre by (dx, dy) cells in its
  // local frame, the nearest one: the torus rounds the grid coordinates
  // (index(round(gx + dx), round(gy + dy))), the sphere moves along the
  // great circle as tapsAt does and takes the cell that holds the point.
  cellDisplaced(gx: number, gy: number, dx: number, dy: number): number
  // The fractional grid point (cell centres at integers) reached from grid
  // point (gx, gy) by (dx, dy) cells — equator cells, a length — in its
  // local frame, written into `out` (step 4e): a track that marches cell
  // by cell (a storm, the dust on the wind). The torus: gx + dx, gy + dy,
  // unwrapped, the addition the track did by hand, so its bits stay. The
  // sphere: along the great circle as tapsAt, wrapped into the chart.
  displaced(gx: number, gy: number, dx: number, dy: number, out: { x: number; y: number }): void
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

// The bilinear taps of many points, one per slot (DomainGrid.tapsAt): the
// four cells and the fractions, kept apart per row because on the sphere
// the two rows may lie on opposite meridians (the far side of a pole).
export interface BilinearTaps {
  // Per slot: cells i00, i10 (the first row), i01, i11 (the second).
  cells: Int32Array
  // Per slot: tx of the first row, tx of the second, ty.
  weights: Float64Array
}

export function bilinearTaps(count: number): BilinearTaps {
  return { cells: new Int32Array(4 * count), weights: new Float64Array(3 * count) }
}

// A field sampled through the taps of slot `at`: in sampleBilinearGrid's
// form, top · (1 − ty) + bottom · ty.
export function sampleTaps(field: Float32Array, taps: BilinearTaps, at: number): number {
  const c = taps.cells
  const w = taps.weights
  const i = 4 * at
  const k = 3 * at
  const tx0 = w[k]
  const tx1 = w[k + 1]
  const ty = w[k + 2]
  const top = field[c[i]] * (1 - tx0) + field[c[i + 1]] * tx0
  const bottom = field[c[i + 2]] * (1 - tx1) + field[c[i + 3]] * tx1
  return top * (1 - ty) + bottom * ty
}

// A range of grid cells (DomainGrid.discBox): columns x0..x1, rows y0..y1,
// both ends included, unwrapped.
export interface CellBox {
  x0: number
  x1: number
  y0: number
  y1: number
}

// The domain of a shape: the torus or the sphere over a width × height
// chart. The one place a shape's NAME becomes its Domain — a message
// carries the name, since a Domain does not cross a worker boundary.
export function domainOfKind(kind: Domain['kind'], width: number, height: number): Domain {
  return kind === 'sphere' ? sphereDomain(width, height) : torusDomain(width, height)
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

  edgeScale(_y: number): number {
    return 1
  }

  discBox(x: number, y: number, radius: number, out: CellBox): void {
    const cellW = this.width / this.resX
    const cellH = this.height / this.resY
    out.x0 = Math.floor((x - radius) / cellW)
    out.x1 = Math.ceil((x + radius) / cellW)
    out.y0 = Math.floor((y - radius) / cellH)
    out.y1 = Math.ceil((y + radius) / cellH)
    if (out.x1 - out.x0 + 1 > this.resX) { out.x0 = 0; out.x1 = this.resX - 1 }
    if (out.y1 - out.y0 + 1 > this.resY) { out.y0 = 0; out.y1 = this.resY - 1 }
  }

  averagePoleRows(_field: Float32Array, _mask?: Uint8Array): void {}

  sampleBilinear(field: Float32Array, gx: number, gy: number): number {
    return sampleBilinearGrid(field, this.resX, this.resY, gx, gy)
  }

  // The arithmetic of erosionForcingFields.upsampleAt as it was written,
  // operation for operation.
  interpolate(field: Float32Array, gx: number, gy: number): number {
    const resX = this.resX
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const fx = gx - x0
    const fy = gy - y0
    const c0 = wrapValue(x0, resX)
    const c1 = wrapValue(x0 + 1, resX)
    const r0 = wrapValue(y0, this.resY) * resX
    const r1 = wrapValue(y0 + 1, this.resY) * resX
    return (field[r0 + c0] * (1 - fx) + field[r0 + c1] * fx) * (1 - fy) + (field[r1 + c0] * (1 - fx) + field[r1 + c1] * fx) * fy
  }

  // sampleBilinearGrid's index arithmetic, kept for sampleTaps.
  tapsAt(gx: number, gy: number, dx: number, dy: number, out: BilinearTaps, at: number): void {
    const resX = this.resX
    const resY = this.resY
    const x = wrapValue(gx + dx, resX)
    const y = wrapValue(gy + dy, resY)
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const x1 = (x0 + 1) % resX
    const y1 = (y0 + 1) % resY
    const tx = x - x0
    const i = 4 * at
    out.cells[i] = y0 * resX + x0
    out.cells[i + 1] = y0 * resX + x1
    out.cells[i + 2] = y1 * resX + x0
    out.cells[i + 3] = y1 * resX + x1
    const k = 3 * at
    out.weights[k] = tx
    out.weights[k + 1] = tx
    out.weights[k + 2] = y - y0
  }

  cellDisplaced(gx: number, gy: number, dx: number, dy: number): number {
    return this.index(Math.round(gx + dx), Math.round(gy + dy))
  }

  displaced(gx: number, gy: number, dx: number, dy: number, out: { x: number; y: number }): void {
    out.x = gx + dx
    out.y = gy + dy
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

// The torus's extent: MAP_WIDTH cells of TORUS_METERS_PER_CELL, the product
// in the order the old WORLD_WIDTH_METERS took it.
const TORUS_METRES_AROUND = MAP_WIDTH * TORUS_METERS_PER_CELL
// The sphere's metres per macro cell at the equator: 9 765.625, exact.
const SPHERE_METRES_PER_UNIT = SPHERE_EQUATOR_METERS / MAP_WIDTH

// The torus, with the thermal equator slid by `equatorOffset` (fraction of
// the height, positive toward the bottom) — the climate's one "move the
// equator" knob, applied once here.
export function torusDomain(width: number, height: number, equatorOffset = 0, metresPerUnit = TORUS_METERS_PER_CELL): Domain {
  const shifted = (yNorm: number): number => {
    const y = yNorm - equatorOffset
    return y - Math.floor(y)
  }
  const domain: Domain = {
    kind: 'torus',
    width,
    height,
    metresPerUnit,
    metresAround: TORUS_METRES_AROUND,
    latitude: (yNorm) => Math.abs(shifted(yNorm) - 0.5) * 2,
    north: (yNorm) => shifted(yNorm) < 0.5,
    delta: (ax, ay, bx, by, out) => {
      out.x = wrappedDelta(ax, bx, width)
      out.y = wrappedDelta(ay, by, height)
    },
    advance: (x, y, dx, dy, out) => {
      out.x = wrapValue(x + dx, width)
      out.y = wrapValue(y + dy, height)
    },
    displace: (x, y, dx, dy, out) => {
      out.x = x + dx
      out.y = y + dy
    },
    fromPlane: (px, py, _refX, _refY, out) => {
      out.x = wrapValue(px, width)
      out.y = wrapValue(py, height)
    },
    wrapX: (x) => wrapValue(x, width),
    wrapY: (y) => wrapValue(y, height),
    wrapPoint: (x, y, out) => {
      out.x = wrapValue(x, width)
      out.y = wrapValue(y, height)
    },
    distanceSq: (ax, ay, bx, by) => {
      const dx = wrappedDelta(ax, bx, width)
      const dy = wrappedDelta(ay, by, height)
      return dx * dx + dy * dy
    },
    rotateAround: (x, y, centerX, centerY, angle) => rotateAroundCenter(x, y, centerX, centerY, angle, width, height),
    transport: (vx, vy, _fromX, _fromY, _toX, _toY, out) => {
      out.x = vx
      out.y = vy
    },
    grid: (resX, resY) => new TorusGrid(domain, resX, resY),
    scaledTo: (w, h) => torusDomain(w, h, equatorOffset, (metresPerUnit * width) / w),
    noise: CHART_NOISE,
  }
  return domain
}

// THE SPHERE (DEC-0035 fork 2, step 4b). The chart is an ADDRESS: a domain
// of width W and height H = W / 2, x in [0, W) the longitude (λ = 2π·x/W,
// east toward +x), y in [0, H] the colatitude from the NORTH pole at y = 0
// to the south pole at y = H (φ = π/2 − π·y/H) — the globe view's chart
// (map/sphereView.ts: v = 0 at the north pole). Every distance is measured
// on the globe of radius R = W / (2π), so one domain unit is one unit of
// arc at the equator.
//
// The local frame of a point b, the one `delta` writes in: east (+x) and
// SOUTH (+y), the chart's own orientation, so a small offset reads as the
// chart's dx, dy scaled by cos φ in x. At a pole the frame is the limit
// along b's own meridian: "south" points along longitude x_b (away from
// the north pole, toward it at the south pole), "east" a quarter turn
// further. That is the same formula as everywhere else, so it needs no
// branch, and it is stable: a point held at a pole keeps its x and with it
// its frame. A point that ARRIVES at a pole by a rotation keeps no
// longitude (the chart's x there is arbitrary, and 0 is written).
export function sphereDomain(width: number, height: number, _equatorOffset = 0, metresPerUnit = SPHERE_METRES_PER_UNIT): Domain {
  // `equatorOffset` slides the torus's THERMAL equator: there the equator is
  // a declared row, so moving it is a choice. On the sphere the equator is
  // the geometry's, and a shifted climate equator is the climate's business
  // (the planet's season), not the Domain's — accepted because callers pass
  // it, and ignored.
  if (Math.abs(width - 2 * height) > 1e-9 * width) {
    throw new Error(`a sphere domain is a 2:1 chart (longitude × colatitude), got ${width} × ${height}`)
  }
  const radius = width / (2 * Math.PI)
  const toLon = (2 * Math.PI) / width
  const toColat = Math.PI / height
  const half = width / 2
  // A point's trig, cached: sin and cos of its colatitude θ and of HALF its
  // longitude λ. The hot loops ask the distance from one point to many — a
  // pixel to every blob, a blob to every cell — and four trig calls per
  // point per pair (seven per distance) made it 9× the torus's
  // (2026-10-10: 200 ns against 23; 55 ns with the cache). Direct-mapped by the coordinates' value; a hit returns the
  // very bits a miss computes, so the cache changes the time and nothing
  // else. Half the longitude, so that sin((λa − λb) / 2) is a difference of
  // two products, exactly 0 for one point twice.
  // 4096 slots, indexed by the top 12 bits of a multiplicative hash (the
  // low bits of a product see only the low bits of the coordinate).
  const CACHE = 4096
  const CACHE_SHIFT = 20
  const keyX = new Float64Array(CACHE).fill(Number.NaN)
  const keyY = new Float64Array(CACHE).fill(Number.NaN)
  const sinT = new Float64Array(CACHE)
  const cosT = new Float64Array(CACHE)
  const sinH = new Float64Array(CACHE)
  const cosH = new Float64Array(CACHE)
  const slot = (x: number, y: number): number => {
    const k = (Math.imul((x * 1024) | 0, 0x9e3779b1) ^ Math.imul((y * 1024) | 0, 0x85ebca77)) >>> CACHE_SHIFT
    if (keyX[k] !== x || keyY[k] !== y) {
      const t = y * toColat
      const h = (x * toLon) / 2
      sinT[k] = detSin(t)
      cosT[k] = detCos(t)
      sinH[k] = detSin(h)
      cosH[k] = detCos(h)
      keyX[k] = x
      keyY[k] = y
    }
    return k
  }
  // Point a seen from b: its components along b's east and south axes
  // (each sin of the arc times the direction's cosine) and the arc's cosine.
  // In the haversine form, so that a short offset keeps its precision: with
  // h = sin(Δλ / 2), sin Δλ = 2h cos(Δλ / 2) and 1 − cos Δλ = 2h², and the
  // colatitude's difference by its own sin and cos.
  let pe = 0
  let ps = 0
  let pc = 0
  const project = (ax: number, ay: number, bx: number, by: number): void => {
    let k = slot(ax, ay)
    const sa = sinT[k]
    const ca = cosT[k]
    const sha = sinH[k]
    const cha = cosH[k]
    k = slot(bx, by)
    const sb = sinT[k]
    const cb = cosT[k]
    const shb = sinH[k]
    const chb = cosH[k]
    const h = sha * chb - cha * shb
    const h2 = 2 * h * h
    pe = sa * (2 * h * (cha * chb + sha * shb))
    ps = (sa * cb - ca * sb) - cb * sa * h2
    pc = (ca * cb + sa * sb) - sa * sb * h2
  }
  const wrapY = (y: number): number => {
    const folded = wrapValue(y, 2 * height)
    return folded > height ? 2 * height - folded : folded
  }
  const wrapPoint = (x: number, y: number, out: { x: number; y: number }): void => {
    const folded = wrapValue(y, 2 * height)
    if (folded > height) {
      out.x = wrapValue(x + half, width)
      out.y = 2 * height - folded
    } else {
      out.x = wrapValue(x, width)
      out.y = folded
    }
  }
  const grids = new Map<number, SphereGrid>()
  const domain: Domain = {
    kind: 'sphere',
    width,
    height,
    metresPerUnit,
    metresAround: SPHERE_EQUATOR_METERS,
    // The torus's rule, which is the sphere's geometry: |φ| / 90°, linear
    // in the row.
    latitude: (yNorm) => Math.abs(yNorm - 0.5) * 2,
    north: (yNorm) => yNorm < 0.5,
    // The log map (azimuthal-equidistant): the direction from b toward a in
    // b's tangent plane, its length the great-circle distance. At the
    // antipode every direction is a shortest one; "south" is taken.
    delta: (ax, ay, bx, by, out) => {
      project(ax, ay, bx, by)
      const st = Math.sqrt(pe * pe + ps * ps)
      if (st === 0) {
        out.x = 0
        out.y = pc < 0 ? Math.PI * radius : 0
        return
      }
      const scale = (radius * detAtan2(st, pc)) / st
      out.x = pe * scale
      out.y = ps * scale
    },
    // The exp map: p · cos α + t · sin α, with p the start's unit vector, t
    // the offset's direction in its east/south frame and α the offset's
    // length in arc. The frame is delta's, the same formula at a pole
    // (south along the start's meridian x), so the two are inverse there
    // too. An end at a pole keeps no longitude: atan2(0, 0) writes 0, as
    // rotateAround does.
    advance: (x, y, dx, dy, out) => {
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d === 0) {
        wrapPoint(x, y, out)
        return
      }
      const t = y * toColat
      const l = x * toLon
      const st = detSin(t)
      const ct = detCos(t)
      const sl = detSin(l)
      const cl = detCos(l)
      // The start, its east axis (−sin λ, cos λ, 0) and its south axis
      // (cos θ cos λ, cos θ sin λ, −sin θ).
      const ue = dx / d
      const us = dy / d
      const tx = -sl * ue + ct * cl * us
      const ty = cl * ue + ct * sl * us
      const tz = -st * us
      const a = d / radius
      const ca = detCos(a)
      const sa = detSin(a)
      const qx = st * cl * ca + tx * sa
      const qy = st * sl * ca + ty * sa
      const qz = ct * ca + tz * sa
      wrapPoint(detAtan2(qy, qx) / toLon, detAtan2(Math.sqrt(qx * qx + qy * qy), qz) / toColat, out)
    },
    // Every chart coordinate names a point of the sphere (a colatitude past
    // a pole is the point over it), so there is nothing to leave unwrapped.
    displace: (x, y, dx, dy, out) => domain.advance(x, y, dx, dy, out),
    fromPlane: (px, py, refX, refY, out) => domain.advance(refX, refY, px - refX, py - refY, out),
    wrapX: (x) => wrapValue(x, width),
    // A reflection over the pole, the row alone — a moved point goes through
    // wrapPoint, which turns the longitude with it.
    wrapY,
    wrapPoint,
    // (R · arc)², the arc as atan2(|a × b|, a · b): sound at every distance,
    // where acos(a · b) loses the short ones.
    distanceSq: (ax, ay, bx, by) => {
      project(ax, ay, bx, by)
      const arc = radius * detAtan2(Math.sqrt(pe * pe + ps * ps), pc)
      return arc * arc
    },
    // A rotation by `angle` about the axis through the centre — an Euler
    // rotation, the plates' spin about their own centre (Rodrigues). In the
    // torus's sense on the chart: a positive angle turns east toward south.
    rotateAround: (x, y, centerX, centerY, angle) => {
      const tp = y * toColat
      const lp = x * toLon
      const sp = detSin(tp)
      const vx = sp * detCos(lp)
      const vy = sp * detSin(lp)
      const vz = detCos(tp)
      const tc = centerY * toColat
      const lc = centerX * toLon
      const sc = detSin(tc)
      const kx = sc * detCos(lc)
      const ky = sc * detSin(lc)
      const kz = detCos(tc)
      // About the axis with angle −α: the right-hand turn about the outward
      // axis takes east toward NORTH, the chart's −y.
      const c = detCos(angle)
      const s = -detSin(angle)
      const kv = (kx * vx + ky * vy + kz * vz) * (1 - c)
      const rx = vx * c + (ky * vz - kz * vy) * s + kx * kv
      const ry = vy * c + (kz * vx - kx * vz) * s + ky * kv
      const rz = vz * c + (kx * vy - ky * vx) * s + kz * kv
      return {
        x: wrapValue(detAtan2(ry, rx) / toLon, width),
        y: detAtan2(Math.sqrt(rx * rx + ry * ry), rz) / toColat,
      }
    },
    // R = I + [v]× + [v]×² / (1 + c), the rotation taking u_from to u_to,
    // with v = u_from × u_to and c = u_from · u_to, applied to the vector
    // t: c·t + v × t + v (v · t) / (1 + c). Read in u_to's east/south
    // frame. Two antipodal points have no single great circle; the vector
    // is then read as it stands.
    transport: (vx, vy, fromX, fromY, toX, toY, out) => {
      const ta = fromY * toColat
      const la = fromX * toLon
      const sta = detSin(ta)
      const cta = detCos(ta)
      const sla = detSin(la)
      const cla = detCos(la)
      const tb = toY * toColat
      const lb = toX * toLon
      const stb = detSin(tb)
      const ctb = detCos(tb)
      const slb = detSin(lb)
      const clb = detCos(lb)
      // t in 3D from the start's east (−sin λ, cos λ, 0) and south
      // (cos θ cos λ, cos θ sin λ, −sin θ).
      const tx = -sla * vx + cta * cla * vy
      const ty = cla * vx + cta * sla * vy
      const tz = -sta * vy
      const ax = sta * cla
      const ay = sta * sla
      const az = cta
      const bx = stb * clb
      const by = stb * slb
      const bz = ctb
      const c = ax * bx + ay * by + az * bz
      let rx = tx
      let ry = ty
      let rz = tz
      if (c > -1 + 1e-12) {
        const wx = ay * bz - az * by
        const wy = az * bx - ax * bz
        const wz = ax * by - ay * bx
        const k = (wx * tx + wy * ty + wz * tz) / (1 + c)
        rx = c * tx + (wy * tz - wz * ty) + wx * k
        ry = c * ty + (wz * tx - wx * tz) + wy * k
        rz = c * tz + (wx * ty - wy * tx) + wz * k
      }
      out.x = -slb * rx + clb * ry
      out.y = ctb * clb * rx + ctb * slb * ry - stb * rz
    },
    // One grid per size, kept: a sphere grid builds its row tables in trig,
    // and callers ask for one per call (some per point — the ocean-age
    // sampler's, 2026-10-10: four seconds of a full render). A grid holds
    // no state between calls.
    grid: (resX, resY) => {
      const key = resX * 65536 + resY
      let g = grids.get(key)
      if (!g) {
        g = new SphereGrid(domain, resX, resY)
        grids.set(key, g)
      }
      return g
    },
    scaledTo: (w, h) => sphereDomain(w, h, 0, (metresPerUnit * width) / w),
    // The unit vector and the axes are advance's: u = (sin θ cos λ,
    // sin θ sin λ, cos θ), east (−sin λ, cos λ, 0), south (cos θ cos λ,
    // cos θ sin λ, −sin θ). At the north pole sin θ is exactly 0, so the
    // position is (0, 0, R) for every x.
    noise: {
      kind: 'globe',
      radius,
      frame: (x, y, out) => {
        const t = y * toColat
        const l = x * toLon
        const st = detSin(t)
        const ct = detCos(t)
        const sl = detSin(l)
        const cl = detCos(l)
        out.px = radius * st * cl
        out.py = radius * st * sl
        out.pz = radius * ct
        out.ex = -sl
        out.ey = cl
        out.ez = 0
        out.sx = ct * cl
        out.sy = ct * sl
        out.sz = -st
      },
      locate: (px, py, pz, out) => {
        out.x = wrapValue(detAtan2(py, px) / toLon, width)
        out.y = detAtan2(Math.sqrt(px * px + py * py), pz) / toColat
      },
    },
  }
  return domain
}

// The sphere's raster over the 2:1 chart (DEC-0035, fork 5): row j covers
// the colatitude band [j, j + 1) · π / resY, so row 0 touches the north
// pole and row resY − 1 the south pole. Columns wrap in longitude. A step
// past a pole row lands in the same row, column + resX / 2 — the cell on
// the other side of the pole — so resX must be even.
//
// The samplers do the same: a bilinear sample near a pole interpolates
// toward the reflected row on the opposite meridian, not toward a clamped
// copy of the pole row, so a field is continuous across the pole; at the
// pole itself the sample is the mean of the two meridians it lies between.
// After averagePoleRows a pole row is one value and the two agree.
//
// Hot-loop tables: colTable is the longitude wrap and works as on the
// torus. rowTable cannot express the column shift that goes with a row
// beyond a pole, so it refuses any margin; a sphere stage walks
// neighbours through `neighbour` (or a pole-aware table, when a hot loop
// in step 4d needs one).
class SphereGrid implements DomainGrid {
  readonly domain: Domain
  readonly resX: number
  readonly resY: number
  private readonly width: number
  private readonly height: number
  private readonly halfCols: number
  private readonly rowScales: Float64Array
  private readonly cellAreas: Float64Array
  private readonly edgeScales: Float64Array
  private readonly point = { x: 0, y: 0 }

  constructor(domain: Domain, resX: number, resY: number) {
    if (resX % 2 !== 0) throw new Error(`a sphere grid needs an even column count (across a pole is column + resX / 2), got ${resX}`)
    this.domain = domain
    this.resX = resX
    this.resY = resY
    this.width = domain.width
    this.height = domain.height
    this.halfCols = resX / 2
    // The band of row j has the area 2πR²(cos θ0 − cos θ1) / resX per cell,
    // = 2πR² · 2 sin θc sin(Δθ / 2) / resX; a chart cell has 2π²R² /
    // (resX · resY). Their ratio is 2 sin θc sin(Δθ / 2) · resY / π, which
    // sums over the rows to exactly 2 · resY / π (Σ cos θ0 − cos θ1 = 2).
    const band = (2 * detSin(Math.PI / (2 * resY)) * resY) / Math.PI
    this.rowScales = new Float64Array(resY)
    this.cellAreas = new Float64Array(resY)
    for (let j = 0; j < resY; j++) {
      const scale = detSin(((j + 0.5) * Math.PI) / resY)
      this.rowScales[j] = scale
      this.cellAreas[j] = scale * band
    }
    // The poles' edges are points: exactly 0, not detSin(π)'s last bit.
    this.edgeScales = new Float64Array(resY + 1)
    for (let j = 1; j < resY; j++) this.edgeScales[j] = detSin((j * Math.PI) / resY)
  }

  wrapCol(x: number): number {
    return wrapValue(x, this.resX)
  }

  // Reflected over the poles, in the convention of cell centres at
  // integers: the north pole lies at −0.5, the south at resY − 0.5. An
  // integer row comes back as a row index in [0, resY); a fractional one in
  // [−0.5, resY − 0.5]. The row alone: the column shift that goes with it
  // is `neighbour`'s.
  wrapRow(y: number): number {
    const n = this.resY
    const folded = wrapValue(y + 0.5, 2 * n) - 0.5
    return folded <= n - 0.5 ? folded : 2 * n - 1 - folded
  }

  // Whether the integer row r lies an odd number of poles away: then its
  // cells are on the opposite meridian.
  private crossed(r: number): boolean {
    return (Math.floor(r / this.resY) & 1) === 1
  }

  index(x: number, y: number): number {
    return this.neighbour(x, y, 0, 0)
  }

  neighbour(x: number, y: number, dx: number, dy: number): number {
    const r = y + dy
    const c = this.crossed(r) ? x + dx + this.halfCols : x + dx
    return this.wrapRow(r) * this.resX + wrapValue(c, this.resX)
  }

  colTable(margin: number): Int32Array {
    const out = new Int32Array(this.resX + 2 * margin)
    for (let k = 0; k < out.length; k++) out[k] = wrapValue(k - margin, this.resX)
    return out
  }

  rowTable(margin: number): Int32Array {
    if (margin > 0) {
      throw new Error('a row table cannot express the column shift across a pole: on the sphere use DomainGrid.neighbour (DEC-0035, fork 5)')
    }
    const out = new Int32Array(this.resY)
    for (let k = 0; k < out.length; k++) out[k] = k * this.resX
    return out
  }

  // `y` a row index.
  rowScale(y: number): number {
    return this.rowScales[this.wrapRow(Math.floor(y))]
  }

  cellArea(y: number): number {
    return this.cellAreas[this.wrapRow(Math.floor(y))]
  }

  // `y` an edge index, 0 (the north pole) to resY (the south pole).
  edgeScale(y: number): number {
    return this.edgeScales[Math.max(0, Math.min(this.resY, Math.round(y)))]
  }

  discBox(x: number, y: number, radius: number, out: CellBox): void {
    this.domain.wrapPoint(x, y, this.point)
    const cellW = this.width / this.resX
    const cellH = this.height / this.resY
    const yc = this.point.y
    out.y0 = Math.max(0, Math.floor((yc - radius) / cellH))
    out.y1 = Math.min(this.resY - 1, Math.ceil((yc + radius) / cellH))
    out.x0 = 0
    out.x1 = this.resX - 1
    // A cap that holds a pole reaches every longitude.
    if (yc - radius <= 0 || yc + radius >= this.height) return
    // Its widest span in longitude, in chart units (R · Δλ): the cap of arc
    // α = radius / R about colatitude θ reaches asin(sin α / sin θ) east and
    // west. A margin far above the rounding, as the blob index files with.
    const R = this.width / (2 * Math.PI)
    const ratio = detSin(radius / R) / detSin(yc / R)
    if (!(ratio < 1)) return
    const span = detAsin(ratio) * R * (1 + 1e-9) + 1e-6
    const x0 = Math.floor((this.point.x - span) / cellW)
    const x1 = Math.ceil((this.point.x + span) / cellW)
    if (x1 - x0 + 1 > this.resX) return
    out.x0 = x0
    out.x1 = x1
  }

  // The cells of a pole row are all the same size, so the area-weighted mean
  // is the plain one; the field's area-weighted mean over the sphere is kept.
  averagePoleRows(field: Float32Array, mask?: Uint8Array): void {
    const rows = this.resY === 1 ? [0] : [0, this.resY - 1]
    for (const row of rows) {
      const base = row * this.resX
      if (!mask) {
        let sum = 0
        for (let i = 0; i < this.resX; i++) sum += field[base + i]
        field.fill(sum / this.resX, base, base + this.resX)
        continue
      }
      let sum = 0
      let count = 0
      for (let i = 0; i < this.resX; i++) if (mask[base + i]) { sum += field[base + i]; count++ }
      if (count === 0) continue
      const mean = sum / count
      for (let i = 0; i < this.resX; i++) if (mask[base + i]) field[base + i] = mean
    }
  }

  interpolate(field: Float32Array, gx: number, gy: number): number {
    return this.sampleBilinear(field, gx, gy)
  }

  // From the cell centre along the great circle (Domain.advance, in domain
  // units: a grid cell is width / resX of them at the equator), then the
  // reached point's taps in sampleBilinear's convention, row by row as
  // rowSample takes them.
  tapsAt(gx: number, gy: number, dx: number, dy: number, out: BilinearTaps, at: number): void {
    const cellW = this.width / this.resX
    const cellH = this.height / this.resY
    this.domain.advance((gx + 0.5) * cellW, (gy + 0.5) * cellH, dx * cellW, dy * cellH, this.point)
    const sx = this.point.x / cellW - 0.5
    const sy = this.point.y / cellH - 0.5
    const y0 = Math.floor(sy)
    const i = 4 * at
    const k = 3 * at
    for (let r = 0; r < 2; r++) {
      const row = y0 + r
      const x = wrapValue(this.crossed(row) ? sx + this.halfCols : sx, this.resX)
      const x0 = Math.floor(x)
      const x1 = x0 + 1 < this.resX ? x0 + 1 : 0
      const base = this.wrapRow(row) * this.resX
      out.cells[i + 2 * r] = base + x0
      out.cells[i + 2 * r + 1] = base + x1
      out.weights[k + r] = x - x0
    }
    out.weights[k + 2] = sy - y0
  }

  cellDisplaced(gx: number, gy: number, dx: number, dy: number): number {
    const cellW = this.width / this.resX
    const cellH = this.height / this.resY
    this.domain.advance((gx + 0.5) * cellW, (gy + 0.5) * cellH, dx * cellW, dy * cellH, this.point)
    return this.cellAt(this.point.x, this.point.y)
  }

  displaced(gx: number, gy: number, dx: number, dy: number, out: { x: number; y: number }): void {
    const cellW = this.width / this.resX
    const cellH = this.height / this.resY
    this.domain.advance((gx + 0.5) * cellW, (gy + 0.5) * cellH, dx * cellW, dy * cellH, this.point)
    out.x = this.point.x / cellW - 0.5
    out.y = this.point.y / cellH - 0.5
  }

  // Row r (any integer) sampled linearly at fractional column gx.
  private rowSample(field: Float32Array, r: number, gx: number): number {
    const x = wrapValue(this.crossed(r) ? gx + this.halfCols : gx, this.resX)
    const x0 = Math.floor(x)
    const x1 = x0 + 1 < this.resX ? x0 + 1 : 0
    const tx = x - x0
    const base = this.wrapRow(r) * this.resX
    return field[base + x0] * (1 - tx) + field[base + x1] * tx
  }

  sampleBilinear(field: Float32Array, gx: number, gy: number): number {
    const y0 = Math.floor(gy)
    const ty = gy - y0
    const top = this.rowSample(field, y0, gx)
    const bottom = this.rowSample(field, y0 + 1, gx)
    return top * (1 - ty) + bottom * ty
  }

  sampleBilinearAt(field: Float32Array, x: number, y: number): number {
    return this.sampleBilinear(field, (x / this.width) * this.resX - 0.5, (y / this.height) * this.resY - 0.5)
  }

  cellAt(x: number, y: number): number {
    this.domain.wrapPoint(x, y, this.point)
    const gx = Math.min(this.resX - 1, Math.floor((this.point.x / this.width) * this.resX))
    const gy = Math.min(this.resY - 1, Math.floor((this.point.y / this.height) * this.resY))
    return gy * this.resX + gx
  }

  sampleNearestAt(field: Float32Array, x: number, y: number): number {
    return field[this.cellAt(x, y)]
  }

  // Cell centre onto cell centre. Not the torus's convention, which samples
  // the target cell's corner and so shifts by half a source cell — kept
  // there byte-identical; on the sphere a shift in y is a shift in
  // latitude.
  upscale(field: Float32Array, toResX: number, toResY: number): Float32Array {
    const out = new Float32Array(toResX * toResY)
    const fx = this.resX / toResX
    const fy = this.resY / toResY
    for (let y = 0; y < toResY; y++) {
      const gy = (y + 0.5) * fy - 0.5
      for (let x = 0; x < toResX; x++) out[y * toResX + x] = this.sampleBilinear(field, (x + 0.5) * fx - 0.5, gy)
    }
    return out
  }
}
