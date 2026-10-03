import { Scene } from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { createGeneratorCamera } from '../../camera/generatorCamera'
import { MAP_WIDTH, METERS_PER_CELL } from '../../generator/core/mapConfig'
import { relabel } from '../../i18n/relabel'
import { createScaleBar } from '../../map/ScaleBar'
import { MAP_WORLD_HEIGHT, MAP_WORLD_WIDTH, UNITS_PER_METER } from '../../map/mapSceneSettings'
import { listServerArtifacts, type ServerArtifact } from '../../server/artifactsClient'
import { fetchWorld } from '../../server/worldClient'
import { artifactKey } from '../../storage/ArtifactStore'
import { getArtifactStore } from '../../storage/artifactStoreProvider'
import { meshLevelStage, readMeshLevelArtifact } from '../../world/meshArtifacts'
import { isCurrentArtifact, parseStage } from '../../world/levels'
import { openWorld, type World } from '../../world/query'
import { createHelpTooltip } from '../../ui/help/HelpTooltip'
import { createServerIndicator } from '../../ui/serverIndicator/ServerIndicator'
import { createSidebar } from '../../ui/sidebar/Sidebar'
import { createTitleBar } from '../../ui/titleBar/TitleBar'
import { createWorldChooser } from '../../ui/worldChooser/WorldChooser'
import { createGroundView } from './groundView'
import type { GridField } from './groundSource'
import '../../ui/theme/design.css'

// THE INCUBATOR: the step between the generator and the game. The generator
// makes a world; the incubator will grow its prehistory — not the geological
// one, the human one: peoples, their spread, what they did before the game
// starts. It replaces the generator's migration step once it can.
//
// It works on a FINISHED world and needs level 1 of it (the world refined on
// the server, the finishing step's job): that is the terrain it will run on.
// So its first step is the generator's world list, which opens only the
// worlds that hold level 1.
//
// For now it is a DEBUG screen, to look at a world: after a choice it shows
// the terrain in 3D as the ground rings (groundView.ts): level 1 far out,
// the tiles of levels 2 and 3 near, painted by surface — the biome's
// cover, rock on the slopes, snow where it is cold, the sea by its depth.
// Progress and failures go to the console, not to the screen.

// The level the incubator runs on.
const LEVEL = 1

// The map view's deepest zoom, as the fraction of the world's width in
// view: 1 % is ~160 km across. Beyond it the camera's NEAR regime takes
// over: perspective, down to NEAR_MIN_ALTITUDE_M over the ground.
const DEEPEST_VIEW_FRACTION = 0.01

// The near regime's lowest camera height over the ground under the focus,
// metres.
const NEAR_MIN_ALTITUDE_M = 1000

// The tilt limit, degrees off vertical (the generator's is 60°).
const MAX_TILT_DEG = 80

// THE TILT BY THE VIEW: flat as a map while the view is wider than
// TILT_FLAT_KM, leaning in as it narrows (a game's oblique view from
// about 50 km on), to TILT_GROUND_DEG at TILT_GROUND_KM and below.
// Linear in the logarithm of the width, so every halving of the view
// leans the same amount.
const TILT_FLAT_KM = 200
const TILT_MID_KM = 20
const TILT_MID_DEG = 50
const TILT_GROUND_KM = 2
const TILT_GROUND_DEG = 68
function tiltForViewWidth(viewWidth: number): number {
  const km = viewWidth / UNITS_PER_METER / 1000
  const l = Math.log10(Math.max(TILT_GROUND_KM, Math.min(TILT_FLAT_KM, km)))
  const flat = Math.log10(TILT_FLAT_KM)
  const mid = Math.log10(TILT_MID_KM)
  const ground = Math.log10(TILT_GROUND_KM)
  const deg = l >= mid ? ((flat - l) / (flat - mid)) * TILT_MID_DEG : TILT_MID_DEG + ((mid - l) / (mid - ground)) * (TILT_GROUND_DEG - TILT_MID_DEG)
  return (deg * Math.PI) / 180
}

// The view width (world units) under which the nearest rings cast
// shadows: ~190 km, where a mountain's shadow is pixels wide.
const SHADOWS_BELOW_VIEW_WIDTH = 190_000 * UNITS_PER_METER

// The server's current level-1 artifacts, by world uid. Any revision of a
// world counts: the world list does not say which terrain a world holds now,
// so the level can belong to an older one. Not in world/meshArtifacts
// beside meshPipelineVersion, because the job worker bundles that module and
// must not carry the server client.
async function levelArtifacts(): Promise<Map<string, ServerArtifact[]>> {
  const listed = await listServerArtifacts()
  const stage = meshLevelStage(LEVEL)
  const byWorld = new Map<string, ServerArtifact[]>()
  for (const a of listed?.artifacts ?? []) {
    if (a.stage !== stage || !isCurrentArtifact(a) || a.worldUid === '') continue
    const list = byWorld.get(a.worldUid) ?? []
    list.push(a)
    byWorld.set(a.worldUid, list)
  }
  return byWorld
}

// A save's field as the painter's grid, or null when the save lacks it.
async function gridField(world: World, name: string): Promise<GridField | null> {
  const view = await world.acquire(name)
  return view ? { data: view.data, resX: view.resX, resY: view.resY } : null
}

export const createIncubatorScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  const query = new URLSearchParams(window.location.search)

  let ground: ReturnType<typeof createGroundView> | null = null
  let shown = false

  const camera = createGeneratorCamera({
    scene,
    canvas: ctx.canvas,
    engine: ctx.engine,
    worldWidth: MAP_WORLD_WIDTH,
    worldHeight: MAP_WORLD_HEIGHT,
    deepMaxZoomWorldFraction: DEEPEST_VIEW_FRACTION,
    // Steeper than the generator's 60°, and open from further out: in the
    // orthographic map view a steep tilt is the only way to see heights.
    maxTiltDeg: MAX_TILT_DEG,
    tiltStartZoom: 0.1,
    nearModeEnabled: true,
    nearMinAltitude: NEAR_MIN_ALTITUDE_M * UNITS_PER_METER,
    autoTilt: tiltForViewWidth,
    // The drawn ground under the focus, so that the camera keeps its height
    // over the terrain, not over the sea; and under the camera itself,
    // which it never sinks below.
    getGroundHeight: () => {
      const focus = camera.getFocus()
      return ground?.drawnHeightAt(focus.x, focus.z) ?? 0
    },
    getGroundHeightAt: (x, z) => ground?.drawnHeightAt(x, z) ?? 0,
  })
  // A level is always eroded terrain: the deep zoom and the tilt are open.
  camera.setDeepZoomEnabled(true)

  const root = document.createElement('div')
  root.className = 'incubator-screen'

  // Sign-in for the title bar's account chip, as on the other screens.
  const serverIndicator = createServerIndicator(root)

  const titleBar = createTitleBar(root, {
    nameKey: 'common.title.nav.incubator',
    onSignIn: () => serverIndicator.openSignIn(),
    // Nothing here is lost by leaving: the world stays where it is kept.
    onHomeClick: () => ctx.goTo('title'),
    onLocaleChange: () => {
      sidebar.relabel()
      relabel(sidebar.body)
      worldChooser.relabel()
    },
  })
  titleBar.setWorld(null)

  // The scale bar at the lower right, as in the generator. Measured every
  // frame; it does nothing while the view has not changed.
  const scaleBar = createScaleBar(root, { scene, worldWidth: MAP_WORLD_WIDTH, worldHeight: MAP_WORLD_HEIGHT, metresPerWorldUnit: (METERS_PER_CELL * MAP_WIDTH) / MAP_WORLD_WIDTH })
  scaleBar.element.hidden = true
  scene.onBeforeRenderObservable.add(() => {
    if (!shown || !ground) return
    const focus = camera.getFocus()
    const viewWidth = camera.getViewWidth()
    // WHERE THE RINGS CENTRE. On the map the focus: the pixel is the same
    // size everywhere. Tilted, the nearest ground is at the frame's
    // bottom and its pixels the smallest, so the finest ring belongs
    // there and the coarser ones toward the horizon, not around the
    // frame's centre (2026-10-03). The centre slides from the focus to
    // the nearest ground in view (the frustum's lower edge on the ground)
    // as the tilt opens past half the field of view — below that the
    // frame's near edge is under the camera anyway. Pixels per world
    // unit there, for the innermost ring's choice, scale with the
    // distance to the eye.
    let centreX = focus.x
    let centreZ = focus.z
    let unitsPerPixel = viewWidth / ctx.engine.getRenderWidth()
    if (camera.getZoom() > 1) {
      const tilt = camera.getTilt()
      const halfFov = camera.camera.fov / 2
      const w = Math.min(1, Math.max(0, (tilt - halfFov) / halfFov))
      if (w > 0) {
        const altitude = camera.getAltitude()
        const yaw = camera.getYaw()
        const upX = Math.sin(yaw)
        const upZ = Math.cos(yaw)
        // Ground distances from the eye's foot: the focus, the near edge.
        const toFocus = altitude * Math.tan(tilt)
        const toNear = altitude * Math.tan(Math.max(0, tilt - halfFov))
        const back = (toFocus - toNear) * w
        centreX = focus.x - upX * back
        centreZ = focus.z - upZ * back
        const eyeDistanceFocus = Math.hypot(altitude, toFocus)
        const eyeDistanceCentre = Math.hypot(altitude, toFocus - back)
        unitsPerPixel *= eyeDistanceCentre / eyeDistanceFocus
      }
    }
    debug.view = { centreX, centreZ, unitsPerPixel, viewWidth, tilt: camera.getTilt(), altitude: camera.getAltitude(), zoom: camera.getZoom(), focus }
    ground.update(centreX, centreZ, unitsPerPixel, viewWidth < SHADOWS_BELOW_VIEW_WIDTH && query.get('shadows') !== '0', {
      altitude: camera.getZoom() > 1 ? camera.getAltitude() : 0,
      eye: camera.camera.position,
      farPlane: camera.camera.maxZ,
    })
    scaleBar.update(`${focus.x.toFixed(3)},${focus.z.toFixed(3)},${camera.getZoom().toFixed(4)},${camera.getYaw().toFixed(3)},${window.innerWidth},${window.innerHeight}`)
  })

  const sidebar = createSidebar(root, 'incubator.step')
  sidebar.setStep('world')

  // What the chooser's last reload found, for the open that follows it.
  let levels = new Map<string, ServerArtifact[]>()
  // Set on dispose, so a level that arrives after leaving is dropped.
  let disposed = false

  // Read the world's level 1 and show it. The level of the save's own
  // terrain when the server holds it, else any level of the world.
  async function showLevel(archive: Blob, uid: string): Promise<boolean> {
    const started = performance.now()
    const step = (what: string): void => console.info(`[incubator] ${what} ${Math.round(performance.now() - started)} ms`)
    const world = await openWorld(new Uint8Array(await archive.arrayBuffer()))
    if (!world) {
      console.warn('[incubator] the archive is not a world')
      return false
    }
    const worldId = await world.worldId()
    const candidates = levels.get(uid) ?? []
    const chosen = candidates.find((a) => a.worldId === worldId) ?? candidates[0]
    if (!chosen) {
      console.warn(`[incubator] world ${uid} holds no level ${LEVEL}`)
      return false
    }
    if (chosen.worldId !== worldId) console.warn(`[incubator] level ${LEVEL} of an older terrain (${chosen.worldId}, the save is ${worldId})`)
    step('save read')
    const store = await getArtifactStore()
    const read = await readMeshLevelArtifact(store, artifactKey(uid, chosen.worldId, chosen.pipelineVersion, chosen.stage))
    if (!read) {
      console.warn(`[incubator] level ${LEVEL} of ${uid} could not be read`)
      return false
    }
    step(`level read, ${read.artifact.count} nodes`)
    // The tiles of levels 2 and 3 the server holds for this terrain.
    const versions = new Map<string, string>()
    for (const a of (await listServerArtifacts())?.artifacts ?? []) {
      if (a.worldUid === uid && a.worldId === chosen.worldId && parseStage(a.stage)?.tile) versions.set(a.stage, a.pipelineVersion)
    }
    step(`${versions.size} tiles listed`)
    // The save's climate fields; the terrain and the water the ground
    // makes from the level itself (groundWorker.ts, waterLevels.ts), the
    // save's elevation standing in until then.
    const fields = {
      biome: await gridField(world, 'biome'),
      elevation: await gridField(world, 'elevation'),
      temperature: await gridField(world, 'temperature'),
      precipitation: await gridField(world, 'precipitationEffective'),
      lakeDepth: await gridField(world, 'lakeDepth'),
      waterLevel: null,
      waterFloor: null,
      waterDam: null,
      waterSurface: null,
    }
    if (disposed) return false
    if (!ground) ground = createGroundView({ scene, store })
    if (query.get('rings') === '1') ground.setTinted(true)
    if (query.get('detail')) ground.setDetailStrength(Number(query.get('detail')))
    ground.onLevels((levels) => {
      debug.water = levels
      debug.elevation = levels.elevation
    })
    await ground.setWorld({ worldUid: uid, worldId: chosen.worldId, width: world.width, height: world.height, level: read.artifact, versions, fields })
    step('ground ready')
    if (disposed) return false
    shown = true
    scaleBar.element.hidden = false
    return true
  }

  const worldChooser = createWorldChooser(root, {
    titleKey: 'incubator.load.title',
    subtitleKey: 'incubator.load.subtitle',
    // The generator's says "loads this world into the generator"; the
    // incubator has no line of its own yet (a debug screen, no new keys).
    cardHelpKey: null,
    // A browser world never holds a level: the levels are server jobs.
    openable: {
      load: async () => {
        levels = await levelArtifacts()
        return (where, uid) => where === 'server' && levels.has(uid)
      },
      reasonKey: 'incubator.load.noLevel',
    },
    // The list stays up while the level loads (seconds), and stays up if it
    // fails; the console says why.
    onOpenArchive: (archive, kept) => {
      void (async () => {
        if (!(await showLevel(archive, kept.uid))) return
        titleBar.setWorld({ name: kept.name || undefined, seed: kept.seed })
        titleBar.setSaveState({ kind: kept.where === 'server' ? 'server' : 'local', at: new Date(kept.savedAt) })
        worldChooser.close()
        sidebar.setVisible(true)
      })()
    },
  })

  // The list first, the column behind it — as the generator opens.
  sidebar.setVisible(false)
  worldChooser.open()

  // DEBUG: `?screen=incubator&world=<uid>&view=x,z,zoom[,yaw,tilt]` opens a
  // server world and puts the camera at a view, so a screenshot ladder
  // shows the same places every time. `data-ready` on the root says the
  // level is shown. Not a user surface: no text, no keys.
  const debug: { errors: string[]; ground: () => unknown; scene: Scene; shaders?: () => string[]; view?: unknown; water?: unknown; elevation?: Float32Array | null } = { errors: [], ground: () => ground?.stats() ?? null, scene }
  ;(window as unknown as { __incubator?: unknown }).__incubator = debug
  window.addEventListener('error', (e) => debug.errors.push(String(e.message)))
  window.addEventListener('unhandledrejection', (e) => debug.errors.push(String(e.reason)))
  // Babylon reports a shader that fails to compile on the console only.
  const consoleError = console.error.bind(console)
  console.error = (...args: unknown[]): void => {
    debug.errors.push(args.map(String).join(' ').slice(0, 300))
    consoleError(...args)
  }
  // Safari reports a shader that fails to compile as a stack trace with no
  // message, and Babylon keeps drawing with the previous effect; the
  // ladder then shows the old look with no error (2026-10-03). So the
  // effects are checked: a material not ready for seconds is listed.
  debug.shaders = () => {
    const out: string[] = []
    for (const mesh of scene.meshes) {
      if (!mesh.material || !mesh.isEnabled()) continue
      const effect = mesh.subMeshes?.[0]?._drawWrapper?.effect
      if (effect && !effect.isReady()) out.push(`${mesh.name}: effect not ready (${String(effect.getCompilationError?.() ?? '').slice(0, 80)})`)
    }
    return out
  }
  const worldParam = query.get('world')
  const viewParam = query.get('view')
  if (worldParam) {
    void (async () => {
      levels = await levelArtifacts()
      const archive = await fetchWorld(worldParam)
      if (!archive || disposed) return
      if (!(await showLevel(archive, worldParam))) return
      worldChooser.close()
      sidebar.setVisible(true)
      root.dataset.ready = '1'
    })()
  }
  if (viewParam) {
    const [x, z, zoom, yaw, tilt] = viewParam.split(',').map(Number)
    if ([x, z, zoom].every(Number.isFinite)) {
      camera.setView({ x, z, zoom, yaw: Number.isFinite(yaw) ? yaw : undefined, tilt: Number.isFinite(tilt) ? (tilt * Math.PI) / 180 : undefined })
    }
  }

  ctx.overlay.appendChild(root)

  const helpTooltip = createHelpTooltip(root)

  return {
    scene,
    dispose() {
      disposed = true
      worldChooser.dispose()
      sidebar.dispose()
      titleBar.dispose()
      helpTooltip.dispose()
      serverIndicator.dispose()
      ground?.dispose()
      // scene.dispose() does not remove the camera's own listeners on the
      // shared canvas (see the generator's dispose).
      camera.dispose()
      scene.dispose()
    },
  }
}
