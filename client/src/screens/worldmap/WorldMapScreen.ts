import { Color4, Scene } from '@babylonjs/core'
import JSZip from 'jszip'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { createWorldgenCamera } from '../../camera/worldgenCamera'
import { createToroidalMapView } from '../../map/ToroidalMapView'
import type { ToroidalMapView } from '../../map/ToroidalMapView'
import { createMapHoverTooltip } from '../../map/MapHoverTooltip'
import type { MapHoverTooltip } from '../../map/MapHoverTooltip'
import { computeReliefBytes } from '../../worldgen/render/reliefShade'
import { buildPaperBase, buildUnshadedPaperBase } from '../../ui/mapOverlay/paperBase'
import { createElevationSurface, downsampleElevation } from '../../map/elevationSurface'
import { MAP_WORLD_WIDTH as WORLD_WIDTH, MAP_WORLD_HEIGHT as WORLD_HEIGHT, RELIEF_DECIMATION, RELIEF_FINE_ZOOM, RELIEF_HEIGHT_SCALE, RELIEF_MIN_ZOOM } from '../../map/mapSceneSettings'
import { decodeLayer } from '../../worldgen/worldSave/worldLayers'
import type { Dtype } from '../../worldgen/worldSave/worldLayers'
import { elevationToMeters } from '../../worldgen/elevation/elevationScale'
import { biomeLabelKey } from '../../worldgen/climate/biomes'
import { t } from '../../i18n/i18n'
import type { TKey } from '../../i18n/i18n'
import { createHelpTooltip } from '../../ui/help/HelpTooltip'
import '../../ui/chrome/chrome.css'
import './worldmap.css'

// "Herederos del Mundo" — the world-map screen. Reads a saved world (.zip)
// through the QUERYABLE side of the save (manifest.json + baked layers —
// see docs/decisions/queryable-world-save.md), deliberately NOT through the
// generator's worker/restore path: this screen consumes a finished world,
// it doesn't continue simulating one. v1 is the flat paper map + hover
// readout; the relief/LOD ladder from docs/design/hex-world-view.md comes
// next, feeding off the same elevation raster.

// The manifest's self-describing layer entry (see WorldGenScreen's
// bakeQueryLayers — this is the consumer side of that contract).
interface ManifestLayer {
  name: string
  file: string
  kind: 'raster' | 'vector'
  resX?: number
  resY?: number
  dtype?: Dtype
  encoding?: { scale: number; offset: number }
}
interface WorldManifest {
  formatVersion: number
  world: { width: number; height: number; topology: string }
  layers: ManifestLayer[]
}

export const createWorldMapScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)

  const {
    dispose: disposeCamera,
    getFocus: getCameraFocus,
    setDeepZoomEnabled: setCameraDeepZoom,
    setDesiredTilt: setCameraDesiredTilt,
    getZoom: getCameraZoom,
    getYaw: getCameraYaw,
  } = createWorldgenCamera({
    scene,
    canvas: ctx.canvas,
    engine: ctx.engine,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
  })

  // Tilt is purely zoom-driven, same as the generator: armed fully, the
  // envelope decides when it shows.
  setCameraDesiredTilt(Number.POSITIVE_INFINITY)

  // Built per loaded world (texture dims come from its manifest); replaced
  // wholesale on the next load.
  let mapView: ToroidalMapView | null = null
  let hoverTooltip: MapHoverTooltip | null = null

  const root = document.createElement('div')
  root.className = 'worldmap-screen map-chrome'
  root.innerHTML = `
    <div class="file-actions">
      <button type="button" class="file-button" data-action="load-world" aria-label="${t('common.action.loadWorld.label')}" data-help="common.action.loadWorld">
        <img src="/icons/folder.png" alt="" />
      </button>
    </div>
    <h2 class="panel-title">Herederos del Mundo</h2>
    <div class="panel">
      <button type="button" class="text-button" data-action="back">Back to Title</button>
    </div>
  `
  ctx.overlay.appendChild(root)
  const helpTooltip = createHelpTooltip(root)
  root.querySelector('[data-action="back"]')!.addEventListener('click', () => {
    ctx.goTo('title')
  })

  // Same load affordance as the generator: folder button → file picker.
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = '.zip'
  fileInput.style.display = 'none'
  root.appendChild(fileInput)
  root.querySelector('[data-action="load-world"]')!.addEventListener('click', () => {
    fileInput.value = ''
    fileInput.click()
  })
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (file) void loadWorld(file)
  })

  function notifyLoadFailed(): void {
    ctx.notifications.show({ message: t('common.notify.invalidWorldFile'), icon: '/icons/folder.png', durationMs: 5000 })
  }

  async function loadWorld(file: File): Promise<void> {
    try {
      const zip = await JSZip.loadAsync(file)
      const manifestText = await zip.file('manifest.json')?.async('string')
      if (!manifestText) {
        notifyLoadFailed()
        return
      }
      const manifest = JSON.parse(manifestText) as WorldManifest
      const elevationEntry = manifest.layers.find((l) => l.name === 'elevation' && l.kind === 'raster')
      const elevationBuffer = elevationEntry ? await zip.file(elevationEntry.file)?.async('arraybuffer') : undefined
      if (!elevationEntry || !elevationBuffer) {
        notifyLoadFailed()
        return
      }
      const width = elevationEntry.resX ?? manifest.world.width
      const height = elevationEntry.resY ?? manifest.world.height
      const elevations = new Float32Array(elevationBuffer)

      // Biome (coarse climate grid) for the hover readout — present once the
      // world was saved with climate computed; older/younger saves just skip
      // the biome line.
      let biome: { data: Float32Array; resX: number; resY: number } | null = null
      const biomeEntry = manifest.layers.find((l) => l.name === 'biome' && l.kind === 'raster')
      if (biomeEntry?.dtype && biomeEntry.encoding && biomeEntry.resX && biomeEntry.resY) {
        const biomeBuffer = await zip.file(biomeEntry.file)?.async('arraybuffer')
        if (biomeBuffer) {
          biome = {
            data: decodeLayer(biomeBuffer, { name: 'biome', dtype: biomeEntry.dtype, scale: biomeEntry.encoding.scale, offset: biomeEntry.encoding.offset, unit: '', landOnly: false }),
            resX: biomeEntry.resX,
            resY: biomeEntry.resY,
          }
        }
      }

      presentWorld(elevations, width, height, biome)
    } catch {
      notifyLoadFailed()
    }
  }

  function presentWorld(elevations: Float32Array, width: number, height: number, biome: { data: Float32Array; resX: number; resY: number } | null): void {
    hoverTooltip?.dispose()
    mapView?.dispose()
    mapView = createToroidalMapView({
      scene,
      worldWidth: WORLD_WIDTH,
      worldHeight: WORLD_HEIGHT,
      textureWidth: width,
      textureHeight: height,
      getFocus: getCameraFocus,
      getYaw: getCameraYaw,
      reliefDetail: () => {
        const zoom = getCameraZoom()
        return zoom > RELIEF_FINE_ZOOM ? 'fine' : zoom > RELIEF_MIN_ZOOM ? 'coarse' : 'flat'
      },
    })
    // The paper look, derived from the elevation raster with the same
    // shade + palette the generator uses (reliefShade + paperBase) — not
    // from preview.png, which carries whatever overlays were on at save
    // time.
    const relief = computeReliefBytes(elevations, width, height)
    const paper = buildPaperBase(relief)
    mapView.texture.update(new Uint8Array(paper.buffer))

    // 3D relief: the same two canonical surfaces as the generator's preview
    // (decimated → coarse mesh, full raster → fine mesh at deep zoom), and
    // the unshaded paper for the LIT relief meshes — no compositor here,
    // there are no overlays to stack yet.
    mapView.reliefTexture.update(new Uint8Array(buildUnshadedPaperBase(relief).buffer))
    const decimated = downsampleElevation(elevations, width, height, RELIEF_DECIMATION)
    mapView.setReliefSurfaces(
      createElevationSurface(decimated.data, decimated.resX, decimated.resY, RELIEF_HEIGHT_SCALE),
      createElevationSurface(elevations, width, height, RELIEF_HEIGHT_SCALE),
    )
    // A loaded world is finished by definition — no erosion gate; deep zoom
    // and the tilt/yaw envelope unlock with the first successful load.
    setCameraDeepZoom(true)

    hoverTooltip = createMapHoverTooltip({
      scene,
      host: root,
      textureWidth: width,
      textureHeight: height,
      describe: (cellX, cellY) => {
        const lines = [`${Math.round(elevationToMeters(elevations[cellY * width + cellX]))} m`]
        if (biome && elevations[cellY * width + cellX] > 0) {
          const bx = Math.min(biome.resX - 1, Math.floor((cellX / width) * biome.resX))
          const by = Math.min(biome.resY - 1, Math.floor((cellY / height) * biome.resY))
          lines.push(t(biomeLabelKey(Math.round(biome.data[by * biome.resX + bx])) as TKey))
        }
        return lines.join('\n')
      },
    })
  }

  return {
    scene,
    dispose() {
      hoverTooltip?.dispose()
      mapView?.dispose()
      helpTooltip.dispose()
      disposeCamera()
      root.remove()
      scene.dispose()
    },
  }
}
