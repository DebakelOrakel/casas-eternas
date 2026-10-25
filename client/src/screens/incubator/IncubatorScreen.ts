import { Color4, FreeCamera, Scene, Vector3 } from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { domainOfKind } from '../../generator/core/domain'
import { loadWasmEngine } from '../../generator/pipeline/engineWasm'
import { relabel } from '../../i18n/relabel'
import { createFlatWorldView } from '../../map/flatWorldView'
import { createCameraTools } from '../../map/cameraTools'
import { createMapScales } from '../../map/mapScales'
import { createGlobeWorldView, type GlobeWorldView } from '../../map/sphereView'
import { seaLevelTemperatureBand } from '../../generator/climate/temperature'
import { weatherParamsFrom } from '../../world/runParams'
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
import { createOverlayList } from '../generator/OverlayList'
import { OVERLAY_META, overlayKey } from '../generator/overlays'
import { createStepBar } from '../generator/StepBar'
import { formatValue, t, type TKey } from '../../i18n/i18n'
import { createMapHoverTooltip } from '../../map/MapHoverTooltip'
import { buildProbeCard } from '../../ui/mapProbe/probeCard'
import { elevationToMeters } from '../../generator/elevation/elevationScale'
import { koppenLabelKey } from '../../generator/climate/koppen'
import { biomeLabelKey } from '../../generator/climate/biomes'
import type { ChartWorkerInbound, ChartWorkerOutbound } from './chartWorker'
import { decodeFineValue, ECOLOGY_FINE_OCEAN, type EcologyFieldId } from '../../generator/ecology/ecologyField'
import { ECOLOGY_FIELD_META, ecologyFieldColor } from '../../generator/ecology/ecologyColors'
import type { LevelLand } from '../../world/meshArtifacts'
import type { RegionWorkerInbound, RegionWorkerOutbound } from './regionWorker'
import type { SpeciesLayer, SpeciesWorkerInbound, SpeciesWorkerOutbound } from './speciesWorker'
import type { World } from '../../world/query'
import { SPECIES } from './species'
import type { PlantUse } from './plants'
import type { PlantLayer, PlantWorkerInbound, PlantWorkerOutbound, TreeLayer } from './plantWorker'
import type { WoodUse } from './trees'
import { levelRasters, type HabitatInput } from './habitat'
import { createLegendPanel } from '../../ui/legend/LegendPanel'
import { createProgressPill } from '../../ui/progressPill/ProgressPill'
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
// used now; they stay for later.)
//
// THE STEPS (2026-10-25), along the foot as in the generator, numbered
// from 1: the world is chosen in the list, not in a step. 1 the flora —
// the wild plants and the trees; 2 the fauna — the trial's catchments and
// animals. The terrain colour is a layer that can
// be switched off: then the land is the bare paper, white with its
// hillshade, as on the generator's map. The load panel shows the steps of an
// open and which one failed; why it failed goes to the console. Over the
// map, the generator's hover card for the level's node under the pointer.

// The incubator's steps, in order; their names are `incubator.step.<id>`.
const STEPS = ['flora', 'fauna'] as const

// The ecology's fields the incubator shows (the level's artifact holds all
// fourteen, docs/decisions/level-waters.md), with their icons as the
// generator's resource picks have them.
const ECOLOGY_PICKS: readonly { id: EcologyFieldId; icon: string }[] = [
  { id: 'carryingCapacity', icon: '/icons/ecology.png' },
  { id: 'arable', icon: '/icons/wheat.png' },
]
// The pick that paints none of them.
const NO_FIELD = 'none:fields'

// An ecology field over a chart, into a copy, as the generator paints it
// (GeneratorScreen.paintEcology): its ramp at 0.6, a deposit field fading
// in from 0 to 0.05. The field is a byte a node (the generator's fine
// code); `nodes` names the node each texel of the half-resolution chart
// shows (chartWorker.ts). The colour of each code is made once.
function blendEcology(base: Uint8ClampedArray, field: EcologyFieldId, codes: Uint8Array, nodes: Int32Array, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(base)
  const fadeZero = ECOLOGY_FIELD_META[field].fadeZero === true
  const rgb = new Uint8Array(256 * 3)
  const alpha = new Float32Array(256)
  for (let c = 0; c < 256; c++) {
    if (c === ECOLOGY_FINE_OCEAN) continue
    const v = decodeFineValue(c)
    const [r, g, b] = ecologyFieldColor(field, v)
    rgb[3 * c] = r
    rgb[3 * c + 1] = g
    rgb[3 * c + 2] = b
    alpha[c] = fadeZero ? 0.6 * Math.min(1, v / 0.05) : 0.6
  }
  const half = width >> 1
  for (let y = 0; y < height; y++) {
    const row = (y >> 1) * half
    for (let x = 0; x < width; x++) {
      const c = codes[nodes[row + (x >> 1)]]
      const a = alpha[c]
      if (a === 0) continue
      const i = 4 * (y * width + x)
      out[i] = out[i] * (1 - a) + rgb[3 * c] * a
      out[i + 1] = out[i + 1] * (1 - a) + rgb[3 * c + 1] * a
      out[i + 2] = out[i + 2] * (1 - a) + rgb[3 * c + 2] * a
    }
  }
  return out
}

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

// Where the plants grow, in the plant worker.
function growPlants(input: PlantWorkerInbound): Promise<(PlantWorkerOutbound & { type: 'plants' }) | null> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./plantWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<PlantWorkerOutbound>): void => {
      worker.terminate()
      if (event.data.type === 'failed') {
        console.warn(`[incubator] the plants could not be grown: ${event.data.message}`)
        resolve(null)
        return
      }
      resolve(event.data)
    }
    worker.onerror = (event): void => {
      worker.terminate()
      console.warn(`[incubator] the plant worker failed: ${event.message}`)
      resolve(null)
    }
    worker.postMessage(input)
  })
}

// The uses of the plants, in the order of their picks, with their icons;
// their names are `plant.use.<use>`.
const PLANT_USES: readonly { use: PlantUse; icon: string }[] = [
  { use: 'starch', icon: '/icons/wheat.png' },
  { use: 'fat', icon: '/icons/nuts.png' },
  { use: 'fruit', icon: '/icons/fruits.png' },
  { use: 'fibre', icon: '/icons/rope.png' },
]
// The picks' ids: the pick that paints no plants, and one a use.
const NO_PLANTS = 'none:plants'
const plantPickId = (use: PlantUse): string => `plant:${use}`

// The uses of the wood, as the plants'; their names are `wood.use.<use>`.
const WOOD_USES: readonly { use: WoodUse; icon: string }[] = [
  { use: 'build', icon: '/icons/timber.png' },
  { use: 'fuel', icon: '/icons/bonfire.png' },
  { use: 'tool', icon: '/icons/stone_axe.png' },
  { use: 'boat', icon: '/icons/boat.png' },
  { use: 'resin', icon: '/icons/resin.png' },
]
const NO_WOOD = 'none:wood'
const woodPickId = (use: WoodUse): string => `wood:${use}`

// A colour for each plant of a group, told apart (Trubetskoy's twenty
// distinct colours, 2017): a group holds at most sixteen.
const PLANT_PALETTE: readonly (readonly [number, number, number])[] = [
  [230, 25, 75], [60, 180, 75], [255, 225, 25], [67, 99, 216], [245, 130, 49], [145, 30, 180], [70, 240, 240], [240, 50, 230],
  [188, 246, 12], [0, 128, 128], [154, 99, 36], [128, 0, 0], [128, 128, 0], [0, 0, 117], [250, 190, 190], [170, 255, 195],
  [230, 190, 255], [255, 216, 177], [255, 250, 200], [128, 128, 128],
]

// A layer's code from which its niche suits a cell (plantWorker.ts:
// SUITABLE 0.3, the niche coded 2 … 255).
const PLANT_SUITS = 2 + Math.round(253 * 0.3)

// The plants of a use over a painted chart, into a copy: per cell the
// plant in range that suits it best, in its colour, as strong as its
// niche; grey where one would suit but none came. A range reaches past
// its niche, where the plant is rare: not drawn.
function blendPlantGroup(base: Uint8ClampedArray, layers: readonly { codes: Uint8Array; colour: number }[], width: number, height: number, scale: number): Uint8ClampedArray {
  const n = width * height
  const pick = new Uint8Array(n).fill(255)
  // The best suiting code, 1 for an empty niche, 0 for none.
  const best = new Uint8Array(n)
  for (let k = 0; k < layers.length; k++) {
    const codes = layers[k].codes
    for (let i = 0; i < n; i++) {
      const c = codes[i]
      if (c >= PLANT_SUITS && c > best[i]) {
        best[i] = c
        pick[i] = k
      } else if (c === 1 && best[i] === 0) best[i] = 1
    }
  }
  const out = new Uint8ClampedArray(base)
  const W = width * scale
  const H = height * scale
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / scale) * width
    for (let x = 0; x < W; x++) {
      const cell = row + Math.floor(x / scale)
      const code = best[cell]
      if (code === 0) continue
      const a = code === 1 ? 0.45 : 0.35 + 0.55 * ((code - PLANT_SUITS) / (255 - PLANT_SUITS))
      const [cr, cg, cb] = code === 1 ? [120, 120, 120] : PLANT_PALETTE[layers[pick[cell]].colour % PLANT_PALETTE.length]
      const i = 4 * (y * W + x)
      out[i] = out[i] * (1 - a) + cr * a
      out[i + 1] = out[i + 1] * (1 - a) + cg * a
      out[i + 2] = out[i + 2] * (1 - a) + cb * a
    }
  }
  return out
}

// A species' colour by its role.
const ROLE_COLOURS: Record<SpeciesLayer['role'], readonly [number, number, number]> = {
  herbivore: [170, 60, 20],
  predator: [120, 30, 140],
  fish: [20, 80, 200],
}

// An animal's layer over a painted chart, into a copy: its
// density in `colour`, the empty niche grey, its origins as rings. The
// layer is on the world raster, the chart `scale` times finer; a texel
// reads its cell.
function blendSpecies(base: Uint8ClampedArray, layer: Pick<SpeciesLayer, 'codes' | 'origins'>, colour: readonly [number, number, number], width: number, height: number, scale: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(base)
  const W = width * scale
  const H = height * scale
  const [r, g, b] = colour
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
      stepBar.relabel()
      updateSteps()
      overlayList.relabel()
      showPlants()
      cameraTools.relabel()
      mapScales.relabel()
    },
  })
  titleBar.setWorld(null)

  const sidebar = createSidebar(root, 'incubator.step')

  // THE STEPS. Each shows its own layers (stepLayers): the flora the
  // plants and the wood, the fauna the trial's catchments and animals; the
  // terrain and the ecology both. What a step had on stays for its return.
  let stepIndex = 0
  const onFlora = (): boolean => STEPS[stepIndex] === 'flora'
  // True once the screen is built: the step's layers are below.
  let built = false
  const stepBar = createStepBar(root, {
    steps: STEPS.map((id) => ({ id })),
    stepKeys: 'incubator.step',
    firstNumber: 1,
    onSelect: (index) => showStep(index),
  })
  function showStep(index: number): void {
    stepIndex = index
    sidebar.setStep(STEPS[index])
    updateSteps()
    if (built) stepLayers()
  }
  function updateSteps(): void {
    stepBar.setState({
      current: stepIndex,
      steps: STEPS.map(() => ({ status: t('generator.step.status.pending'), settled: false, blocked: false })),
    })
  }
  // The column and the bar step aside together: for the world list and
  // for the windows.
  function setFurniture(visible: boolean): void {
    sidebar.setVisible(visible)
    stepBar.setVisible(visible)
    plantLegend.element.hidden = !visible
  }

  // THE MAP'S FURNITURE, as in the generator: the globe's camera buttons
  // (map/cameraTools.ts), and the distance and temperature scales with the
  // free area the globe's far shot fits into (map/mapScales.ts). The
  // temperature is the sea-level band of the world's own levers.
  let globe: GlobeWorldView | null = null
  let band: { values: Float32Array; key: string } | null = null
  const cameraTools = createCameraTools(root, {
    reset: () => view?.resetCamera(),
    spin: (on) => globe?.setSpinning(on),
    tilt: (on) => globe?.setTilted(on),
  })
  const mapScales = createMapScales(root, {
    engine: ctx.engine,
    canvas: ctx.canvas,
    view: () => view,
    globe: () => globe,
    band: () => band,
    bars: { title: titleBar.element, steps: stepBar.element, column: sidebar.element },
    onFreeArea: (area) => globe?.setFreeArea(area),
  })

  // THE LAYERS. The terrain colour: on, the chart with the terrain wash;
  // off, the bare paper. The chart worker paints both (chartWorker.ts).
  // Over it, one of the ecology's fields at a time (ECOLOGY_PICKS), read
  // from the level's artifact per node; none in a level made before its
  // land fields.
  let terrainOn = true
  let charts: { shaded: Uint8ClampedArray; unshaded: Uint8ClampedArray | null; paperShaded: Uint8ClampedArray; paperUnshaded: Uint8ClampedArray | null } | null = null
  let ecology: { nodes: Int32Array; fields: LevelLand['ecology'] } | null = null
  let picked: EcologyFieldId | null = null
  // TRIAL (2026-10-25): the plants of plants.ts, grown on the first pick;
  // the use shown, or null. Declared here, above the first showCharts.
  let plants: { layers: PlantLayer[]; trees: TreeLayer[] } | null = null
  let plantShown: PlantUse | null = null
  // The wood shown, or null; one of the two at a time.
  let woodShown: WoodUse | null = null
  // The last blend, for showing it again without blending it again.
  let blended: { key: string; shaded: Uint8ClampedArray; unshaded: Uint8ClampedArray | null } | null = null
  const overlayList = createOverlayList({
    onToggle: () => {
      terrainOn = !terrainOn
      showCharts()
    },
    onPick: (id) => {
      if (id === NO_PLANTS || id.startsWith('plant:') || id === NO_WOOD || id.startsWith('wood:')) {
        if (id === NO_PLANTS || id.startsWith('plant:')) {
          plantShown = id === NO_PLANTS ? null : (id.slice('plant:'.length) as PlantUse)
          if (plantShown) woodShown = null
        } else {
          woodShown = id === NO_WOOD ? null : (id.slice('wood:'.length) as WoodUse)
          if (woodShown) plantShown = null
        }
        showPlants()
        void showSpecies()
        return
      }
      picked = id === NO_FIELD ? null : (id as EcologyFieldId)
      showCharts()
    },
  })
  // The pick groups; the step shows its own (stepLayers).
  const RESOURCE_PICKS = {
    title: 'generator.section.resources',
    rows: [
      { id: NO_FIELD, helpBase: 'overlay.none', icon: '/icons/clear.png' },
      ...ECOLOGY_PICKS.map((p) => ({ id: p.id, helpBase: `resource.${p.id}`, icon: p.icon })),
    ],
  }
  const PLANT_PICKS = {
    title: 'incubator.section.plants',
    rows: [
      { id: NO_PLANTS, helpBase: 'overlay.none', icon: '/icons/clear.png' },
      ...PLANT_USES.map((p) => ({ id: plantPickId(p.use), helpBase: `plant.use.${p.use}`, icon: p.icon })),
    ],
  }
  const WOOD_PICKS = {
    title: 'incubator.section.wood',
    rows: [
      { id: NO_WOOD, helpBase: 'overlay.none', icon: '/icons/clear.png' },
      ...WOOD_USES.map((p) => ({ id: woodPickId(p.use), helpBase: `wood.use.${p.use}`, icon: p.icon })),
    ],
  }
  sidebar.body.append(overlayList.element)
  // Under the picks, a line while the plants are grown, or why they are not.
  const plantStatus = document.createElement('p')
  const plantInfo = document.createElement('section')
  plantInfo.className = 'gen-overlays'
  plantInfo.append(plantStatus)
  sidebar.body.append(plantInfo)
  function showCharts(): void {
    overlayList.refresh((id) => {
      if (id === 'terrain') return { on: terrainOn, available: charts !== null }
      if (id === NO_FIELD) return { on: picked === null, available: true }
      if (id === NO_PLANTS) return { on: plantShown === null, available: true }
      if (id.startsWith('plant:')) return { on: plantShown !== null && id === plantPickId(plantShown), available: charts !== null }
      if (id === NO_WOOD) return { on: woodShown === null, available: true }
      if (id.startsWith('wood:')) return { on: woodShown !== null && id === woodPickId(woodShown), available: charts !== null }
      return { on: picked === id, available: ecology?.fields[id as EcologyFieldId] !== undefined }
    })
    if (!charts || !view) return
    let shaded = terrainOn ? charts.shaded : charts.paperShaded
    let unshaded = terrainOn ? charts.unshaded : charts.paperUnshaded
    const codes = picked && ecology ? ecology.fields[picked] : undefined
    if (picked && ecology && codes) {
      const key = `${picked},${terrainOn}`
      if (blended?.key !== key) {
        // The last blend goes before the next is made: two are 256 MB.
        blended = null
        blended = {
          key,
          shaded: blendEcology(shaded, picked, codes, ecology.nodes, CHART_WIDTH, CHART_HEIGHT),
          unshaded: unshaded ? blendEcology(unshaded, picked, codes, ecology.nodes, CHART_WIDTH, CHART_HEIGHT) : null,
        }
      }
      shaded = blended.shaded
      unshaded = blended.unshaded
    } else {
      blended = null
    }
    ;({ shaded, unshaded } = overTrials(shaded, unshaded))
    // The globe is lit by the sphere's normal alone: it wears the
    // composite WITH the hillshade, or the level's relief would not show.
    if (view.shape === 'sphere') view.reliefTexture.update(shaded)
    else {
      view.baseTexture.update(shaded)
      view.reliefTexture.update(unshaded!)
    }
  }
  showStep(0)
  showCharts()

  // THE HOVER READOUT, the generator's card (ui/mapProbe): the node under
  // the pointer through the chart's node map, its height, and on land its
  // climate class, its biome and the ecology's fields shown (ECOLOGY_PICKS).
  // None in a level made before its land fields. Only what it reads is
  // kept of the level's land fields.
  let probe: { nodes: Int32Array; z: Float32Array; land: Pick<LevelLand, 'land' | 'biome' | 'koppen' | 'ecology'> } | null = null
  function describeNode(x: number, y: number): HTMLElement | null {
    if (!probe) return null
    const node = probe.nodes[(y >> 1) * (CHART_WIDTH >> 1) + (x >> 1)]
    const metres = Math.round(elevationToMeters(probe.z[node]))
    const onLand = probe.land.land[node] === 1
    const koppen = probe.land.koppen[node]
    return buildProbeCard({
      heading: metres >= 0 ? formatValue(String(metres), 'common.unit.metres') : t('readout.metresDeep', { v: String(-metres) }),
      kind: onLand ? t('readout.kind.land') : t('readout.kind.ocean'),
      land: onLand,
      highlights: onLand ? [...(koppen > 0 ? [t(koppenLabelKey(koppen) as TKey)] : []), t(biomeLabelKey(probe.land.biome[node]) as TKey)] : [],
      rows: onLand ? [
        ...ECOLOGY_PICKS.flatMap((p) => {
          const code = probe!.land.ecology[p.id]?.[node]
          return code === undefined || code === ECOLOGY_FINE_OCEAN ? [] : [{ label: t(`resource.${p.id}.label` as TKey), value: formatValue(String(Math.round(decodeFineValue(code) * 100)), 'common.unit.percent') }]
        }),
        // TRIAL: the plants there, on the world raster, one a line; the
        // use named on its first.
        ...(shown && onFlora() ? plantsAt(Math.floor(y / (CHART_HEIGHT / shown.height)) * shown.width + Math.floor(x / (CHART_WIDTH / shown.width))).flatMap((g) => g.names.map((name, k) => ({ label: k === 0 ? g.label : '', value: name }))) : []),
      ] : [],
      months: t('readout.months').split(','),
      charts: [],
    })
  }
  const hoverTooltip = createMapHoverTooltip({
    locate: (x, y) => view?.groundAt(x, y) ?? null,
    surface: ctx.canvas,
    host: root,
    textureWidth: CHART_WIDTH,
    textureHeight: CHART_HEIGHT,
    describe: describeNode,
  })

  // TRIAL (2026-10-23): the catchments over the chart, on a switch in the
  // column. Hardcoded text, no catalog keys: we are trying it out.
  // The world shown, kept for the layers drawn over it.
  let shown: {
    kind: 'sphere' | 'torus'
    width: number
    height: number
    worldAreaM2: number
    level: RegionWorkerInbound['level']
    rivers: HabitatInput['rivers']
    // Level 1's ground and water on the world raster (habitat.ts,
    // levelRasters); null for a level made before its land fields.
    ground: ReturnType<typeof levelRasters> | null
  } | null = null
  // The last cut, for its threshold: drawn over the chart in showCharts.
  let regionCut: { minAreaKm2: number; overlay: Uint8ClampedArray } | null = null
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
    if (on && regionCut?.minAreaKm2 !== minAreaKm2) {
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
      regionCut = { minAreaKm2, overlay: cut.overlay }
    }
    showCharts()
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
  speciesTitle.textContent = 'Tiere'
  const speciesSection = document.createElement('section')
  speciesSection.className = 'gen-overlays'
  speciesSection.append(speciesTitle, speciesPick, speciesStatus)
  sidebar.body.append(speciesSection)
  const ROLE_NAMES: Record<SpeciesLayer['role'], string> = { herbivore: 'Pflanzenfresser', predator: 'Räuber', fish: 'Fische' }
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
      const input = await habitatOf(world)
      if (!input) {
        speciesStatus.textContent = 'der Welt fehlen Felder (Konsole)'
        return
      }
      const done = await distributeSpecies(input)
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
    showCharts()
  }
  speciesPick.addEventListener('change', () => void showSpecies())

  // The fields the animals and the plants live on (habitat.ts), from the
  // world shown; null when it lacks one.
  async function habitatOf(world: World): Promise<HabitatInput | null> {
    if (!shown) return null
    const [temperature, precipitation, seasonalAmplitude] = await Promise.all(['temperature', 'precipitation', 'seasonalAmplitude'].map((name) => world.acquire(name)))
    if (!temperature || !precipitation || !seasonalAmplitude) {
      console.warn('[incubator] the habitat needs the save\'s climate')
      return null
    }
    // Level 1's ground and water; the save's for a level without them.
    let ground = shown.ground
    if (!ground) {
      const [elevation, biome, discharge, koppen] = await Promise.all(['elevation', 'biome', 'discharge', 'koppen'].map((name) => world.acquire(name)))
      if (!elevation || !biome || !discharge || !koppen) {
        console.warn('[incubator] the habitat needs elevation, biome, discharge and the Köppen classes')
        return null
      }
      // A world without lakes has no lake depth.
      const lakeDepth = await world.acquire('lakeDepth')
      ground = { elevation: elevation.data, biome: biome.data, discharge: discharge.data, koppen: koppen.data, lakeDepth: lakeDepth?.data ?? null }
    }
    const domain = domainOfKind(shown.kind, shown.width, shown.height)
    return {
      kind: shown.kind,
      width: shown.width,
      height: shown.height,
      cellMetres: shown.kind === 'sphere' ? domain.metresAround / shown.width : domain.metresPerUnit,
      ...ground,
      rivers: shown.rivers,
      climate: { resX: temperature.resX, resY: temperature.resY, temperature: temperature.data, precipitation: precipitation.data, seasonalAmplitude: seasonalAmplitude.data },
      seed: world.recipe.detailSeed,
    }
  }

  // TRIAL (2026-10-25): where the plants of plants.ts grow, a use at a
  // time, each plant of it in a colour of its own (the picks under the
  // ecology's). One layer over the chart at a time: picking a plant group
  // drops the animal, and back. The hover card names the plants at the
  // place.
  // The legend, as the generator's (ui/legend): the plants of the use
  // shown, each in its colour, the ones that grow nowhere left out.
  // The group on the map: the plants of a use, or the trees of a wood.
  // A plant's colour is its place in its use; a tree's its place among
  // the trees, the same under every wood it gives.
  function shownGroup(): { title: string; layers: { name: string; codes: Uint8Array; reached: number; colour: number }[] } | null {
    if (!plants || !onFlora()) return null
    if (plantShown) {
      const use = plantShown
      return {
        title: t(`plant.use.${use}.label` as TKey),
        layers: plants.layers.filter((l) => l.use === use).map((l, k) => ({ name: t(`plant.${l.id}.label` as TKey), codes: l.codes, reached: l.reached, colour: k })),
      }
    }
    if (woodShown) {
      const use = woodShown
      return {
        title: t(`wood.use.${use}.label` as TKey),
        layers: plants.trees.flatMap((l, k) => (l.woods.includes(use) ? [{ name: t(`wood.${l.id}.label` as TKey), codes: l.codes, reached: l.reached, colour: k }] : [])),
      }
    }
    return null
  }
  const plantLegend = createLegendPanel(root, {
    content: () => {
      const group = shownGroup()
      if (!group) return { count: 0, build: () => [] }
      return {
        count: 1,
        build: () => [{
          type: 'swatches',
          title: group.title,
          items: group.layers.flatMap((layer) => layer.reached === 0 ? [] : [{
            // The name and the share of the land it reached, whole percent.
            label: `${layer.name} (${formatValue(layer.reached < 0.005 ? '<1' : String(Math.round(100 * layer.reached)), 'common.unit.percent')})`,
            rgb: [...PLANT_PALETTE[layer.colour % PLANT_PALETTE.length]] as [number, number, number],
          }]),
        }],
      }
    },
  })
  // The plants and the trees grow by themselves once a world is shown,
  // in the background, the pill saying so; a pick shows them once they
  // are there. Each world asks again; an answer for an older one is
  // dropped.
  const progressPill = createProgressPill(root)
  let plantAsk = 0
  async function growFlora(): Promise<void> {
    const ask = ++plantAsk
    if (!shown || !shownWorld) return
    const world = shownWorld
    const label = t('incubator.step.flora.label')
    progressPill.show({ label, sub: null, fraction: null, aria: t('generator.progress.ariaRunning', { step: label }) })
    plantStatus.textContent = ''
    const input = await habitatOf(world)
    const done = input ? await growPlants(input) : null
    if (ask !== plantAsk || shownWorld !== world) return
    progressPill.hide()
    if (!input) {
      console.warn('[incubator] the plants need the habitat\'s fields')
      plantStatus.textContent = t('incubator.plants.missing')
      return
    }
    if (!done) {
      plantStatus.textContent = t('incubator.plants.failed')
      return
    }
    console.info(`[incubator] plants grown, ${done.ms} ms`)
    plants = { layers: done.layers, trees: done.trees }
    hoverTooltip.refresh()
    showPlants()
  }
  // The picks' plants or wood on the map, and their legend.
  function showPlants(): void {
    plantLegend.refresh()
    showCharts()
  }

  // The plants at a cell of the world raster, by use: those in range whose
  // niche suits it, the best first. Empty before the plants are grown.
  function plantsAt(cell: number): { label: string; names: string[] }[] {
    if (!plants) return []
    const best = <L extends { codes: Uint8Array }>(layers: L[]): L[] => layers.filter((l) => l.codes[cell] >= PLANT_SUITS).sort((p, q) => q.codes[cell] - p.codes[cell])
    const uses = PLANT_USES.map(({ use }) => ({ label: t(`plant.use.${use}.label` as TKey), names: best(plants!.layers.filter((l) => l.use === use)).map((l) => t(`plant.${l.id}.label` as TKey)) }))
    const woods = WOOD_USES.map(({ use }) => ({ label: t(`wood.use.${use}.label` as TKey), names: best(plants!.trees.filter((l) => l.woods.includes(use))).map((l) => t(`wood.${l.id}.label` as TKey)) }))
    return [...uses, ...woods].filter((g) => g.names.length > 0)
  }

  // The trials' layers over the chart (showCharts): the catchments, then
  // the animal or the plant. Each a copy of the chart, 128 MB.
  function overTrials(shaded: Uint8ClampedArray, unshaded: Uint8ClampedArray | null): { shaded: Uint8ClampedArray; unshaded: Uint8ClampedArray | null } {
    if (!shown) return { shaded, unshaded }
    if (!onFlora() && regionBox.checked && regionCut) {
      shaded = blendOver(shaded, regionCut.overlay)
      if (unshaded) unshaded = blendOver(unshaded, regionCut.overlay)
    }
    const scale = CHART_WIDTH / shown.width
    const layer = onFlora() ? undefined : speciesLayers?.find((l) => l.id === speciesPick.value)
    const group = shownGroup()
    if (layer) {
      shaded = blendSpecies(shaded, layer, ROLE_COLOURS[layer.role], shown.width, shown.height, scale)
      if (unshaded) unshaded = blendSpecies(unshaded, layer, ROLE_COLOURS[layer.role], shown.width, shown.height, scale)
    } else if (group) {
      shaded = blendPlantGroup(shaded, group.layers, shown.width, shown.height, scale)
      if (unshaded) unshaded = blendPlantGroup(unshaded, group.layers, shown.width, shown.height, scale)
    }
    return { shaded, unshaded }
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
    // The level's own biomes; the save's for a level made before them.
    const land = level.land ?? null
    const biome = land ? null : await world.acquire('biome')
    const painted = await paintChart({
      kind,
      width: world.width,
      height: world.height,
      chartWidth: CHART_WIDTH,
      chartHeight: CHART_HEIGHT,
      level: { count: level.count, nodes: level.nodes, connectivity: level.connectivity, z: level.z, waterBodies: level.waterBodies },
      land: land ? { land: land.land, biome: land.biome } : null,
      biome: biome ? Float32Array.from(biome.data) : null,
      detailSeed: world.recipe.detailSeed,
    })
    if (!painted) loadPanel.fail('paint')
    if (!painted || disposed) return false
    step(`chart painted (${Object.entries(painted.ms).map(([k, v]) => `${k} ${v}`).join(', ')})`)

    // The view for the world's shape, a new one per world. The globe as
    // the generator's: leaning with the world's obliquity, turning with its
    // day, its far shot in the free area.
    view?.dispose()
    view = null
    globe = null
    const domain = domainOfKind(kind, world.width, world.height)
    const deepestMetresPerPixel = LEVEL_NODE_SPACING_M / PIXELS_PER_NODE
    const values = world.recipe.values
    const params = values ? weatherParamsFrom((path) => values[path]) : null
    band = params
      ? { values: seaLevelTemperatureBand(params.temperatureOffset, params.temperatureContrast, params.planet, kind), key: uid }
      : null
    if (kind === 'sphere') {
      globe = createGlobeWorldView({ engine: ctx.engine, canvas: ctx.canvas, textureWidth: CHART_WIDTH, textureHeight: CHART_HEIGHT, metresRound: domain.metresAround, deepestMetresPerPixel })
      if (values) {
        globe.setObliquity(values['planet.obliquity'])
        globe.setDayLength(values['planet.rotation'])
      }
      globe.setSpinning(cameraTools.spinning)
      globe.setTilted(cameraTools.tilted)
      globe.setFreeArea(mapScales.freeArea())
      globe.setHome('overview', true)
      globe.setLayersShown(true)
      view = globe
    } else {
      view = createFlatWorldView({ engine: ctx.engine, canvas: ctx.canvas, textureWidth: CHART_WIDTH, textureHeight: CHART_HEIGHT, metresWide: domain.metresPerUnit * world.width, metresHigh: domain.metresPerUnit * world.height })
    }
    // The globe wears only the shaded charts; the unshaded ones are 128 MB
    // each, not kept for nothing.
    const flat = kind !== 'sphere'
    charts = { shaded: painted.shaded, unshaded: flat ? painted.unshaded : null, paperShaded: painted.paperShaded, paperUnshaded: flat ? painted.paperUnshaded : null }
    // Only the fields shown are kept of the level's fourteen.
    ecology = land && painted.nodes
      ? { nodes: painted.nodes, fields: Object.fromEntries(ECOLOGY_PICKS.flatMap((p) => (land.ecology[p.id] ? [[p.id, land.ecology[p.id]]] : []))) }
      : null
    blended = null
    probe = land && painted.nodes && ecology
      ? { nodes: painted.nodes, z: level.z, land: { land: land.land, biome: land.biome, koppen: land.koppen, ecology: ecology.fields } }
      : null
    hoverTooltip.refresh()
    showCharts()
    cameraTools.setVisible(kind === 'sphere')
    mapScales.redraw()
    shown = {
      kind,
      width: world.width,
      height: world.height,
      worldAreaM2: kind === 'sphere' ? domain.metresAround ** 2 / Math.PI : (domain.metresPerUnit ** 2) * world.width * world.height,
      level: { count: level.count, nodes: level.nodes, connectivity: level.connectivity, z: level.z },
      rivers: level.rivers,
      ground: land && painted.nodes ? levelRasters(land, level.z, painted.nodes, CHART_WIDTH >> 1, CHART_HEIGHT >> 1, world.width, world.height) : null,
    }
    regionCut = null
    shownWorld = world
    speciesLayers = null
    fillSpeciesPick()
    plants = null
    plantLegend.refresh()
    if (regionBox.checked) void showRegions()
    if (speciesPick.value !== '') void showSpecies()
    void growFlora()
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
        setFurniture(true)
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
    if (!worldChooser.isOpen()) setFurniture(true)
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
    setFurniture(false)
    window.open()
  }

  // The layers the step on screen offers: its picks and its trial
  // sections; the map and its legend redrawn.
  function stepLayers(): void {
    const flora = onFlora()
    overlayList.setRows([{ id: 'terrain', helpBase: overlayKey('terrain'), icon: OVERLAY_META.terrain.icon }], flora ? [RESOURCE_PICKS, PLANT_PICKS, WOOD_PICKS] : [RESOURCE_PICKS])
    plantInfo.hidden = !flora
    regionSection.hidden = flora
    speciesSection.hidden = flora
    showCharts()
    plantLegend.refresh()
    hoverTooltip.refresh()
  }
  built = true
  stepLayers()

  // The list first, the column behind it — as the generator opens.
  setFurniture(false)
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
      setFurniture(true)
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
      stepBar.dispose()
      mapScales.dispose()
      cameraTools.dispose()
      titleBar.dispose()
      helpTooltip.dispose()
      progressPill.dispose()
      hoverTooltip.dispose()
      serverIndicator.dispose()
      // A view disposes its own camera and its listeners on the shared
      // canvas with its scene.
      view?.dispose()
      idleScene.dispose()
    },
  }
}
