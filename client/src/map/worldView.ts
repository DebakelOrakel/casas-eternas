import type { RawTexture, Scene } from '@babylonjs/core'
import type { ElevationSurface } from './elevationSurface'

// THE WORLD VIEW (docs/decisions/two-shapes.md, DEC-0035, fork 3): what a
// screen draws a world through, whatever its shape. The screen paints its
// layers into textures in CHART texels — the 2:1 chart both shapes keep
// their data in — and hands over relief and rivers; the view puts them on
// screen, holds its own scene and camera, and says which chart point lies
// under the pointer.
//
// Two implementations: the flat torus (flatWorldView.ts, the map plane with
// its wrap copies) and the globe (sphereView.ts). A screen talks to this
// interface alone; what only one shape can show, the other takes and
// ignores.
//
// SYMBOLS AND NAMES are not painted into the textures (2026-10-10): a circle
// in the chart is an ellipse on the globe, stretched 1 / cos φ toward the
// poles. The screen hands them over as OBJECTS (WorldSymbols), and the view
// lays each one in its surface, round wherever it lies.

export type WorldShape = 'flat' | 'sphere'

// A point of the chart, as fractions: u across, v down its rows, each in
// [0, 1) — texel (u · width, v · height) of any layer.
export interface ChartPoint {
  u: number
  v: number
}

// Polylines in chart texels, as the hydrology hands them over.
export interface WorldRivers {
  setPolylines(points: Float32Array, lengths: Uint32Array, regimes?: Uint8Array): void
  setEnabled(enabled: boolean): void
}

// A picture symbols show: drawn by the screen into a canvas of its own,
// upright (the canvas's top is the picture's top), and its size ON THE
// WORLD in metres — it zooms with the world, it does not keep its size on
// the screen. The canvas's resolution is the screen's choice.
export interface SymbolPicture {
  image: HTMLCanvasElement
  width: number
  height: number
}

// One symbol: a picture of its layer, its centre at a chart point, lying in
// the surface. Without `angle` it stands upright: its top toward the view's
// top when the view is turned north up (the flat map's grid bottom, the
// globe's north pole). With `angle`, its x axis runs along that direction
// ON THE SURFACE at its point, radians, x along the rows (toward +u) and y
// down them (toward +v), measured in true lengths — the generator's local
// frame (Domain.delta). On the flat map that is the chart's texels; on the
// globe the frame's east and south, not a texel's (cos φ narrower) shape.
// `readable`: a half turn more
// where the x axis would point to the left, for text. `alpha` (default 1)
// fades it.
export interface WorldSymbol {
  at: ChartPoint
  picture: number
  angle?: number
  readable?: boolean
  alpha?: number
}

// A layer of symbols: its pictures, its symbols, on or off. Drawn over the
// world's layers, relief, water and rivers, the layers in the order they
// were first asked for (WorldView.symbols). Setting the symbols alone is
// cheap — for a fade, frame by frame.
export interface WorldSymbols {
  setPictures(pictures: SymbolPicture[]): void
  setSymbols(symbols: WorldSymbol[]): void
  setEnabled(enabled: boolean): void
}

export interface WorldView {
  readonly shape: WorldShape
  readonly scene: Scene
  // The composited map, with the hillshade baked in.
  readonly baseTexture: RawTexture
  // The same composite without the hillshade, for the relief, whose own
  // normals and light shade it.
  readonly reliefTexture: RawTexture
  setLakesVisible(visible: boolean): void
  // Standing water: the per-cell level and surface kind, and the coast type,
  // or nulls for "the sea everywhere"; the terrain the shores are found on.
  setWaterLevels(level: Float32Array | null, surface: Uint8Array | null, coast?: Uint8Array | null): void
  setWaterElevation(data: Float32Array, width: number, height: number): void
  // The relief: a coarse and a fine surface, metre-true, or null for none;
  // the vertical exaggeration it is drawn with.
  setRelief(coarse: ElevationSurface | null, fine?: ElevationSurface | null): void
  setHeightScale(scale: number): void
  readonly rivers: WorldRivers
  // The symbol layer of an id, made on the first ask and kept with the view;
  // hidden until enabled.
  symbols(id: string): WorldSymbols
  // The chart point under a screen pixel (canvas pixels). `chartAt` meets
  // the view's REFERENCE surface analytically — the flat map's plane, the
  // globe's sphere — in microseconds, for readings that need many points
  // (the temperature scale, the scale bar); `groundAt` picks what is drawn,
  // relief included, for the pointer. Null off the world.
  chartAt(screenX: number, screenY: number): ChartPoint | null
  groundAt(screenX: number, screenY: number): ChartPoint | null
  // How far apart two chart points are on the world, in metres.
  metresBetween(a: ChartPoint, b: ChartPoint): number
  // Changes whenever what the screen shows of the world does (position,
  // zoom, turn): a key to compare, not to read.
  viewKey(): string
  // Camera: drag on or off (another gesture may own the drag), the deep zoom
  // that only eroded terrain earns, and back to where it started.
  setPanEnabled(enabled: boolean): void
  setDeepZoom(enabled: boolean): void
  resetCamera(): void
  dispose(): void
}
