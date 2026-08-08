import { Color3, Color4, MeshBuilder, Scene, ShaderMaterial } from '@babylonjs/core'
import JSZip from 'jszip'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { createWorldgenCamera } from '../../camera/worldgenCamera'
import { createToroidalMapView } from '../../map/ToroidalMapView'
import { createToroidalRibbonOverlay } from '../../map/ToroidalRibbonOverlay'
import type { ToroidalMapView } from '../../map/ToroidalMapView'
import { createMapHoverTooltip } from '../../map/MapHoverTooltip'
import type { MapHoverTooltip } from '../../map/MapHoverTooltip'
import { computeReliefBytes } from '../../worldgen/render/reliefShade'
import { upscaleBilinearToroidal } from '../../worldgen/core/field'
import { buildPaperBase, buildUnshadedPaperBase } from '../../ui/mapOverlay/paperBase'
import { applyBiomeWash, dilateLandBiomes, expandBiomeIds } from '../../ui/mapOverlay/biomePaper'
import { createElevationSurface, downsampleElevation } from '../../map/elevationSurface'
import { createFineElevationSurface } from '../../map/fineElevationSurface'
import { AMPLIFY_EROSION_ROUNDS, AMPLIFY_STAGES, MAP_EXAGGERATION, NEAR_EXAGGERATION, PAPER_TEXTURE_HEIGHT, PAPER_TEXTURE_WIDTH, HEX_COL_SPACING, HEX_ROW_SPACING, HEXGRID_FADE_HIGH_ALTITUDE, HEXGRID_FADE_LOW_ALTITUDE, MAP_WORLD_WIDTH as WORLD_WIDTH, MAP_WORLD_HEIGHT as WORLD_HEIGHT, NEAR_MIN_ALTITUDE, RELIEF_DECIMATION, RELIEF_FINE_ZOOM, RELIEF_HEIGHT_SCALE, RELIEF_MIN_ZOOM, UNITS_PER_METER } from '../../map/mapSceneSettings'
import type { AmplificationInboundMessage, AmplificationOutboundMessage } from '../../worldgen/amplificationWorker'
import { decodeLayer } from '../../worldgen/worldSave/worldLayers'
import type { Dtype } from '../../worldgen/worldSave/worldLayers'
import { elevationToMeters } from '../../worldgen/elevation/elevationScale'
import { biomeLabelKey } from '../../worldgen/climate/biomes'
import { t } from '../../i18n/i18n'
import type { TKey } from '../../i18n/i18n'
import { createHelpTooltip } from '../../ui/help/HelpTooltip'
import { deriveWorldId, derivePipelineVersion } from '../../storage/artifactKey'
import { readAmplificationArtifact, writeAmplificationArtifact } from '../../storage/amplificationArtifact'
import { getArtifactStore } from '../../storage/artifactStoreProvider'
import { createStoragePanel } from '../../ui/storagePanel/StoragePanel'
import { createServerIndicator } from '../../ui/serverIndicator/ServerIndicator'
import { createLoadPanel } from '../../ui/worldPanels/LoadPanel'
import { getServerStatus } from '../../server/serverStatus'
import { readRecipeNumber, readRecipeValue } from '../../worldgen/worldSave/recipeYaml'
import { AMPLIFY_CONSTANTS } from '../../worldgen/surface/amplify'
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
// The world's own pipeline settings, read back out of its recipe —
// undefined where a save doesn't record them (then the bake uses defaults).
interface ErosionControls {
  strength?: number
  refresh?: number
  riverDensity?: number
}

// Precipitation for the bake's hydrology re-run, decoded from the save's
// baked climate layer (absent on a world saved before climate was computed).
interface ClimateInput {
  precipitation: Float32Array
  resX: number
  resY: number
}

// How much of the biome palette reaches the paper. Same two knobs, and the
// same reasoning, as the generator's terrain wash: pull the colours toward
// their own luminance and let them through only partly, so the paper's white
// and its hillshade keep showing. Full-strength palette would turn the map
// into a flat colour chart.
const BIOME_DESATURATE = 0.45
const BIOME_ALPHA = 0.55

// River ribbon widths per relief level — the same reasoning as the
// generator's: the stored per-point widths are cartographic, and at relief
// zoom a literal reading turns a line into a flood while the D8 staircase's
// mitered joints degenerate into sawteeth.
const RIBBON_WIDTH_PROFILES = {
  flat: { factor: 1, maxWidthPx: Number.POSITIVE_INFINITY },
  coarse: { factor: 0.5, maxWidthPx: 4 },
  fine: { factor: 0.3, maxWidthPx: 2 },
} as const

interface WorldManifest {
  formatVersion: number
  world: { width: number; height: number; topology: string }
  layers: ManifestLayer[]
}

export const createWorldMapScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)

  const {
    camera,
    dispose: disposeCamera,
    getFocus: getCameraFocus,
    setDeepZoomEnabled: setCameraDeepZoom,
    setDesiredTilt: setCameraDesiredTilt,
    getZoom: getCameraZoom,
    getYaw: getCameraYaw,
    getNearBlend: getCameraNearBlend,
    getAltitude: getCameraAltitude,
  } = createWorldgenCamera({
    scene,
    canvas: ctx.canvas,
    engine: ctx.engine,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    // Past the deepest map zoom the camera hands over to the perspective
    // NEAR regime — the descent toward the horizon view (Stage A of the
    // world view; see worldgenCamera's header).
    nearModeEnabled: true,
    nearMinAltitude: NEAR_MIN_ALTITUDE,
  })

  // Tilt is purely zoom-driven, same as the generator: armed fully, the
  // envelope decides when it shows.
  setCameraDesiredTilt(Number.POSITIVE_INFINITY)

  // Sky for the near regime: a camera-following dome whose gradient runs
  // from a compact deep-blue band at the horizon slowly up into near-white
  // (per design discussion 2026-08-07). Everything below the horizon stays
  // the deep blue — the same color the distance fog uses, which is what
  // makes terrain melt seamlessly into the sky line. Depth-write off + a
  // radius just inside the far plane: terrain always wins the depth test,
  // sky fills whatever remains.
  const SKY_HORIZON = new Color3(40 / 255, 90 / 255, 140 / 255)
  const SKY_ZENITH = new Color3(235 / 255, 245 / 255, 252 / 255)
  const skyMaterial = new ShaderMaterial(
    'worldmapSky',
    scene,
    {
      vertexSource: `
        precision highp float;
        attribute vec3 position;
        uniform mat4 worldViewProjection;
        varying float vHeight;
        void main() {
          vHeight = position.y;
          gl_Position = worldViewProjection * vec4(position, 1.0);
        }`,
      fragmentSource: `
        precision highp float;
        varying float vHeight;
        uniform vec3 horizonColor;
        uniform vec3 zenithColor;
        void main() {
          float t = clamp(vHeight, 0.0, 1.0);
          gl_FragColor = vec4(mix(horizonColor, zenithColor, smoothstep(0.03, 0.55, t)), 1.0);
        }`,
    },
    { attributes: ['position'], uniforms: ['worldViewProjection', 'horizonColor', 'zenithColor'] },
  )
  skyMaterial.backFaceCulling = false
  skyMaterial.disableDepthWrite = true
  skyMaterial.setColor3('horizonColor', SKY_HORIZON)
  skyMaterial.setColor3('zenithColor', SKY_ZENITH)
  // Unit sphere (local Y in -1..1, matching the shader's height ramp),
  // scaled to the live far plane each frame.
  const skyDome = MeshBuilder.CreateSphere('worldmapSkyDome', { diameter: 2, segments: 16 }, scene)
  skyDome.material = skyMaterial
  skyDome.infiniteDistance = true
  skyDome.isPickable = false
  skyDome.setEnabled(false)

  scene.fogColor = SKY_HORIZON
  // Altitude readout in the bottom panel — value + unit only (language-
  // neutral, no catalog key needed). Shown during the near descent, where
  // the number means something; the map regime's rig height is a fiction.
  let altitudeEl: HTMLElement | null = null
  let lastAltitudeText = ''
  const formatAltitude = (meters: number): string => {
    if (meters >= 100000) return `${Math.round(meters / 1000)} km`
    if (meters >= 10000) return `${(meters / 1000).toFixed(1)} km`
    if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`
    return `${Math.round(meters)} m`
  }
  const skyObserver = scene.onBeforeRenderObservable.add(() => {
    const blend = getCameraNearBlend()
    const nearActive = blend > 0.001
    skyDome.setEnabled(nearActive)
    scene.fogMode = nearActive ? Scene.FOGMODE_LINEAR : Scene.FOGMODE_NONE
    if (nearActive) {
      skyDome.scaling.setAll(camera.maxZ * 0.9)
      scene.fogStart = camera.maxZ * 0.3
      scene.fogEnd = camera.maxZ * 0.85
    }
    // Vertical exaggeration follows the register: strong on the map, where
    // a mountain is otherwise a few dozen pixels tall, fading to metre-true
    // as the descent turns the map into a world.
    const exaggeration = MAP_EXAGGERATION + (NEAR_EXAGGERATION - MAP_EXAGGERATION) * blend
    mapView?.setHeightScale(exaggeration)
    riverLayer?.setHeightScale(exaggeration)

    const altitudeText = nearActive ? formatAltitude(getCameraAltitude() / UNITS_PER_METER) : ''
    if (altitudeText !== lastAltitudeText) {
      lastAltitudeText = altitudeText
      altitudeEl ??= root.querySelector<HTMLElement>('[data-value="altitude"]')
      if (altitudeEl) altitudeEl.textContent = altitudeText
    }
  })

  // Built per loaded world (texture dims come from its manifest); replaced
  // wholesale on the next load.
  let mapView: ToroidalMapView | null = null
  let hoverTooltip: MapHoverTooltip | null = null
  // The height raster currently in force: the save's macro field until the
  // amplification bake returns a finer one (see startAmplification).
  let heightField: { data: Float32Array; width: number; height: number } | null = null
  let amplifyWorker: Worker | null = null
  // Bumped on every load so a stage chain from a superseded world can't
  // swap its result in after the user has opened a different one.
  let bakeGeneration = 0
  // Identity of the world currently loaded, derived from what the bake
  // actually consumes (see storage/artifactKey.ts).
  let worldId = ''
  // Scene-space river ribbons + the relief surfaces they drape on (set when
  // the bake's height field arrives), and which relief level they are
  // currently styled for.
  let riverLayer: ReturnType<typeof createToroidalRibbonOverlay> | null = null
  let reliefCoarseSurface: ReturnType<typeof createElevationSurface> | null = null
  let reliefFineSurface: ReturnType<typeof createElevationSurface> | null = null
  let ribbonLevel: keyof typeof RIBBON_WIDTH_PROFILES = 'flat'
  // The paper's hillshade bytes and the per-texel biome ids, retained so the
  // biome toggle can repaint without redoing either.
  let lastRelief: Uint8Array | null = null
  let biomeIds: Uint8Array | null = null
  let biomeWashEnabled = true
  let bakeEl: HTMLElement | null = null
  const setBakeText = (text: string): void => {
    bakeEl ??= root.querySelector<HTMLElement>('[data-value="bake"]')
    if (bakeEl) bakeEl.textContent = text
  }

  const root = document.createElement('div')
  root.className = 'worldmap-screen map-chrome'
  root.innerHTML = `
    <div class="file-actions">
      <span data-slot="server-indicator"></span>
      <button type="button" class="file-button" data-action="load-world" aria-label="${t('common.action.loadWorld.label')}" data-help="common.action.loadWorld">
        <img src="/icons/folder.png" alt="" />
      </button>
      <button type="button" class="file-button cache-button" data-action="cache-manager" aria-label="${t('common.action.storage.label')}" data-help="common.action.storage">
        <img src="/icons/server_clean.png" alt="" />
      </button>
    </div>
    <h2 class="panel-title">Herederos del Mundo</h2>
    <div class="panel">
      <button type="button" class="text-button" data-action="back">Back to Title</button>
      <button type="button" class="icon-button" data-action="toggle-hexgrid" aria-label="Toggle hex grid">
        <img src="/icons/voronoi.png" alt="" />
      </button>
      <button type="button" class="icon-button" data-action="toggle-biomes" aria-label="Toggle biome colouring">
        <img src="/icons/biomes.png" alt="" />
      </button>
      <span class="altitude-readout" data-value="altitude"></span>
      <span class="bake-readout" data-value="bake"></span>
    </div>
  `
  ctx.overlay.appendChild(root)
  const helpTooltip = createHelpTooltip(root)
  root.querySelector('[data-action="back"]')!.addEventListener('click', () => {
    ctx.goTo('title')
  })

  // Hex grid on/off (button deliberately un-localized for now — pending an
  // approved game.* key set). Feeds the grid's strength closure below.
  let hexGridEnabled = true
  const hexGridButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-hexgrid"]')!
  hexGridButton.addEventListener('click', () => {
    hexGridEnabled = !hexGridEnabled
    hexGridButton.classList.toggle('is-off', !hexGridEnabled)
  })

  // Cache admin: the button reports what the origin is holding and opens the
  // manager (a centred window, shared with the generator) rather than
  // clearing outright — with several worlds cached, "delete everything" is
  // rarely the operation actually wanted.
  // Where a world would go, shown on every screen (see ui/serverIndicator).
  const serverIndicator = createServerIndicator()
  root.querySelector('[data-slot="server-indicator"]')!.replaceWith(serverIndicator.element)

  const storagePanel = createStoragePanel(root)
  root.querySelector('[data-action="cache-manager"]')!.addEventListener('click', () => storagePanel.open())

  // Biome wash on/off, so the plain paper stays one click away for
  // comparison (button un-localized for now, like the hex grid one).
  const biomeToggleButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-biomes"]')!
  biomeToggleButton.addEventListener('click', () => {
    biomeWashEnabled = !biomeWashEnabled
    biomeToggleButton.classList.toggle('is-off', !biomeWashEnabled)
    repaintPaper()
  })

  // Same load affordance as the generator: folder button → file picker.
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = '.zip'
  fileInput.style.display = 'none'
  root.appendChild(fileInput)
  // Loading from the server belongs on BOTH screens: worlds are made in the
  // generator but opened here, and without this they could only come back via
  // download-then-open. Uploading stays generator-only — nothing here creates
  // a world.
  const loadPanel = createLoadPanel(root, {
    onOpenArchive: (archive) => { void loadWorld(new File([archive], 'world.zip')) },
    onPickFile: () => { fileInput.value = ''; fileInput.click() },
  })
  root.querySelector('[data-action="load-world"]')!.addEventListener('click', () => {
    void getServerStatus().then((status) => {
      if (status.state === 'local' || status.state === 'remote') loadPanel.open()
      else { fileInput.value = ''; fileInput.click() }
    })
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

      // Recipe values, through the shared path-aware reader. Bare-key
      // regexes were wrong here in both directions: `seed` sits INDENTED
      // under `spec:`, so a line-anchored pattern never matched it (every
      // world fell back to the same default label AND the same detail
      // seed), and a leaf name matched anywhere would collide the moment
      // two groups share a key.
      const yamlText = (await zip.file('world.yaml')?.async('string')) ?? ''
      const seedText = readRecipeValue(yamlText, 'spec.seed') ?? 'casas-eternas'
      // Seed for the deterministic near-field detail, hashed from the
      // recipe's seed so the same world always grows the same bumps. (Not
      // the generator's warpSeed — see fineElevationSurface.)
      let detailSeed = 5381
      for (let i = 0; i < seedText.length; i++) detailSeed = ((detailSeed * 33) ^ seedText.charCodeAt(i)) >>> 0

      // This world's own erosion settings, so the bake erodes the way the
      // world was eroded rather than by generic defaults (the generator
      // restores the same values into its sliders on load, from these very
      // paths).
      const erosionControls: ErosionControls = {
        strength: readRecipeNumber(yamlText, 'spec.erosion.erosionStrength'),
        refresh: readRecipeNumber(yamlText, 'spec.erosion.drainageRefresh'),
        riverDensity: readRecipeNumber(yamlText, 'spec.hydrology.riverDensity'),
      }

      // Precipitation drives the discharge in the bake's hydrology re-run.
      let climate: ClimateInput | null = null
      const precipEntry = manifest.layers.find((l) => l.name === 'precipitation' && l.kind === 'raster')
      if (precipEntry?.dtype && precipEntry.encoding && precipEntry.resX && precipEntry.resY) {
        const precipBuffer = await zip.file(precipEntry.file)?.async('arraybuffer')
        if (precipBuffer) {
          climate = {
            precipitation: decodeLayer(precipBuffer, { name: 'precipitation', dtype: precipEntry.dtype, scale: precipEntry.encoding.scale, offset: precipEntry.encoding.offset, unit: '', landOnly: true }),
            resX: precipEntry.resX,
            resY: precipEntry.resY,
          }
        }
      }

      // The world's cache identity, from what the bake actually consumes —
      // NOT from the recipe, which cannot distinguish two worlds stopped at
      // different tectonic epochs (see storage/artifactKey.ts). The seed
      // string rides along only as a readable path label.
      worldId = deriveWorldId(seedText, {
        elevation: elevations,
        precipitation: climate?.precipitation ?? null,
        erosionStrength: erosionControls.strength,
        drainageRefresh: erosionControls.refresh,
        riverDensity: erosionControls.riverDensity,
      })

      presentWorld(elevations, width, height, biome, detailSeed, erosionControls, climate)
    } catch {
      notifyLoadFailed()
    }
  }

  // Re-derive the paper from whatever height raster is current, at the
  // session's fixed texture resolution: a coarser field is upscaled, a finer
  // one BOX-DOWNSAMPLED (averaging heights, so the hillshade doesn't sparkle
  // the way point-sampling would). Called at load and again after every bake
  // stage, so the map's texture sharpens in step with its geometry.
  function applyPaper(field: Float32Array, fieldWidth: number, fieldHeight: number): void {
    if (!mapView) return
    let paperField = field
    if (fieldWidth > PAPER_TEXTURE_WIDTH && fieldWidth % PAPER_TEXTURE_WIDTH === 0) {
      const reduced = downsampleElevation(field, fieldWidth, fieldHeight, fieldWidth / PAPER_TEXTURE_WIDTH)
      paperField = reduced.data
    } else if (fieldWidth !== PAPER_TEXTURE_WIDTH) {
      paperField = upscaleBilinearToroidal(field, fieldWidth, fieldHeight, PAPER_TEXTURE_WIDTH, PAPER_TEXTURE_HEIGHT)
    }
    lastRelief = computeReliefBytes(paperField, PAPER_TEXTURE_WIDTH, PAPER_TEXTURE_HEIGHT)
    repaintPaper()
  }

  // Paint the retained relief bytes into both textures, with the biome wash
  // on top when it is on. Split from applyPaper so the toggle repaints
  // without recomputing the hillshade (the expensive half).
  function repaintPaper(): void {
    if (!mapView || !lastRelief) return
    const shaded = buildPaperBase(lastRelief)
    const unshaded = buildUnshadedPaperBase(lastRelief)
    if (biomeWashEnabled && biomeIds) {
      applyBiomeWash(shaded, lastRelief, biomeIds, BIOME_DESATURATE, BIOME_ALPHA)
      applyBiomeWash(unshaded, lastRelief, biomeIds, BIOME_DESATURATE, BIOME_ALPHA)
    }
    mapView.texture.update(new Uint8Array(shaded.buffer))
    mapView.reliefTexture.update(new Uint8Array(unshaded.buffer))
  }

  // Build the three surfaces from a height raster and hand them to the map
  // view. Called for the macro raster at load, then again when the
  // amplification bake returns a finer one — the bake swaps the world's
  // GEOMETRY under a map that is already on screen (the paper texture stays
  // at macro resolution; texture res is its own decision, see the doc).
  function applyHeightField(field: Float32Array, fieldWidth: number, fieldHeight: number, detailSeed: number): void {
    if (!mapView) return
    const decimated = downsampleElevation(field, fieldWidth, fieldHeight, RELIEF_DECIMATION)
    const coarseSurface = createElevationSurface(decimated.data, decimated.resX, decimated.resY, RELIEF_HEIGHT_SCALE)
    const fineSurface = createElevationSurface(field, fieldWidth, fieldHeight, RELIEF_HEIGHT_SCALE)
    // The synthetic cascade rides ON TOP of whatever raster is current: its
    // scales are relative to the raster's resolution, so after the bake it
    // automatically retreats to the band below the amplified cells instead
    // of competing with them. (What survives of it once erosion lands is a
    // later question — see the decision doc's ladder.)
    const detailSurface = createFineElevationSurface(field, fieldWidth, fieldHeight, RELIEF_HEIGHT_SCALE, detailSeed, 0.6)
    mapView.setReliefSurfaces(coarseSurface, fineSurface)
    mapView.setNearDetailSurfaces(detailSurface, fineSurface)
    reliefCoarseSurface = coarseSurface
    reliefFineSurface = fineSurface
    syncRibbonLevel(true) // the ribbons drape on these same surfaces
  }

  function presentWorld(elevations: Float32Array, width: number, height: number, biome: { data: Float32Array; resX: number; resY: number } | null, detailSeed: number, erosionControls: ErosionControls, climate: ClimateInput | null): void {
    hoverTooltip?.dispose()
    riverLayer?.dispose()
    riverLayer = null
    mapView?.dispose()
    // Per-texel biome ids for the paper wash, built once per world: dilate
    // the land biomes over the ocean first (so coastal land can't sample
    // "Ocean" across the grid mismatch), then expand through a warped
    // coordinate so boundaries are organic rather than 16-pixel squares.
    biomeIds = biome
      ? expandBiomeIds(dilateLandBiomes(biome.data, biome.resX, biome.resY), biome.resX, biome.resY, PAPER_TEXTURE_WIDTH, PAPER_TEXTURE_HEIGHT, detailSeed)
      : null
    biomeToggleButton.classList.toggle('is-off', !biomeWashEnabled || biomeIds === null)
    biomeToggleButton.disabled = biomeIds === null

    // Seed surfaces for construction; applyHeightField replaces them right
    // after (and again when the bake finishes).
    const fineSurface = createElevationSurface(elevations, width, height, RELIEF_HEIGHT_SCALE)
    const detailSurface = createFineElevationSurface(elevations, width, height, RELIEF_HEIGHT_SCALE, detailSeed, 0.6)
    mapView = createToroidalMapView({
      scene,
      worldWidth: WORLD_WIDTH,
      worldHeight: WORLD_HEIGHT,
      textureWidth: PAPER_TEXTURE_WIDTH,
      textureHeight: PAPER_TEXTURE_HEIGHT,
      getFocus: getCameraFocus,
      getYaw: getCameraYaw,
      getSunWorldBlend: getCameraNearBlend,
      nearDetail: {
        detailSurface,
        baseSurface: fineSurface,
        getActive: () => getCameraNearBlend() > 0.02,
        getAltitude: getCameraAltitude,
      },
      hexGrid: {
        spacingX: HEX_COL_SPACING,
        spacingY: HEX_ROW_SPACING,
        // Fade the 300 m grid in over the descent: subpixel moiré above,
        // full strength once hexes are comfortably readable. In the map
        // regime the altitude is the fixed rig height, far above the band —
        // strength 0 without a special case.
        getStrength: () => {
          if (!hexGridEnabled) return 0
          const altitude = getCameraAltitude()
          if (altitude >= HEXGRID_FADE_HIGH_ALTITUDE) return 0
          if (altitude <= HEXGRID_FADE_LOW_ALTITUDE) return 1
          return (HEXGRID_FADE_HIGH_ALTITUDE - altitude) / (HEXGRID_FADE_HIGH_ALTITUDE - HEXGRID_FADE_LOW_ALTITUDE)
        },
        // A near-field disk around the camera, scaled with altitude: hexes
        // reach a comfortable working radius and are gone long before the
        // haze — they are a foreground instrument, not a horizon pattern.
        getFadeDistances: () => {
          const altitude = getCameraAltitude()
          return { start: altitude * 8, end: altitude * 18 }
        },
      },
      reliefDetail: () => {
        const zoom = getCameraZoom()
        return zoom > RELIEF_FINE_ZOOM ? 'fine' : zoom > RELIEF_MIN_ZOOM ? 'coarse' : 'flat'
      },
      onRecenter: (centerX, centerZ) => {
        riverLayer?.recenter(centerX, centerZ)
        syncRibbonLevel()
      },
    })
    // The paper look, derived from the elevation raster with the same
    // shade + palette the generator uses (reliefShade + paperBase) — not
    // from preview.png, which carries whatever overlays were on at save
    // time. The unshaded variant is for the LIT relief meshes (no
    // compositor here — there are no overlays to stack yet).
    applyPaper(elevations, width, height)
    applyHeightField(elevations, width, height, detailSeed)
    // A loaded world is finished by definition — no erosion gate; deep zoom
    // and the tilt/yaw envelope unlock with the first successful load.
    setCameraDeepZoom(true)

    // The height raster the readout samples — replaced by the bake. The
    // tooltip's own cell resolution stays the texture's (macro), so a
    // hovered cell maps proportionally into whatever raster is current.
    heightField = { data: elevations, width, height }
    hoverTooltip = createMapHoverTooltip({
      scene,
      host: root,
      textureWidth: width,
      textureHeight: height,
      describe: (cellX, cellY) => {
        if (!heightField) return null
        const fx = Math.min(heightField.width - 1, Math.floor((cellX / width) * heightField.width))
        const fy = Math.min(heightField.height - 1, Math.floor((cellY / height) * heightField.height))
        const elevation = heightField.data[fy * heightField.width + fx]
        const lines = [`${Math.round(elevationToMeters(elevation))} m`]
        if (biome && elevation > 0) {
          const bx = Math.min(biome.resX - 1, Math.floor((cellX / width) * biome.resX))
          const by = Math.min(biome.resY - 1, Math.floor((cellY / height) * biome.resY))
          lines.push(t(biomeLabelKey(Math.round(biome.data[by * biome.resX + bx])) as TKey))
        }
        return lines.join('\n')
      },
    })

    startAmplification(elevations, width, height, detailSeed, erosionControls, climate)
  }

  // River ribbons for the re-derived network. Built on arrival (a world only
  // gets rivers once the bake's hydrology has run) in the AMPLIFIED texel
  // space — that is what extractRiverPolylines emitted, and the overlay's
  // texel→world mapping must agree with it or every river lands at half
  // scale in the wrong place.
  function applyRivers(points: Float32Array, lengths: Uint32Array, fieldWidth: number, fieldHeight: number, factor: number): void {
    riverLayer?.dispose()
    riverLayer = null
    if (lengths.length === 0) return
    riverLayer = createToroidalRibbonOverlay({
      scene,
      worldWidth: WORLD_WIDTH,
      worldHeight: WORLD_HEIGHT,
      textureWidth: fieldWidth,
      textureHeight: fieldHeight,
      // The stored widths are in the SOURCE grid's texels, so on a finer
      // grid the same river would draw physically thinner. Scaling by the
      // amplification factor keeps a river the size its discharge earns,
      // independent of what resolution it was extracted at.
      widthScale: 1.5 * factor,
      // The amplified grid packs several times as many D8 direction changes
      // (and discharge wiggles) into the same world distance, which the
      // interpolating spline would faithfully render as a wobble — average
      // the control points first. Measured on a synthetic D8 staircase: the
      // mean turn between steps drops from 30° to 0.1° after two passes,
      // and the path's displacement CONVERGES at ~0.22 cells however many
      // more are run (once the zigzag is gone, averaging a straight line
      // changes nothing) — i.e. the smoothed line settles in the middle of
      // the staircase, which is where the river actually runs. Scaled with
      // the refinement because a finer grid spreads the same zigzag over
      // more points, making it lower-frequency.
      smoothingPasses: 2 * factor,
    })
    riverLayer.setPolylines(points, lengths)
    ribbonLevel = 'flat'
    syncRibbonLevel(true)
  }

  // Keep the ribbons styled for whichever relief level is on screen —
  // surface AND width profile, swapped only on an actual level change.
  function syncRibbonLevel(force = false): void {
    if (!riverLayer) return
    const zoom = getCameraZoom()
    const level: keyof typeof RIBBON_WIDTH_PROFILES = !reliefCoarseSurface ? 'flat' : zoom > RELIEF_FINE_ZOOM ? 'fine' : zoom > RELIEF_MIN_ZOOM ? 'coarse' : 'flat'
    if (level === ribbonLevel && !force) return
    ribbonLevel = level
    const profile = RIBBON_WIDTH_PROFILES[level]
    riverLayer.setWidthProfile(profile.factor, profile.maxWidthPx)
    riverLayer.setHeightSurface(level === 'flat' ? null : level === 'fine' && reliefFineSurface ? reliefFineSurface : reliefCoarseSurface)
  }

    // Everything a finished bake changes on screen, whether it was computed
  // just now or read back from the cache — one path, so the two can't drift.
  function applyBakeResult(artifact: { elevation: Float32Array; width: number; height: number; riverPoints: Float32Array; riverLengths: Uint32Array }, factor: number, detailSeed: number): void {
    heightField = { data: artifact.elevation, width: artifact.width, height: artifact.height }
    applyPaper(artifact.elevation, artifact.width, artifact.height)
    applyHeightField(artifact.elevation, artifact.width, artifact.height, detailSeed)
    applyRivers(artifact.riverPoints, artifact.riverLengths, artifact.width, artifact.height, factor)
    hoverTooltip?.refresh()
  }

  // --- Amplification bake (docs/decisions/worldmap-amplification.md) ---
  // Runs in its own worker after the macro map is already on screen, then
  // swaps the geometry. Deliberately fire-and-forget from the load path: a
  // failed or slow bake leaves a perfectly usable macro world behind.
  function startAmplification(macro: Float32Array, macroWidth: number, macroHeight: number, detailSeed: number, erosionControls: ErosionControls, climate: ClimateInput | null): void {
    amplifyWorker?.terminate() // a new world supersedes any bake in flight
    const stages = AMPLIFY_STAGES.filter((factor) => factor > 1)
    if (stages.length === 0) return
    const generation = ++bakeGeneration

    // Stages run one after another, coarse first, each swapped in when it
    // lands — so the map is amplified early and sharpens later. Each stage
    // bakes from the MACRO raster (not from the previous stage's output):
    // re-amplifying an already-amplified field would compound its invented
    // detail, and the decision doc's rule is that every derived tier comes
    // from the authoritative one.
    const runStage = async (index: number): Promise<void> => {
      if (index >= stages.length || generation !== bakeGeneration) return
      const factor = stages[index]
      const label = `${macroWidth * factor}px`

      // Cache first. The key covers the world (what the bake consumes) and
      // the pipeline (the constants it runs with), so a hit is by
      // construction the same field this stage would have produced —
      // including after a constant is retuned, which yields a different key
      // rather than stale terrain.
      const key = {
        worldId,
        pipelineVersion: derivePipelineVersion({ ...AMPLIFY_CONSTANTS, rounds: AMPLIFY_EROSION_ROUNDS }),
        stage: String(factor),
      }
      const store = await getArtifactStore()
      if (generation !== bakeGeneration) return
      const hit = await readAmplificationArtifact(store, key).catch(() => null)
      if (hit && generation === bakeGeneration) {
        applyBakeResult(hit.artifact, factor, detailSeed)
        setBakeText(`${hit.artifact.width}×${hit.artifact.height} · cached`)
        void runStage(index + 1)
        return
      }

      const worker = new Worker(new URL('../../worldgen/amplificationWorker.ts', import.meta.url), { type: 'module' })
      amplifyWorker = worker
      const finish = (): void => {
        worker.terminate()
        if (amplifyWorker === worker) amplifyWorker = null
      }
      worker.onmessage = (event: MessageEvent<AmplificationOutboundMessage>) => {
        if (generation !== bakeGeneration) return
        const message = event.data
        if (message.type === 'amplifyProgress') {
          setBakeText(`${label} ${message.stage} ${Math.round(message.fraction * 100)}%`)
          return
        }
        const artifact = {
          elevation: new Float32Array(message.elevation),
          width: message.width,
          height: message.height,
          riverPoints: new Float32Array(message.riverPoints),
          riverLengths: new Uint32Array(message.riverLengths),
        }
        applyBakeResult(artifact, factor, detailSeed)
        setBakeText(`${message.width}×${message.height} · ${(message.durationMs / 1000).toFixed(0)}s`)
        finish()
        // Stored after the result is on screen, so the write never delays
        // what the user is waiting for — and failing to store is not an
        // error, only a bake that will happen again.
        void writeAmplificationArtifact(store, key, artifact, message.durationMs).catch(() => false)
        void runStage(index + 1)
      }
      // A stage that dies (the deepest tier needs ~3 GB — a browser may
      // simply refuse) must not take the screen with it: the last good
      // result stays up and the readout says where it stopped.
      worker.onerror = () => {
        if (generation !== bakeGeneration) return
        setBakeText(`${label} failed`)
        finish() // deliberately no next stage — a deeper one would fail harder
      }
      // A copy: the macro raster stays live here (later stages re-read it),
      // so only the copy is transferred.
      const request: AmplificationInboundMessage = {
        type: 'amplify',
        elevation: macro.slice().buffer as ArrayBuffer,
        macroWidth,
        macroHeight,
        factor,
        seed: detailSeed,
        erosionRounds: AMPLIFY_EROSION_ROUNDS,
        erosionStrength: erosionControls.strength,
        drainageRefresh: erosionControls.refresh,
        riverDensity: erosionControls.riverDensity,
        precipitation: climate ? (climate.precipitation.slice().buffer as ArrayBuffer) : undefined,
        climateResX: climate?.resX,
        climateResY: climate?.resY,
      }
      setBakeText(`${label} …`)
      worker.postMessage(request, [request.elevation])
    }
    void runStage(0)
  }

  return {
    scene,
    dispose() {
      amplifyWorker?.terminate()
      riverLayer?.dispose()
      scene.onBeforeRenderObservable.remove(skyObserver)
      skyDome.dispose()
      skyMaterial.dispose()
      hoverTooltip?.dispose()
      mapView?.dispose()
      helpTooltip.dispose()
      storagePanel.dispose()
      loadPanel.dispose()
      disposeCamera()
      root.remove()
      scene.dispose()
    },
  }
}
