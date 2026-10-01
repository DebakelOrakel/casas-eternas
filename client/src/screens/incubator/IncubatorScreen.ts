import { Color4, Scene } from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { createGeneratorCamera } from '../../camera/generatorCamera'
import { MAP_WIDTH, METERS_PER_CELL } from '../../generator/core/mapConfig'
import { elevationToColor } from '../../generator/elevation/elevationColor'
import { createMeshSampler } from '../../generator/mesh/meshSampler'
import { relabel } from '../../i18n/relabel'
import type { ElevationSurface } from '../../map/elevationSurface'
import { createMeshSurface } from '../../map/meshSurface'
import { createScaleBar } from '../../map/ScaleBar'
import { MAP_EXAGGERATION, MAP_WORLD_HEIGHT, MAP_WORLD_WIDTH, RELIEF_FINE_ZOOM, RELIEF_HEIGHT_SCALE, UNITS_PER_METER } from '../../map/mapSceneSettings'
import { createToroidalMapView } from '../../map/ToroidalMapView'
import { listServerArtifacts, type ServerArtifact } from '../../server/artifactsClient'
import { artifactKey } from '../../storage/ArtifactStore'
import { getArtifactStore } from '../../storage/artifactStoreProvider'
import { meshLevelMesh, meshLevelStage, readMeshLevelArtifact } from '../../world/meshArtifacts'
import { isCurrentArtifact } from '../../world/levels'
import { openWorld } from '../../world/query'
import { createHelpTooltip } from '../../ui/help/HelpTooltip'
import { createServerIndicator } from '../../ui/serverIndicator/ServerIndicator'
import { createSidebar } from '../../ui/sidebar/Sidebar'
import { createTitleBar } from '../../ui/titleBar/TitleBar'
import { createWorldChooser } from '../../ui/worldChooser/WorldChooser'
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
// level 1 in 3D, the relief read from the level's mesh, the texture the
// height colours of the generator's terrain (elevationToColor). No water,
// no rivers, no shading of the flat plane yet. Progress and failures go to
// the console, not to the screen.
//
// Two grounds, as a level of detail. Far out, the map view's relief levels:
// fixed grids over the whole world, one vertex per world cell at most
// (7.8 km), too coarse for the level's ~2 km nodes. Close in, the map
// view's NEAR-DETAIL PATCH: a grid of 192 × 192 quads that follows the
// focus and spans the view, so its spacing shrinks with the zoom. Past the
// map view's deepest zoom the camera goes over into perspective (its near
// regime), down to 1 km over the ground, where the patch's quads (~80 m)
// are finer than the level's nodes.

// The level the incubator runs on.
const LEVEL = 1

// The colour texture's size: twice the world raster in each axis, so the
// texture holds more of the level than the save's grid does. Measured on a
// level of 4.3 M nodes (2026-09-30, node): decode 1.7 s, sampler 0.2 s,
// this texture 1.7 s; the world raster's size would take 0.4 s.
const TEXTURE_WIDTH = 4096
const TEXTURE_HEIGHT = 2048

// The map view's deepest zoom, as the fraction of the world's width in
// view: 1 % is ~160 km across. Beyond it the camera's NEAR regime takes
// over: perspective, down to NEAR_MIN_ALTITUDE_M over the ground. The map
// view alone cannot show a relief: it is orthographic, so a tilted view
// has no horizon and no silhouettes — the terrain reads as a squashed
// band however high it stands (seen 2026-09-30, measured heights correct).
const DEEPEST_VIEW_FRACTION = 0.01

// The near regime's lowest camera height over the ground under the focus,
// metres.
const NEAR_MIN_ALTITUDE_M = 1000

// The patch is shown while the view is narrower than a tenth of the
// world: from there on its quads (the view width / 192) are finer than the
// fine relief level's (the world width / 2048).
const PATCH_VIEW_FRACTION = 0.1

// The tilt limit, degrees off vertical (the generator's is 60°).
const MAX_TILT_DEG = 80

// The sun's height for the shadows on the near ground, degrees. A slope
// facing away casts a shadow only where it is steeper than the sun. The
// level is flat: its steepest 1 % of slopes is 2.2 %, 13 % with the map's
// ×6 height (measured 2026-09-30). At 8° (a slope of 14 %) about that 1 %
// casts a shadow, plus the ground in the lee of it. A higher sun casts
// none; a lower one blows out the slopes that face it, because the sun's
// intensity rises as it sinks (see ToroidalMapView's nearShadows).
const SUN_ELEVATION_DEG = 8

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

// The texture of the level: per texel the height at the texel's centre, as
// colour. Texel px shows world x = (px + ½)·width/TEXTURE_WIDTH − ½, the
// convention meshSurface samples the relief with, so the colour sits on its
// relief.
function paintLevel(sampler: ReturnType<typeof createMeshSampler>): Uint8Array {
  const { width, height } = sampler.mesh.domain
  const rgba = new Uint8Array(TEXTURE_WIDTH * TEXTURE_HEIGHT * 4)
  const sx = width / TEXTURE_WIDTH
  const sy = height / TEXTURE_HEIGHT
  for (let y = 0; y < TEXTURE_HEIGHT; y++) {
    const wy = (y + 0.5) * sy - 0.5
    for (let x = 0; x < TEXTURE_WIDTH; x++) {
      const c = elevationToColor(sampler.heightAt((x + 0.5) * sx - 0.5, wy))
      const p = (y * TEXTURE_WIDTH + x) * 4
      rgba[p] = c[0]
      rgba[p + 1] = c[1]
      rgba[p + 2] = c[2]
      rgba[p + 3] = 255
    }
  }
  return rgba
}

export const createIncubatorScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)

  // The level's surface, once one is shown. The view is built before any
  // level is there, so the patch starts on a flat stand-in and is handed the
  // level with setNearDetailSurfaces.
  let levelSurface: ElevationSurface | null = null
  const flat: ElevationSurface = { heightAtUV: () => 0 }

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
    // The drawn ground under the focus, so that the camera keeps its height
    // over the terrain, not over the sea. The map plane is centred on the
    // origin: u = x / width + ½, v = z / height + ½.
    getGroundHeight: () => {
      if (!levelSurface) return 0
      const focus = camera.getFocus()
      const u = (((focus.x / MAP_WORLD_WIDTH + 0.5) % 1) + 1) % 1
      const v = (((focus.z / MAP_WORLD_HEIGHT + 0.5) % 1) + 1) % 1
      return levelSurface.heightAtUV(u, v) * MAP_EXAGGERATION
    },
  })
  // A level is always eroded terrain: the deep zoom and the tilt are open.
  camera.setDeepZoomEnabled(true)

  // Relief at every zoom, unlike the generator, which shows the flat plane
  // far out to save triangles: this screen is for looking at the terrain,
  // and the flat plane has no shading yet.
  //
  // The map view makes the patch 16 × `getAltitude` across. In the map
  // regime it is sized by the view, not by the altitude: the camera is
  // orthographic at a fixed height there, so its altitude does not change
  // with the zoom. In the near regime (zoom above 1) by the altitude, as
  // the patch was made for.
  const mapView = createToroidalMapView({
    scene,
    worldWidth: MAP_WORLD_WIDTH,
    worldHeight: MAP_WORLD_HEIGHT,
    textureWidth: TEXTURE_WIDTH,
    textureHeight: TEXTURE_HEIGHT,
    getFocus: camera.getFocus,
    getYaw: camera.getYaw,
    getSunWorldBlend: camera.getNearBlend,
    reliefDetail: () => (camera.getZoom() > RELIEF_FINE_ZOOM ? 'fine' : 'coarse'),
    nearDetail: {
      // The same surface as detail and as base: the patch has nothing
      // coarser to blend back into at its rim.
      detailSurface: flat,
      baseSurface: flat,
      getActive: () => levelSurface !== null && (camera.getZoom() > 1 || camera.getViewWidth() < MAP_WORLD_WIDTH * PATCH_VIEW_FRACTION),
      getAltitude: () => (camera.getZoom() > 1 ? camera.getAltitude() : camera.getViewWidth() / 16),
    },
    nearShadows: { sunElevationDeg: SUN_ELEVATION_DEG },
  })
  mapView.setHeightScale(MAP_EXAGGERATION)
  mapView.setEnabled(false)

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
    if (!levelSurface) return
    const focus = camera.getFocus()
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
    if (disposed) return false
    const mesh = meshLevelMesh(read.artifact, world.width, world.height)
    step('mesh decoded')
    const sampler = createMeshSampler(mesh, read.artifact.z)
    step('sampler built')
    const rgba = paintLevel(sampler)
    step('texture painted')
    if (disposed) return false
    mapView.texture.update(rgba)
    mapView.reliefTexture.update(rgba)
    const surface = createMeshSurface(sampler, RELIEF_HEIGHT_SCALE)
    levelSurface = surface
    mapView.setReliefSurfaces(surface, surface)
    mapView.setNearDetailSurfaces(surface, surface)
    mapView.setEnabled(true)
    step('shown')
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
      mapView.dispose()
      // scene.dispose() does not remove the camera's own listeners on the
      // shared canvas (see the generator's dispose).
      camera.dispose()
      scene.dispose()
    },
  }
}
