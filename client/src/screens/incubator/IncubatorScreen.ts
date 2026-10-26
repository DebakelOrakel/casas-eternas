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
import type { WorldSymbol, WorldView } from '../../map/worldView'
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
import { formatValue, getLocale, t, type TKey } from '../../i18n/i18n'
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
import type { AnimalLayer } from './fauna'
import type { AnimalUse } from './animals'
import type { PeopleResult } from './people'
import { SPAN_YEARS } from './peopleShared'
import { arrowsOf, type PeopleArrow } from './peopleArrows'
import type { SettleResult } from './settle'
import { densityAt, GOODS, LIFEWAY, pressure, sharesAt, type SettleTimes } from './settleShared'
import { ANIMALS } from './animals'
import { cellPoint, centrePictures, originPictures, sourcePictures, villagePictures, villageSymbols } from './incubatorSymbols'
import { clearOverlay, OVERLAY_DIVISOR, paintDensity, paintGroup, paintLifeways, paintPeople, paintRaster, paintTrade, DENSITY_STOPS, GOOD_COLOURS, LIFEWAY_COLOURS, TRADE_COLOUR, PEOPLE_AGE_STOPS, PEOPLE_AGO_AT_START, PEOPLE_ROUTE, PLANT_PALETTE, PLANT_SUITS, type OverlayRaster } from './incubatorOverlay'
import type { LegendSpec } from '../../ui/legend/LegendPanel'
import type { ProbeRow } from '../../ui/mapProbe/probeCard'
import type { World } from '../../world/query'
import type { PlantUse } from './plants'
import type { PlantLayer, TreeLayer } from './flora'
import type { IncubatorAnswer, IncubatorRequest } from './incubatorWorker'
import type { WoodUse } from './trees'
import { LEVEL_ECOLOGY } from './habitat'
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
// the wild plants and the trees; 2 the fauna — the animals; 3 the people —
// their spread from one origin over the world, played; and set apart
// at the end, as the generator's migration, T the testing — the trials
// that have no step of their own (the catchments). The terrain colour is a layer that can
// be switched off: then the land is the bare paper, white with its
// hillshade, as on the generator's map. The load panel shows the steps of an
// open and which one failed; why it failed goes to the console. Over the
// map, the generator's hover card for the level's node under the pointer.

// The incubator's steps, in order; their names are `incubator.step.<id>`.
const STEPS = ['flora', 'fauna', 'people', 'testing'] as const

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

// What the animals are to people, as the plants' uses; their names are
// `animal.use.<use>`.
const ANIMAL_USES: readonly { use: AnimalUse; icon: string }[] = [
  { use: 'hunt', icon: '/icons/deer.png' },
  { use: 'tame', icon: '/icons/pastures.png' },
  { use: 'water', icon: '/icons/fish.png' },
  { use: 'fur', icon: '/icons/beaver.png' },
  { use: 'danger', icon: '/icons/tiger.png' },
]
const NO_ANIMALS = 'none:animals'
const animalPickId = (use: AnimalUse): string => `animal:${use}`

// THE WORKER (incubatorWorker.ts): one for the screen, its answers in the
// order it was asked; a failure is null, why to the console.
function createIncubatorClient(): { ask(request: IncubatorRequest): Promise<IncubatorAnswer | null>; dispose(): void } {
  const worker = new Worker(new URL('./incubatorWorker.ts', import.meta.url), { type: 'module' })
  const waiting: ((answer: IncubatorAnswer | null) => void)[] = []
  worker.onmessage = (event: MessageEvent<IncubatorAnswer>): void => {
    const answer = event.data
    if (answer.type === 'failed') console.warn(`[incubator] the worker failed: ${answer.message}`)
    waiting.shift()?.(answer.type === 'failed' ? null : answer)
  }
  worker.onerror = (event): void => {
    console.warn(`[incubator] the worker failed: ${event.message}`)
    while (waiting.length > 0) waiting.shift()?.(null)
  }
  return {
    ask: (request) => new Promise((resolve) => {
      waiting.push(resolve)
      worker.postMessage(request)
    }),
    dispose: () => worker.terminate(),
  }
}

// The lifeways' names (settleShared.ts LIFEWAY).
const LIFEWAY_KEYS: Record<number, TKey> = { 1: 'incubator.lifeway.foragers', 2: 'incubator.lifeway.fishers', 3: 'incubator.lifeway.herders', 4: 'incubator.lifeway.farmers' }

// The people step's switches (rows) and its pick of what the settled land
// shows (SETTLEMENT_PICKS), as the generator's layers.
const PEOPLE_ROWS: readonly { id: string; helpBase: string; icon: string }[] = [
  { id: 'people:routes', helpBase: 'incubator.people.routes', icon: '/icons/river.png' },
  { id: 'people:trade', helpBase: 'incubator.people.trade', icon: '/icons/trade.png' },
  { id: 'people:villages', helpBase: 'incubator.people.villages', icon: '/icons/village.png' },
  { id: 'people:centres', helpBase: 'incubator.people.centres', icon: '/icons/origin.png' },
  { id: 'people:sources', helpBase: 'incubator.people.sources', icon: '/icons/stone_axe.png' },
]
type Settlement = 'spread' | 'lifeway' | 'density'
const NO_SETTLEMENT = 'none:settlement'

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
      peoplePlayer.relabel()
      showPlants()
      cameraTools.relabel()
      mapScales.relabel()
    },
  })
  titleBar.setWorld(null)

  const sidebar = createSidebar(root, 'incubator.step')

  // THE STEPS. Each shows its own layers (stepLayers): the flora the
  // plants and the wood, the fauna the animals, the testing the trial's
  // catchments; the terrain and the ecology all. What a step had on stays
  // for its return.
  let stepIndex = 0
  const onFlora = (): boolean => STEPS[stepIndex] === 'flora'
  const onTesting = (): boolean => STEPS[stepIndex] === 'testing'
  const onPeople = (): boolean => STEPS[stepIndex] === 'people'
  // True once the screen is built: the step's layers are below.
  let built = false
  const stepBar = createStepBar(root, {
    steps: STEPS.map((id) => (id === 'testing' ? { id, aside: true, mark: 'T' } : { id })),
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
  // The animals of animals.ts, and the use shown (the fauna's step).
  let animals: AnimalLayer[] | null = null
  let animalShown: AnimalUse | null = null
  // The people's spread (people.ts), the time shown (years from the
  // departure), its two layers, and the origin set by a click (-1: chosen).
  let people: PeopleResult | null = null
  let peopleArrows: PeopleArrow[] = []
  let peopleTime = SPAN_YEARS
  // What the settled land shows, and the people's switches.
  let settlementShown: Settlement | null = 'spread'
  const peopleOn: Record<string, boolean> = { 'people:routes': true, 'people:trade': false, 'people:villages': false, 'people:centres': true, 'people:sources': false }
  const routesOn = (): boolean => peopleOn['people:routes']
  let peopleOrigin = -1
  // The people's end state (settle.ts), a proof of concept.
  let settled: SettleResult | null = null
  // The composite last uploaded (showCharts), and the charts' version: a
  // new world's charts are a new composite.
  let uploadedBase = ''
  let baseVersion = 0
  // The overlay the trials paint (incubatorOverlay.ts), the world's.
  let overlay: OverlayRaster | null = null
  // The last blend, for showing it again without blending it again.
  let blended: { key: string; shaded: Uint8ClampedArray; unshaded: Uint8ClampedArray | null } | null = null
  const overlayList = createOverlayList({
    onToggle: (id) => {
      if (id in peopleOn) peopleOn[id] = !peopleOn[id]
      else terrainOn = !terrainOn
      showCharts()
      plantLegend.refresh()
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
        return
      }
      if (id === NO_SETTLEMENT || id.startsWith('settle:')) {
        settlementShown = id === NO_SETTLEMENT ? null : (id.slice('settle:'.length) as Settlement)
        showPlants()
        return
      }
      if (id === NO_ANIMALS || id.startsWith('animal:')) {
        animalShown = id === NO_ANIMALS ? null : (id.slice('animal:'.length) as AnimalUse)
        showPlants()
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
  const SETTLEMENT_PICKS = {
    title: 'incubator.section.settlement',
    rows: [
      { id: NO_SETTLEMENT, helpBase: 'overlay.none', icon: '/icons/clear.png' },
      { id: 'settle:spread', helpBase: 'incubator.people.spread', icon: '/icons/human.png' },
      { id: 'settle:lifeway', helpBase: 'incubator.people.lifeway', icon: '/icons/pastures.png' },
      { id: 'settle:density', helpBase: 'incubator.people.density', icon: '/icons/population.png' },
    ],
  }
  const ANIMAL_PICKS = {
    title: 'incubator.section.animals',
    rows: [
      { id: NO_ANIMALS, helpBase: 'overlay.none', icon: '/icons/clear.png' },
      ...ANIMAL_USES.map((p) => ({ id: animalPickId(p.use), helpBase: `animal.use.${p.use}`, icon: p.icon })),
    ],
  }
  sidebar.body.append(overlayList.element)
  // Under the picks, why the plants or the animals could not be grown.
  const plantStatus = document.createElement('p')
  const plantInfo = document.createElement('section')
  plantInfo.className = 'gen-overlays'
  plantInfo.append(plantStatus)
  sidebar.body.append(plantInfo)

  // THE TIME (steps 1 to 3): a slider over the span and under it the years
  // ago shown with a play button and the speed, in the column's foot as the
  // generator's months. Playing runs the span from its start, at 1×
  // YEARS_A_SECOND years a second, a frame every PEOPLE_FRAME_MS. The people's layers follow it; the flora and the fauna do not
  // yet.
  const YEARS_A_SECOND = 100
  const PEOPLE_FRAME_MS = 250
  const peopleSection = document.createElement('section')
  peopleSection.className = 'gen-overlays'
  const peopleRow = document.createElement('div')
  peopleRow.className = 'gen-month'
  // The speed, on the row's left where the generator keeps a spare: a press
  // steps through PLAY_SPEEDS.
  const PLAY_SPEEDS = [0.5, 1, 2, 4]
  let speedIndex = 1
  const speedButton = document.createElement('button')
  speedButton.type = 'button'
  speedButton.className = 'gen-action-icon'
  speedButton.dataset.help = 'incubator.people.speed'
  speedButton.dataset.tAria = 'incubator.people.speed.label'
  speedButton.style.font = 'inherit'
  speedButton.style.fontSize = '13px'
  const saySpeed = (): void => {
    const speed = PLAY_SPEEDS[speedIndex]
    speedButton.textContent = `${speed === 0.5 ? '½' : String(speed)}×`
    speedButton.setAttribute('aria-label', `${t('incubator.people.speed.label')} ${speedButton.textContent}`)
  }
  saySpeed()
  speedButton.addEventListener('click', () => {
    speedIndex = (speedIndex + 1) % PLAY_SPEEDS.length
    saySpeed()
  })
  const peopleLabel = document.createElement('span')
  peopleLabel.className = 'gen-month__label'
  const peopleButton = document.createElement('button')
  peopleButton.type = 'button'
  peopleButton.className = 'gen-action-icon'
  peopleButton.dataset.help = 'incubator.people.play'
  const peopleIcon = document.createElement('img')
  peopleIcon.alt = ''
  peopleButton.append(peopleIcon)
  peopleRow.append(speedButton, peopleLabel, peopleButton)
  const peopleSlider = document.createElement('input')
  peopleSlider.type = 'range'
  peopleSlider.className = 'gen-param__range'
  peopleSlider.min = '0'
  peopleSlider.max = String(SPAN_YEARS)
  peopleSlider.step = '100'
  peopleSection.append(peopleSlider, peopleRow)
  sidebar.foot.append(peopleSection)
  // THE ANIMALS AT THE TIME SHOWN (2026-10-26): as the fauna placed them
  // before people came; where people live by then, under their pressure by
  // the lifeway and the density of that time (settleShared.ts); a big game
  // gone from a landmass once its time came (settle.ts). Made per
  // animal for the time and kept for it.
  const animalsAtTime = new Map<string, { time: number; codes: Uint8Array; reached: number }>()
  function animalAtTime(animal: AnimalLayer): { codes: Uint8Array; reached: number } {
    if (!settled || !people) return animal
    const kept = animalsAtTime.get(animal.id)
    if (kept && kept.time === peopleTime) return kept
    const now = settledNow()
    const spec = ANIMALS.find((a) => a.id === animal.id)
    const hunted = spec ? spec.uses.includes('hunt') || spec.uses.includes('fur') : false
    const gone = new Set(settled.extinctions.filter((e) => e.id === animal.id && e.at <= peopleTime).map((e) => e.landmass))
    const codes = new Uint8Array(animal.codes.length)
    const shares = new Float32Array(5)
    let lives = 0
    let land = 0
    for (let i = 0; i < codes.length; i++) {
      if (settled.landmass[i] >= 0) land++
      let c = animal.codes[i]
      if (c >= 2 && gone.has(settled.landmass[i])) c = 1
      else if (c >= 2 && now && spec && now.lifeway[i]) {
        for (let w = 1; w < 5; w++) shares[w] = now.shares[4 * i + w - 1] / 255
        c = Math.max(2, 2 + Math.round((c - 2) * pressure(spec.role, hunted, shares, now.density[i])))
      }
      codes[i] = c
      if (c >= 2) lives++
    }
    const made = { time: peopleTime, codes, reached: land > 0 ? lives / land : 0 }
    animalsAtTime.set(animal.id, made)
    return made
  }
  // The end state's lifeways (the largest, and the shares: 4 a cell, the
  // lifeways 1 … 4, 0 … 255), density, villages and links at the time shown
  // (settleShared.ts), made for the time and kept for it.
  let settledAtTime: { time: number; lifeway: Uint8Array; shares: Uint8Array; density: Float32Array; villages: Int32Array; links: Float32Array } | null = null
  function settledNow(): NonNullable<typeof settledAtTime> | null {
    if (!settled || !people) return null
    if (settledAtTime?.time === peopleTime) return settledAtTime
    const times: SettleTimes = { arrival: people.arrival, farmAt: settled.farmAt, herdAt: settled.herdAt, fishOk: settled.fishOk, farmSuit: settled.farmSuit, herdSuit: settled.herdSuit, fishSuit: settled.fishSuit, carrying: settled.carrying }
    const n = people.arrival.length
    const lifeway = new Uint8Array(n)
    const shares = new Uint8Array(4 * n)
    const density = new Float32Array(n)
    const cell = new Float32Array(5)
    for (let i = 0; i < n; i++) {
      if (!(people.arrival[i] <= peopleTime) || !people.land[i]) continue
      lifeway[i] = sharesAt(times, i, peopleTime, cell)
      density[i] = densityAt(times, i, peopleTime, cell)
      for (let w = 1; w < 5; w++) shares[4 * i + w - 1] = Math.round(cell[w] * 255)
    }
    // The villages there by now; the links between two of them, their
    // indices into the end state's villages kept.
    const villages: number[] = []
    for (let v = 0; v < settled.villageFrom.length; v++) if (settled.villageFrom[v] <= peopleTime) villages.push(settled.villages[2 * v], settled.villages[2 * v + 1])
    const links: number[] = []
    for (let k = 0; k < settled.links.length; k += 3) {
      if (settled.villageFrom[settled.links[k]] <= peopleTime && settled.villageFrom[settled.links[k + 1]] <= peopleTime) links.push(settled.links[k], settled.links[k + 1], settled.links[k + 2])
    }
    settledAtTime = { time: peopleTime, lifeway, shares, density, villages: Int32Array.from(villages), links: Float32Array.from(links) }
    return settledAtTime
  }
  // The animals shown, at the time shown.
  function shownAnimals(): AnimalLayer[] | null {
    if (!animals) return null
    return animals.map((a) => ({ ...a, ...animalAtTime(a) }))
  }

  const peoplePlayer = (() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const sayButton = (): void => {
      const key: TKey = timer ? 'incubator.people.play.labelActive' : 'incubator.people.play.label'
      peopleButton.dataset.tAria = key
      peopleButton.setAttribute('aria-label', t(key))
      peopleButton.setAttribute('aria-pressed', String(timer !== null))
      peopleIcon.src = timer ? '/icons/stop.png' : '/icons/play.png'
    }
    const say = (): void => {
      const ago = Math.round((PEOPLE_AGO_AT_START - peopleTime) / 100) * 100
      peopleLabel.textContent = t('incubator.people.time', { years: ago.toLocaleString(getLocale()) })
    }
    const player = {
      show(time: number): void {
        peopleTime = Math.min(SPAN_YEARS, Math.max(0, time))
        peopleSlider.value = String(peopleTime)
        say()
        if (people) showPlants()
      },
      stop(): void {
        if (timer) clearInterval(timer)
        timer = null
        sayButton()
      },
      relabel(): void {
        say()
        sayButton()
        saySpeed()
      },
    }
    peopleButton.addEventListener('click', () => {
      if (timer) {
        player.stop()
        return
      }
      if (peopleTime >= SPAN_YEARS) player.show(0)
      timer = setInterval(() => {
        player.show(peopleTime + YEARS_A_SECOND * (PEOPLE_FRAME_MS / 1000) * PLAY_SPEEDS[speedIndex])
        if (peopleTime >= SPAN_YEARS) player.stop()
      }, PEOPLE_FRAME_MS)
      sayButton()
    })
    peopleSlider.addEventListener('input', () => {
      player.stop()
      player.show(Number(peopleSlider.value))
    })
    return player
  })()
  peoplePlayer.relabel()
  // A click on the map (not a drag) sets the people's origin there.
  let pressAt: { x: number; y: number } | null = null
  const onPress = (e: PointerEvent): void => {
    pressAt = { x: e.clientX, y: e.clientY }
  }
  const onRelease = (e: PointerEvent): void => {
    const press = pressAt
    pressAt = null
    if (!press || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4 || !onPeople() || !overlay || !view) return
    const rect = ctx.canvas.getBoundingClientRect()
    const at = view.groundAt(e.clientX - rect.left, e.clientY - rect.top)
    if (!at) return
    const ox = Math.min(overlay.width - 1, Math.floor(at.u * overlay.width))
    const oy = Math.min(overlay.height - 1, Math.floor(at.v * overlay.height))
    peopleOrigin = overlay.owners[oy * overlay.width + ox]
    void growPeople()
  }
  ctx.canvas.addEventListener('pointerdown', onPress)
  ctx.canvas.addEventListener('pointerup', onRelease)
  function showCharts(): void {
    overlayList.refresh((id) => {
      if (id === 'terrain') return { on: terrainOn, available: charts !== null }
      if (id in peopleOn) return { on: peopleOn[id], available: id === 'people:routes' ? people !== null : settled !== null }
      if (id === NO_SETTLEMENT) return { on: settlementShown === null, available: true }
      if (id.startsWith('settle:')) return { on: id === `settle:${settlementShown}`, available: id === 'settle:spread' ? people !== null : settled !== null }
      if (id === NO_FIELD) return { on: picked === null, available: true }
      if (id === NO_PLANTS) return { on: plantShown === null, available: true }
      if (id.startsWith('plant:')) return { on: plantShown !== null && id === plantPickId(plantShown), available: charts !== null }
      if (id === NO_WOOD) return { on: woodShown === null, available: true }
      if (id.startsWith('wood:')) return { on: woodShown !== null && id === woodPickId(woodShown), available: charts !== null }
      if (id === NO_ANIMALS) return { on: animalShown === null, available: true }
      if (id.startsWith('animal:')) return { on: animalShown !== null && id === animalPickId(animalShown), available: charts !== null }
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
    // The composite goes up only when it changed: the layers over it are
    // the overlay's (paintOverlay).
    const key = `${terrainOn},${picked},${baseVersion}`
    if (uploadedBase !== key) {
      uploadedBase = key
      // The globe is lit by the sphere's normal alone: it wears the
      // composite WITH the hillshade, or the level's relief would not show.
      if (view.shape === 'sphere') view.reliefTexture.update(shaded)
      else {
        view.baseTexture.update(shaded)
        view.reliefTexture.update(unshaded!)
      }
    }
    paintOverlay()
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
        // The trials' rows at the world cell under the pointer.
        ...(overlay ? stepTrials().flatMap((l) => l.probe(overlay!.owners[(y >> 1) * overlay!.width + (x >> 1)])) : []),
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
      const cut = await cutRegions({ kind: shown.kind, width: shown.width, height: shown.height, chartWidth: CHART_WIDTH / OVERLAY_DIVISOR, chartHeight: CHART_HEIGHT / OVERLAY_DIVISOR, level: shown.level, worldAreaM2: shown.worldAreaM2, minAreaKm2 })
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

  let shownWorld: World | null = null



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
  function shownGroup(): { title: string; from: number; layers: { name: string; codes: Uint8Array; reached: number; colour: number }[] } | null {
    if (onTesting() || onPeople()) return null
    if (!onFlora()) {
      const animals = shownAnimals()
      if (!animals || !animalShown) return null
      const use = animalShown
      return {
        title: t(`animal.use.${use}.label` as TKey),
        from: 2,
        layers: animals.flatMap((l, k) => (l.uses.includes(use) ? [{ name: t(`animal.${l.id}.label` as TKey), codes: l.codes, reached: l.reached, colour: k }] : [])),
      }
    }
    if (!plants) return null
    if (plantShown) {
      const use = plantShown
      return {
        title: t(`plant.use.${use}.label` as TKey),
        from: PLANT_SUITS,
        layers: plants.layers.filter((l) => l.use === use).map((l, k) => ({ name: t(`plant.${l.id}.label` as TKey), codes: l.codes, reached: l.reached, colour: k })),
      }
    }
    if (woodShown) {
      const use = woodShown
      return {
        title: t(`wood.use.${use}.label` as TKey),
        from: PLANT_SUITS,
        layers: plants.trees.flatMap((l, k) => (l.woods.includes(use) ? [{ name: t(`wood.${l.id}.label` as TKey), codes: l.codes, reached: l.reached, colour: k }] : [])),
      }
    }
    return null
  }
  const plantLegend = createLegendPanel(root, {
    content: () => {
      const specs = activeTrials().flatMap((l) => l.legend())
      return { count: specs.length, build: () => specs }
    },
  })
  // The plants and the trees grow by themselves once a world is shown,
  // in the background, the pill saying so; a pick shows them once they
  // are there. Each world asks again; an answer for an older one is
  // dropped.
  const progressPill = createProgressPill(root)
  const incubator = createIncubatorClient()
  // The cells of the world shown (cells.ts): the texel each shows of the
  // overlay, their centres; null before they are made or without level
  // 1's land fields.
  let cellsInput: Extract<IncubatorRequest, { type: 'cells' }> | null = null
  // A step's work in the worker under the pill; the world it was asked for
  // still shown, or nothing.
  async function work<T extends IncubatorAnswer['type']>(label: string, request: IncubatorRequest, type: T): Promise<Extract<IncubatorAnswer, { type: T }> | null> {
    const world = shownWorld
    progressPill.show({ label, sub: null, fraction: null, aria: t('generator.progress.ariaRunning', { step: label }) })
    const answer = await incubator.ask(request)
    if (shownWorld !== world) return null
    progressPill.hide()
    if (!answer || answer.type !== type) {
      plantStatus.textContent = t('incubator.plants.failed')
      return null
    }
    console.info(`[incubator] ${type}, ${answer.type === 'failed' ? 0 : answer.ms} ms`)
    return answer as Extract<IncubatorAnswer, { type: T }>
  }
  // The world's steps in turn: the cells, the flora, the fauna, the people
  // and their settlement.
  async function growWorld(): Promise<void> {
    if (!cellsInput) {
      console.warn('[incubator] the habitat needs level 1\'s land fields')
      plantStatus.textContent = t('incubator.plants.missing')
      return
    }
    const cells = await work(t('incubator.step.flora.label'), cellsInput, 'cells')
    if (!cells) return
    overlay = { data: new Uint8ClampedArray(cells.owners.length * 4), width: CHART_WIDTH / OVERLAY_DIVISOR, height: CHART_HEIGHT / OVERLAY_DIVISOR, owners: cells.owners, count: cells.count, u: cells.u, v: cells.v }
    const flora = await work(t('incubator.step.flora.label'), { type: 'flora' }, 'flora')
    if (!flora) return
    plants = { layers: flora.plants, trees: flora.trees }
    hoverTooltip.refresh()
    showPlants()
    const fauna = await work(t('incubator.step.fauna.label'), { type: 'fauna' }, 'fauna')
    if (!fauna) return
    animals = fauna.animals
    hoverTooltip.refresh()
    showPlants()
    await growPeople()
  }
  // The people, from the origin clicked or chosen, then their settlement.
  async function growPeople(): Promise<void> {
    if (!overlay) return
    const done = await work(t('incubator.step.people.label'), { type: 'people', origin: peopleOrigin }, 'people')
    if (!done || !overlay) return
    people = { arrival: done.arrival, land: done.land, from: done.from, flow: done.flow, origin: done.origin }
    peopleArrows = arrowsOf(people, overlay.u, overlay.v, overlay.width, overlay.height)
    showPlants()
    const result = await work(t('incubator.step.people.label'), { type: 'settle' }, 'settle')
    if (!result) return
    const { type: _type, ms: _ms, ...rest } = result
    settled = rest
    settledAtTime = null
    animalsAtTime.clear()
    showPlants()
  }
  // The picks' plants, wood or animals on the map, and their legend.
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

  // The animals at a cell of the world raster, by use: those that live
  // there, the most first. Empty before the animals are placed.
  function animalsAt(cell: number): { label: string; names: string[] }[] {
    const animals = shownAnimals()
    if (!animals) return []
    const here = animals.filter((l) => l.codes[cell] >= 2).sort((p, q) => q.codes[cell] - p.codes[cell])
    return ANIMAL_USES.map(({ use }) => ({ label: t(`animal.use.${use}.label` as TKey), names: here.filter((l) => l.uses.includes(use)).map((l) => t(`animal.${l.id}.label` as TKey)) })).filter((g) => g.names.length > 0)
  }

  // THE TRIALS' LAYERS, as the generator's table of its layers
  // (overlayReadout): per layer the steps that offer it, whether it draws
  // now, how it paints the overlay, its legend and its hover rows. The
  // overlay, the legend and the hover card derive from it.
  interface TrialLayer {
    steps: readonly (typeof STEPS)[number][]
    on(): boolean
    paint(o: OverlayRaster): void
    legend(): LegendSpec[]
    // The rows at a world cell, whether drawn or not.
    probe(cell: number): ProbeRow[]
  }
  // A group's swatches: each layer's name and the share of the land it
  // reached, whole percent, the ones that grow nowhere left out.
  const groupLegend = (group: NonNullable<ReturnType<typeof shownGroup>>): LegendSpec => ({
    type: 'swatches',
    title: group.title,
    items: group.layers.flatMap((layer) => layer.reached === 0 ? [] : [{
      label: `${layer.name} (${formatValue(layer.reached < 0.005 ? '<1' : String(Math.round(100 * layer.reached)), 'common.unit.percent')})`,
      rgb: [...PLANT_PALETTE[layer.colour % PLANT_PALETTE.length]] as [number, number, number],
    }]),
  })
  const groupRows = (groups: { label: string; names: string[] }[]): ProbeRow[] => groups.flatMap((g) => g.names.map((name, k) => ({ label: k === 0 ? g.label : '', value: name })))
  const groupLayer = (steps: TrialLayer['steps'], at: (cell: number) => { label: string; names: string[] }[]): TrialLayer => ({
    steps,
    on: () => shownGroup() !== null,
    paint: (o) => {
      const group = shownGroup()
      if (group) paintGroup(o, group.layers, group.from)
    },
    legend: () => {
      const group = shownGroup()
      return group ? [groupLegend(group)] : []
    },
    probe: (cell) => groupRows(at(cell)),
  })
  const TRIALS: readonly TrialLayer[] = [
    groupLayer(['flora'], plantsAt),
    groupLayer(['fauna'], animalsAt),
    {
      steps: ['people'],
      on: () => people !== null,
      paint: (o) => {
        if (people) paintPeople(o, people, peopleArrows, peopleTime, settlementShown === 'spread', routesOn())
      },
      legend: () => {
        const spreadOn = settlementShown === 'spread'
        if (!people || (!spreadOn && !routesOn())) return []
        const routes = routesOn() ? [{ label: t('incubator.people.routes.label'), rgb: [...PEOPLE_ROUTE] as [number, number, number], shape: 'line' as const }] : []
        // The ramp as the years before the game the land was settled.
        return [spreadOn
          ? { type: 'gradient', title: t('incubator.people.time', { years: '…' }), unit: '', stops: PEOPLE_AGE_STOPS.map((s) => ({ value: s.value, rgb: [...s.rgb] as [number, number, number] })), items: routes }
          : { type: 'swatches', title: t('incubator.step.people.label'), items: routes }]
      },
      probe: () => [],
    },
    {
      // TRIAL: the end state, drawn over the spread.
      steps: ['people'],
      on: () => settled !== null && (settlementShown === 'lifeway' || settlementShown === 'density' || peopleOn['people:trade'] || peopleOn['people:centres']),
      paint: (o) => {
        if (!settled) return
        const now = settledNow()
        if (!now) return
        if (settlementShown === 'lifeway') paintLifeways(o, now.shares)
        if (settlementShown === 'density') paintDensity(o, now.density)
        if (peopleOn['people:trade']) paintTrade(o, settled.villages, now.links)
      },
      legend: () => {
        if (!settled) return []
        const specs: LegendSpec[] = []
        if (settlementShown === 'lifeway') specs.push({ type: 'swatches', title: t('incubator.people.lifeway.label'), items: [1, 2, 3, 4].map((w) => ({ label: t(LIFEWAY_KEYS[w]), rgb: [...LIFEWAY_COLOURS[w]] as [number, number, number] })) })
        if (settlementShown === 'density') specs.push({ type: 'gradient', title: t('incubator.people.densityUnit'), unit: '', stops: DENSITY_STOPS.map((s) => ({ value: s.value, rgb: [...s.rgb] as [number, number, number] })) })
        if (peopleOn['people:centres']) {
          specs.push({ type: 'swatches', title: t('incubator.people.centres.label'), items: [
            { label: t('incubator.people.origin'), rgb: [220, 30, 30], shape: 'ring' },
            { label: t('incubator.people.farmCentre'), rgb: [...LIFEWAY_COLOURS[LIFEWAY.farmers]] as [number, number, number], shape: 'ring' },
            { label: t('incubator.people.herdCentre'), rgb: [...LIFEWAY_COLOURS[LIFEWAY.herders]] as [number, number, number], shape: 'ring' },
          ] })
        }
        if (peopleOn['people:trade'] || peopleOn['people:sources']) specs.push({ type: 'swatches', title: t('incubator.people.trade.label'), items: [...(peopleOn['people:trade'] ? [{ label: t('incubator.people.trade.label'), rgb: [...TRADE_COLOUR] as [number, number, number], shape: 'line' as const }] : []), ...(peopleOn['people:sources'] ? GOODS.map((g, k) => ({ label: t(`resource.${g}.label` as TKey), rgb: [...GOOD_COLOURS[k]] as [number, number, number] })) : [])] })
        return specs
      },
      probe: (cell) => {
        const now = settledNow()
        if (!now || !now.lifeway[cell]) return []
        // The lifeways of a share of 5 % or more, the largest first.
        const ways = [1, 2, 3, 4].filter((w) => now.shares[4 * cell + w - 1] >= 13).sort((a, b) => now.shares[4 * cell + b - 1] - now.shares[4 * cell + a - 1])
        return [
          ...ways.map((w) => ({ label: t(LIFEWAY_KEYS[w]), value: `${Math.round((100 * now.shares[4 * cell + w - 1]) / 255)} %` })),
          { label: t('incubator.people.density.label'), value: `${now.density[cell].toFixed(2)} ${t('incubator.people.densityUnit')}` },
        ]
      },
    },
    {
      steps: ['testing'],
      on: () => regionBox.checked && regionCut !== null,
      paint: (o) => {
        if (regionCut) paintRaster(o, regionCut.overlay)
      },
      legend: () => [],
      probe: () => [],
    },
  ]
  const stepTrials = (): TrialLayer[] => TRIALS.filter((l) => l.steps.includes(STEPS[stepIndex]))
  const activeTrials = (): TrialLayer[] => stepTrials().filter((l) => l.on())

  // THE MARKS (incubatorSymbols.ts) of the people step: the sources, the
  // villages, the farming's and the herding's centres, the origin, in that
  // order from below; the centres and the origin on one switch (Zentren);
  // each view is given the pictures once.
  const marked = new WeakSet<WorldView>()
  function syncMarks(): void {
    if (!view || !overlay) return
    const sources = view.symbols('incubator-sources')
    const villages = view.symbols('incubator-villages')
    const centres = view.symbols('incubator-centres')
    const origin = view.symbols('incubator-origin')
    if (!marked.has(view)) {
      sources.setPictures(sourcePictures())
      villages.setPictures(villagePictures())
      centres.setPictures(centrePictures())
      origin.setPictures(originPictures())
      marked.add(view)
    }
    const { u, v } = overlay
    const now = onPeople() ? settledNow() : null
    const showSources = now !== null && settled !== null && peopleOn['people:sources']
    sources.setSymbols(showSources ? Array.from({ length: settled!.sources.length / 2 }, (_, k) => ({ at: cellPoint(settled!.sources[2 * k], u, v), picture: settled!.sources[2 * k + 1] })) : [])
    sources.setEnabled(showSources)
    const showVillages = now !== null && peopleOn['people:villages']
    villages.setSymbols(showVillages ? villageSymbols(now!.villages, now!.density, u, v) : [])
    villages.setEnabled(showVillages)
    const showCentres = now !== null && settled !== null && peopleOn['people:centres']
    const centreSymbols: WorldSymbol[] = []
    if (showCentres) {
      for (let k = 0; k < settled!.centres.length; k += 3) {
        if (settled!.centres[k + 1] <= peopleTime) centreSymbols.push({ at: cellPoint(settled!.centres[k], u, v), picture: settled!.centres[k + 2] === LIFEWAY.farmers ? 0 : 1 })
      }
    }
    centres.setSymbols(centreSymbols)
    centres.setEnabled(showCentres)
    const showOrigin = onPeople() && people !== null && people.origin >= 0 && peopleOn['people:centres']
    origin.setSymbols(showOrigin ? [{ at: cellPoint(people!.origin, u, v), picture: 0 }] : [])
    origin.setEnabled(showOrigin)
  }

  // The overlay from the step's layers that draw now; none, none at all.
  function paintOverlay(): void {
    if (!view) return
    syncMarks()
    const active = activeTrials()
    if (!overlay || active.length === 0) {
      view.setOverlay(null, 0, 0)
      return
    }
    clearOverlay(overlay)
    for (const layer of active) layer.paint(overlay)
    view.setOverlay(new Uint8Array(overlay.data.buffer), overlay.width, overlay.height)
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
    baseVersion++
    overlay = null
    // The cells' input: the node map and level 1's land fields, copied on
    // the way to the worker.
    cellsInput = land && painted.nodes
      ? {
        type: 'cells', seed: world.recipe.detailSeed, kind, width: world.width, height: world.height,
        nodes: painted.nodes, nodeW: CHART_WIDTH / OVERLAY_DIVISOR, nodeH: CHART_HEIGHT / OVERLAY_DIVISOR,
        land: land.land, biome: land.biome, koppen: land.koppen, z: level.z, lakeDepth: land.lakeDepth,
        ecology: Object.fromEntries((['game', 'carryingCapacity', ...LEVEL_ECOLOGY] as const).flatMap((id) => (land.ecology[id] ? [[id, land.ecology[id]]] : []))),
        rivers: level.rivers,
      }
      : null
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
    }
    regionCut = null
    shownWorld = world
    plants = null
    animals = null
    people = null
    settled = null
    peopleOrigin = -1
    peoplePlayer.stop()
    peoplePlayer.show(SPAN_YEARS)
    plantStatus.textContent = ''
    plantLegend.refresh()
    if (regionBox.checked) void showRegions()
    void growWorld()
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
    const picks = onFlora() ? [RESOURCE_PICKS, PLANT_PICKS, WOOD_PICKS] : onTesting() ? [RESOURCE_PICKS] : [RESOURCE_PICKS, ANIMAL_PICKS]
    const rows = [{ id: 'terrain', helpBase: overlayKey('terrain'), icon: OVERLAY_META.terrain.icon }]
    if (onPeople()) rows.push(...PEOPLE_ROWS)
    overlayList.setRows(rows, onPeople() ? [SETTLEMENT_PICKS, RESOURCE_PICKS] : picks)
    peopleSection.hidden = onTesting()
    if (onTesting()) peoplePlayer.stop()
    regionSection.hidden = !onTesting()
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
      incubator.dispose()
      peoplePlayer.stop()
      ctx.canvas.removeEventListener('pointerdown', onPress)
      ctx.canvas.removeEventListener('pointerup', onRelease)
      hoverTooltip.dispose()
      serverIndicator.dispose()
      // A view disposes its own camera and its listeners on the shared
      // canvas with its scene.
      view?.dispose()
      idleScene.dispose()
    },
  }
}
