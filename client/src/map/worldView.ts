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

export type WorldShape = 'flat' | 'sphere'

// Polylines in chart texels, as the hydrology hands them over.
export interface WorldRivers {
  setPolylines(points: Float32Array, lengths: Uint32Array, regimes?: Uint8Array): void
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
  // The names over the map.
  readonly labelTexture: RawTexture
  setLabelsVisible(visible: boolean): void
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
  // Camera: drag on or off (another gesture may own the drag), the deep zoom
  // that only eroded terrain earns, and back to where it started.
  setPanEnabled(enabled: boolean): void
  setDeepZoom(enabled: boolean): void
  resetCamera(): void
  dispose(): void
}
