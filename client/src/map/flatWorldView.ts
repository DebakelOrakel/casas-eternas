import { Color4, type Engine, Scene } from '@babylonjs/core'
import { createGeneratorCamera, type GeneratorCamera } from '../camera/generatorCamera'
import type { ElevationSurface } from './elevationSurface'
import { MAP_WORLD_HEIGHT, MAP_WORLD_WIDTH, RELIEF_FINE_ZOOM, RELIEF_MIN_ZOOM } from './mapSceneSettings'
import { pickMapPlane } from './ScaleBar'
import { createToroidalMapView } from './ToroidalMapView'
import { createToroidalRibbonOverlay } from './ToroidalRibbonOverlay'
import type { WorldView } from './worldView'

// THE FLAT WORLD VIEW (docs/decisions/two-shapes.md, fork 3): the torus
// drawn as the map plane with its wrap copies (ToroidalMapView), the river
// ribbons tiled with it (ToroidalRibbonOverlay), under the generator's
// camera rig (camera/generatorCamera.ts). Moved out of the generator
// screen on 2026-10-10, unchanged in what it draws.
//
// Beyond WorldView it still offers the flat camera's state and the plane
// pick, which the screen's scale bar, temperature scale and hover readout
// read until they ask in chart coordinates.

export interface FlatWorldView extends WorldView {
  readonly shape: 'flat'
  getFocus(): { x: number; z: number }
  getZoom(): number
  getYaw(): number
  // The map PLANE's point under a screen pixel, in scene units (x, z): met
  // analytically (ScaleBar.ts, pickMapPlane), never a pick against the
  // relief — that cost milliseconds a ray at deep zoom, and the temperature
  // scale's 64 of them made the pan stutter (2026-09-27, and again for a day
  // on 2026-10-10 when the move wired the mesh pick here).
  pickPlane(screenX: number, screenY: number): { x: number; z: number } | null
}

export interface FlatWorldViewOptions {
  engine: Engine
  canvas: HTMLCanvasElement
  // The chart's size in texels: the layers' textures.
  textureWidth: number
  textureHeight: number
}

export function createFlatWorldView(options: FlatWorldViewOptions): FlatWorldView {
  const { engine, canvas, textureWidth, textureHeight } = options
  const scene = new Scene(engine)
  scene.clearColor = new Color4(1, 1, 1, 1)

  const camera: GeneratorCamera = createGeneratorCamera({
    scene,
    canvas,
    engine,
    worldWidth: MAP_WORLD_WIDTH,
    worldHeight: MAP_WORLD_HEIGHT,
  })

  // The relief's two surfaces, and which of them the ribbons lie on —
  // swapped in lockstep with the relief level the map shows, from its
  // per-frame recenter hook, so the rivers always drape the surface on
  // screen, at widths that fit its scale.
  let coarseSurface: ElevationSurface | null = null
  let fineSurface: ElevationSurface | null = null
  let ribbonLevel: 'flat' | 'coarse' | 'fine' = 'flat'

  // Scene-space river ribbons (crisp at any zoom, not baked into the map
  // texture), tiled for the torus wrap through the recenter hook. Made
  // after the map plane, as the screen made them before the move.
  let rivers: ReturnType<typeof createToroidalRibbonOverlay> | null = null

  const map = createToroidalMapView({
    scene,
    worldWidth: MAP_WORLD_WIDTH,
    worldHeight: MAP_WORLD_HEIGHT,
    textureWidth,
    textureHeight,
    getFocus: camera.getFocus,
    getYaw: camera.getYaw,
    reliefDetail: () => {
      const zoom = camera.getZoom()
      return zoom > RELIEF_FINE_ZOOM ? 'fine' : zoom > RELIEF_MIN_ZOOM ? 'coarse' : 'flat'
    },
    onRecenter: (centerX, centerZ) => {
      if (!rivers) return
      rivers.recenter(centerX, centerZ)
      // Keep the ribbons draped on whichever relief surface is on screen
      // (rebuilds are a few ms and only happen on an actual level
      // transition; width follows zoom continuously in the overlay's own
      // shader). Level is 'flat' whenever no relief exists, whatever the
      // zoom.
      const zoom = camera.getZoom()
      const level: typeof ribbonLevel = !coarseSurface ? 'flat' : zoom > RELIEF_FINE_ZOOM ? 'fine' : zoom > RELIEF_MIN_ZOOM ? 'coarse' : 'flat'
      if (level !== ribbonLevel) {
        ribbonLevel = level
        if (coarseSurface) rivers.setHeightSurface(level === 'fine' && fineSurface ? fineSurface : coarseSurface)
      }
    },
  })

  const ribbons = createToroidalRibbonOverlay({
    scene,
    worldWidth: MAP_WORLD_WIDTH,
    worldHeight: MAP_WORLD_HEIGHT,
    textureWidth,
    textureHeight,
    getViewWidth: camera.getViewWidth,
  })
  ribbons.setEnabled(false)
  rivers = ribbons

  return {
    shape: 'flat',
    scene,
    baseTexture: map.texture,
    reliefTexture: map.reliefTexture,
    labelTexture: map.labelTexture,
    setLabelsVisible: (visible) => map.setLabelsVisible(visible),
    setLakesVisible: (visible) => map.setLakesVisible(visible),
    setWaterLevels: (level, surface, coast) => map.setWaterLevels(level, surface, coast),
    setWaterElevation: (data, width, height) => map.setWaterElevation(data, width, height),
    setRelief(coarse, fine = null) {
      coarseSurface = coarse
      fineSurface = fine
      map.setReliefSurfaces(coarse, fine)
      if (!coarse) {
        ribbonLevel = 'flat'
        ribbons.setHeightSurface(null)
        return
      }
      ribbons.setHeightSurface(ribbonLevel === 'fine' ? fineSurface : coarseSurface)
    },
    setHeightScale(scale) {
      // The ribbons carry the ground's scale, or they sink inside it
      // (ToroidalRibbonOverlay.setHeightScale).
      map.setHeightScale(scale)
      ribbons.setHeightScale(scale)
    },
    rivers: ribbons,
    setPanEnabled: (enabled) => camera.setPanEnabled(enabled),
    setDeepZoom: (enabled) => camera.setDeepZoomEnabled(enabled),
    // Not asked for the flat map yet (DEC-0035, "what this does not decide").
    resetCamera: () => {},
    getFocus: camera.getFocus,
    getZoom: camera.getZoom,
    getYaw: camera.getYaw,
    pickPlane: (screenX, screenY) => pickMapPlane(scene, screenX, screenY),
    dispose() {
      ribbons.dispose()
      map.dispose()
      // scene.dispose() does not remove the camera rig's own 'wheel'
      // listener on the shared canvas; the rig goes by hand.
      camera.dispose()
      scene.dispose()
    },
  }
}
