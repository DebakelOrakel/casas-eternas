import { Color3, Color4, DirectionalLight, HemisphericLight, Mesh, Scene, StandardMaterial, Vector3, VertexData } from '@babylonjs/core'
import type { InstancedMesh } from '@babylonjs/core'
import { createHexMapCamera } from '../../camera/hexMapCamera'
import { createToroidalMapView } from '../../map/ToroidalMapView'
import { createMapHoverTooltip } from '../../map/MapHoverTooltip'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { MAP_HEIGHT, MAP_WIDTH } from '../../worldgen/mapConfig'
import JSZip from 'jszip'
import type { WorkerClimateDataMessage, WorkerErosionProgressMessage, WorkerExportDataMessage, WorkerInboundMessage, WorkerRenderedMessage, WorkerWorldDataMessage } from '../../worldgen/plateSimulationWorker'
import { drawContinentLabels } from '../../worldgen/continentLabelRenderer'
import type { ContinentLabelPlacement } from '../../worldgen/continentLabelRenderer'
import type { PlateArrow } from '../../worldgen/elevationMapImage'
import type { SimEvent, PlateSimulationSnapshot } from '../../worldgen/plateSimulation'
import { eventCategory } from '../../worldgen/plateSimulation'
import { MapOverlayCompositor } from '../../ui/mapOverlay/MapOverlayCompositor'
import { createOverlayToggleBar } from '../../ui/mapOverlay/OverlayToggleBar'
import { temperatureColor, precipitationColor, amplitudeColor } from '../../worldgen/climate/climateColors'
import { OCEAN_PRECIP } from '../../worldgen/climate/precipitation'
import { OCEAN_AMPLITUDE } from '../../worldgen/climate/seasonality'
import { biomeColor, biomeLabel, Biome } from '../../worldgen/climate/biomes'
import './worldgen.css'

// Plate-boundary line color for the boundaries overlay (drawn main-thread
// from the worker's boundary mask — see the compositor).
const BOUNDARY_COLOR: [number, number, number] = [15, 15, 15]
const ARROW_COLOR = '#0f0f0f'

// Event markers + notifications share one wall-clock lifetime, so a toast and
// its geologic map marker appear and fade together (the user's coupling
// choice). Continent-scale events (collision/breakup/supercontinent) get a
// bold marker AND a notification; routine crust churn gets only a faint,
// shorter marker (no toast). Colors are "r, g, b" fragments for rgba().
const EVENT_CONTINENT_LIFETIME_MS = 15000
const EVENT_ROUTINE_LIFETIME_MS = 6000
const EVENT_MARKER_HALF_LENGTH = 90
const COLLISION_COLOR = '220, 45, 45'
const BREAKUP_COLOR = '235, 140, 30'
const ROUTINE_COLOR = '90, 130, 200'

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

  const { dispose: disposeCamera, setTilt: setCameraTilt, getFocus: getCameraFocus } = createHexMapCamera({
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

  // DEBUG 3D preview state — see the "DEBUG: temporary 3D relief
  // preview" block further down for what builds/tears these down.
  // Declared up here (rather than only where they're built) so the
  // single recenter observer below can tile whichever mesh — flat 2D or
  // debug 3D — is currently active without a second, near-duplicate
  // observer.
  let debugMeshTile: Mesh | null = null
  let debugMeshWrapInstances: InstancedMesh[] = []

  // The flat map plane + its toroidal 3x3 recentering (see ToroidalMapView).
  // The temporary debug relief mesh tiles in lockstep via onRecenter, using
  // the same center — it goes away when this whole debug block is deleted.
  const mapView = createToroidalMapView({
    scene,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    textureWidth: MAP_WIDTH,
    textureHeight: MAP_HEIGHT,
    getFocus: getCameraFocus,
    onRecenter: (centerX, centerZ) => {
      if (debugMeshTile) debugMeshTile.position.set(centerX, 0, centerZ)
      let i = 0
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue
          debugMeshWrapInstances[i]?.position.set(centerX + dx * WORLD_WIDTH, 0, centerZ + dz * WORLD_HEIGHT)
          i++
        }
      }
    },
  })

  // -----------------------------------------------------------------
  // DEBUG: temporary 3D relief preview ("enter 3D" button on the
  // Erosion panel) — a coarse displaced grid mesh, NOT the real
  // hex-tile terrain this screen's own top-of-file comment says is the
  // actual target. Exists purely so the height map can be eyeballed in
  // 3D without waiting on that system. Delete this whole block (plus
  // the worker-side debugHeightmapGrid plumbing it depends on, in
  // plateSimulationWorker.ts and elevationMapImage.ts) once real
  // hex-tile terrain exists.
  // -----------------------------------------------------------------

  // World units of Y displacement per unit of (already redistributed,
  // roughly [-1,1]) elevation. Real planetary relief is subtle relative
  // to horizontal scale (Everest is ~0.14% of Earth's radius) — mapped
  // 1:1 this would read as almost perfectly flat. Purely a stylized
  // exaggeration so the preview actually looks like terrain; tune by eye.
  const DEBUG_VERTICAL_EXAGGERATION = 1.0
  // Camera angle (radians off vertical) the preview snaps to on entry —
  // see hexMapCamera.ts's setTilt. Tune by eye.
  const DEBUG_TILT_RADIANS = Math.PI / 3

  // Only affects the debug mesh's own material (see rebuildDebugMesh) —
  // mapMaterial keeps lighting disabled, so this has zero visible effect
  // in ordinary 2D mode. Raking (low-angle), not overhead — per this
  // project's own prior finding from the abandoned sphere-mesh attempt
  // (docs/design/world-gen.md): lighting angle mattered more than mesh
  // resolution for whether displaced terrain actually read as 3D.
  const debugSunLight = new DirectionalLight('debugSunLight', new Vector3(-0.6, -1, -0.35), scene)
  debugSunLight.intensity = 0.9
  // Without this, anything facing away from debugSunLight (a single
  // directional source, no bounce) goes pure black rather than merely
  // dim — a heightfield mesh with real relief has plenty of steep,
  // shadowed-from-the-sun faces, so this matters a lot more here than it
  // did for the old sphere attempt's smoothly curved surface, where
  // grazing light could still reach almost everywhere.
  const debugAmbientLight = new HemisphericLight('debugAmbientLight', new Vector3(0, 1, 0), scene)
  debugAmbientLight.intensity = 0.35

  let debugHeightmapGrid: Float32Array | null = null
  let debugHeightmapGridWidth = 0
  let debugHeightmapGridHeight = 0
  let debug3DActive = false

  function disposeDebugMesh(): void {
    for (const instance of debugMeshWrapInstances) instance.dispose()
    debugMeshWrapInstances = []
    if (debugMeshTile) {
      debugMeshTile.material?.dispose()
      debugMeshTile.dispose()
      debugMeshTile = null
    }
  }

  // Rebuilds from scratch every call rather than updating an existing
  // mesh's vertex buffer in place — simpler code, and cheap enough at
  // this grid's resolution (debugHeightmapGridWidth x
  // debugHeightmapGridHeight, not the full 2048x1024 elevation raster)
  // not to bother with an in-place-update path for a debug view.
  function rebuildDebugMesh(): void {
    disposeDebugMesh()
    if (!debugHeightmapGrid) return
    const grid = debugHeightmapGrid
    const gridWidth = debugHeightmapGridWidth
    const gridHeight = debugHeightmapGridHeight

    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    for (let gy = 0; gy < gridHeight; gy++) {
      const v = gy / (gridHeight - 1)
      const z = (v - 0.5) * WORLD_HEIGHT
      for (let gx = 0; gx < gridWidth; gx++) {
        const u = gx / (gridWidth - 1)
        const x = (u - 0.5) * WORLD_WIDTH
        positions.push(x, grid[gy * gridWidth + gx] * DEBUG_VERTICAL_EXAGGERATION, z)
        uvs.push(u, v)
      }
    }
    for (let gy = 0; gy < gridHeight - 1; gy++) {
      for (let gx = 0; gx < gridWidth - 1; gx++) {
        const topLeft = gy * gridWidth + gx
        const topRight = topLeft + 1
        const bottomLeft = topLeft + gridWidth
        const bottomRight = bottomLeft + 1
        indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight)
      }
    }
    const normals: number[] = []
    VertexData.ComputeNormals(positions, indices, normals)
    // A heightfield never has overhangs, so every normal should
    // legitimately have a positive Y (upward) component — if it
    // doesn't, this hand-built index buffer's winding order came out
    // backward for whatever handedness/culling convention
    // ComputeNormals assumes, and every triangle lights as if seen from
    // underneath (reads as almost entirely black under a directional
    // light, which is exactly what a first look at this showed).
    // Checking one normal and flipping all of them if it's
    // downward-facing fixes that without needing to correctly guess the
    // convention from memory — backFaceCulling is already off so this
    // doesn't need to also reverse the index winding for visibility.
    if (normals[1] < 0) {
      for (let i = 0; i < normals.length; i++) normals[i] = -normals[i]
    }

    const vertexData = new VertexData()
    vertexData.positions = positions
    vertexData.indices = indices
    vertexData.uvs = uvs
    vertexData.normals = normals

    debugMeshTile = new Mesh('debugHeightmapMesh', scene)
    vertexData.applyToMesh(debugMeshTile)

    const material = new StandardMaterial('debugHeightmapMaterial', scene)
    material.diffuseTexture = mapView.texture
    material.specularColor = new Color3(0, 0, 0)
    // Winding order for a hand-built grid mesh is easy to get backward
    // (which would make it invisible from directly above — exactly the
    // angle this preview is meant to be viewed from). Disabling culling
    // entirely sidesteps needing to get that exactly right for a
    // throwaway debug view, at the cost of rendering both faces.
    material.backFaceCulling = false
    debugMeshTile.material = material

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        debugMeshWrapInstances.push(debugMeshTile.createInstance(`debugHeightmapMesh_${dx}_${dz}`))
      }
    }
  }

  // No-ops if there's no heightmap data yet (e.g. clicked before the
  // very first render arrives) rather than tilting into a blank view
  // with nothing built to show.
  function setDebug3DActive(active: boolean): void {
    if (active && !debugHeightmapGrid) return
    debug3DActive = active
    if (active) {
      rebuildDebugMesh()
      mapView.setEnabled(false)
      setCameraTilt(DEBUG_TILT_RADIANS)
    } else {
      disposeDebugMesh()
      mapView.setEnabled(true)
      setCameraTilt(0)
    }
    // Queried later in the file (root.innerHTML hasn't run yet at this
    // function's own definition point) — safe since this function is
    // only ever called after setup finishes, never during it.
    toggleDebug3DButton.setAttribute('aria-label', debug3DActive ? 'Debug: exit 3D preview' : 'Debug: enter 3D preview')
  }

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
    <div class="panel" data-panel="0">
      <label class="field field--seed">
        <span class="field-row">
          <input type="text" class="seed-input" placeholder="Seed" value="${initialSeed}" />
          <button type="button" class="icon-button" data-action="randomize-seed" aria-label="Randomize seed">
            <img src="/icons/dice.png" alt="" />
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
            <img src="/icons/tectonics_off.png" alt="" />
          </button>
          <span class="tectonics-stats">
            <span>Land: <span data-value="stat-land"></span>%</span>
            <span>Epoch: <span data-value="stat-epoch"></span></span>
          </span>
        </span>
      </label>
    </div>
    <div class="panel" data-panel="2">
      <label class="field field--icon-row">
        <span class="field-row">
          <button type="button" class="icon-button" data-action="reset-erosion" aria-label="Revert to tectonics result">
            <img src="/icons/reset.png" alt="" />
          </button>
          <button type="button" class="icon-button" data-action="erode" aria-label="Run erosion">
            <img src="/icons/erosion.png" alt="" />
          </button>
          <span class="erosion-status" data-value="erosion-status"></span>
          <button type="button" class="icon-button" data-action="toggle-debug-3d" aria-label="Debug: enter 3D preview">
            <img src="/icons/tilt_on.png" alt="" />
          </button>
          <button type="button" class="text-button" data-action="export" aria-label="Export world data for hex-tile conversion">Export</button>
        </span>
      </label>
    </div>
    <div class="panel" data-panel="3">
      <label class="field">
        <span class="field-label">Temperature: <span><span data-value="temp-band-label">0</span>°C</span></span>
        <input type="range" class="temp-band-input" min="-20" max="20" step="1" value="0" aria-label="Temperature offset (°C)" />
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
          <button type="button" class="icon-button climate-toggle" data-action="toggle-temperature" aria-label="Toggle temperature overlay">
            <img src="/icons/temp_off.png" alt="" />
          </button>
          <span class="climate-readout">
            <span>Min: <span data-value="temp-min">–</span>°C</span>
            <span>Max: <span data-value="temp-max">–</span>°C</span>
          </span>
          <button type="button" class="icon-button climate-toggle" data-action="toggle-wind" aria-label="Toggle wind overlay">
            <img src="/icons/wind_off.png" alt="" />
          </button>
          <button type="button" class="icon-button climate-toggle" data-action="toggle-precipitation" aria-label="Toggle precipitation overlay">
            <img src="/icons/ocean.png" alt="" />
          </button>
          <button type="button" class="icon-button climate-toggle" data-action="toggle-currents" aria-label="Toggle ocean current overlay">
            <img src="/icons/gyres.png" alt="" />
          </button>
          <button type="button" class="icon-button climate-toggle" data-action="toggle-seasonality" aria-label="Toggle seasonality overlay">
            <img src="/icons/seasonality.png" alt="" />
          </button>
          <button type="button" class="icon-button climate-toggle" data-action="toggle-biomes" aria-label="Toggle biome overlay">
            <img src="/icons/biomes.png" alt="" />
          </button>
          <span class="erosion-status" data-value="climate-status"></span>
        </span>
      </label>
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
  const toggleSimIcon = toggleSimButton.querySelector<HTMLImageElement>('img')!
  const erodeButton = root.querySelector<HTMLButtonElement>('[data-action="erode"]')!
  const resetErosionButton = root.querySelector<HTMLButtonElement>('[data-action="reset-erosion"]')!
  const erosionStatus = root.querySelector<HTMLElement>('[data-value="erosion-status"]')!
  const toggleDebug3DButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-debug-3d"]')!
  const exportButton = root.querySelector<HTMLButtonElement>('[data-action="export"]')!
  const loadWorldButton = root.querySelector<HTMLButtonElement>('[data-action="load-world"]')!
  const saveWorldButton = root.querySelector<HTMLButtonElement>('[data-action="save-world"]')!
  const tempToggleButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-temperature"]')!
  const tempToggleIcon = tempToggleButton.querySelector<HTMLImageElement>('img')!
  const windToggleButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-wind"]')!
  const windToggleIcon = windToggleButton.querySelector<HTMLImageElement>('img')!
  const precipToggleButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-precipitation"]')!
  const precipToggleIcon = precipToggleButton.querySelector<HTMLImageElement>('img')!
  const currentsToggleButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-currents"]')!
  const currentsToggleIcon = currentsToggleButton.querySelector<HTMLImageElement>('img')!
  const seasonalityToggleButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-seasonality"]')!
  const seasonalityToggleIcon = seasonalityToggleButton.querySelector<HTMLImageElement>('img')!
  const biomesToggleButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-biomes"]')!
  const biomesToggleIcon = biomesToggleButton.querySelector<HTMLImageElement>('img')!
  const climateStatus = root.querySelector<HTMLElement>('[data-value="climate-status"]')!
  const tempBandInput = root.querySelector<HTMLInputElement>('.temp-band-input')!
  const tempBandLabel = root.querySelector<HTMLElement>('[data-value="temp-band-label"]')!
  const humidityInput = root.querySelector<HTMLInputElement>('.humidity-input')!
  const humidityLabel = root.querySelector<HTMLElement>('[data-value="humidity-label"]')!
  const contrastInput = root.querySelector<HTMLInputElement>('.contrast-input')!
  const contrastLabel = root.querySelector<HTMLElement>('[data-value="contrast-label"]')!
  const tempMaxLabel = root.querySelector<HTMLElement>('[data-value="temp-max"]')!
  const tempMinLabel = root.querySelector<HTMLElement>('[data-value="temp-min"]')!
  const statLand = root.querySelector<HTMLElement>('[data-value="stat-land"]')!
  const statEpoch = root.querySelector<HTMLElement>('[data-value="stat-epoch"]')!

  // Simulation and rendering both happen inside this worker (see
  // plateSimulationWorker.ts) — stepping an epoch and rendering the full
  // raster are heavy enough that doing them on the main thread stalled
  // camera panning/input for the duration of every tick.
  const worker = new Worker(new URL('../../worldgen/plateSimulationWorker.ts', import.meta.url), { type: 'module' })
  const postToWorker = (message: WorkerInboundMessage): void => worker.postMessage(message)

  let simRunning = false
  // Erosion (erosion.ts, run once on demand rather than every epoch —
  // see WorkerErodeMessage's own comment) only makes sense against a
  // settled field, so both erosion buttons stay disabled while tectonics
  // is actively ticking, and again for the stretch between clicking
  // either one and its render coming back — the worker only ever
  // processes one render at a time regardless of which of the two
  // triggered it, so a single in-flight flag covers both.
  let erosionOpInFlight = false
  const updateErosionButtonsState = (): void => {
    erodeButton.disabled = simRunning || erosionOpInFlight
    resetErosionButton.disabled = simRunning || erosionOpInFlight
  }

  const updateStats = (): void => {
    statLand.textContent = String(Math.round(lastLandFraction * 100))
    statEpoch.textContent = String(lastEpoch)
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
  // Coarse climate rasters (from the worker's computeClimate step). Sampled up
  // to full map resolution in the overlay paint fns. null until computed / when
  // invalidated by an upstream reset.
  const CLIMATE_PANEL_INDEX = 3
  let lastTemperature: Float32Array | null = null
  let lastWind: Float32Array | null = null
  let lastPrecipitation: Float32Array | null = null
  let lastCurrents: Float32Array | null = null
  let lastSeasonality: Float32Array | null = null
  let lastBiomes: Uint8Array | null = null
  let climateResX = 0
  let climateResY = 0

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
  overlay.setLayers([
    { id: 'temperature', label: 'Temp', enabled: false, hidden: true, paintPixels: paintTemperature },
    { id: 'precipitation', label: 'Precipitation', enabled: false, hidden: true, paintPixels: paintPrecipitation },
    { id: 'seasonality', label: 'Seasonality', enabled: false, hidden: true, paintPixels: paintSeasonality },
    { id: 'biomes', label: 'Biomes', enabled: false, hidden: true, paintPixels: paintBiomes },
    { id: 'boundaries', label: 'Boundaries', enabled: true, paintPixels: paintBoundaryMask },
    { id: 'arrows', label: 'Arrows', enabled: false, paint: drawArrows },
    { id: 'wind', label: 'Wind', enabled: false, hidden: true, paint: drawWind },
    { id: 'currents', label: 'Currents', enabled: false, hidden: true, paint: drawCurrents },
    { id: 'events', label: 'Events', enabled: true },
    { id: 'names', label: 'Names', enabled: true, paint: (c) => drawContinentLabels(c, lastRaftLabels) },
  ])
  createOverlayToggleBar(overlay, root)

  // Draws one tectonic event's geologic marker, faded by `alpha`: a suture band
  // (collision), a dashed rift axis (breakup), or a ring (supercontinent /
  // routine point). The worldgen-specific side of the generic marker facility.
  function drawEventMarker(c: CanvasRenderingContext2D, ev: SimEvent, alpha: number): void {
    const color = ev.type === 'continent_collided' || ev.type === 'supercontinent_formed' ? COLLISION_COLOR : ev.type === 'continent_broke_up' ? BREAKUP_COLOR : ROUTINE_COLOR
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
      const continent = eventCategory(ev.type) === 'continent'
      const lifetimeMs = continent ? EVENT_CONTINENT_LIFETIME_MS : EVENT_ROUTINE_LIFETIME_MS
      if (ev.x !== undefined && ev.y !== undefined) {
        overlay.addMarker('events', { lifetimeMs, paint: (c, alpha) => drawEventMarker(c, ev, alpha) })
      }
      if (continent) {
        const { message, icon } = eventText(ev)
        ctx.notifications.show({ message, icon, durationMs: lifetimeMs })
      }
    }
  }

  // Shows/hides the temperature overlay and keeps its three visual states in
  // sync: the panel's temp toggle button (icon), the overlay-bar chip, and the
  // layer itself. The panel button and the overlay chip are two doors to the
  // same switch.
  // Desired on/off of each climate overlay — persists across panel switches
  // (the toggle buttons flip these). The overlays only actually SHOW while on
  // the climate panel; off-panel they're hidden but the desired state (and the
  // data) is kept, so returning restores them. Defaults: temperature on, wind off.
  const climateOverlaysOn: Record<string, boolean> = { temperature: true, wind: false, precipitation: false, currents: false, seasonality: false, biomes: false }
  // Per overlay: its toggle button (for the active-state class) and, where a
  // pair exists, the on/off icon to swap. Precipitation reuses one icon and
  // shows state via the class alone.
  const climateToggleIcons: Record<string, { button: HTMLButtonElement; icon: HTMLImageElement; on: string; off: string }> = {
    temperature: { button: tempToggleButton, icon: tempToggleIcon, on: '/icons/temp_on.png', off: '/icons/temp_off.png' },
    wind: { button: windToggleButton, icon: windToggleIcon, on: '/icons/wind_on.png', off: '/icons/wind_off.png' },
    precipitation: { button: precipToggleButton, icon: precipToggleIcon, on: '/icons/ocean.png', off: '/icons/ocean.png' },
    currents: { button: currentsToggleButton, icon: currentsToggleIcon, on: '/icons/gyres.png', off: '/icons/gyres.png' },
    seasonality: { button: seasonalityToggleButton, icon: seasonalityToggleIcon, on: '/icons/seasonality.png', off: '/icons/seasonality.png' },
    biomes: { button: biomesToggleButton, icon: biomesToggleIcon, on: '/icons/biomes.png', off: '/icons/biomes.png' },
  }

  // The hover tooltip (created near setup end); refresh()ed whenever the data or
  // active overlays change so a stationary readout stays in sync.
  let hoverTooltip: ReturnType<typeof createMapHoverTooltip> | null = null

  // Enables each climate layer only when on the climate panel AND wanted; the
  // button icon + active-state class always reflect the wanted state. One
  // composite at the end.
  function applyClimateOverlays(onClimatePanel: boolean): void {
    for (const id of Object.keys(climateOverlaysOn)) {
      const want = climateOverlaysOn[id]
      overlay.setLayerEnabled(id, onClimatePanel && want)
      const t = climateToggleIcons[id]
      t.icon.src = want ? t.on : t.off
      t.button.classList.toggle('is-active', want)
    }
    overlay.composite()
    hoverTooltip?.refresh()
  }

  function toggleClimateOverlay(id: string): void {
    climateOverlaysOn[id] = !climateOverlaysOn[id]
    applyClimateOverlays(true) // only reachable from the climate panel
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
    if (climateOverlaysOn.biomes && lastBiomes) lines.push(biomeLabel(lastBiomes[i]))
    if (climateOverlaysOn.temperature && lastTemperature) lines.push(`${Math.round(lastTemperature[i])} °C`)
    if (climateOverlaysOn.precipitation && lastPrecipitation) {
      const p = lastPrecipitation[i]
      lines.push(p === OCEAN_PRECIP ? 'Ocean' : `${Math.round(p)} mm/yr`)
    }
    if (climateOverlaysOn.seasonality && lastSeasonality) {
      const a = lastSeasonality[i]
      lines.push(a === OCEAN_AMPLITUDE ? 'Ocean' : `${Math.round(a)} °C range`)
    }
    if (climateOverlaysOn.wind && lastWind) {
      lines.push(`Wind ${compass(lastWind[i * 2], lastWind[i * 2 + 1])}`)
    }
    if (climateOverlaysOn.currents && lastCurrents) {
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
    lastBiomes = new Uint8Array(message.biomes)
    climateResX = message.resX
    climateResY = message.resY
    climateStatus.textContent = ''
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
    // Show the freshly-computed result — but only if still on the climate panel
    // (the compute is async; the user may have navigated away).
    applyClimateOverlays(panelIndex === CLIMATE_PANEL_INDEX)
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
    lastBiomes = null
    applyClimateOverlays(false)
    climateStatus.textContent = ''
    tempMinLabel.textContent = '–'
    tempMaxLabel.textContent = '–'
  }

  // Posts a climate compute with the current band-slider offset. Fired on
  // opening the climate panel and by the slider (debounced) for live re-tuning.
  function requestClimate(): void {
    if (simRunning) return
    climateStatus.textContent = '…'
    postToWorker({
      type: 'computeClimate',
      temperatureOffset: Number(tempBandInput.value),
      temperatureContrast: Number(contrastInput.value) / 100,
      humidity: Number(humidityInput.value) / 100,
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

  // A browser can't write to an arbitrary filesystem path (the repo's
  // own /saves/ included) — this is the platform's actual ceiling, not a
  // choice. Triggers two ordinary downloads into wherever the browser's
  // normal downloads location is; move them into /saves/ by hand — see
  // saves/README.md for what the two files contain and why there are
  // two of them.
  function handleExportData(message: WorkerExportDataMessage): void {
    const safeSeed = message.seed.replace(/[^a-zA-Z0-9_-]/g, '_')
    const baseName = `world_${safeSeed}_epoch${message.epoch}`
    const metadata = {
      formatVersion: 2,
      seed: message.seed,
      epoch: message.epoch,
      width: message.width,
      height: message.height,
      landFraction: message.landFraction,
      elevationsFile: `${baseName}.f32`,
      plates: message.plates,
      rafts: message.rafts,
      // Age raster ships as a separate binary blob (like elevations) — it's
      // a Float32 grid, not something to inline as JSON numbers.
      oceanAge: {
        resX: message.oceanAge.resX,
        resY: message.oceanAge.resY,
        valuesFile: `${baseName}.oceanage.f32`,
      },
      terrainFeatures: message.terrainFeatures,
    }
    downloadBlob(new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' }), `${baseName}.json`)
    downloadBlob(new Blob([message.elevations], { type: 'application/octet-stream' }), `${baseName}.f32`)
    downloadBlob(new Blob([message.oceanAge.values], { type: 'application/octet-stream' }), `${baseName}.oceanage.f32`)
  }

  worker.onmessage = (event: MessageEvent<WorkerRenderedMessage | WorkerErosionProgressMessage | WorkerExportDataMessage | WorkerClimateDataMessage | WorkerWorldDataMessage>) => {
    const message = event.data

    if (message.type === 'erosionProgress') {
      erosionStatus.textContent = `${Math.round(message.fraction * 100)}%`
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

    if (message.type === 'exportData') {
      handleExportData(message)
      return
    }

    // Retain the overlay source data + feed the base raster to the compositor
    // so a toggle can re-composite without a worker round-trip, then draw the
    // current layer set.
    lastBoundaryMask = new Uint8Array(message.boundaryMask)
    lastPlateArrows = message.plateArrows
    lastRaftLabels = message.raftLabels
    overlay.setBase(new Uint8ClampedArray(message.buffer))
    handleSimEvents(message.events)
    overlay.composite()

    lastLandFraction = message.landFraction
    lastEpoch = message.epoch
    updateStats()

    // Safety auto-stop once this run reaches its armed target epoch (see
    // startSim / autoStopAtEpoch) — reuses the manual-pause path (stopSim),
    // so the play/pause button and everything else it toggles stay in sync.
    // Guarded by simRunning, so it's a no-op during erosion redraws (which
    // run while stopped) and can't re-fire before the next deliberate start
    // re-arms it.
    if (simRunning && message.epoch >= autoStopAtEpoch) {
      stopSim()
    }

    // DEBUG 3D preview data — kept fresh on every render (see
    // WorkerRenderedMessage.debugHeightmapGrid), not just while the
    // preview is open, so toggling it on always shows the latest state
    // with no extra round trip. If the preview is already open when a
    // new render lands (e.g. Erode clicked again without leaving it),
    // rebuild immediately rather than leaving it showing a stale grid.
    debugHeightmapGrid = new Float32Array(message.debugHeightmapGrid)
    debugHeightmapGridWidth = message.debugHeightmapGridWidth
    debugHeightmapGridHeight = message.debugHeightmapGridHeight
    if (debug3DActive) rebuildDebugMesh()

    // Intermediate renders (see WorkerRenderedMessage.intermediate) are
    // one of 5 in-progress redraws an 'erode' request posts mid-flight —
    // the map/stats above should still reflect them live, but they're
    // not the operation finishing, so the buttons/status readout stay as
    // they are until the actual final render arrives.
    if (!message.intermediate) {
      erosionOpInFlight = false
      erosionStatus.textContent = ''
      updateErosionButtonsState()
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
    toggleSimIcon.src = '/icons/tectonics_off.png'
    toggleSimButton.setAttribute('aria-label', 'Run tectonics')
    seedInput.disabled = false
    plateCountInput.disabled = false
    landFractionInput.disabled = false
    clusteringInput.disabled = false
    cratonCountInput.disabled = false
    randomizeButton.disabled = false
    updateErosionButtonsState()
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
    toggleSimIcon.src = '/icons/tectonics_on.png'
    toggleSimButton.setAttribute('aria-label', 'Stop tectonics')
    seedInput.disabled = true
    plateCountInput.disabled = true
    landFractionInput.disabled = true
    clusteringInput.disabled = true
    cratonCountInput.disabled = true
    randomizeButton.disabled = true
    updateErosionButtonsState()
  }

  toggleSimButton.addEventListener('click', () => {
    if (simRunning) stopSim()
    else startSim()
  })

  erodeButton.addEventListener('click', () => {
    if (simRunning || erosionOpInFlight) return
    erosionOpInFlight = true
    erosionRunCount += 1
    invalidateClimate()
    updateErosionButtonsState()
    postToWorker({ type: 'erode' })
  })

  resetErosionButton.addEventListener('click', () => {
    if (simRunning || erosionOpInFlight) return
    erosionOpInFlight = true
    erosionRunCount = 0
    invalidateClimate()
    updateErosionButtonsState()
    postToWorker({ type: 'resetErosion' })
  })

  toggleDebug3DButton.addEventListener('click', () => setDebug3DActive(!debug3DActive))

  exportButton.addEventListener('click', () => postToWorker({ type: 'export' }))

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
      'kind: World',
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
    setDebug3DActive(false)
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

  // The temp/wind buttons just toggle their overlay on/off (climate is computed
  // on panel open, not here).
  tempToggleButton.addEventListener('click', () => toggleClimateOverlay('temperature'))
  windToggleButton.addEventListener('click', () => toggleClimateOverlay('wind'))
  precipToggleButton.addEventListener('click', () => toggleClimateOverlay('precipitation'))
  currentsToggleButton.addEventListener('click', () => toggleClimateOverlay('currents'))
  seasonalityToggleButton.addEventListener('click', () => toggleClimateOverlay('seasonality'))
  biomesToggleButton.addEventListener('click', () => toggleClimateOverlay('biomes'))

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

  const regenerate = (): void => {
    stopSim()
    // Otherwise a fresh sim would start ticking underneath a debug 3D
    // preview left showing the previous world's now-stale mesh.
    setDebug3DActive(false)
    ctx.notifications.clearAll()
    overlay.clearMarkers()
    invalidateClimate()
    erosionRunCount = 0
    initSim(seedInput.value, Number(plateCountInput.value), Number(landFractionInput.value), Number(clusteringInput.value), Number(cratonCountInput.value))
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
  const PANEL_TITLES = ['Genesis', 'Tectonics', 'Erosion', 'Climate']
  const panelTitle = root.querySelector<HTMLElement>('[data-value="panel-title"]')!
  const panels = Array.from(root.querySelectorAll<HTMLElement>('.panel'))
  let panelIndex = 0
  const showPanel = (index: number): void => {
    panelIndex = index
    panels.forEach((panel, i) => {
      panel.hidden = i !== index
    })
    panelTitle.textContent = PANEL_TITLES[index]
    // Climate overlays only show on the climate panel. Entering it computes the
    // climate if it isn't up to date (first open, or after an upstream reset
    // invalidated it), else re-shows the already-computed result; leaving it
    // hides the overlays (but keeps the data, so returning doesn't recompute).
    // requestClimate self-guards a running sim / missing world.
    if (index === CLIMATE_PANEL_INDEX) {
      if (lastTemperature === null) requestClimate()
      else applyClimateOverlays(true)
    } else {
      applyClimateOverlays(false)
    }
    // The hover readout describes the climate overlays, so it's only live on the
    // climate panel.
    hoverTooltip?.setEnabled(index === CLIMATE_PANEL_INDEX)
  }

  // Cursor readout over the map (reusable module; here it reports the active
  // climate overlays for the hovered cell). Created before the first showPanel
  // so that call sets its enabled state.
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
  root.querySelector('[data-action="next"]')!.addEventListener('click', () => {
    if (panelIndex < panels.length - 1) showPanel(panelIndex + 1)
  })

  ctx.overlay.appendChild(root)

  return {
    scene,
    dispose() {
      stopSim()
      hoverTooltip?.dispose()
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
