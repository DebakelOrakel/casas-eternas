import { Color4, Scene } from '@babylonjs/core'
import { createHexMapCamera } from '../../camera/hexMapCamera'
import { createToroidalMapView } from '../../map/ToroidalMapView'
import { createMapHoverTooltip } from '../../map/MapHoverTooltip'
import { createToroidalRibbonOverlay } from '../../map/ToroidalRibbonOverlay'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { MAP_HEIGHT, MAP_WIDTH } from '../../worldgen/mapConfig'
import JSZip from 'jszip'
import type { WorkerClimateDataMessage, WorkerHydrologyDataMessage, WorkerEcologyDataMessage, WorkerErosionProgressMessage, WorkerInboundMessage, WorkerRenderedMessage, WorkerWorldDataMessage } from '../../worldgen/plateSimulationWorker'
import { drawContinentLabels } from '../../worldgen/continentLabelRenderer'
import type { ContinentLabelPlacement } from '../../worldgen/continentLabelRenderer'
import type { PlateArrow } from '../../worldgen/elevationMapImage'
import type { SimEvent, PlateSimulationSnapshot } from '../../worldgen/plateSimulation'
import { eventCategory } from '../../worldgen/plateSimulation'
import { MapOverlayCompositor } from '../../ui/mapOverlay/MapOverlayCompositor'
import { temperatureColor, precipitationColor, amplitudeColor, monsoonColor, temperatureLegendStops, precipitationLegendStops, amplitudeLegendStops, monsoonLegendStops } from '../../worldgen/climate/climateColors'
import { OCEAN_PRECIP } from '../../worldgen/climate/precipitation'
import { OCEAN_AMPLITUDE } from '../../worldgen/climate/seasonality'
import { biomeColor, biomeLabel, biomeLegend, Biome } from '../../worldgen/climate/biomes'
import { ECOLOGY_FIELD_META, ecologyFieldColor, ecologyFieldLegendStops } from '../../worldgen/ecology/ecologyColors'
import { ECOLOGY_OCEAN, type EcologyFieldId } from '../../worldgen/ecology/ecologyField'
import './worldgen.css'

// The ecology per-field abundance weights persisted in world.yaml (keys `w_<field>`).
const ECOLOGY_WEIGHT_FIELDS: EcologyFieldId[] = ['arable', 'fish', 'game', 'pasture', 'timber', 'salt', 'toolStone', 'copper', 'tin', 'iron', 'gold', 'silver', 'gems']

// Plate-boundary line color for the boundaries overlay (drawn main-thread
// from the worker's boundary mask — see the compositor).
const BOUNDARY_COLOR: [number, number, number] = [15, 15, 15]
const ARROW_COLOR = '#0f0f0f'

// Event markers + notifications share one wall-clock lifetime, so a toast and
// its geologic map marker appear and fade together (the user's coupling
// choice). ONLY continent-scale events (collision/breakup/supercontinent) get a
// marker AND a notification now; routine crust churn (oceanic plate created/
// subducted) used to add a cryptic unlabelled blue ring and was dropped (see
// handleSimEvents). Colors are "r, g, b" fragments for rgba().
const EVENT_CONTINENT_LIFETIME_MS = 15000
const EVENT_MARKER_HALF_LENGTH = 90
const COLLISION_COLOR = '220, 45, 45'
const BREAKUP_COLOR = '235, 140, 30'

// Fresh start for the hex-tile world generation approach — the sphere-
// based version this replaces lives on under 'worldgen-sphere' (see
// screens/worldgen-sphere/WorldGenScreen.ts), still reachable from the
// title screen. Hex-tile generation code itself belongs in src/worldgen.

// World-space size of one toroidal period, independent of the plate
// map's own pixel resolution — matches the map's 2:1 aspect for a simple
// first pass.
const WORLD_WIDTH = 20
const WORLD_HEIGHT = 10

// Earth has ~7 major plates (covering ~90% of the surface) plus a tail of
// minor/microplates. Measured against this generator's own Voronoi areas, a
// default of 8 reproduces that major-plate structure closely: largest plate
// ~15-18% of the surface (Pacific is ~20%), ~7 plates covering 90%. Fewer =
// bigger, more dominant plates; more = a busier, more uniform patchwork.
const TOTAL_PLATE_COUNT_MIN = 5
const TOTAL_PLATE_COUNT_MAX = 13
const TOTAL_PLATE_COUNT_DEFAULT = 8

// Raft model: continental crust is no longer "how many plates are
// continental" but how much of the surface starts as land (raft coverage,
// which then evolves emergently) and how tightly those continents cluster.
// Both are percentages in the UI, converted to 0..1 fractions for the sim.
const LAND_FRACTION_MIN = 8
const LAND_FRACTION_MAX = 45
const LAND_FRACTION_DEFAULT = 25
const CLUSTERING_MIN = 0
const CLUSTERING_MAX = 100
const CLUSTERING_DEFAULT = 50
// How many separate continents (cratons) to seed. Direct control rather than
// seed-derived — see rafts.ts / the decision doc follow-up.
const CRATON_COUNT_MIN = 1
const CRATON_COUNT_MAX = 8
const CRATON_COUNT_DEFAULT = 4

// How often, while running, the sim advances one epoch and re-renders —
// paced deliberately (not "as fast as possible") so a run reads as
// gradual mountain-building over time rather than flashing straight to
// some final state.
const EPOCH_INTERVAL_MS = 400

// Safety cap: the live tectonics stepping auto-stops once it reaches this
// epoch, so a run left going by accident doesn't keep stepping (and
// steadily slowing down as terrain features accumulate) forever. Only a
// safety net — deliberately restarting after it fires keeps going (see
// autoStopTriggered), and generating a new world re-arms it.
const MAX_TECTONICS_EPOCHS = 100

function randomSeed(): string {
  return Math.floor(Math.random() * 1_000_000_000).toString()
}

export const createWorldGenScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)

  const { dispose: disposeCamera, getFocus: getCameraFocus } = createHexMapCamera({
    scene,
    canvas: ctx.canvas,
    engine: ctx.engine,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
  })

  const initialSeed = randomSeed()
  let lastLandFraction = 0
  let lastEpoch = 0
  // How many erosion passes have been applied to the current world (status
  // .erosionRun in a save). Reset when the topography is remade (regenerate /
  // running tectonics / reset-erosion), bumped per erode, set on load.
  let erosionRunCount = 0
  // Epoch the safety auto-stop will fire at. Re-armed to (current epoch +
  // MAX_TECTONICS_EPOCHS) every time the sim is started (see startSim), so
  // each run halts ~MAX_TECTONICS_EPOCHS after it began: start at 0 stops
  // at 100, restarting at 100 stops at 200, and so on.
  let autoStopAtEpoch = MAX_TECTONICS_EPOCHS

  // Scene-space river ribbons (crisp at any zoom, not baked into the map
  // texture). Declared before the map view so its onRecenter can tile them.
  let riverLayer: ReturnType<typeof createToroidalRibbonOverlay> | null = null

  // The flat map plane + its toroidal 3x3 recentering (see ToroidalMapView).
  const mapView = createToroidalMapView({
    scene,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    textureWidth: MAP_WIDTH,
    textureHeight: MAP_HEIGHT,
    getFocus: getCameraFocus,
    onRecenter: (centerX, centerZ) => {
      riverLayer?.recenter(centerX, centerZ)
    },
  })

  // River ribbons live in the scene over the map plane; segments come from the
  // hydrology step, tiled for the torus wrap via the recenter hook above.
  riverLayer = createToroidalRibbonOverlay({
    scene,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    textureWidth: MAP_WIDTH,
    textureHeight: MAP_HEIGHT,
  })
  riverLayer.setEnabled(false)

  const root = document.createElement('div')
  // Own root class (not the shared 'worldgen-screen') so this screen's CSS
  // doesn't collide with the legacy sphere screen's worldgen.css, which uses
  // the same selectors at equal specificity and was silently overriding these
  // styles depending on bundle order.
  root.className = 'worldgen-flat-screen'
  root.innerHTML = `
    <div class="file-actions">
      <button type="button" class="file-button" data-action="load-world" aria-label="Load world">
        <img src="/icons/folder.png" alt="" />
      </button>
      <button type="button" class="file-button" data-action="save-world" aria-label="Save world">
        <img src="/icons/floppy.png" alt="" />
      </button>
    </div>
    <button type="button" class="nav-arrow nav-arrow--back" data-action="back" aria-label="Back">‹</button>
    <button type="button" class="nav-arrow nav-arrow--next" data-action="next" aria-label="Next">›</button>
    <span class="panel-title" data-value="panel-title"></span>
    <div class="compute-progress" data-value="compute-progress" hidden>
      <span class="compute-progress-fill" data-value="compute-progress-fill"></span>
    </div>
    <div class="panel" data-panel="0">
      <label class="field field--seed">
        <span class="field-row">
          <input type="text" class="seed-input" placeholder="Seed" value="${initialSeed}" />
          <button type="button" class="icon-button" data-action="randomize-seed" aria-label="Randomize seed">
            <img src="/icons/reset.png" alt="" />
          </button>
        </span>
      </label>
      <label class="field">
        <span class="field-label">Total plates: <span data-value="plate-count-label">${TOTAL_PLATE_COUNT_DEFAULT}</span></span>
        <input
          type="range"
          class="plate-count-input"
          min="${TOTAL_PLATE_COUNT_MIN}"
          max="${TOTAL_PLATE_COUNT_MAX}"
          step="1"
          value="${TOTAL_PLATE_COUNT_DEFAULT}"
        />
      </label>
      <label class="field">
        <span class="field-label">Land fraction: <span><span data-value="land-fraction-label">${LAND_FRACTION_DEFAULT}</span>%</span></span>
        <input
          type="range"
          class="land-fraction-input"
          min="${LAND_FRACTION_MIN}"
          max="${LAND_FRACTION_MAX}"
          step="1"
          value="${LAND_FRACTION_DEFAULT}"
        />
      </label>
      <label class="field">
        <span class="field-label">Continents: <span data-value="craton-count-label">${CRATON_COUNT_DEFAULT}</span></span>
        <input
          type="range"
          class="craton-count-input"
          min="${CRATON_COUNT_MIN}"
          max="${CRATON_COUNT_MAX}"
          step="1"
          value="${CRATON_COUNT_DEFAULT}"
        />
      </label>
      <label class="field">
        <span class="field-label">Clustering: <span><span data-value="clustering-label">${CLUSTERING_DEFAULT}</span>%</span></span>
        <input
          type="range"
          class="clustering-input"
          min="${CLUSTERING_MIN}"
          max="${CLUSTERING_MAX}"
          step="1"
          value="${CLUSTERING_DEFAULT}"
        />
      </label>
    </div>
    <div class="panel" data-panel="1">
      <label class="field field--icon-row">
        <span class="field-row">
          <button type="button" class="icon-button" data-action="reset-sim" aria-label="Reset simulation">
            <img src="/icons/reset.png" alt="" />
          </button>
          <button type="button" class="icon-button" data-action="toggle-sim" aria-label="Run tectonics">
            <img src="/icons/tectonics.png" alt="" />
          </button>
          <span class="tectonics-stats">
            <span class="stat"><span class="stat-num" data-value="stat-epoch">–</span><span class="stat-label">Epoch</span></span>
            <span class="stat"><span class="stat-num" data-value="stat-plates">–</span><span class="stat-label">Plates</span></span>
            <span class="stat"><span class="stat-num" data-value="stat-continents">–</span><span class="stat-label">Continents</span></span>
            <span class="stat"><span class="stat-num"><span data-value="stat-land">–</span><span class="stat-unit">%</span></span><span class="stat-label">Land</span></span>
          </span>
        </span>
      </label>
    </div>
    <div class="panel" data-panel="2">
      <label class="field">
        <span class="field-label">Strength: <span><span data-value="erosion-strength-label">4</span>×</span></span>
        <input type="range" class="erosion-strength-input" min="1" max="5" step="1" value="4" aria-label="Erosion strength multiplier" />
      </label>
      <label class="field">
        <span class="field-label">Drainage: <span><span data-value="erosion-refresh-label">5</span>×</span></span>
        <input type="range" class="erosion-refresh-input" min="1" max="5" step="1" value="5" aria-label="Drainage network refreshes per round" />
      </label>
      <label class="field field--icon-row">
        <span class="field-row">
          <button type="button" class="icon-button" data-action="reset-erosion" aria-label="Revert to tectonics result">
            <img src="/icons/reset.png" alt="" />
          </button>
          <button type="button" class="icon-button" data-action="erode" aria-label="Run erosion">
            <img src="/icons/erosion.png" alt="" />
          </button>
        </span>
      </label>
    </div>
    <div class="panel" data-panel="3">
      <label class="field">
        <span class="field-label">Temperature: <span><span data-value="temp-band-label">0</span>°C</span></span>
        <input type="range" class="temp-band-input" min="-20" max="20" step="1" value="0" aria-label="Temperature offset (°C)" />
      </label>
      <label class="field">
        <span class="field-label">Equator: <span><span data-value="equator-offset-label">0</span>%</span></span>
        <input type="range" class="equator-offset-input" min="-50" max="50" step="5" value="0" aria-label="Equator latitudinal shift (% of map height)" />
      </label>
      <label class="field">
        <span class="field-label">Humidity: <span><span data-value="humidity-label">100</span>%</span></span>
        <input type="range" class="humidity-input" min="40" max="200" step="5" value="100" aria-label="Global humidity (%)" />
      </label>
      <label class="field">
        <span class="field-label">Contrast: <span><span data-value="contrast-label">100</span>%</span></span>
        <input type="range" class="contrast-input" min="30" max="170" step="5" value="100" aria-label="Equator–pole temperature contrast (%)" />
      </label>
      <label class="field field--icon-row">
        <span class="field-row">
          <span class="climate-readout">
            <span>Min: <span data-value="temp-min">–</span>°C</span>
            <span>Max: <span data-value="temp-max">–</span>°C</span>
          </span>
          <span class="erosion-status" data-value="climate-status"></span>
        </span>
      </label>
    </div>
    <div class="panel" data-panel="4">
      <label class="field">
        <span class="field-label">River density: <span data-value="river-density-label">55</span></span>
        <input type="range" class="river-density-input" min="0" max="100" step="1" value="55" aria-label="River density" />
      </label>
    </div>
    <div class="panel" data-panel="5">
      <label class="field" data-ecofield="carryingCapacity">
        <span class="field-label">Carrying capacity: <span><span data-value="carrying-capacity-label">100</span>%</span></span>
        <input type="range" class="carrying-capacity-input" min="50" max="200" step="5" value="100" aria-label="Carrying capacity (%)" />
      </label>
      <label class="field" data-ecofield="carryingCapacity">
        <span class="field-label">Concentration: <span data-value="concentration-label">0</span></span>
        <input type="range" class="concentration-input" min="-100" max="100" step="5" value="0" aria-label="Resource concentration (even ↔ clumped)" />
      </label>
      <label class="field" data-ecofield="carryingCapacity">
        <span class="field-label">Provinces: <span data-value="province-label">45</span></span>
        <input type="range" class="province-input" min="0" max="100" step="5" value="45" aria-label="Province strength" />
      </label>
      <span class="ecology-cat-buttons">
        <button type="button" class="icon-button ecology-cat" data-eco-cat="subsistence" aria-label="Subsistence"><img src="/icons/wheat.png" alt="" /></button>
        <button type="button" class="icon-button ecology-cat" data-eco-cat="material" aria-label="Material"><img src="/icons/stone_axe.png" alt="" /></button>
        <button type="button" class="icon-button ecology-cat" data-eco-cat="metals" aria-label="Metals"><img src="/icons/ecology.png" alt="" /></button>
        <button type="button" class="icon-button ecology-cat" data-eco-cat="prestige" aria-label="Prestige"><img src="/icons/crown.png" alt="" /></button>
      </span>
      <div class="ecology-foldout" data-value="ecology-foldout" hidden></div>
    </div>
  `

  const seedInput = root.querySelector<HTMLInputElement>('.seed-input')!
  const plateCountInput = root.querySelector<HTMLInputElement>('.plate-count-input')!
  const plateCountLabel = root.querySelector<HTMLElement>('[data-value="plate-count-label"]')!
  const landFractionInput = root.querySelector<HTMLInputElement>('.land-fraction-input')!
  const landFractionLabel = root.querySelector<HTMLElement>('[data-value="land-fraction-label"]')!
  const clusteringInput = root.querySelector<HTMLInputElement>('.clustering-input')!
  const clusteringLabel = root.querySelector<HTMLElement>('[data-value="clustering-label"]')!
  const cratonCountInput = root.querySelector<HTMLInputElement>('.craton-count-input')!
  const cratonCountLabel = root.querySelector<HTMLElement>('[data-value="craton-count-label"]')!
  const randomizeButton = root.querySelector<HTMLButtonElement>('[data-action="randomize-seed"]')!
  const resetButton = root.querySelector<HTMLButtonElement>('[data-action="reset-sim"]')!
  const toggleSimButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-sim"]')!
  const erodeButton = root.querySelector<HTMLButtonElement>('[data-action="erode"]')!
  // Erosion-strength multiplier (scales the fluvial time step — essentially free
  // compute-wise, it just erodes more per step) and drainage-network refresh count
  // (re-derives the river network within a round so channels migrate/capture — costs
  // one extra priority-flood each, the only real time cost). See the erosion docs.
  const strengthInput = root.querySelector<HTMLInputElement>('.erosion-strength-input')!
  const strengthLabel = root.querySelector<HTMLElement>('[data-value="erosion-strength-label"]')!
  const refreshInput = root.querySelector<HTMLInputElement>('.erosion-refresh-input')!
  const refreshLabel = root.querySelector<HTMLElement>('[data-value="erosion-refresh-label"]')!
  strengthInput.addEventListener('input', () => { strengthLabel.textContent = strengthInput.value })
  refreshInput.addEventListener('input', () => { refreshLabel.textContent = refreshInput.value })
  const resetErosionButton = root.querySelector<HTMLButtonElement>('[data-action="reset-erosion"]')!
  const loadWorldButton = root.querySelector<HTMLButtonElement>('[data-action="load-world"]')!
  const saveWorldButton = root.querySelector<HTMLButtonElement>('[data-action="save-world"]')!
  const climateStatus = root.querySelector<HTMLElement>('[data-value="climate-status"]')!
  const tempBandInput = root.querySelector<HTMLInputElement>('.temp-band-input')!
  const tempBandLabel = root.querySelector<HTMLElement>('[data-value="temp-band-label"]')!
  const humidityInput = root.querySelector<HTMLInputElement>('.humidity-input')!
  const humidityLabel = root.querySelector<HTMLElement>('[data-value="humidity-label"]')!
  const contrastInput = root.querySelector<HTMLInputElement>('.contrast-input')!
  const contrastLabel = root.querySelector<HTMLElement>('[data-value="contrast-label"]')!
  const equatorOffsetInput = root.querySelector<HTMLInputElement>('.equator-offset-input')!
  const equatorOffsetLabel = root.querySelector<HTMLElement>('[data-value="equator-offset-label"]')!
  const riverDensityInput = root.querySelector<HTMLInputElement>('.river-density-input')!
  const riverDensityLabel = root.querySelector<HTMLElement>('[data-value="river-density-label"]')!
  const carryingCapacityInput = root.querySelector<HTMLInputElement>('.carrying-capacity-input')!
  const carryingCapacityLabel = root.querySelector<HTMLElement>('[data-value="carrying-capacity-label"]')!
  const concentrationInput = root.querySelector<HTMLInputElement>('.concentration-input')!
  const concentrationLabel = root.querySelector<HTMLElement>('[data-value="concentration-label"]')!
  const tempMaxLabel = root.querySelector<HTMLElement>('[data-value="temp-max"]')!
  const tempMinLabel = root.querySelector<HTMLElement>('[data-value="temp-min"]')!
  const statLand = root.querySelector<HTMLElement>('[data-value="stat-land"]')!
  const statEpoch = root.querySelector<HTMLElement>('[data-value="stat-epoch"]')!
  const statPlates = root.querySelector<HTMLElement>('[data-value="stat-plates"]')!
  const statContinents = root.querySelector<HTMLElement>('[data-value="stat-continents"]')!
  const erodeIcon = erodeButton.querySelector<HTMLImageElement>('img')!
  const toggleSimIcon = toggleSimButton.querySelector<HTMLImageElement>('img')!
  const backButton = root.querySelector<HTMLButtonElement>('[data-action="back"]')!
  const nextButton = root.querySelector<HTMLButtonElement>('[data-action="next"]')!
  const computeProgress = root.querySelector<HTMLElement>('[data-value="compute-progress"]')!
  const computeProgressFill = root.querySelector<HTMLElement>('[data-value="compute-progress-fill"]')!

  // Simulation and rendering both happen inside this worker (see
  // plateSimulationWorker.ts) — stepping an epoch and rendering the full
  // raster are heavy enough that doing them on the main thread stalled
  // camera panning/input for the duration of every tick.
  const worker = new Worker(new URL('../../worldgen/plateSimulationWorker.ts', import.meta.url), { type: 'module' })
  const postToWorker = (message: WorkerInboundMessage): void => worker.postMessage(message)

  let simRunning = false
  // Any worker computation in flight: tectonics ticking, an erosion pass, or a
  // climate/hydrology compute. While busy, ALL bottom-panel controls are disabled
  // except the ACTIVE process's stop button (the only allowed action).
  let erosionOpInFlight = false
  let climateInFlight = false
  let hydrologyInFlight = false
  let ecologyInFlight = false
  let erosionProgressFraction = 0
  const isBusy = (): boolean => simRunning || erosionOpInFlight || climateInFlight || hydrologyInFlight || ecologyInFlight

  // Disable every panel control while a compute runs; the running process keeps its
  // stop button live (tectonics = toggle-sim, erosion = erode, which becomes a stop).
  const updateControlsDisabled = (): void => {
    const busy = isBusy()
    randomizeButton.disabled = busy
    resetButton.disabled = busy
    resetErosionButton.disabled = busy
    loadWorldButton.disabled = busy
    saveWorldButton.disabled = busy
    // Stop buttons of the active process stay enabled.
    toggleSimButton.disabled = busy && !simRunning
    erodeButton.disabled = busy && !erosionOpInFlight
    // Genesis inputs (debounced-)regenerate the whole world, so lock them while busy;
    // the erosion/climate/river sliders are left live for tuning (they only affect the
    // next pass, not the one in flight).
    for (const el of [seedInput, plateCountInput, landFractionInput, cratonCountInput, clusteringInput]) el.disabled = busy
    backButton.disabled = busy
    nextButton.disabled = busy
    updateNavState() // nav arrows also lock while busy (see its own gating)
  }

  // The centered progress indicator over the panel: a real 0..100 bar for erosion, an
  // indeterminate sweep for the open-ended processes (tectonics runs until you stop it;
  // climate/hydrology report no fraction). Hidden when idle.
  const updateProgress = (): void => {
    if (erosionOpInFlight) {
      computeProgress.hidden = false
      computeProgress.classList.remove('is-indeterminate')
      computeProgressFill.style.width = `${Math.round(erosionProgressFraction * 100)}%`
    } else if (simRunning || climateInFlight || hydrologyInFlight || ecologyInFlight) {
      computeProgress.hidden = false
      computeProgress.classList.add('is-indeterminate')
      computeProgressFill.style.width = ''
    } else {
      computeProgress.hidden = true
    }
  }

  let lastPlateCount = 0
  let lastContinentCount = 0
  const updateStats = (): void => {
    statLand.textContent = String(Math.round(lastLandFraction * 100))
    statEpoch.textContent = String(lastEpoch)
    statPlates.textContent = String(lastPlateCount)
    statContinents.textContent = String(lastContinentCount)
  }
  updateStats()

  // Overlays (boundaries / names / events / arrows) are composited on the main
  // thread over the worker's base color raster — the worker has no Canvas2D
  // (fonts/strokes) and toggling must be instant, so the base raster + overlay
  // source data are retained here and re-composited on demand rather than
  // re-rendered. The generic mechanism (canvas, toggle state, marker fade,
  // texture upload) lives in MapOverlayCompositor; only the worldgen-specific
  // layer drawing + event→marker/notification mapping stays here.
  let lastBoundaryMask: Uint8Array | null = null
  let lastPlateArrows: PlateArrow[] = []
  let lastRaftLabels: ContinentLabelPlacement[] = []
  // Coarse mantle buoyancy field + hotspot plumes (from each render) for the
  // tectonics "Mantle" overlay: hot upwelling → red, cold downwelling → blue, plus
  // a marker at each fixed plume (the source of the hotspot volcano chains).
  let lastMantle: Float32Array | null = null
  let mantleResX = 0
  let mantleResY = 0
  let lastHotspots: { x: number; y: number }[] = []
  let lastVolcanoes: { x: number; y: number; thickness: number; kind: 'hotspot' | 'flood' | 'arc' }[] = []
  // Two base rasters: the full-colour terrain (default) and a neutral relief base
  // (light-blue water, white-shaded land) used on the Climate/Rivers panels so
  // the data overlays read clearly. The simplified RGBA is built lazily from the
  // worker's compact relief bytes and cached until the next render.
  let lastColoredBase: Uint8ClampedArray | null = null
  let lastRelief: Uint8Array | null = null
  let simplifiedBaseCache: Uint8ClampedArray | null = null
  // Coarse climate rasters (from the worker's computeClimate step). Sampled up
  // to full map resolution in the overlay paint fns. null until computed / when
  // invalidated by an upstream reset.
  const CLIMATE_PANEL_INDEX = 3
  let lastTemperature: Float32Array | null = null
  let lastWind: Float32Array | null = null
  let lastPrecipitation: Float32Array | null = null
  let lastCurrents: Float32Array | null = null
  let lastSeasonality: Float32Array | null = null
  let lastMonsoonIndex: Float32Array | null = null
  let lastBiomes: Uint8Array | null = null
  let climateResX = 0
  let climateResY = 0
  // Rivers/lakes (hydrology) panel — its own step after climate. River segments
  // come from the worker's computeHydrology; null until computed / invalidated.
  const HYDROLOGY_PANEL_INDEX = 4
  let lastRiverData: { points: Float32Array; lengths: Uint32Array } | null = null
  let lastLakeDepth: Float32Array | null = null
  // Ecology (resource/suitability) panel — its own step after hydrology. Phase 1:
  // the carrying-capacity field only. null until computed / invalidated.
  const ECOLOGY_PANEL_INDEX = 5
  // All computed ecology fields, keyed by id (see ecology/ecologyField). The
  // single ecology overlay paints whichever `selectedEcologyField` is chosen in
  // the panel selector, on an absolute 0..1 scale.
  let lastEcologyFields: Partial<Record<EcologyFieldId, Float32Array>> = {}
  let selectedEcologyField: EcologyFieldId = 'carryingCapacity'
  // Field currently previewed by hovering a panel slider/icon (null = not
  // hovering). While non-null the ecology overlay shows even if its toolbar
  // toggle is off, and reverts when the mouse leaves the panel.
  let ecologyHoverField: EcologyFieldId | null = null
  const ecologyLayerOn = (): boolean => (overlaysOn.ecology || ecologyHoverField !== null) && hasEcologyData()
  let ecologyResX = 0
  let ecologyResY = 0
  const hasEcologyData = (): boolean => lastEcologyFields.carryingCapacity != null

  function paintBoundaryMask(data: Uint8ClampedArray): void {
    if (!lastBoundaryMask) return
    for (let i = 0; i < lastBoundaryMask.length; i++) {
      if (lastBoundaryMask[i]) {
        const p = i * 4
        data[p] = BOUNDARY_COLOR[0]
        data[p + 1] = BOUNDARY_COLOR[1]
        data[p + 2] = BOUNDARY_COLOR[2]
      }
    }
  }

  // Mantle buoyancy tint: hot upwelling → red, cold downwelling → blue, strength
  // ∝ |value| (near-zero stays transparent). Coarse field sampled up to full res.
  function paintMantle(data: Uint8ClampedArray): void {
    if (!lastMantle) return
    for (let y = 0; y < MAP_HEIGHT; y++) {
      const gy = Math.min(mantleResY - 1, Math.floor((y / MAP_HEIGHT) * mantleResY))
      for (let x = 0; x < MAP_WIDTH; x++) {
        const gx = Math.min(mantleResX - 1, Math.floor((x / MAP_WIDTH) * mantleResX))
        const v = lastMantle[gy * mantleResX + gx]
        const a = Math.min(1, Math.abs(v) / 1.0) * 0.55
        if (a < 0.01) continue
        const r = v >= 0 ? 225 : 55
        const g = v >= 0 ? 85 : 110
        const b = v >= 0 ? 55 : 210
        const p = (y * MAP_WIDTH + x) * 4
        data[p] = data[p] * (1 - a) + r * a
        data[p + 1] = data[p + 1] * (1 - a) + g * a
        data[p + 2] = data[p + 2] * (1 - a) + b * a
      }
    }
  }

  // Mantle-driver markers, drawn onto the base texture so the toroidal tiling wraps
  // them: the volcanic PRODUCTS (red cones = hotspot chains, dark cones = flood-basalt
  // provinces, sized by thickness) underneath, then the fixed plume SOURCES (orange
  // rings) the hotspot chains trail from.
  function drawMantleMarkers(c: CanvasRenderingContext2D): void {
    for (const v of lastVolcanoes) {
      // Arc volcanoes are smaller (individual cones in a chain); hotspot cones and
      // flood-basalt provinces are larger single edifices. Cone height ∝ thickness.
      const isArc = v.kind === 'arc'
      const s = isArc ? Math.max(3, Math.min(9, 2 + v.thickness * 0.25)) : Math.max(4, Math.min(15, 3 + v.thickness * 0.35))
      // The base texture is displayed Y-flipped, so the apex sits at +s (canvas
      // space) to point up on screen.
      c.beginPath()
      c.moveTo(v.x, v.y + s)
      c.lineTo(v.x - s * 0.85, v.y - s * 0.6)
      c.lineTo(v.x + s * 0.85, v.y - s * 0.6)
      c.closePath()
      // flood = dark maroon province, hotspot = bright red cone, arc = orange cone.
      c.fillStyle = v.kind === 'flood' ? 'rgba(120, 25, 20, 0.85)' : v.kind === 'arc' ? 'rgba(235, 120, 30, 0.9)' : 'rgba(220, 55, 30, 0.9)'
      c.fill()
      c.lineWidth = isArc ? 1 : 1.5
      c.strokeStyle = 'rgba(60, 12, 0, 0.9)'
      c.stroke()
    }
    for (const hs of lastHotspots) {
      c.beginPath()
      c.arc(hs.x, hs.y, 9, 0, Math.PI * 2)
      c.fillStyle = 'rgba(255, 140, 0, 0.9)'
      c.fill()
      c.lineWidth = 3
      c.strokeStyle = 'rgba(90, 30, 0, 0.95)'
      c.stroke()
    }
  }

  function drawArrows(c: CanvasRenderingContext2D): void {
    c.strokeStyle = ARROW_COLOR
    c.lineWidth = 2
    c.lineCap = 'round'
    for (const { x, y, vx, vy } of lastPlateArrows) {
      const endX = x + vx
      const endY = y + vy
      const angle = Math.atan2(vy, vx)
      c.beginPath()
      c.moveTo(x, y)
      c.lineTo(endX, endY)
      for (const wing of [-1, 1]) {
        const wa = angle + Math.PI + wing * ((25 * Math.PI) / 180)
        c.moveTo(endX, endY)
        c.lineTo(endX + Math.cos(wa) * 12, endY + Math.sin(wa) * 12)
      }
      c.stroke()
    }
  }

  // Temperature heatmap tint (climate) — a pixel layer blended over the terrain
  // so both show. Samples the coarse climate grid (nearest cell) per map pixel.
  // No-op until climate is computed. Drawn before boundaries/names so those
  // stay legible on top.
  function paintTemperature(data: Uint8ClampedArray): void {
    if (!lastTemperature) return
    const alpha = 0.55
    for (let y = 0; y < MAP_HEIGHT; y++) {
      const gy = Math.min(climateResY - 1, Math.floor((y / MAP_HEIGHT) * climateResY))
      for (let x = 0; x < MAP_WIDTH; x++) {
        const gx = Math.min(climateResX - 1, Math.floor((x / MAP_WIDTH) * climateResX))
        const [r, g, b] = temperatureColor(lastTemperature[gy * climateResX + gx])
        const p = (y * MAP_WIDTH + x) * 4
        data[p] = data[p] * (1 - alpha) + r * alpha
        data[p + 1] = data[p + 1] * (1 - alpha) + g * alpha
        data[p + 2] = data[p + 2] * (1 - alpha) + b * alpha
      }
    }
  }

  // Ecology tint: paints whichever field the panel selector has chosen, land
  // only, on an ABSOLUTE 0..1 scale (the ramp clamps). Absolute — NOT self-
  // normalised — so the fold-out weight/strength/rarity knobs are actually
  // visible (a uniform scale would vanish under max-normalisation). Ocean =
  // ECOLOGY_OCEAN sentinel, left as terrain. No-op until computed.
  function paintEcology(data: Uint8ClampedArray): void {
    const field = lastEcologyFields[selectedEcologyField]
    if (!field) return
    const alpha = 0.6
    for (let y = 0; y < MAP_HEIGHT; y++) {
      const gy = Math.min(ecologyResY - 1, Math.floor((y / MAP_HEIGHT) * ecologyResY))
      for (let x = 0; x < MAP_WIDTH; x++) {
        const gx = Math.min(ecologyResX - 1, Math.floor((x / MAP_WIDTH) * ecologyResX))
        const v = field[gy * ecologyResX + gx]
        if (v === ECOLOGY_OCEAN) continue
        const [r, g, b] = ecologyFieldColor(selectedEcologyField, v)
        const p = (y * MAP_WIDTH + x) * 4
        data[p] = data[p] * (1 - alpha) + r * alpha
        data[p + 1] = data[p + 1] * (1 - alpha) + g * alpha
        data[p + 2] = data[p + 2] * (1 - alpha) + b * alpha
      }
    }
  }

  // Precipitation heatmap tint (climate), land only — ocean cells carry the
  // OCEAN_PRECIP sentinel and are left as terrain. No-op until computed.
  function paintPrecipitation(data: Uint8ClampedArray): void {
    if (!lastPrecipitation) return
    const alpha = 0.6
    for (let y = 0; y < MAP_HEIGHT; y++) {
      const gy = Math.min(climateResY - 1, Math.floor((y / MAP_HEIGHT) * climateResY))
      for (let x = 0; x < MAP_WIDTH; x++) {
        const gx = Math.min(climateResX - 1, Math.floor((x / MAP_WIDTH) * climateResX))
        const mm = lastPrecipitation[gy * climateResX + gx]
        if (mm === OCEAN_PRECIP) continue
        const [r, g, b] = precipitationColor(mm)
        const p = (y * MAP_WIDTH + x) * 4
        data[p] = data[p] * (1 - alpha) + r * alpha
        data[p + 1] = data[p + 1] * (1 - alpha) + g * alpha
        data[p + 2] = data[p + 2] * (1 - alpha) + b * alpha
      }
    }
  }

  // Monsoon / precipitation-seasonality index (0 even → 1 strongly wet-dry), land only
  // (ocean = OCEAN_PRECIP sentinel, left as terrain). No-op until computed.
  function paintMonsoon(data: Uint8ClampedArray): void {
    if (!lastMonsoonIndex) return
    const alpha = 0.6
    for (let y = 0; y < MAP_HEIGHT; y++) {
      const gy = Math.min(climateResY - 1, Math.floor((y / MAP_HEIGHT) * climateResY))
      for (let x = 0; x < MAP_WIDTH; x++) {
        const gx = Math.min(climateResX - 1, Math.floor((x / MAP_WIDTH) * climateResX))
        const idx = lastMonsoonIndex[gy * climateResX + gx]
        if (idx === OCEAN_PRECIP) continue
        const [r, g, b] = monsoonColor(idx)
        const p = (y * MAP_WIDTH + x) * 4
        data[p] = data[p] * (1 - alpha) + r * alpha
        data[p + 1] = data[p + 1] * (1 - alpha) + g * alpha
        data[p + 2] = data[p + 2] * (1 - alpha) + b * alpha
      }
    }
  }

  // Prevailing-wind arrows (climate) — a coarse grid of arrows sampling the
  // wind field, drawn over the map. Calm belts (near-zero magnitude) draw no
  // arrow. No-op until climate is computed.
  function drawWind(c: CanvasRenderingContext2D): void {
    if (!lastWind) return
    const cols = 40
    const rows = 20
    const scale = 42
    c.strokeStyle = 'rgba(15, 45, 65, 0.8)'
    c.lineWidth = 2
    c.lineCap = 'round'
    for (let r = 0; r < rows; r++) {
      const py = ((r + 0.5) / rows) * MAP_HEIGHT
      const gy = Math.min(climateResY - 1, Math.floor((py / MAP_HEIGHT) * climateResY))
      for (let col = 0; col < cols; col++) {
        const px = ((col + 0.5) / cols) * MAP_WIDTH
        const gx = Math.min(climateResX - 1, Math.floor((px / MAP_WIDTH) * climateResX))
        const u = lastWind[(gy * climateResX + gx) * 2]
        const v = lastWind[(gy * climateResX + gx) * 2 + 1]
        if (Math.hypot(u, v) < 0.05) continue
        const ex = px + u * scale
        const ey = py + v * scale
        const angle = Math.atan2(v, u)
        c.beginPath()
        c.moveTo(px, py)
        c.lineTo(ex, ey)
        for (const wing of [-1, 1]) {
          const wa = angle + Math.PI + wing * ((25 * Math.PI) / 180)
          c.moveTo(ex, ey)
          c.lineTo(ex + Math.cos(wa) * 8, ey + Math.sin(wa) * 8)
        }
        c.stroke()
      }
    }
  }

  // Seasonality tint (climate): the annual temperature amplitude everywhere —
  // stable teal near coasts/equator, extreme purple in continental interiors at
  // high latitude. No-op until computed.
  function paintSeasonality(data: Uint8ClampedArray): void {
    if (!lastSeasonality) return
    const alpha = 0.6
    for (let y = 0; y < MAP_HEIGHT; y++) {
      const gy = Math.min(climateResY - 1, Math.floor((y / MAP_HEIGHT) * climateResY))
      for (let x = 0; x < MAP_WIDTH; x++) {
        const gx = Math.min(climateResX - 1, Math.floor((x / MAP_WIDTH) * climateResX))
        const amp = lastSeasonality[gy * climateResX + gx]
        if (amp === OCEAN_AMPLITUDE) continue
        const [r, g, b] = amplitudeColor(amp)
        const p = (y * MAP_WIDTH + x) * 4
        data[p] = data[p] * (1 - alpha) + r * alpha
        data[p + 1] = data[p + 1] * (1 - alpha) + g * alpha
        data[p + 2] = data[p + 2] * (1 - alpha) + b * alpha
      }
    }
  }

  // Biome tint (climate payoff): the Whittaker class per land cell, opaque so it
  // reads as a map rather than a wash. Ocean cells are skipped (the base ocean
  // shows through). No-op until computed.
  function paintBiomes(data: Uint8ClampedArray): void {
    if (!lastBiomes) return
    const alpha = 0.85
    for (let y = 0; y < MAP_HEIGHT; y++) {
      const gy = Math.min(climateResY - 1, Math.floor((y / MAP_HEIGHT) * climateResY))
      for (let x = 0; x < MAP_WIDTH; x++) {
        const gx = Math.min(climateResX - 1, Math.floor((x / MAP_WIDTH) * climateResX))
        const id = lastBiomes[gy * climateResX + gx]
        if (id === Biome.Ocean) continue
        const [r, g, b] = biomeColor(id)
        const p = (y * MAP_WIDTH + x) * 4
        data[p] = data[p] * (1 - alpha) + r * alpha
        data[p + 1] = data[p + 1] * (1 - alpha) + g * alpha
        data[p + 2] = data[p + 2] * (1 - alpha) + b * alpha
      }
    }
  }

  // Bilinear-sampled ocean current (u,v) at a map pixel, wrapped. Zero over land.
  function sampleCurrent(px: number, py: number): [number, number] {
    if (!lastCurrents) return [0, 0]
    const fx = (px / MAP_WIDTH) * climateResX - 0.5
    const fy = (py / MAP_HEIGHT) * climateResY - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const wrap = (a: number, n: number): number => ((a % n) + n) % n
    const xa = wrap(x0, climateResX)
    const xb = wrap(x0 + 1, climateResX)
    const ya = wrap(y0, climateResY)
    const yb = wrap(y0 + 1, climateResY)
    const at = (xw: number, yw: number, comp: number): number => lastCurrents![(yw * climateResX + xw) * 2 + comp]
    const lerp2 = (comp: number): number =>
      (at(xa, ya, comp) * (1 - tx) + at(xb, ya, comp) * tx) * (1 - ty) + (at(xa, yb, comp) * (1 - tx) + at(xb, yb, comp) * tx) * ty
    return [lerp2(0), lerp2(1)]
  }

  // Ocean currents as streamlines: from a grid of seeds, trace along the current
  // and draw the path, so the gyres read as loops. Each segment is colored by
  // whether the flow is poleward (carrying warm water — reddish) or equatorward
  // (cold — bluish), the climate-relevant distinction. Two batched paths keep it
  // to two strokes. Streamlines stop where the current goes calm (i.e. at land).
  function drawCurrents(c: CanvasRenderingContext2D): void {
    if (!lastCurrents) return
    const cols = 60
    const rows = 30
    const step = 6
    const steps = 28
    const threshold = 0.1
    const mid = MAP_HEIGHT / 2
    const warmPath = new Path2D()
    const coldPath = new Path2D()
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        let x = ((col + 0.5) / cols) * MAP_WIDTH
        let y = ((r + 0.5) / rows) * MAP_HEIGHT
        for (let s = 0; s < steps; s++) {
          const [u, v] = sampleCurrent(x, y)
          if (Math.hypot(u, v) < threshold) break
          const nx = x + u * step
          const ny = y + v * step
          const path = v * (y - mid) > 0 ? warmPath : coldPath
          path.moveTo(x, y)
          path.lineTo(nx, ny)
          // Wrap for the next sample; a seam-crossing segment just clips.
          x = ((nx % MAP_WIDTH) + MAP_WIDTH) % MAP_WIDTH
          y = ((ny % MAP_HEIGHT) + MAP_HEIGHT) % MAP_HEIGHT
        }
      }
    }
    c.lineWidth = 1.5
    c.lineCap = 'round'
    c.strokeStyle = 'rgba(205, 65, 50, 0.55)'
    c.stroke(warmPath)
    c.strokeStyle = 'rgba(40, 95, 185, 0.6)'
    c.stroke(coldPath)
  }

  // Rivers are NOT a compositor (texture) layer — they're scene-space ribbon
  // geometry (riverLayer) so they stay crisp at any zoom. See handleHydrologyData.

  // Lakes ARE a texture layer (filled water areas, low-frequency — texture blur
  // on zoom is far less objectionable than for thin rivers). Blue tint over cells
  // with water depth, slightly deeper = darker. lakeDepth is full-res (= map
  // resolution), so it indexes the pixel buffer directly.
  function paintLakes(data: Uint8ClampedArray): void {
    if (!lastLakeDepth) return
    for (let i = 0; i < lastLakeDepth.length; i++) {
      const d = lastLakeDepth[i]
      if (d <= 0) continue
      const shade = Math.min(1, d * 6) // deeper → richer blue
      const r = 60 - 25 * shade
      const g = 110 - 30 * shade
      const b = 170 - 20 * shade
      const p = i * 4
      const a = 0.75
      data[p] = data[p] * (1 - a) + r * a
      data[p + 1] = data[p + 1] * (1 - a) + g * a
      data[p + 2] = data[p + 2] * (1 - a) + b * a
    }
  }

  // Layer draw/list order: temperature first (a base tint), names last so labels
  // stay on top (always readable); the climate layers (temperature, wind) are
  // hidden from the overlay bar — toggled from the climate panel instead. The
  // 'events' layer has no static paint — it just gates the transient event
  // markers (added via overlay.addMarker).
  // Latest composited RGBA (retained for the save preview thumbnail).
  let lastCompositePixels: Uint8Array | null = null
  const overlay = new MapOverlayCompositor(MAP_WIDTH, MAP_HEIGHT, (pixels) => {
    lastCompositePixels = pixels
    mapView.texture.update(pixels)
  })

  // Torus wrap for VECTOR overlays (labels, markers, arrows): the compositor canvas is
  // MAP_WIDTH×MAP_HEIGHT and doesn't wrap, so an element straddling the seam gets clipped
  // at the edge — a wide continent name near x=0/x=MAP_WIDTH loses half itself, then the
  // 3×3 texture tiling just repeats the clipped copy. Drawing `fn` at all 9 tile offsets
  // makes the overflow reappear on the opposite edge, so it stitches back together across
  // the seam. (Full-raster paintPixels layers already cover the whole canvas, so only the
  // shape/text `paint` layers need this.) See the [[project_worldgen_canvas_flip]] note.
  const paintWrapped = (c: CanvasRenderingContext2D, fn: (c: CanvasRenderingContext2D) => void): void => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        c.save()
        c.translate(dx * MAP_WIDTH, dy * MAP_HEIGHT)
        fn(c)
        c.restore()
      }
    }
  }

  overlay.setLayers([
    // Muted terrain wash first (bottom-most tint, over the relief base).
    { id: 'terrain', label: 'Terrain', enabled: false, hidden: true, paintPixels: paintTerrain },
    { id: 'temperature', label: 'Temp', enabled: false, hidden: true, paintPixels: paintTemperature },
    { id: 'precipitation', label: 'Precipitation', enabled: false, hidden: true, paintPixels: paintPrecipitation },
    { id: 'monsoon', label: 'Monsoon', enabled: false, hidden: true, paintPixels: paintMonsoon },
    { id: 'seasonality', label: 'Seasonality', enabled: false, hidden: true, paintPixels: paintSeasonality },
    { id: 'biomes', label: 'Biomes', enabled: false, hidden: true, paintPixels: paintBiomes },
    { id: 'ecology', label: 'Ecology', enabled: false, hidden: true, paintPixels: paintEcology },
    // Mantle: field tint (paintPixels) + hotspot plume markers (paint) in one layer.
    { id: 'mantle', label: 'Mantle', enabled: false, hidden: true, paintPixels: paintMantle, paint: (c) => paintWrapped(c, drawMantleMarkers) },
    { id: 'boundaries', label: 'Boundaries', enabled: false, paintPixels: paintBoundaryMask },
    { id: 'arrows', label: 'Arrows', enabled: false, paint: (c) => paintWrapped(c, drawArrows) },
    { id: 'wind', label: 'Wind', enabled: false, hidden: true, paint: drawWind },
    { id: 'currents', label: 'Currents', enabled: false, hidden: true, paint: drawCurrents },
    { id: 'lakes', label: 'Lakes', enabled: false, hidden: true, paintPixels: paintLakes },
    // Events are always on — a persistent notification-coupled marker layer, not
    // a user toggle. Arrows are unused (no toggle), kept only so the id resolves.
    { id: 'events', label: 'Events', enabled: true },
    { id: 'names', label: 'Names', enabled: false, paint: (c) => paintWrapped(c, (cc) => drawContinentLabels(cc, lastRaftLabels)) },
  ])

  // Draws one tectonic event's geologic marker, faded by `alpha`: a suture band
  // (collision), a dashed rift axis (breakup), or a ring (supercontinent /
  // routine point). The worldgen-specific side of the generic marker facility.
  function drawEventMarker(c: CanvasRenderingContext2D, ev: SimEvent, alpha: number): void {
    const color = ev.type === 'continent_broke_up' ? BREAKUP_COLOR : COLLISION_COLOR
    c.strokeStyle = `rgba(${color}, ${alpha})`
    c.lineCap = 'round'
    if (ev.x === undefined || ev.y === undefined) return
    if (ev.dirX && ev.dirY) {
      const hl = EVENT_MARKER_HALF_LENGTH
      c.lineWidth = ev.type === 'continent_collided' ? 8 : 5
      if (ev.type === 'continent_broke_up') c.setLineDash([14, 10])
      c.beginPath()
      c.moveTo(ev.x - ev.dirX * hl, ev.y - ev.dirY * hl)
      c.lineTo(ev.x + ev.dirX * hl, ev.y + ev.dirY * hl)
      c.stroke()
      c.setLineDash([])
    } else {
      const r = ev.type === 'supercontinent_formed' ? 26 : 12
      c.lineWidth = ev.type === 'supercontinent_formed' ? 5 : 3
      c.beginPath()
      c.arc(ev.x, ev.y, r, 0, Math.PI * 2)
      c.stroke()
    }
  }

  function eventText(ev: SimEvent): { message: string; icon: string } {
    switch (ev.type) {
      case 'continent_collided':
        return { message: ev.nameA && ev.nameB ? `${ev.nameA} and ${ev.nameB} collided` : 'Two continents collided', icon: '/icons/continent.png' }
      case 'continent_broke_up':
        return { message: ev.name ? `${ev.name} is breaking apart` : 'A continent is breaking apart', icon: '/icons/continent.png' }
      case 'supercontinent_formed':
        return { message: ev.name ? `Supercontinent ${ev.name} formed` : 'A supercontinent has formed', icon: '/icons/crown.png' }
      default:
        return { message: '', icon: '/icons/ocean.png' }
    }
  }

  // Turns sim events into faded map markers (all events) + notifications
  // (continent-scale only), sharing one lifetime so a toast and its marker fade
  // together (the user's coupling choice). Routine crust churn is overlay-only.
  function handleSimEvents(events: SimEvent[]): void {
    if (!events || events.length === 0) return
    for (const ev of events) {
      // Only continent-scale events (collision / breakup / supercontinent) get a map
      // marker + toast. Routine crust churn (oceanic plate created at a rift / subducted)
      // used to drop a faint, unlabelled BLUE RING with no notification — removed as
      // cryptic clutter. Re-add here if that seafloor activity is wanted back.
      if (eventCategory(ev.type) !== 'continent') continue
      if (ev.x !== undefined && ev.y !== undefined) {
        overlay.addMarker('events', { lifetimeMs: EVENT_CONTINENT_LIFETIME_MS, paint: (c, alpha) => paintWrapped(c, (cc) => drawEventMarker(cc, ev, alpha)) })
      }
      const { message, icon } = eventText(ev)
      ctx.notifications.show({ message, icon, durationMs: EVENT_CONTINENT_LIFETIME_MS })
    }
  }

  // Shows/hides the temperature overlay and keeps its three visual states in
  // sync: the panel's temp toggle button (icon), the overlay-bar chip, and the
  // layer itself. The panel button and the overlay chip are two doors to the
  // same switch.
  // The hover tooltip (created near setup end); refresh()ed whenever the data or
  // active overlays change so a stationary readout stays in sync.
  let hoverTooltip: ReturnType<typeof createMapHoverTooltip> | null = null

  // Unified overlay toolbar (top-center, persistent across all panels). Every
  // toggleable overlay is one icon button; a button is disabled until its data
  // exists (its `available`), and shows an active state when on. 'rivers' bundles
  // the scene-space river ribbons + the lake tint under one control. Events are
  // NOT here — they're always on. Order = display order in the bar.
  // A legend explains an overlay's colours; only overlays whose colour→meaning
  // isn't self-evident carry one (names/cells/wind/rivers don't). 'gradient' = a
  // continuous colour ramp with value labels; 'swatches' = discrete colour+label
  // rows. Shown on the right whenever a legend-bearing overlay is active.
  type LegendSpec =
    | { type: 'gradient'; title: string; unit: string; stops: { value: number; rgb: [number, number, number] }[] }
    | { type: 'swatches'; title: string; items: { label: string; rgb: [number, number, number]; shape?: 'square' | 'cone' | 'ring' }[] }
  // `legend` may be a function so an overlay (ecology) can vary its legend with the
  // selected field. Resolved at render time (see resolveLegend / renderLegends).
  const OVERLAY_DEFS: { id: string; icon: string; label: string; available: () => boolean; legend?: LegendSpec | (() => LegendSpec) }[] = [
    { id: 'terrain', icon: '/icons/colours.png', label: 'Terrain colour', available: () => lastColoredBase !== null },
    { id: 'boundaries', icon: '/icons/voronoi.png', label: 'Voronoi cells', available: () => lastBoundaryMask !== null },
    { id: 'names', icon: '/icons/continent_name.png', label: 'Continent names', available: () => lastRaftLabels.length > 0 },
    {
      id: 'mantle', icon: '/icons/mantle.png', label: 'Mantle field + volcanism', available: () => lastMantle !== null,
      legend: { type: 'swatches', title: 'Mantle & volcanism', items: [
        { label: 'Upwelling (hot)', rgb: [225, 85, 55] },
        { label: 'Downwelling (cold)', rgb: [55, 110, 210] },
        { label: 'Volcano', rgb: [220, 55, 30], shape: 'cone' },
        { label: 'Hotspot plume', rgb: [255, 140, 0], shape: 'ring' },
      ] },
    },
    { id: 'temperature', icon: '/icons/temperature.png', label: 'Temperature', available: () => lastTemperature !== null, legend: { type: 'gradient', title: 'Temperature', unit: '°C', stops: temperatureLegendStops } },
    { id: 'seasonality', icon: '/icons/seasonality.png', label: 'Seasonality', available: () => lastSeasonality !== null, legend: { type: 'gradient', title: 'Seasonality', unit: '°C range', stops: amplitudeLegendStops } },
    { id: 'wind', icon: '/icons/wind.png', label: 'Wind', available: () => lastWind !== null },
    { id: 'currents', icon: '/icons/gyres.png', label: 'Ocean currents', available: () => lastCurrents !== null },
    { id: 'precipitation', icon: '/icons/rain.png', label: 'Precipitation', available: () => lastPrecipitation !== null, legend: { type: 'gradient', title: 'Precipitation', unit: 'mm/yr', stops: precipitationLegendStops } },
    { id: 'monsoon', icon: '/icons/weather.png', label: 'Monsoon / precip seasonality', available: () => lastMonsoonIndex !== null, legend: { type: 'gradient', title: 'Monsoon index', unit: '', stops: monsoonLegendStops } },
    { id: 'biomes', icon: '/icons/biomes.png', label: 'Biomes', available: () => lastBiomes !== null, legend: { type: 'swatches', title: 'Biomes', items: biomeLegend() } },
    { id: 'rivers', icon: '/icons/river.png', label: 'Rivers & lakes', available: () => lastRiverData !== null },
    {
      id: 'ecology', icon: '/icons/ecology.png', label: 'Ecology (resources)', available: hasEcologyData,
      legend: () => ({ type: 'gradient', title: ECOLOGY_FIELD_META[selectedEcologyField].label, unit: '', stops: ecologyFieldLegendStops(selectedEcologyField) }),
    },
  ]
  // Desired on/off per overlay (persists as availability comes and goes). Voronoi
  // + names + mantle default on (they show as soon as their data exists); terrain
  // default on too but is re-set per panel in showPanel (on for the shaping panels,
  // off for the neutral data panels); other data overlays default off.
  const overlaysOn: Record<string, boolean> = {}
  for (const def of OVERLAY_DEFS) overlaysOn[def.id] = def.id === 'boundaries' || def.id === 'names' || def.id === 'terrain' || def.id === 'mantle'

  const overlayBar = document.createElement('div')
  overlayBar.className = 'overlay-bar'
  const overlayButtons: Record<string, HTMLButtonElement> = {}
  for (const def of OVERLAY_DEFS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'overlay-icon'
    btn.title = def.label
    btn.setAttribute('aria-label', def.label)
    const img = document.createElement('img')
    img.src = def.icon
    img.alt = ''
    btn.appendChild(img)
    btn.addEventListener('click', () => toggleOverlay(def.id))
    overlayBar.appendChild(btn)
    overlayButtons[def.id] = btn
  }
  root.appendChild(overlayBar)

  // Fading backdrop behind the top overlay bar (mirrors the bottom panel's fade),
  // so the icons read against a busy map.
  const overlayBackdrop = document.createElement('div')
  overlayBackdrop.className = 'overlay-bar-backdrop'
  root.appendChild(overlayBackdrop)

  // Right-side legend for the active overlay(s) that carry one (see OVERLAY_DEFS).
  const overlayLegend = document.createElement('div')
  overlayLegend.className = 'overlay-legend'
  overlayLegend.hidden = true
  root.appendChild(overlayLegend)

  function buildLegendBlock(spec: LegendSpec): HTMLElement {
    const block = document.createElement('div')
    block.className = 'legend-block'
    const title = document.createElement('div')
    title.className = 'legend-title'
    title.textContent = spec.type === 'gradient' && spec.unit ? `${spec.title} (${spec.unit})` : spec.title
    block.appendChild(title)
    if (spec.type === 'gradient') {
      const min = spec.stops[0].value
      const max = spec.stops[spec.stops.length - 1].value
      const span = max - min || 1
      const css = spec.stops.map((s) => `rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]}) ${(((s.value - min) / span) * 100).toFixed(1)}%`).join(', ')
      const row = document.createElement('div')
      row.className = 'legend-gradient-row'
      const bar = document.createElement('div')
      bar.className = 'legend-gradient-bar'
      bar.style.background = `linear-gradient(to right, ${css})`
      const labels = document.createElement('div')
      labels.className = 'legend-gradient-labels'
      const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1))
      for (const v of [min, (min + max) / 2, max]) {
        const l = document.createElement('span')
        l.textContent = fmt(v)
        labels.appendChild(l)
      }
      row.append(bar, labels)
      block.appendChild(row)
    } else {
      const list = document.createElement('div')
      list.className = 'legend-swatches'
      for (const it of spec.items) {
        const r = document.createElement('div')
        r.className = 'legend-swatch-row'
        const sw = document.createElement('span')
        if (it.shape === 'cone') {
          // Match the map's volcano marker (an upward cone), not a flat square.
          sw.className = 'legend-cone'
          sw.style.borderBottomColor = `rgb(${it.rgb[0]},${it.rgb[1]},${it.rgb[2]})`
        } else if (it.shape === 'ring') {
          // Match the map's hotspot-plume marker (an orange ring).
          sw.className = 'legend-ring'
          sw.style.borderColor = `rgb(${it.rgb[0]},${it.rgb[1]},${it.rgb[2]})`
        } else {
          sw.className = 'legend-swatch'
          sw.style.background = `rgb(${it.rgb[0]},${it.rgb[1]},${it.rgb[2]})`
        }
        const lb = document.createElement('span')
        lb.textContent = it.label
        r.append(sw, lb)
        list.appendChild(r)
      }
      block.appendChild(list)
    }
    return block
  }

  // Rebuild the right-side legend from whichever legend-bearing overlays are
  // currently on + available (stacked; usually one or two). Hidden when none.
  function renderLegends(): void {
    // Ecology's legend follows its EFFECTIVE state (toolbar toggle OR hover preview).
    const active = OVERLAY_DEFS.filter((d) => d.legend && (d.id === 'ecology' ? ecologyLayerOn() : overlaysOn[d.id] && d.available()))
    if (active.length === 0) {
      overlayLegend.hidden = true
      overlayLegend.replaceChildren()
      return
    }
    overlayLegend.replaceChildren(...active.map((d) => buildLegendBlock(typeof d.legend === 'function' ? d.legend() : d.legend!)))
    overlayLegend.hidden = false
  }

  // Enable each layer per its wanted state AND availability; 'rivers' drives the
  // scene ribbons + lake tint together. One composite at the end.
  function applyOverlays(): void {
    for (const def of OVERLAY_DEFS) {
      // Ecology shows on its toolbar toggle OR while a panel slider is hovered.
      const show = def.id === 'ecology' ? ecologyLayerOn() : overlaysOn[def.id] && def.available()
      if (def.id === 'rivers') {
        riverLayer?.setEnabled(show)
        overlay.setLayerEnabled('lakes', show)
      } else {
        overlay.setLayerEnabled(def.id, show)
      }
    }
    overlay.composite()
    hoverTooltip?.refresh()
  }

  // Sync each button's disabled (unavailable) + active (on) look.
  function refreshOverlayBar(): void {
    for (const def of OVERLAY_DEFS) {
      const btn = overlayButtons[def.id]
      const avail = def.available()
      btn.disabled = !avail
      btn.classList.toggle('is-disabled', !avail)
      btn.classList.toggle('is-active', avail && overlaysOn[def.id])
    }
  }

  // Called whenever overlay data appears/disappears (climate/hydrology computed
  // or invalidated, world re-rendered) so the bar + layers stay in sync.
  function updateOverlays(): void {
    applyOverlays()
    refreshOverlayBar()
    renderLegends()
  }

  function toggleOverlay(id: string): void {
    const def = OVERLAY_DEFS.find((d) => d.id === id)
    if (!def || !def.available()) return
    overlaysOn[id] = !overlaysOn[id]
    updateOverlays()
  }

  // Expand the worker's packed relief bytes (top bit = land, low 7 = hillshade)
  // into the RGBA "paper" base: land → near-white grey, ocean → light blue, each
  // subtly modulated by the shade so relief reads on water too.
  function buildSimplifiedBase(): Uint8ClampedArray | null {
    if (!lastRelief) return null
    if (simplifiedBaseCache) return simplifiedBaseCache
    const out = new Uint8ClampedArray(lastRelief.length * 4)
    for (let i = 0; i < lastRelief.length; i++) {
      const v = lastRelief[i]
      const shade = (v & 127) / 127
      const p = i * 4
      if (v & 128) {
        // Land: near-white, subtle grey shading.
        const b = 210 + shade * 45
        out[p] = b
        out[p + 1] = b
        out[p + 2] = b
      } else {
        // Ocean: light blue, subtle bathymetric shading.
        out[p] = 178 + shade * 30
        out[p + 1] = 206 + shade * 22
        out[p + 2] = 230 + shade * 18
      }
      out[p + 3] = 255
    }
    simplifiedBaseCache = out
    return out
  }

  // Muted "watercolour" terrain wash derived from the (never-shown) full-colour
  // render: desaturate the land colours, cache the pigment; paintTerrain then
  // alpha-blends it over the relief base so the white + hillshade show through —
  // pigment on paper. Land only; ocean stays the relief blue.
  const TERRAIN_DESATURATE = 0.5
  const TERRAIN_ALPHA = 0.62
  let terrainTintCache: Uint8ClampedArray | null = null
  function buildTerrainTint(): Uint8ClampedArray | null {
    if (!lastColoredBase || !lastRelief) return null
    if (terrainTintCache) return terrainTintCache
    const out = new Uint8ClampedArray(lastColoredBase.length)
    for (let i = 0; i < lastRelief.length; i++) {
      const p = i * 4
      if (!(lastRelief[i] & 128)) continue // ocean → no tint (alpha stays 0)
      const r = lastColoredBase[p]
      const g = lastColoredBase[p + 1]
      const b = lastColoredBase[p + 2]
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      out[p] = r + (lum - r) * TERRAIN_DESATURATE
      out[p + 1] = g + (lum - g) * TERRAIN_DESATURATE
      out[p + 2] = b + (lum - b) * TERRAIN_DESATURATE
      out[p + 3] = 255
    }
    terrainTintCache = out
    return out
  }
  function paintTerrain(data: Uint8ClampedArray): void {
    const tint = buildTerrainTint()
    if (!tint) return
    const a = TERRAIN_ALPHA
    for (let i = 0; i < tint.length; i += 4) {
      if (tint[i + 3] === 0) continue
      data[i] = data[i] * (1 - a) + tint[i] * a
      data[i + 1] = data[i + 1] * (1 - a) + tint[i + 1] * a
      data[i + 2] = data[i + 2] * (1 - a) + tint[i + 2] * a
    }
  }

  // The base is always the neutral relief now; the full-colour render is only a
  // source for the muted terrain wash. Does not composite.
  function applyBase(): void {
    const base = buildSimplifiedBase()
    if (base) overlay.setBase(base)
  }

  // 8-point compass for a (u,v) field vector — u east+, v toward the bottom
  // ("south"), so north is −v. Names the direction the vector points toward.
  function compass(u: number, v: number): string {
    if (Math.hypot(u, v) < 1e-4) return '–'
    const angle = Math.atan2(u, -v) // 0 = N, increasing clockwise
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
    const idx = Math.round((((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8
    return dirs[idx]
  }

  // Hover readout: one line per active climate overlay for the map cell under
  // the cursor (the reusable MapHoverTooltip resolves the cell; here we map it to
  // the coarse climate grid and read the computed fields). Null when no climate
  // is computed or no data-bearing overlay is on. mapX/mapY are full-res texels.
  function describeClimateCell(mapX: number, mapY: number): string | null {
    if (climateResX === 0) return null
    const gx = Math.min(climateResX - 1, Math.floor((mapX / MAP_WIDTH) * climateResX))
    const gy = Math.min(climateResY - 1, Math.floor((mapY / MAP_HEIGHT) * climateResY))
    const i = gy * climateResX + gx
    const lines: string[] = []
    if (overlaysOn.ecology && lastEcologyFields[selectedEcologyField]) {
      const v = lastEcologyFields[selectedEcologyField]![i]
      lines.push(v === ECOLOGY_OCEAN ? 'Ocean' : `${ECOLOGY_FIELD_META[selectedEcologyField].label} ${Math.round(v * 100)}%`)
    }
    if (overlaysOn.biomes && lastBiomes) lines.push(biomeLabel(lastBiomes[i]))
    if (overlaysOn.temperature && lastTemperature) lines.push(`${Math.round(lastTemperature[i])} °C`)
    if (overlaysOn.precipitation && lastPrecipitation) {
      const p = lastPrecipitation[i]
      lines.push(p === OCEAN_PRECIP ? 'Ocean' : `${Math.round(p)} mm/yr`)
    }
    if (overlaysOn.seasonality && lastSeasonality) {
      const a = lastSeasonality[i]
      lines.push(a === OCEAN_AMPLITUDE ? 'Ocean' : `${Math.round(a)} °C range`)
    }
    if (overlaysOn.monsoon && lastMonsoonIndex) {
      const m = lastMonsoonIndex[i]
      lines.push(m === OCEAN_PRECIP ? 'Ocean' : `Monsoon ${m.toFixed(2)}`)
    }
    if (overlaysOn.wind && lastWind) {
      lines.push(`Wind ${compass(lastWind[i * 2], lastWind[i * 2 + 1])}`)
    }
    if (overlaysOn.currents && lastCurrents) {
      const u = lastCurrents[i * 2]
      const v = lastCurrents[i * 2 + 1]
      if (Math.hypot(u, v) > 0.02) {
        const warm = v * (gy + 0.5 - climateResY / 2) > 0 // poleward = warm (see drawCurrents)
        lines.push(`Current ${warm ? 'warm' : 'cold'} ${compass(u, v)}`)
      }
    }
    return lines.length ? lines.join('\n') : null
  }

  function handleClimateData(message: WorkerClimateDataMessage): void {
    lastTemperature = new Float32Array(message.temperature)
    lastWind = new Float32Array(message.wind)
    lastCurrents = new Float32Array(message.currents)
    lastPrecipitation = new Float32Array(message.precipitation)
    lastSeasonality = new Float32Array(message.seasonalAmplitude)
    lastMonsoonIndex = new Float32Array(message.monsoonIndex)
    lastBiomes = new Uint8Array(message.biomes)
    climateResX = message.resX
    climateResY = message.resY
    climateStatus.textContent = ''
    climateInFlight = false
    updateControlsDisabled()
    updateProgress()
    // Coldest/warmest average temperature on this world (reflects latitude,
    // the greenhouse offset, and elevation lapse — a high pole peak is the min).
    let min = Infinity
    let max = -Infinity
    for (const t of lastTemperature) {
      if (t < min) min = t
      if (t > max) max = t
    }
    tempMinLabel.textContent = String(Math.round(min))
    tempMaxLabel.textContent = String(Math.round(max))
    // Climate data now exists → its overlay buttons become available.
    updateOverlays()
  }

  // Invalidate the (now stale) climate when an upstream step changes the
  // topography — the rasters no longer match. Recomputed on the next climate-
  // panel open.
  function invalidateClimate(): void {
    lastTemperature = null
    lastWind = null
    lastCurrents = null
    lastPrecipitation = null
    lastSeasonality = null
    lastMonsoonIndex = null
    lastBiomes = null
    climateStatus.textContent = ''
    tempMinLabel.textContent = '–'
    tempMaxLabel.textContent = '–'
    // Rivers depend on both topography and climate, so any climate invalidation
    // (which fires on every topography change too) also stales the hydrology.
    invalidateHydrology()
    // Ecology reads the climate (productivity) too, so it stales alongside.
    invalidateEcology()
    updateOverlays() // climate overlays no longer available
  }

  function handleHydrologyData(message: WorkerHydrologyDataMessage): void {
    lastRiverData = { points: new Float32Array(message.riverPoints), lengths: new Uint32Array(message.riverLengths) }
    riverLayer?.setPolylines(lastRiverData.points, lastRiverData.lengths)
    // Lakes only arrive on a re-route (empty buffer = unchanged, keep the last).
    if (message.lakeDepth.byteLength > 0) lastLakeDepth = new Float32Array(message.lakeDepth)
    // Riparian-refined biomes replace the climate step's water-free ones.
    if (message.biomes.byteLength > 0) lastBiomes = new Uint8Array(message.biomes)
    hydrologyInFlight = false
    updateControlsDisabled()
    updateProgress()
    updateOverlays() // rivers/lakes + refreshed biomes now available
    // On the Ecology panel, fish (freshwater) depends on this hydrology, so
    // (re)compute the ecology fields now that rivers/lakes are fresh.
    if (panelIndex === ECOLOGY_PANEL_INDEX) requestEcology()
  }

  function invalidateHydrology(): void {
    lastRiverData = null
    lastLakeDepth = null
    riverLayer?.setPolylines(new Float32Array(0), new Uint32Array(0))
    riverLayer?.setEnabled(false)
    overlay.setLayerEnabled('lakes', false)
    overlay.composite()
  }

  // Posts a hydrology compute with the current density knob. Needs a computed
  // climate (the worker caches its precipitation as the river water source); the
  // hydrology panel ensures that first. Self-guards a running sim.
  function requestHydrology(): void {
    if (simRunning) return
    hydrologyInFlight = true
    updateControlsDisabled()
    updateProgress()
    postToWorker({ type: 'computeHydrology', riverDensity: Number(riverDensityInput.value) })
  }

  // Posts a climate compute with the current band-slider offset. Fired on
  // opening the climate panel and by the slider (debounced) for live re-tuning.
  function requestClimate(): void {
    if (simRunning) return
    climateStatus.textContent = '…'
    climateInFlight = true
    updateControlsDisabled()
    updateProgress()
    postToWorker({
      type: 'computeClimate',
      temperatureOffset: Number(tempBandInput.value),
      temperatureContrast: Number(contrastInput.value) / 100,
      humidity: Number(humidityInput.value) / 100,
      equatorOffset: Number(equatorOffsetInput.value) / 100,
    })
  }

  function handleEcologyData(message: WorkerEcologyDataMessage): void {
    lastEcologyFields = {}
    for (const f of message.fields) lastEcologyFields[f.id as EcologyFieldId] = new Float32Array(f.data)
    ecologyResX = message.resX
    ecologyResY = message.resY
    ecologyInFlight = false
    updateControlsDisabled()
    updateProgress()
    updateOverlays() // ecology overlay now available
  }

  // Ecology depends on climate (+ the sim's volcanoes), so any climate change
  // stales it — recomputed on the next ecology-panel open / slider tweak.
  function invalidateEcology(): void {
    lastEcologyFields = {}
    updateOverlays()
  }

  // Posts an ecology compute with the current top-slider values. Needs a computed
  // climate (its cached temperature+precipitation feed productivity); the ecology
  // panel ensures that first. Self-guards a running sim.
  function requestEcology(): void {
    // Needs a computed climate (the worker no-ops without it, which would leave
    // ecologyInFlight stuck). Hydrology is optional (fish falls back to marine).
    if (simRunning || lastTemperature === null) return
    ecologyInFlight = true
    updateControlsDisabled()
    updateProgress()
    const w = (f: EcologyFieldId): number => (foldoutInputs[f] ? Number(foldoutInputs[f]!.value) / 100 : 1)
    postToWorker({
      type: 'computeEcology',
      carryingCapacity: Number(carryingCapacityInput.value),
      concentration: Number(concentrationInput.value),
      provinceStrength: Number(provinceInput.value) / 100,
      tinRarity: 0,
      weights: {
        arable: w('arable'), fish: w('fish'), game: w('game'), pasture: w('pasture'),
        timber: w('timber'), salt: w('salt'), toolStone: w('toolStone'),
        copper: w('copper'), tin: w('tin'), iron: w('iron'),
        gold: w('gold'), silver: w('silver'), gems: w('gems'),
      },
    })
  }

  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  worker.onmessage = (event: MessageEvent<WorkerRenderedMessage | WorkerErosionProgressMessage | WorkerClimateDataMessage | WorkerHydrologyDataMessage | WorkerEcologyDataMessage | WorkerWorldDataMessage>) => {
    const message = event.data

    if (message.type === 'erosionProgress') {
      erosionProgressFraction = message.fraction
      updateProgress()
      return
    }

    if (message.type === 'worldData') {
      void handleWorldData(message)
      return
    }

    if (message.type === 'climateData') {
      handleClimateData(message)
      return
    }

    if (message.type === 'hydrologyData') {
      handleHydrologyData(message)
      return
    }

    if (message.type === 'ecologyData') {
      handleEcologyData(message)
      return
    }

    // Retain the overlay source data + feed the base raster to the compositor
    // so a toggle can re-composite without a worker round-trip, then draw the
    // current layer set.
    lastBoundaryMask = new Uint8Array(message.boundaryMask)
    lastPlateArrows = message.plateArrows
    lastRaftLabels = message.raftLabels
    lastColoredBase = new Uint8ClampedArray(message.buffer)
    lastRelief = new Uint8Array(message.relief)
    lastMantle = new Float32Array(message.mantle)
    mantleResX = message.mantleResX
    mantleResY = message.mantleResY
    lastHotspots = message.hotspots
    lastVolcanoes = message.volcanoes
    simplifiedBaseCache = null // rebuilt lazily from the fresh relief
    terrainTintCache = null // rebuilt lazily from the fresh colour render
    applyBase()
    handleSimEvents(message.events)
    // Applies the current overlay states over the fresh base + syncs the bar
    // (boundaries/names data now exists → their buttons become available).
    updateOverlays()

    lastLandFraction = message.landFraction
    lastEpoch = message.epoch
    lastPlateCount = message.plateCount
    lastContinentCount = message.raftLabels.length
    updateStats()
    updateNavState() // epoch progress may unlock the Erosion panel

    // Safety auto-stop once this run reaches its armed target epoch (see
    // startSim / autoStopAtEpoch) — reuses the manual-pause path (stopSim),
    // so the play/pause button and everything else it toggles stay in sync.
    // Guarded by simRunning, so it's a no-op during erosion redraws (which
    // run while stopped) and can't re-fire before the next deliberate start
    // re-arms it.
    if (simRunning && message.epoch >= autoStopAtEpoch) {
      stopSim()
    }

    // Intermediate renders (see WorkerRenderedMessage.intermediate) are
    // one of 5 in-progress redraws an 'erode' request posts mid-flight —
    // the map/stats above should still reflect them live, but they're
    // not the operation finishing, so the buttons/status readout stay as
    // they are until the actual final render arrives.
    if (!message.intermediate) {
      erosionOpInFlight = false
      erodeIcon.src = '/icons/erosion.png' // back from the stop icon
      erodeButton.setAttribute('aria-label', 'Run erosion')
      updateControlsDisabled()
      updateProgress()
    }
  }

  const initSim = (seed: string, plateCount: number, landFractionPct: number, clusteringPct: number, cratonCount: number): void => {
    // Reset immediately (not only once the worker's first render arrives),
    // so a start clicked in that brief gap arms autoStopAtEpoch off epoch 0,
    // not the previous world's last epoch.
    lastEpoch = 0
    postToWorker({
      type: 'init',
      seed,
      plateCount,
      landFraction: landFractionPct / 100,
      clustering: clusteringPct / 100,
      cratonCount,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      epochIntervalMs: EPOCH_INTERVAL_MS,
      // Overlays (boundaries/names/arrows/events) are composited on the main
      // thread now and toggled there, so the render itself needs no overlay
      // flags — it always emits the full overlay source data.
      renderOptions: {},
    })
  }
  initSim(initialSeed, TOTAL_PLATE_COUNT_DEFAULT, LAND_FRACTION_DEFAULT, CLUSTERING_DEFAULT, CRATON_COUNT_DEFAULT)

  const stopSim = (): void => {
    if (!simRunning) return
    simRunning = false
    postToWorker({ type: 'stop' })
    toggleSimIcon.src = '/icons/tectonics.png'
    toggleSimButton.setAttribute('aria-label', 'Run tectonics')
    updateControlsDisabled()
    updateProgress()
  }

  const startSim = (): void => {
    if (simRunning) return
    simRunning = true
    // Re-arm the safety auto-stop for another MAX_TECTONICS_EPOCHS from
    // wherever this run begins (see MAX_TECTONICS_EPOCHS / the 'rendered'
    // handler), so restarting after a stop halts again 100 epochs later.
    autoStopAtEpoch = lastEpoch + MAX_TECTONICS_EPOCHS
    // Running tectonics will change the topography → any computed climate is
    // stale, and prior erosion no longer applies.
    invalidateClimate()
    erosionRunCount = 0
    postToWorker({ type: 'start' })
    toggleSimIcon.src = '/icons/stop.png'
    toggleSimButton.setAttribute('aria-label', 'Stop tectonics')
    updateControlsDisabled()
    updateProgress()
  }

  toggleSimButton.addEventListener('click', () => {
    if (simRunning) stopSim()
    else startSim()
  })

  erodeButton.addEventListener('click', () => {
    // While a pass is running the erode button IS the stop button (see the icon swap
    // below); clicking it cancels — the worker keeps the partial result so a later
    // click continues from there.
    if (erosionOpInFlight) {
      postToWorker({ type: 'stopErosion' })
      return
    }
    if (isBusy()) return
    erosionOpInFlight = true
    erosionProgressFraction = 0
    erosionRunCount += 1
    invalidateClimate()
    erodeIcon.src = '/icons/stop.png'
    erodeButton.setAttribute('aria-label', 'Stop erosion')
    updateControlsDisabled()
    updateProgress()
    updateNavState() // first erosion unlocks Climate/Rivers
    postToWorker({ type: 'erode', strength: Number(strengthInput.value), networkRefreshes: Number(refreshInput.value) })
  })

  resetErosionButton.addEventListener('click', () => {
    if (isBusy()) return
    erosionOpInFlight = true
    erosionRunCount = 0
    invalidateClimate()
    updateControlsDisabled()
    updateProgress()
    updateNavState() // reverting erosion re-locks Climate/Rivers
    postToWorker({ type: 'resetErosion' })
  })

  // Load a previously-saved world (top-left folder button). Intended handler:
  // open a file picker for a saved snapshot (the export format — world_*.json
  // metadata + the .f32 elevation + .oceanage.f32 rasters), parse it, and
  // --- Save / load a world as a .zip (world.yaml recipe+status + state.json
  // sim snapshot + oceanAge.f32 + elevation.f32 + preview.png). See
  // docs/decisions/... (the save/load design). The deterministic parts could be
  // replayed from the recipe, but the snapshot is stored so a 300-epoch world
  // loads instantly and survives generator changes.

  // The world.yaml recipe (spec) + how far it was taken (status).
  function buildWorldYaml(): string {
    const name = seedInput.value || 'world'
    return [
      'apiVersion: casas-eternas/v1alpha1',
      'kind: FlatWorld',
      'metadata:',
      `  name: ${name}`,
      'spec:',
      `  seed: "${seedInput.value}"`,
      `  platesTotal: ${Number(plateCountInput.value)}`,
      `  landRatio: ${Number(landFractionInput.value)}`,
      `  initialContinents: ${Number(cratonCountInput.value)}`,
      `  clusterFactor: ${Number(clusteringInput.value)}`,
      `  tempOffset: ${Number(tempBandInput.value)}`,
      `  humidity: ${Number(humidityInput.value)}`,
      `  contrast: ${Number(contrastInput.value)}`,
      `  equatorOffset: ${Number(equatorOffsetInput.value)}`,
      `  riverDensity: ${Number(riverDensityInput.value)}`,
      `  erosionStrength: ${Number(strengthInput.value)}`,
      `  drainageRefresh: ${Number(refreshInput.value)}`,
      `  carryingCapacity: ${Number(carryingCapacityInput.value)}`,
      `  concentration: ${Number(concentrationInput.value)}`,
      `  provinceStrength: ${Number(provinceInput.value)}`,
      ...ECOLOGY_WEIGHT_FIELDS.map((f) => `  w_${f}: ${Number(foldoutInputs[f]?.value ?? 100)}`),
      'status:',
      `  tectonicsRun: ${lastEpoch}`,
      `  erosionRun: ${erosionRunCount}`,
      '',
    ].join('\n')
  }

  // Refresh every slider's readout label from its input value — used after a
  // load sets the inputs programmatically (which doesn't fire input events).
  function syncSliderLabels(): void {
    plateCountLabel.textContent = plateCountInput.value
    landFractionLabel.textContent = landFractionInput.value
    cratonCountLabel.textContent = cratonCountInput.value
    clusteringLabel.textContent = clusteringInput.value
    const t = Number(tempBandInput.value)
    tempBandLabel.textContent = t > 0 ? `+${t}` : String(t)
    humidityLabel.textContent = humidityInput.value
    contrastLabel.textContent = contrastInput.value
    equatorOffsetLabel.textContent = equatorOffsetInput.value
    riverDensityLabel.textContent = riverDensityInput.value
    strengthLabel.textContent = strengthInput.value
    refreshLabel.textContent = refreshInput.value
    carryingCapacityLabel.textContent = carryingCapacityInput.value
    const c = Number(concentrationInput.value)
    concentrationLabel.textContent = c > 0 ? `+${c}` : String(c)
    provinceLabel.textContent = provinceInput.value
    for (const f of ECOLOGY_WEIGHT_FIELDS) {
      const lbl = foldoutLabels[f]
      const inp = foldoutInputs[f]
      if (lbl && inp) lbl.textContent = inp.value
    }
  }

  // Flat, single-occurrence keys → a tiny regex parser, no YAML dependency.
  function readYamlValue(text: string, key: string): string | undefined {
    const match = text.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm'))
    return match ? match[1].replace(/^["']|["']$/g, '') : undefined
  }

  // Downscaled PNG of the current composited map, for the save's preview.png.
  async function makePreviewBlob(): Promise<Blob | null> {
    if (!lastCompositePixels) return null
    const full = document.createElement('canvas')
    full.width = MAP_WIDTH
    full.height = MAP_HEIGHT
    full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(lastCompositePixels), MAP_WIDTH, MAP_HEIGHT), 0, 0)
    const thumb = document.createElement('canvas')
    thumb.width = 512
    thumb.height = 256
    thumb.getContext('2d')!.drawImage(full, 0, 0, thumb.width, thumb.height)
    return new Promise((resolve) => thumb.toBlob((blob) => resolve(blob), 'image/png'))
  }

  // Save flow: worker replies with the sim snapshot + rasters → zip it up.
  async function handleWorldData(message: WorkerWorldDataMessage): Promise<void> {
    const zip = new JSZip()
    zip.file('world.yaml', buildWorldYaml())
    zip.file('state.json', JSON.stringify(message.snapshot))
    zip.file('oceanAge.f32', message.oceanAge)
    zip.file('elevation.f32', message.elevation)
    const preview = await makePreviewBlob()
    if (preview) zip.file('preview.png', preview)
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
    const safeName = (seedInput.value || 'world').replace(/[^a-zA-Z0-9_-]/g, '_')
    downloadBlob(blob, `${safeName}.zip`)
  }

  saveWorldButton.addEventListener('click', () => {
    if (simRunning) return
    postToWorker({ type: 'serializeWorld' })
  })

  // Load flow: unzip → set the UI from the recipe/status → restore the sim in
  // the worker (no replay) → the render it posts back displays the world.
  async function loadWorldFromZip(file: File): Promise<void> {
    let zip: JSZip
    let yaml: string
    let snapshot: PlateSimulationSnapshot
    let oceanAge: ArrayBuffer
    let elevation: ArrayBuffer
    try {
      zip = await JSZip.loadAsync(file)
      const yamlFile = zip.file('world.yaml')
      const stateFile = zip.file('state.json')
      const oceanFile = zip.file('oceanAge.f32')
      const elevFile = zip.file('elevation.f32')
      if (!yamlFile || !stateFile || !oceanFile || !elevFile) throw new Error('missing files')
      yaml = await yamlFile.async('string')
      snapshot = JSON.parse(await stateFile.async('string'))
      oceanAge = await oceanFile.async('arraybuffer')
      elevation = await elevFile.async('arraybuffer')
    } catch {
      ctx.notifications.show({ message: 'Invalid world file', icon: '/icons/folder.png', durationMs: 6000 })
      return
    }

    stopSim()
    // Drop any pending debounced regenerate — it would fire an `init` after the
    // restore and overwrite the loaded world.
    if (regenerateTimer !== undefined) clearTimeout(regenerateTimer)
    ctx.notifications.clearAll()
    overlay.clearMarkers()
    invalidateClimate()

    const seed = readYamlValue(yaml, 'seed') ?? ''
    seedInput.value = seed
    plateCountInput.value = readYamlValue(yaml, 'platesTotal') ?? plateCountInput.value
    landFractionInput.value = readYamlValue(yaml, 'landRatio') ?? landFractionInput.value
    cratonCountInput.value = readYamlValue(yaml, 'initialContinents') ?? cratonCountInput.value
    clusteringInput.value = readYamlValue(yaml, 'clusterFactor') ?? clusteringInput.value
    tempBandInput.value = readYamlValue(yaml, 'tempOffset') ?? '0'
    humidityInput.value = readYamlValue(yaml, 'humidity') ?? '100'
    contrastInput.value = readYamlValue(yaml, 'contrast') ?? '100'
    equatorOffsetInput.value = readYamlValue(yaml, 'equatorOffset') ?? '0'
    riverDensityInput.value = readYamlValue(yaml, 'riverDensity') ?? '55'
    strengthInput.value = readYamlValue(yaml, 'erosionStrength') ?? strengthInput.value
    refreshInput.value = readYamlValue(yaml, 'drainageRefresh') ?? refreshInput.value
    carryingCapacityInput.value = readYamlValue(yaml, 'carryingCapacity') ?? '100'
    concentrationInput.value = readYamlValue(yaml, 'concentration') ?? '0'
    provinceInput.value = readYamlValue(yaml, 'provinceStrength') ?? '45'
    for (const f of ECOLOGY_WEIGHT_FIELDS) {
      const inp = foldoutInputs[f]
      if (inp) inp.value = readYamlValue(yaml, `w_${f}`) ?? '100'
    }
    syncSliderLabels()
    erosionRunCount = Number(readYamlValue(yaml, 'erosionRun') ?? 0)
    // lastEpoch is set from the restore render's reported epoch (status
    // .tectonicsRun == the snapshot's epoch), so no need to set it here.

    postToWorker({ type: 'restoreWorld', seed, snapshot, oceanAge, elevation })
  }

  loadWorldButton.addEventListener('click', () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.zip'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file) void loadWorldFromZip(file)
    })
    input.click()
  })

  // Dragging the band slider live-recomputes the climate (debounced) once a
  // world exists — the worker no-ops if there's no elevation yet. Recomputes
  // only while not running tectonics (topography would be mid-change).
  let climateDebounce: ReturnType<typeof setTimeout> | undefined
  tempBandInput.addEventListener('input', () => {
    const v = Number(tempBandInput.value)
    tempBandLabel.textContent = v > 0 ? `+${v}` : String(v)
    if (simRunning) return
    clearTimeout(climateDebounce)
    climateDebounce = setTimeout(requestClimate, 150)
  })
  // Humidity + contrast: percentage sliders, same debounced live-recompute.
  const wireClimateSlider = (input: HTMLInputElement, label: HTMLElement): void => {
    input.addEventListener('input', () => {
      label.textContent = input.value
      if (simRunning) return
      clearTimeout(climateDebounce)
      climateDebounce = setTimeout(requestClimate, 150)
    })
  }
  wireClimateSlider(humidityInput, humidityLabel)
  wireClimateSlider(contrastInput, contrastLabel)
  wireClimateSlider(equatorOffsetInput, equatorOffsetLabel)

  // River density: live-recompute (debounced); a density-only change reuses the
  // worker's cached routing/discharge, so it's cheap.
  let hydrologyDebounce: ReturnType<typeof setTimeout> | undefined
  riverDensityInput.addEventListener('input', () => {
    riverDensityLabel.textContent = riverDensityInput.value
    if (simRunning) return
    clearTimeout(hydrologyDebounce)
    hydrologyDebounce = setTimeout(requestHydrology, 150)
  })

  // Ecology top sliders (carrying capacity + concentration): live-recompute
  // (debounced) — cheap (a single pass over the coarse climate grid). Concentration
  // shows a signed value (+ clumped / − even).
  let ecologyDebounce: ReturnType<typeof setTimeout> | undefined
  const scheduleEcology = (): void => {
    if (simRunning) return
    clearTimeout(ecologyDebounce)
    ecologyDebounce = setTimeout(requestEcology, 150)
  }
  carryingCapacityInput.addEventListener('input', () => {
    carryingCapacityLabel.textContent = carryingCapacityInput.value
    scheduleEcology()
  })
  concentrationInput.addEventListener('input', () => {
    const v = Number(concentrationInput.value)
    concentrationLabel.textContent = v > 0 ? `+${v}` : String(v)
    scheduleEcology()
  })

  // Provinces is a main slider (a global spatial knob, alongside carrying capacity
  // + concentration).
  const provinceInput = root.querySelector<HTMLInputElement>('.province-input')!
  const provinceLabel = root.querySelector<HTMLElement>('[data-value="province-label"]')!
  provinceInput.addEventListener('input', () => { provinceLabel.textContent = provinceInput.value; scheduleEcology() })

  // Hover-to-preview (replaces the old dropdown): hovering a slider/its icon shows
  // that field on the ecology overlay — even if the overlay's toolbar toggle is
  // OFF — and reverts when the mouse leaves the panel (see the panel mouseleave).
  // The three main sliders preview the carrying-capacity aggregate.
  const previewField = (id: EcologyFieldId): void => {
    if (ecologyHoverField === id) return
    ecologyHoverField = id
    selectedEcologyField = id
    updateOverlays()
  }
  const clearPreview = (): void => {
    if (ecologyHoverField === null) return
    ecologyHoverField = null
    selectedEcologyField = 'carryingCapacity'
    updateOverlays()
  }

  // Fold-out: three category icon-buttons in the base row; clicking one reveals
  // that category's per-field abundance sliders (each with its resource icon) in
  // the full-width sub-row (radio-style — one category open at a time). Hovering a
  // row previews that field.
  const ECOLOGY_CATEGORIES: { id: string; fields: EcologyFieldId[] }[] = [
    { id: 'subsistence', fields: ['arable', 'fish', 'game', 'pasture'] },
    { id: 'material', fields: ['timber', 'salt', 'toolStone'] },
    { id: 'metals', fields: ['copper', 'tin', 'iron'] },
    { id: 'prestige', fields: ['silver', 'gold', 'gems'] },
  ]
  // Per-field icon (falls back to the category icon if ever missing). Every field
  // has a dedicated icon.
  const FIELD_ICON: Partial<Record<EcologyFieldId, string>> = {
    arable: 'wheat', fish: 'fish', game: 'deer', pasture: 'pastures',
    timber: 'timber', salt: 'salt', toolStone: 'stone_axe',
    copper: 'copper_ore', tin: 'tin_ore', iron: 'iron_ore',
    silver: 'silver', gold: 'gold', gems: 'gems',
  }
  const CAT_ICON: Record<string, string> = { subsistence: 'wheat', material: 'stone_axe', metals: 'ecology', prestige: 'crown' }
  const ecologyFoldout = root.querySelector<HTMLElement>('[data-value="ecology-foldout"]')!
  const foldoutInputs: Partial<Record<EcologyFieldId, HTMLInputElement>> = {}
  const foldoutLabels: Partial<Record<EcologyFieldId, HTMLElement>> = {}
  const catPanels: Record<string, HTMLElement> = {}
  for (const cat of ECOLOGY_CATEGORIES) {
    const panel = document.createElement('div')
    panel.className = 'ecology-cat-panel'
    panel.hidden = true
    for (const field of cat.fields) {
      const row = document.createElement('label')
      row.className = 'field ecology-nudge'
      row.dataset.ecofield = field
      const icon = document.createElement('img')
      icon.className = 'ecology-nudge-icon'
      icon.src = `/icons/${FIELD_ICON[field] ?? CAT_ICON[cat.id]}.png`
      icon.alt = ''
      const label = document.createElement('span')
      label.className = 'field-label'
      const name = document.createElement('span')
      name.textContent = `${ECOLOGY_FIELD_META[field].label}: `
      const val = document.createElement('span')
      val.textContent = '100'
      label.append(name, val)
      const input = document.createElement('input')
      input.type = 'range'
      input.min = '50'
      input.max = '200'
      input.step = '5'
      input.value = '100'
      input.setAttribute('aria-label', `${ECOLOGY_FIELD_META[field].label} abundance`)
      input.addEventListener('input', () => { val.textContent = input.value; scheduleEcology() })
      const body = document.createElement('span')
      body.className = 'ecology-nudge-body'
      body.append(label, input)
      row.append(icon, body)
      row.addEventListener('mouseenter', () => previewField(field))
      panel.appendChild(row)
      foldoutInputs[field] = input
      foldoutLabels[field] = val
    }
    ecologyFoldout.appendChild(panel)
    catPanels[cat.id] = panel
  }
  let activeCat: string | null = null
  const setActiveCat = (id: string | null): void => {
    activeCat = id
    for (const cat of ECOLOGY_CATEGORIES) {
      catPanels[cat.id].hidden = cat.id !== id
      root.querySelector<HTMLButtonElement>(`[data-eco-cat="${cat.id}"]`)!.classList.toggle('is-active', cat.id === id)
    }
    ecologyFoldout.hidden = id === null
  }
  for (const cat of ECOLOGY_CATEGORIES) {
    root.querySelector<HTMLButtonElement>(`[data-eco-cat="${cat.id}"]`)!.addEventListener('click', () => setActiveCat(activeCat === cat.id ? null : cat.id))
  }
  // Main sliders (direct children of the panel) preview the aggregate on hover.
  const ecologyPanel = root.querySelector<HTMLElement>('.panel[data-panel="5"]')!
  for (const el of ecologyPanel.querySelectorAll<HTMLElement>(':scope > .field[data-ecofield]')) {
    el.addEventListener('mouseenter', () => previewField(el.dataset.ecofield as EcologyFieldId))
  }
  // Leaving the whole panel clears the preview (moving between sliders keeps it,
  // so no flicker) — the previewed overlay disappears when the mouse is away.
  ecologyPanel.addEventListener('mouseleave', clearPreview)

  const regenerate = (): void => {
    stopSim()
    ctx.notifications.clearAll()
    overlay.clearMarkers()
    invalidateClimate()
    erosionRunCount = 0
    initSim(seedInput.value, Number(plateCountInput.value), Number(landFractionInput.value), Number(clusteringInput.value), Number(cratonCountInput.value))
    updateNavState() // fresh world → re-lock downstream panels
  }
  // Debounced so dragging a slider (or typing a seed) doesn't fire a full
  // world regen + render on every input event — the label updates live, the
  // world rebuilds once the value settles. A single click (reset/randomize)
  // regenerates immediately.
  let regenerateTimer: ReturnType<typeof setTimeout> | undefined
  const regenerateDebounced = (): void => {
    if (regenerateTimer !== undefined) clearTimeout(regenerateTimer)
    regenerateTimer = setTimeout(() => {
      regenerateTimer = undefined
      regenerate()
    }, 150)
  }
  resetButton.addEventListener('click', regenerate)
  seedInput.addEventListener('input', regenerateDebounced)
  randomizeButton.addEventListener('click', () => {
    seedInput.value = randomSeed()
    regenerate()
  })
  plateCountInput.addEventListener('input', () => {
    plateCountLabel.textContent = plateCountInput.value
    regenerateDebounced()
  })
  landFractionInput.addEventListener('input', () => {
    landFractionLabel.textContent = landFractionInput.value
    regenerateDebounced()
  })
  clusteringInput.addEventListener('input', () => {
    clusteringLabel.textContent = clusteringInput.value
    regenerateDebounced()
  })
  cratonCountInput.addEventListener('input', () => {
    cratonCountLabel.textContent = cratonCountInput.value
    regenerateDebounced()
  })

  // Same back/next convention as the sphere screen: back steps to the
  // previous panel, or exits to the title screen from the first one;
  // next steps forward and is a no-op past the last panel. Generation
  // parameters (seed, plate counts) live on panel 0, tectonics on panel
  // 1, erosion on panel 2 — future panels slot in the same way via the
  // data-panel pattern, with one more entry in PANEL_TITLES to match.
  const PANEL_TITLES = ['Genesis', 'Tectonics', 'Erosion', 'Climate', 'Hydrology', 'Ecology']
  const panelTitle = root.querySelector<HTMLElement>('[data-value="panel-title"]')!
  const nextArrow = root.querySelector<HTMLButtonElement>('[data-action="next"]')!
  const panels = Array.from(root.querySelectorAll<HTMLElement>('.panel'))
  let panelIndex = 0

  // Each more-detailed panel needs its upstream step settled, else it operates on
  // unfinished data (the hydrology test series proved rivers/lakes on un-eroded
  // terrain are badly wrong: giant undrained lakes, unnatural drainage). So the
  // forward step is gated: entering Erosion needs some tectonics, entering Climate
  // or Rivers needs at least one erosion pass. Returns why entry is blocked, or
  // null if allowed. Values are tunable.
  const MIN_TECTONIC_EPOCHS = 30
  const entryRequirementUnmet = (index: number): string | null => {
    if (index === 2 && lastEpoch < MIN_TECTONIC_EPOCHS) return `First run tectonics to at least epoch ${MIN_TECTONIC_EPOCHS} (now ${lastEpoch}).`
    if ((index === CLIMATE_PANEL_INDEX || index === HYDROLOGY_PANEL_INDEX || index === ECOLOGY_PANEL_INDEX) && erosionRunCount < 1) return 'First run erosion at least once — climate, rivers and ecology need the eroded terrain.'
    return null
  }
  // Grey out (but keep clickable, so a click can explain why) the next arrow when
  // the next panel's requirement isn't met yet.
  const updateNavState = (): void => {
    const target = panelIndex + 1
    const blocked = target < panels.length && entryRequirementUnmet(target) !== null
    nextArrow.classList.toggle('is-disabled', blocked)
    nextArrow.setAttribute('aria-disabled', String(blocked))
  }
  const showPanel = (index: number): void => {
    panelIndex = index
    panels.forEach((panel, i) => {
      panel.hidden = i !== index
    })
    panelTitle.textContent = PANEL_TITLES[index]
    // Overlays are toggled from the persistent top bar, not the panel — but the
    // Climate / Rivers panels are still where their data gets computed. Entering
    // Climate computes it if stale; entering Rivers ensures a climate first (the
    // worker caches its precipitation as the river source — posting climate then
    // hydrology keeps that order), then computes rivers if stale.
    if (index === CLIMATE_PANEL_INDEX && lastTemperature === null) requestClimate()
    if (index === HYDROLOGY_PANEL_INDEX) {
      if (lastTemperature === null) requestClimate()
      if (lastRiverData === null) requestHydrology()
    }
    // Entering Ecology ensures climate + hydrology first (its fields read both —
    // productivity/biomes from climate, fish freshwater from rivers/lakes). If
    // hydrology is stale it's posted here and ecology is triggered once it lands
    // (see handleHydrologyData); otherwise ecology is computed directly.
    if (index === ECOLOGY_PANEL_INDEX) {
      if (lastTemperature === null) requestClimate()
      if (lastRiverData === null) requestHydrology()
      else if (!hasEcologyData()) requestEcology()
    }
    // The terrain colour wash is panel-contextual: on for the shaping panels
    // (Genesis/Tectonics/Erosion), off for the neutral data panels (Climate/
    // Rivers). Still toggleable in the bar within a panel; resets on switch.
    overlaysOn.terrain = index < CLIMATE_PANEL_INDEX
    // The mantle overlay is on for Genesis/Tectonics (where you watch the plates
    // drive), off from the Erosion panel (index 2) onward. Same per-panel reset.
    overlaysOn.mantle = index < 2
    // Rivers/lakes come on automatically when you enter the Hydrology panel (the
    // reason you're there), off elsewhere — same per-panel reset. Once the compute
    // finishes, handleHydrologyData's updateOverlays() makes the layer visible.
    overlaysOn.rivers = index === HYDROLOGY_PANEL_INDEX
    // Carrying-capacity overlay comes on automatically in the Ecology panel (the
    // reason you're there), off elsewhere. handleEcologyData's updateOverlays()
    // makes it visible once the compute finishes.
    overlaysOn.ecology = index === ECOLOGY_PANEL_INDEX
    ecologyHoverField = null // drop any stale hover preview when switching panels
    if (lastColoredBase) updateOverlays()
    updateNavState()
  }

  // Cursor readout over the map (reusable module; reports the active climate
  // overlays for the hovered cell). Always enabled — it self-hides when no
  // data-bearing overlay is on (describeClimateCell returns null), and overlays
  // are now global rather than climate-panel-only.
  hoverTooltip = createMapHoverTooltip({
    scene,
    host: root,
    textureWidth: MAP_WIDTH,
    textureHeight: MAP_HEIGHT,
    describe: describeClimateCell,
  })
  showPanel(0)

  root.querySelector('[data-action="back"]')!.addEventListener('click', () => {
    if (panelIndex > 0) {
      showPanel(panelIndex - 1)
      return
    }
    ctx.goTo('title')
  })
  nextArrow.addEventListener('click', () => {
    if (panelIndex >= panels.length - 1) return
    const target = panelIndex + 1
    const reason = entryRequirementUnmet(target)
    if (reason) {
      ctx.notifications.show({ message: reason, icon: '/icons/erosion.png', durationMs: 4000 })
      return
    }
    showPanel(target)
  })

  ctx.overlay.appendChild(root)

  return {
    scene,
    dispose() {
      stopSim()
      hoverTooltip?.dispose()
      riverLayer?.dispose()
      overlay.dispose()
      mapView.dispose()
      worker.terminate()
      // scene.dispose() doesn't remove the camera module's own 'wheel'
      // listener on the shared canvas — same reasoning as MarsScreen's
      // dispose (see orbitSwoopCamera's equivalent comment).
      disposeCamera()
      scene.dispose()
    },
  }
}
