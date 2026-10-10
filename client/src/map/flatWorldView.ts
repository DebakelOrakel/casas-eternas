import { type AbstractMesh, Color4, type Engine, type InstancedMesh, Scene } from '@babylonjs/core'
import { createGeneratorCamera, type GeneratorCamera } from '../camera/generatorCamera'
import type { ElevationSurface } from './elevationSurface'
import { MAP_WORLD_HEIGHT, MAP_WORLD_WIDTH, RELIEF_FINE_ZOOM, RELIEF_MIN_ZOOM } from './mapSceneSettings'
import { pickMapPlane } from './ScaleBar'
import { createSymbolLayerSet } from './symbolLayer'
import { type FlatChart, flatChartOfScene, flatSymbolFrame, flatSymbolVertex } from './symbolPlacement'
import { createToroidalMapView, LABEL_RENDERING_GROUP } from './ToroidalMapView'
import { createToroidalRibbonOverlay } from './ToroidalRibbonOverlay'
import type { WorldView } from './worldView'

// THE FLAT WORLD VIEW (docs/decisions/two-shapes.md, fork 3): the torus
// drawn as the map plane with its wrap copies (ToroidalMapView), the river
// ribbons tiled with it (ToroidalRibbonOverlay), under the generator's
// camera rig (camera/generatorCamera.ts). Moved out of the generator
// screen on 2026-10-10, unchanged in what it draws.
//
// Chart and scene: the plane spans MAP_WORLD_WIDTH × MAP_WORLD_HEIGHT
// centred on the origin, and its UVs run u = x / W + 0.5, v = z / H + 0.5
// (Babylon's ground, measured 2026-10-10), so a scene point's chart point is
// its fraction of the period from the far corner, wrapped.
//
// The symbols and names (WorldView.symbols) lie on the plane in the label
// group (ToroidalMapView, LABEL_RENDERING_GROUP), over everything else, in
// the 3 × 3 copies the map plane has; each one at the height of the relief
// on screen under its centre, so it stays on its place when the view tilts.

export interface FlatWorldView extends WorldView {
  readonly shape: 'flat'
}

export interface FlatWorldViewOptions {
  engine: Engine
  canvas: HTMLCanvasElement
  // The chart's size in texels: the layers' textures.
  textureWidth: number
  textureHeight: number
  // The chart's size on the world, metres: one period of the torus.
  metresWide: number
  metresHigh: number
}

export function createFlatWorldView(options: FlatWorldViewOptions): FlatWorldView {
  const { engine, canvas, textureWidth, textureHeight, metresWide, metresHigh } = options
  const chart: FlatChart = { width: MAP_WORLD_WIDTH, height: MAP_WORLD_HEIGHT }
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
  let heightScale = 1

  // The symbol layers: each mesh with its 8 wrap copies, placed with the
  // map plane's copies on every recenter.
  const symbolMeshes: { base: AbstractMesh; copies: InstancedMesh[] }[] = []
  const unitsPerMetre = MAP_WORLD_WIDTH / metresWide
  let symbolCentre = { x: 0, z: 0 }
  const liftSurface = (): ElevationSurface | null => (ribbonLevel === 'flat' ? null : ribbonLevel === 'fine' ? fineSurface ?? coarseSurface : coarseSurface)
  const symbolSet = createSymbolLayerSet(scene, 'flatSymbols', {
    frame(symbol) {
      const surface = liftSurface()
      return flatSymbolFrame(chart, symbol.at, surface ? surface.heightAtUV(symbol.at.u, symbol.at.v) : 0, symbol.angle, symbol.readable ?? false)
    },
    vertex: (frame, x, y, out, offset) => flatSymbolVertex(frame, x, y, unitsPerMetre, out, offset),
    segments: () => 1,
  }, (mesh) => {
    mesh.renderingGroupId = LABEL_RENDERING_GROUP
    mesh.scaling.y = heightScale
    const copies: InstancedMesh[] = []
    for (let i = 0; i < 8; i++) {
      const copy = mesh.createInstance(`${mesh.name}_copy${i}`)
      copy.renderingGroupId = LABEL_RENDERING_GROUP
      copy.isPickable = false
      copy.scaling.y = heightScale
      copies.push(copy)
    }
    symbolMeshes.push({ base: mesh, copies })
    placeSymbolCopies(symbolMeshes.length - 1)
    return copies
  })
  function placeSymbolCopies(index: number): void {
    const { base, copies } = symbolMeshes[index]
    const { x: centerX, z: centerZ } = symbolCentre
    base.position.set(centerX, 0, centerZ)
    let i = 0
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        copies[i++].position.set(centerX + dx * MAP_WORLD_WIDTH, 0, centerZ + dz * MAP_WORLD_HEIGHT)
      }
    }
  }

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
      if (centerX !== symbolCentre.x || centerZ !== symbolCentre.z) {
        symbolCentre = { x: centerX, z: centerZ }
        for (let i = 0; i < symbolMeshes.length; i++) placeSymbolCopies(i)
      }
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
        symbolSet.relayout()
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
      } else {
        ribbons.setHeightSurface(ribbonLevel === 'fine' ? fineSurface : coarseSurface)
      }
      symbolSet.relayout()
    },
    setHeightScale(scale) {
      // The ribbons carry the ground's scale, or they sink inside it
      // (ToroidalRibbonOverlay.setHeightScale).
      map.setHeightScale(scale)
      ribbons.setHeightScale(scale)
      heightScale = scale
      for (const { base, copies } of symbolMeshes) {
        base.scaling.y = scale
        for (const copy of copies) copy.scaling.y = scale
      }
    },
    rivers: ribbons,
    symbols: (id) => symbolSet.symbols(id),
    setPanEnabled: (enabled) => camera.setPanEnabled(enabled),
    setDeepZoom: (enabled) => camera.setDeepZoomEnabled(enabled),
    // Not asked for the flat map yet (DEC-0035, "what this does not decide").
    resetCamera: () => {},
    chartAt(screenX, screenY) {
      // The plane, analytically (ScaleBar.ts, pickMapPlane) — never a pick
      // against the relief, which cost milliseconds a ray at deep zoom: the
      // temperature scale's 64 of them made the pan stutter (2026-09-27,
      // and again for a day on 2026-10-10 when the move wired the mesh pick
      // here).
      const point = pickMapPlane(scene, screenX, screenY)
      return point ? flatChartOfScene(chart, point.x, point.z) : null
    },
    groundAt(screenX, screenY) {
      // What is drawn: the plane, its wrap copies, the relief — they all
      // carry the chart in their UVs (the texture uploaded top row first).
      const pick = scene.pick(screenX, screenY)
      const uv = pick?.hit ? pick.getTextureCoordinates() : null
      return uv ? { u: uv.x, v: uv.y } : null
    },
    metresBetween(a, b) {
      // The shorter way round the torus on each axis.
      let du = Math.abs(b.u - a.u) % 1
      if (du > 0.5) du = 1 - du
      let dv = Math.abs(b.v - a.v) % 1
      if (dv > 0.5) dv = 1 - dv
      return Math.hypot(du * metresWide, dv * metresHigh)
    },
    viewKey() {
      const focus = camera.getFocus()
      return `${focus.x.toFixed(1)},${focus.z.toFixed(1)},${camera.getZoom().toFixed(4)},${camera.getYaw().toFixed(3)}`
    },
    dispose() {
      symbolSet.dispose()
      ribbons.dispose()
      map.dispose()
      // scene.dispose() does not remove the camera rig's own 'wheel'
      // listener on the shared canvas; the rig goes by hand.
      camera.dispose()
      scene.dispose()
    },
  }
}
