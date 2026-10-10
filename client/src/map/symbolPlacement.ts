import type { ChartPoint } from './worldView'

// WHERE A SYMBOL LIES (worldView.ts, WorldSymbols): the chart of each view
// and the frame a symbol is laid in, as pure arithmetic — no scene, so a
// script can check it (scripts/symbolPlacement.mjs). The views use these
// functions for their own chart, so the check reads the code that runs.
//
// A FRAME is a point on the view's reference surface and two unit vectors in
// the surface there: `right` and `up`, the picture's x and y axes. Seen from
// the camera's side (above the flat map, outside the globe), right then up
// turn the same way as the screen's own right and up: the picture is never
// mirrored. Babylon's frame is left-handed, so (right × up) · normal < 0.

export type Vec3 = [number, number, number]

export interface SymbolFrame {
  centre: Vec3
  right: Vec3
  up: Vec3
  normal: Vec3
}

// A symbol's turn (WorldSymbol.angle, .readable): from the view's own right
// and up at the point and a direction in those two axes, the picture's axes.
// `readable`: a half turn more where the x axis would point to the left.
function turnedFrame(centre: Vec3, right: Vec3, up: Vec3, normal: Vec3, along: [number, number] | null, readable: boolean): SymbolFrame {
  if (!along) return { centre, right, up, normal }
  let [a, b] = along
  const length = Math.hypot(a, b)
  if (length === 0) return { centre, right, up, normal }
  a /= length
  b /= length
  if (readable && a < -1e-9) {
    a = -a
    b = -b
  }
  const turnedRight: Vec3 = [right[0] * a + up[0] * b, right[1] * a + up[1] * b, right[2] * a + up[2] * b]
  const turnedUp: Vec3 = [-right[0] * b + up[0] * a, -right[1] * b + up[1] * a, -right[2] * b + up[2] * a]
  return { centre, right: turnedRight, up: turnedUp, normal }
}

// --- the flat map (flatWorldView.ts) ----------------------------------------
//
// The plane spans width × height scene units centred on the origin, and its
// UVs run u = x / width + 0.5, v = z / height + 0.5 (Babylon's ground). A
// layer's texel (u · W, v · H) shows at the scene point of (u, v), which is
// why the grid's first row lies at −z: under the generator's camera, north
// up, the screen's up is +z and its right +x, so the view's up is the grid's
// BOTTOM (the vertical mirror the texture-painted text had to undo).

export interface FlatChart {
  // The plane's size in scene units.
  width: number
  height: number
}

const wrapUnit = (f: number): number => ((f % 1) + 1) % 1

export function flatChartOfScene(chart: FlatChart, x: number, z: number): ChartPoint {
  return { u: wrapUnit(x / chart.width + 0.5), v: wrapUnit(z / chart.height + 0.5) }
}

// The scene point of a chart point, in the period centred on the origin.
export function flatSceneOfChart(chart: FlatChart, at: ChartPoint): { x: number; z: number } {
  return { x: (wrapUnit(at.u) - 0.5) * chart.width, z: (wrapUnit(at.v) - 0.5) * chart.height }
}

// `angle`: a chart direction in texels (x across, y down the rows), or
// undefined for upright. Texels are square on the flat map, so the direction
// is the same on the plane: x to +x, y to +z.
export function flatSymbolFrame(chart: FlatChart, at: ChartPoint, lift: number, angle: number | undefined, readable: boolean): SymbolFrame {
  const { x, z } = flatSceneOfChart(chart, at)
  const along: [number, number] | null = angle === undefined ? null : [Math.cos(angle), Math.sin(angle)]
  return turnedFrame([x, lift, z], [1, 0, 0], [0, 0, 1], [0, 1, 0], along, readable)
}

// A point of the picture, (x, y) metres from its centre along right and up,
// on the plane: `unitsPerMetre` scene units to the metre.
export function flatSymbolVertex(frame: SymbolFrame, x: number, y: number, unitsPerMetre: number, out: Float32Array, offset: number): void {
  const { centre, right, up } = frame
  out[offset] = centre[0] + (right[0] * x + up[0] * y) * unitsPerMetre
  out[offset + 1] = centre[1]
  out[offset + 2] = centre[2] + (right[2] * x + up[2] * y) * unitsPerMetre
}

// --- the globe (sphereView.ts) ----------------------------------------------
//
// The chart is longitude and latitude in the globe's own frame (below its
// tilt), laid as Babylon's sphere lays its UVs: u once round the axis from
// +x toward −z, v from the north pole (+y, v = 0) to the south. Radius 1.

export function globeChartOfFrame(point: Vec3): ChartPoint {
  const length = Math.hypot(point[0], point[1], point[2]) || 1
  const longitude = Math.atan2(-point[2] / length, point[0] / length)
  const latitude = Math.asin(Math.max(-1, Math.min(1, point[1] / length)))
  return { u: (longitude / (2 * Math.PI) + 1) % 1, v: 0.5 - latitude / Math.PI }
}

export function globeFrameOfChart(at: ChartPoint): Vec3 {
  const longitude = at.u * 2 * Math.PI
  const latitude = (0.5 - Math.max(0, Math.min(1, at.v))) * Math.PI
  const c = Math.cos(latitude)
  return [c * Math.cos(longitude), Math.sin(latitude), -c * Math.sin(longitude)]
}

// The view's right and up at a point: up toward the north pole, right the
// screen's right when north is up — the direction of DEcreasing u, since u
// runs from +x toward −z, which is the screen's left seen from outside.
// `angle` is a chart direction in texels; a texel's width on the globe is
// cos φ of its height, so the direction is measured with that metric.
export function globeSymbolFrame(at: ChartPoint, angle: number | undefined, readable: boolean): SymbolFrame {
  const longitude = at.u * 2 * Math.PI
  const latitude = (0.5 - Math.max(0, Math.min(1, at.v))) * Math.PI
  const sinL = Math.sin(longitude)
  const cosL = Math.cos(longitude)
  const sinP = Math.sin(latitude)
  const cosP = Math.cos(latitude)
  const centre: Vec3 = [cosP * cosL, sinP, -cosP * sinL]
  const right: Vec3 = [sinL, 0, cosL]
  const up: Vec3 = [-sinP * cosL, cosP, sinP * sinL]
  // +u is −right, +v (down the rows) is −up.
  const along: [number, number] | null = angle === undefined ? null : [-Math.cos(angle) * cosP, -Math.sin(angle)]
  return turnedFrame(centre, right, up, centre, along, readable)
}

// A point of the picture on the sphere: the step (x, y) metres along right
// and up, walked as a great circle from the centre (the exponential map), so
// distances and angles from the centre hold at any size — round at the
// poles as at the equator. `lift`: the radius it lies at, a little over 1.
export function globeSymbolVertex(frame: SymbolFrame, x: number, y: number, radiusMetres: number, lift: number, out: Float32Array, offset: number): void {
  const { centre, right, up } = frame
  const tx = (right[0] * x + up[0] * y) / radiusMetres
  const ty = (right[1] * x + up[1] * y) / radiusMetres
  const tz = (right[2] * x + up[2] * y) / radiusMetres
  const d = Math.hypot(tx, ty, tz)
  const along = d > 0 ? Math.sin(d) / d : 1
  const c = Math.cos(d)
  out[offset] = (centre[0] * c + tx * along) * lift
  out[offset + 1] = (centre[1] * c + ty * along) * lift
  out[offset + 2] = (centre[2] * c + tz * along) * lift
}
