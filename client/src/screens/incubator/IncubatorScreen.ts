import { Color4, FreeCamera, Scene, Vector3 } from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { domainOfKind } from '../../generator/core/domain'
import { loadWasmEngine } from '../../generator/pipeline/engineWasm'
import { relabel } from '../../i18n/relabel'
import { createFlatWorldView } from '../../map/flatWorldView'
import { createCameraTools } from '../../map/cameraTools'
import { createMapScales } from '../../map/mapScales'
import { createGlobeWorldView, type GlobeWorldView } from '../../map/sphereView'
import { weatherParamsFrom } from '../../world/runParams'
import type { WorldSymbol, WorldView } from '../../map/worldView'
import { listServerArtifacts, type ServerArtifact } from '../../server/artifactsClient'
import { fetchWorld, listWorlds } from '../../server/worldClient'
import { peekServerStatus } from '../../server/serverStatus'
import { artifactKey } from '../../storage/ArtifactStore'
import { getArtifactStore, getServerArtifactStore } from '../../storage/artifactStoreProvider'
import { historyInputs, historyKey, PEOPLING_DEFAULTS, peoplingInput, readHistoryArtifact, samePeopling, type PeoplingInput } from '../../world/historyArtifacts'
import { meshLevelStage, readMeshLevelArtifact } from '../../world/meshArtifacts'
import { isCurrentArtifact } from '../../world/levels'
import { sameWorldsPipeline } from '../../world/worldPipeline'
import { openWorld } from '../../world/query'
import { createHelpTooltip } from '../../ui/help/HelpTooltip'
import { createServerIndicator } from '../../ui/serverIndicator/ServerIndicator'
import { createSidebar } from '../../ui/sidebar/Sidebar'
import { createTitleBar } from '../../ui/titleBar/TitleBar'
import { createPanelToggles } from '../../ui/titleBar/PanelToggles'
import { createWorldChooser, type OpenedCopy } from '../../ui/worldChooser/WorldChooser'
import { createLoadPanel } from '../../ui/loadPanel/LoadPanel'
import { formatBytes } from '../../ui/format'
import { ARTIFACTS_ICON, createArtifactChooser, reportCommission } from '../../ui/artifactChooser/ArtifactChooser'
import { createJobChooser, JOBS_ICON } from '../../ui/jobChooser/JobChooser'
import { BOOK_ICON, createHandbookPanel } from '../../ui/handbook/HandbookPanel'
import { createLayerPanel } from '../../ui/layerPanel/LayerPanel'
import { createLanguagePanel, LANGUAGES_ICON } from '../../ui/languagePanel/LanguagePanel'
import type { LanguageView } from '../../ui/languagePanel/languageTypes'
import { createWindowSet } from '../../ui/windows/windowSet'
import type { LayerState } from '../../ui/layerPanel/layerTypes'
import { ANIMAL_USES, OVERLAY_GROUPS, OVERLAY_PANEL_TEXTS, PLANT_USES, favouritesToTurnOn, WOOD_USES, animalLayerId, isNoneLayer, overlayGroupOf, plantLayerId, resourceLayerId, woodLayerId, type AnimalUse, type OverlayGroupId, type PlantUse, type WoodUse } from '../../map/overlayGroups'
import { CURRENT_GAP, CURRENT_LENGTH, currentPictures, currentSymbols, hotspotSymbols, nameSymbols, volcanoSymbols, WIND_GAP, WIND_LENGTH, windPictures, windSymbols, type ChartSize, type VolcanoMark } from '../generator/mapSymbols'
import { Biome } from '../../generator/climate/biomes'
import { OCEAN_PRECIP } from '../../generator/climate/precipitation'
import { CLIMATE_WASHES, climateWashAvailable, climateWashLegend, paintClimateWash, type ClimateClasses, type ClimateFields, type ClimateWash } from '../../map/climateLayers'
import { cratonAgeLegend, hotspotLegend, mantleLegend, mantleRaster, paintCratonAge, paintMantle, volcanoLegend, type MantleRaster } from '../../map/geologyLayers'
import { computeRaftLabelPlacements } from '../../generator/render/raftLabelLayout'
import { chartRefined, currentClass, currentMarks, paintPressure, paintSea, paintWeather, paintWindCalm, pressureLegend, pressurePicture, seaLegend, SEA_LAYERS, WEATHER_LAYERS, weatherLegend, windMarks, type PressurePicture, type RefinedCharts, type SeaLayer, type WeatherLayer } from '../../map/refinedLayers'
import type { Domain } from '../../generator/core/domain'
import { createStepBar } from '../generator/StepBar'
import { formatValue, getLocale, t, type TKey } from '../../i18n/i18n'
import { createMapHoverTooltip } from '../../map/MapHoverTooltip'
import { buildProbeCard } from '../../ui/mapProbe/probeCard'
import { elevationToMeters } from '../../generator/elevation/elevationScale'
import { koppenLabelKey } from '../../generator/climate/koppen'
import { biomeLabelKey } from '../../generator/climate/biomes'
import type { ChartWorkerInbound, ChartWorkerOutbound } from './chartWorker'
import { decodeFineValue, ECOLOGY_FIELD_IDS, ECOLOGY_FINE_OCEAN, type EcologyFieldId } from '../../generator/ecology/ecologyField'
import { ECOLOGY_FIELD_META, ecologyFieldColor } from '../../generator/ecology/ecologyColors'
import { levelTemperatureYear, type LevelLand } from '../../world/meshArtifacts'
import { POPULATION_STEP, type AnimalLayer, type PeopleResult, type PlantLayer, type SettleResult, type TreeLayer } from './cellsShared'
import { KEEP_YEARS, SPAN_YEARS } from './peopleShared'
import { flowAt, routeOrder, routesOf, type RouteLine } from './peopleArrows'
import type { LogEvent } from './historyLogShared'
import { CAME_STEP, clearedAt, clearedOf, densityAt, extinctAt, GOODS, LIFEWAY, pressure, sharesAt, type SettleTimes } from './settleShared'
import { ANIMALS } from './animals'
import { campPictures, campSymbols, cellPoint, centrePictures, hamletPictures, hamletSymbols, isCampWay, crossingPictures, crossingSymbols, originPictures, routePictures, routeSymbols, sourcePictures, tradePictures, tradeSymbols, villagePictures, villageSymbols, type LineGeometry } from './incubatorSymbols'
import { clearOverlay, OVERLAY_DIVISOR, paintDensity, paintGroup, paintGroups, paintLifeways, paintPeople, paintPeoples, peopleColours, putTexel, washTarget, DENSITY_STOPS, GOOD_COLOURS, LIFEWAY_COLOURS, TRADE_COLOUR, PEOPLE_AGE_STOPS, PEOPLE_ROUTE, PLANT_PALETTE, PLANT_SUITS, type OverlayRaster } from './incubatorOverlay'
import type { LegendItem, LegendSpec } from '../../ui/legend/LegendPanel'
import type { ProbeRow } from '../../ui/mapProbe/probeCard'
import type { World } from '../../world/query'
import type { ChartPoint } from '../../map/worldView'
import type { IncubatorAnswer, IncubatorRequest, PeoplesWithoutIds, PeoplingControls } from './incubatorWorker'
import { NAME_KINDS, NO_PEOPLE } from './historyPack'
import { createChroniclePanel, type ChronicleEvent } from './chroniclePanel'
import { deriveLanguageView, nameAt, peopleCentre, type HistoryLanguages, type LanguagePlaces } from './languageView'
import { cellInputOf, CHART_HEIGHT, CHART_WIDTH, rainOf, type HistoryRain } from './historyInput'
import { createLegendPanel } from '../../ui/legend/LegendPanel'
import { createProgressPill } from '../../ui/progressPill/ProgressPill'
import '../../ui/theme/design.css'
// The generator's overlay section, for the plants' notes.
import '../generator/overlayList.css'

// THE INCUBATOR: the step between the generator and the game. The generator
// makes a world; the incubator will grow its prehistory — not the geological
// one, the human one: peoples, their spread, what they did before the game
// starts. It takes the place of the migration step the generator had.
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
// from 1: the world is chosen in the list, not in a step. 1 the old stone
// age (2026-10-27, docs/design/prehistory-in-three-steps.md) — where people
// could go and when, a graph, not a simulation; 2 the people — the
// history, from one origin over the world, played. The flora and the
// fauna were steps 1 and 2 until 2026-10-26: they are grown on the way in
// now (growWorld), their layers in the panel in every step. The terrain colour is a layer that can
// be switched off: then the land is the bare paper, white with its
// hillshade, as on the generator's map. The load panel shows the steps of an
// open and which one failed; why it failed goes to the console. Over the
// map, the generator's hover card for the level's node under the pointer.

// The incubator's steps, in order; their names are `incubator.step.<id>`.
const STEPS = ['oldStoneAge', 'newStoneAge'] as const

// THE STEPS' FAVOURITES (2026-10-28): the layer panel's first group, rows of
// map/overlayGroups.ts. A step sets them and nothing else of the
// layers; they are what comes on as a world opens and on the panel's
// "Defaults", everything else off (favouritesToTurnOn: of a group of one
// choice, the first listed).
const FAVOURITES: Record<(typeof STEPS)[number], readonly string[]> = {
  oldStoneAge: ['people:routes', 'people:centres', 'settle:spread', 'settle:groups', 'settle:density'],
  newStoneAge: ['people:routes', 'people:villages', 'people:centres', 'settle:lifeway', 'settle:density'],
}

// The ecology's fields the incubator shows: all fourteen the level's
// artifact holds (docs/decisions/level-waters.md), their rows the shared
// list's (map/overlayGroups.ts). The tooltip names TOOLTIP_FIELDS and
// the one picked.
const TOOLTIP_FIELDS: readonly EcologyFieldId[] = ['carryingCapacity', 'arable']

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
      // A packed history (300 MB) is handed over, not copied.
      worker.postMessage(request, request.type === 'restore' ? [request.bytes] : [])
    }),
    dispose: () => worker.terminate(),
  }
}

// The lifeways' names (settleShared.ts LIFEWAY).
const LIFEWAY_KEYS: Record<number, TKey> = { 1: 'incubator.lifeway.foragers', 2: 'incubator.lifeway.fishers', 3: 'incubator.lifeway.herders', 4: 'incubator.lifeway.farmers' }

type Settlement = 'spread' | 'groups' | 'peoples' | 'lifeway' | 'density'

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
      { key: 'titlebar.jobs', icon: JOBS_ICON, onSelect: () => windows.open(jobChooser) },
      { key: 'common.action.storage', icon: ARTIFACTS_ICON, onSelect: () => windows.open(artifactChooser) },
      // The languages' full layout, as the window it is (languagePanel, below).
      { key: 'titlebar.languages', icon: LANGUAGES_ICON, onSelect: () => windows.open(languagePanel) },
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
      panelToggles.relabel()
      updateSteps()
      overlayList.relabel()
      chronicle.relabel()
      languagePanel.relabel()
      sayChronicle()
      // The crossings' years are pictures: made again in the new language.
      crossingWays = null
      showPlants()
      cameraTools.relabel()
      mapScales.relabel()
    },
  })
  titleBar.setWorldShown(false)

  const sidebar = createSidebar(root, 'incubator.step')
  // THE CHRONICLE (chroniclePanel.ts, DES-0031): the time and its playback
  // on the right, in every step; a click on an event goes to its time and
  // its place (eventPlaces).
  const eventPlaces = new Map<ChronicleEvent, ChartPoint>()
  const chronicle = createChroniclePanel(root, {
    span: SPAN_YEARS,
    onTime: (time) => {
      peopleTime = time
      languagePanel.setTime(time)
      if (people) showPlants()
      sayCounts()
    },
    onEvent: (event) => {
      const at = eventPlaces.get(event)
      if (at) view?.lookAt(at)
    },
  })

  // THE LANGUAGES (ui/languagePanel, TEG-140, DES-0033), read only: a
  // column beside the chronicle, shown by its switch (showPanels), and a
  // full view, a window as the artifacts and the jobs (`windows`). Its view
  // is the history's languages (languageView.ts; showLanguages), or the
  // fixture (`?languages=fixture`, below).
  const languagePanel = createLanguagePanel(root, {
    // The map's colouring of the peoples selected comes with the languages
    // of the world (a later step of TEG-135 ff.).
    onSelect: () => {},
    onShowOnMap: (target) => {
      if (!overlay) return
      const tree = peoples?.tree
      const node = 'language' in target ? languageView?.nodes.find((n) => n.id === target.language) : undefined
      const cell = 'cell' in target ? target.cell : tree && node && !languageFixture ? peopleCentre(tree, node.peoples, frameIndex()) : -1
      if (cell >= 0) view?.lookAt(cellPoint(cell, overlay.u, overlay.v))
    },
    onLayout: (layout) => (layout === 'full' ? windows.open(languagePanel) : windows.close(languagePanel)),
  })
  // The time as the chronicle starts (peopleTime, below).
  languagePanel.setTime(SPAN_YEARS)
  let languageView: LanguageView | null = null
  // The tree and the log the view was made from, to make it again only
  // when one of them changes.
  let languagesFrom: { tree: unknown; log: unknown } = { tree: null, log: null }
  // True while the fixture is shown: the history's languages are not.
  let languageFixture = false
  // What the languages' view asks of the screen (TEG-141): a name's story
  // from the worker's book, and where a cell lies on the world's chart
  // (u, v each 0..1, the chart's width over its height).
  function languagePlaces(): LanguagePlaces {
    return {
      story: async (index, year) => {
        const answer = await incubator.ask({ type: 'nameStory', index, year })
        return answer?.type === 'nameStory' ? answer.story : null
      },
      cellAt: (cell) => (overlay && cell >= 0 && cell < overlay.u.length ? { u: overlay.u[cell], v: overlay.v[cell] } : null),
      aspect: cellsInput ? cellsInput.width / cellsInput.height : 2,
    }
  }
  // Called with the chronicle (sayChronicle): the history's peoples and its
  // log come with the history and its settlement.
  function showLanguages(): void {
    const tree = peoples?.tree ?? null
    const log = settled?.log ?? null
    // The fixture (the debug parameter below) shows until a history is
    // there; the parameter stays in the address when the screens change.
    if (languageFixture && !(tree && log)) return
    languageFixture = false
    if (languagesFrom.tree === tree && languagesFrom.log === log) return
    languagesFrom = { tree, log }
    languageView = tree && log && historyTime && peoples ? deriveLanguageView({ tree, log, start: historyTime.start, end: historyTime.end, languages: peoples.languages }, languagePlaces()) : null
    languagePanel.setView(languageView)
  }

  // THE STEPS. They compute and say what they did; the layers are the
  // panel's, the same in every step (map/overlayGroups.ts).
  let stepIndex = 0
  const onNewStoneAge = (): boolean => STEPS[stepIndex] === 'newStoneAge'
  const onOldStoneAge = (): boolean => STEPS[stepIndex] === 'oldStoneAge'
  // The history's settlement, its kept states and what follows from them
  // show in every step but the old stone age's.
  // The data the overlays show is the time's, not the step's (2026-10-28:
  // the overlay list is the world's, an overlay is off only where its data
  // is not made yet): the history's from its start on, the old stone age's
  // before it and where there is no history. A history is shown only over
  // its own old stone age: from the origin the old stone age is shown for.
  const historyShown = (): boolean => people !== null && historyTime !== null && peopleTime >= historyTime.start && peopleInput !== null && stone !== null && samePeopling(peopleInput, stone.input)
  // True once the screen is built: the step's layers are below.
  let built = false
  const stepBar = createStepBar(root, {
    steps: STEPS.map((id) => ({ id })),
    stepKeys: 'incubator.step',
    firstNumber: 1,
    onSelect: (index) => showStep(index),
  })
  function showStep(index: number): void {
    const wasStone = onOldStoneAge()
    stepIndex = index
    sidebar.setStep(STEPS[index])
    if (built) showPeoplingControls()
    // The step's favourites; the layers on stay as they are.
    overlayList.setFavourites(FAVOURITES[STEPS[index]])
    updateSteps()
    showTimeRange()
    if (built) stepLayers()
    if (built) void historyForStone()
    if (built && wasStone !== onOldStoneAge()) {
      // What was made of the time shown is made again.
      routeWidths = null
      crossingWays = null
      settledAtTime = null
      treesAtTime = null
      keptAtTime = null
      animalsAtTime.clear()
      showPlants()
      sayChronicle()
    }
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
    furnitureShown = visible
    showPanels()
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
  // Over it, one of the ecology's fields at a time (map/overlayGroups.ts), read
  // from the level's artifact per node; none in a level made before its
  // land fields.
  let terrainOn = true
  let charts: { shaded: Uint8ClampedArray; unshaded: Uint8ClampedArray | null; paperShaded: Uint8ClampedArray; paperUnshaded: Uint8ClampedArray | null } | null = null
  let ecology: { nodes: Int32Array; fields: LevelLand['ecology'] } | null = null
  let picked: EcologyFieldId | null = null
  // The climate's wash shown (map/climateLayers.ts) and its fields, the
  // save's on its chart (level 1 has none of its own; the classes, Köppen
  // and biome, are level 1's, and so is the coast the washes keep to).
  // The land's washes, the pressure among them (the refinement's).
  let climateShown: ClimateWash | null = null
  let climateFields: ClimateFields | null = null
  // The refinement's layers (map/refinedLayers.ts): the sea's wash, the
  // weather's, on the save's refinement charted; the pressure's picture at
  // the overlay's size, made once a world.
  let seaShown: SeaLayer | null = null
  let weatherShown: WeatherLayer | null = null
  let refinedCharts: RefinedCharts | null = null
  // The rain the history takes (historyInput.ts rainOf), as the history's
  // job takes it: a run waits for it, so that the two give one history.
  let historyRain: Promise<HistoryRain | null> = Promise.resolve(null)
  let pressureShown: PressurePicture | null = null
  // The wind's streaks and the currents' arrows, switched as the global
  // layers; their marks made once a world.
  // The climate's layers over land and sea, switches (2026-10-26): the
  // temperature's and the pressure's washes, the wind's and the currents'
  // marks.
  const flowOn: Record<string, boolean> = { 'temperature': false, 'pressure': false, 'wind': false, 'currents': false, 'iceAge': false }
  // The world's climate history (casas-incubator/climate_history.rs), for
  // the ice's overlay.
  // The world's cold over the span (casas-incubator, from its seed): at a
  // time, and the ice's reach and the sea's drop then.
  let iceHistory: { cold(t: number): number; iceReachKm: number; seaDropM(t: number): number } | null = null
  let flowMarked: { charts: RefinedCharts; view: WorldView; wind: boolean; currents: boolean } | null = null
  // The geology's switches and its marks: the volcanoes and the plumes of
  // the save's snapshot, on the world raster's texels.
  const geoOn: Record<string, boolean> = { 'volcanoes': false, 'hotspots': false, 'names': false, 'cratonAge': false, 'mantle': false }
  // The continents' names (raftLabelLayout.ts) and the mantle's buoyancy on
  // the overlay's raster (geologyLayers.ts, null without the field).
  type Geology = { volcanoes: VolcanoMark[]; hotspots: { x: number; y: number }[]; names: ReturnType<typeof computeRaftLabelPlacements>; mantle: MantleRaster | null; chart: ChartSize }
  let geology: Geology | null = null
  // TRIAL (2026-10-25): the plants of plants.ts, grown on the first pick;
  // the use shown, or null. Declared here, above the first showCharts.
  let plants: { layers: PlantLayer[]; trees: TreeLayer[] } | null = null
  let plantShown: PlantUse | null = null
  // The wood shown, or null; one of the two at a time.
  let woodShown: WoodUse | null = null
  // The animals of animals.ts, and the use shown (the animals' group).
  let animals: AnimalLayer[] | null = null
  let animalShown: AnimalUse | null = null
  // The people's spread (casas-incubator/peopling.rs), the time shown (years
  // from the departure), its two layers, and the origin set by a click (-1:
  // chosen).
  let people: PeopleResult | null = null
  // THE ROUTES' WIDTHS at the time shown, km a cell: as the migration
  // arrows the generator had, the square root of the land reached beyond a cell
  // (peopleArrows.ts, flowAt) over all of it, ROUTE_MIN_KM to
  // ROUTE_MAX_KM. Made for the time and kept for it. By the people beyond
  // (until 2026-10-26) a line swelled where it entered the fields, and to
  // 110 km it hid the land.
  const ROUTE_MIN_KM = 8
  const ROUTE_MAX_KM = 50
  let routeWidths: { time: number; people: PeopleResult; widths: Float32Array } | null = null
  function routeWidthsNow(): Float32Array {
    const spread = stone!
    const p = spread.people
    if (routeWidths?.time === peopleTime && routeWidths.people === p) return routeWidths.widths
    const flow = flowAt(p, spread.order, peopleTime, (cell) => p.land[cell])
    const total = Math.max(1e-9, flow[p.origin])
    const widths = Float32Array.from(flow, (f) => ROUTE_MIN_KM + (ROUTE_MAX_KM - ROUTE_MIN_KM) * Math.sqrt(Math.min(1, f / total)))
    routeWidths = { time: peopleTime, people: p, widths }
    return widths
  }
  let peopleTime = SPAN_YEARS
  // What the settled land shows, and the people's switches.
  let settlementShown: Settlement | null = 'spread'
  const peopleOn: Record<string, boolean> = { 'people:routes': true, 'people:trade': false, 'people:villages': false, 'people:hamlets': false, 'people:camps': false, 'people:centres': true, 'people:sources': false }
  const routesOn = (): boolean => peopleOn['people:routes']
  // THE ORIGIN, one for both steps (2026-10-28): set by a click in the old
  // stone age's step; the history is the one from it. -1: the worker's
  // choice, until the old stone age answers.
  let peopleOrigin = -1
  // STEP 1'S CONTROLS (2026-10-30, DES-0032): the reach over sea at its
  // end and the lowest sea level, set in the old stone age's step. With
  // the origin they are its input (world/historyArtifacts.ts
  // PeoplingInput), and so the history's and H1's.
  let peoplingControls: PeoplingControls = { ...PEOPLING_DEFAULTS }
  // The input of the history run or restored (people), null without one.
  let peopleInput: PeoplingInput | null = null
  // THE OLD STONE AGE (casas-incubator peopling.rs): its spread in a
  // history's form, with its routes, their order and their way over the
  // sea, as a history's are made (growPeople); each cell's group; its log;
  // and its input, the origin set by a click in its step and the controls;
  // when the land the ice pushed down is open sea on them (the worker's
  // `flooded`), for both steps.
  let stone: { input: PeoplingInput; people: PeopleResult; routes: RouteLine[]; order: Int32Array; sea: Uint8Array; group: Int32Array; groups: number; density: Float32Array; log: LogEvent[]; span: number; flooded: Int32Array } | null = null
  // The history's time (historyPack.ts): from the old stone age's end to
  // its first city.
  let historyTime: { start: number; end: number } | null = null
  // THE PEOPLES (2026-10-29): the history's peoples' tree (historyPack.ts
  // PeoplesTree; each kept state's ids come with the state, HistoryFrame
  // `peoples`) and a colour per people (incubatorOverlay.ts peopleColours).
  let peoples: { tree: PeoplesWithoutIds; colours: Uint8Array; languages: HistoryLanguages } | null = null
  // The chronicle's range: from the departure to the step's end — the old
  // stone age's in its step, the history's after it (2026-10-28: one
  // chronicle, each step's built on the one before).
  function timeRange(): [number, number] {
    if (onOldStoneAge()) return [0, stone?.span ?? SPAN_YEARS]
    return [0, historyTime?.end ?? stone?.span ?? SPAN_YEARS]
  }
  function showTimeRange(): void {
    const [from, to] = timeRange()
    chronicle.setRange(from, to)
    const cold = iceHistory?.cold
    chronicle.setCold(cold ? Float32Array.from({ length: Math.floor((to - from) / 500) + 1 }, (_, k) => cold(from + k * 500)) : null)
  }
  // The spread the step on screen shows: the old stone age's in its step,
  // the history's in the others.
  function spreadShown(): { people: PeopleResult } | null {
    return historyShown() ? { people: people! } : stone
  }
  // The old stone age's foragers a km² at the time shown: where people
  // came by then, but not under the ice of that time, nor on a shelf the
  // sea covers then (as the ice's layer draws them). The cold's toll on
  // the rest is not taken. Made for the time and kept for it.
  let stoneDensity: { time: number; density: Float32Array } | null = null
  // THE SUNK LAND at the time shown (2026-10-31, TEG-22): per cell 1
  // where the land the ice pushed down is open sea then, as step 1 and
  // the history take it (casas-incubator climate_history.rs THE REBOUND;
  // the old stone age's runs, `stone.flooded`). Made for the time and
  // kept for it; null before the old stone age.
  let floodedShown: { time: number; flooded: Uint8Array } | null = null
  function floodedNow(): Uint8Array | null {
    if (!stone || !cellFacts) return null
    if (floodedShown?.time === peopleTime) return floodedShown.flooded
    const runs = stone.flooded
    const flooded = new Uint8Array(cellFacts.land.length)
    for (let k = 0; k < runs.length; k += 3) if (runs[k + 1] <= peopleTime && peopleTime < runs[k + 2]) flooded[runs[k]] = 1
    floodedShown = { time: peopleTime, flooded }
    return flooded
  }
  function stoneDensityNow(): Float32Array | null {
    if (!stone || !cellFacts) return null
    if (stoneDensity?.time === peopleTime) return stoneDensity.density
    const { arrival } = stone.people
    const reach = iceHistory ? iceHistory.iceReachKm * iceHistory.cold(peopleTime) : 0
    const drop = iceHistory ? iceHistory.seaDropM(peopleTime) : 0
    const { iceKm, seaDepthM, land } = cellFacts
    const flooded = floodedNow()
    const density = new Float32Array(arrival.length)
    for (let i = 0; i < density.length; i++) {
      if (!(arrival[i] <= peopleTime)) continue
      if (land[i] ? (iceKm[i] > 0 && iceKm[i] <= reach) || flooded?.[i] : seaDepthM[i] > drop) continue
      density[i] = stone.density[i]
    }
    stoneDensity = { time: peopleTime, density }
    return density
  }
  // The chronicle's log: the old stone age's in its step; after it the
  // history's, which holds the old stone age's before its own.
  const logShown = (): LogEvent[] => (onOldStoneAge() ? stone?.log ?? [] : settled?.log ?? stone?.log ?? [])
  // The people's end state (casas-incubator/settle.rs), a proof of concept.
  let settled: SettleResult | null = null
  // What the chronicle tells of the cells (casas-incubator/habitat.rs): each
  // one's landmass and area, the landmasses' areas, and their rank by it (1 the
  // largest), which names them.
  let cellFacts: { landmass: Int32Array; landmassKm2: Float64Array; areaKm2: Float32Array; rank: Int32Array; iceKm: Float32Array; seaDepthM: Float32Array; land: Uint8Array } | null = null
  // The composite last uploaded (showCharts), and the charts' version: a
  // new world's charts are a new composite.
  let uploadedBase = ''
  let baseVersion = 0
  // The overlay the trials paint (incubatorOverlay.ts), the world's.
  let overlay: OverlayRaster | null = null
  // The last blend, for showing it again without blending it again.
  let blended: { key: string; shaded: Uint8ClampedArray; unshaded: Uint8ClampedArray | null } | null = null
  // The save's climate fields and its geology, for the panel's washes and
  // marks; in the background, dropped for a world no longer shown.
  async function loadClimate(world: World, domain: Domain, metresPerTexel: number): Promise<void> {
    const [temperature, precipitation, seasonality, monsoon] = await Promise.all(['temperature', 'precipitation', 'seasonalAmplitude', 'monsoonIndex'].map((n) => world.acquire(n).catch(() => null)))
    if (shownWorld !== world) return
    const size = temperature ?? precipitation
    climateFields = size
      ? { width: size.resX, height: size.resY, temperature: temperature?.data ?? null, precipitation: precipitation?.data ?? null, seasonality: seasonality?.data ?? null, monsoon: monsoon?.data ?? null }
      : null
    showCharts()
    const refined = await world.refined().catch(() => null)
    if (shownWorld !== world) return
    refinedCharts = refined ? chartRefined(domain, refined) : null
    showCharts()
    const snapshot = await world.snapshot().catch(() => null)
    if (shownWorld !== world || !snapshot) return
    const engine = await loadWasmEngine()
    const mantle = await world.meshField('mantle')
    if (shownWorld !== world) return
    geology = {
      volcanoes: engine.volcanoesOfSnapshot(snapshot),
      hotspots: snapshot.hotspots.map((h) => ({ x: h.x, y: h.y })),
      names: computeRaftLabelPlacements(snapshot.rafts, domain),
      mantle: mantle ? mantleRaster(domain, new Float64Array(mantle.values)) : null,
      chart: { width: world.width, height: world.height, metresPerTexel },
    }
    showCharts()
  }

  // THE PANELS (2026-10-28): the step's actions (the left column), the
  // layers (ui/layerPanel) beside it and the chronicle on the right, each
  // shown and hidden by its switch in the title bar (ui/titleBar/
  // PanelToggles), while the furniture shows.
  let furnitureShown = false
  const panelToggles = createPanelToggles(titleBar.panels, 'incubator', ['actions', 'overlays', 'chronicle', 'languages'], () => showPanels())
  function showPanels(): void {
    sidebar.setVisible(furnitureShown && panelToggles.shown('actions'))
    overlayList.setVisible(furnitureShown && panelToggles.shown('overlays'))
    chronicle.setVisible(furnitureShown && panelToggles.shown('chronicle'))
    languagePanel.setVisible(furnitureShown && panelToggles.shown('languages'))
  }
  // Every layer off: by "All off", and before the favourites come on.
  const layersOff = (): void => {
    terrainOn = false
    for (const id of Object.keys(peopleOn)) peopleOn[id] = false
    picked = null
    plantShown = null
    woodShown = null
    animalShown = null
    settlementShown = null
    climateShown = null
    seaShown = null
    weatherShown = null
    for (const id of Object.keys(geoOn)) geoOn[id] = false
    for (const id of Object.keys(flowOn)) flowOn[id] = false
  }
  // THE PICKS: per group of one choice (map/overlayGroups.ts), the row
  // shown as its id, or null for the group's "none".
  const prefixed = <T extends string>(prefix: string, get: () => T | null, set: (value: T | null) => void): { shown(): string | null; show(id: string | null): void } => ({
    shown: () => {
      const value = get()
      return value === null ? null : `${prefix}${value}`
    },
    show: (id) => set(id === null ? null : (id.slice(prefix.length) as T)),
  })
  const picks: Partial<Record<OverlayGroupId, { shown(): string | null; show(id: string | null): void }>> = {
    land: prefixed<ClimateWash>('', () => climateShown, (v) => (climateShown = v)),
    sea: prefixed<SeaLayer>('', () => seaShown, (v) => (seaShown = v)),
    weather: prefixed<WeatherLayer>('', () => weatherShown, (v) => (weatherShown = v)),
    resources: prefixed<EcologyFieldId>(resourceLayerId('' as EcologyFieldId), () => picked, (v) => (picked = v)),
    settlement: prefixed<Settlement>('settle:', () => settlementShown, (v) => (settlementShown = v)),
    plants: prefixed<PlantUse>(plantLayerId('' as PlantUse), () => plantShown, (v) => (plantShown = v)),
    animals: prefixed<AnimalUse>(animalLayerId('' as AnimalUse), () => animalShown, (v) => (animalShown = v)),
    trees: prefixed<WoodUse>(woodLayerId('' as WoodUse), () => woodShown, (v) => (woodShown = v)),
  }
  // The plants, the animals and the trees paint the same overlay (shownGroup):
  // one of the three groups at a time, a choice in one clearing the others.
  // The other groups combine, as the list has them.
  const ONE_OVERLAY: readonly OverlayGroupId[] = ['plants', 'animals', 'trees']
  // The favourites of the step shown on (FAVOURITES), everything else off:
  // as a world opens, and on the panel's "Defaults".
  const layersFavourite = (): void => {
    layersOff()
    for (const id of favouritesToTurnOn(FAVOURITES[STEPS[stepIndex]])) {
      if (id === 'terrain') terrainOn = true
      else if (id in peopleOn) peopleOn[id] = true
      else if (id in geoOn) geoOn[id] = true
      else if (id in flowOn) flowOn[id] = true
      else {
        const group = overlayGroupOf(id)
        const pick = group ? picks[group.id] : undefined
        if (!group || !pick || isNoneLayer(id)) continue
        pick.show(id)
        if (ONE_OVERLAY.includes(group.id)) for (const other of ONE_OVERLAY) if (other !== group.id) picks[other]!.show(null)
      }
    }
  }
  // Whether a pick's row has its data here.
  function pickAvailable(group: OverlayGroupId, id: string): boolean {
    switch (group) {
      case 'land': return (CLIMATE_WASHES as readonly string[]).includes(id) && climateWashAvailable(id as ClimateWash, climateFields, climateClasses())
      case 'sea': return (SEA_LAYERS as readonly string[]).includes(id) && refinedCharts !== null
      case 'weather': return (WEATHER_LAYERS as readonly string[]).includes(id) && refinedCharts !== null
      case 'resources': return ecology?.fields[id.slice(resourceLayerId('' as EcologyFieldId).length) as EcologyFieldId] !== undefined
      case 'settlement': return id === 'settle:spread' ? stone !== null || people !== null : id === 'settle:groups' ? stone !== null : id === 'settle:peoples' ? peoples !== null && historyShown() : id === 'settle:density' ? stone !== null || settled !== null : settled !== null
      default: return charts !== null
    }
  }
  // A row's state, from the screen's own; a row the incubator has not (the
  // plate boundaries, the rivers, the watersheds) is never on and greyed out.
  // The level's land fields the hover readout (below) and the layers read.
  // None in a level made before its land fields. Only what it reads is
  // kept of the level's land fields.
  let probe: { nodes: Int32Array; z: Float32Array; land: Pick<LevelLand, 'land' | 'biome' | 'koppen' | 'cratonAge' | 'ecology' | 'temperature' | 'temperatureSwing' | 'temperatureMonths'> } | null = null
  function layerState(id: string): LayerState {
    if (id === 'terrain') return { on: terrainOn, available: charts !== null }
    if (id in peopleOn) return { on: peopleOn[id], available: id === 'people:routes' ? stone !== null : id === 'people:centres' ? stone !== null || settled !== null : settled !== null }
    if (id === 'cratonAge') return { on: geoOn[id], available: probe?.land.cratonAge !== undefined }
    if (id === 'mantle') return { on: geoOn[id], available: geology?.mantle != null }
    if (id in geoOn) return { on: geoOn[id], available: geology !== null }
    if (id === 'temperature') return { on: flowOn[id], available: climateFields?.temperature != null }
    if (id === 'iceAge') return { on: flowOn[id], available: cellFacts !== null }
    if (id in flowOn) return { on: flowOn[id], available: refinedCharts !== null }
    const group = overlayGroupOf(id)
    const pick = group ? picks[group.id] : undefined
    if (!group || !pick) return { on: false, available: false }
    if (isNoneLayer(id)) return { on: pick.shown() === null, available: true }
    return { on: pick.shown() === id, available: pickAvailable(group.id, id) }
  }
  const overlayList = createLayerPanel(root, {
    texts: OVERLAY_PANEL_TEXTS,
    onAllOff: () => {
      layersOff()
      showPlants()
    },
    onDefaults: () => {
      layersFavourite()
      showPlants()
    },
    onToggle: (id) => {
      if (id === 'terrain') terrainOn = !terrainOn
      else if (id in peopleOn) peopleOn[id] = !peopleOn[id]
      else if (id in geoOn) geoOn[id] = !geoOn[id]
      else if (id in flowOn) flowOn[id] = !flowOn[id]
      else return
      showCharts()
      plantLegend.refresh()
    },
    onPick: (id) => {
      const group = overlayGroupOf(id)
      const pick = group ? picks[group.id] : undefined
      if (!group || !pick) return
      const row = isNoneLayer(id) ? null : id
      if (row !== null && !layerState(row).available) return
      pick.show(row)
      if (row !== null && ONE_OVERLAY.includes(group.id)) for (const other of ONE_OVERLAY) if (other !== group.id) picks[other]!.show(null)
      showPlants()
    },
  })
  // Every layer in every step, the world's list (map/overlayGroups.ts).
  overlayList.setGroups(OVERLAY_GROUPS)
  // Under the picks, why the plants or the animals could not be grown.
  const plantStatus = document.createElement('p')
  const plantInfo = document.createElement('section')
  plantInfo.className = 'gen-overlays'
  plantInfo.append(plantStatus)

  // STEP 1'S CONTROLS in the old stone age's step (peoplingControls): a
  // slider each, as the generator's column has them. A change, at the
  // slider's release, makes the old stone age again (controlsAt). Disabled
  // until an old stone age is made: before it a change would make nothing.
  const PEOPLING_SLIDERS = [
    { key: 'reachKm', i18n: 'incubator.people.reach', unit: 'common.unit.kilometres', min: 100, max: 1000, step: 10 },
    { key: 'seaLowM', i18n: 'incubator.people.seaLow', unit: 'common.unit.metres', min: 60, max: 150, step: 5 },
  ] as const
  const peoplingPanel = document.createElement('section')
  peoplingPanel.className = 'gen-params'
  const peoplingSliders = PEOPLING_SLIDERS.map((c) => {
    const field = document.createElement('div')
    field.className = 'gen-param'
    field.dataset.help = c.i18n
    field.innerHTML = `<div class="gen-param__head">
        <span class="gen-param__label" data-t="${c.i18n}.label">${t(`${c.i18n}.label`)}</span>
        <span class="gen-param__value"><span data-value></span><span data-t="${c.unit}">${t(c.unit)}</span></span>
      </div>
      <input type="range" class="gen-param__range" min="${c.min}" max="${c.max}" step="${c.step}" aria-label="${t(`${c.i18n}.label`)}" data-t-aria="${c.i18n}.label" />`
    const input = field.querySelector('input')!
    const value = field.querySelector<HTMLElement>('[data-value]')!
    input.addEventListener('input', () => (value.textContent = input.value))
    input.addEventListener('change', () => void controlsAt({ ...peoplingControls, [c.key]: Number(input.value) }))
    peoplingPanel.append(field)
    return { key: c.key, input, value }
  })
  // The sliders set to `controls`, and the controls taken.
  function setPeoplingControls(controls: PeoplingControls): void {
    peoplingControls = controls
    for (const s of peoplingSliders) {
      s.input.value = String(controls[s.key])
      s.value.textContent = String(controls[s.key])
    }
  }
  // Shown in the old stone age's step; usable once its old stone age is made.
  function showPeoplingControls(): void {
    peoplingPanel.hidden = !onOldStoneAge()
    for (const s of peoplingSliders) s.input.disabled = stone === null
  }
  setPeoplingControls(peoplingControls)
  showPeoplingControls()
  sidebar.body.append(peoplingPanel, plantInfo)

  // THE ANIMALS AT THE TIME SHOWN (2026-10-26): as the fauna placed them
  // before people came; where people live by then, under their pressure by
  // the lifeway and the density of that time (settleShared.ts); a big game
  // gone from a cell of a landmass it dies out on once its time came there
  // (casas-incubator/simulation.rs, the extinctions). Made per
  // animal for the time and kept for it.
  const animalsAtTime = new Map<string, { time: number; codes: Uint8Array; reached: number }>()
  function animalAtTime(animal: AnimalLayer): { codes: Uint8Array; reached: number } {
    if (!settled || !people || !historyShown()) return animal
    const kept = animalsAtTime.get(animal.id)
    if (kept && kept.time === peopleTime) return kept
    // THE HISTORY'S GAME (casas-incubator/simulation.rs): with a simulated
    // history the animals are its state at the time shown — the big game by
    // its species' share, the hunted ones by the small game's, the rest as
    // the fauna placed them; a species gone from a landmass by then, gone.
    // The shares mixed between the kept states before and after the time
    // (frameAfter), as the people (2026-10-26).
    const frame = frameNow()
    if (frame) {
      const spec = ANIMALS.find((a) => a.id === animal.id)
      const hunted = spec ? spec.uses.includes('hunt') || spec.uses.includes('fur') : false
      const pick = (f: HistoryFrame): Uint8Array | null => f.big.get(animal.id) ?? (hunted ? f.small : null)
      const shareBefore = pick(frame)
      const next = frameAfter(frame)
      const shareAfter = next ? pick(next.after) : null
      let share = shareBefore
      if (shareBefore && shareAfter) {
        share = new Uint8Array(shareBefore.length)
        for (let i = 0; i < share.length; i++) share[i] = shareBefore[i] + (shareAfter[i] - shareBefore[i]) * next!.share + 0.5
      }
      const gone = new Map(settled.extinctions.filter((e) => e.id === animal.id).map((e) => [e.landmass, e.at]))
      const codes = new Uint8Array(animal.codes.length)
      let lives = 0
      let land = 0
      for (let i = 0; i < codes.length; i++) {
        if (settled.landmass[i] >= 0) land++
        let c = animal.codes[i]
        const at = gone.get(settled.landmass[i])
        if (c >= 2 && at !== undefined && at <= peopleTime) c = 1
        else if (c >= 2 && share) c = share[i] < GAME_GONE ? 1 : 2 + Math.round(((c - 2) * share[i]) / 255)
        codes[i] = c
        if (c >= 2) lives++
      }
      const made = { time: peopleTime, codes, reached: land > 0 ? lives / land : 0 }
      animalsAtTime.set(animal.id, made)
      return made
    }
    const now = settledNow()
    const spec = ANIMALS.find((a) => a.id === animal.id)
    const hunted = spec ? spec.uses.includes('hunt') || spec.uses.includes('fur') : false
    // The landmasses it dies out on, cell by cell behind the people, and
    // when the rest goes.
    const gone = new Map(settled.extinctions.filter((e) => e.id === animal.id).map((e) => [e.landmass, e.at]))
    const codes = new Uint8Array(animal.codes.length)
    const shares = new Float32Array(5)
    let lives = 0
    let land = 0
    for (let i = 0; i < codes.length; i++) {
      if (settled.landmass[i] >= 0) land++
      let c = animal.codes[i]
      const rest = gone.get(settled.landmass[i])
      if (c >= 2 && rest !== undefined && (rest <= peopleTime || extinctAt(people.arrival[i], i) <= peopleTime)) c = 1
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
  // Whether village `v` stands at `t`: founded, not left.
  const standing = (s: SettleResult, v: number, t: number): boolean => s.villageFrom[v] <= t && t < s.villageTo[v]
  let settledAtTime: { time: number; lifeway: Uint8Array; shares: Uint8Array; density: Float32Array; cleared: Float32Array; villages: Int32Array; links: Float32Array } | null = null
  function settledNow(): NonNullable<typeof settledAtTime> | null {
    if (!settled || !people || !historyShown()) return null
    if (settledAtTime?.time === peopleTime) return settledAtTime
    const times: SettleTimes = { arrival: people.arrival, farmAt: settled.farmAt, herdAt: settled.herdAt, fishOk: settled.fishOk, farmSuit: settled.farmSuit, herdSuit: settled.herdSuit, fishSuit: settled.fishSuit, carrying: settled.carrying }
    const n = people.arrival.length
    const lifeway = new Uint8Array(n)
    const shares = new Uint8Array(4 * n)
    const density = new Float32Array(n)
    const cleared = new Float32Array(n)
    const cell = new Float32Array(5)
    // A history's people are its kept state's (frameNow, KEEP_YEARS
    // apart), the clearing theirs; a cell they left is empty (2026-10-26;
    // until then the rules' density from the history's times). The
    // lifeways' shares stay the times' (sharesAt), a history's own.
    const living = livingNow()
    for (let i = 0; i < n; i++) {
      if (!(people.arrival[i] <= peopleTime) || !people.land[i]) continue
      if (living && living[i] <= 0) continue
      lifeway[i] = sharesAt(times, i, peopleTime, cell)
      density[i] = living ? living[i] : densityAt(times, i, peopleTime, cell)
      cleared[i] = living ? clearedOf(cell, living[i]) : clearedAt(times, i, peopleTime, cell)
      for (let w = 1; w < 5; w++) shares[4 * i + w - 1] = Math.round(cell[w] * 255)
    }
    // The villages standing now (a history's may be left); the links
    // between two of them, their indices into these.
    const villages: number[] = []
    const index = new Int32Array(settled.villageFrom.length).fill(-1)
    for (let v = 0; v < settled.villageFrom.length; v++) {
      if (!standing(settled, v, peopleTime)) continue
      index[v] = villages.length / 2
      villages.push(settled.villages[2 * v], settled.villages[2 * v + 1])
    }
    const links: number[] = []
    for (let k = 0; k < settled.links.length; k += 3) {
      const a = index[settled.links[k]]
      const b = index[settled.links[k + 1]]
      if (a >= 0 && b >= 0) links.push(a, b, settled.links[k + 2])
    }
    settledAtTime = { time: peopleTime, lifeway, shares, density, cleared, villages: Int32Array.from(villages), links: Float32Array.from(links) }
    return settledAtTime
  }
  // THE DOMESTICATES AT THE TIME SHOWN (2026-10-26): per crop and herd animal,
  // the cells where people sow or keep it by then — where its wave came by then
  // (casas-incubator/simulation.rs, the domesticates; one a centre that tamed
  // it). Made for the time and kept for it.
  let keptAtTime: { time: number; crops: Map<string, Uint8Array>; herds: Map<string, Uint8Array> } | null = null
  function keptNow(): { crops: Map<string, Uint8Array>; herds: Map<string, Uint8Array> } | null {
    if (!settled || !historyShown()) return null
    if (keptAtTime?.time === peopleTime) return keptAtTime
    const crops = new Map<string, Uint8Array>()
    const herds = new Map<string, Uint8Array>()
    const by = Math.floor(peopleTime / CAME_STEP)
    for (const d of settled.domestications) {
      const into = d.kind === 'plant' ? crops : herds
      let mask = into.get(d.id)
      if (!mask) into.set(d.id, (mask = new Uint8Array(d.came.length)))
      for (let i = 0; i < d.came.length; i++) if (d.came[i] <= by) mask[i] = 1
    }
    keptAtTime = { time: peopleTime, crops, herds }
    return keptAtTime
  }
  // THE TREES AT THE TIME SHOWN (2026-10-26): where people cleared part of
  // a cell's forest by then (settleShared.ts, clearedAt), each tree that
  // suits it there that much less above its threshold, so it shows fainter
  // but stays. Made for the time and kept for it.
  let treesAtTime: { time: number; trees: TreeLayer[] } | null = null
  function shownTrees(): TreeLayer[] | null {
    if (!plants) return null
    const now = settledNow()
    if (!now) return plants.trees
    if (treesAtTime?.time === peopleTime) return treesAtTime.trees
    const trees = plants.trees.map((tree) => {
      const codes = tree.codes.slice()
      for (let i = 0; i < codes.length; i++) {
        if (now.cleared[i] > 0 && codes[i] >= PLANT_SUITS) codes[i] = PLANT_SUITS + Math.round((codes[i] - PLANT_SUITS) * (1 - now.cleared[i]))
      }
      return { ...tree, codes }
    })
    treesAtTime = { time: peopleTime, trees }
    return trees
  }
  // The animals shown, at the time shown.
  function shownAnimals(): AnimalLayer[] | null {
    if (!animals) return null
    return animals.map((a) => ({ ...a, ...animalAtTime(a) }))
  }

  // THE CHRONICLE's texts and counts (chroniclePanel.ts): the events of the
  // people's spread and settlement, said in the language active now; the
  // people, the villages and the centres at the time shown.
  // A crossing or a species dying out tells of a landmass of
  // EVENT_LEAST_KM2 or more.
  const EVENT_LEAST_KM2 = 100_000
  // The famines the chronicle tells, and their colour (sayChronicle).
  const FAMINE_SHARE = 0.3
  const FAMINE_LEAST = 10_000
  const FAMINE_JOIN_YEARS = 1000
  const FAMINE_RGB: [number, number, number] = [150, 110, 40]
  const CROSSING_LEAST_KM = 10
  const BOAT_RGB = [40, 120, 190] as const
  const EXTINCT_RGB = [176, 57, 44] as const
  // The copper's and the first city's colours.
  const COPPER_RGB = [184, 115, 51] as const
  const CITY_RGB = [120, 70, 150] as const
  // The rising sea's, the cold spells' and the land drying's colours.
  const DROWNED_RGB = [40, 90, 150] as const
  const COLD_RGB = [90, 130, 170] as const
  const DRYING_RGB = [190, 150, 80] as const
  // The land rising where the ice lay (its flooding takes DROWNED_RGB).
  const REBOUND_RGB = [110, 120, 90] as const
  const ERUPTION_RGB = [170, 60, 40] as const
  // The peoples' splits, merges and ends (peoples.rs Tree::tell).
  const PEOPLES_RGB = [150, 80, 60] as const
  // The languages' rise and ends (casas-incubator languages.rs).
  const LANGUAGES_RGB = [60, 130, 110] as const
  function sayChronicle(): void {
    eventPlaces.clear()
    const events: ChronicleEvent[] = []
    const place = (event: ChronicleEvent, cell: number): void => {
      events.push(event)
      if (overlay) eventPlaces.set(event, cellPoint(cell, overlay.u, overlay.v))
    }
    // A landmass by the name its first people gave it, in its form of the
    // event's year (TEG-139, languageView.ts nameAt; the world's content,
    // not i18n); by its number where it had no name by then.
    const names = peoples?.languages.names ?? null
    const landmassNames = new Map<number, number>()
    if (names) for (let j = 0; j < names.kind.length; j++) if (NAME_KINDS[names.kind[j]] === 'landmass') landmassNames.set(names.place[j], j)
    const madeName = (m: number, at: number): string | null => {
      const j = landmassNames.get(m)
      return names && j !== undefined ? nameAt(names, j, at) : null
    }
    const landmassName = (m: number, at: number): string => madeName(m, at) ?? t('incubator.chronicle.landmass', { n: String(cellFacts ? cellFacts.rank[m] : m + 1) })
    // The log (historyLogShared.ts), the history's: what it tells of each
    // kind.
    const log = logShown()
    const facts = cellFacts
    const o = overlay
    if (facts && o) {
      // The villages numbered by when they were founded, 1 the first.
      const villageName = (v: number): string => t('incubator.chronicle.village', { n: String(v + 1) })
      const villageOrder = new Map<number, number>()
      const campOrder = new Map<number, number>()
      for (const e of log) if (e.kind === 'village') villageOrder.set(e.village, villageOrder.size)
      else if (e.kind === 'camp') campOrder.set(e.village, campOrder.size)
      const nameOf = (v: number): string => (campOrder.has(v) ? t('incubator.chronicle.camp', { n: String(campOrder.get(v)! + 1) }) : villageName(villageOrder.get(v) ?? v))
      // Only a domesticate's first taming is told: each centre tames its
      // own, and the chronicle held some 25 tamings over 20 000 years
      // (2026-10-26).
      const tamed = new Set<string>()
      let villageTold = false
      const famines: Extract<LogEvent, { kind: 'famine' }>[] = []
      for (const e of log) {
        if (e.kind === 'departure') {
          place({ time: 0, icon: '/icons/origin.png', rgb: [220, 30, 30], title: t('incubator.chronicle.event.departure'), detail: landmassName(facts.landmass[e.cell], e.at) }, e.cell)
        } else if (e.kind === 'centre') {
          const farm = e.lifeway === LIFEWAY.farmers
          place({
            time: e.at,
            icon: farm ? '/icons/wheat.png' : '/icons/pastures.png',
            rgb: LIFEWAY_COLOURS[farm ? LIFEWAY.farmers : LIFEWAY.herders],
            title: t(farm ? 'incubator.chronicle.event.farmCentre' : 'incubator.chronicle.event.herdCentre'),
            detail: landmassName(facts.landmass[e.cell], e.at),
          }, e.cell)
        } else if (e.kind === 'domesticated') {
          if (tamed.has(e.id)) continue
          tamed.add(e.id)
          place({
            time: e.at,
            icon: e.plant ? '/icons/wheat.png' : '/icons/pastures.png',
            rgb: LIFEWAY_COLOURS[e.plant ? LIFEWAY.farmers : LIFEWAY.herders],
            title: t('incubator.chronicle.event.domesticated', { name: t(`${e.plant ? 'plant' : 'animal'}.${e.id}.label` as TKey) }),
            detail: landmassName(facts.landmass[e.cell], e.at),
          }, e.cell)
        } else if (e.kind === 'copper') {
          place({
            time: e.at,
            icon: e.smelted ? '/icons/bonfire.png' : '/icons/copper_ore.png',
            rgb: COPPER_RGB,
            title: t(e.smelted ? 'incubator.chronicle.event.smelting' : 'incubator.chronicle.event.copper'),
            detail: landmassName(facts.landmass[e.cell], e.at),
          }, e.cell)
        } else if (e.kind === 'city') {
          place({
            time: e.at,
            icon: '/icons/crown.png',
            rgb: CITY_RGB,
            title: t('incubator.chronicle.event.city'),
            detail: t('incubator.chronicle.cityDetail', { people: Math.round(e.people).toLocaleString(getLocale()), landmass: landmassName(facts.landmass[e.cell], e.at) }),
          }, e.cell)
        } else if (e.kind === 'drowned') {
          place({
            time: e.at,
            icon: '/icons/ocean.png',
            rgb: DROWNED_RGB,
            title: t('incubator.chronicle.event.drowned'),
            detail: t('incubator.chronicle.drownedDetail', { landmass: landmassName(e.landmass, e.at), area: Math.round(e.km2).toLocaleString(getLocale()), people: Math.round(e.people).toLocaleString(getLocale()) }),
          }, e.cell)
        } else if (e.kind === 'drying') {
          place({
            time: e.at,
            icon: '/icons/dust.png',
            rgb: DRYING_RGB,
            title: t('incubator.chronicle.event.drying'),
            detail: t('incubator.chronicle.dryingDetail', { landmass: landmassName(e.landmass, e.at), area: Math.round(e.km2).toLocaleString(getLocale()), people: Math.round(e.people).toLocaleString(getLocale()) }),
          }, e.cell)
        } else if (e.kind === 'seaFloodsIce' || e.kind === 'landRises') {
          // THE REBOUND'S COASTS (casas-incubator simulation.rs).
          const flood = e.kind === 'seaFloodsIce'
          const area = { landmass: landmassName(e.landmass, e.at), area: Math.round(e.km2).toLocaleString(getLocale()) }
          place({
            time: e.at,
            icon: flood ? '/icons/ocean.png' : '/icons/continent.png',
            rgb: flood ? DROWNED_RGB : REBOUND_RGB,
            title: t(flood ? 'incubator.chronicle.event.seaFloodsIce' : 'incubator.chronicle.event.landRises'),
            detail: t(flood ? 'incubator.chronicle.seaFloodsIceDetail' : 'incubator.chronicle.landRisesDetail', area),
          }, e.cell)
        } else if (e.kind === 'eruption' || e.kind === 'fissure') {
          const measure = { landmass: landmassName(e.landmass, e.at), area: Math.round(e.km2).toLocaleString(getLocale()), people: Math.round(e.people).toLocaleString(getLocale()), left: Math.round(e.left).toLocaleString(getLocale()) }
          place({
            time: e.at,
            icon: '/icons/volcano.png',
            rgb: ERUPTION_RGB,
            title: t(e.kind === 'eruption' ? 'incubator.chronicle.event.eruption' : 'incubator.chronicle.event.fissure'),
            detail: t(e.kind === 'eruption' ? 'incubator.chronicle.eruptionDetail' : 'incubator.chronicle.fissureDetail', measure),
          }, e.cell)
        } else if (e.kind === 'coldSpell') {
          // No place: the whole world's.
          events.push({
            time: e.at,
            icon: '/icons/blizzard.png',
            rgb: COLD_RGB,
            title: t('incubator.chronicle.event.coldSpell'),
            detail: t('incubator.chronicle.coldSpellDetail', { years: Math.round(e.years).toLocaleString(getLocale()) }),
          })
        } else if (e.kind === 'peopleSplit' || e.kind === 'peopleMerged' || e.kind === 'peopleReplaced' || e.kind === 'peopleGone' || e.kind === 'peopleFarmers') {
          // The peoples by their ids from 1, as the overlay's probe.
          const a = String(e.people + 1)
          const measure = { people: Math.round(e.count).toLocaleString(getLocale()), area: Math.round(e.km2).toLocaleString(getLocale()) }
          const farmers = e.kind === 'peopleFarmers'
          place({
            time: e.at,
            icon: farmers ? '/icons/wheat.png' : '/icons/group.png',
            rgb: farmers ? LIFEWAY_COLOURS[LIFEWAY.farmers] : PEOPLES_RGB,
            title:
              e.kind === 'peopleSplit' ? t('incubator.chronicle.event.peopleSplit', { a })
              : e.kind === 'peopleMerged' ? t('incubator.chronicle.event.peopleMerged', { a, b: String(e.into + 1) })
              : e.kind === 'peopleReplaced' ? t('incubator.chronicle.event.peopleReplaced', { a, b: String(e.into + 1) })
              : e.kind === 'peopleGone' ? t('incubator.chronicle.event.peopleGone', { a })
              : t('incubator.chronicle.event.peopleFarmers', { a }),
            detail: e.kind === 'peopleSplit' ? t('incubator.chronicle.peopleSplitDetail', { b: String(e.new + 1), ...measure }) : t('incubator.chronicle.peopleDetail', measure),
          }, e.cell)
        } else if (e.kind === 'languageArises' || e.kind === 'languageGone' || e.kind === 'familyGone') {
          // The names are the world's content (languageView.ts
          // LanguagesMade), not i18n; the people by its id from 1, as
          // the peoples' events.
          const made = peoples?.languages.made.nodes
          const nodeName = (k: number): string => made?.[k]?.name || String(k + 1)
          const people = String(e.people + 1)
          place({
            time: e.at,
            icon: '/icons/lineage.png',
            rgb: LANGUAGES_RGB,
            title:
              e.kind === 'languageArises' ? t('incubator.chronicle.event.languageArises', { name: nodeName(e.language) })
              : e.kind === 'languageGone' ? t('incubator.chronicle.event.languageGone', { name: nodeName(e.language) })
              : t('incubator.chronicle.event.familyGone', { name: nodeName(e.family) }),
            detail:
              e.kind === 'languageArises' ? t('incubator.chronicle.languageArisesDetail', { people, from: nodeName(e.from) })
              : e.kind === 'familyGone' ? t('incubator.chronicle.familyGoneDetail', { people })
              : e.replaced ? t('incubator.chronicle.languageReplacedDetail', { people, into: nodeName(e.into) })
              : e.into >= 0 ? t('incubator.chronicle.languageMergedDetail', { people, into: nodeName(e.into) })
              : t('incubator.chronicle.languageDiedOutDetail', { people }),
          }, e.cell)
        } else if (e.kind === 'extinct') {
          if (facts.landmassKm2[e.landmass] < EVENT_LEAST_KM2) continue
          const spec = ANIMALS.find((a) => a.id === e.id)
          const group = ANIMAL_USES.find((u) => spec?.uses.includes(u.use))
          place({
            time: e.at,
            icon: group ? group.icon : '/icons/deer.png',
            rgb: EXTINCT_RGB,
            title: t('incubator.chronicle.event.extinct', { animal: t(`animal.${e.id}.label` as TKey) }),
            detail: landmassName(e.landmass, e.at),
          }, e.cell)
        } else if (e.kind === 'crossing') {
          if (!toldCrossing(e, spreadShown()?.people.origin ?? -1)) continue
          const landmass = madeName(e.landmass, e.at)
          place({
            time: e.at,
            icon: '/icons/boat.png',
            rgb: BOAT_RGB,
            title: landmass !== null ? t('incubator.chronicle.event.crossingNamed', { landmass }) : t('incubator.chronicle.event.crossing', { n: String(facts.rank[e.landmass]) }),
            detail: t('incubator.chronicle.crossingDetail', { area: Math.round(facts.landmassKm2[e.landmass]).toLocaleString(getLocale()), km: Math.round(e.km).toLocaleString(getLocale()) }),
          }, e.cell)
        } else if (e.kind === 'village') {
          if (villageTold) continue
          villageTold = true
          place({
            time: e.at,
            icon: '/icons/village.png',
            rgb: LIFEWAY_COLOURS[e.lifeway],
            title: t('incubator.chronicle.event.firstVillage'),
            detail: `${nameOf(e.village)} · ${landmassName(facts.landmass[e.cell], e.at)}`,
          }, e.cell)
        } else if (e.kind === 'trade' && settled) {
          // Placed at the link's middle.
          const pa = cellPoint(settled.villages[2 * e.a], o.u, o.v)
          const pb = cellPoint(settled.villages[2 * e.b], o.u, o.v)
          const km = view ? Math.round(view.metresBetween(pa, pb) / 1000) : 0
          const event: ChronicleEvent = {
            time: e.at,
            icon: '/icons/trade.png',
            rgb: TRADE_COLOUR,
            title: t('incubator.chronicle.event.firstTrade'),
            detail: t('incubator.chronicle.tradeDetail', { a: nameOf(e.a), b: nameOf(e.b), km: km.toLocaleString(getLocale()) }),
          }
          events.push(event)
          const du = pb.u - pa.u - Math.round(pb.u - pa.u)
          eventPlaces.set(event, { u: (((pa.u + du / 2) % 1) + 1) % 1, v: (pa.v + pb.v) / 2 })
        } else if (e.kind === 'population') {
          // No place.
          events.push({
            time: e.at,
            icon: '/icons/population.png',
            rgb: [110, 20, 40],
            title: t('incubator.chronicle.event.population', { count: e.count.toLocaleString(getLocale()) }),
            detail: t('incubator.chronicle.populationDetail', { villages: e.villages.toLocaleString(getLocale()), centres: String(e.centres) }),
          })
        } else if (e.kind === 'famine') {
          if (e.before > 0 && e.lost >= FAMINE_SHARE * e.before && e.lost >= FAMINE_LEAST) famines.push(e)
        }
      }
      // The famines: those that cost FAMINE_SHARE of their square's people
      // and FAMINE_LEAST people or more; the ones on a landmass within
      // FAMINE_JOIN_YEARS of each other told as one, at the cell of the one
      // that cost most. On Morvane 12 (2026-10-26): with 10 000 people at
      // least alone, 29; with the share alone, 92 — a thin square loses a
      // third soon; their spans alone rarely touch.
      famines.sort((a, b) => a.landmass - b.landmass || a.at - b.at)
      for (let k = 0; k < famines.length; ) {
        const first = famines[k]
        let to = first.to
        let lost = 0
        let left = 0
        let villages = 0
        let worst = first
        for (; k < famines.length && famines[k].landmass === first.landmass && famines[k].at <= to + FAMINE_JOIN_YEARS; k++) {
          const f = famines[k]
          to = Math.max(to, f.to)
          lost += f.lost
          left += f.left
          villages += f.villages
          if (f.lost > worst.lost) worst = f
        }
        place({
          time: first.at,
          icon: '/icons/warning.png',
          rgb: FAMINE_RGB,
          title: t('incubator.chronicle.event.famine'),
          detail: t('incubator.chronicle.famineDetail', { landmass: landmassName(first.landmass, first.at), people: Math.round(lost).toLocaleString(getLocale()), left: Math.round(left).toLocaleString(getLocale()), villages: String(villages) }),
        }, worst.cell)
      }
    }
    chronicle.setEvents(events)
    showLanguages()
    // The curve over the range: the old stone age's part alone in its step.
    const curve = curveNow()
    chronicle.setCurve(curve && onOldStoneAge() && stone ? curve.slice(0, Math.floor(stone.span / POPULATION_STEP) + 1) : curve)
    // The epochs: the Palaeolithic to the first farming centre, the
    // Neolithic from it, the Copper Age from the first smelting.
    let farming = Infinity
    let smelting = Infinity
    if (settled && !onOldStoneAge()) {
      for (let k = 0; k < settled.centres.length; k += 3) if (settled.centres[k + 2] === LIFEWAY.farmers) farming = Math.min(farming, settled.centres[k + 1])
      for (const e of log) if (e.kind === 'copper' && e.smelted) smelting = Math.min(smelting, e.at)
    }
    chronicle.setEpochs([
      { from: 0, name: t('incubator.epoch.paleolithic') },
      ...(farming < Infinity ? [{ from: farming, name: t('incubator.epoch.neolithic') }] : []),
      ...(smelting < Infinity ? [{ from: smelting, name: t('incubator.epoch.chalcolithic') }] : []),
    ])
    sayCounts()
  }
  // The people over the chronicle's range, every POPULATION_STEP: the old
  // stone age's from its density where people came by then (the cold's
  // toll not taken), then the history's own count from its start. Made
  // for the two and kept.
  let curveMade: { stone: object | null; settled: object | null; curve: Float32Array | null } | null = null
  function curveNow(): Float32Array | null {
    if (curveMade?.stone === stone && curveMade.settled === settled) return curveMade.curve
    let curve: Float32Array | null = settled?.population ?? null
    if (stone && cellFacts) {
      const start = settled && historyTime ? historyTime.start : stone.span
      const samples = Math.floor(start / POPULATION_STEP) + (curve ? 0 : 1)
      // Each cell's people from the first sample at or after its arrival.
      const added = new Float64Array(samples + 1)
      const arrival = stone.people.arrival
      for (let i = 0; i < arrival.length; i++) {
        if (!(arrival[i] <= start) || stone.density[i] <= 0) continue
        added[Math.min(samples, Math.ceil(arrival[i] / POPULATION_STEP))] += stone.density[i] * cellFacts.areaKm2[i]
      }
      const head = new Float32Array(samples + (curve?.length ?? 0))
      let sum = 0
      for (let k = 0; k < samples; k++) head[k] = sum += added[k]
      if (curve) head.set(curve, samples)
      curve = head
    }
    curveMade = { stone, settled, curve }
    return curve
  }
  function sayCounts(): void {
    const now = settledNow()
    // A history's people are its own count (casas-incubator), between the
    // curve's samples linearly; before its first kept state comes, the
    // density's.
    // The old stone age's, from its density at the time.
    const stoneNow = !historyShown() && stone ? stoneDensityNow() : null
    let persons = 0
    if (stoneNow && cellFacts) {
      for (let i = 0; i < stoneNow.length; i++) if (stoneNow[i] > 0) persons += stoneNow[i] * cellFacts.areaKm2[i]
    } else if (historyFrames && settled && historyShown()) {
      const curve = curveNow() ?? settled.population
      const x = Math.max(0, Math.min(curve.length - 1, peopleTime / POPULATION_STEP))
      const k = Math.floor(x)
      persons = curve[k] + (curve[Math.min(curve.length - 1, k + 1)] - curve[k]) * (x - k)
    } else if (now && cellFacts) for (let i = 0; i < now.density.length; i++) if (now.density[i] > 0) persons += now.density[i] * cellFacts.areaKm2[i]
    let centres = 0
    if (settled && historyShown()) for (let k = 0; k < settled.centres.length; k += 3) if (settled.centres[k + 1] <= peopleTime) centres++
    const say = (n: number): string => (now ? Math.round(n).toLocaleString(getLocale()) : '–')
    let villages = 0
    let camps = 0
    if (now) for (let k = 1; k < now.villages.length; k += 2) if (isCampWay(now.villages[k])) camps++
    else villages++
    chronicle.setStats([
      { label: t('incubator.chronicle.people'), value: stoneNow ? Math.round(persons).toLocaleString(getLocale()) : say(persons) },
      { label: t('incubator.chronicle.villages'), value: say(villages) },
      { label: t('incubator.chronicle.camps'), value: say(camps) },
      { label: t('incubator.chronicle.centres'), value: say(centres) },
    ])
  }
  // A click on the map (not a drag) sets the people's origin there.
  let pressAt: { x: number; y: number } | null = null
  const onPress = (e: PointerEvent): void => {
    pressAt = { x: e.clientX, y: e.clientY }
  }
  const onRelease = (e: PointerEvent): void => {
    const press = pressAt
    pressAt = null
    if (!press || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4 || !onOldStoneAge() || !overlay || !view) return
    const rect = ctx.canvas.getBoundingClientRect()
    const at = view.groundAt(e.clientX - rect.left, e.clientY - rect.top)
    if (!at) return
    const ox = Math.min(overlay.width - 1, Math.floor(at.u * overlay.width))
    const oy = Math.min(overlay.height - 1, Math.floor(at.v * overlay.height))
    const cell = overlay.owners[oy * overlay.width + ox]
    void originAt(cell)
  }
  ctx.canvas.addEventListener('pointerdown', onPress)
  ctx.canvas.addEventListener('pointerup', onRelease)
  function showCharts(): void {
    overlayList.refresh(layerState)
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
  // climate class, its biome and the ecology's fields shown.
  // Its level's land fields (`probe`), above, where the layers read them.
  // The climate's classes per overlay texel, level 1's through the node map
  // (a node a texel at the overlay's size), and its land: the washes keep
  // to level 1's coast. Null before a level with its land fields.
  function climateClasses(): ClimateClasses | null {
    if (!probe) return null
    const { nodes, land } = probe
    return {
      koppen: (t) => (land.land[nodes[t]] ? land.koppen[nodes[t]] : 0),
      biome: (t) => (land.land[nodes[t]] ? land.biome[nodes[t]] : Biome.Ocean),
    }
  }
  const onLevelLand = (t: number): boolean => probe !== null && probe.land.land[probe.nodes[t]] === 1
  // The Köppen classes level 1's land has, for the legend.
  let koppenPresent: Set<number> | null = null
  // THE CLIMATE AT THE POINTER (2026-10-26, variant A): the save's fields
  // at the chart point (u, v), its chart's texel under it — the year's
  // temperature, everywhere, and the rain on the land; and the value of the
  // climate layer shown, where it has one. Coarse, and of level 0's
  // heights. VARIANT B (TEG-109): the temperature of level 1's node where
  // its artifact has it — the year's span and, in brackets, its mean, as
  // the generator's card gives them.
  function climateRows(u: number, v: number, onLand: boolean, node: number, year: number[] | null): ProbeRow[] {
    const at = (field: Float32Array, width: number, height: number): number =>
      field[Math.min(height - 1, Math.floor(v * height)) * width + Math.min(width - 1, Math.floor(u * width))]
    const rows: ProbeRow[] = []
    const f = climateFields
    const mean = probe?.land.temperature?.[node]
    if (mean !== undefined) {
      const shown = formatValue(String(Math.round(mean)), 'common.unit.celsius')
      const span = year ? `${Math.round(Math.min(...year))}…${formatValue(String(Math.round(Math.max(...year))), 'common.unit.celsius')}` : null
      rows.push({ label: t('readout.row.temperature'), value: span ? `${span} (${shown})` : shown })
    } else if (f?.temperature) rows.push({ label: t('readout.row.temperature'), value: formatValue(String(Math.round(at(f.temperature, f.width, f.height))), 'common.unit.celsius') })
    if (onLand && f?.precipitation) {
      const mm = at(f.precipitation, f.width, f.height)
      if (mm !== OCEAN_PRECIP) rows.push({ label: t('readout.row.precipitation'), value: formatValue(String(Math.round(mm)), 'common.unit.millimetresPerYear') })
    }
    if (onLand && climateShown === 'monsoon' && f?.monsoon) {
      const m = at(f.monsoon, f.width, f.height)
      if (m !== OCEAN_PRECIP) rows.push({ label: t('readout.row.monsoon'), value: Math.abs(m).toFixed(2) })
    }
    const c = refinedCharts
    if (!c) return rows
    if (flowOn['pressure']) rows.push({ label: t('readout.row.pressure'), value: formatValue(String(Math.round(at(c.pressure, c.width, c.height))), 'common.unit.hectopascal') })
    if (!onLand && seaShown === 'salinity') rows.push({ label: t('readout.row.salinity'), value: formatValue(at(c.salinity, c.width, c.height).toFixed(1), 'common.unit.psu') })
    if (!onLand && seaShown === 'upwelling' && c.upwellingPeak > 0) {
      rows.push({ label: t('readout.row.upwelling'), value: formatValue(String(Math.round(100 * Math.max(0, Math.min(1, at(c.upwelling, c.width, c.height) / c.upwellingPeak)))), 'common.unit.percent') })
    }
    if (onLand && weatherShown) {
      const w = at(c.weather[weatherShown], c.width, c.height)
      if (Math.abs(w) > 0.005) {
        const shown = weatherShown === 'enso' ? `${w > 0 ? '+' : '−'}${Math.round(100 * Math.abs(w))}` : String(Math.round(100 * w))
        rows.push({ label: t(`overlay.${weatherShown}.label` as TKey), value: formatValue(shown, 'common.unit.percent') })
      }
    }
    return rows
  }
  function describeNode(x: number, y: number): HTMLElement | null {
    if (!probe) return null
    const node = probe.nodes[(y >> 1) * (CHART_WIDTH >> 1) + (x >> 1)]
    const metres = Math.round(elevationToMeters(probe.z[node]))
    const onLand = probe.land.land[node] === 1
    const koppen = probe.land.koppen[node]
    const year = levelTemperatureYear(probe.land, node)
    return buildProbeCard({
      heading: metres >= 0 ? formatValue(String(metres), 'common.unit.metres') : t('readout.metresDeep', { v: String(-metres) }),
      kind: onLand ? t('readout.kind.land') : t('readout.kind.ocean'),
      land: onLand,
      highlights: onLand ? [...(koppen > 0 ? [t(koppenLabelKey(koppen) as TKey)] : []), t(biomeLabelKey(probe.land.biome[node]) as TKey)] : [],
      rows: [
        ...climateRows(x / CHART_WIDTH, y / CHART_HEIGHT, onLand, node, year),
        ...(onLand ? [
        ...[...TOOLTIP_FIELDS, ...(picked && !TOOLTIP_FIELDS.includes(picked) ? [picked] : [])].flatMap((id) => {
          const code = probe!.land.ecology[id]?.[node]
          return code === undefined || code === ECOLOGY_FINE_OCEAN ? [] : [{ label: t(`resource.${id}.label` as TKey), value: formatValue(String(Math.round(decodeFineValue(code) * 100)), 'common.unit.percent') }]
        }),
        // The trials' rows at the world cell under the pointer.
        ...(overlay ? TRIALS.flatMap((l) => l.probe(overlay!.owners[(y >> 1) * overlay!.width + (x >> 1)])) : []),
        ] : []),
      ],
      months: t('readout.months').split(','),
      charts: year ? [{ label: t('readout.chart.temperature'), kind: 'line', values: year }] : [],
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

  // The world shown, its shape and size, for the marks' directions.
  let shown: { kind: 'sphere' | 'torus'; width: number; height: number } | null = null
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
  function shownGroup(): { title: string; from: number; keptKey: TKey; layers: { name: string; codes: Uint8Array; reached: number; colour: number; kept: Uint8Array | null }[] } | null {
    if (animalShown) {
      const animals = shownAnimals()
      if (!animals) return null
      const use = animalShown
      return {
        title: t(`animal.use.${use}.label` as TKey),
        from: 2,
        keptKey: 'incubator.domestic.herds',
        layers: animals.flatMap((l, k) => (l.uses.includes(use) ? [{ name: t(`animal.${l.id}.label` as TKey), codes: l.codes, reached: l.reached, colour: k, kept: keptNow()?.herds.get(l.id) ?? null }] : [])),
      }
    }
    if (!plants) return null
    if (plantShown) {
      const use = plantShown
      return {
        title: t(`plant.use.${use}.label` as TKey),
        from: PLANT_SUITS,
        keptKey: 'incubator.domestic.crops',
        layers: plants.layers.filter((l) => l.use === use).map((l, k) => ({ name: t(`plant.${l.id}.label` as TKey), codes: l.codes, reached: l.reached, colour: k, kept: keptNow()?.crops.get(l.id) ?? null })),
      }
    }
    if (woodShown) {
      const use = woodShown
      return {
        title: t(`wood.use.${use}.label` as TKey),
        from: PLANT_SUITS,
        keptKey: 'incubator.domestic.crops',
        layers: (shownTrees() ?? plants.trees).flatMap((l, k) => (l.woods.includes(use) ? [{ name: t(`wood.${l.id}.label` as TKey), codes: l.codes, reached: l.reached, colour: k, kept: null }] : [])),
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
  // The cells of the world shown (casas-incubator/habitat.rs): the texel each
  // shows of the overlay, their centres; null before they are made or without
  // level 1's land fields.
  let cellsInput: Extract<IncubatorRequest, { type: 'cells' }> | null = null
  // A step's work in the worker under the pill; the world it was asked for
  // still shown, or nothing.
  // While a world opens (`loadStep`: its row in the load panel) the panel
  // shows the work instead of the pill; the caller marks the row done.
  async function work<T extends IncubatorAnswer['type']>(label: string, request: IncubatorRequest, type: T, loadStep?: string): Promise<Extract<IncubatorAnswer, { type: T }> | null> {
    const world = shownWorld
    if (loadStep) loadPanel.start(loadStep)
    else progressPill.show({ label, sub: null, fraction: null, aria: t('generator.progress.ariaRunning', { step: label }) })
    const answer = await incubator.ask(request)
    if (shownWorld !== world) return null
    progressPill.hide()
    if (!answer || answer.type !== type) {
      plantStatus.textContent = t('incubator.plants.failed')
      if (loadStep) loadPanel.fail(loadStep)
      return null
    }
    console.info(`[incubator] ${type}, ${answer.type === 'failed' ? 0 : answer.ms} ms`)
    return answer as Extract<IncubatorAnswer, { type: T }>
  }
  // What the world opens with, in turn: the cells, the flora, the fauna —
  // rows of the load panel (2026-10-26; after it, under the pill, while the
  // map was shown). False where one failed. The people follow in their
  // step, under the pill (showLevel).
  async function growWorld(): Promise<boolean> {
    if (!cellsInput) {
      console.warn('[incubator] the habitat needs level 1\'s land fields')
      plantStatus.textContent = t('incubator.plants.missing')
      loadPanel.fail('cells')
      return false
    }
    const cells = await work(t('incubator.section.plants.label'), cellsInput, 'cells', 'cells')
    if (!cells) return false
    loadPanel.done('cells')
    overlay = { data: new Uint8ClampedArray(cells.owners.length * 4), width: CHART_WIDTH / OVERLAY_DIVISOR, height: CHART_HEIGHT / OVERLAY_DIVISOR, owners: cells.owners, count: cells.count, u: cells.u, v: cells.v }
    const rank = new Int32Array(cells.landmassKm2.length)
    Array.from(cells.landmassKm2.keys()).sort((a, b) => cells.landmassKm2[b] - cells.landmassKm2[a]).forEach((m, k) => (rank[m] = k + 1))
    cellFacts = { landmass: cells.landmass, landmassKm2: cells.landmassKm2, areaKm2: cells.areaKm2, rank, iceKm: cells.iceKm, seaDepthM: cells.seaDepthM, land: cells.land }
    const flora = await work(t('incubator.section.plants.label'), { type: 'flora' }, 'flora', 'flora')
    if (!flora) return false
    loadPanel.done('flora')
    plants = { layers: flora.plants, trees: flora.trees }
    hoverTooltip.refresh()
    showPlants()
    const fauna = await work(t('incubator.section.animals.label'), { type: 'fauna' }, 'fauna', 'fauna')
    if (!fauna) return false
    loadPanel.done('fauna')
    animals = fauna.animals
    hoverTooltip.refresh()
    showPlants()
    return true
  }
  // The people, from the old stone age's origin, then their settlement.
  // THE HISTORY'S PLAYBACK (DES-0032): the kept state at the time shown —
  // the people a km², KEEP_YEARS apart — asked of the worker as the time
  // comes to it, the last few kept; null before a history.
  // A frame: its index, the people a km², the small game's share and each
  // big game species' share (in 255ths, per cell; 255 where the species is
  // not), each cell's people id (NO_PEOPLE for none).
  type HistoryFrame = { index: number; people: Float32Array; small: Uint8Array; peoples: Uint16Array | null; big: Map<string, Uint8Array> }
  let historyFrames: Map<number, HistoryFrame> | null = null
  const framesAsked = new Set<number>()
  const FRAMES_KEPT = 6
  // Under this share (in 255ths) the game is gone from a cell.
  const GAME_GONE = 5
  // The people at the time shown: between the kept states before and after
  // it, mixed by the time (2026-10-26; the last before it until then, so
  // the map jumped every KEEP_YEARS); the one before alone until the one
  // after comes. Made for the time and kept for it.
  let livingAt: { time: number; before: HistoryFrame; after: HistoryFrame | null; people: Float32Array } | null = null
  // The kept state after the one before the time shown, and how far the
  // time is between them, 0 … 1; null until it comes, and where the one
  // before is not the time's own (still coming).
  function frameAfter(before: HistoryFrame): { after: HistoryFrame; share: number } | null {
    const k = frameIndex()
    const share = (peopleTime - frameTime(k)) / Math.max(1e-9, frameTime(k + 1) - frameTime(k))
    const after = share > 0 && k < lastFrame() && historyFrames?.get(k) === before ? frameAt(k + 1) : null
    return after ? { after, share } : null
  }
  // The kept states' times: every KEEP_YEARS from the history's start, the
  // last at its end; the last's index, and the index of the one at or
  // before the time shown.
  function frameTime(k: number): number {
    return historyTime ? Math.min(historyTime.end, historyTime.start + k * KEEP_YEARS) : k * KEEP_YEARS
  }
  function lastFrame(): number {
    return historyTime ? Math.ceil((historyTime.end - historyTime.start) / KEEP_YEARS) : 0
  }
  function frameIndex(): number {
    const start = historyTime?.start ?? 0
    return Math.max(0, Math.min(lastFrame(), Math.floor((peopleTime - start) / KEEP_YEARS)))
  }
  function livingNow(): Float32Array | null {
    const before = frameNow()
    if (!before) return null
    const next = frameAfter(before)
    if (!next) return before.people
    const { after, share } = next
    if (livingAt && livingAt.time === peopleTime && livingAt.before === before && livingAt.after === after) return livingAt.people
    const mixed = livingAt && livingAt.people.length === before.people.length ? livingAt.people : new Float32Array(before.people.length)
    for (let i = 0; i < mixed.length; i++) mixed[i] = before.people[i] + (after.people[i] - before.people[i]) * share
    livingAt = { time: peopleTime, before, after, people: mixed }
    return mixed
  }
  // The kept state `index`, asked of the worker if it is not here; null
  // until it comes, and past the last.
  function frameAt(index: number): HistoryFrame | null {
    if (!historyFrames || index > lastFrame()) return null
    const frame = historyFrames.get(index)
    if (frame) return frame
    if (!framesAsked.has(index)) {
      framesAsked.add(index)
      const frames = historyFrames
      void incubator.ask({ type: 'frame', index }).then((answer) => {
        if (historyFrames !== frames || answer?.type !== 'frame' || !answer.people || !answer.small) return
        const big = new Map<string, Uint8Array>()
        for (const b of answer.big) {
          const full = new Uint8Array(answer.people.length).fill(255)
          b.cells.forEach((cell, k) => (full[cell] = b.share[k]))
          big.set(b.id, full)
        }
        frames.set(index, { index, people: answer.people, small: answer.small, peoples: answer.peoples, big })
        animalsAtTime.clear()
        settledAtTime = null
        treesAtTime = null
        routeWidths = null
        // The oldest asked go; asked again when the time comes back to
        // them (until 2026-10-26 they were never asked again).
        while (frames.size > FRAMES_KEPT) {
          const oldest = frames.keys().next().value!
          frames.delete(oldest)
          framesAsked.delete(oldest)
        }
        showPlants()
      })
    }
    return null
  }
  // The kept state at or before the time shown; until it comes, the
  // nearest kept before it.
  function frameNow(): HistoryFrame | null {
    if (!historyFrames || !historyShown()) return null
    const index = frameIndex()
    const frame = frameAt(index)
    if (frame) return frame
    for (let k = index - 1; k >= 0; k--) {
      const earlier = historyFrames.get(k)
      if (earlier) return earlier
    }
    return null
  }
  // THE PEOPLE (casas-incubator, DES-0032): the history from the origin
  // the old stone age's (peopleOrigin), run — shown
  // only — or, `restore`, the server's
  // H1 of it (and its input) taken in a run's place. The rules' preview, shown before a history until
  // 2026-10-27, went with the port (DEC-0048): a run is quick enough.
  // `loadStep`: the load panel's row (work). False where it failed.
  async function growPeople(restore?: { bytes: ArrayBuffer; input: PeoplingInput }, loadStep?: string): Promise<boolean> {
    if (!overlay) return false
    const started = performance.now()
    const controls = peoplingControls
    const done = restore
      ? await work(t('incubator.progress.loadHistory'), { type: 'restore', bytes: restore.bytes }, 'people', loadStep)
      : await work(t('incubator.action.runHistory.label'), { type: 'simulate', origin: peopleOrigin, controls, rain: await historyRain }, 'people', loadStep)
    if (!done || !overlay || done.origin !== peopleOrigin || (!restore && controls !== peoplingControls)) return false
    peopleInput = restore ? restore.input : peoplingInput(done.origin, controls)
    people = { arrival: done.arrival, land: done.land, from: done.from, flow: done.flow, origin: done.origin, crossings: done.crossings, crossingWays: done.crossingWays }
    historyTime = { start: done.start, end: done.end }
    peoples = { tree: done.peoples, colours: peopleColours(done.peoples.group), languages: done.languages }
    showTimeRange()
    historyFrames = new Map()
    framesAsked.clear()
    routeWidths = null
    showPlants()
    sayChronicle()
    const result = await work(t('incubator.chronicle.people'), { type: 'settle' }, 'settle', loadStep)
    if (!result) return false
    const { type: _type, ms: _ms, ...rest } = result
    settled = rest
    crossingWays = null
    settledAtTime = null
    routeWidths = null
    treesAtTime = null
    keptAtTime = null
    animalsAtTime.clear()
    showPlants()
    sayChronicle()
    console.info(`[incubator] history ${restore ? 'loaded' : 'run'}, ${Math.round(performance.now() - started)} ms`)
    return true
  }
  // THE H1 ARTIFACT (world/historyArtifacts.ts), on the server: a job runs
  // a history there and keeps it as H1 (the history's route,
  // scripts/incubatorPipeline.ts) — the same bits, the same key. A world
  // shown with a history on the server for its origin loads it.
  //
  // The inputs of the server's histories of the world shown, on its
  // level, the one saved last first; none without a server.
  async function serverHistories(): Promise<PeoplingInput[]> {
    const at = held
    if (!at?.worldId || !at.level) return []
    const listed = await listServerArtifacts()
    return listed ? historyInputs(getServerArtifactStore(), listed.artifacts, at.worldId, at.level).catch(() => []) : []
  }
  // As a world opens: the history saved last on the server, its input the
  // input (2026-10-26: a history kept for an origin clicked was not
  // found, the rules' chosen one asked for); else the worker's origin at
  // the controls' defaults, and the history only once the new stone age's
  // step is shown.
  async function openPeople(): Promise<void> {
    const world = shownWorld
    const [saved] = await serverHistories()
    if (shownWorld !== world) return
    const bytes = saved !== undefined ? await readSaved(saved) : null
    if (shownWorld !== world) return
    peopleOrigin = bytes ? saved!.origin : -1
    setPeoplingControls(bytes ? { reachKm: saved!.reachKm, seaLowM: saved!.seaLowM } : { ...PEOPLING_DEFAULTS })
    await stoneFor(peopleOrigin)
    if (shownWorld !== world) return
    if (!(bytes && (await growPeople({ bytes, input: saved! })))) await historyForStone()
  }
  // A new origin (-1: the worker's choice): the old stone age from it, the
  // history of the one before dropped; the new one's made where its step
  // is shown.
  async function originAt(cell: number): Promise<void> {
    const world = shownWorld
    peopleOrigin = cell
    dropHistory()
    await stoneFor(cell)
    if (shownWorld === world) await historyForStone()
  }
  // New controls: the old stone age from the same origin made again, the
  // history of the one before dropped, as a new origin does.
  async function controlsAt(controls: PeoplingControls): Promise<void> {
    const world = shownWorld
    peoplingControls = controls
    dropHistory()
    await stoneFor(peopleOrigin)
    if (shownWorld === world) await historyForStone()
  }
  function dropHistory(): void {
    people = null
    peopleInput = null
    historyTime = null
    peoples = null
    settled = null
    historyFrames = null
    framesAsked.clear()
    settledAtTime = null
    routeWidths = null
    crossingWays = null
    treesAtTime = null
    keptAtTime = null
    animalsAtTime.clear()
    showTimeRange()
    showPlants()
    sayChronicle()
  }
  // The history of the old stone age shown, in the new stone age's step:
  // the server's, else run.
  async function historyForStone(): Promise<void> {
    if (!onNewStoneAge() || !stone || (peopleInput && samePeopling(peopleInput, stone.input))) return
    const world = shownWorld
    const at = stone.input
    const bytes = await readSaved(at)
    if (shownWorld !== world || stone?.input !== at) return
    if (bytes && (await growPeople({ bytes, input: at }))) return
    await growPeople()
  }
  // The old stone age from `origin` (-1: the worker's choice), its routes
  // made as a history's are (growPeople); the flow, which the worker
  // leaves to the screen, the land reached through each cell.
  async function stoneFor(origin: number): Promise<void> {
    const world = shownWorld
    const started = performance.now()
    const controls = peoplingControls
    const done = await incubator.ask({ type: 'peopling', origin, controls })
    if (shownWorld !== world || done?.type !== 'peopling' || (peopleOrigin >= 0 && done.origin !== peopleOrigin) || controls !== peoplingControls) return
    peopleOrigin = done.origin
    const p: PeopleResult = { arrival: done.arrival, land: done.land, from: done.from, flow: done.flow, origin: done.origin, crossings: done.crossings, crossingWays: done.crossingWays }
    const order = routeOrder(p)
    p.flow = Float32Array.from(flowAt(p, order, Infinity, (cell) => p.land[cell]))
    const sea = new Uint8Array(p.arrival.length)
    for (const cell of p.crossingWays) if (cell >= 0 && !p.land[cell]) sea[cell] = 1
    stone = { input: peoplingInput(done.origin, controls), people: p, routes: [], order, sea, group: done.group, groups: done.groups, density: done.density, log: done.log, span: done.span, flooded: done.flooded }
    floodedShown = null
    showPeoplingControls()
    showTimeRange()
    stoneDensity = null
    stone.routes = routesOf(p, [...toldCrossings(done.log, p.origin)].map((n) => p.crossings[4 * n + 1]))
    routeWidths = null
    crossingWays = null
    showPlants()
    sayChronicle()
    console.info(`[incubator] old stone age from cell ${p.origin}: ${done.groups} groups, ${done.log.length - 1} landings, span ${Math.round(done.span)} a, ${Math.round(performance.now() - started)} ms`)
  }
  // The server's history from step 1's `input`, under the pill; null where
  // it has none. Read past this machine's cache, which would keep it too.
  async function readSaved(input: PeoplingInput): Promise<ArrayBuffer | null> {
    const at = held
    if (!at?.worldId || !at.level) return null
    const store = getServerArtifactStore()
    const key = historyKey(at.worldId, at.level, input)
    if (!(await store.resolve(key, false).catch(() => null))) return null
    const label = t('incubator.progress.loadHistory')
    progressPill.show({ label, sub: null, fraction: null, aria: t('generator.progress.ariaRunning', { step: label }) })
    const bytes = await readHistoryArtifact(store, key).catch(() => null)
    progressPill.hide()
    return bytes
  }
  // The world's cold over the span from the worker (casas-incubator), every
  // stepYears: on the chronicle's axis every 500 years, and for the ice's
  // overlay.
  async function loadColdCurve(world: World): Promise<void> {
    const answer = await incubator.ask({ type: 'climate', seed: world.recipe.detailSeed })
    if (shownWorld !== world || answer?.type !== 'climate') return
    const { cold: curve, stepYears, iceReachKm } = answer
    const cold = (t: number): number => {
      const x = Math.max(0, Math.min(curve.length - 1, t / stepYears))
      const k = Math.floor(x)
      return curve[k] + (curve[Math.min(curve.length - 1, k + 1)] - curve[k]) * (x - k)
    }
    // The sea's drop at cold 1: the old stone age's control, the one it was
    // made with (the history shown runs on the same).
    iceHistory = { cold, iceReachKm, seaDropM: (t) => (stone?.input.seaLowM ?? peoplingControls.seaLowM) * cold(t) }
    showTimeRange()
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
    const kept = keptNow()
    const crops = { label: t('incubator.domestic.crops'), names: kept ? [...kept.crops].filter(([, mask]) => mask[cell]).map(([id]) => t(`plant.${id}.label` as TKey)) : [] }
    return [crops, ...uses, ...woods].filter((g) => g.names.length > 0)
  }

  // The animals at a cell of the world raster, by use: those that live
  // there, the most first. Empty before the animals are placed.
  function animalsAt(cell: number): { label: string; names: string[] }[] {
    const animals = shownAnimals()
    if (!animals) return []
    const here = animals.filter((l) => l.codes[cell] >= 2).sort((p, q) => q.codes[cell] - p.codes[cell])
    const kept = keptNow()
    const herds = { label: t('incubator.domestic.herds'), names: kept ? [...kept.herds].filter(([, mask]) => mask[cell]).map(([id]) => t(`animal.${id}.label` as TKey)) : [] }
    return [herds, ...ANIMAL_USES.map(({ use }) => ({ label: t(`animal.use.${use}.label` as TKey), names: here.filter((l) => l.uses.includes(use)).map((l) => t(`animal.${l.id}.label` as TKey)) }))].filter((g) => g.names.length > 0)
  }

  // THE TRIALS' LAYERS, as the generator's table of its layers
  // (overlayReadout): per layer whether it draws now, how it paints the overlay, its legend and its hover rows. The
  // overlay, the legend and the hover card derive from it.
  interface TrialLayer {
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
    items: [
      ...group.layers.flatMap((layer): LegendItem[] => layer.reached === 0 ? [] : [{
        label: `${layer.name} (${formatValue(layer.reached < 0.005 ? '<1' : String(Math.round(100 * layer.reached)), 'common.unit.percent')})`,
        rgb: [...PLANT_PALETTE[layer.colour % PLANT_PALETTE.length]] as [number, number, number],
      }]),
      // What people keep, hatched (incubatorOverlay.ts, paintGroup).
      ...(group.layers.some((layer) => layer.kept) ? [{ label: t(group.keptKey), rgb: [60, 60, 60], shape: 'line' } satisfies LegendItem] : []),
    ],
  })
  const groupRows = (groups: { label: string; names: string[] }[]): ProbeRow[] => groups.flatMap((g) => g.names.map((name, k) => ({ label: k === 0 ? g.label : '', value: name })))
  const groupLayer = (at: (cell: number) => { label: string; names: string[] }[]): TrialLayer => ({
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
  // THE ICE AND THE SEA's colours: the ice, the dry shelf, the sunk land
  // (the sea's).
  const ICE_RGB: [number, number, number] = [245, 248, 252]
  const SHELF_RGB: [number, number, number] = [226, 206, 160]
  const SUNK_RGB: [number, number, number] = [150, 185, 210]
  // Every step shows every layer (ui/layerPanel, 2026-10-26): the steps
  // compute, the panel chooses.
  const TRIALS: readonly TrialLayer[] = [
    {
      // The geology (map/geologyLayers.ts): the mantle's and the cratons'
      // washes under every other layer, and the marks' legends. The
      // cratons' age is level 1's, per node, on its land.
      on: () => Object.values(geoOn).some(Boolean),
      paint: (o) => {
        if (!probe || probe.nodes.length !== o.width * o.height) return
        const target = washTarget(o)
        if (geoOn['mantle'] && geology?.mantle) paintMantle(target, geology.mantle)
        const { nodes, land } = probe
        if (geoOn['cratonAge']) paintCratonAge(target, (t) => land.cratonAge[nodes[t]], onLevelLand)
      },
      legend: () => [
        ...(geoOn['mantle'] && geology?.mantle ? [mantleLegend()] : []),
        ...(geoOn['cratonAge'] ? [cratonAgeLegend()] : []),
        ...(geoOn['volcanoes'] && geology ? [volcanoLegend()] : []),
        ...(geoOn['hotspots'] && geology ? [hotspotLegend()] : []),
      ],
      probe: () => [],
    },
    {
      // THE ICE AND THE SEA at the time shown
      // (casas-incubator/climate_history.rs): the ice grown past today's
      // glaciers, white; the shelf the low sea lays dry, sand; the land the
      // ice pushed down under the sea (THE SUNK LAND), sea. As the
      // history's simulation has them.
      on: () => flowOn['iceAge'] && cellFacts !== null && iceHistory !== null,
      paint: (o) => {
        if (!cellFacts || !iceHistory) return
        const reach = iceHistory.iceReachKm * iceHistory.cold(peopleTime)
        const drop = iceHistory.seaDropM(peopleTime)
        const { iceKm, seaDepthM, land } = cellFacts
        const flooded = floodedNow()
        for (let k = 0; k < o.owners.length; k++) {
          const cell = o.owners[k]
          if (land[cell]) {
            if (iceKm[cell] > 0 && iceKm[cell] <= reach) putTexel(o, k, ICE_RGB, 0.85)
            else if (flooded?.[cell]) putTexel(o, k, SUNK_RGB, 0.85)
          } else if (seaDepthM[cell] <= drop) putTexel(o, k, SHELF_RGB, 0.75)
        }
      },
      legend: () => [{ type: 'swatches', title: t('incubator.layers.iceAge.label'), items: [
        { label: t('incubator.layers.iceAge.ice'), rgb: ICE_RGB },
        { label: t('incubator.layers.iceAge.shelf'), rgb: SHELF_RGB },
        ...(floodedNow()?.includes(1) ? [{ label: t('common.layers.sea.label'), rgb: SUNK_RGB } satisfies LegendItem] : []),
      ] }],
      probe: () => [],
    },
    {
      // The climate's washes over land and sea (switches): the temperature,
      // the pressure with its isobars; under the other layers.
      on: () => flowOn['temperature'] || flowOn['pressure'],
      paint: (o) => {
        const target = washTarget(o)
        if (flowOn['temperature']) paintClimateWash(target, 'temperature', climateFields, null, onLevelLand)
        if (flowOn['pressure'] && refinedCharts) {
          if (!pressureShown || pressureShown.width !== o.width) pressureShown = pressurePicture(refinedCharts, o.width, o.height)
          paintPressure(target, pressureShown)
        }
      },
      legend: () => [
        ...(flowOn['temperature'] ? [climateWashLegend('temperature')] : []),
        ...(flowOn['pressure'] && refinedCharts ? [pressureLegend()] : []),
      ],
      probe: () => [],
    },
    groupLayer((cell) => (animalShown ? animalsAt(cell) : plantsAt(cell))),
    {
      // The climate's wash (map/climateLayers.ts).
      on: () => climateShown !== null,
      paint: (o) => {
        if (!climateShown || !probe || probe.nodes.length !== o.width * o.height) return
        paintClimateWash(washTarget(o), climateShown, climateFields, climateClasses(), onLevelLand)
      },
      legend: () => {
        if (!climateShown) return []
        if (climateShown === 'koppen' && !koppenPresent && probe) {
          koppenPresent = new Set()
          for (let v = 0; v < probe.land.koppen.length; v++) if (probe.land.land[v]) koppenPresent.add(probe.land.koppen[v])
        }
        return [climateWashLegend(climateShown, koppenPresent ?? undefined)]
      },
      probe: () => [],
    },
    {
      // The refinement's washes (map/refinedLayers.ts): the sea's on level
      // 1's sea, the weather's on its land, the wind's calm belts.
      on: () => refinedCharts !== null && (seaShown !== null || weatherShown !== null || flowOn['wind']),
      paint: (o) => {
        if (!refinedCharts || !probe || probe.nodes.length !== o.width * o.height) return
        const target = washTarget(o)
        if (flowOn['wind']) paintWindCalm(target, refinedCharts.wind)
        if (seaShown) paintSea(target, refinedCharts, seaShown, (t) => !onLevelLand(t))
        if (weatherShown) paintWeather(target, refinedCharts, weatherShown, onLevelLand)
      },
      legend: () => [
        ...(seaShown ? [seaLegend(seaShown)] : []),
        ...(weatherShown && refinedCharts ? [weatherLegend(weatherShown, refinedCharts.ensoPeriodYears)] : []),
      ],
      probe: () => [],
    },
    {
      on: () => spreadShown() !== null,
      paint: (o) => {
        const spread = spreadShown()
        if (spread && settlementShown === 'spread') paintPeople(o, spread.people, peopleTime, livingNow())
        if (stone && settlementShown === 'groups') paintGroups(o, stone.people, stone.group, peopleTime)
        const ids = peoples && settlementShown === 'peoples' ? frameNow()?.peoples : null
        if (ids) paintPeoples(o, ids, peoples!.colours, NO_PEOPLE)
        const density = !historyShown() && stone && settlementShown === 'density' ? stoneDensityNow() : null
        if (density) paintDensity(o, density)
      },
      legend: () => {
        const spreadOn = settlementShown === 'spread'
        if (!historyShown() && settlementShown === 'density') return stone ? [{ type: 'gradient', title: t('incubator.people.densityUnit'), unit: '', stops: DENSITY_STOPS.map((s) => ({ value: s.value, rgb: [...s.rgb] as [number, number, number] })) }] : []
        // A colour stands for every group its number in the palette names.
        if (stone && settlementShown === 'groups') {
          const items = Array.from({ length: Math.min(stone.groups, PLANT_PALETTE.length) }, (_, c) => ({
            label: Array.from({ length: Math.ceil((stone!.groups - c) / PLANT_PALETTE.length) }, (_, k) => String(c + 1 + k * PLANT_PALETTE.length)).join(', '),
            rgb: [...PLANT_PALETTE[c]] as [number, number, number],
          }))
          return [{ type: 'swatches', title: t('incubator.peopling.groups.label'), items }]
        }
        if (!spreadShown() || (!spreadOn && !routesOn())) return []
        const routes = routesOn() ? [{ label: t('incubator.people.routes.label'), rgb: [...PEOPLE_ROUTE] as [number, number, number], shape: 'line' as const }] : []
        // The ramp as the years before the game the land was settled.
        return [spreadOn
          ? { type: 'gradient', title: t('incubator.chronicle.year', { year: '…' }), unit: '', stops: PEOPLE_AGE_STOPS.map((s) => ({ value: s.value, rgb: [...s.rgb] as [number, number, number] })), items: routes }
          : { type: 'swatches', title: t('incubator.chronicle.people'), items: routes }]
      },
      probe: (cell) => {
        if (settlementShown === 'peoples') return peoplesProbe(cell)
        return stone && settlementShown === 'groups' && stone.group[cell] >= 0 && stone.people.arrival[cell] <= peopleTime ? [{ label: t('incubator.peopling.groups.label'), value: String(stone.group[cell] + 1) }] : []
      },
    },
    {
      // TRIAL: the end state, drawn over the spread.
      on: () => settled !== null && historyShown() && (settlementShown === 'lifeway' || settlementShown === 'density' || peopleOn['people:trade'] || peopleOn['people:centres']),
      paint: (o) => {
        if (!settled) return
        const now = settledNow()
        if (!now) return
        if (settlementShown === 'lifeway') paintLifeways(o, now.shares)
        if (settlementShown === 'density') paintDensity(o, now.density)
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
  ]
  const activeTrials = (): TrialLayer[] => TRIALS.filter((l) => l.on())
  // The people of a cell at the kept state shown: its id (from 1, as the
  // groups'), its people, its farmers' share.
  function peoplesProbe(cell: number): ProbeRow[] {
    const frame = peoples ? frameNow() : null
    const id = frame?.peoples?.[cell] ?? NO_PEOPLE
    if (!peoples || !frame || id === NO_PEOPLE) return []
    const tree = peoples.tree
    for (let r = tree.frameStart[id]; r < tree.frameStart[id + 1]; r++) {
      if (tree.frame[r] !== frame.index) continue
      const value = t('incubator.people.peoplesDetail', {
        id: String(id + 1),
        people: Math.round(tree.people[r]).toLocaleString(getLocale()),
        farmers: formatValue(String(Math.round((100 * tree.farmers[r]) / 255)), 'common.unit.percent'),
      })
      return [{ label: t('incubator.people.peoples.label'), value }]
    }
    return []
  }

  // THE MARKS (incubatorSymbols.ts) of the people step: the sources, the
  // trade, the villages, the routes, the crossings, the farming's and the
  // herding's centres, the origin, in that order from below; the centres
  // and the origin on one switch (Zentren), the crossings on the routes';
  // each view is given the pictures once, the crossings' again for new
  // people.
  const marked = new WeakSet<WorldView>()
  // The geology and the view its marks were made for.
  let geologyMarked: { geology: Geology | null; view: WorldView } | null = null
  let namesMarked: { geology: Geology | null; view: WorldView } | null = null
  // The crossings drawn: those the chronicle tells (EVENT_LEAST_KM2), each its
  // way over the open water (casas-incubator/simulation.rs, crossing_ways) and
  // when they landed; and the people and the view their pictures were made for.
  let crossingWays: { people: PeopleResult; view: WorldView; ways: { path: number[]; time: number }[] } | null = null
  function crossingsOf(p: PeopleResult, log: readonly LogEvent[]): { path: number[]; time: number }[] {
    const ways: { path: number[]; time: number }[] = []
    const c = p.crossings
    const told = toldCrossings(log, p.origin)
    let at = 0
    for (let k = 0; k < c.length; k += 4) {
      const path: number[] = []
      for (; p.crossingWays[at] >= 0; at++) path.push(p.crossingWays[at])
      at++
      if (told.has(k / 4)) ways.push({ path, time: c[k + 2] })
    }
    return ways
  }
  // The crossings the chronicle tells and the map draws: the first arrival
  // on a landmass of EVENT_LEAST_KM2 or more, by any way (the log's
  // `first`), when it was a crossing over CROSSING_LEAST_KM of open water
  // or more; not the people's own. The history's crossings join the
  // regions the ice leaves apart, a landmass's pockets one by one, most
  // along the coast alone: each told, they were hundreds (2026-10-26).
  // `origin`: the spread's whose log it is.
  function toldCrossing(e: Extract<LogEvent, { kind: 'crossing' }>, origin: number): boolean {
    if (!cellFacts) return false
    const home = origin >= 0 ? cellFacts.landmass[origin] : -1
    return e.first && e.landmass !== home && cellFacts.landmassKm2[e.landmass] >= EVENT_LEAST_KM2 && e.km >= CROSSING_LEAST_KM
  }
  // Those, by their order in the log, which is PeopleResult.crossings'.
  function toldCrossings(log: readonly LogEvent[], origin: number): Set<number> {
    const told = new Set<number>()
    let n = 0
    for (const e of log) {
      if (e.kind !== 'crossing') continue
      if (toldCrossing(e, origin)) told.add(n)
      n++
    }
    return told
  }
  // The true direction from one chart point to the next (WorldSymbol.angle):
  // on the globe a degree of longitude shrinks with the latitude; the
  // torus's texels are square.
  function directionOf(a: ChartPoint, b: ChartPoint): number {
    const du = b.u - a.u - Math.round(b.u - a.u)
    const dv = b.v - a.v
    if (!shown || shown.kind === 'sphere') return Math.atan2(dv * Math.PI, du * 2 * Math.PI * Math.cos((0.5 - (a.v + b.v) / 2) * Math.PI))
    return Math.atan2((dv - Math.round(dv)) * shown.height, du * shown.width)
  }
  function syncMarks(): void {
    if (!view || !overlay) return
    const volcanoes = view.symbols('incubator-volcanoes')
    const hotspots = view.symbols('incubator-hotspots')
    if (geologyMarked?.geology !== geology || geologyMarked?.view !== view) {
      if (geology) {
        const v1 = volcanoSymbols(geology.volcanoes, geology.chart)
        const h1 = hotspotSymbols(geology.hotspots, geology.chart)
        volcanoes.setPictures(v1.pictures)
        volcanoes.setSymbols(v1.symbols)
        hotspots.setPictures(h1.pictures)
        hotspots.setSymbols(h1.symbols)
      } else {
        volcanoes.setSymbols([])
        hotspots.setSymbols([])
      }
      geologyMarked = { geology, view }
    }
    volcanoes.setEnabled(geology !== null && geoOn['volcanoes'])
    const names = view.symbols('incubator-names')
    if (namesMarked?.geology !== geology || namesMarked?.view !== view) {
      if (geology) {
        const n1 = nameSymbols(geology.names, geology.chart)
        names.setPictures(n1.pictures)
        names.setSymbols(n1.symbols)
      } else names.setSymbols([])
      namesMarked = { geology, view }
    }
    names.setEnabled(geology !== null && geoOn['names'])
    // The wind's streaks and the currents' arrows, made once a world each,
    // when first switched on.
    const wind = view.symbols('incubator-wind')
    const currents = view.symbols('incubator-currents')
    if (refinedCharts && geology && (flowMarked?.charts !== refinedCharts || flowMarked.view !== view)) flowMarked = { charts: refinedCharts, view, wind: false, currents: false }
    if (flowMarked && geology && flowOn['wind'] && !flowMarked.wind) {
      wind.setPictures(windPictures(geology.chart))
      wind.setSymbols(windSymbols(windMarks(flowMarked.charts, WIND_LENGTH, WIND_GAP)))
      flowMarked.wind = true
    }
    if (flowMarked && geology && flowOn['currents'] && !flowMarked.currents) {
      const charts = flowMarked.charts
      currents.setPictures(currentPictures(geology.chart))
      currents.setSymbols(currentSymbols(currentMarks(charts, CURRENT_LENGTH, CURRENT_GAP), (m) => currentClass(charts, m)))
      flowMarked.currents = true
    }
    wind.setEnabled(flowOn['wind'] && flowMarked?.wind === true)
    currents.setEnabled(flowOn['currents'] && flowMarked?.currents === true)
    hotspots.setEnabled(geology !== null && geoOn['hotspots'])
    const sources = view.symbols('incubator-sources')
    const trade = view.symbols('incubator-trade')
    const hamlets = view.symbols('incubator-hamlets')
    const camps = view.symbols('incubator-camps')
    const villages = view.symbols('incubator-villages')
    const routes = view.symbols('incubator-routes')
    const crossings = view.symbols('incubator-crossings')
    const centres = view.symbols('incubator-centres')
    const origin = view.symbols('incubator-origin')
    if (!marked.has(view)) {
      sources.setPictures(sourcePictures())
      trade.setPictures(tradePictures(TRADE_COLOUR))
      hamlets.setPictures(hamletPictures())
      camps.setPictures(campPictures())
      villages.setPictures(villagePictures())
      routes.setPictures(routePictures(PEOPLE_ROUTE))
      centres.setPictures(centrePictures())
      origin.setPictures(originPictures())
      marked.add(view)
    }
    const { u, v } = overlay
    const v0 = view
    const geometry: LineGeometry = { km: (a, b) => v0.metresBetween(a, b) / 1000, direction: directionOf, wrapsV: shown?.kind === 'torus' }
    const now = settledNow()
    const showTrade = now !== null && settled !== null && peopleOn['people:trade']
    trade.setSymbols(showTrade ? tradeSymbols(now!.villages, now!.links, u, v, geometry) : [])
    trade.setEnabled(showTrade)
    // The routes are the old stone age's in every step: the history makes
    // none of its own (2026-10-28).
    const spread = stone
    const showRoutes = spread !== null && routesOn()
    if (showRoutes) {
      const widths = routeWidthsNow()
      routes.setSymbols(routeSymbols(spread.routes, peopleTime, spread.people.arrival, (cell) => widths[cell], spread.sea, u, v, geometry))
    } else routes.setSymbols([])
    routes.setEnabled(showRoutes)
    const showSources = now !== null && settled !== null && peopleOn['people:sources']
    sources.setSymbols(showSources ? Array.from({ length: settled!.sources.length / 2 }, (_, k) => ({ at: cellPoint(settled!.sources[2 * k], u, v), picture: settled!.sources[2 * k + 1] })) : [])
    sources.setEnabled(showSources)
    const showVillages = now !== null && peopleOn['people:villages']
    villages.setSymbols(showVillages ? villageSymbols(now!.villages, now!.density, u, v) : [])
    villages.setEnabled(showVillages)
    const showHamlets = now !== null && cellFacts !== null && peopleOn['people:hamlets']
    hamlets.setSymbols(showHamlets ? hamletSymbols(now!.density, now!.shares, cellFacts!.areaKm2, u, v) : [])
    hamlets.setEnabled(showHamlets)
    const showCamps = now !== null && peopleOn['people:camps']
    camps.setSymbols(showCamps ? campSymbols(now!.villages, u, v) : [])
    camps.setEnabled(showCamps)
    const showCrossings = spread !== null && routesOn()
    if (spread && (crossingWays?.people !== spread.people || crossingWays.view !== view)) {
      const ways = crossingsOf(spread.people, spread.log)
      crossings.setPictures(crossingPictures(ways.map((w) => t('incubator.chronicle.year', { year: Math.round(w.time).toLocaleString(getLocale()) }))))
      crossingWays = { people: spread.people, view, ways }
    }
    const shownWays = showCrossings && crossingWays ? crossingWays.ways.map((w) => (w.time <= peopleTime ? w.path : [])) : []
    crossings.setSymbols(crossingSymbols(shownWays, u, v, geometry))
    crossings.setEnabled(showCrossings)
    const showCentres = now !== null && settled !== null && peopleOn['people:centres']
    const centreSymbols: WorldSymbol[] = []
    if (showCentres) {
      for (let k = 0; k < settled!.centres.length; k += 3) {
        if (settled!.centres[k + 1] <= peopleTime) centreSymbols.push({ at: cellPoint(settled!.centres[k], u, v), picture: settled!.centres[k + 2] === LIFEWAY.farmers ? 0 : 1 })
      }
    }
    centres.setSymbols(centreSymbols)
    centres.setEnabled(showCentres)
    const showOrigin = spread !== null && spread.people.origin >= 0 && peopleOn['people:centres']
    origin.setSymbols(showOrigin ? [{ at: cellPoint(spread.people.origin, u, v), picture: 0 }] : [])
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

  // showLevel, whose exceptions end the load too: a store that does not
  // answer, an engine that does not load, a view not built. The step that
  // ran fails, the reason to the console; the list stays up behind the
  // panel (TEG-89).
  async function openLevel(archive: Blob, uid: string): Promise<boolean> {
    try {
      return await showLevel(archive, uid)
    } catch (error) {
      console.error('[incubator] the world could not be opened', error)
      loadPanel.failRunning()
      return false
    }
  }

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
    // The engine's WASM build, for the temperature band (loaded with the world).
    const engine = await loadWasmEngine()
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
      ? { values: engine.seaLevelTemperatureBand(params.temperatureOffset, params.temperatureContrast, params.planet, kind), key: uid }
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
      ? { nodes: painted.nodes, fields: Object.fromEntries(ECOLOGY_FIELD_IDS.flatMap((id) => (land.ecology[id] ? [[id, land.ecology[id]]] : []))) }
      : null
    blended = null
    baseVersion++
    overlay = null
    // The cells' input: the node map and level 1's land fields, copied on
    // the way to the worker.
    cellsInput = land && painted.nodes
      ? { type: 'cells', seed: world.recipe.detailSeed, ...cellInputOf(kind, world.width, world.height, painted.nodes, level, land) }
      : null
    probe = land && painted.nodes && ecology
      ? { nodes: painted.nodes, z: level.z, land: { land: land.land, biome: land.biome, koppen: land.koppen, cratonAge: land.cratonAge, ecology: ecology.fields, temperature: land.temperature, temperatureSwing: land.temperatureSwing, temperatureMonths: land.temperatureMonths } }
      : null
    hoverTooltip.refresh()
    // A world opens on the favourites of the step shown.
    layersFavourite()
    showCharts()
    cameraTools.setVisible(kind === 'sphere')
    mapScales.redraw()
    shown = { kind, width: world.width, height: world.height }
    shownWorld = world
    climateFields = null
    geology = null
    koppenPresent = null
    // A world texel's metres, at the equator on the globe.
    refinedCharts = null
    historyRain = world.refined().then((r) => (r ? rainOf(domain, r) : null)).catch(() => null)
    pressureShown = null
    historyFrames = null
    // The world's climate history on the chronicle's axis, every 500 years,
    // and for the ice's overlay (the worker's: casas-incubator).
    iceHistory = null
    void loadColdCurve(world)
    void loadClimate(world, domain, kind === 'sphere' ? domain.metresAround / world.width : domain.metresPerUnit)
    plants = null
    animals = null
    people = null
    historyTime = null
    peoples = null
    settled = null
    peopleInput = null
    peopleOrigin = -1
    stone = null
    showPeoplingControls()
    cellFacts = null
    chronicle.stop()
    showTimeRange()
    chronicle.show(timeRange()[1])
    sayChronicle()
    plantStatus.textContent = ''
    plantLegend.refresh()
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
    loadPanel.done('paint')
    if (!(await growWorld())) return false
    step('grown')
    loadPanel.close()
    held = { uid, name: '', seed: '', worldId: chosen.worldId, level: chosen.pipelineVersion }
    void openPeople()
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
        if (!(await openLevel(archive, kept.uid))) return
        if (held) held = { ...held, name: kept.name, seed: kept.seed }
        titleBar.setWorldShown(true)
        stepBar.setWorld({ name: kept.name || undefined, seed: kept.seed })
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
        { id: 'cells', labelKey: 'incubator.load.step.cells', weight: 6 },
        { id: 'flora', labelKey: 'incubator.load.step.flora', weight: 2 },
        { id: 'fauna', labelKey: 'incubator.load.step.fauna', weight: 2 },
      ],
    })
    loadPanel.start('fetch')
  }

  // The jobs and the artifacts, full screen over the world as in the
  // generator; one at a time, the column out of the way while one is up.
  // "This world" is the world shown. Over the world list they cover the list,
  // and closing one leaves the list as it was.
  // `level`: the pipeline of the level 1 shown, which its histories run on.
  let held: { uid: string; name: string; seed: string; worldId: string | null; level?: string } | null = null
  const artifactChooser = createArtifactChooser(root, {
    currentWorld: () => held,
    onClose: () => windows.close(artifactChooser),
    onCommissioned: (outcome) => reportCommission(ctx.notifications, outcome),
  })
  const jobChooser = createJobChooser(root, {
    currentWorld: () => held,
    onClose: () => windows.close(jobChooser),
  })
  // The handbook, as in the generator. No step and no layers here, so it
  // opens on its overview.
  const handbookPanel = createHandbookPanel(root, {
    docsAvailable: () => peekServerStatus()?.modules.includes('docs') ?? false,
    current: () => null,
  })
  // One window at a time (ui/windows/windowSet.ts), the languages' full
  // view the third. Over the world list, the list stays and the column
  // stays away.
  const windows = createWindowSet([artifactChooser, jobChooser, languagePanel], {
    beforeOpen: () => {
      handbookPanel.close()
      setFurniture(false)
    },
    afterClose: () => {
      if (!worldChooser.isOpen()) setFurniture(true)
    },
  })

  // The step on screen: its actions; the panel's rows, the map and its
  // legend redrawn. The layers are the same in every step.
  function stepLayers(): void {
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
      if (!(await openLevel(archive, worldParam))) return
      worldChooser.close()
      setFurniture(true)
      root.dataset.ready = '1'
    })()
  }

  // DEBUG: `?screen=incubator&languages=fixture` shows the languages
  // fixture (scripts/fixtures/languages.json) in the languages panel instead
  // of the history's, opened in its full view. Not a user surface.
  if (new URLSearchParams(window.location.search).get('languages') === 'fixture') {
    languageFixture = true
    void import('../../../scripts/fixtures/fixtureView').then((m) => m.loadFixtureView()).then((fixture) => {
      if (disposed) return
      languageView = fixture
      languagePanel.setView(fixture)
      windows.open(languagePanel)
    })
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
      chronicle.dispose()
      languagePanel.dispose()
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
