import { Color4, FreeCamera, Scene, Vector3 } from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { domainOfKind } from '../../generator/core/domain'
import { loadWasmEngine } from '../../generator/pipeline/engineWasm'
import { relabel } from '../../i18n/relabel'
import { createFlatWorldView } from '../../map/flatWorldView'
import { createScaleBar } from '../../map/ScaleBar'
import { createGlobeWorldView } from '../../map/sphereView'
import type { WorldView } from '../../map/worldView'
import { listServerArtifacts, type ServerArtifact } from '../../server/artifactsClient'
import { fetchWorld, listWorlds } from '../../server/worldClient'
import { peekServerStatus } from '../../server/serverStatus'
import { artifactKey } from '../../storage/ArtifactStore'
import { getArtifactStore } from '../../storage/artifactStoreProvider'
import { meshLevelStage, readMeshLevelArtifact } from '../../world/meshArtifacts'
import { isCurrentArtifact } from '../../world/levels'
import { sameWorldsPipeline } from '../../world/worldPipeline'
import { openWorld } from '../../world/query'
import { createHelpTooltip } from '../../ui/help/HelpTooltip'
import { createServerIndicator } from '../../ui/serverIndicator/ServerIndicator'
import { createSidebar } from '../../ui/sidebar/Sidebar'
import { createTitleBar } from '../../ui/titleBar/TitleBar'
import { createWorldChooser, type OpenedCopy } from '../../ui/worldChooser/WorldChooser'
import { createLoadPanel } from '../../ui/loadPanel/LoadPanel'
import { formatBytes } from '../../ui/format'
import { ARTIFACTS_ICON, createArtifactChooser, reportCommission } from '../../ui/artifactChooser/ArtifactChooser'
import { createJobChooser, JOBS_ICON } from '../../ui/jobChooser/JobChooser'
import { BOOK_ICON, createHandbookPanel } from '../../ui/handbook/HandbookPanel'
import type { ChartWorkerInbound, ChartWorkerOutbound } from './chartWorker'
import type { RegionWorkerInbound, RegionWorkerOutbound } from './regionWorker'
import type { SpeciesLayer, SpeciesWorkerInbound, SpeciesWorkerOutbound } from './speciesWorker'
import type { World } from '../../world/query'
import { SPECIES } from './species'
import '../../ui/theme/design.css'
// The generator's layer switches, for the trial's switch.
import '../generator/overlayList.css'

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
// For now it is a DEBUG screen, to look at a world. Since 2026-10-23 it
// shows the world as the generator does — the whole globe on the white
// page with its atmosphere, or the flat map of a torus (map/worldView.ts)
// — with level 1's terrain in place of the save's: the paper, the
// hillshade, the terrain wash and the lakes painted from the level at its
// own resolution (chartWorker.ts), the level's rivers over them. The zoom
// stops where a node of the level is about two pixels. (The ground rings
// with the tiles of levels 2 and 3, groundView.ts and its kin, are not
// used now; they stay for later.) The load panel shows the steps of an
// open and which one failed; why it failed goes to the console.

// The level the incubator runs on.
const LEVEL = 1

// The chart the level is painted on, texels: 2.4 km a texel at the
// sphere's equator, 2 km on the torus — a level-1 node (LEVEL_NODE_SPACING_M)
// per texel or so. Two such RGBA textures are 128 MB each.
const CHART_WIDTH = 8192
const CHART_HEIGHT = 4096

// The level's typical node spacing on land, metres (map/groundPaint.ts
// NODE_SPACING_M), and how many pixels it may span at the deepest zoom.
const LEVEL_NODE_SPACING_M = 2200
const PIXELS_PER_NODE = 2
// On the flat map the camera's own limit without the deep zoom (10 % of
// the world's width in view, generatorCamera) is that already: 1 600 km
// over a canvas 1 500 px wide, 1.07 km a pixel.

// The server's level-1 artifacts, by world uid: current for this client,
// or made by the pipeline that made the world (a world of another pipeline
// is refined by that pipeline; its level 1's version is the pipeline's
// name, worldPipeline.ts). An artifact is keyed by its terrain (DEC-0039),
// and each server world names the terrains its jobs found or baked
// (WorldSummary.terrains). Any of them counts: the level can belong to an
// older terrain of the world. Not in world/meshArtifacts beside
// meshPipelineVersion, because the job worker bundles that module and must
// not carry the server client.
async function levelArtifacts(): Promise<Map<string, ServerArtifact[]>> {
  const [listed, worlds] = await Promise.all([listServerArtifacts(), listWorlds()])
  const stage = meshLevelStage(LEVEL)
  const byTerrain = new Map<string, ServerArtifact[]>()
  for (const a of listed?.artifacts ?? []) {
    if (a.stage !== stage || a.worldId === '') continue
    byTerrain.set(a.worldId, [...(byTerrain.get(a.worldId) ?? []), a])
  }
  const byWorld = new Map<string, ServerArtifact[]>()
  for (const world of worlds ?? []) {
    const pipeline = sameWorldsPipeline(world.pipeline ?? '')
    const list = (world.terrains ?? []).flatMap((terrain) => byTerrain.get(terrain) ?? [])
      .filter((a) => isCurrentArtifact(a) || (pipeline !== '' && a.pipelineVersion === pipeline))
    if (list.length > 0) byWorld.set(world.uid, list)
  }
  return byWorld
}

// Level 1 painted on the chart, in the chart worker.
function paintChart(input: ChartWorkerInbound): Promise<(ChartWorkerOutbound & { type: 'painted' }) | null> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./chartWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<ChartWorkerOutbound>): void => {
      worker.terminate()
      if (event.data.type === 'failed') {
        console.warn(`[incubator] the chart could not be painted: ${event.data.message}`)
        resolve(null)
        return
      }
      resolve(event.data)
    }
    worker.onerror = (event): void => {
      worker.terminate()
      console.warn(`[incubator] the chart worker failed: ${event.message}`)
      resolve(null)
    }
    worker.postMessage(input)
  })
}

// Level 1's catchments as a layer over the chart, in the region worker.
function cutRegions(input: RegionWorkerInbound): Promise<(RegionWorkerOutbound & { type: 'regions' }) | null> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./regionWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<RegionWorkerOutbound>): void => {
      worker.terminate()
      if (event.data.type === 'failed') {
        console.warn(`[incubator] the regions could not be cut: ${event.data.message}`)
        resolve(null)
        return
      }
      resolve(event.data)
    }
    worker.onerror = (event): void => {
      worker.terminate()
      console.warn(`[incubator] the region worker failed: ${event.message}`)
      resolve(null)
    }
    worker.postMessage(input)
  })
}

// The region layer blended over a painted chart, into a copy.
function blendOver(base: Uint8ClampedArray, overlay: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(base)
  for (let i = 0; i < out.length; i += 4) {
    const a = overlay[i + 3] / 255
    if (a === 0) continue
    for (let c = 0; c < 3; c++) out[i + c] = out[i + c] * (1 - a) + overlay[i + c] * a
  }
  return out
}

// Where the species live, in the species worker.
function distributeSpecies(input: SpeciesWorkerInbound): Promise<(SpeciesWorkerOutbound & { type: 'species' }) | null> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./speciesWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<SpeciesWorkerOutbound>): void => {
      worker.terminate()
      if (event.data.type === 'failed') {
        console.warn(`[incubator] the species could not be distributed: ${event.data.message}`)
        resolve(null)
        return
      }
      resolve(event.data)
    }
    worker.onerror = (event): void => {
      worker.terminate()
      console.warn(`[incubator] the species worker failed: ${event.message}`)
      resolve(null)
    }
    worker.postMessage(input)
  })
}

// A species' colour by its role.
const ROLE_COLOURS: Record<SpeciesLayer['role'], readonly [number, number, number]> = {
  herbivore: [170, 60, 20],
  predator: [120, 30, 140],
  fish: [20, 80, 200],
  plant: [20, 120, 30],
}

// A species layer over a painted chart, into a copy: its density in its
// role's colour, the empty niche grey, its origins as rings. The layer is
// on the world raster, the chart `scale` times finer; a texel reads its
// cell.
function blendSpecies(base: Uint8ClampedArray, layer: SpeciesLayer, width: number, height: number, scale: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(base)
  const W = width * scale
  const H = height * scale
  const [r, g, b] = ROLE_COLOURS[layer.role]
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / scale) * width
    for (let x = 0; x < W; x++) {
      const code = layer.codes[row + Math.floor(x / scale)]
      if (code === 0) continue
      const i = 4 * (y * W + x)
      const a = code === 1 ? 0.45 : 0.25 + 0.65 * ((code - 2) / 253)
      const [cr, cg, cb] = code === 1 ? [120, 120, 120] : [r, g, b]
      out[i] = out[i] * (1 - a) + cr * a
      out[i + 1] = out[i + 1] * (1 - a) + cg * a
      out[i + 2] = out[i + 2] * (1 - a) + cb * a
    }
  }
  const radius = 6 * scale
  for (const o of layer.origins) {
    const cx = (o.x + 0.5) * scale
    const cy = (o.y + 0.5) * scale
    for (let dy = -radius - 2; dy <= radius + 2; dy++) {
      for (let dx = -radius - 2; dx <= radius + 2; dx++) {
        const d = Math.hypot(dx, dy)
        if (d < radius - scale || d > radius + scale) continue
        const x = (((Math.round(cx + dx) % W) + W) % W)
        const y = Math.round(cy + dy)
        if (y < 0 || y >= H) continue
        const i = 4 * (y * W + x)
        out[i] = 20
        out[i + 1] = 20
        out[i + 2] = 20
      }
    }
  }
  return out
}

// The smallest catchment that makes a region of its own, km², the
// choices of the trial control.
const REGION_MIN_AREAS_KM2 = [100, 300, 1000, 3000]

export const createIncubatorScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  // THE SCENES. Before a world is shown, an empty white page; then the
  // world's view, made for its shape and dropped with it.
  const idleScene = new Scene(ctx.engine)
  idleScene.clearColor = new Color4(1, 1, 1, 1)
  new FreeCamera('incubatorIdle', new Vector3(0, 1, 0), idleScene)
  let view: WorldView | null = null

  const root = document.createElement('div')
  root.className = 'incubator-screen'

  // Sign-in for the title bar's account chip, as on the other screens.
  const serverIndicator = createServerIndicator(root)

  const titleBar = createTitleBar(root, {
    nameKey: 'common.title.nav.incubator',
    onSignIn: () => serverIndicator.openSignIn(),
    notifications: ctx.notifications,
    // Nothing here is lost by leaving: the world stays where it is kept.
    onHomeClick: () => ctx.goTo('title'),
    // The same entries on every screen, the world list included.
    menuItems: [
      { key: 'titlebar.handbook', icon: BOOK_ICON, onSelect: () => handbookPanel.open() },
      { key: 'titlebar.jobs', icon: JOBS_ICON, onSelect: () => openWindow(jobChooser) },
      { key: 'common.action.storage', icon: ARTIFACTS_ICON, onSelect: () => openWindow(artifactChooser) },
    ],
    onLocaleChange: () => {
      sidebar.relabel()
      relabel(sidebar.body)
      worldChooser.relabel()
      artifactChooser.relabel()
      jobChooser.relabel()
      handbookPanel.relabel()
      loadPanel.relabel()
    },
  })
  titleBar.setWorld(null)

  // The scale bar at the lower right, as in the generator: measured on the
  // view's reference surface, at the screen's centre on the globe.
  const scaleBar = createScaleBar(root, {
    measure: (ax, ay, bx, by) => {
      if (!view) return null
      const a = view.chartAt(ax, ay)
      const b = view.chartAt(bx, by)
      return a && b ? view.metresBetween(a, b) : null
    },
    at: () => (view?.shape === 'sphere' ? { x: ctx.canvas.clientWidth / 2, y: ctx.canvas.clientHeight / 2 } : null),
  })
  scaleBar.element.hidden = true
  const renderScaleBar = (): void => {
    if (view) scaleBar.update(`${view.viewKey()},${window.innerWidth},${window.innerHeight}`)
  }

  const sidebar = createSidebar(root, 'incubator.step')
  sidebar.setStep('world')

  // TRIAL (2026-10-23): the catchments over the chart, on a switch in the
  // column. Hardcoded text, no catalog keys: we are trying it out.
  // The world shown, kept for the layers drawn over it.
  let shown: {
    kind: 'sphere' | 'torus'
    width: number
    height: number
    worldAreaM2: number
    level: RegionWorkerInbound['level']
    shaded: Uint8ClampedArray
    unshaded: Uint8ClampedArray
  } | null = null
  // The last blend, for its threshold.
  let regionBlend: { minAreaKm2: number; shaded: Uint8ClampedArray; unshaded: Uint8ClampedArray } | null = null
  const regionRow = document.createElement('label')
  regionRow.className = 'gen-overlay'
  const regionName = document.createElement('span')
  regionName.className = 'gen-overlay__label'
  regionName.textContent = 'Einzugsgebiete'
  const regionBox = document.createElement('input')
  regionBox.type = 'checkbox'
  regionBox.className = 'gen-overlay__switch'
  regionRow.append(regionName, regionBox)
  const regionSize = document.createElement('select')
  for (const km2 of REGION_MIN_AREAS_KM2) {
    const option = document.createElement('option')
    option.value = String(km2)
    option.textContent = `ab ${km2} km²`
    regionSize.append(option)
  }
  regionSize.value = '300'
  const regionStatus = document.createElement('p')
  const regionSection = document.createElement('section')
  regionSection.className = 'gen-overlays'
  regionSection.append(regionRow, regionSize, regionStatus)
  sidebar.body.append(regionSection)
  // Each change asks again; an answer to an older ask is dropped.
  let regionAsk = 0
  async function showRegions(): Promise<void> {
    const ask = ++regionAsk
    if (!shown || !view) return
    const on = regionBox.checked
    const minAreaKm2 = Number(regionSize.value)
    if (on && regionBlend?.minAreaKm2 !== minAreaKm2) {
      regionStatus.textContent = 'rechnet …'
      const cut = await cutRegions({ kind: shown.kind, width: shown.width, height: shown.height, chartWidth: CHART_WIDTH, chartHeight: CHART_HEIGHT, level: shown.level, worldAreaM2: shown.worldAreaM2, minAreaKm2 })
      if (ask !== regionAsk || !shown) return
      if (!cut) {
        regionStatus.textContent = 'fehlgeschlagen (Konsole)'
        return
      }
      console.info(`[incubator] regions cut (${Object.entries(cut.ms).map(([k, v]) => `${k} ${v}`).join(', ')})`)
      const areas = Float64Array.from(cut.areas).sort()
      const median = areas.length > 0 ? areas[Math.floor(areas.length / 2)] : 0
      regionStatus.textContent = `${areas.length.toLocaleString()} Gebiete, Median ${Math.round(median)} km²`
      regionBlend = { minAreaKm2, shaded: blendOver(shown.shaded, cut.overlay), unshaded: blendOver(shown.unshaded, cut.overlay) }
    }
    refreshTextures()
  }
  regionBox.addEventListener('change', () => void showRegions())
  regionSize.addEventListener('change', () => void showRegions())

  // TRIAL (2026-10-23): where the species of species.ts live, one at a
  // time over the chart (and over the catchments, when they are on).
  let shownWorld: World | null = null
  let speciesLayers: SpeciesLayer[] | null = null
  const speciesPick = document.createElement('select')
  const speciesStatus = document.createElement('p')
  const speciesTitle = document.createElement('span')
  speciesTitle.className = 'gen-overlay__label'
  speciesTitle.textContent = 'Art'
  const speciesSection = document.createElement('section')
  speciesSection.className = 'gen-overlays'
  speciesSection.append(speciesTitle, speciesPick, speciesStatus)
  sidebar.body.append(speciesSection)
  const ROLE_NAMES: Record<SpeciesLayer['role'], string> = { herbivore: 'Pflanzenfresser', predator: 'Räuber', fish: 'Fische', plant: 'Pflanzen' }
  function fillSpeciesPick(): void {
    const none = document.createElement('option')
    none.value = ''
    none.textContent = speciesLayers ? '(keine)' : '(keine; die erste Wahl rechnet)'
    const groups = (Object.keys(ROLE_NAMES) as SpeciesLayer['role'][]).map((role) => {
      const group = document.createElement('optgroup')
      group.label = ROLE_NAMES[role]
      return { role, group }
    })
    const value = speciesPick.value
    speciesPick.replaceChildren(none, ...groups.map((g) => g.group))
    for (const spec of SPECIES) {
      const option = document.createElement('option')
      option.value = spec.id
      option.textContent = spec.name
      groups.find((g) => g.role === spec.role)!.group.append(option)
    }
    speciesPick.value = value
  }
  fillSpeciesPick()
  let speciesAsk = 0
  async function showSpecies(): Promise<void> {
    const ask = ++speciesAsk
    if (!shown || !shownWorld) return
    if (speciesPick.value !== '' && !speciesLayers) {
      speciesStatus.textContent = 'rechnet …'
      const world = shownWorld
      const [elevation, biome, discharge, temperature, precipitation, seasonalAmplitude] = await Promise.all(
        ['elevation', 'biome', 'discharge', 'temperature', 'precipitation', 'seasonalAmplitude'].map((name) => world.acquire(name)))
      if (!elevation || !biome || !discharge || !temperature || !precipitation || !seasonalAmplitude) {
        speciesStatus.textContent = 'der Welt fehlen Felder (Konsole)'
        console.warn('[incubator] the species need elevation, biome, discharge and the climate')
        return
      }
      const domain = domainOfKind(shown.kind, shown.width, shown.height)
      const done = await distributeSpecies({
        kind: shown.kind,
        width: shown.width,
        height: shown.height,
        cellMetres: shown.kind === 'sphere' ? domain.metresAround / shown.width : domain.metresPerUnit,
        elevation: elevation.data,
        biome: biome.data,
        discharge: discharge.data,
        climate: { resX: temperature.resX, resY: temperature.resY, temperature: temperature.data, precipitation: precipitation.data, seasonalAmplitude: seasonalAmplitude.data },
        seed: world.recipe.detailSeed,
      })
      if (ask !== speciesAsk || shownWorld !== world) return
      if (!done) {
        speciesStatus.textContent = 'fehlgeschlagen (Konsole)'
        return
      }
      console.info(`[incubator] species distributed, ${done.ms} ms`)
      speciesLayers = done.layers
      fillSpeciesPick()
    }
    const layer = speciesLayers?.find((l) => l.id === speciesPick.value)
    const pct = (v: number): string => `${(100 * v).toFixed(1)} %`
    speciesStatus.textContent = layer
      ? `Nische ${pct(layer.suitable)} des Landes, davon erreicht ${pct(layer.reached)}, leer (grau) ${pct(layer.empty)}. Ringe: Ursprünge.`
      : ''
    refreshTextures()
  }
  speciesPick.addEventListener('change', () => void showSpecies())

  // The chart with what is switched on over it: the catchments, then the
  // species.
  function refreshTextures(): void {
    if (!shown || !view) return
    const regions = regionBox.checked && regionBlend
    let shaded = regions ? regionBlend!.shaded : shown.shaded
    let unshaded = regions ? regionBlend!.unshaded : shown.unshaded
    const layer = speciesLayers?.find((l) => l.id === speciesPick.value)
    if (layer) {
      const scale = CHART_WIDTH / shown.width
      shaded = blendSpecies(shaded, layer, shown.width, shown.height, scale)
      if (view.shape !== 'sphere') unshaded = blendSpecies(unshaded, layer, shown.width, shown.height, scale)
    }
    if (view.shape === 'sphere') view.reliefTexture.update(shaded)
    else {
      view.baseTexture.update(shaded)
      view.reliefTexture.update(unshaded)
    }
  }

  // What the chooser's last reload found, for the open that follows it.
  let levels = new Map<string, ServerArtifact[]>()
  // Set on dispose, so a level that arrives after leaving is dropped.
  let disposed = false

  // Read the world's level 1, paint it and show it. The level of the save's
  // own terrain when the server holds it, else any level of the world.
  async function showLevel(archive: Blob, uid: string): Promise<boolean> {
    const started = performance.now()
    const step = (what: string): void => console.info(`[incubator] ${what} ${Math.round(performance.now() - started)} ms`)
    loadPanel.done('fetch', formatBytes(archive.size))
    loadPanel.start('read')
    const world = await openWorld(new Uint8Array(await archive.arrayBuffer()), await loadWasmEngine())
    if (!world) {
      console.warn('[incubator] the archive is not a world')
      loadPanel.fail('read')
      return false
    }
    const worldId = await world.worldId()
    const candidates = levels.get(uid) ?? []
    const chosen = candidates.find((a) => a.worldId === worldId) ?? candidates[0]
    if (!chosen) {
      console.warn(`[incubator] world ${uid} holds no level ${LEVEL}`)
      loadPanel.fail('level')
      return false
    }
    if (chosen.worldId !== worldId) console.warn(`[incubator] level ${LEVEL} of an older terrain (${chosen.worldId}, the save is ${worldId})`)
    step('save read')
    loadPanel.start('level')
    const store = await getArtifactStore()
    const read = await readMeshLevelArtifact(store, artifactKey(chosen.worldId, chosen.pipelineVersion, chosen.stage), await loadWasmEngine())
    if (!read) {
      console.warn(`[incubator] level ${LEVEL} of ${uid} could not be read`)
      loadPanel.fail('level')
      return false
    }
    const level = read.artifact
    step(`level read, ${level.count} nodes`)
    loadPanel.done('level', formatBytes(chosen.bytes))
    loadPanel.start('paint')
    const kind = world.kind === 'SphereWorld' ? 'sphere' : 'torus'
    const biome = await world.acquire('biome')
    const painted = await paintChart({
      kind,
      width: world.width,
      height: world.height,
      chartWidth: CHART_WIDTH,
      chartHeight: CHART_HEIGHT,
      level: { count: level.count, nodes: level.nodes, connectivity: level.connectivity, z: level.z, waterBodies: level.waterBodies },
      biome: biome ? Float32Array.from(biome.data) : null,
      detailSeed: world.recipe.detailSeed,
    })
    if (!painted) loadPanel.fail('paint')
    if (!painted || disposed) return false
    step(`chart painted (${Object.entries(painted.ms).map(([k, v]) => `${k} ${v}`).join(', ')})`)

    // The view for the world's shape, a new one per world.
    view?.dispose()
    view = null
    const domain = domainOfKind(kind, world.width, world.height)
    const deepestMetresPerPixel = LEVEL_NODE_SPACING_M / PIXELS_PER_NODE
    if (kind === 'sphere') {
      const globe = createGlobeWorldView({ engine: ctx.engine, canvas: ctx.canvas, textureWidth: CHART_WIDTH, textureHeight: CHART_HEIGHT, metresRound: domain.metresAround, deepestMetresPerPixel })
      globe.setHome('overview', true)
      // The globe is lit by the sphere's normal alone: it wears the
      // composite WITH the hillshade, or the level's relief would not show.
      globe.reliefTexture.update(painted.shaded)
      globe.setLayersShown(true)
      view = globe
    } else {
      const flat = createFlatWorldView({ engine: ctx.engine, canvas: ctx.canvas, textureWidth: CHART_WIDTH, textureHeight: CHART_HEIGHT, metresWide: domain.metresPerUnit * world.width, metresHigh: domain.metresPerUnit * world.height })
      flat.baseTexture.update(painted.shaded)
      flat.reliefTexture.update(painted.unshaded)
      view = flat
    }
    view.scene.onAfterRenderObservable.add(renderScaleBar)
    shown = {
      kind,
      width: world.width,
      height: world.height,
      worldAreaM2: kind === 'sphere' ? domain.metresAround ** 2 / Math.PI : (domain.metresPerUnit ** 2) * world.width * world.height,
      level: { count: level.count, nodes: level.nodes, connectivity: level.connectivity, z: level.z },
      shaded: painted.shaded,
      unshaded: painted.unshaded,
    }
    regionBlend = null
    shownWorld = world
    speciesLayers = null
    fillSpeciesPick()
    if (regionBox.checked) void showRegions()
    if (speciesPick.value !== '') void showSpecies()
    // The level's rivers, from the world raster's texels to the chart's.
    if (level.rivers) {
      const points = Float32Array.from(level.rivers.points)
      const gain = CHART_WIDTH / world.width
      for (let i = 0; i < points.length; i += 3) {
        points[i] *= gain
        points[i + 1] *= gain
      }
      view.rivers.setPolylines(points, level.rivers.lengths, level.rivers.regimes)
      view.rivers.setEnabled(true)
    }
    step('shown')
    loadPanel.close()
    held = { uid, name: '', seed: '', worldId: chosen.worldId }
    scaleBar.element.hidden = false
    return true
  }

  const worldChooser = createWorldChooser(root, {
    titleKey: 'incubator.load.title',
    subtitleKey: 'incubator.load.subtitle',
    // The generator's says "loads this world into the generator"; the
    // incubator has no line of its own yet (a debug screen, no new keys).
    openHelpKey: null,
    notifications: ctx.notifications,
    // A browser world never holds a level: the levels are server jobs.
    openable: {
      load: async () => {
        levels = await levelArtifacts()
        return (where, uid) => where === 'server' && levels.has(uid)
      },
      reasonKey: 'incubator.load.noLevel',
    },
    // The list stays up behind the load panel while the level loads
    // (seconds), and stays up if it fails; the console says why.
    onOpening: (kept) => openLoad(kept),
    onOpenFailed: () => loadPanel.fail('fetch'),
    onOpenArchive: (archive, kept) => {
      void (async () => {
        if (!(await showLevel(archive, kept.uid))) return
        if (held) held = { ...held, name: kept.name, seed: kept.seed }
        titleBar.setWorld({ name: kept.name || undefined, seed: kept.seed })
        titleBar.setSaveState({ kind: kept.where === 'server' ? 'server' : 'local', at: new Date(kept.savedAt) })
        worldChooser.close()
        sidebar.setVisible(true)
      })()
    },
  })

  // The open's steps, over the list. Only server worlds open here.
  const loadPanel = createLoadPanel(root)
  function openLoad(kept: OpenedCopy): void {
    loadPanel.open({
      screenKey: 'common.title.nav.incubator',
      name: kept.name,
      seed: kept.seed,
      source: { where: kept.where, savedAt: kept.savedAt },
      steps: [
        { id: 'fetch', labelKey: kept.where === 'server' ? 'common.loading.step.fetch.server' : 'common.loading.step.fetch.browser' },
        { id: 'read', labelKey: 'common.loading.step.read' },
        { id: 'level', labelKey: 'common.loading.step.level', weight: 2 },
        { id: 'paint', labelKey: 'common.loading.step.paint', weight: 4 },
      ],
    })
    loadPanel.start('fetch')
  }

  // The jobs and the artifacts, full screen over the world as in the
  // generator; one at a time, the column out of the way while one is up.
  // "This world" is the world shown. Over the world list they cover the list,
  // and closing one leaves the list as it was.
  let held: { uid: string; name: string; seed: string; worldId: string | null } | null = null
  const closeWindow = (window: { isOpen(): boolean; close(): void }): void => {
    if (!window.isOpen()) return
    window.close()
    // Over the world list, the list stays and the column stays away.
    if (!worldChooser.isOpen()) sidebar.setVisible(true)
  }
  const artifactChooser = createArtifactChooser(root, {
    currentWorld: () => held,
    onClose: () => closeWindow(artifactChooser),
    onCommissioned: (outcome) => reportCommission(ctx.notifications, outcome),
  })
  const jobChooser = createJobChooser(root, {
    currentWorld: () => held,
    onClose: () => closeWindow(jobChooser),
  })
  // The handbook, as in the generator. No step and no layers here, so it
  // opens on its overview.
  const handbookPanel = createHandbookPanel(root, {
    docsAvailable: () => peekServerStatus()?.modules.includes('docs') ?? false,
    current: () => null,
  })
  function openWindow(window: typeof artifactChooser | typeof jobChooser): void {
    if (window.isOpen()) return
    handbookPanel.close()
    const other = window === artifactChooser ? jobChooser : artifactChooser
    if (other.isOpen()) closeWindow(other)
    sidebar.setVisible(false)
    window.open()
  }

  // The list first, the column behind it — as the generator opens.
  sidebar.setVisible(false)
  worldChooser.open()

  // DEBUG: `?screen=incubator&world=<uid>` opens a server world, so a
  // check sees the same world every time. `data-ready` on the root says
  // the level is shown. Not a user surface: no text, no keys.
  const debug: { errors: string[]; view: () => WorldView | null } = { errors: [], view: () => view }
  ;(window as unknown as { __incubator?: unknown }).__incubator = debug
  window.addEventListener('error', (e) => debug.errors.push(String(e.message)))
  window.addEventListener('unhandledrejection', (e) => debug.errors.push(String(e.reason)))
  const worldParam = new URLSearchParams(window.location.search).get('world')
  if (worldParam) {
    void (async () => {
      openLoad({ where: 'server', savedAt: '', uid: worldParam, name: '', seed: worldParam })
      levels = await levelArtifacts()
      const archive = await fetchWorld(worldParam)
      if (!archive) loadPanel.fail('fetch')
      if (!archive || disposed) return
      if (!(await showLevel(archive, worldParam))) return
      worldChooser.close()
      sidebar.setVisible(true)
      root.dataset.ready = '1'
    })()
  }

  ctx.overlay.appendChild(root)

  const helpTooltip = createHelpTooltip(root)

  return {
    get scene() {
      return view?.scene ?? idleScene
    },
    dispose() {
      disposed = true
      worldChooser.dispose()
      loadPanel.dispose()
      artifactChooser.dispose()
      jobChooser.dispose()
      handbookPanel.dispose()
      sidebar.dispose()
      titleBar.dispose()
      helpTooltip.dispose()
      serverIndicator.dispose()
      // A view disposes its own camera and its listeners on the shared
      // canvas with its scene.
      view?.dispose()
      idleScene.dispose()
    },
  }
}
