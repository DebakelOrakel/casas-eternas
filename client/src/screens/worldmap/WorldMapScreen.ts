import { Color3, Color4, MeshBuilder, PointerEventTypes, RawTexture, Scene, ShaderMaterial, Texture } from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { createGeneratorCamera } from '../../camera/generatorCamera'
import { NEAR_RENDERING_GROUP, createToroidalMapView } from '../../map/ToroidalMapView'
import { createToroidalRibbonOverlay } from '../../map/ToroidalRibbonOverlay'
import type { ToroidalMapView } from '../../map/ToroidalMapView'
import { createMapHoverTooltip } from '../../map/MapHoverTooltip'
import type { MapHoverTooltip } from '../../map/MapHoverTooltip'
import { hexAt, hexCenter, wrappedHexDelta } from '../../map/hexGrid'
import { createHexClassifier, hexUvFromWorld } from '../../map/hexTiles'
import { WATER_LINE_INK } from '../../map/terrainPalette'
import type { HexClassifier, HexTileClass } from '../../map/hexTiles'
import { buildRiverPorts, hexShoreCrossings } from '../../map/hexPorts'
import type { HexRiverPortMap } from '../../map/hexPorts'
import { HEX_COLUMNS, HEX_ROWS } from '../../map/mapSceneSettings'
import { createElevationSurface } from '../../map/elevationSurface'
import { createFineElevationSurface } from '../../map/fineElevationSurface'
import { buildChannelField } from '../../map/channelField'
import type { ChannelField } from '../../map/channelField'
import { createMapPresentation, DEFAULT_KNOWLEDGE_RAMP, DEFAULT_PIGMENT_TUNING } from '../../map/mapPresentation'
import type { KnowledgeRamp, MapWorldFields, PigmentTuning } from '../../map/mapPresentation'
import { DEFAULT_TERRAIN_WASH } from '../../map/terrainPalette'
import type { TerrainWash } from '../../map/terrainPalette'
import type { ElevationSurface } from '../../map/elevationSurface'
import { createKnowledgeField } from './knowledgeField'
import type { KnowledgeField } from './knowledgeField'
import { createKnowledgeDebugPanel } from './knowledgeDebugPanel'
import { createWatercolorPass } from './watercolorPass'
import { MAP_EXAGGERATION, NEAR_EXAGGERATION, PAPER_TEXTURE_HEIGHT, PAPER_TEXTURE_WIDTH, HEX_COL_SPACING, HEX_ROW_SPACING, HEXGRID_FADE_HIGH_ALTITUDE, HEXGRID_FADE_LOW_ALTITUDE, MAP_WORLD_WIDTH as WORLD_WIDTH, MAP_WORLD_HEIGHT as WORLD_HEIGHT, NEAR_MIN_ALTITUDE, RELIEF_FINE_ZOOM, RELIEF_HEIGHT_SCALE, RELIEF_MIN_ZOOM } from '../../map/mapSceneSettings'
import { AMPLIFY_FINEST_STAGE } from '../../world/bakeSettings'
import { elevationToMeters } from '../../generator/elevation/elevationScale'
import { Biome, biomeLabelKey } from '../../generator/climate/biomes'
import { t } from '../../i18n/i18n'
import type { TKey } from '../../i18n/i18n'
import { createHelpTooltip } from '../../ui/help/HelpTooltip'
import { amplificationPipelineVersion, readAmplificationArtifact } from '../../world/artifacts'
import { getArtifactStore } from '../../storage/artifactStoreProvider'
import { artifactKey } from '../../storage/ArtifactStore'
import { createStoragePanel } from '../../ui/storagePanel/StoragePanel'
import { createServerIndicator } from '../../ui/serverIndicator/ServerIndicator'
import { createTitleBar } from '../../ui/titleBar/TitleBar'
import { createLoadPanel } from '../../ui/worldPanels/LoadPanel'
import { getServerStatus } from '../../server/serverStatus'
import { worldInputsFrom } from '../../world/save/loadWorldInputs'
import { deriveRivers } from '../../generator/surface/runAmplification'
import { openWorld } from '../../world/query'
import type { FieldView, World } from '../../world/query'
import '../../ui/chrome/chrome.css'

// "Herederos del Mundo" — the world-map screen. Reads a saved world (.zip)
// through the QUERYABLE side of the save (manifest.json + baked layers —
// see docs/decisions/queryable-world-save.md), deliberately NOT through the
// generator's worker/restore path: this screen consumes a finished world,
// it doesn't continue simulating one. v1 is the flat paper map + hover
// readout; the relief/LOD ladder from docs/design/hex-world-view.md comes
// next, feeding off the same elevation raster.

// How many stand-in settlements a freshly loaded world starts with — enough
// that the three registers are all on screen at once, which is what stage A is
// for judging. Goes away with the debug field it seeds.
const SEED_SETTLEMENTS = 7

// The rivers' two registers (docs/design/watercolor-map.md: "coast and rivers
// as single confident lines" — ink over paint). On the paper map a river is
// INK — the shared water-line pen, so the ribbons and the lake shorelines
// stroked into the paper (terrainPalette) are literally one colour; on the
// descent the map becomes a world and the line becomes water. Lerped along
// the same near-blend that fades the watercolour and the exaggeration, so all
// three register shifts arrive together.
const RIVER_INK = new Color3(WATER_LINE_INK[0] / 255, WATER_LINE_INK[1] / 255, WATER_LINE_INK[2] / 255)
const RIVER_WATER = new Color3(45 / 255, 95 / 255, 175 / 255)

export const createWorldMapScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)

  const {
    camera,
    dispose: disposeCamera,
    getFocus: getCameraFocus,
    setDeepZoomEnabled: setCameraDeepZoom,
    setDesiredTilt: setCameraDesiredTilt,
    setPanEnabled: setCameraPanEnabled,
    getZoom: getCameraZoom,
    getYaw: getCameraYaw,
    getNearBlend: getCameraNearBlend,
    getAltitude: getCameraAltitude,
    getViewWidth: getCameraViewWidth,
  } = createGeneratorCamera({
    scene,
    canvas: ctx.canvas,
    engine: ctx.engine,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    // Past the deepest map zoom the camera hands over to the perspective
    // NEAR regime — the descent toward the horizon view (Stage A of the
    // world view; see generatorCamera's header).
    nearModeEnabled: true,
    nearMinAltitude: NEAR_MIN_ALTITUDE,
    // What the descent's altitude is measured FROM. The near ground the
    // camera can fly into is the DRAWN one, so the sampler is the same
    // biased fine surface the patch and the hex lattice render, times the
    // exaggeration in force this frame.
    getGroundHeight: () => {
      if (!reliefDetailSurface) return 0
      const focus = getCameraFocus()
      const { u, v } = hexUvFromWorld(focus.x, focus.z)
      return reliefDetailSurface.heightAtUV(u, v) * drawnExaggeration
    },
  })

  // The exaggeration in force this frame, kept because the camera has to
  // measure its altitude against the ground as DRAWN, not as stored.
  let drawnExaggeration = MAP_EXAGGERATION

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
  const riverColorScratch = new Color3()
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
    drawnExaggeration = exaggeration
    mapView?.setHeightScale(exaggeration)
    riverLayer?.setHeightScale(exaggeration)
    shoreLayer?.setHeightScale(exaggeration)
    Color3.LerpToRef(RIVER_INK, RIVER_WATER, blend, riverColorScratch)
    riverLayer?.setColor(riverColorScratch)
    shoreLayer?.setColor(riverColorScratch)
  })

  // Built per loaded world (texture dims come from its manifest); replaced
  // wholesale on the next load.
  let mapView: ToroidalMapView | null = null
  let hoverTooltip: MapHoverTooltip | null = null
  // The world this screen is showing, and the elevation view it reads.
  //
  // `heightField` used to be a plain variable that the arriving tier OVERWROTE
  // — which is why the hover readout silently changed resolution mid-session.
  // Now the amplified tier is REGISTERED with the world and the view is
  // re-acquired, so the answer still sharpens but the source it came from is a
  // property of the view rather than of whatever landed last.
  //
  // `presentation` is the honest purpose here: the readout answers "how high is
  // the ground I am looking at", and once a tier has landed that ground IS the
  // amplified one. A rule would ask for `authoritative` and get the macro
  // raster.
  let world: World | null = null
  let elevationView: FieldView | null = null
  // Bumped on every load so a tier fetch for a superseded world can't swap its
  // result in after the user has opened a different one.
  let loadGeneration = 0
  // Identity of the world currently loaded, derived from what the bake
  // actually consumes (see world/identity.ts) — the key its artifacts are
  // stored under.
  let worldId = ''
  // The stable uid beside the content hash — the artifact path carries both
  // (see ArtifactStore's grammar). Empty for a save too old to carry one.
  let worldUid = ''
  // Scene-space river ribbons + the relief surfaces they drape on (set when an
  // amplified tier arrives), and which relief level they are currently styled
  // for.
  let riverLayer: ReturnType<typeof createToroidalRibbonOverlay> | null = null
  // The lake shorelines, a second ribbon overlay in the same ink — vector like
  // the rivers, so shore and river stay one pen at every zoom (the painted
  // first cut blurred beside the crisp ribbons). Sourced from the
  // presentation's tracer, which skips frozen basins.
  let shoreLayer: ReturnType<typeof createToroidalRibbonOverlay> | null = null
  let shoreSource: { points: Float32Array; lengths: Uint32Array; width: number; height: number } | null = null
  let ribbonLevel: 'flat' | 'coarse' | 'fine' | 'near' = 'flat'

  // What the presentation last produced. Held here rather than pushed straight
  // into the map view because the view does not exist yet the first time round:
  // a world's paper and surfaces are derived BEFORE the view is built (the
  // near-detail patch needs two of the surfaces at construction), and pushed in
  // as soon as it is. Every later tier finds the view already there and goes
  // through the same two functions.
  let latestPaper: { shaded: Uint8ClampedArray; unshaded: Uint8ClampedArray } | null = null
  let reliefCoarseSurface: ElevationSurface | null = null
  let reliefFineSurface: ElevationSurface | null = null
  let reliefDetailSurface: ElevationSurface | null = null

  function pushPaper(): void {
    if (!mapView || !latestPaper) return
    mapView.texture.update(new Uint8Array(latestPaper.shaded.buffer))
    mapView.reliefTexture.update(new Uint8Array(latestPaper.unshaded.buffer))
  }

  function pushSurfaces(): void {
    if (!mapView || !reliefCoarseSurface || !reliefFineSurface || !reliefDetailSurface) return
    mapView.setReliefSurfaces(reliefCoarseSurface, reliefFineSurface)
    mapView.setNearDetailSurfaces(reliefDetailSurface, reliefFineSurface)
    syncRibbonLevel(true) // the ribbons drape on these same surfaces
  }

  // How much of this world is known (see knowledgeField.ts — the field is a
  // STAND-IN until exploration exists). Rebuilt per world, because its stand-in
  // settlements are seeded from that world's own terrain.
  let knowledge: KnowledgeField | null = null
  const knowledgeRamp: KnowledgeRamp = { ...DEFAULT_KNOWLEDGE_RAMP }
  const pigmentTuning: PigmentTuning = { ...DEFAULT_PIGMENT_TUNING }
  const terrainWash: TerrainWash = { ...DEFAULT_TERRAIN_WASH }
  // What the stand-in settlements are placed against, kept so "reseed" can run
  // again without reloading the world.
  let knowledgeSeedInputs: { elevations: Float32Array; width: number; height: number; biome: { data: Float32Array; resX: number; resY: number } | null; detailSeed: number } | null = null
  // Re-seeded with a different offset each time, so pressing the button walks
  // through arrangements instead of redrawing the same one.
  let knowledgeSeedNonce = 0

  function seedKnowledge(): void {
    if (!knowledge || !knowledgeSeedInputs) return
    const { elevations, width, height, biome, detailSeed } = knowledgeSeedInputs
    knowledge.seed(elevations, width, height, biome, detailSeed + knowledgeSeedNonce++, SEED_SETTLEMENTS)
  }
  // The rivers as the bake extracted them, retained because the ones actually
  // DRAWN are a subset that changes with knowledge.
  let riverSource: { points: Float32Array; lengths: Uint32Array; width: number; height: number; factor: number } | null = null
  // The height raster in force, kept because everything the near field derives
  // — the classifier, the channel distance field — is rebuilt by events that
  // do not carry it (a river network landing, a tier's polylines arriving).
  let currentRaster: { data: Float32Array; width: number; height: number; detailSeed: number } | null = null
  // Step 1 of the near-field plan: where the water is, as a field. Built from
  // whichever river network is current, so it turns over with the tier.
  let channelField: ChannelField | null = null

  // A repaint touches every one of the paper's 8.4 million texels twice over,
  // so it cannot run per pointer-move. The brush writes into the field (cheap,
  // a few hundred coarse cells) and the picture catches up on a timer — which
  // is honest for a debug tool and is also roughly how wet paint behaves.
  const KNOWLEDGE_REPAINT_INTERVAL_MS = 220
  let knowledgeRepaintTimer: ReturnType<typeof setTimeout> | null = null

  // The sheet: paper fibre, granulation, spatter, drips (see watercolorPass).
  // Fades out over the descent along the same ramp everything else in the near
  // regime keys off — the effect belongs to the MAP register.
  const watercolor = createWatercolorPass({
    scene,
    camera,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    getStrength: () => 1 - getCameraNearBlend(),
  })

  // Resolution of the k texture the shader reads. Coarser than the paper on
  // purpose: fibre and spatter do not need texel precision, and this is
  // re-uploaded on every brush stroke.
  const KNOWLEDGE_TEXTURE_WIDTH = 1024
  const KNOWLEDGE_TEXTURE_HEIGHT = 512

  function refreshKnowledge(): void {
    presentation.refreshKnowledge()
    setRiverPolylines()
    setShorePolylines()
    if (knowledge) watercolor.setKnowledge(knowledge.toBytes(KNOWLEDGE_TEXTURE_WIDTH, KNOWLEDGE_TEXTURE_HEIGHT), KNOWLEDGE_TEXTURE_WIDTH, KNOWLEDGE_TEXTURE_HEIGHT)
  }

  function scheduleKnowledgeRepaint(): void {
    if (knowledgeRepaintTimer !== null) return
    knowledgeRepaintTimer = setTimeout(() => {
      knowledgeRepaintTimer = null
      refreshKnowledge()
    }, KNOWLEDGE_REPAINT_INTERVAL_MS)
  }

  // How this world's fields become pixels and heights — see map/mapPresentation.
  // One instance for the screen's lifetime: the texture resolution is fixed for
  // the session, so a tier landing never rebuilds it.
  const presentation = createMapPresentation({
    textureWidth: PAPER_TEXTURE_WIDTH,
    textureHeight: PAPER_TEXTURE_HEIGHT,
    onPaper: (shaded, unshaded) => { latestPaper = { shaded, unshaded }; pushPaper() },
    onSurfaces: (coarse, fine, detail) => {
      reliefCoarseSurface = coarse
      reliefFineSurface = fine
      reliefDetailSurface = detail
      pushSurfaces()
    },
  })

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
  `
  ctx.overlay.appendChild(root)
  const helpTooltip = createHelpTooltip(root)

  // Cache admin: the button reports what the origin is holding and opens the
  // manager (a centred window, shared with the generator) rather than
  // clearing outright — with several worlds cached, "delete everything" is
  // rarely the operation actually wanted.
  // Where a world would go, shown on every screen (see ui/serverIndicator).
  const serverIndicator = createServerIndicator(root)
  root.querySelector('[data-slot="server-indicator"]')!.replaceWith(serverIndicator.element)

  // The same strip the generator wears (ui/titleBar). It carries no save state
  // here on purpose: this screen opens finished worlds and never edits one, so
  // every state the bar could show would be a claim about a save it did not
  // make. It shows which world is open once one is.
  //
  // onLocaleChange rebuilds the screen, which this one can afford — unlike the
  // generator it holds no unsaved work, only a world it can open again.
  const titleBar = createTitleBar(root, {
    onSignIn: () => serverIndicator.openSignIn(),
    onLocaleChange: () => ctx.goTo('worldmap'),
  })
  titleBar.setWorld(null)

  const storagePanel = createStoragePanel(root)
  root.querySelector('[data-action="cache-manager"]')!.addEventListener('click', () => storagePanel.open())

  // Stage A's tuning strip — temporary, see knowledgeDebugPanel.ts.
  const debugPanel = createKnowledgeDebugPanel(root, {
    ramp: knowledgeRamp,
    sheet: watercolor.tuning,
    onRampChange: () => { presentation.setKnowledgeRamp(knowledgeRamp); setRiverPolylines(); setShorePolylines() },
    pigment: pigmentTuning,
    onPigmentChange: () => presentation.setPigment(pigmentTuning),
    wash: terrainWash,
    onWashChange: () => presentation.setTerrainWash(terrainWash),
    onSeed: () => { seedKnowledge(); refreshKnowledge() },
    onClear: () => { knowledge?.fill(0); refreshKnowledge() },
    onReveal: () => { knowledge?.fill(1); refreshKnowledge() },
    // The map must not slide out from under a brush stroke — the camera
    // exposes exactly this seam (see generatorCamera's setPanEnabled).
    onBrushToggle: (active: boolean) => setCameraPanEnabled(!active),
    onClassesToggle: (active: boolean) => {
      hexClassesOn = active
      if (!active) {
        resetHexClassWindow()
        mapView?.setHexClassOverlay(null)
      }
    },
    onNearGroundToggle: (visible: boolean) => mapView?.setNearGroundVisible(visible),
  })

  // Paint knowledge where the pointer is. Babylon's pick gives the map plane's
  // UV directly, and every wrapped tile instance shares those UVs — so a stroke
  // over any copy of the torus lands on the one world underneath.
  let brushDown = false
  const brushObserver = scene.onPointerObservable.add((info) => {
    if (!debugPanel.isBrushActive() || !knowledge) return
    if (info.type === PointerEventTypes.POINTERUP) {
      brushDown = false
      refreshKnowledge() // the stroke ended: show it in full at once
      return
    }
    if (info.type === PointerEventTypes.POINTERDOWN) brushDown = true
    else if (info.type !== PointerEventTypes.POINTERMOVE || !brushDown) return
    const uv = scene.pick(scene.pointerX, scene.pointerY)?.getTextureCoordinates()
    if (!uv) return
    knowledge.paint(uv.x, uv.y, debugPanel.brushRadius(), 1)
    scheduleKnowledgeRepaint()
  })

  // Phase 2 (hex-world-view.md build plan): per-tile classification over the
  // TRUTH fine surface — the same fine-height seam the near patch renders,
  // but with bias 0 (the patch's 0.6 exists to stay above the base mesh and
  // must not become anyone's ground truth). Rebuilt whenever the height
  // raster in force changes, so the cache can never serve a stale tier.
  let hexClassifier: HexClassifier | null = null
  let hexLakeDepth: { data: Float32Array; resX: number; resY: number } | null = null
  // Phase 3: the seam data. Rivers RESERVE ports, shorelines COMPUTE their
  // crossing — see map/hexPorts.ts. Deliberately NOT folded into the cached
  // classification: the terrain class is world-wide and invalidated by a new
  // height raster, while the port map is a moving window around the camera.
  // One cache per invalidation rule; the consumers below combine them.
  let hexShoreHeight: ((x: number, z: number) => number) | null = null
  let hexPorts: HexRiverPortMap | null = null
  let hexPortsCenter: { x: number; z: number } | null = null
  // Half-width in tiles. Deliberately LARGER than the class overlay window
  // (96 tiles across) so that window lies strictly inside it: a port-map miss
  // for a tile the overlay paints then means "no river here", never "outside
  // the window I built".
  const HEX_PORT_WINDOW_TILES = 72

  function rebuildHexPorts(): void {
    if (!riverSource) return
    const focus = getCameraFocus()
    const half = HEX_PORT_WINDOW_TILES * HEX_COL_SPACING
    if (hexPortsCenter) {
      const d = wrappedHexDelta(hexPortsCenter, { x: focus.x, z: focus.z })
      if (Math.abs(d.x) < half / 2 && Math.abs(d.z) < half / 2) return
    }
    hexPortsCenter = { x: focus.x, z: focus.z }
    hexPorts = buildRiverPorts(
      { points: riverSource.points, lengths: riverSource.lengths, width: riverSource.width, height: riverSource.height },
      { centerX: focus.x, centerZ: focus.z, halfWidth: half, halfHeight: half },
    )
    // The overlay's river flags were filled against the previous port map.
    resetHexClassWindow()
  }

  function rebuildHexClassifier(): void {
    if (!currentRaster) return
    const { data: field, width: fieldWidth, height: fieldHeight, detailSeed } = currentRaster
    // UNCLAMPED for the shoreline: the render surfaces flatten the sea to
    // zero, which would collapse every waterline crossing onto a corner.
    const bathymetry = createElevationSurface(field, fieldWidth, fieldHeight, RELIEF_HEIGHT_SCALE, false)
    hexShoreHeight = (x, z) => {
      const { u, v } = hexUvFromWorld(x, z)
      return bathymetry.heightAtUV(u, v)
    }
    const truth = createFineElevationSurface({ elevation: field, resX: fieldWidth, resY: fieldHeight, heightScale: RELIEF_HEIGHT_SCALE, seed: detailSeed, bias: 0, channels: channelField })
    const lake = hexLakeDepth ? createElevationSurface(hexLakeDepth.data, hexLakeDepth.resX, hexLakeDepth.resY, 1) : null
    hexClassifier = createHexClassifier({
      heightAtUV: (u, v) => truth.heightAtUV(u, v),
      lakeDepthAtUV: lake ? (u, v) => lake.heightAtUV(u, v) : undefined,
      biomeIdAtUV: (u, v) => presentation.biomeIdAtUV(u, v),
    })
    resetHexClassWindow()
  }

  // The class overlay's window: HEX_CLASS_WINDOW² tiles around the camera
  // focus, classified INCREMENTALLY (the classifier runs 13 fine-surface
  // samples per tile — a full window in one frame would hitch), written to
  // a small RGBA texture the grid shader samples. Debug instrument like the
  // rest of the panel; dies with it.
  const HEX_CLASS_WINDOW = 96
  const HEX_CLASS_FILL_BUDGET = 600
  let hexClassesOn = false
  let hexClassTexture: RawTexture | null = null
  let hexClassData: Uint8Array | null = null
  let hexClassOrigin: { col0: number; row0: number } | null = null
  let hexClassFill = 0

  function hexClassEncode(cls: HexTileClass): number {
    if (cls.water === 'water') return 1
    if (cls.water === 'shore') return 2
    return 3 + Math.max(0, Math.min(10, Math.round(cls.grade * 10)))
  }

  function resetHexClassWindow(): void {
    hexClassOrigin = null
    hexClassFill = 0
    hexClassData?.fill(0)
  }

  const wrapCentered = (d: number, n: number): number => {
    const m = ((d % n) + n) % n
    return m > n / 2 ? m - n : m
  }

  function updateHexClassOverlay(): void {
    if (!mapView) return
    if (!hexClassesOn || !hexClassifier) {
      mapView.setHexClassOverlay(null)
      return
    }
    const focus = getCameraFocus()
    const focusTile = hexAt(focus.x, focus.z)
    const half = HEX_CLASS_WINDOW / 2
    if (hexClassOrigin) {
      // Re-window once the focus drifts a quarter window off center; the
      // refill sweeps visibly, which is honest for a debug view.
      const dc = wrapCentered(focusTile.col - hexClassOrigin.col0 - half, HEX_COLUMNS)
      const dr = wrapCentered(focusTile.row - hexClassOrigin.row0 - half, HEX_ROWS)
      if (Math.abs(dc) > half / 2 || Math.abs(dr) > half / 2) resetHexClassWindow()
    }
    if (!hexClassOrigin) {
      hexClassOrigin = {
        col0: ((focusTile.col - half) % HEX_COLUMNS + HEX_COLUMNS) % HEX_COLUMNS,
        row0: ((focusTile.row - half) % HEX_ROWS + HEX_ROWS) % HEX_ROWS,
      }
      hexClassFill = 0
    }
    if (!hexClassData) {
      hexClassData = new Uint8Array(HEX_CLASS_WINDOW * HEX_CLASS_WINDOW * 4)
      hexClassTexture = RawTexture.CreateRGBATexture(hexClassData, HEX_CLASS_WINDOW, HEX_CLASS_WINDOW, scene, false, false, Texture.NEAREST_SAMPLINGMODE)
    }
    const total = HEX_CLASS_WINDOW * HEX_CLASS_WINDOW
    if (hexClassFill < total) {
      const end = Math.min(total, hexClassFill + HEX_CLASS_FILL_BUDGET)
      for (let i = hexClassFill; i < end; i++) {
        const col = (hexClassOrigin.col0 + (i % HEX_CLASS_WINDOW)) % HEX_COLUMNS
        const row = (hexClassOrigin.row0 + Math.floor(i / HEX_CLASS_WINDOW)) % HEX_ROWS
        hexClassData[i * 4] = hexClassEncode(hexClassifier.classify({ col, row }))
        // Green channel = "a river crosses this tile" (phase 3). A separate
        // channel rather than another class value, because a river tile still
        // has a terrain class worth seeing.
        hexClassData[i * 4 + 1] = hexPorts?.has({ col, row }) ? 255 : 0
        hexClassData[i * 4 + 3] = 255
      }
      hexClassFill = end
      hexClassTexture!.update(hexClassData)
    }
    mapView.setHexClassOverlay(hexClassTexture, { col0: hexClassOrigin.col0, row0: hexClassOrigin.row0, cols: HEX_CLASS_WINDOW, rows: HEX_CLASS_WINDOW })
  }

  // Light the hovered 300 m tile through the grid shader. Interaction arms
  // below FULL grid visibility — a threshold on the continuous zoom axis,
  // not a mode (decisions/hex-tiling.md, fork 3). The picked point may lie
  // on any wrap copy; hexAt canonicalizes it, and the shader lights every
  // copy of that tile.
  let hexPointerInside = false
  let lastHexHoverTime = 0
  function updateHexHover(): void {
    if (!mapView) return
    lastHexHoverTime = performance.now()
    if (!hexPointerInside || getCameraAltitude() > HEXGRID_FADE_LOW_ALTITUDE) {
      mapView.setHexHighlight(null)
      debugPanel.setHexTile(null)
      return
    }
    const point = mapView.pickGround(scene.pointerX, scene.pointerY)
    const tile = point ? hexAt(point.x, point.z) : null
    mapView.setHexHighlight(tile ? hexCenter(tile) : null)
    if (!tile) {
      debugPanel.setHexTile(null)
      return
    }
    const cls = hexClassifier?.classify(tile)
    if (!cls) {
      debugPanel.setHexTile(`hex: ${tile.col},${tile.row}`)
      return
    }
    const biomeName = cls.biomeId !== null ? t(biomeLabelKey(cls.biomeId) as TKey) : '—'
    const shorePart = cls.water === 'shore' ? ` ${(cls.landFraction * 100).toFixed(0)}% land` : ''
    // Phase 3 seam data, combined here rather than inside the cached class.
    const rivers = hexPorts?.get(tile)
    let seam = ''
    if (rivers) {
      const ins = rivers.ports.filter((p) => p.direction === 'in')
      const outs = rivers.ports.filter((p) => p.direction === 'out')
      const slots = rivers.ports.reduce((n, p) => n + p.slots.length, 0)
      seam += ` · river ${ins.length}in/${outs.length}out ${slots} slot${slots === 1 ? '' : 's'}`
    }
    if (hexShoreHeight) {
      const shore = hexShoreCrossings(tile, hexShoreHeight, 0)
      if (shore.segments.length > 0) seam += ` · waterline ${shore.segments.length}`
    }
    debugPanel.setHexTile(
      `hex: ${tile.col},${tile.row} · ${Math.round(cls.medianHeightMeters)} m · slope ${(cls.slope * 100).toFixed(0)}% · ${cls.water}${shorePart} · ${biomeName} · grade ${cls.grade.toFixed(2)}${seam}`,
    )

    // FRAME DIAGNOSTIC. Kept from the plate work, because the lesson outlived
    // it: three wrong guesses in a row all shared one symptom — "nothing is
    // there" — and only putting the numbers side by side told them apart.
    // hexGrid reports a tile in its PRINCIPAL copy while the meshes are
    // centred on the origin, so anything that puts a tile into the scene has
    // to be checked against both.
    const principal = hexCenter(tile)
    const focus = getCameraFocus()
    debugPanel.setHexGeometry(
      `pick ${point!.x.toFixed(3)},${point!.z.toFixed(3)} · focus ${focus.x.toFixed(2)},${focus.z.toFixed(2)} · principal ${principal.x.toFixed(3)},${principal.z.toFixed(3)}`,
    )
  }
  const hexHoverObserver = scene.onPointerObservable.add((info) => {
    if (info.type !== PointerEventTypes.POINTERMOVE) return
    hexPointerInside = true
    updateHexHover()
  })
  // The world streams under a RESTING cursor during the descent and while
  // panning — without this, the highlight sticks to the tile picked at the
  // last pointer move and visibly lags the terrain flow. Throttled: the
  // pick against the fine mesh is not free, and 150 ms of lag on a flowing
  // highlight is invisible.
  const hexFrameObserver = scene.onBeforeRenderObservable.add(() => {
    // Ports first: the class overlay's fill reads them for its river flag.
    // Same threshold that arms hex interaction (decisions/hex-tiling.md fork
    // 3) — above it nothing reads ports, so nothing builds them.
    if (getCameraAltitude() <= HEXGRID_FADE_LOW_ALTITUDE) rebuildHexPorts()
    updateHexClassOverlay()
    if (performance.now() - lastHexHoverTime < 150) return
    updateHexHover()
  })
  const onHexPointerLeave = (): void => {
    hexPointerInside = false
    updateHexHover()
  }
  ctx.canvas.addEventListener('pointerleave', onHexPointerLeave)

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
    // A save carries no name of its own beyond its seed (the generator writes
    // `metadata.name = seed`), so the bar shows the seed alone.
    titleBar.setWorld({ seed: inputs.seedText })
    presentWorld(
      inputs.elevations, inputs.width, inputs.height,
      inputs.biome, inputs.detailSeed,
      inputs.biomeInputs, inputs.climate, inputs.lakeDepth,
    )
  }


  function presentWorld(elevations: Float32Array, width: number, height: number, biome: { data: Float32Array; resX: number; resY: number } | null, detailSeed: number, savedBiomeInputs: MapWorldFields['biomeInputs'] = null, climate: { data: Float32Array; resX: number; resY: number } | null = null, lakeDepth: { data: Float32Array; resX: number; resY: number } | null = null): void {
    // A new world supersedes any tier fetch still in flight for the last one.
    loadGeneration++
    hoverTooltip?.dispose()
    riverLayer?.dispose()
    riverLayer = null
    shoreLayer?.dispose()
    shoreLayer = null
    shoreSource = null
    mapView?.dispose()
    mapView = null

    riverSource = null
    currentRaster = { data: elevations, width, height, detailSeed }
    // A new world's channels are not known until its network is re-derived
    // below; until then the fine synthesis runs on cascade detail alone.
    channelField = null
    presentation.setChannelField(null)
    // The stand-in knowledge state, seeded from this world's own terrain.
    knowledge = createKnowledgeField(PAPER_TEXTURE_WIDTH, PAPER_TEXTURE_HEIGHT, detailSeed)
    knowledgeSeedInputs = { elevations, width, height, biome, detailSeed }
    seedKnowledge()
    presentation.setKnowledge(knowledge)
    watercolor.setKnowledge(knowledge.toBytes(KNOWLEDGE_TEXTURE_WIDTH, KNOWLEDGE_TEXTURE_HEIGHT), KNOWLEDGE_TEXTURE_WIDTH, KNOWLEDGE_TEXTURE_HEIGHT)

    // Derived BEFORE the view exists, because the near-detail patch needs two
    // of the surfaces at construction. Both callbacks stash and find no view;
    // the two pushes below hand everything over once there is one.
    presentation.setWorld({ elevations, width, height, biome, detailSeed, biomeInputs: savedBiomeInputs, lakeDepth })
    presentation.setElevation(elevations, width, height, detailSeed)
    debugPanel.setTerrainTier(width, height)
    // Lakes are macro authority (carried, never re-derived) — stash the layer
    // once per load; tier rebuilds reuse it.
    hexLakeDepth = lakeDepth ?? null
    rebuildHexClassifier()

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
        detailSurface: reliefDetailSurface!,
        baseSurface: reliefFineSurface!,
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
        shoreLayer?.recenter(centerX, centerZ)
        syncRibbonLevel()
      },
    })

    // Hand over what the presentation derived above.
    pushPaper()
    pushSurfaces()
    // A loaded world is finished by definition — no erosion gate; deep zoom
    // and the tilt/yaw envelope unlock with the first successful load.
    setCameraDeepZoom(true)

    // The height raster the readout samples — replaced as tiers land. The
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
          const painted = presentation.biomeIdAtUV(cellX / width, cellY / height)
          if (painted !== null) {
            lines.push(t(biomeLabelKey(painted) as TKey))
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

    refreshLakeShorelines()
    void loadTiers(detailSeed)
    void deriveMacroRivers(elevations, width, height, climate)
  }

  // The MACRO tier's rivers, so a freshly loaded world is never river-less
  // while the bake tiers load (or don't exist). Re-derived from the save's own
  // raster + climate through the SAME deriveRivers the bake runs — the save
  // deliberately carries no polylines. Runs on the main thread; the routing
  // yields, and on the 2048 grid the whole derivation is around a second.
  async function deriveMacroRivers(elevations: Float32Array, width: number, height: number, climate: { data: Float32Array; resX: number; resY: number } | null): Promise<void> {
    // No climate, no discharge — the Archean case; the map simply has no rivers.
    if (!climate) return
    const generation = loadGeneration
    // Rivers only: the save already carries its own macro lake layer, so no
    // temperature goes in and no lakes come back.
    const { rivers } = await deriveRivers(elevations, width, height, climate.data, climate.resX, climate.resY)
    if (generation !== loadGeneration) return
    // A bake tier's finer network may have landed while this derived — never
    // replace finer with coarser.
    if (riverSource) return
    applyRivers(rivers.points, rivers.lengths, width, height, 1)
  }

  // River ribbons for the re-derived network. Built on arrival (a world only
  // gets rivers once a bake's hydrology has run) in the AMPLIFIED texel
  // space — that is what extractRiverPolylines emitted, and the overlay's
  // texel→world mapping must agree with it or every river lands at half
  // scale in the wrong place.
  function applyRivers(points: Float32Array, lengths: Uint32Array, fieldWidth: number, fieldHeight: number, factor: number): void {
    riverLayer?.dispose()
    riverLayer = null
    riverSource = { points, lengths, width: fieldWidth, height: fieldHeight, factor }
    // A finer tier's network replaces the one the ports were built from.
    hexPortsCenter = null
    // …and the one the fine synthesis shapes its valleys around. This is the
    // one place a network turns over, so it is the one place the channel field
    // is built (a few hundred ms on the main thread, once per tier, next to
    // the second the macro network's own derivation already takes). It needs
    // the raster the polylines came from, for the water surface at each
    // channel.
    channelField = currentRaster && currentRaster.width === fieldWidth && currentRaster.height === fieldHeight
      ? buildChannelField({ points, lengths, width: fieldWidth, height: fieldHeight }, currentRaster.data)
      : null
    presentation.setChannelField(channelField)
    rebuildHexClassifier()
    if (lengths.length === 0) return
    riverLayer = createToroidalRibbonOverlay({
      scene,
      worldWidth: WORLD_WIDTH,
      worldHeight: WORLD_HEIGHT,
      textureWidth: fieldWidth,
      textureHeight: fieldHeight,
      getViewWidth: getCameraViewWidth,
      // With the near ground. The rivers are draped ON it, and its rendering
      // group clears the depth buffer — a ribbon left in the terrain group
      // would be painted over by the very ground it lies on.
      renderingGroupId: NEAR_RENDERING_GROUP,
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
      // more points, making it lower-frequency. At the source grid's own
      // resolution (the macro tier) the zigzag is invisible and the
      // generator's screen smooths nothing — match it.
      smoothingPasses: factor > 1 ? 2 * factor : 0,
    })
    setRiverPolylines()
    ribbonLevel = 'flat'
    syncRibbonLevel(true)
  }

  // Rivers END at a lake: the extraction deliberately traces one continuous
  // channel through every basin it crosses (hydrology's river → lake → river
  // rule, 2026-08-06 — back then lakes were not rendered and the through-line
  // was the only thing holding a river together across a basin). Now the lake
  // IS drawn, its shoreline is stroked in the same ink (terrainPalette's
  // WATER_LINE_INK), and the submerged 29% of the baked network (measured on
  // an 8K artifact: 65k of 223k points, 2529 of 8612 polylines) is double ink
  // over a water surface — worse, on a filled basin the D8 paths run the
  // FILL's gradient toward the spill, drawing tributaries that visibly bypass
  // the lake they feed. So the DRAWING splits at the shore; the channel mask
  // itself stays whole for riparian biomes, the status rule and the channel
  // field. One wet point is kept at each entry/exit so the line reaches the
  // water instead of stopping a texel short — the sea-mouth rule's sibling.
  function clipRiversAtLakes(points: Float32Array, lengths: Uint32Array, width: number, height: number): { points: Float32Array; lengths: Uint32Array } {
    const lake = hexLakeDepth
    if (!lake) return { points, lengths }
    const wetAt = (x: number, y: number): boolean => {
      const sx = Math.min(lake.resX - 1, Math.max(0, Math.floor((x / width) * lake.resX)))
      const sy = Math.min(lake.resY - 1, Math.max(0, Math.floor((y / height) * lake.resY)))
      if (!(lake.data[sy * lake.resX + sx] > 0)) return false
      // A FROZEN basin is not open water: the river keeps flowing across it
      // — the subglacial reading — and its shore gets no ring either (the
      // presentation's tracer makes the same exception). The painted biome
      // carries the frozen verdict, per-texel rules included.
      return presentation.biomeIdAtUV(x / width, y / height) !== Biome.Glacier
    }
    const outPoints: number[] = []
    const outLengths: number[] = []
    let read = 0
    for (const length of lengths) {
      let run = 0
      for (let n = 0; n < length; n++) {
        const b = (read + n) * 3
        if (wetAt(points[b], points[b + 1])) {
          if (run > 0) {
            // Exit into the water: one wet point, then split.
            outPoints.push(points[b], points[b + 1], points[b + 2])
            outLengths.push(run + 1)
            run = 0
          }
          continue
        }
        if (run === 0 && n > 0) {
          const prev = (read + n - 1) * 3
          if (wetAt(points[prev], points[prev + 1])) {
            // Entry from the water: start the run one wet point early.
            outPoints.push(points[prev], points[prev + 1], points[prev + 2])
            run++
          }
        }
        outPoints.push(points[b], points[b + 1], points[b + 2])
        run++
      }
      if (run >= 2) outLengths.push(run)
      else if (run === 1) outPoints.length -= 3
      read += length
    }
    return { points: new Float32Array(outPoints), lengths: new Uint32Array(outLengths) }
  }

  // The knowledge clip, shared by rivers and shorelines: line work is vector
  // geometry drawn OVER the paper, so unlike the wash it is not dimmed by
  // knowledge — it is simply absent where nobody has been. A polyline
  // crossing the frontier is split rather than dropped, so a river you know
  // the lower half of ends at the edge of what you know instead of vanishing
  // whole.
  function clipByKnowledge(points: Float32Array, lengths: Uint32Array, width: number, height: number): { points: Float32Array; lengths: Uint32Array } {
    const outPoints: number[] = []
    const outLengths: number[] = []
    let run = 0
    let read = 0
    for (const length of lengths) {
      run = 0
      for (let n = 0; n < length; n++, read += 3) {
        const known = presentation.knowledgeAtUV(points[read] / width, points[read + 1] / height)
        if (known >= knowledgeRamp.activeFrom) {
          outPoints.push(points[read], points[read + 1], points[read + 2])
          run++
          continue
        }
        // A run of one is a dot, not a line.
        if (run >= 2) outLengths.push(run)
        else if (run === 1) outPoints.length -= 3
        run = 0
      }
      if (run >= 2) outLengths.push(run)
      else if (run === 1) outPoints.length -= 3
    }
    return { points: new Float32Array(outPoints), lengths: new Uint32Array(outLengths) }
  }

  function setRiverPolylines(): void {
    if (!riverLayer || !riverSource) return
    const lakeClipped = clipRiversAtLakes(riverSource.points, riverSource.lengths, riverSource.width, riverSource.height)
    const clipped = knowledge ? clipByKnowledge(lakeClipped.points, lakeClipped.lengths, riverSource.width, riverSource.height) : lakeClipped
    riverLayer.setPolylines(clipped.points, clipped.lengths)
  }

  function setShorePolylines(): void {
    if (!shoreLayer || !shoreSource) return
    const clipped = knowledge ? clipByKnowledge(shoreSource.points, shoreSource.lengths, shoreSource.width, shoreSource.height) : shoreSource
    shoreLayer.setPolylines(clipped.points, clipped.lengths)
  }

  // Rebuild the shoreline overlay from the presentation's current lakes and
  // painted biomes — called where the lake layer turns over (world load, a
  // tier landing), the shoreline sibling of applyRivers.
  function refreshLakeShorelines(): void {
    shoreLayer?.dispose()
    shoreLayer = null
    shoreSource = presentation.lakeShorelines()
    if (!shoreSource || shoreSource.lengths.length === 0) return
    shoreLayer = createToroidalRibbonOverlay({
      scene,
      worldWidth: WORLD_WIDTH,
      worldHeight: WORLD_HEIGHT,
      textureWidth: shoreSource.width,
      textureHeight: shoreSource.height,
      getViewWidth: getCameraViewWidth,
      renderingGroupId: NEAR_RENDERING_GROUP,
      // Shore rings carry the thinnest pen at every point — the ink budget
      // would cull all of them at far zoom rather than the least of them.
      presenceRule: false,
      // The tracer's lattice staircase is the texture's own grid; two passes
      // melt it the way the amplified rivers' zigzag is melted.
      smoothingPasses: 2,
    })
    setShorePolylines()
    syncRibbonLevel(true)
  }

  // Keep the ribbons draped on whichever relief surface is on screen,
  // swapped only on an actual level change (width follows zoom continuously
  // in the overlay's own shader).
  //
  // In the NEAR regime the ground under the camera is the detail patch —
  // the raster plus the synthetic cascade, up to ~240 m above the raster the
  // fine surface knows, against only ~160 m of drape clearance. Draping on
  // the raster there tunnels rivers under the cascade's bumps, so the near
  // level drapes on the SAME detail sampler the patch displaces by. Away
  // from the patch that overstates the ground — but that is the far field,
  // under the fog.
  function syncRibbonLevel(force = false): void {
    if (!riverLayer && !shoreLayer) return
    const zoom = getCameraZoom()
    const level: typeof ribbonLevel = !reliefCoarseSurface ? 'flat'
      : getCameraNearBlend() > 0.02 && reliefDetailSurface ? 'near'
      : zoom > RELIEF_FINE_ZOOM ? 'fine' : zoom > RELIEF_MIN_ZOOM ? 'coarse' : 'flat'
    if (level === ribbonLevel && !force) return
    ribbonLevel = level
    const surface = level === 'flat' ? null
      : level === 'near' ? reliefDetailSurface
      : level === 'fine' && reliefFineSurface ? reliefFineSurface : reliefCoarseSurface
    riverLayer?.setHeightSurface(surface)
    shoreLayer?.setHeightSurface(surface)
  }

  // Everything an arriving amplified tier changes on screen.
  function applyTier(artifact: { elevation: Float32Array; width: number; height: number; riverPoints: Float32Array; riverLengths: Uint32Array; lakeDepth: Float32Array | null }, factor: number, detailSeed: number): void {
    // Registered, not overwritten: the world gains a tier and the view is
    // re-acquired from it, so what the readout answers with stays a stated
    // property rather than a side effect of whichever tier landed last.
    world?.addAmplifiedElevation(artifact.elevation, artifact.width, artifact.height)
    void world?.acquire('elevation', 'presentation').then((view) => { elevationView = view; hoverTooltip?.refresh() })
    // Lakes BEFORE the elevation, so the repaint setElevation triggers already
    // washes this tier's own basins. An artifact without the layer (a region
    // bake, or one written before it existed) leaves the macro lakes standing
    // — better a coarse lake than none.
    if (artifact.lakeDepth) {
      const lake = { data: artifact.lakeDepth, resX: artifact.width, resY: artifact.height }
      presentation.setLakeDepth(lake)
      hexLakeDepth = lake
    }
    currentRaster = { data: artifact.elevation, width: artifact.width, height: artifact.height, detailSeed }
    presentation.setElevation(artifact.elevation, artifact.width, artifact.height, detailSeed)
    debugPanel.setTerrainTier(artifact.width, artifact.height)
    // Rivers first: they carry this tier's channel field, and the classifier
    // samples the fine surface that field shapes.
    applyRivers(artifact.riverPoints, artifact.riverLengths, artifact.width, artifact.height, factor)
    // After setElevation: the shoreline tracer reads the repainted biomes
    // (the frozen verdict) along with the tier's own lakes.
    refreshLakeShorelines()
    hoverTooltip?.refresh()
  }

  // The amplified tiers this world already HAS — the derived-family ladder
  // (docs/decisions/derived-bake-tiers.md): coarse-first so the map sharpens
  // fast, but with at most ONE terrain-changing swap. When the designated
  // finest bake exists, the coarse step is its own downsampled family
  // member, so the follow-up to full resolution changes RESOLUTION only —
  // the terrain never moves. Only when the family is absent does the
  // independent provisional 4K show, the labelled-sketch state the ladder's
  // one real swap replaces.
  //
  // Read-only on purpose: this screen never bakes and never commissions. Baking
  // is a WORKBENCH capability — the generator has both the in-browser path and
  // the ordering one — and a tier nobody has made yet is the server's business
  // to produce on a read it cannot fulfil (docs/decisions/distributed-bake.md,
  // "Who triggers a bake"). Nothing here falls back to computing one, which is
  // also what keeps the 2.6 GB crash path closed by construction rather than by
  // a stage list.
  //
  // A miss is not an error and gets no message: the coarser tiers stay on
  // screen, and with none of them the save's macro raster is a perfectly
  // usable world. (Factor 1 is that macro raster — nothing to fetch; its
  // rivers come from deriveMacroRivers.)
  async function loadTiers(detailSeed: number): Promise<void> {
    const generation = loadGeneration
    const pipelineVersion = amplificationPipelineVersion()
    const store = await getArtifactStore()
    const familyKey = artifactKey(worldUid, worldId, pipelineVersion, String(AMPLIFY_FINEST_STAGE))
    // The family's coarse member — null also for a pre-family finest
    // artifact, which then behaves like the provisional path below.
    const coarse = await readAmplificationArtifact(store, familyKey, 2).catch(() => null)
    if (generation !== loadGeneration) return
    if (coarse) {
      applyTier(coarse.artifact, 2, detailSeed)
    } else {
      const sketch = await readAmplificationArtifact(store, artifactKey(worldUid, worldId, pipelineVersion, '2')).catch(() => null)
      if (generation !== loadGeneration) return
      if (sketch) applyTier(sketch.artifact, 2, detailSeed)
    }
    const finest = await readAmplificationArtifact(store, familyKey).catch(() => null)
    if (generation !== loadGeneration) return
    if (finest) applyTier(finest.artifact, AMPLIFY_FINEST_STAGE, detailSeed)
  }

  return {
    scene,
    dispose() {
      // Teardown must leave the same state a world SWITCH does, or the two
      // drift: presentWorld bumps the generation and nulls the view, and a tier
      // fetch still in flight is checked against exactly those two things. Left
      // out here, a read that lands after the screen is gone passes both guards
      // — the view is disposed but not null — and goes on to update a disposed
      // texture, hand surfaces to a disposed view, and build a fresh ribbon
      // overlay on a scene that no longer exists.
      loadGeneration++
      if (knowledgeRepaintTimer !== null) clearTimeout(knowledgeRepaintTimer)
      scene.onPointerObservable.remove(brushObserver)
      scene.onPointerObservable.remove(hexHoverObserver)
      scene.onBeforeRenderObservable.remove(hexFrameObserver)
      ctx.canvas.removeEventListener('pointerleave', onHexPointerLeave)
      titleBar.dispose()
      debugPanel.dispose()
      watercolor.dispose()
      riverLayer?.dispose()
      shoreLayer?.dispose()
      scene.onBeforeRenderObservable.remove(skyObserver)
      skyDome.dispose()
      skyMaterial.dispose()
      hoverTooltip?.dispose()
      hexClassTexture?.dispose()
      mapView?.dispose()
      mapView = null // disposed AND cleared, so the guards above mean what they say
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
