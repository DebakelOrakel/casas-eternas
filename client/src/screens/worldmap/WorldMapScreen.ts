import { Color3, Color4, MeshBuilder, Scene, ShaderMaterial } from '@babylonjs/core'
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
import { MAP_EXAGGERATION, NEAR_EXAGGERATION, PAPER_TEXTURE_HEIGHT, PAPER_TEXTURE_WIDTH, HEX_COL_SPACING, HEX_ROW_SPACING, HEXGRID_FADE_HIGH_ALTITUDE, HEXGRID_FADE_LOW_ALTITUDE, MAP_WORLD_WIDTH as WORLD_WIDTH, MAP_WORLD_HEIGHT as WORLD_HEIGHT, NEAR_MIN_ALTITUDE, RELIEF_DECIMATION, RELIEF_FINE_ZOOM, RELIEF_HEIGHT_SCALE, RELIEF_MIN_ZOOM, UNITS_PER_METER } from '../../map/mapSceneSettings'
import { AMPLIFY_BAKE_STAGES, AMPLIFY_EROSION_ROUNDS, AMPLIFY_FETCH_STAGES } from '../../world/bakeSettings'
import type { AmplificationInboundMessage, AmplificationOutboundMessage } from '../../worldgen/amplificationWorker'
import { SEA_LEVEL, elevationToMeters } from '../../worldgen/elevation/elevationScale'
import { Biome, biomeLabelKey, computeBiomesFine, reduceTemperatureToSeaLevel } from '../../worldgen/climate/biomes'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../../worldgen/climate/climateField'
import { t } from '../../i18n/i18n'
import type { TKey } from '../../i18n/i18n'
import { createHelpTooltip } from '../../ui/help/HelpTooltip'
import { amplificationArtifactExists, amplificationPipelineVersion, readAmplificationArtifact, writeAmplificationArtifact } from '../../world/artifacts'
import { getArtifactStore } from '../../storage/artifactStoreProvider'
import { createStoragePanel } from '../../ui/storagePanel/StoragePanel'
import { createServerIndicator } from '../../ui/serverIndicator/ServerIndicator'
import { createLoadPanel } from '../../ui/worldPanels/LoadPanel'
import { getServerStatus } from '../../server/serverStatus'
import { hasSession } from '../../server/session'
import { bakeFraction, bakeIsWaiting, canCommissionBakes, commissionBake, findActiveBake, followBake } from '../../world/bakeClient'
import type { BakeJob } from '../../world/bakeClient'
import { worldInputsFrom } from '../../world/save/loadWorldInputs'
import { openWorld } from '../../world/query'
import type { FieldView, World } from '../../world/query'
import type { ErosionControls as SaveErosionControls } from '../../world/save/loadWorldInputs'
import '../../ui/chrome/chrome.css'
import './worldmap.css'

// "Herederos del Mundo" — the world-map screen. Reads a saved world (.zip)
// through the QUERYABLE side of the save (manifest.json + baked layers —
// see docs/decisions/queryable-world-save.md), deliberately NOT through the
// generator's worker/restore path: this screen consumes a finished world,
// it doesn't continue simulating one. v1 is the flat paper map + hover
// readout; the relief/LOD ladder from docs/design/hex-world-view.md comes
// next, feeding off the same elevation raster.

// The world's own pipeline settings, read back out of its recipe — undefined
// where a save doesn't record them (then the bake uses defaults). Shared with
// the server's baker; see worldSave/loadWorldInputs for why there is only one
// reader of a save.
type ErosionControls = SaveErosionControls

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
  // The world this screen is showing, and the elevation view it reads.
  //
  // `heightField` used to be a plain variable that `applyBakeResult` OVERWROTE
  // when a bake landed — which is why the hover readout silently changed
  // resolution mid-session. Now the amplified tier is REGISTERED with the world
  // and the view is re-acquired, so the answer still sharpens but the source it
  // came from is a property of the view rather than of whatever ran last.
  //
  // `presentation` is the honest purpose here: the readout answers "how high is
  // the ground I am looking at", and after a bake that ground IS the amplified
  // tier. A rule would ask for `authoritative` and get the macro raster.
  let world: World | null = null
  let elevationView: FieldView | null = null
  let amplifyWorker: Worker | null = null
  // Bumped on every load so a stage chain from a superseded world can't
  // swap its result in after the user has opened a different one.
  let bakeGeneration = 0
  // Identity of the world currently loaded, derived from what the bake
  // actually consumes (see world/identity.ts).
  let worldId = ''
  // The SERVER's name for the same world — `metadata.uid`, which does not move
  // when the terrain does. Ordering a bake needs this one; empty for a save too
  // old to carry it, and for that case the answer is to save it again.
  let worldUid = ''
  // Scene-space river ribbons + the relief surfaces they drape on (set when
  // the bake's height field arrives), and which relief level they are
  // currently styled for.
  let riverLayer: ReturnType<typeof createToroidalRibbonOverlay> | null = null

  // DEBUG: force a resolution rather than taking whatever the staging left on
  // screen. Worth having because the stages differ in ways that are hard to
  // judge from memory — 4k against 8k against the raw macro raster is a
  // comparison you want side by side in time, not a fortnight apart.
  //
  // Re-READ from the store rather than kept in memory: holding every level at
  // once would be 33 + 134 MB of rasters for a debug affordance, and the local
  // tier already has them (a server hit is backfilled on the way in).
  let bakeSource: {
    macro: Float32Array; macroWidth: number; macroHeight: number; detailSeed: number
    key: { worldId: string; pipelineVersion: string }
    // The density the world was saved with. Rivers are keyed by it inside the
    // artifact, so a read that guessed would find the wrong set — or none.
    riverDensity: number | undefined
  } | null = null
  // Factor 1 is the macro raster the save carries — the authoritative one, and
  // the only level with no rivers, since those are a product of the bake.
  let availableFactors: number[] = []
  let shownFactor = 1
  // Levels this world could SHOW but nobody has baked — either because the tab
  // must not bake them (8k is the 2.6 GB that kills it) or because it tried and
  // died. Exactly the set worth ordering from a server, which is why it is
  // recorded rather than merely skipped over.
  let missingFactors: number[] = []
  // One order at a time. Not a lock over anything shared — it stops a second
  // click from queueing a second run of the same six minutes.
  let bakeOrdered = false
  let reliefCoarseSurface: ReturnType<typeof createElevationSurface> | null = null
  let reliefFineSurface: ReturnType<typeof createElevationSurface> | null = null
  let ribbonLevel: keyof typeof RIBBON_WIDTH_PROFILES = 'flat'
  // The paper's hillshade bytes and the per-texel biome ids, retained so the
  // biome toggle can repaint without redoing either.
  let lastRelief: Uint8Array | null = null
  let biomeIds: Uint8Array | null = null
  // The save's climate inputs, kept so the biome wash can be RECLASSIFIED
  // against whatever terrain is current instead of upsampled from the saved
  // ids — that is what makes the amplification bake's ridges carry a treeline.
  // Null for a save written before those layers existed; the legacy upsample
  // path in presentWorld then stands.
  let biomeInputs: NonNullable<Awaited<ReturnType<typeof worldInputsFrom>>>['biomeInputs'] = null
  // The MACRO biome ids, nearest-sampled to texture resolution. Two things the
  // classification cannot re-derive on its own live in here, and the macro
  // raster is their authority: salt flats (a hydrology state, not a climate)
  // and dry basin floors (below sea level yet land).
  let macroBiomeAtTexel: Uint8Array | null = null
  // The saved temperature with its lapse term removed, computed ONCE against
  // the macro raster the generator's climate actually ran on. It has to be
  // built here rather than inside the classification, because after a bake the
  // terrain being classified is no longer that raster.
  let seaLevelTemperature: Float32Array | null = null
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
      <button type="button" class="text-button resolution-cycle" data-action="cycle-resolution" title="Force a resolution (debug)" hidden></button>
      <button type="button" class="text-button" data-action="order-bake" data-help="common.action.orderBake" hidden></button>
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
  const serverIndicator = createServerIndicator(root)
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
    // Reading the save is shared with the SERVER'S baker (worldSave/
    // loadWorldInputs): both write artifacts under a key derived from what
    // they read, so two readers that drifted by one decoded layer would
    // produce two worldIds for one world and the cache would serve terrain
    // from a world that does not exist.
    const opened = await openWorld(await file.arrayBuffer())
    const inputs = opened && (await worldInputsFrom(opened))
    if (!opened || !inputs) {
      notifyLoadFailed()
      return
    }
    world = opened
    worldId = inputs.worldId
    worldUid = inputs.worldUid
    presentWorld(
      inputs.elevations, inputs.width, inputs.height,
      inputs.biome, inputs.detailSeed, inputs.erosionControls,
      inputs.climate ? { precipitation: inputs.climate.data, resX: inputs.climate.resX, resY: inputs.climate.resY } : null,
      inputs.biomeInputs,
    )
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
    reclassifyBiomes(paperField)
    repaintPaper()
  }

  // Biomes re-derived from THIS raster, at texture resolution.
  //
  // The wash used to be the saved 2048 ids upsampled through a domain-warped
  // coordinate — a guess at what lies between two macro cells. Here the
  // elevation at every texel is already known (it is the field the hillshade
  // was just built from), and the Whittaker classification is pointwise, so the
  // answer can simply be computed instead. Called from applyPaper, which means
  // it re-runs after every bake stage: the biome boundaries sharpen in step
  // with the terrain, and a treeline follows the ridges the bake actually
  // carved rather than the 62 km cell they sit in.
  //
  // What does NOT get finer: precipitation, seasonality and monsoon stay
  // regional (the classification interpolates them, but interpolation is not
  // information). So this sharpens the elevation-driven boundaries — treeline,
  // alpine, valley warmth — and leaves rain-driven ones where they were. In
  // mountains that is the visible half; on a plain nothing changes.
  function reclassifyBiomes(paperField: Float32Array): void {
    // Legacy save, or a climate grid this build does not index the same way:
    // keep whatever presentWorld built. computeBiomesFine reads the grid through
    // the shared constants, so a mismatch would be misindexed rather than
    // rejected, and the upsample path is a working fallback.
    if (!biomeInputs || !seaLevelTemperature) return
    const { temperature, precipitationEffective, seasonalAmplitude, monsoonIndex } = biomeInputs

    // Dry basin floors: below sea level in THIS raster, yet land according to
    // the macro authority. Rebuilt per call because it depends on the field.
    let dryLand: Uint8Array | undefined
    if (macroBiomeAtTexel) {
      dryLand = new Uint8Array(paperField.length)
      for (let i = 0; i < paperField.length; i++) {
        if (paperField[i] <= SEA_LEVEL && macroBiomeAtTexel[i] !== Biome.Ocean) dryLand[i] = 1
      }
    }
    const ids = computeBiomesFine(
      temperature.data, precipitationEffective.data, seasonalAmplitude.data, monsoonIndex.data,
      paperField, PAPER_TEXTURE_WIDTH, PAPER_TEXTURE_HEIGHT, dryLand, seaLevelTemperature,
    )
    // Salt flats are a hydrology state and the classification has no way to
    // reach them — they come from the terminal-basin pass that ran on the macro
    // world. Carried over rather than re-derived, per the authority rule.
    if (macroBiomeAtTexel) {
      for (let i = 0; i < ids.length; i++) if (macroBiomeAtTexel[i] === Biome.SaltFlat) ids[i] = Biome.SaltFlat
    }
    biomeIds = ids
    biomeToggleButton.classList.toggle('is-off', !biomeWashEnabled)
    biomeToggleButton.disabled = false
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

  function presentWorld(elevations: Float32Array, width: number, height: number, biome: { data: Float32Array; resX: number; resY: number } | null, detailSeed: number, erosionControls: ErosionControls, climate: ClimateInput | null, savedBiomeInputs: typeof biomeInputs = null): void {
    hoverTooltip?.dispose()
    riverLayer?.dispose()
    riverLayer = null
    mapView?.dispose()
    biomeInputs = savedBiomeInputs
    // The macro ids at texture resolution, nearest — this is a lookup table for
    // two facts the classification cannot reach (salt flats, dry basin floors),
    // so nearest is right: they are categorical and the macro raster is their
    // authority. Blending them would invent states that exist nowhere.
    macroBiomeAtTexel = null
    if (biome) {
      const table = new Uint8Array(PAPER_TEXTURE_WIDTH * PAPER_TEXTURE_HEIGHT)
      for (let y = 0; y < PAPER_TEXTURE_HEIGHT; y++) {
        const sy = Math.min(biome.resY - 1, Math.floor((y / PAPER_TEXTURE_HEIGHT) * biome.resY))
        for (let x = 0; x < PAPER_TEXTURE_WIDTH; x++) {
          const sx = Math.min(biome.resX - 1, Math.floor((x / PAPER_TEXTURE_WIDTH) * biome.resX))
          table[y * PAPER_TEXTURE_WIDTH + x] = Math.round(biome.data[sy * biome.resX + sx])
        }
      }
      macroBiomeAtTexel = table
    }
    // Sea-level temperature, against the MACRO raster and its own dry-basin
    // floors (below sea level yet land) — the same pair computeTemperature saw.
    seaLevelTemperature = null
    if (savedBiomeInputs && savedBiomeInputs.temperature.resX === CLIMATE_RES_X && savedBiomeInputs.temperature.resY === CLIMATE_RES_Y) {
      let macroDry: Uint8Array | undefined
      if (biome) {
        macroDry = new Uint8Array(elevations.length)
        for (let i = 0; i < elevations.length; i++) {
          const by = Math.min(biome.resY - 1, Math.floor((Math.floor(i / width) / height) * biome.resY))
          const bx = Math.min(biome.resX - 1, Math.floor(((i % width) / width) * biome.resX))
          if (elevations[i] <= SEA_LEVEL && Math.round(biome.data[by * biome.resX + bx]) !== Biome.Ocean) macroDry[i] = 1
        }
      }
      seaLevelTemperature = reduceTemperatureToSeaLevel(savedBiomeInputs.temperature.data, elevations, width, height, macroDry)
    }
    // Fallback ids for a save too old to carry the classification's inputs:
    // dilate the land biomes over the ocean first (so coastal land can't sample
    // "Ocean" across the grid mismatch), then expand through a warped
    // coordinate so boundaries are organic rather than blocks. When the inputs
    // ARE present, applyPaper replaces this with a real classification below.
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
    // Acquired once, sampled freely — the two stages the facade exists for: the
    // sources are asynchronous, the readout fires per pointer move.
    void world?.acquire('elevation', 'presentation').then((view) => { elevationView = view })
    hoverTooltip = createMapHoverTooltip({
      scene,
      host: root,
      textureWidth: width,
      textureHeight: height,
      describe: (cellX, cellY) => {
        if (!elevationView) return null
        // World coordinates in, so the readout never has to know which grid
        // answered — that is the view's business, and it says so in `.source`.
        // The tooltip's cell grid IS the world raster, so a cell centre is
        // already a world coordinate.
        const elevation = elevationView.sample(cellX + 0.5, cellY + 0.5)
        const lines = [`${Math.round(elevationToMeters(elevation))} m`]
        if (elevation > 0) {
          // Read from the array that was actually PAINTED, not from the coarse
          // source it came from. expandBiomeIds domain-warps the upsample so
          // biome edges read as organic rather than blocky — which displaces a
          // boundary by tens of kilometres. Naming the unwarped cell meant the
          // map showed one biome and the tooltip said another, all along every
          // border. One source, and they agree by construction.
          if (biomeIds) {
            const px = Math.min(PAPER_TEXTURE_WIDTH - 1, Math.floor((cellX / width) * PAPER_TEXTURE_WIDTH))
            const py = Math.min(PAPER_TEXTURE_HEIGHT - 1, Math.floor((cellY / height) * PAPER_TEXTURE_HEIGHT))
            lines.push(t(biomeLabelKey(biomeIds[py * PAPER_TEXTURE_WIDTH + px]) as TKey))
          } else if (biome) {
            // No painted layer (the wash never built): the coarse source is the
            // only answer there is, and it is at least not contradicting one.
            const bx = Math.min(biome.resX - 1, Math.floor((cellX / width) * biome.resX))
            const by = Math.min(biome.resY - 1, Math.floor((cellY / height) * biome.resY))
            lines.push(t(biomeLabelKey(Math.round(biome.data[by * biome.resX + bx])) as TKey))
          }
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
    // Registered, not overwritten: the world gains a tier and the view is
    // re-acquired from it, so what the readout answers with stays a stated
    // property rather than a side effect of whichever bake finished last.
    world?.addAmplifiedElevation(artifact.elevation, artifact.width, artifact.height)
    void world?.acquire('elevation', 'presentation').then((view) => { elevationView = view; hoverTooltip?.refresh() })
    applyPaper(artifact.elevation, artifact.width, artifact.height)
    applyHeightField(artifact.elevation, artifact.width, artifact.height, detailSeed)
    applyRivers(artifact.riverPoints, artifact.riverLengths, artifact.width, artifact.height, factor)
    hoverTooltip?.refresh()
  }

  // DEBUG affordance: step through the resolutions this world actually has.
  // Deliberately English and untranslated, like the hexgrid and biome toggles
  // beside it — a debug control that will not outlive the investigation it
  // serves should not also mint two catalog entries.
  const resolutionButton = root.querySelector<HTMLButtonElement>('[data-action="cycle-resolution"]')!

  const levelLabel = (factor: number): string =>
    factor === 1 ? 'macro' : `${Math.round((bakeSource?.macroWidth ?? 2048) * factor / 1024)}k`

  function refreshResolutionButton(): void {
    // Hidden until there is a choice: a control that cycles a single value is
    // furniture, not an affordance.
    resolutionButton.hidden = availableFactors.length < 2
    resolutionButton.textContent = levelLabel(shownFactor)
  }

  // Records that a level exists, so the button offers it. Called wherever a
  // stage lands, whether it was baked here or fetched.
  function noteLevel(factor: number): void {
    if (!availableFactors.includes(factor)) {
      availableFactors.push(factor)
      availableFactors.sort((a, b) => a - b)
    }
    shownFactor = factor
    refreshResolutionButton()
  }

  async function showLevel(factor: number): Promise<void> {
    if (!bakeSource) return
    if (factor === 1) {
      applyBakeResult({
        elevation: bakeSource.macro,
        width: bakeSource.macroWidth,
        height: bakeSource.macroHeight,
        // The macro world has no rivers to show: they are a product of the
        // bake's hydrology re-run, not of the save.
        riverPoints: new Float32Array(0),
        riverLengths: new Uint32Array(0),
      }, 1, bakeSource.detailSeed)
      shownFactor = 1
      setBakeText(`${bakeSource.macroWidth}×${bakeSource.macroHeight} · macro`)
      refreshResolutionButton()
      return
    }
    const store = await getArtifactStore()
    const hit = await readAmplificationArtifact(store, { ...bakeSource.key, stage: String(factor) }, bakeSource.riverDensity).catch(() => null)
    if (!hit) {
      setBakeText(`${levelLabel(factor)} unavailable`)
      return
    }
    applyBakeResult(hit.artifact, factor, bakeSource.detailSeed)
    shownFactor = factor
    setBakeText(`${hit.artifact.width}×${hit.artifact.height} · forced`)
    refreshResolutionButton()
  }

  resolutionButton.addEventListener('click', () => {
    if (availableFactors.length < 2) return
    const next = availableFactors[(availableFactors.indexOf(shownFactor) + 1) % availableFactors.length]
    void showLevel(next)
  })

  // --- Ordering a bake from the server -------------------------------------
  //
  // The counterpart to the fetch/bake split in mapSceneSettings: the client
  // shows stages it must never bake itself, and this is how one of those comes
  // into existence. Everything about it is explicit — the button only appears
  // when there is genuinely something to order and somewhere to order it from,
  // and it never fires on its own. See world/bakeClient.ts for why automatic
  // ordering is the wrong design rather than merely a bolder one.
  const bakeButton = root.querySelector<HTMLButtonElement>('[data-action="order-bake"]')!

  // Records a level that could be shown but does not exist anywhere.
  function noteMissing(factor: number): void {
    if (!missingFactors.includes(factor)) {
      missingFactors.push(factor)
      missingFactors.sort((a, b) => a - b)
    }
  }

  // Coarsest first: if both 4k and 8k are absent, the cheaper one is also the
  // one that arrives sooner and improves the map more per minute spent.
  function nextMissing(): number | undefined {
    return missingFactors.find((factor) => !availableFactors.includes(factor))
  }

  async function refreshBakeButton(): Promise<void> {
    const generation = bakeGeneration
    const factor = nextMissing()
    // Hidden for exactly two reasons: nothing to bake, or nowhere to bake it.
    // Asking the server LAST keeps the common case free of a request.
    //
    // A missing worldUid is deliberately NOT one of them, though it will fail.
    // Hiding on it made three unrelated situations produce the same silent
    // nothing — no stage missing, no server, and a save too old to name itself
    // — and the third is the one a user can actually fix. So the button
    // appears and the click explains: saving the world to the server is the
    // remedy, and it is the same remedy the 404 case already names.
    const offerable = factor !== undefined && !bakeOrdered && (await canCommissionBakes())
    // The world may have changed while that was in flight.
    if (generation !== bakeGeneration) return
    bakeButton.hidden = !offerable
    if (offerable) bakeButton.textContent = t('common.action.orderBake.label', { level: levelLabel(factor!) })
  }

  async function orderBake(): Promise<void> {
    const factor = nextMissing()
    if (factor === undefined || bakeOrdered) return
    // A save with no `metadata.uid` cannot name its world to the server, and
    // guessing one would address a stranger's. Saying so is the whole point of
    // still showing the button — and saving the world is the fix for this and
    // for the 404 below alike.
    if (worldUid === '') {
      ctx.notifications.show({ message: t('common.notify.bakeNeedsUpload'), icon: '/icons/warning.png', durationMs: 12000 })
      return
    }
    const generation = bakeGeneration
    bakeOrdered = true
    bakeButton.hidden = true
    const label = levelLabel(factor)

    const pipelineVersion = amplificationPipelineVersion()

    // A bake runs for minutes, so the progress belongs in a notification the
    // user can walk away from rather than in a readout on one panel. Sticky:
    // it is dismissed when the work ENDS, not on a timer, because a toast that
    // expired mid-bake would leave no sign that anything was still happening.
    const toast = ctx.notifications.show({
      message: t('common.notify.bakeWaiting', { level: label }),
      icon: '/icons/server_load.png',
      sticky: true,
    })
    // Every exit from here goes through this, so the sticky toast cannot
    // outlive the job that justified it.
    const settle = (message: string, icon: string, durationMs: number): void => {
      ctx.notifications.dismiss(toast)
      ctx.notifications.show({ message, icon, durationMs })
    }

    const order = await commissionBake(worldUid, factor, AMPLIFY_EROSION_ROUNDS)
    if (generation !== bakeGeneration) {
      ctx.notifications.dismiss(toast)
      return
    }
    if (!order.ok) {
      // The one outcome that is not a fault: a world that was never uploaded.
      // Saying "save it to the server first" is actionable in a way a 404 is
      // not, so it gets its own message rather than a generic refusal.
      settle(
        order.reason === 'unknownWorld'
          ? t('common.notify.bakeNeedsUpload')
          : t('common.notify.bakeFailed', { reason: order.message ?? '' }),
        '/icons/warning.png',
        12000,
      )
      setBakeText(`${label} ✕`)
      bakeOrdered = false
      void refreshBakeButton()
      return
    }

    const outcome = await followBake(order.job.id, pipelineVersion, (job) => {
      if (generation !== bakeGeneration) return
      // Waiting and working are different things and are said differently: in
      // a cluster the first state is a Job with no node yet, which with hard
      // anti-affinity is routine rather than a fault. The bar appears only
      // where there is a real fraction to draw — see bakeFraction.
      ctx.notifications.update(toast, {
        message: t(bakeIsWaiting(job) ? 'common.notify.bakeWaiting' : 'common.notify.bakeRunning', { level: label }),
        progress: bakeFraction(job),
      })
    })
    if (generation !== bakeGeneration) {
      ctx.notifications.dismiss(toast)
      return
    }

    if (!outcome.ok) {
      // The mismatch case is not a failure on the server's side: the bake ran
      // and its bytes are real, they are simply addressed by a key this client
      // never reads. Nothing about clicking again would change that, so the
      // button stays gone and the message names both builds.
      settle(
        outcome.reason === 'mismatch'
          ? t('common.notify.bakeMismatch', { serverVersion: outcome.serverVersion, clientVersion: outcome.clientVersion })
          : t('common.notify.bakeFailed', { reason: outcome.message }),
        '/icons/warning.png',
        15000,
      )
      setBakeText(`${label} ✕`)
      if (outcome.reason !== 'mismatch') {
        bakeOrdered = false
        void refreshBakeButton()
      }
      return
    }

    // The artifact is on the server now. Reading through the TIERED store both
    // fetches and backfills it locally, so the next load of this world is a
    // local hit rather than a second download.
    const store = await getArtifactStore()
    const hit = await readAmplificationArtifact(store, { worldId, pipelineVersion, stage: String(factor) }, bakeSource?.riverDensity).catch(() => null)
    // bakeSource carries the detail seed the near-field bumps grow from, and a
    // wrong one would draw a different world at the same resolution. Checked
    // rather than defaulted: there is no sensible stand-in for it.
    if (generation !== bakeGeneration || !bakeSource) {
      ctx.notifications.dismiss(toast)
      return
    }
    if (!hit) {
      settle(t('common.notify.bakeUnfetchable', { level: label }), '/icons/warning.png', 12000)
      setBakeText(`${label} ✕`)
      bakeOrdered = false
      void refreshBakeButton()
      return
    }
    applyBakeResult(hit.artifact, factor, bakeSource.detailSeed)
    noteLevel(factor)
    settle(
      t('common.notify.bakeDone', {
        level: label,
        width: outcome.result.width,
        height: outcome.result.height,
        seconds: Math.round(outcome.result.durationMs / 1000),
      }),
      '/icons/server_clean.png',
      15000,
    )
    setBakeText(`${hit.artifact.width}×${hit.artifact.height}`)
    bakeOrdered = false
    void refreshBakeButton()
  }

  bakeButton.addEventListener('click', () => { void orderBake() })

  // Attach to a bake somebody else set in motion — same follow, same toasts,
  // same read-back as orderBake, minus the ordering. True when the stage ended
  // up applied; false sends the caller down the path it would have taken had
  // the job not existed (bake locally, or offer the order button).
  //
  // Deliberately NOT merged with orderBake despite the resemblance: one
  // places an order and owns the outcomes of placing it (unknownWorld, busy,
  // forbidden), the other only watches, and a shared body would carry both
  // sets of special cases behind flags. The notification flow is the part
  // they genuinely share, and it is the catalog that keeps those texts single.
  async function followExistingBake(job: BakeJob, factor: number): Promise<boolean> {
    const generation = bakeGeneration
    const label = levelLabel(factor)
    const pipelineVersion = amplificationPipelineVersion()
    bakeOrdered = true
    void refreshBakeButton()
    const toast = ctx.notifications.show({
      message: t(bakeIsWaiting(job) ? 'common.notify.bakeWaiting' : 'common.notify.bakeRunning', { level: label }),
      icon: '/icons/server_load.png',
      sticky: true,
    })
    const settle = (message: string, icon: string, durationMs: number): void => {
      ctx.notifications.dismiss(toast)
      ctx.notifications.show({ message, icon, durationMs })
    }

    const outcome = await followBake(job.id, pipelineVersion, (update) => {
      if (generation !== bakeGeneration) return
      ctx.notifications.update(toast, {
        message: t(bakeIsWaiting(update) ? 'common.notify.bakeWaiting' : 'common.notify.bakeRunning', { level: label }),
        progress: bakeFraction(update),
      })
    })
    if (generation !== bakeGeneration) {
      ctx.notifications.dismiss(toast)
      return false
    }
    if (!outcome.ok) {
      // A mismatch is worth its sentence — the job worked, for another build,
      // and re-attaching cannot change that. A failed job is NOT worth one
      // here: the caller is about to do the work another way, and a failure
      // toast followed by a successful bake reads as the screen contradicting
      // itself.
      if (outcome.reason === 'mismatch') {
        settle(t('common.notify.bakeMismatch', { serverVersion: outcome.serverVersion, clientVersion: outcome.clientVersion }), '/icons/warning.png', 15000)
      } else {
        ctx.notifications.dismiss(toast)
        bakeOrdered = false
        void refreshBakeButton()
      }
      return false
    }

    const store = await getArtifactStore()
    const hit = await readAmplificationArtifact(store, { worldId, pipelineVersion, stage: String(factor) }, bakeSource?.riverDensity).catch(() => null)
    if (generation !== bakeGeneration || !bakeSource) {
      ctx.notifications.dismiss(toast)
      return false
    }
    if (!hit) {
      settle(t('common.notify.bakeUnfetchable', { level: label }), '/icons/warning.png', 12000)
      bakeOrdered = false
      void refreshBakeButton()
      return false
    }
    applyBakeResult(hit.artifact, factor, bakeSource.detailSeed)
    noteLevel(factor)
    settle(
      t('common.notify.bakeDone', {
        level: label,
        width: outcome.result.width,
        height: outcome.result.height,
        seconds: Math.round(outcome.result.durationMs / 1000),
      }),
      '/icons/server_clean.png',
      15000,
    )
    setBakeText(`${hit.artifact.width}×${hit.artifact.height}`)
    bakeOrdered = false
    void refreshBakeButton()
    return true
  }

  // --- Amplification bake (docs/decisions/worldmap-amplification.md) ---
  // Runs in its own worker after the macro map is already on screen, then
  // swaps the geometry. Deliberately fire-and-forget from the load path: a
  // failed or slow bake leaves a perfectly usable macro world behind.
  function startAmplification(macro: Float32Array, macroWidth: number, macroHeight: number, detailSeed: number, erosionControls: ErosionControls, climate: ClimateInput | null): void {
    amplifyWorker?.terminate() // a new world supersedes any bake in flight
    // Every stage worth showing, coarse first. Which of them this machine may
    // BAKE is a separate question, asked per stage below.
    // The macro raster is always a level, and it is the one the world is
    // showing right now.
    bakeSource = { macro, macroWidth, macroHeight, detailSeed, riverDensity: erosionControls.riverDensity, key: { worldId, pipelineVersion: amplificationPipelineVersion() } }
    availableFactors = [1]
    shownFactor = 1
    // A new world knows nothing about the last one's gaps, and an order placed
    // for the previous world must not keep this one's button hidden.
    missingFactors = []
    bakeOrdered = false
    refreshResolutionButton()
    void refreshBakeButton()

    const stages = AMPLIFY_FETCH_STAGES.filter((factor) => factor > 1)
    if (stages.length === 0) return
    const generation = ++bakeGeneration

    // Which orderable stages are absent, asked UP FRONT rather than as the
    // chain reaches them.
    //
    // The chain runs coarse-first and each stage waits for the last, so a
    // browser that has to bake 4k first would not learn that 8k is missing for
    // another minute or two — and the button to order it would appear long
    // after the moment someone was looking for it. Nothing about that check
    // depends on the earlier stage's result: it is a store lookup, and it can
    // happen immediately.
    //
    // Self-correcting if a stage turns out to be present after all: the chain
    // fetches it, noteLevel records it, and nextMissing filters it back out.
    void (async () => {
      const store = await getArtifactStore()
      for (const factor of stages) {
        if (AMPLIFY_BAKE_STAGES.includes(factor)) continue // this tab can make it itself
        const key = { worldId, pipelineVersion: bakeSource!.key.pipelineVersion, stage: String(factor) }
        // Presence only — reading it here would download and decode ~134 MB
        // just to answer whether a button should be shown, and the chain is
        // about to fetch it properly anyway.
        const present = await amplificationArtifactExists(store, key, bakeSource?.riverDensity).catch(() => false)
        if (generation !== bakeGeneration) return
        if (!present) noteMissing(factor)
      }
      if (generation === bakeGeneration) void refreshBakeButton()
    })()

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
        pipelineVersion: amplificationPipelineVersion(),
        stage: String(factor),
      }
      const store = await getArtifactStore()
      if (generation !== bakeGeneration) return
      const hit = await readAmplificationArtifact(store, key, erosionControls.riverDensity).catch(() => null)
      if (hit && generation === bakeGeneration) {
        applyBakeResult(hit.artifact, factor, detailSeed)
        noteLevel(factor)
        setBakeText(`${hit.artifact.width}×${hit.artifact.height} · cached`)
        void runStage(index + 1)
        return
      }

      // Absent from every store — but is somebody already MAKING it? The
      // worldgen screen orders server bakes, the server does not deduplicate
      // orders, and a read that raced the job's last write misses honestly.
      // In all of those, computing it here again is the waste this check
      // exists to prevent: attach to the existing job, then read what it
      // wrote. Reported as a bug before the check existed — the map baked 4K
      // beside a server that was baking, or had just baked, the same world.
      const active = await findActiveBake(worldUid, factor).catch(() => null)
      if (generation !== bakeGeneration) return
      if (active) {
        const attached = await followExistingBake(active, factor)
        if (generation !== bakeGeneration) return
        if (attached) {
          void runStage(index + 1)
          return
        }
        // Attach failed (job died, or its output is keyed for another build):
        // fall through to what would have happened without it.
      }

      // Fetch-only stage with nothing on the server: stop here rather than
      // bake it. This is the whole point of the split — an 8k bake is the
      // 2.6 GB that kills the tab, and a stage the client cannot produce must
      // not be attempted just because it was allowed to be shown.
      if (!AMPLIFY_BAKE_STAGES.includes(factor)) {
        // Not a dead end any more: this is precisely the stage a server can
        // make and a tab cannot, so it is offered rather than merely skipped.
        noteMissing(factor)
        void refreshBakeButton()
        void runStage(index + 1)
        return
      }

      // About to spend a minute-plus computing a stage a server may well be
      // holding — name why the cached path came up empty, because every link
      // in it fails silently by design (a store miss means "compute it") and
      // "the map baked again" has already been reported as a bug with no way
      // to tell WHICH link broke. Console only: this is for whoever is
      // debugging, not for the player.
      void getServerStatus().then((status) => {
        console.info(
          `[bake] ${label}: not in cache, baking locally — server ${status.state}`
          + `${status.state === 'remote' ? (hasSession() ? ', signed in' : ', NO SESSION (reads 401)') : ''}`
          + `, key ${key.worldId}/${key.pipelineVersion}/${key.stage}`,
        )
      })
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
        noteLevel(factor)
        setBakeText(`${message.width}×${message.height} · ${(message.durationMs / 1000).toFixed(0)}s`)
        finish()
        // Stored after the result is on screen, so the write never delays
        // what the user is waiting for — and failing to store is not an
        // error, only a bake that will happen again.
        void writeAmplificationArtifact(store, key, artifact, message.durationMs, erosionControls.riverDensity).catch(() => false)
        void runStage(index + 1)
      }
      // A stage that dies (the deepest tier needs ~3 GB — a browser may
      // simply refuse) must not take the screen with it: the last good
      // result stays up and the readout says where it stopped.
      worker.onerror = () => {
        if (generation !== bakeGeneration) return
        setBakeText(`${label} failed`)
        // A stage this machine could not manage is a good candidate for one
        // that is not a browser tab — the failure is usually memory, and that
        // is exactly what the server has more of.
        noteMissing(factor)
        void refreshBakeButton()
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
      serverIndicator.dispose()
      loadPanel.dispose()
      disposeCamera()
      root.remove()
      scene.dispose()
    },
  }
}
