import { Color4, Matrix, PointerEventTypes, Scene } from '@babylonjs/core'
import { BUILD_VERSION } from '../../app/buildVersion'
import { createGeneratorCamera } from '../../camera/generatorCamera'
import { createToroidalMapView } from '../../map/ToroidalMapView'
import { createMapHoverTooltip } from '../../map/MapHoverTooltip'
import { buildProbeCard } from '../../ui/mapProbe/probeCard'
import type { ProbeChart, ProbeRow } from '../../ui/mapProbe/probeCard'
import { createToroidalRibbonOverlay } from '../../map/ToroidalRibbonOverlay'
import { createElevationSurface, downsampleElevation } from '../../map/elevationSurface'
import { createMeshSurface } from '../../map/meshSurface'
import { createMeshSampler } from '../../generator/mesh/meshSampler'
import { decodeMesh } from '../../generator/mesh/meshSerial'
import { torusDomain } from '../../generator/core/domain'
import { MAP_WORLD_WIDTH as WORLD_WIDTH, MAP_WORLD_HEIGHT as WORLD_HEIGHT, MAP_EXAGGERATION, RELIEF_DECIMATION, RELIEF_FINE_ZOOM, RELIEF_HEIGHT_SCALE, RELIEF_MIN_ZOOM } from '../../map/mapSceneSettings'
import { AMPLIFY_BAKE_STAGES, AMPLIFY_EROSION_ROUNDS, AMPLIFY_FINEST_STAGE } from '../../world/bakeSettings'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { MAP_HEIGHT, MAP_WIDTH, METERS_PER_CELL } from '../../generator/core/mapConfig'

// Discharge display conversion at the macro cell size (hydrology.dischargeToM3s).
const DISCHARGE_TO_M3S = dischargeToM3s(1, METERS_PER_CELL)
import JSZip from 'jszip'
import type { WaterBody } from '../../generator/surface/hydrology'
import type { CoastReach } from '../../generator/surface/coastGraph'
import type { SedimentBasin } from '../../generator/surface/sedimentBasins'
import { dischargeToM3s } from '../../generator/surface/hydrology'
import type { WorkerOutboundMessage, WorkerStageDeclinedMessage, WorkerGenesisStatusMessage, WorkerClimateDataMessage, WorkerHydrologyDataMessage, WorkerEcologyDataMessage, WorkerMigrationDataMessage, WorkerInboundMessage, WorkerWorldDataMessage, WorkerPlanetPreviewDataMessage, MeshPayload } from '../../generator/pipeline/messages'
import { downstreamOf, stage } from '../../generator/pipeline/stages'
import type { StageId } from '../../generator/pipeline/stages'
import { drawContinentLabels } from '../../generator/render/continentLabelRenderer'
import type { ContinentLabelPlacement } from '../../generator/render/continentLabelRenderer'
import { elevationToMeters, metersToElevation, waterSliderToOffsetM } from '../../generator/elevation/elevationScale'
import { formatWorldAge, worldAgeMa } from '../../generator/core/worldTime'
import type { SimEvent, PlateSimulationSnapshot } from '../../generator/tectonics/plateSimulation'
import { eventCategory } from '../../generator/tectonics/plateSimulation'
import { MapOverlayCompositor } from '../../ui/mapOverlay/MapOverlayCompositor'
import { buildPaperBase, buildUnshadedPaperBase } from '../../map/paperBase'
import { seaLevelTemperatureBand } from '../../generator/climate/temperature'
import { temperatureColor, precipitationColor, amplitudeColor, monsoonColor, temperatureLegendStops, precipitationLegendStops, amplitudeLegendStops, monsoonLegendStops } from '../../generator/climate/climateColors'
import { OCEAN_PRECIP } from '../../generator/climate/precipitation'
import { OCEAN_AMPLITUDE } from '../../generator/climate/seasonality'
import { shiftedYNorm } from '../../generator/climate/climateField'
import { CLIMATE_TUNING } from '../../generator/climate/climateTuneParams'
import { biomeColor, biomeLabelKey, biomeLegend, Biome } from '../../generator/climate/biomes'
import { evaporationPotential } from '../../generator/surface/hydrology'
import { ECOLOGY_FIELD_META, ecologyFieldColor } from '../../generator/ecology/ecologyColors'
import { ECOLOGY_OCEAN, type EcologyFieldId } from '../../generator/ecology/ecologyField'
import { DISCHARGE_LAYER, FORCING_LAYERS, WORLD_LAYERS, bakeLayer } from '../../world/save/worldLayers'
import { getLocale, t, type TKey } from '../../i18n/i18n'
import { relabel } from '../../i18n/relabel'
import { createOverlayList } from './OverlayList'
import { OVERLAY_META, OVERLAY_IDS, overlayKey, type OverlayId } from './overlays'

// The pick row that paints none of a step's exclusive layers (overlayList).
const NO_PICK = 'none' as const
import { STEPS, STEP_IDS, step, type StepId } from './steps'
import { createHelpTooltip } from '../../ui/help/HelpTooltip'
import { createStoragePanel } from '../../ui/storagePanel/StoragePanel'
import { createServerIndicator } from '../../ui/serverIndicator/ServerIndicator'
import { createTitleBar, type TitleBarSaveState } from '../../ui/titleBar/TitleBar'
import { createSaveMenu, type SaveTarget } from '../../ui/titleBar/SaveMenu'
import { createConfirmDialog } from '../../ui/confirmDialog/ConfirmDialog'
import { keepWorldInBrowser } from '../../world/browserWorlds'
import { getServerStatus, refreshServerStatus } from '../../server/serverStatus'
import { isStoredOnServer, uploadWorld } from '../../server/worldClient'
import { createWorldChooser } from './WorldChooser'
import { createStepBar } from './StepBar'
import { createSidebar } from './Sidebar'
import { readRecipeValue as readYamlValue } from '../../world/save/recipeYaml'
import { deriveWorldUid, newWorldUid } from '../../world/identity'
import { getArtifactStore } from '../../storage/artifactStoreProvider'
import { artifactKey } from '../../storage/ArtifactStore'
import { amplificationArtifactExists, amplificationPipelineVersion, readAmplificationArtifact, writeAmplificationArtifact } from '../../world/artifacts'
import { readWorldInputs } from '../../world/save/loadWorldInputs'
import { openWorld } from '../../world/query'
import { amplifyPhaseFraction, bakeStageInBrowser } from '../../generator/surface/bakeInBrowser'
import { bakeFraction, bakeIsWaiting, canCommissionBakes, commissionBake, followBake } from '../../world/bakeClient'
import { MIGRATION_INPUTS } from '../../generator/migration/migrationInputParams'
import { ARCHEAN_INPUTS } from '../../generator/archean/archeanInputParams'
import { CLIMATE_INPUTS } from '../../generator/climate/climateInputParams'
import { TECTONICS_INPUTS } from '../../generator/tectonics/tectonicsInputParams'
import { ECOLOGY_INPUTS, ECOLOGY_ABUNDANCE, ECOLOGY_ABUNDANCE_GROUPS } from '../../generator/ecology/ecologyInputParams'
import { WORLD_SPEC_FIELDS, specFromYaml, specToYamlLines } from '../../world/save/worldSpec'
import type { WorldSpec } from '../../world/save/worldSpec'
import { displayValue, type InputParam } from '../../generator/core/inputParams'
import { PLANET_INPUTS } from '../../generator/planet/planetInputParams'
import { DEFAULT_PLANET_FORCING } from '../../generator/planet/planetForcing'
import './generator.css'
import '../../ui/chrome/chrome.css'
import { needsSignIn } from '../../server/session'

// The ecology per-field abundance weights persisted in world.yaml (keys `w_<field>`).
// The one grouping of ecology resources — used by the panel's abundance fold-out, by
// the column's resource picker, and by the nesting in world.yaml.
//
// It was briefly two lists, and they had already drifted: the panel called the third
// group `metals` and ordered prestige silver-gold-gems, the save called it `metal` and
// ordered it gold-silver-gems. One of them names a key in the save format, so a
// divergence here is not cosmetic.
// The abundance groups are a SAVE-FORMAT fact (a field's group is part of its
// yaml path) and they live where that is decided, in ecology/ecologyInputParams.
// The column no longer shows them: it offers the abundance of the ONE resource
// the map is painting, so there is nothing left to group. Still read here for
// the flat field list and for the save path.
const ECOLOGY_WEIGHT_FIELDS: EcologyFieldId[] = ECOLOGY_ABUNDANCE_GROUPS.flatMap((g) => [...g.fields])
const ecologyWeightPath = (field: EcologyFieldId): string =>
  `spec.ecology.${ECOLOGY_ABUNDANCE_GROUPS.find((g) => g.fields.includes(field))!.id}.${field}`
// Per-field icon; every field has its own.
const FIELD_ICON: Record<EcologyFieldId, string> = {
  carryingCapacity: 'ecology',
  arable: 'wheat', fish: 'fish', game: 'deer', pasture: 'pastures',
  timber: 'timber', salt: 'salt', toolStone: 'stone_axe',
  copper: 'copper_ore', tin: 'tin_ore', iron: 'iron_ore',
  silver: 'silver', gold: 'gold', gems: 'gems',
}

// The initial-migration races (icon toggles + distinct hues). Order = the race
// index used in migrationOrigins / the worker's race field.
// The name is NOT here: it is `species.<id>.label` in the catalogs, which the
// toggles and the legend both read. Carrying a second English copy beside the id
// is how the two drift apart, and only one of them can follow a language switch.
const MIGRATION_RACES: { id: string; icon: string; rgb: [number, number, number] }[] = [
  { id: 'human', icon: 'human', rgb: [86, 116, 200] },
  { id: 'dwarf', icon: 'dwarf', rgb: [96, 176, 92] },
  { id: 'beaver', icon: 'beaver', rgb: [216, 76, 58] },
]

// Plate-boundary line color for the boundaries overlay (drawn main-thread
// from the worker's boundary mask — see the compositor).
const BOUNDARY_COLOR: [number, number, number] = [15, 15, 15]

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

// Fresh start for the hex-tile world generation approach. The sphere-based
// version this replaced was kept beside it for a year and removed 2026-09-20,
// unvisited; it is in the git history if it is ever wanted. Hex-tile generation
// code itself belongs in src/generator.

// World-space size of one toroidal period, independent of the plate
// map's own pixel resolution — matches the map's 2:1 aspect for a simple
// first pass.
// Scene scale + relief-preview settings are shared with the worldmap screen
// — see map/mapSceneSettings.ts.
// Slider value → mantle mixing per epoch. Higher vigour = less stirring = finer
// field = more, smaller plates.
//
// **Quadratic, not linear**, because the response is squeezed against zero. Measured
// plate count against diffusion, mean of three seeds at 250 epochs:
//
//     diffusion   0    0.03  0.08  0.15  0.25  0.40  0.70  1.0  1.7  3.0
//     plates     24.3  22.3  19.0  18.3  13.3  10.3  11.0   10    6  6.5
//
// Half the total swing (24 → 13) happens below diffusion 0.25, and nothing at all
// happens above ~1.7. A linear slider would therefore spend a third of its travel in
// the saturated tail and cram the entire upper half of the range into its last step —
// which is exactly what the first attempt did, and why it read as a switch rather
// than a control.
const MANTLE_DIFFUSION_MAX = 2.25
const MANTLE_DIFFUSION_CURVE = 2
const vigourToDiffusion = (vigour: number): number =>
  MANTLE_DIFFUSION_MAX * ((ARCHEAN_INPUTS.mantleVigour.max - vigour) / (ARCHEAN_INPUTS.mantleVigour.max - ARCHEAN_INPUTS.mantleVigour.min)) ** MANTLE_DIFFUSION_CURVE

// How often, while running, the sim advances one epoch and re-renders —
// paced deliberately (not "as fast as possible") so a run reads as gradual
// mountain-building over time rather than flashing straight to some final state.
//
// 400 ms was set when tectonics was the only thing that stepped. The Archean's
// usable stopping window is 150-250 epochs wide, which at that pace is well over a
// minute of watching before it is even reachable — too slow for a phase whose whole
// interaction is "watch until it looks right". 180 ms keeps the growth legible while
// putting that window inside half a minute.
const EPOCH_INTERVAL_MS = 180

// The mantle tint saturates at this multiple of the field's own p90(|value|),
// rather than at a fixed number.
//
// It used to divide by a hardcoded 1.0. That happens to be well calibrated for the
// TECTONIC phase — measured p90(|v|) climbs to 0.97 by epoch 100 over two seeds, so
// the ramp there very nearly uses its full range. It is wrong for the Archean, whose
// field sustainMantleVigour renormalises to a fixed RMS: p90 is 0.61, and the bulk
// of the map is far below that. The measured median tint alpha in the Archean is
// 0.06 out of a possible 0.55, falling from 0.16 by epoch 25 — a 6% wash in which
// the field's real motion (correlation 0.9 per 25 epochs) is simply not visible.
//
// The reason the two phases differ is structural, not a tuning accident. The field
// is zero-mean, and once continents cover roughly a quarter of the surface that
// quarter carries nearly all of the variance (they insulate; the ocean cools), so
// the remaining three quarters sit just barely below zero. The Archean's fixed-RMS
// renormalisation is set by those few strong cells, which pushes everything else
// down: p50 falls from 0.18 at epoch 100 to ~0.11 by epoch 300, where the tectonic
// phase holds p50 near 0.33.
//
// Normalising by the field's own p90 makes the ramp mean the same thing in both
// phases — "the strongest tenth of the map is fully saturated" — and removes the
// magic number. Deliberately the ONLY difference from the old ramp: an Archean-only
// gamma was tried on top, to lift the mid-tones there (p90 holds around 0.53-0.65
// while p50 falls to ~0.11, so the distribution grows peakier over time and the
// median tint sat at 0.09). It was dropped again once the vigour knob started
// steering the field visibly — the extra contrast was compensating for a control
// that did nothing, and both phases reading the same is worth more than the lift.
const MANTLE_TINT_PERCENTILE = 0.9
// Floor, so a nearly flat field is not amplified into noise: dividing by a p90 near
// zero would paint numerical dust at full opacity.
const MANTLE_TINT_FLOOR = 0.25
// Craton-age ramp: pale sand for crust that formed just now, deep russet for cores
// as old as the world. Warm and sequential on purpose — this is one quantity going
// one direction, so a diverging or rainbow scale would invent a midpoint that has no
// meaning. The dark end reads as "ancient shield", which is roughly how these are
// drawn on real geological maps.
const CRATON_AGE_STOPS: readonly (readonly [share: number, rgb: readonly [number, number, number]])[] = [
  [0.0, [238, 219, 176]],
  [0.5, [186, 122, 74]],
  [1.0, [104, 40, 30]],
]
const CRATON_AGE_ALPHA = 0.8

function cratonAgeColor(age: number): readonly [number, number, number] {
  const a = age <= 0 ? 0 : age >= 1 ? 1 : age
  for (let i = 1; i < CRATON_AGE_STOPS.length; i++) {
    const [hi, hiRgb] = CRATON_AGE_STOPS[i]
    if (a > hi && i < CRATON_AGE_STOPS.length - 1) continue
    const [lo, loRgb] = CRATON_AGE_STOPS[i - 1]
    const t = hi === lo ? 0 : (a - lo) / (hi - lo)
    return [loRgb[0] + (hiRgb[0] - loRgb[0]) * t, loRgb[1] + (hiRgb[1] - loRgb[1]) * t, loRgb[2] + (hiRgb[2] - loRgb[2]) * t]
  }
  return CRATON_AGE_STOPS[0][1]
}

// Legend reads as a share of the world's history rather than an absolute age: the
// field is normalised against the current epoch, so "1" means "here since the
// beginning" and would be a different number of years at every moment you look.
const cratonAgeLegendStops = CRATON_AGE_STOPS.map(([share, rgb]) => ({
  value: Math.round(share * 100),
  rgb: [rgb[0], rgb[1], rgb[2]] as [number, number, number],
}))

// Signed field value scaled so ±1 is full saturation. Precomputed per field rather
// than per pixel: paintMantle runs over the full 2048×1024 map on every overlay
// repaint, and this is constant across each coarse mantle cell.
function mantleTintNorm(field: Float32Array): Float32Array {
  const magnitudes = Float32Array.from(field, Math.abs).sort()
  const scale = Math.max(MANTLE_TINT_FLOOR, magnitudes[Math.floor(magnitudes.length * MANTLE_TINT_PERCENTILE)])
  return Float32Array.from(field, (v) => Math.max(-1, Math.min(1, v / scale)))
}

// Safety cap: the live tectonics stepping auto-stops once it reaches this
// epoch, so a run left going by accident doesn't keep stepping (and
// steadily slowing down as terrain features accumulate) forever. Only a
// safety net — deliberately restarting after it fires keeps going (see
// autoStopTriggered), and generating a new world re-arms it.
const MAX_TECTONICS_EPOCHS = 100

function randomSeed(): string {
  return Math.floor(Math.random() * 1_000_000_000).toString()
}

// Names offered by step 0's dice. Proper nouns, so they are code and not a
// catalog: they read the same in both languages, and a translator asked to
// render "Aurelia" into German has nothing to do but make it worse.
const WORLD_NAMES = [
  'Elvaris', 'Morvane', 'Quelthar', 'Sylvenne', 'Draketh', 'Ombrial',
  'Zephyra', 'Kaldrin', 'Serathis', 'Valdoren', 'Ithryn', 'Corvessa',
  'Thalassor', 'Veyrune', 'Astrakan', 'Lumeris', 'Brannoch', 'Estravel',
  'Myrrhdal', 'Orendis', 'Galvarin', 'Solveth', 'Nerathis', 'Karvossa',
  'Elduran', 'Vashtar', 'Pellucir', 'Ravenne', 'Ystrelle', 'Dornhal',
  'Aethryn', 'Calvessor', 'Mirdane', 'Tovarak', 'Selunor', 'Hyrrin',
  'Obsidra', 'Faerolin', 'Grimvald', 'Liraneth', 'Zarathul', 'Evendris',
  'Quorvain', 'Talmyra', 'Ulthera', 'Brevanth', 'Sarnoth', 'Ilvessa',
  'Xandrel', 'Morthain', 'Celestra', 'Vandaris', 'Yssolde', 'Kharvel',
  'Novareth', 'Drummar', 'Aelindor', 'Pyrrhen', 'Wyndaris', 'Oltheim',
]

function randomWorldName(): string {
  return WORLD_NAMES[Math.floor(Math.random() * WORLD_NAMES.length)]
}

export const createGeneratorScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)

  const {
    dispose: disposeCamera,
    getFocus: getCameraFocus,
    setPanEnabled: setCameraPanEnabled,
    setDeepZoomEnabled: setCameraDeepZoom,
    setDesiredTilt: setCameraDesiredTilt,
    getZoom: getCameraZoom,
    getYaw: getCameraYaw,
    getViewWidth: getCameraViewWidth,
  } = createGeneratorCamera({
    scene,
    canvas: ctx.canvas,
    engine: ctx.engine,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
  })

  const initialSeed = randomSeed()
  // The world's own name, as opposed to its seed. Until step 0 existed the two
  // were the same string: `metadata.name` was written from the seed field, so
  // every world was called by its own dice roll. It travels with the save and
  // shows in the title bar and in the world list.
  //
  // It is deliberately NOT part of the spec: renaming a world must not make it
  // a different one, so the name reaches neither readSpec() nor deriveWorldId()
  // nor the world uid. It IS part of worldSignature, because renaming is an
  // unsaved change like any other.
  let worldName = randomWorldName()
  let lastLandFraction = 0
  let lastEpoch = 0
  // How many eroding epochs the current world has been through (status
  // .erosionRun in a save). Since the coupled history (phase 5.1) every
  // tectonic epoch erodes, so this counts the epochs run since the hand-over:
  // bumped per epoch render, zeroed when the topography is remade (regenerate /
  // reset tectonics), set on load. The gates below ask only whether it is
  // at least one — whether the terrain has been eroded at all.
  let erosionRunCount = 0
  // The world as it was last ESTABLISHED — saved, loaded, or freshly regenerated.
  // Growing it from there (stepping the Archean, running tectonics, eroding, moving
  // a slider) is work that would be lost, so it counts as unsaved. See
  // worldSignature() for what goes into the comparison.
  let savedSignature = ''
  let markCleanOnNextRender = false
  // Set by the load path only. A world from a save arrives with its whole
  // history in the recipe but with NONE of the derived stages in this screen:
  // climate, hydrology and ecology are held as live rasters, and a restore
  // brings back the terrain and the simulation, not them. Until this existed,
  // the step bar called Climate and Ecology uncomputed on every world you
  // opened — which is not a display fault, the screen really did not hold
  // them, but it is a lie about the world.
  let restoredFromSave = false
  // A world's STABLE identity and how many times it has been saved — written to
  // world.yaml's metadata/status, read back on load, and deliberately NOT
  // derived from anything: see identity.newWorldUid for why the terrain hash
  // cannot serve here. Empty until the world is first saved or loaded.
  let worldUid = ''
  let worldRevision = 0
  // Epoch the safety auto-stop will fire at. Re-armed to (current epoch +
  // MAX_TECTONICS_EPOCHS) every time the sim is started (see startSim), so
  // each run halts ~MAX_TECTONICS_EPOCHS after it began: start at 0 stops
  // at 100, restarting at 100 stops at 200, and so on.
  let autoStopAtEpoch = MAX_TECTONICS_EPOCHS

  // Scene-space river ribbons (crisp at any zoom, not baked into the map
  // texture). Declared before the map view so its onRecenter can tile them.
  let riverLayer: ReturnType<typeof createToroidalRibbonOverlay> | null = null

  // The relief preview's two surfaces (see the 'elevationField' handler) +
  // which relief level the ribbons are currently styled for — swapped in
  // lockstep with the mesh LOD from the per-frame onRecenter hook below, so
  // rivers always lie on the surface that is actually on screen, at widths
  // that fit its scale.
  let reliefCoarseSurface: ReturnType<typeof createElevationSurface> | null = null
  let reliefFineSurface: ReturnType<typeof createElevationSurface> | null = null
  let ribbonLevel: 'flat' | 'coarse' | 'fine' = 'flat'

  // The flat map plane + its toroidal 3x3 recentering (see ToroidalMapView).
  // The temperature scale and the scale bar follow the camera — but only
  // once it has come to rest: both read the map through ground picks (a
  // ray against the relief meshes and their wrapped copies, a hundred of
  // them for the scale), and doing that every frame of a pan made the pan
  // crawl (picture check 2026-09-27). The view's key is compared per
  // frame, which is cheap; the redraw waits VIEW_SETTLE_MS after the last
  // change.
  const VIEW_SETTLE_MS = 60
  let viewKeySeen = ''
  let viewChangedAt = 0
  let viewDirty = true
  scene.onBeforeRenderObservable.add(() => {
    const focus = getCameraFocus()
    const key = `${focus.x.toFixed(1)},${focus.z.toFixed(1)},${getCameraZoom().toFixed(4)},${getCameraYaw().toFixed(3)},${window.innerWidth},${window.innerHeight}`
    if (key !== viewKeySeen) {
      viewKeySeen = key
      viewChangedAt = performance.now()
      viewDirty = true
      return
    }
    if (viewDirty && performance.now() - viewChangedAt >= VIEW_SETTLE_MS) {
      viewDirty = false
      renderTemperatureScale()
      renderScaleBar()
    }
  })

  const mapView = createToroidalMapView({
    scene,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    textureWidth: MAP_WIDTH,
    textureHeight: MAP_HEIGHT,
    getFocus: getCameraFocus,
    getYaw: getCameraYaw,
    reliefDetail: () => {
      const zoom = getCameraZoom()
      return zoom > RELIEF_FINE_ZOOM ? 'fine' : zoom > RELIEF_MIN_ZOOM ? 'coarse' : 'flat'
    },
    onRecenter: (centerX, centerZ) => {
      riverLayer?.recenter(centerX, centerZ)
      // Keep the ribbons draped on whichever relief surface is on screen
      // (rebuilds are a few ms and only happen on an actual level
      // transition; width follows zoom continuously in the overlay's own
      // shader). Level is 'flat' whenever no relief exists, whatever the
      // zoom.
      if (!riverLayer) return
      const zoom = getCameraZoom()
      const level: typeof ribbonLevel = !reliefCoarseSurface ? 'flat' : zoom > RELIEF_FINE_ZOOM ? 'fine' : zoom > RELIEF_MIN_ZOOM ? 'coarse' : 'flat'
      if (level !== ribbonLevel) {
        ribbonLevel = level
        if (reliefCoarseSurface) {
          riverLayer.setHeightSurface(level === 'fine' && reliefFineSurface ? reliefFineSurface : reliefCoarseSurface)
        }
      }
    },
  })

  // Relief preview gate: eroded terrain unlocks the deeper zoom ceiling and
  // the tilt envelope; losing it (reset/regenerate/tectonics rerun) folds the
  // view back flat and drops the stale surface. Called from the 'rendered'
  // handler — every path that changes erosionRunCount is followed by a
  // render, so the gate re-syncs itself without per-call-site bookkeeping.
  // The desired tilt is armed permanently for now: tilting is purely
  // zoom-driven (a dedicated tilt control is an open UI question).
  setCameraDesiredTilt(Number.POSITIVE_INFINITY)
  const syncReliefGate = (): void => {
    const active = erosionRunCount >= 1
    setCameraDeepZoom(active)
    if (!active) {
      reliefCoarseSurface = null
      reliefFineSurface = null
      ribbonLevel = 'flat'
      mapView.setReliefSurfaces(null)
      riverLayer?.setHeightSurface(null)
    }
    // The bake start button shares this gate (a bake refines ERODED terrain),
    // and this is the one place every erosionRunCount change flows through.
    void refreshBakeButtons()
  }

  // River ribbons live in the scene over the map plane; segments come from the
  // hydrology step, tiled for the torus wrap via the recenter hook above.
  riverLayer = createToroidalRibbonOverlay({
    scene,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    textureWidth: MAP_WIDTH,
    textureHeight: MAP_HEIGHT,
    getViewWidth: getCameraViewWidth,
  })
  riverLayer.setEnabled(false)

  const root = document.createElement('div')
  // Own root class (not the shared 'worldgen-screen') so this screen's CSS
  // doesn't collide with the legacy sphere screen's worldgen.css, which uses
  // the same selectors at equal specificity and was silently overriding these
  // styles depending on bundle order.
  // map-chrome = the shared screen frame (panel bar, file buttons, nav
  // arrows, fields) extracted to ui/chrome/chrome.css and worn by the
  // worldmap screen too; generator-screen scopes everything specific.
  root.className = 'generator-screen map-chrome'

  // One slider field, rendered from its declaration instead of from four
  // hand-typed copies of the same numbers (the range, the shown default, the
  // input's default, and the reset handler's). The migration panel below is the
  // first to use it; the remaining panels follow in part B6.
  // One slider field, rendered from its declaration. The variants are real, not
  // decoration: genesis sits INSIDE a <label>, so it must be a <span> (nested
  // labels are invalid HTML), and the ecology fields carry a data-ecofield the
  // overlay selector reads.
  //
  // The value and its unit are always wrapped together in one <span>. That is a
  // layout requirement, not tidiness: `.field-label` is `justify-content:
  // space-between`, so an unwrapped "30" + "%" would be two flex items and the
  // percent sign would be pushed to the far edge, away from its number.
  // Every control the markup below declares, so the DOM elements can be found again
  // from the InputParam that produced them. Recorded here rather than assembled by
  // hand afterwards: a control that exists has exactly one place it was written.
  const declaredSliders: { param: InputParam; cls: string; valueKey: string }[] = []
  const sliderBindings = new Map<InputParam, { input: HTMLInputElement; label: HTMLElement }>()

  const sliderField = (p: InputParam, cls: string, valueKey: string,
    opts: { tag?: 'label' | 'span'; extraClass?: string; attrs?: string } = {}): string => {
    declaredSliders.push({ param: p, cls, valueKey })
    const tag = opts.tag ?? 'label'
    const label = t(`${p.i18n}.label` as TKey)
    return `<${tag} class="field${opts.extraClass ? ` ${opts.extraClass}` : ''}" data-help="${p.i18n}"${opts.attrs ?? ''}>
        <span class="field-label">${label}: <span><span data-value="${valueKey}">${displayValue(p, p.default)}</span>${p.unit ? t(p.unit as TKey) : ''}</span></span>
        <input type="range" class="${cls}" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.default}" aria-label="${label}" />
      </${tag}>`
  }


  // The same declaration in the COLUMN's layout: name left, value right, the
  // track under both (design canvas, the Params section). The panel row keeps
  // its own variant above, where a slider has to fit beside five others.
  // The strings sit on the elements as keys, so the column can be said again in
  // another language without the screen being rebuilt (see i18n/relabel).
  const paramField = (p: InputParam, cls: string, valueKey: string, opts: { attrs?: string } = {}): string => {
    declaredSliders.push({ param: p, cls, valueKey })
    const label = t(`${p.i18n}.label` as TKey)
    return `<div class="gen-param" data-help="${p.i18n}"${opts.attrs ?? ''}>
        <div class="gen-param__head">
          <span class="gen-param__label" data-t="${p.i18n}.label">${label}</span>
          <span class="gen-param__value"><span data-value="${valueKey}">${displayValue(p, p.default)}</span>${p.unit ? `<span data-t="${p.unit}">${t(p.unit as TKey)}</span>` : ''}</span>
        </div>
        <input type="range" class="gen-param__range ${cls}" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.default}" aria-label="${label}" data-t-aria="${p.i18n}.label" />
      </div>`
  }

  // One figure of a running simulation, as a tile (design canvas, the Status
  // section): the name, the number with its unit, and — for a percentage — a
  // bar under it, because "41 %" says more when you can see it against the
  // whole. A count and an age have no whole to be a part of, so they get none.
  const statTile = (labelKey: string, valueKey: string,
    opts: { unit?: string; bar?: boolean } = {}): string => `
    <div class="gen-stat">
      <span class="gen-stat__label" data-t="${labelKey}">${t(labelKey as TKey)}</span>
      <span class="gen-stat__value">
        <span class="gen-stat__num" data-value="${valueKey}">–</span>
        ${opts.unit ? `<span class="gen-stat__unit" data-t="${opts.unit}">${t(opts.unit as TKey)}</span>` : ''}
      </span>
      ${opts.bar ? `<span class="gen-stat__track"><span class="gen-stat__bar" data-value="${valueKey}-bar"></span></span>` : ''}
    </div>`

  root.innerHTML = `
    <div class="file-actions">
      <span data-slot="server-indicator"></span>
      <button type="button" class="file-button cache-button" data-action="cache-manager" aria-label="${t('common.action.storage.label')}" data-help="common.action.storage">
        <img src="/icons/server_clean.png" alt="" />
      </button>
    </div>
    <div class="compute-progress" data-value="compute-progress" role="status" hidden>
      <span class="compute-progress__text">
        <span class="compute-progress__label" data-value="compute-progress-label"></span>
        <span class="compute-progress__sub" data-value="compute-progress-sub" hidden></span>
      </span>
      <svg class="compute-progress__disc" viewBox="0 0 120 120" aria-hidden="true">
        <circle class="compute-progress__track" cx="60" cy="60" r="44"/>
        <g data-value="compute-progress-plume">
          <circle class="compute-progress__pulse" cx="60" cy="60" r="10"/>
          <circle class="compute-progress__pulse" cx="60" cy="60" r="10" style="animation-delay: 0.55s"/>
          <circle class="compute-progress__pulse" cx="60" cy="60" r="10" style="animation-delay: 1.1s"/>
        </g>
        <path class="compute-progress__fill" data-value="compute-progress-fill" d=""/>
      </svg>
    </div>
    <div class="temp-scale"><canvas data-value="temp-scale" role="img"></canvas></div>
    <div class="scale-bar" data-value="scale-bar" role="img" hidden>
      <span class="scale-bar__label" data-value="scale-bar-label"></span>
      <span class="scale-bar__bar" data-value="scale-bar-bar"></span>
    </div>
    <div class="world-panel" data-stage="world">
      <p class="world-panel__intro" data-t="generator.world.intro"></p>
      <div class="world-panel__fields">
        <label class="world-field">
          <span class="world-field__label" data-help="generator.world.name" data-t="generator.world.name.label"></span>
          <span class="field-row">
            <input type="text" class="world-name-input" />
            <button type="button" class="icon-button" data-action="roll-name" data-t-aria="generator.world.rollName.label" data-help="generator.world.rollName">
              <img src="/icons/dice.png" alt="" />
            </button>
          </span>
        </label>
        <label class="world-field">
          <span class="world-field__label" data-help="generator.world.seed" data-t="generator.world.seed.label"></span>
          <span class="field-row">
            <input type="text" class="seed-input" data-t-placeholder="generator.panel.genesis.seed.placeholder" value="${initialSeed}" />
            <button type="button" class="icon-button" data-action="randomize-seed" data-t-aria="generator.action.randomizeSeed.label" data-help="generator.action.randomizeSeed">
              <img src="/icons/dice.png" alt="" />
            </button>
          </span>
        </label>
        <div class="world-field world-field--topology">
          <span class="world-field__label" data-help="generator.world.topology" data-t="generator.world.topology.label"></span>
          <div class="topology-list">
            <button type="button" class="topology" aria-pressed="true">
              <span class="topology__name" data-t="generator.world.topology.flat.label"></span>
              <span class="topology__desc" data-t="generator.world.topology.flat.help"></span>
            </button>
            <button type="button" class="topology" aria-pressed="false" aria-disabled="true">
              <span class="topology__name" data-t="generator.world.topology.sphere.label"></span>
              <span class="topology__desc" data-t="generator.world.topology.sphere.help"></span>
            </button>
          </div>
        </div>
      </div>
      <button type="button" class="world-create" data-action="create-world" data-help="generator.world.create" data-t="generator.world.create.label"></button>
    </div>
    <div class="gen-step" data-stage="planet">
      <section class="gen-params">
        <h2 class="gen-section-title" data-t="generator.params.label" data-help="generator.params"></h2>
        ${paramField(PLANET_INPUTS.obliquity, 'obliquity-input', 'obliquity-label')}
        ${paramField(PLANET_INPUTS.greenhouse, 'temp-band-input', 'temp-band-label')}
        ${paramField(PLANET_INPUTS.rotation, 'rotation-input', 'rotation-label')}
      </section>
    </div>
    <div class="gen-step" data-stage="genesis">
      <section class="gen-params">
        <h2 class="gen-section-title" data-t="generator.params.label" data-help="generator.params"></h2>
        ${paramField(ARCHEAN_INPUTS.mantleVigour, 'mantle-vigour-input', 'mantle-vigour-label')}
        ${paramField(ARCHEAN_INPUTS.water, 'water-input', 'water-label')}
      </section>
      <div class="gen-step__foot">
        <div class="gen-stats">
          ${statTile('generator.panel.genesis.stat.stabilised', 'stat-stabilised', { unit: 'common.unit.percent', bar: true })}
          ${statTile('generator.panel.genesis.stat.cratons', 'stat-cratons')}
          ${statTile('generator.panel.genesis.stat.crust', 'stat-crust', { unit: 'common.unit.percent', bar: true })}
          ${statTile('generator.panel.genesis.stat.age', 'stat-world-age')}
        </div>
        <div class="gen-step__actions">
          <button type="button" class="gen-action-icon" data-action="reset-archean" data-t-aria="generator.action.resetArchean.label" data-help="generator.action.resetArchean">
            <img src="/icons/reset.png" alt="" />
          </button>
          <button type="button" class="gen-action" data-action="toggle-archean" data-help="generator.action.runArchean">
            <span class="gen-action__label"></span>
          </button>
        </div>
      </div>
    </div>
    <div class="gen-step" data-stage="tectonics">
      <section class="gen-params">
        <h2 class="gen-section-title" data-t="generator.params.label" data-help="generator.params"></h2>
        <!-- The history's controls (phase 5.1): erosion runs inside every
             epoch, so what used to be the erosion panel's sliders shape the
             epochs, and the epoch's length is what the erosion advances by. -->
        ${paramField(TECTONICS_INPUTS.alluvium, 'tectonics-alluvium-input', 'tectonics-alluvium-label')}
        ${paramField(TECTONICS_INPUTS.rockContrast, 'tectonics-rock-input', 'tectonics-rock-label')}
      </section>
      <div class="gen-step__foot">
        <div class="gen-stats">
          ${statTile('generator.panel.tectonics.stat.land', 'stat-land', { unit: 'common.unit.percent', bar: true })}
          ${statTile('generator.panel.tectonics.stat.continents', 'stat-continents')}
          ${statTile('generator.panel.tectonics.stat.plates', 'stat-plates')}
          ${statTile('generator.panel.tectonics.stat.age', 'stat-tect-age')}
        </div>
        <div class="gen-step__actions">
          <button type="button" class="gen-action-icon" data-action="reset-sim" data-t-aria="generator.action.resetSim.label" data-help="generator.action.resetSim">
            <img src="/icons/reset.png" alt="" />
          </button>
          <button type="button" class="gen-action" data-action="toggle-sim" data-help="generator.action.runTectonics">
            <span class="gen-action__label"></span>
          </button>
        </div>
      </div>
    </div>
    <div class="gen-step" data-stage="climate">
      <section class="gen-params">
        <h2 class="gen-section-title" data-t="generator.params.label" data-help="generator.params"></h2>
        ${paramField(CLIMATE_INPUTS.humidity, 'humidity-input', 'humidity-label')}
        ${paramField(CLIMATE_INPUTS.contrast, 'contrast-input', 'contrast-label')}
      </section>
      <div class="gen-step__foot">
        <div class="gen-stats">
          ${statTile('generator.panel.climate.readout.min', 'temp-min', { unit: 'common.unit.celsius' })}
          ${statTile('generator.panel.climate.readout.max', 'temp-max', { unit: 'common.unit.celsius' })}
        </div>
        <div class="gen-step__actions">
          <!-- No run button: the sliders recompute as they move, so the only
               thing left to press is the reset. It keeps the place it has in
               Genesis and Tectonics; the busy mark stands where their run
               button would be. -->
          <button type="button" class="gen-action-icon" data-action="reset-climate" data-t-aria="generator.action.resetClimate.label" data-help="generator.action.resetClimate">
            <img src="/icons/reset.png" alt="" />
          </button>
          <span class="gen-step__status" data-value="climate-status"></span>
        </div>
      </div>
    </div>
    <div class="gen-step" data-stage="erosion">
      <!-- No sliders and no run button: since the coupled history (phase
           5.1) the erosion happens inside the tectonics' epochs, and its
           controls sit on that panel. What is left here is the readout
           (the rivers) and the detail bake. -->
      <div class="gen-step__foot">
        <!-- The detail bake: pick a width, then order it. It stands with the
             step that makes its input, because a bake refines ERODED terrain
             and nothing else. The design canvas gives it a place of its own
             ("Feinsimulation", with the job list); it moves there when that
             exists. -->
        <div class="gen-bake">
          <div class="gen-bake__tiers">
            <button type="button" class="gen-tier" data-bake-tier="8" aria-pressed="false" disabled data-t="generator.panel.erosion.bake16k.label" data-help="generator.panel.erosion.bake16k">${t('generator.panel.erosion.bake16k.label')}</button>
            <button type="button" class="gen-tier" data-bake-tier="4" aria-pressed="true" data-t="generator.panel.erosion.bake8k.label" data-help="generator.panel.erosion.bake8k">${t('generator.panel.erosion.bake8k.label')}</button>
            <button type="button" class="gen-tier" data-bake-tier="2" aria-pressed="false" data-t="generator.panel.erosion.bake4k.label" data-help="generator.panel.erosion.bake4k">${t('generator.panel.erosion.bake4k.label')}</button>
          </div>
          <button type="button" class="gen-action-icon" data-action="bake-detail" data-t-aria="generator.action.runDetailBake.label" data-help="generator.action.runDetailBake">
            <img src="/icons/erosion_detail.png" alt="" />
          </button>
        </div>
      </div>
    </div>
    <div class="gen-step" data-stage="ecology">
      <section class="gen-params">
        <h2 class="gen-section-title" data-t="generator.params.label" data-help="generator.params"></h2>
        <!-- How much of the resource you are LOOKING AT. One slider rather than
             thirteen behind three category buttons: the column already lists
             every resource once, as the picker that says which one the map
             paints, and tuning the one you can see is how the work goes
             anyway. Its name is set from that pick (see showAbundanceFor).
             It comes FIRST, before the three levers that apply to all
             resources at once. Hidden while the pick is the carrying-capacity
             aggregate, which is not a resource and has those levers instead. -->
        <div class="gen-param" data-value="abundance-row" hidden>
          <div class="gen-param__head">
            <span class="gen-param__label" data-value="abundance-label"></span>
            <span class="gen-param__value"><span data-value="abundance-value">${ECOLOGY_ABUNDANCE.default}</span><span data-t="common.unit.percent">${t('common.unit.percent')}</span></span>
          </div>
          <input type="range" class="gen-param__range abundance-input" min="${ECOLOGY_ABUNDANCE.min}" max="${ECOLOGY_ABUNDANCE.max}" step="${ECOLOGY_ABUNDANCE.step}" value="${ECOLOGY_ABUNDANCE.default}" />
        </div>
        ${paramField(ECOLOGY_INPUTS.carryingCapacity, 'carrying-capacity-input', 'carrying-capacity-label', { attrs: ' data-ecofield="carryingCapacity"' })}
        ${paramField(ECOLOGY_INPUTS.concentration, 'concentration-input', 'concentration-label', { attrs: ' data-ecofield="carryingCapacity"' })}
        ${paramField(ECOLOGY_INPUTS.provinceStrength, 'province-input', 'province-label', { attrs: ' data-ecofield="carryingCapacity"' })}
      </section>
      <div class="gen-step__foot">
        <div class="gen-step__actions">
          <button type="button" class="gen-action-icon" data-action="reset-ecology" data-t-aria="generator.action.resetEcology.label" data-help="generator.action.resetEcology">
            <img src="/icons/reset.png" alt="" />
          </button>
        </div>
      </div>
    </div>
    <div class="panel" data-stage="migration">
      <button type="button" class="icon-button panel-reset" data-action="reset-migration" aria-label="${t('generator.action.resetMigration.label')}" data-help="generator.action.resetMigration">
        <img src="/icons/reset.png" alt="" />
      </button>
      ${sliderField(MIGRATION_INPUTS.spreadBudget, 'migration-spread-input', 'migration-spread-label')}
      ${sliderField(MIGRATION_INPUTS.arrowThreshold, 'migration-threshold-input', 'migration-threshold-label')}
      ${sliderField(MIGRATION_INPUTS.seaCrossing, 'migration-sea-input', 'migration-sea-label')}
      <span class="ecology-cat-buttons" data-value="migration-races"></span>
    </div>
  `

  const seedInput = root.querySelector<HTMLInputElement>('.seed-input')!
  const worldNameInput = root.querySelector<HTMLInputElement>('.world-name-input')!
  const rollNameButton = root.querySelector<HTMLButtonElement>('[data-action="roll-name"]')!
  const createWorldButton = root.querySelector<HTMLButtonElement>('[data-action="create-world"]')!
  worldNameInput.value = worldName
  const mantleVigourInput = root.querySelector<HTMLInputElement>('.mantle-vigour-input')!
  const mantleVigourLabel = root.querySelector<HTMLElement>('[data-value="mantle-vigour-label"]')!
  const waterInput = root.querySelector<HTMLInputElement>('.water-input')!
  const waterLabel = root.querySelector<HTMLElement>('[data-value="water-label"]')!
  // The Planet stage's astronomical controls (planet/planetInputParams.ts).
  const obliquityInput = root.querySelector<HTMLInputElement>('.obliquity-input')!
  const obliquityLabel = root.querySelector<HTMLElement>('[data-value="obliquity-label"]')!
  const rotationInput = root.querySelector<HTMLInputElement>('.rotation-input')!
  const rotationLabel = root.querySelector<HTMLElement>('[data-value="rotation-label"]')!
  const resetArcheanButton = root.querySelector<HTMLButtonElement>('[data-action="reset-archean"]')!
  for (const { param, cls, valueKey } of declaredSliders) {
    const input = root.querySelector<HTMLInputElement>(`.${cls}`)
    const label = root.querySelector<HTMLElement>(`[data-value="${valueKey}"]`)
    if (input && label) sliderBindings.set(param, { input, label })
  }

  // THE INPUT RESET: one stage's controls back to their declared defaults.
  //
  // Was three hand-written lists, one per panel, each naming its sliders again —
  // and the climate one wrote its LABELS as literals ('0', '100') beside values it
  // took from the declaration, so changing a default would have left the panel
  // showing a number the slider was not on. The stage table already knows which
  // controls belong to which stage; this reads them from there.
  //
  // Note what it does NOT touch: anything downstream. A later stage's settings are
  // stated intent, and dropping them because an earlier panel was reset would be
  // data loss rather than cleanup — see docs/design/generator-pipeline.md.
  function resetInputs(id: StageId): void {
    for (const param of Object.values(stage(id).inputs)) {
      const bound = sliderBindings.get(param)
      if (!bound) continue
      bound.input.value = String(param.default)
      bound.label.textContent = displayValue(param, param.default)
    }
  }

  const toggleArcheanButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-archean"]')!
  const statCrust = root.querySelector<HTMLElement>('[data-value="stat-crust"]')!
  const statCratons = root.querySelector<HTMLElement>('[data-value="stat-cratons"]')!
  const statWorldAge = root.querySelector<HTMLElement>('[data-value="stat-world-age"]')!
  const statStabilised = root.querySelector<HTMLElement>('[data-value="stat-stabilised"]')!
  const statCrustBar = root.querySelector<HTMLElement>('[data-value="stat-crust-bar"]')!
  const statStabilisedBar = root.querySelector<HTMLElement>('[data-value="stat-stabilised-bar"]')!
  const randomizeButton = root.querySelector<HTMLButtonElement>('[data-action="randomize-seed"]')!
  const resetButton = root.querySelector<HTMLButtonElement>('[data-action="reset-sim"]')!
  const toggleSimButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-sim"]')!
  // The history's controls (tectonicsInputParams): read when a run starts,
  // so a change while the plates move applies to the next run.
  const alluviumInput = root.querySelector<HTMLInputElement>('.tectonics-alluvium-input')!
  const rockContrastInput = root.querySelector<HTMLInputElement>('.tectonics-rock-input')!
  const alluviumLabel = root.querySelector<HTMLElement>('[data-value="tectonics-alluvium-label"]')!
  const rockContrastLabel = root.querySelector<HTMLElement>('[data-value="tectonics-rock-label"]')!
  alluviumInput.addEventListener('input', () => { alluviumLabel.textContent = alluviumInput.value })
  rockContrastInput.addEventListener('input', () => { rockContrastLabel.textContent = rockContrastInput.value })
  const resetClimateButton = root.querySelector<HTMLButtonElement>('[data-action="reset-climate"]')!
  const resetEcologyButton = root.querySelector<HTMLButtonElement>('[data-action="reset-ecology"]')!
  const resetMigrationButton = root.querySelector<HTMLButtonElement>('[data-action="reset-migration"]')!
  // The artifact cache is filled by the worldmap, but inspecting it is just
  // as wanted from here — a world tuned in this screen is what ends up
  // costing minutes to bake over there. Same centred window, un-localized
  // like the other debug affordances.
  // Where a world would go, shown on every screen (see ui/serverIndicator).
  const serverIndicator = createServerIndicator(root)
  root.querySelector('[data-slot="server-indicator"]')!.replaceWith(serverIndicator.element)

  // The title bar (ui/titleBar). It has taken over saving and opening from the
  // older chrome — the floppy and the folder are gone, and what is left of the
  // strip below it is the server indicator and the cache window, which the
  // design keeps in the job list this screen does not have yet.
  //
  // The WORDMARK is the way out, not the world's name beside it: the name says
  // which world is open, and a control that reads as a label is how you leave
  // a world by accident. The world list is reached from the save menu now.
  //
  // onLocaleChange does NOT rebuild the screen, unlike the title and map
  // screens: a rebuild here throws away an unsaved world. The pieces redrawn
  // from the design canvas say themselves again in place instead. The older
  // panels still cannot — their markup called `t()` once, when the screen was
  // built — so they keep the language they were built in until the screen is
  // entered again. They follow as each one moves into the sidebar.
  const titleBar = createTitleBar(root, {
    nameKey: 'generator.title',
    onSignIn: () => serverIndicator.openSignIn(),
    onHomeClick: () => { void leaveWorld(() => ctx.goTo('title')) },
    onLocaleChange: () => {
      // One call for the whole column: every step block in it carries its keys
      // rather than its strings (see i18n/relabel).
      relabel(sidebar.body)
      sidebar.relabel()
      stepBar.relabel()
      worldChooser.relabel()
      saveMenu.relabel()
      tempScale.setAttribute('aria-label', t('overlay.temperature.scale'))
      // The step statuses are words the screen chooses, not the bar's; this is
      // what puts the new language into them.
      updateNavState()
      sayScreen()
    },
  })

  // Saving and opening hang in the bar's tool slot (ui/titleBar/SaveMenu),
  // where the design draws them. It is the generator that owns them — the bar
  // is chrome and knows no world — so the menu is built here and its four
  // moves are this screen's own.
  const saveMenu = createSaveMenu({
    currentWorld: () => ({ uid: worldUid, seed: seedInput.value, revision: worldRevision }),
    onSave: (target) => { void saveTo(target) },
    onOpenWorld: () => { void leaveWorld(() => openWorldChooser()) },
    onSignIn: () => serverIndicator.openSignIn(),
  })
  titleBar.tools.appendChild(saveMenu.element)

  const storagePanel = createStoragePanel(root)
  root.querySelector('[data-action="cache-manager"]')!.addEventListener('click', () => storagePanel.open())
  const climateStatus = root.querySelector<HTMLElement>('[data-value="climate-status"]')!
  const tempBandInput = root.querySelector<HTMLInputElement>('.temp-band-input')!
  const tempBandLabel = root.querySelector<HTMLElement>('[data-value="temp-band-label"]')!
  const humidityInput = root.querySelector<HTMLInputElement>('.humidity-input')!
  const humidityLabel = root.querySelector<HTMLElement>('[data-value="humidity-label"]')!
  const contrastInput = root.querySelector<HTMLInputElement>('.contrast-input')!
  const contrastLabel = root.querySelector<HTMLElement>('[data-value="contrast-label"]')!
  const carryingCapacityInput = root.querySelector<HTMLInputElement>('.carrying-capacity-input')!
  const carryingCapacityLabel = root.querySelector<HTMLElement>('[data-value="carrying-capacity-label"]')!
  const concentrationInput = root.querySelector<HTMLInputElement>('.concentration-input')!
  const concentrationLabel = root.querySelector<HTMLElement>('[data-value="concentration-label"]')!
  const migrationSpreadInput = root.querySelector<HTMLInputElement>('.migration-spread-input')!
  const migrationSpreadLabel = root.querySelector<HTMLElement>('[data-value="migration-spread-label"]')!
  const migrationThresholdInput = root.querySelector<HTMLInputElement>('.migration-threshold-input')!
  const migrationThresholdLabel = root.querySelector<HTMLElement>('[data-value="migration-threshold-label"]')!
  const migrationSeaInput = root.querySelector<HTMLInputElement>('.migration-sea-input')!
  const migrationSeaLabel = root.querySelector<HTMLElement>('[data-value="migration-sea-label"]')!
  const tempMaxLabel = root.querySelector<HTMLElement>('[data-value="temp-max"]')!
  const tempMinLabel = root.querySelector<HTMLElement>('[data-value="temp-min"]')!
  const statLand = root.querySelector<HTMLElement>('[data-value="stat-land"]')!
  const statLandBar = root.querySelector<HTMLElement>('[data-value="stat-land-bar"]')!
  const statTectAge = root.querySelector<HTMLElement>('[data-value="stat-tect-age"]')!
  const statPlates = root.querySelector<HTMLElement>('[data-value="stat-plates"]')!
  const statContinents = root.querySelector<HTMLElement>('[data-value="stat-continents"]')!
  // Plate tectonics runs and stops from one button, which says which it is —
  // the same shape the Archean's has since both moved into the column. Saying
  // it again is also how the button follows a language switch.
  const sayTectonicsButton = (running: boolean): void => {
    const label = t(running ? 'generator.action.runTectonics.labelActive' : 'generator.action.runTectonics.label')
    toggleSimButton.setAttribute('aria-label', label)
    toggleSimButton.querySelector('.gen-action__label')!.textContent = label
  }
  sayTectonicsButton(false)
  const computeProgress = root.querySelector<HTMLElement>('[data-value="compute-progress"]')!
  const computeProgressLabel = root.querySelector<HTMLElement>('[data-value="compute-progress-label"]')!
  const computeProgressSub = root.querySelector<HTMLElement>('[data-value="compute-progress-sub"]')!
  const computeProgressPlume = root.querySelector<SVGGElement>('[data-value="compute-progress-plume"]')!
  const computeProgressFill = root.querySelector<SVGPathElement>('[data-value="compute-progress-fill"]')!

  // Simulation and rendering both happen inside this worker (see
  // generator/pipeline/runtime.ts) — stepping an epoch and rendering the full
  // raster are heavy enough that doing them on the main thread stalled
  // camera panning/input for the duration of every tick.
  const worker = new Worker(new URL('../../generator/generatorWorker.ts', import.meta.url), { type: 'module' })
  const postToWorker = (message: WorkerInboundMessage): void => worker.postMessage(message)

  // Named for the PHASE, not "the sim": the Archean is a simulation too, and its own
  // stepper is archeanRunning. The two are mutually exclusive — the worker runs both
  // off a single interval — but the UI gates different buttons on each.
  let tectonicsRunning = false
  // The Archean phase is running (its own stepper in the worker, separate from the
  // tectonic one). Both can never run at once: the Archean is finalised before the
  // tectonic phase can start.
  let archeanRunning = false
  // Archean epochs completed — carried into the world.yaml recipe and, after the
  // handover, into the world-age readout.
  let lastArcheanEpochs = 0
  // Whether this screen holds a world at all: step 0 was answered with "Create
  // world", or a world was opened from a file. Every later step is gated on it
  // (see entryRequirementUnmet) — until then there is a map on screen, but it
  // is the one the screen starts with, not one anybody asked for.
  let worldCreated = false
  // Latest stabilised fraction, so updateProgress can render the bar without the
  // status message being in scope.
  let archeanStabilised = 0
  // Set once the Archean has been handed over, so re-entering the Tectonics panel
  // doesn't finalise a world that is already past that point. Cleared by a
  // regenerate or an Archean reset.
  let archeanFinalised = false
  // Whether a HAND-OVER exists to go back to — mirrors the worker's
  // `handoverSnapshot`. Kept apart from `archeanFinalised` because that flag was
  // carrying two meanings at once: "the Archean is over, plates exist" (which the
  // overlays and the commit guard ask) and "this world was grown here, so
  // tectonics can be rewound" (which only the reset button asks). A loaded
  // tectonic world answers YES to the first and NO to the second, so one boolean
  // could not be right for both.
  let hasHandover = false
  // Any worker computation in flight: tectonics ticking (which erodes as it
  // goes) or a climate/hydrology compute. While busy, ALL bottom-panel controls
  // are disabled except the ACTIVE process's stop button (the only allowed action).
  let climateInFlight = false
  let hydrologyInFlight = false
  let ecologyInFlight = false
  let migrationInFlight = false
  // One-shot resolvers so the save flow can await each compute (compute-on-save):
  // set before requesting a step, called by its data handler when it lands.
  let climateResolve: (() => void) | null = null
  let hydrologyResolve: (() => void) | null = null
  let ecologyResolve: (() => void) | null = null
  // True while the save flow drives the compute chain — suppresses the ecology
  // panel's own auto-recompute so it doesn't double-fire.
  let saveChainActive = false
  const isBusy = (): boolean => tectonicsRunning || climateInFlight || hydrologyInFlight || ecologyInFlight || migrationInFlight

  // Disable every panel control while a compute runs; the running process keeps its
  // stop button live (tectonics = toggle-sim, erosion = erode, which becomes a stop).
  const updateControlsDisabled = (): void => {
    const busy = isBusy()
    randomizeButton.disabled = busy
    resetButton.disabled = busy
    resetClimateButton.disabled = busy
    resetEcologyButton.disabled = busy
    resetMigrationButton.disabled = busy
    saveMenu.setEnabled(!busy)
    // Stop buttons of the active process stay enabled.
    toggleSimButton.disabled = busy && !tectonicsRunning
    // Genesis inputs (debounced-)regenerate the whole world, so lock them while
    // busy; the history's controls are read when a run starts, so they lock
    // too — a slider that moves while the plates run and changes nothing
    // would lie. The climate/river sliders are left live for tuning (they
    // only affect the next compute, not the one in flight).
    for (const el of [seedInput, mantleVigourInput, waterInput, alluviumInput, rockContrastInput]) el.disabled = busy

    updateNavState() // the step bar locks with it (see its own gating)
  }

  // THE PROGRESS PILL over the map (design canvas, Fortschritt.dc.html,
  // variant C "Plume und Füllstand", 2026-09-26): a line, a disc, and
  // under the Archean's line its advice — the state ("crust still
  // forming") over what to do about it ("keep running"); the tectonics'
  // epoch and age, the name of a stage that runs outside its step, stand
  // alone (user's call). Where the run has a measure the disc
  // FILLS from the bottom with a wave for a surface — the Archean by its
  // stabilised fraction, the tectonics by this run's epochs towards the
  // safety stop — coloured by the same three-stage judgement the banner
  // states (archeanStage; the tectonics grey below the minimum the climate
  // needs, green above). Where there is none — the climate, the rivers,
  // the ecology, the migration — rings rise out of the centre like a
  // plume. No percentage is written (user's call). Hidden when idle —
  // except in the Genesis step, where the Archean's pill STANDS after the
  // stop, wave and clock still, with its narration and its disc: that is
  // the moment the judgement is needed (run on, or hand over).
  //
  // The fraction is a position, not a promise: the Archean and the
  // tectonics are processes you STOP (the 2026-08-06 objection to a
  // filling bar); the disc says how far along the window you are, the
  // banner says what that means.
  const PROGRESS_R = 44
  const PROGRESS_CY = 60
  let progressTicker: ReturnType<typeof setInterval> | undefined
  let progressWavePhase = 0
  let progressPaused = false
  // The fill: the disc below a wavy water line at `fraction` of its height,
  // as one closed path — the wave across the chord, the circle's lower arc
  // back to the start.
  const progressFillPath = (fraction: number, phase: number): string => {
    const f = Math.min(0.985, Math.max(0.015, fraction))
    const level = PROGRESS_CY + PROGRESS_R - 2 * PROGRESS_R * f
    const half = Math.sqrt(Math.max(0, PROGRESS_R * PROGRESS_R - (level - PROGRESS_CY) * (level - PROGRESS_CY)))
    const x0 = 60 - half
    const x1 = 60 + half
    const amplitude = Math.min(3.5, half * 0.12)
    const points: string[] = []
    const steps = 24
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps
      const y = level + amplitude * Math.sin(((x - 60) / 22) + phase)
      points.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
    }
    const yEnd = level + amplitude * Math.sin(((x1 - 60) / 22) + phase)
    const yStart = level + amplitude * Math.sin(((x0 - 60) / 22) + phase)
    return `${points.join(' ')} L${x1.toFixed(2)} ${yEnd.toFixed(2)} A${PROGRESS_R} ${PROGRESS_R} 0 0 1 60 ${PROGRESS_CY + PROGRESS_R} A${PROGRESS_R} ${PROGRESS_R} 0 0 1 ${x0.toFixed(2)} ${yStart.toFixed(2)} Z`
  }
  const updateProgress = (): void => {
    let label = ''
    let sub: string | null = null
    let fraction: number | null = null
    let stage: 'early' | 'window' | 'late' | null = null
    const archeanStanding = archeanNarrated && !archeanFinalised && !hasHandover && panelIndex === GENESIS_PANEL_INDEX
    progressPaused = false
    if (archeanRunning || archeanStanding) {
      const judged = archeanStage(archeanStabilised)
      label = judged.hint
      sub = judged.advice
      fraction = archeanStabilised
      stage = judged.stage
      progressPaused = !archeanRunning
    } else if (tectonicsRunning) {
      // The same two lines as the Archean's: the state over the advice.
      // Early until the climate's minimum, late within the last epochs
      // before the safety stop, the window between.
      const judged = tectonicsStage(lastEpoch)
      label = judged.hint
      sub = judged.advice
      fraction = 1 - Math.max(0, autoStopAtEpoch - lastEpoch) / MAX_TECTONICS_EPOCHS
      stage = judged.stage
    } else if (climateInFlight) {
      label = t('generator.step.climate.label')
    } else if (hydrologyInFlight) {
      label = t('generator.progress.hydrology')
    } else if (ecologyInFlight) {
      label = t('generator.step.ecology.label')
    } else if (migrationInFlight) {
      label = t('generator.step.migration.label')
    } else {
      computeProgress.hidden = true
      if (progressTicker !== undefined) { clearInterval(progressTicker); progressTicker = undefined }
      return
    }
    computeProgress.hidden = false
    computeProgressLabel.textContent = label
    computeProgressSub.textContent = sub ?? ''
    computeProgressSub.hidden = sub === null
    if (fraction === null) {
      computeProgressPlume.style.display = ''
      computeProgressFill.setAttribute('d', '')
      delete computeProgress.dataset.stage
      computeProgress.setAttribute('aria-label', t('generator.progress.ariaRunning', { step: label }))
    } else {
      computeProgressPlume.style.display = 'none'
      computeProgressFill.setAttribute('d', progressFillPath(fraction, progressWavePhase))
      if (stage) computeProgress.dataset.stage = stage
      else delete computeProgress.dataset.stage
      computeProgress.setAttribute('aria-label', t('generator.progress.aria', { step: label, percent: `${Math.round(fraction * 100)} %` }))
    }
    // The wave moves while the pill shows — once a second is enough, and
    // not at all when motion is reduced or the Archean stands.
    if (progressTicker === undefined) {
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      progressTicker = setInterval(() => {
        if (!still && !progressPaused) progressWavePhase += 0.6
        updateProgress()
      }, 1000)
    }
  }

  let lastPlateCount = 0
  let lastContinentCount = 0
  const updateStats = (): void => {
    statLand.textContent = String(Math.round(lastLandFraction * 100))
    statLandBar.style.width = `${Math.min(100, lastLandFraction * 100)}%`
    // The world clock runs across both phases — the Archean's epochs are worth
    // 5 Ma each and the tectonic ones 1 Ma, so this is not just the epoch count
    // rescaled. See core/worldTime.
    statTectAge.textContent = formatWorldAge(worldAgeMa(lastArcheanEpochs, lastEpoch))
    statPlates.textContent = String(lastPlateCount)
    statContinents.textContent = String(lastContinentCount)
  }
  updateStats()

  // Overlays (boundaries / names / events) are composited on the main
  // thread over the worker's base color raster — the worker has no Canvas2D
  // (fonts/strokes) and toggling must be instant, so the base raster + overlay
  // source data are retained here and re-composited on demand rather than
  // re-rendered. The generic mechanism (canvas, toggle state, marker fade,
  // texture upload) lives in MapOverlayCompositor; only the worldgen-specific
  // layer drawing + event→marker/notification mapping stays here.
  let lastBoundaryMask: Uint8Array | null = null
  let lastRaftLabels: ContinentLabelPlacement[] = []
  // Coarse mantle buoyancy field + hotspot plumes (from each render) for the
  // tectonics "Mantle" overlay: hot upwelling → red, cold downwelling → blue, plus
  // a marker at each fixed plume (the source of the hotspot volcano chains).
  let lastMantle: Float32Array | null = null
  let mantleResX = 0
  let mantleResY = 0
  // lastMantle scaled to ±1 for the tint ramp, recomputed per field (mantleTintNorm).
  let mantleNorm: Float32Array | null = null
  // Crust age on the mantle grid: -1 over ocean, else 0 (formed now) to 1 (formed
  // at epoch 0). Drives the "Craton age" overlay — see computeCratonOldnessField.
  let lastCratonAge: Float32Array | null = null
  let lastHotspots: { x: number; y: number }[] = []
  let lastVolcanoes: { x: number; y: number; thickness: number; kind: 'hotspot' | 'flood' | 'arc' }[] = []
  // Coarse elevation for the hover readout's metre line (see
  // WorkerRenderedMessage.elevation). Present from the first render on, which is
  // why the readout works before any climate has been computed.
  let lastCoarseElevation: Float32Array | null = null
  let elevationResX = 0
  let elevationResY = 0
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
  // Step order IS the pipeline chain, plus step 0 in front of it — see steps.ts,
  // which owns the table and checks it against the chain. Hoisted here because
  // the panel constants below derive from it.
  //
  // Throws rather than returning -1: a step whose panel is missing would
  // otherwise read as "panel before the first one" and quietly change every
  // comparison that uses it.
  const panelIndexOf = (id: StepId): number => {
    const i = STEP_IDS.indexOf(id)
    if (i < 0) throw new Error(`no panel for step ${id}`)
    return i
  }
  const GENESIS_PANEL_INDEX = panelIndexOf('genesis')

  // Entering this panel is what commits the Archean — see commitGenesis.
  const TECTONICS_PANEL_INDEX = panelIndexOf('tectonics')
  const CLIMATE_PANEL_INDEX = panelIndexOf('climate')
  let lastTemperature: Float32Array | null = null
  let lastWind: Float32Array | null = null
  let lastPrecipitation: Float32Array | null = null
  let lastCurrents: Float32Array | null = null
  let lastSeasonality: Float32Array | null = null
  let lastMonsoonIndex: Float32Array | null = null
  let lastBiomes: Uint8Array | null = null
  let climateResX = 0
  let climateResY = 0
  // Rivers/lakes (hydrology) — a panel-less stage shown on the erosion panel.
  // River segments come from the worker's hydrology step; null until computed /
  // invalidated.
  let lastRiverData: { points: Float32Array; lengths: Uint32Array; regimes: Uint8Array } | null = null
  // A baked river network, shown INSTEAD of the 2k one when this world has an
  // amplified artifact. Display only, and kept apart from lastRiverData for a
  // concrete reason: that one is written into the save as layers/rivers.json,
  // and a save whose rivers came from an 8k bake would carry a network its own
  // elevation raster cannot reproduce — while deriveWorldId, which hashes no
  // rivers at all, would call the two saves identical.
  //
  // The 2048 raster stays the authority (docs/decisions/worldmap-amplification);
  // this only lets the generator PREVIEW what the world map will draw.
  let bakedRiverDisplay: { points: Float32Array; lengths: Uint32Array; regimes: Uint8Array } | null = null

  // Whichever network is current. One place, so the two sources cannot both
  // think they are on screen.
  function drawRivers(): void {
    const shown = bakedRiverDisplay ?? lastRiverData
    if (shown) riverLayer?.setPolylines(shown.points, shown.lengths, shown.regimes)
  }

  // Adopt a baked artifact's rivers for display, rescaled from the fine grid to
  // macro texel coordinates. Only x/y are divided: the third component is a
  // CARTOGRAPHIC width, sized to read as a line rather than measured in cells,
  // so scaling it would thin every river as the bake got finer.
  function showBakedRivers(points: Float32Array, lengths: Uint32Array, regimes: Uint8Array, factor: number): void {
    const scaled = new Float32Array(points.length)
    for (let i = 0; i < points.length; i += 3) {
      scaled[i] = points[i] / factor
      scaled[i + 1] = points[i + 1] / factor
      scaled[i + 2] = points[i + 2]
    }
    bakedRiverDisplay = { points: scaled, lengths, regimes }
    drawRivers()
  }
  let lastWatersheds: Uint16Array | null = null
  let lastDischargeField: Float32Array | null = null
  let lastMaxDischarge = 0
  let lastLakeDepth: Float32Array | null = null
  // The water table's depth below the surface (phase 5a), a save layer.
  let lastWaterTable: Float32Array | null = null
  // The standing-water truth behind lastLakeDepth (hydrology.WaterBody): the
  // save carries the list; the map draws shores against the per-cell level.
  let lastWaterBodies: WaterBody[] | null = null
  let lastWaterLevel: Float32Array | null = null
  let lastWaterSurface: Uint8Array | null = null
  // The coast (surface/coastGraph.ts): the type per cell the shore drawing
  // reads, and the reach list the save carries.
  let lastCoastType: Uint8Array | null = null
  let lastCoast: { reaches: CoastReach[]; cells: Int32Array } | null = null
  // The erosion pass's deposits as features (surface/sedimentBasins.ts).
  let lastSedimentBasins: SedimentBasin[] | null = null
  // Precipitation INCLUDING the riparian bonus — what the biomes were actually
  // classified from, and the only extra a consumer needs to reclassify them at
  // its own resolution (see the precipitationEffective layer).
  let lastPrecipitationEffective: Float32Array | null = null
  // Ecology (resource/suitability) panel — its own step after hydrology. Phase 1:
  // the carrying-capacity field only. null until computed / invalidated.
  const ECOLOGY_PANEL_INDEX = panelIndexOf('ecology')
  // All computed ecology fields, keyed by id (see ecology/ecologyField). The
  // single ecology overlay paints whichever `selectedEcologyField` is chosen in
  // the panel selector, on an absolute 0..1 scale.
  let lastEcologyFields: Partial<Record<EcologyFieldId, Float32Array>> = {}
  let selectedEcologyField: EcologyFieldId = 'carryingCapacity'
  // What the picker last CHOSE, as opposed to what a hover is momentarily
  // showing. Leaving a hover returns here; it used to return to the aggregate,
  // which silently threw the choice away — and since the abundance slider
  // follows the choice, it threw the slider away with it.
  let pickedEcologyField: EcologyFieldId = 'carryingCapacity'
  // Field currently previewed by hovering a panel slider/icon (null = not
  // hovering). While non-null the ecology overlay shows even if its own
  // toggle is off, and reverts when the mouse leaves the panel.
  let ecologyHoverField: EcologyFieldId | null = null
  const ecologyLayerOn = (): boolean => (overlaysOn.ecology || ecologyHoverField !== null) && hasEcologyData()
  let ecologyResX = 0
  let ecologyResY = 0
  const hasEcologyData = (): boolean => lastEcologyFields.carryingCapacity != null
  // Initial-migration panel — its own step after ecology. Three races (icon toggles),
  // origins auto-placed at good cradles, least-cost dispersal → density + arrow tree.
  const MIGRATION_PANEL_INDEX = panelIndexOf('migration')
  let lastMigration: { race: Int8Array; density: Float32Array; flow: Float32Array; predecessor: Int32Array; resX: number; resY: number } | null = null
  const migrationRaceEnabled = MIGRATION_RACES.map(() => true)
  let migrationOrigins: { cell: number; race: number }[] = [] // one per race index (by MIGRATION_RACES order)
  let migrationMaxDensity = 0 // for the density-fill brightness (cached on compute)
  let migrationMaxFlow = 0 // for the arrow-tree width + threshold (cached on compute)

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
    if (!mantleNorm) return
    for (let y = 0; y < MAP_HEIGHT; y++) {
      const gy = Math.min(mantleResY - 1, Math.floor((y / MAP_HEIGHT) * mantleResY))
      for (let x = 0; x < MAP_WIDTH; x++) {
        const gx = Math.min(mantleResX - 1, Math.floor((x / MAP_WIDTH) * mantleResX))
        const v = mantleNorm[gy * mantleResX + gx]
        const a = (v < 0 ? -v : v) * 0.55
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

  // Crust age: fresh crust pale, ancient cratonic cores deep russet. Ocean is left
  // untouched, so this reads as a geological map of the land rather than a tint over
  // everything — and it is what makes the Archean's structure legible, since a
  // craton grows by welding younger crust onto an old core and that history is
  // otherwise invisible in the coastline.
  //
  // Blended over the base at full strength rather than as a wash: unlike the mantle
  // field, which is a cause acting everywhere, this is a property OF the land, and a
  // faint version of it would be unreadable against the terrain colouring.
  function paintCratonAge(data: Uint8ClampedArray): void {
    if (!lastCratonAge || !lastRelief) return
    for (let y = 0; y < MAP_HEIGHT; y++) {
      const gy = Math.min(mantleResY - 1, Math.floor((y / MAP_HEIGHT) * mantleResY))
      for (let x = 0; x < MAP_WIDTH; x++) {
        const i = y * MAP_WIDTH + x
        // Masked to the coastline the renderer actually drew, not to the crust field's
        // own reach. computeCratonOldnessField reports an age wherever ANY blob kernel
        // touches — that is the full blob radius — but land only begins where the
        // SUMMED metaball field clears sea level, which for a lone blob is 0.458 of its
        // radius. Painting the field directly therefore covered about five times the
        // area of the island under it, and the overlay visibly overhung the coast.
        if (!(lastRelief[i] & 128)) continue
        const gx = Math.min(mantleResX - 1, Math.floor((x / MAP_WIDTH) * mantleResX))
        const age = lastCratonAge[gy * mantleResX + gx]
        if (age < 0) continue // no crust here at all
        const [r, g, b] = cratonAgeColor(age)
        const p = i * 4
        data[p] = data[p] * (1 - CRATON_AGE_ALPHA) + r * CRATON_AGE_ALPHA
        data[p + 1] = data[p + 1] * (1 - CRATON_AGE_ALPHA) + g * CRATON_AGE_ALPHA
        data[p + 2] = data[p + 2] * (1 - CRATON_AGE_ALPHA) + b * CRATON_AGE_ALPHA
      }
    }
  }

  // Mantle-driver markers, drawn onto the base texture so the toroidal tiling wraps
  // them: the volcanic PRODUCTS (red cones = hotspot chains, dark cones = flood-basalt
  // provinces, sized by thickness) underneath, then the fixed plume SOURCES (orange
  // rings) the hotspot chains trail from.
  function drawVolcanoes(c: CanvasRenderingContext2D): void {
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
  }

  // The plume SOURCES, split from the cones they produce: a plume is a fixture of the
  // deep mantle, the volcanoes are what it prints onto whatever drifts over it. They
  // also do not exist in the same phases — the Archean has neither, while the mantle
  // field it shares a button with is that phase's main content.
  function drawHotspots(c: CanvasRenderingContext2D): void {
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

  // Temperature heatmap tint (climate) — a pixel layer blended over the terrain
  // so both show. Samples the coarse climate grid (nearest cell) per map pixel.
  // No-op until climate is computed. Drawn before boundaries/names so those
  // stay legible on top.
  // Climatic water balance: rainfall minus potential evaporation, the map of
  // where the land gains water and where it loses it. Diverging ramp — arid
  // rust below zero, paper-white at balance, deep blue-green surplus. Coarse
  // climate grid, land only (ocean keeps the base map).
  function paintWaterBalance(data: Uint8ClampedArray): void {
    if (!lastTemperature || !lastPrecipitation) return
    const alpha = 0.55
    const clampAbs = 1500
    for (let y = 0; y < MAP_HEIGHT; y++) {
      const gy = Math.min(climateResY - 1, Math.floor((y / MAP_HEIGHT) * climateResY))
      for (let x = 0; x < MAP_WIDTH; x++) {
        const gx = Math.min(climateResX - 1, Math.floor((x / MAP_WIDTH) * climateResX))
        const i = gy * climateResX + gx
        const p0 = lastPrecipitation[i]
        if (p0 === OCEAN_PRECIP) continue
        const balance = Math.max(-clampAbs, Math.min(clampAbs, p0 - evaporationPotential(lastTemperature[i])))
        const t2 = balance / clampAbs // -1..1
        const r = t2 < 0 ? 245 + (170 - 245) * -t2 : 245 + (30 - 245) * t2
        const g = t2 < 0 ? 243 + (60 - 243) * -t2 : 243 + (110 - 243) * t2
        const b = t2 < 0 ? 238 + (40 - 238) * -t2 : 238 + (150 - 238) * t2
        const p = (y * MAP_WIDTH + x) * 4
        data[p] = data[p] * (1 - alpha) + r * alpha
        data[p + 1] = data[p + 1] * (1 - alpha) + g * alpha
        data[p + 2] = data[p + 2] * (1 - alpha) + b * alpha
      }
    }
  }

  // Watersheds: each labelled catchment in its own colour, golden-angle hue
  // walk over the id so neighbouring ids land far apart on the wheel.
  function paintWatersheds(data: Uint8ClampedArray): void {
    if (!lastWatersheds) return
    const alpha = 0.5
    for (let i = 0; i < lastWatersheds.length; i++) {
      const id = lastWatersheds[i]
      if (id === 0) continue
      const hue = (id * 137.508) % 360
      const c = 0.45, m = 0.35 // fixed chroma/lightness floor -> readable pastels
      const hp = hue / 60
      const xw = c * (1 - Math.abs((hp % 2) - 1))
      const [r1, g1, b1] = hp < 1 ? [c, xw, 0] : hp < 2 ? [xw, c, 0] : hp < 3 ? [0, c, xw] : hp < 4 ? [0, xw, c] : hp < 5 ? [xw, 0, c] : [c, 0, xw]
      const p = i * 4
      data[p] = data[p] * (1 - alpha) + (r1 + m) * 255 * alpha
      data[p + 1] = data[p + 1] * (1 - alpha) + (g1 + m) * 255 * alpha
      data[p + 2] = data[p + 2] * (1 - alpha) + (b1 + m) * 255 * alpha
    }
  }

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
    const baseAlpha = 0.6
    // Deposit fields (fadeZero) blend out below this value — barren land shows
    // terrain instead of the ramp's 0% tint, and the Gaussian deposit halos fade
    // smoothly into it rather than ending in a hard stamp edge.
    const fadeIn = 0.05
    const fadeZero = ECOLOGY_FIELD_META[selectedEcologyField].fadeZero === true
    for (let y = 0; y < MAP_HEIGHT; y++) {
      const gy = Math.min(ecologyResY - 1, Math.floor((y / MAP_HEIGHT) * ecologyResY))
      for (let x = 0; x < MAP_WIDTH; x++) {
        const gx = Math.min(ecologyResX - 1, Math.floor((x / MAP_WIDTH) * ecologyResX))
        const v = field[gy * ecologyResX + gx]
        if (v === ECOLOGY_OCEAN) continue
        const alpha = fadeZero ? baseAlpha * Math.min(1, v / fadeIn) : baseAlpha
        if (alpha === 0) continue
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
        // The strength, not the phase — the ramp runs 0..1 and a signed field
        // would fold its two halves onto one colour (climate/monsoon.ts).
        const [r, g, b] = monsoonColor(Math.abs(idx))
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
  // `lastBiomes` shares the map raster (see the worker's climateData message), so
  // this is a straight per-pixel read — no climate-grid sampling, and no 8x8
  // blocks. The other climate overlays around it still sample their coarse grid.
  function paintBiomes(data: Uint8ClampedArray): void {
    if (!lastBiomes) return
    const alpha = 0.85
    for (let i = 0; i < MAP_WIDTH * MAP_HEIGHT; i++) {
      const id = lastBiomes[i]
      if (id === Biome.Ocean) continue
      const [r, g, b] = biomeColor(id)
      const p = i * 4
      data[p] = data[p] * (1 - alpha) + r * alpha
      data[p + 1] = data[p + 1] * (1 - alpha) + g * alpha
      data[p + 2] = data[p + 2] * (1 - alpha) + b * alpha
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

  // Debug marker, not a map layer: flat magenta on every cell the erosion pass lifted
  // from below sea level. Deliberately garish and unshaded — the job is "where did the
  // sediment go", and a tasteful tint would disappear against the ocean blue at the
  // very sizes (a handful of cells) that matter most here.
  // Layer draw/list order: temperature first (a base tint), names last so labels
  // stay on top (always readable); the climate layers (temperature, wind) are
  // not offered by every step — see steps.ts. The
  // 'events' layer has no static paint — it just gates the transient event
  // markers (added via overlay.addMarker).
  // Latest composited RGBA (retained for the save preview thumbnail).
  let lastCompositePixels: Uint8Array | null = null
  const overlay = new MapOverlayCompositor(MAP_WIDTH, MAP_HEIGHT, (pixels) => {
    lastCompositePixels = pixels
    mapView.texture.update(pixels)
  })

  // Second compositor output for the relief meshes: identical layer stack
  // (the layer OBJECTS are shared, so every toggle applies to both) over the
  // UNSHADED base — the relief carries real normals and a real light, and
  // feeding it the hillshaded composite would double-shade every slope. Only
  // composited while eroded terrain exists (see compositeOverlays); transient
  // event markers are main-compositor-only, which is fine — they belong to
  // the map reading, not the relief look.
  const reliefOverlay = new MapOverlayCompositor(MAP_WIDTH, MAP_HEIGHT, (pixels) => {
    mapView.reliefTexture.update(pixels)
  })
  // Every composite goes through here so the two outputs can never drift.
  function compositeOverlays(): void {
    overlay.composite()
    if (erosionRunCount >= 1) reliefOverlay.composite()
  }

  // Torus wrap for VECTOR overlays (labels, markers, arrows): the compositor canvas is
  // MAP_WIDTH×MAP_HEIGHT and doesn't wrap, so an element straddling the seam gets clipped
  // at the edge — a wide continent name near x=0/x=MAP_WIDTH loses half itself, then the
  // 3×3 texture tiling just repeats the clipped copy. Drawing `fn` at all 9 tile offsets
  // makes the overflow reappear on the opposite edge, so it stitches back together across
  // the seam. (Full-raster paintPixels layers already cover the whole canvas, so only the
  // shape/text `paint` layers need this.) See the [[project_worldgen_canvas_flip]] note.
  // The equator: the map's middle row, about which the climate is symmetric
  // (the thermal-equator shift is 0 since 2026-09-26). A faint dashed line,
  // drawn across the wrapped copies like the map's other lines.
  function drawEquator(c: CanvasRenderingContext2D): void {
    const y = MAP_HEIGHT / 2
    c.save()
    c.strokeStyle = 'rgba(44, 62, 96, 0.32)'
    c.lineWidth = 2
    c.setLineDash([20, 16])
    c.beginPath()
    c.moveTo(0, y)
    c.lineTo(MAP_WIDTH, y)
    c.stroke()
    c.restore()
  }

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

  // Migration density fill: each reached cell tinted its race's hue, alpha ∝
  // population density (denser = stronger). Ocean/unreached left as terrain.
  function paintMigration(data: Uint8ClampedArray): void {
    if (!lastMigration || migrationMaxDensity <= 0) return
    const { race, density, resX, resY } = lastMigration
    for (let y = 0; y < MAP_HEIGHT; y++) {
      const gy = Math.min(resY - 1, Math.floor((y / MAP_HEIGHT) * resY))
      for (let x = 0; x < MAP_WIDTH; x++) {
        const gx = Math.min(resX - 1, Math.floor((x / MAP_WIDTH) * resX))
        const cell = gy * resX + gx
        const r = race[cell]
        if (r < 0) continue
        const a = 0.62 * Math.min(1, density[cell] / migrationMaxDensity)
        if (a < 0.02) continue
        const [rr, gg, bb] = MIGRATION_RACES[r].rgb
        const p = (y * MAP_WIDTH + x) * 4
        data[p] = data[p] * (1 - a) + rr * a
        data[p + 1] = data[p + 1] * (1 - a) + gg * a
        data[p + 2] = data[p + 2] * (1 - a) + bb * a
      }
    }
  }

  // Migration arrow-tree: the pruned predecessor tree drawn as tapering ribbons —
  // each edge's width ∝ the population flowing through it, so a corridor narrows
  // as it fans out (flow[child] < flow[parent]). Race sets the hue, local density
  // modulates brightness, and arrowheads mark only the outer *drawn* tips (the
  // frontiers) so direction reads without clutter. Pruned by the "arrows"
  // threshold slider (higher = lower flow cut = more arrows). No-op until computed.
  const MIGRATION_ARROW_MAX_WIDTH = 15
  const MIGRATION_ARROW_MIN_WIDTH = 1.4
  function drawMigrationArrows(c: CanvasRenderingContext2D): void {
    if (!lastMigration || migrationMaxFlow <= 0) return
    const { race, density, flow, predecessor, resX, resY } = lastMigration
    const n = resX * resY
    // Flow spans orders of magnitude (trunk ≈ whole population, leaf ≈ one cell),
    // so the slider maps EXPONENTIALLY onto the flow cut: s=0 → only the fattest
    // trunks (0.12·max), s=1 → fine branches (0.0004·max). Higher slider = more arrows.
    const s = Math.max(0, Math.min(1, MIGRATION_INPUTS.arrowThreshold.toModel(Number(migrationThresholdInput.value))))
    const threshold = migrationMaxFlow * Math.exp(Math.log(0.12) + s * (Math.log(0.0004) - Math.log(0.12))) + 1e-9
    const cellWX = (cell: number): number => (((cell % resX) + 0.5) / resX) * MAP_WIDTH
    const cellWY = (cell: number): number => ((Math.floor(cell / resX) + 0.5) / resY) * MAP_HEIGHT
    const wd = (a: number, b: number, m: number): number => { let d = a - b; if (d > m / 2) d -= m; if (d < -m / 2) d += m; return d }
    // A drawn cell is a frontier tip if no drawn child hangs off it.
    const hasDrawnChild = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      if (race[i] < 0 || flow[i] <= threshold) continue
      const p = predecessor[i]
      if (p >= 0) hasDrawnChild[p] = 1
    }
    c.lineCap = 'round'
    c.lineJoin = 'round'
    for (let i = 0; i < n; i++) {
      if (race[i] < 0 || flow[i] <= threshold) continue
      const p = predecessor[i]
      if (p < 0) continue
      const cx = cellWX(i)
      const cy = cellWY(i)
      const ddx = wd(cellWX(p), cx, MAP_WIDTH) // child→parent, wrapped (edges are grid-adjacent)
      const ddy = wd(cellWY(p), cy, MAP_HEIGHT)
      const width = MIGRATION_ARROW_MIN_WIDTH + (MIGRATION_ARROW_MAX_WIDTH - MIGRATION_ARROW_MIN_WIDTH) * Math.sqrt(Math.min(1, flow[i] / migrationMaxFlow))
      const bright = 0.45 + 0.55 * (migrationMaxDensity > 0 ? Math.min(1, density[i] / migrationMaxDensity) : 1)
      const [rr, gg, bb] = MIGRATION_RACES[race[i]].rgb
      const col = `rgb(${Math.round(rr * bright)},${Math.round(gg * bright)},${Math.round(bb * bright)})`
      c.strokeStyle = col
      c.lineWidth = width
      c.beginPath()
      c.moveTo(cx + ddx, cy + ddy)
      c.lineTo(cx, cy)
      c.stroke()
      if (!hasDrawnChild[i]) {
        const angle = Math.atan2(-ddy, -ddx) // outward = parent→child direction
        const head = Math.max(13, width * 3.2)
        c.fillStyle = col
        c.beginPath()
        c.moveTo(cx + Math.cos(angle) * head, cy + Math.sin(angle) * head)
        c.lineTo(cx + Math.cos(angle + 2.5) * head * 0.6, cy + Math.sin(angle + 2.5) * head * 0.6)
        c.lineTo(cx + Math.cos(angle - 2.5) * head * 0.6, cy + Math.sin(angle - 2.5) * head * 0.6)
        c.closePath()
        c.fill()
      }
    }
  }

  // Origin markers: a filled disc in the race hue at each enabled race's origin.
  function drawMigrationOrigins(c: CanvasRenderingContext2D): void {
    for (const o of migrationOrigins) {
      if (!lastMigration || !migrationRaceEnabled[o.race]) continue
      const gy = Math.floor(o.cell / lastMigration.resX)
      const gx = o.cell - gy * lastMigration.resX
      const wx = ((gx + 0.5) / lastMigration.resX) * MAP_WIDTH
      const wy = ((gy + 0.5) / lastMigration.resY) * MAP_HEIGHT
      const [r, g, b] = MIGRATION_RACES[o.race].rgb
      c.beginPath()
      c.arc(wx, wy, 16, 0, Math.PI * 2)
      c.fillStyle = `rgb(${r},${g},${b})`
      c.fill()
      c.lineWidth = 4
      c.strokeStyle = 'rgba(255,255,255,0.9)'
      c.stroke()
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
    // Migration: race-tinted density fill (paintPixels) + origin markers (paint).
    { id: 'migration', label: 'Migration', enabled: false, hidden: true, paintPixels: paintMigration, paint: (c) => paintWrapped(c, (cc) => { drawMigrationArrows(cc); drawMigrationOrigins(cc) }) },
    // Mantle: field tint (paintPixels) + hotspot plume markers (paint) in one layer.
    { id: 'mantle', label: 'Mantle', enabled: false, hidden: true, paintPixels: paintMantle },
    { id: 'volcanoes', label: 'Volcanoes', enabled: false, hidden: true, paint: (c) => paintWrapped(c, drawVolcanoes) },
    { id: 'hotspots', label: 'Hotspots', enabled: false, hidden: true, paint: (c) => paintWrapped(c, drawHotspots) },
    // After 'mantle', so on land the crust's own age wins over the tint of the
    // mantle beneath it — the mantle field is the cause and covers the whole map,
    // this is the result and covers only the crust.
    { id: 'cratonAge', label: 'Craton age', enabled: false, hidden: true, paintPixels: paintCratonAge },
    { id: 'boundaries', label: 'Boundaries', enabled: false, paintPixels: paintBoundaryMask },
    // The equator is always drawn, like the events — a property of the map,
    // not a user toggle (decided 2026-09-26 on the picture check).
    { id: 'equator', label: 'Equator', enabled: true, paint: (c) => paintWrapped(c, drawEquator) },
    { id: 'wind', label: 'Wind', enabled: false, hidden: true, paint: drawWind },
    { id: 'currents', label: 'Currents', enabled: false, hidden: true, paint: drawCurrents },
    { id: 'waterBalance', label: 'Water balance', enabled: false, hidden: true, paintPixels: paintWaterBalance },
    { id: 'watersheds', label: 'Watersheds', enabled: false, hidden: true, paintPixels: paintWatersheds },
    // Events are always on — a persistent notification-coupled marker layer,
    // not a user toggle.
    { id: 'events', label: 'Events', enabled: true },
    { id: 'names', label: 'Names', enabled: false, paint: (c) => paintWrapped(c, (cc) => drawContinentLabels(cc, lastRaftLabels)) },
  ])
  // Same layer OBJECTS in both compositors — toggles/enabled flags are
  // shared state, only the base differs (shaded vs. unshaded paper).
  reliefOverlay.setLayers([...overlay.getLayers()])

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
        return { message: ev.nameA && ev.nameB ? t('notify.event.continentsCollidedNamed', { a: ev.nameA, b: ev.nameB }) : t('notify.event.continentsCollided'), icon: '/icons/continent.png' }
      case 'continent_broke_up':
        return { message: ev.name ? t('notify.event.continentBreakupNamed', { name: ev.name }) : t('notify.event.continentBreakup'), icon: '/icons/continent.png' }
      case 'supercontinent_formed':
        return { message: ev.name ? t('notify.event.supercontinentFormedNamed', { name: ev.name }) : t('notify.event.supercontinentFormed'), icon: '/icons/crown.png' }
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

  // The hover tooltip (created near setup end); refresh()ed whenever the data or
  // active overlays change so a stationary readout stays in sync.
  let hoverTooltip: ReturnType<typeof createMapHoverTooltip> | null = null

  // THE OVERLAYS. Which layers exist, what they are called and which icon
  // stands for them lives in overlays.ts; which of them a step offers lives in
  // steps.ts; the two tables below say when a layer can be shown and what its
  // legend says, because both read this screen's own data. 'rivers' bundles the
  // scene-space river ribbons + the lake tint under one control. Events are not
  // a layer you switch — they are always on.
  //
  // 'gradient' = a continuous colour ramp with value labels; 'swatches' =
  // discrete colour+label rows. Shown on the right whenever a legend-bearing
  // overlay is active.
  type LegendSpec =
    | { type: 'gradient'; title: string; unit: string; stops: { value: number; rgb: [number, number, number] }[] }
    | { type: 'swatches'; title: string; items: { label: string; rgb: [number, number, number]; shape?: 'square' | 'cone' | 'ring' | 'line'; dash?: 'solid' | 'dashed' | 'dotted' }[] }
  // EVERY ENTRY IS A FUNCTION, and renderLegends calls it. Two reasons, and the
  // first one was a bug: a spec written as a plain object runs its `t()` once,
  // when the screen is built, so the legend kept the language the generator was
  // entered in for as long as the world stayed open. The second is that a
  // legend may depend on live state, which is what the ecology one used to do.
  //
  // The gradient titles and units below are still English in the code — they
  // have no catalog key yet, and giving them one is its own step.
  // WHETHER a layer can be shown right now — one predicate per layer, keyed by
  // the id, so a layer added to the vocabulary is a compile error here until it
  // says when it exists. (The icons and the names live in overlays.ts; these
  // read the screen's own data, which is why they stay.)
  const overlayAvailable: Record<OverlayId, () => boolean> = {
    terrain: () => lastColoredBase !== null,
    // Available from the hand-over on, running or not — the plates are the thing
    // you are watching in that step, and hiding them mid-run (which is what
    // `!tectonicsRunning` used to do) removed them exactly when they were moving.
    // The Archean clause is what keeps them off a world that has no plates yet.
    boundaries: () => lastBoundaryMask !== null && (archeanFinalised || !archeanRunning),
    // Blocked during the Archean: proto-cratons are not continents yet, they merge
    // and fragment constantly, and naming something that dissolves ten epochs later
    // is noise. finalizeArchean names them all when plate tectonics begins.
    names: () => archeanFinalised && lastRaftLabels.length > 0,
    mantle: () => lastMantle !== null,
    // Split out of the mantle overlay. It used to carry the field tint, the volcanic
    // cones and the plume rings under one control with one static legend — which in the
    // Genesis step promised a "Volcano" and a "Hotspot plume" that can never appear
    // there, because the Archean has neither. Three layers, three honest legends.
    volcanoes: () => lastVolcanoes.length > 0,
    hotspots: () => lastHotspots.length > 0,
    // Available as soon as any crust exists, which in the Archean is within a few
    // epochs of the first upwelling standing still long enough.
    cratonAge: () => lastCratonAge !== null && lastCratonAge.some((v) => v >= 0),
    temperature: () => lastTemperature !== null,
    seasonality: () => lastSeasonality !== null,
    wind: () => lastWind !== null,
    currents: () => lastCurrents !== null,
    precipitation: () => lastPrecipitation !== null,
    monsoon: () => lastMonsoonIndex !== null,
    biomes: () => lastBiomes !== null,
    rivers: () => lastRiverData !== null,
    waterBalance: () => lastTemperature !== null && lastPrecipitation !== null,
    watersheds: () => lastWatersheds !== null,
    ecology: hasEcologyData,
    migration: () => lastMigration !== null,
  }

  // A legend explains a layer's colours; only the layers whose colour→meaning is
  // not self-evident carry one (names/boundaries/wind/rivers do not).
  //
  // EVERY ENTRY IS A FUNCTION, and renderLegends calls it. Two reasons, and the
  // first was a bug: a spec written as a plain object runs its `t()` once, when
  // the screen is built, so the legend kept the language the generator was
  // entered in for as long as the world stayed open — a rebuild is what the
  // other screens do on a language switch, and this one must not. The second is
  // that a legend may depend on live state, which the ecology one used to do.
  //
  // The gradient titles and units below are still English in the code: they
  // have no catalog key yet, and giving them one is its own step.
  // NO ENTRY FOR `ecology`: a resource layer paints 0..100% of one field, and
  // a ramp from "none" to "much" explains nothing the map does not already
  // show. Which field it is stands in the column, on the row you picked.
  const overlayLegend: Partial<Record<OverlayId, () => LegendSpec>> = {
    mantle: () => ({ type: 'swatches', title: t('overlay.mantle.legend.title'), items: [
      { label: t('overlay.mantle.legend.upwelling'), rgb: [225, 85, 55] },
      { label: t('overlay.mantle.legend.downwelling'), rgb: [55, 110, 210] },
    ] }),
    volcanoes: () => ({ type: 'swatches', title: t('overlay.volcanoes.legend.title'), items: [
      { label: t('overlay.volcanoes.legend.hotspot'), rgb: [220, 55, 30], shape: 'cone' },
      { label: t('overlay.volcanoes.legend.arc'), rgb: [235, 120, 30], shape: 'cone' },
      { label: t('overlay.volcanoes.legend.flood'), rgb: [120, 25, 20], shape: 'cone' },
    ] }),
    hotspots: () => ({ type: 'swatches', title: t('overlay.hotspots.legend.title'), items: [
      { label: t('overlay.hotspots.legend.plume'), rgb: [255, 140, 0], shape: 'ring' },
    ] }),
    cratonAge: () => ({ type: 'gradient', title: t('overlay.cratonAge.label'), unit: t('overlay.cratonAge.legend.unit'), stops: cratonAgeLegendStops }),
    temperature: () => ({ type: 'gradient', title: t('overlay.temperature.label'), unit: t('overlay.temperature.legend.unit'), stops: temperatureLegendStops }),
    seasonality: () => ({ type: 'gradient', title: t('overlay.seasonality.label'), unit: t('overlay.seasonality.legend.unit'), stops: amplitudeLegendStops }),
    precipitation: () => ({ type: 'gradient', title: t('overlay.precipitation.label'), unit: t('overlay.precipitation.legend.unit'), stops: precipitationLegendStops }),
    monsoon: () => ({ type: 'gradient', title: t('overlay.monsoon.legend.title'), unit: '', stops: monsoonLegendStops }),
    biomes: () => ({ type: 'swatches', title: t('overlay.biomes.label'), items: biomeLegend().map((b) => ({ label: t(b.labelKey as TKey), rgb: b.rgb })) }),
    // The colours are the map's: the ribbon overlay's river blue, the water
    // shader's lake, ice and coast tints (map/waterMaterialPlugin.ts).
    rivers: () => ({ type: 'swatches', title: t('overlay.rivers.label'), items: [
      { label: t('overlay.rivers.legend.perennial'), rgb: [45, 95, 175], shape: 'line', dash: 'solid' },
      { label: t('overlay.rivers.legend.intermittent'), rgb: [45, 95, 175], shape: 'line', dash: 'dashed' },
      { label: t('overlay.rivers.legend.ephemeral'), rgb: [45, 95, 175], shape: 'line', dash: 'dotted' },
      { label: t('overlay.rivers.legend.lake'), rgb: [60, 110, 170] },
      { label: t('overlay.rivers.legend.ice'), rgb: [216, 230, 242] },
      { label: t('overlay.rivers.legend.cliff'), rgb: [72, 60, 50], shape: 'line', dash: 'solid' },
      { label: t('overlay.rivers.legend.beach'), rgb: [238, 224, 178] },
      { label: t('overlay.rivers.legend.marsh'), rgb: [150, 168, 130] },
    ] }),
    waterBalance: () => ({ type: 'swatches', title: t('overlay.waterBalance.label'), items: [
      { label: t('overlay.waterBalance.legend.humid'), rgb: [30, 110, 150] },
      { label: t('overlay.waterBalance.legend.arid'), rgb: [170, 60, 40] },
    ] }),
    migration: () => ({ type: 'swatches', title: t('overlay.migration.legend.title'), items: MIGRATION_RACES.map((r) => ({ label: t(`species.${r.id}.label` as TKey), rgb: r.rgb })) }),
  }

  // Which layers are showing. Set from the step you enter (see steps.ts) and
  // changed by the switches in the column; a layer stays "wanted" while its data
  // comes and goes, which is what lets a switch survive a recompute.
  const overlaysOn: Record<OverlayId, boolean> = Object.fromEntries(OVERLAY_IDS.map((id) => [id, false])) as Record<OverlayId, boolean>

  // Picking a resource field points the ecology layer at that field. Unlike every
  // other overlay these are mutually exclusive — paintEcology renders ONE field over
  // the whole land, so a second could only overwrite the first. Picking the one
  // already showing switches the layer off again.
  function selectEcologyField(field: EcologyFieldId): void {
    if (overlaysOn.ecology && selectedEcologyField === field) {
      overlaysOn.ecology = false
    } else {
      selectedEcologyField = field
      overlaysOn.ecology = true
    }
    pickedEcologyField = selectedEcologyField
    showAbundanceFor(pickedEcologyField)
    updateOverlays()
  }

  // The phase hint sits just above the compute bar, at the bottom. It used to sit
  // under the overlay bar that used to hang over the map, and the move turned out
  // to be the better place anyway: the compute bar's three-stage COLOUR and this
  // sentence come from the same archeanStage() call, so they say the same thing
  // and had no business being at opposite edges of the screen.
  // The Archean's narration ("crust forms and dissolves", "drifting", …)
  // is the progress pill's line since 2026-09-26; the band it stood in
  // over the map is gone. True once a status has said something.
  let archeanNarrated = false

  // The legend for the active overlay(s) that carry one (see overlayLegend), as
  // a collapsible panel: a header button that names it and counts what is in it,
  // and a body that opens under it. COLLAPSED BY DEFAULT — the map is the thing
  // being looked at, and a standing column of swatches is an answer to a question
  // most hovers do not ask.
  //
  // It stays at the left edge of the map rather than moving to the bottom-left
  // corner the design puts it in: that corner is the parameter panel's, and its
  // step title already sits there.
  const legendPanel = document.createElement('section')
  legendPanel.className = 'overlay-legend'
  const legendToggle = document.createElement('button')
  legendToggle.type = 'button'
  legendToggle.className = 'legend-toggle'
  const legendToggleLabel = document.createElement('span')
  legendToggleLabel.className = 'legend-toggle-label'
  const legendCount = document.createElement('span')
  legendCount.className = 'legend-toggle-count'
  const legendChevron = document.createElement('span')
  legendChevron.className = 'legend-toggle-chevron'
  legendChevron.setAttribute('aria-hidden', 'true')
  legendToggle.append(legendToggleLabel, legendCount, legendChevron)
  const legendBody = document.createElement('div')
  legendBody.className = 'legend-body'
  legendPanel.append(legendToggle, legendBody)
  root.appendChild(legendPanel)

  let legendOpen = false
  legendToggle.addEventListener('click', () => {
    legendOpen = !legendOpen
    renderLegends()
  })

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
        } else if (it.shape === 'line') {
          // A drawn line: the rivers' regimes (solid, dashed, dotted — the
          // ribbon shader's convention) and the coast's cliff line.
          sw.className = 'legend-line'
          sw.style.borderTopStyle = it.dash ?? 'solid'
          sw.style.borderTopColor = `rgb(${it.rgb[0]},${it.rgb[1]},${it.rgb[2]})`
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
    // Ecology's legend follows its EFFECTIVE state (the pick in the column OR a
    // hover preview over one of its sliders).
    const active = OVERLAY_IDS.filter((id) => overlayLegend[id] && overlayShown(id))
    legendToggleLabel.textContent = t('overlay.legend.title')
    legendCount.textContent = String(active.length)
    legendToggle.setAttribute('aria-expanded', String(legendOpen))
    legendPanel.classList.toggle('overlay-legend--open', legendOpen)
    if (!legendOpen) {
      legendBody.replaceChildren()
      return
    }
    if (active.length === 0) {
      // Open and empty says something the closed button cannot: the layers on
      // the map are ones whose colours explain themselves.
      const empty = document.createElement('div')
      empty.className = 'legend-empty'
      empty.textContent = t('overlay.legend.empty')
      legendBody.replaceChildren(empty)
      return
    }
    legendBody.replaceChildren(...active.map((id) => buildLegendBlock(overlayLegend[id]!())))
  }

  // Whether a layer is actually on the map: wanted AND available. Ecology is the
  // one exception — it also shows while an abundance slider is hovered, which is
  // a preview of what that slider does, not a state anybody switched on.
  const overlayShown = (id: OverlayId): boolean =>
    id === 'ecology' ? ecologyLayerOn() : overlaysOn[id] && overlayAvailable[id]()

  // Enable each layer per overlayShown; 'rivers' drives the scene ribbons and
  // the lakes (drawn by the map's water plugin, not a layer) together. One
  // composite at the end.
  function applyOverlays(): void {
    for (const id of OVERLAY_IDS) {
      const show = overlayShown(id)
      if (id === 'rivers') {
        riverLayer?.setEnabled(show)
        mapView.setLakesVisible(show)
      } else {
        overlay.setLayerEnabled(id, show)
      }
    }
    compositeOverlays()
    hoverTooltip?.refresh()
  }

  const isOverlayId = (id: string): id is OverlayId => id in OVERLAY_META

  // Pick one of the step's exclusive layers: it comes on, the rest of ITS group
  // goes off. The group is read from the step table rather than kept a second
  // time, and the state is the ordinary `overlaysOn` — a pick is a switch that
  // turns its siblings off, not a second kind of thing to keep in sync.
  // `NO_PICK` switches the whole group off.
  function pickExclusiveOverlay(id: OverlayId | typeof NO_PICK): void {
    const group = step(STEP_IDS[panelIndex]).exclusive
    if (id !== NO_PICK && !group.includes(id)) return
    for (const member of group) overlaysOn[member] = member === id
    updateOverlays()
  }

  // The column's switches and picks, from the same state the map is drawn from.
  // A resource field is reachable exactly when the ecology layer is, and checked
  // when it is the one being painted.
  function refreshOverlayList(): void {
    const ecologyAvailable = overlayAvailable.ecology()
    overlayList.refresh((id) => isOverlayId(id)
      ? { on: overlaysOn[id], available: overlayAvailable[id]() }
      : id === NO_PICK
        ? { on: !step(STEP_IDS[panelIndex]).exclusive.some((member) => overlaysOn[member]), available: true }
      // The PICK, not what a hover is showing: hovering a lever previews the
      // aggregate, and the mark would leave the resource you chose.
      : { on: overlaysOn.ecology && pickedEcologyField === id, available: ecologyAvailable })
  }
  // Called whenever overlay data appears/disappears (climate/hydrology computed
  // or invalidated, world re-rendered) so the column + layers stay in sync.
  function updateOverlays(): void {
    applyOverlays()
    refreshOverlayList()
    renderLegends()
    renderTemperatureScale(true)
  }

  // THE TEMPERATURE SCALE beside the map (2026-09-26): a strip between the
  // column and the map, coloured like the temperature wash with the
  // sea-level band of the latitude each screen row looks at — the band the
  // climate's own function gives (climate/temperature.ts), with the
  // greenhouse, the contrast and the planet's forcing as they stand, and
  // nothing of the terrain. A reading aid, not a field: it follows the
  // camera, since a row's latitude does, and stands in every step (decided
  // 2026-09-26). The pick is the plane pick above, per sampled row.
  // THE SCALE BAR at the map's lower right (2026-09-27): a bar of a round
  // length — 1, 2 or 5 × 10ⁿ km — sized to the metres a screen pixel spans
  // where the bar stands. The span is read from the map view's own ground
  // pick at two points a hundred pixels apart on the bar's row (the
  // torus's shorter way between them), so the bar is right at any zoom,
  // tilt and place, and says nothing while the ray misses the plane.
  // The ground for the two scales: the map's PLANE (y = 0), met by the
  // picking ray analytically — microseconds, where a mesh pick against the
  // fine relief and its wrapped copies cost milliseconds each and made a
  // slow pan stutter at high zoom (2026-09-27). For a latitude and for a
  // map scale the plane is the right reference anyway; the relief's
  // exaggeration is a view property.
  function pickPlane(screenX: number, screenY: number): { x: number; z: number } | null {
    const camera = scene.activeCamera
    if (!camera) return null
    const ray = scene.createPickingRay(screenX, screenY, Matrix.Identity(), camera)
    if (Math.abs(ray.direction.y) < 1e-6) return null
    const t = -ray.origin.y / ray.direction.y
    if (t <= 0) return null
    return { x: ray.origin.x + ray.direction.x * t, z: ray.origin.z + ray.direction.z * t }
  }
  const scaleBar = root.querySelector<HTMLElement>('[data-value="scale-bar"]')!
  const scaleBarLabel = root.querySelector<HTMLElement>('[data-value="scale-bar-label"]')!
  const scaleBarBar = root.querySelector<HTMLElement>('[data-value="scale-bar-bar"]')!
  const SCALE_BAR_PROBE_PX = 100
  const SCALE_BAR_MIN_PX = 70
  const SCALE_BAR_MAX_PX = 170
  const metresPerWorldUnit = (METERS_PER_CELL * MAP_WIDTH) / WORLD_WIDTH
  let scaleBarSeen = ''
  function renderScaleBar(): void {
    const focus = getCameraFocus()
    const key = `${focus.x.toFixed(1)},${focus.z.toFixed(1)},${getCameraZoom().toFixed(4)},${getCameraYaw().toFixed(3)},${window.innerWidth},${window.innerHeight}`
    if (key === scaleBarSeen) return
    scaleBarSeen = key
    const rect = scaleBar.getBoundingClientRect()
    const y = scaleBar.hidden ? window.innerHeight - 40 : rect.top + rect.height / 2
    const xRight = scaleBar.hidden ? window.innerWidth - 24 : rect.right - 8
    const a = pickPlane(xRight - SCALE_BAR_PROBE_PX, y)
    const b = pickPlane(xRight, y)
    if (!a || !b) { scaleBar.hidden = true; return }
    let dx = Math.abs(b.x - a.x) % WORLD_WIDTH
    if (dx > WORLD_WIDTH / 2) dx = WORLD_WIDTH - dx
    let dz = Math.abs(b.z - a.z) % WORLD_HEIGHT
    if (dz > WORLD_HEIGHT / 2) dz = WORLD_HEIGHT - dz
    const metresPerPx = (Math.hypot(dx, dz) * metresPerWorldUnit) / SCALE_BAR_PROBE_PX
    if (!(metresPerPx > 0)) { scaleBar.hidden = true; return }
    // The round length whose bar fits the band, the largest such.
    let lengthKm = 0
    for (let exp = 0; exp <= 5 && lengthKm === 0; exp++) {
      for (const m of [1, 2, 5]) {
        const km = m * 10 ** exp
        const px = (km * 1000) / metresPerPx
        if (px >= SCALE_BAR_MIN_PX && px <= SCALE_BAR_MAX_PX) { lengthKm = km; break }
        if (px > SCALE_BAR_MAX_PX) break
      }
    }
    if (lengthKm === 0) { scaleBar.hidden = true; return }
    scaleBar.hidden = false
    scaleBarBar.style.width = `${Math.round((lengthKm * 1000) / metresPerPx)}px`
    scaleBarLabel.textContent = `${lengthKm} ${t('common.unit.kilometres')}`
    scaleBar.setAttribute('aria-label', `${lengthKm} ${t('common.unit.kilometres')}`)
  }

  const tempScale = root.querySelector<HTMLCanvasElement>('[data-value="temp-scale"]')!
  tempScale.setAttribute('aria-label', t('overlay.temperature.scale'))
  const TEMP_SCALE_SAMPLES = 64
  let tempScaleSeen = ''
  function renderTemperatureScale(force = false): void {
    const focus = getCameraFocus()
    const key = `${focus.x.toFixed(1)},${focus.z.toFixed(1)},${getCameraZoom().toFixed(4)},${tempBandInput.value},${contrastInput.value},${obliquityInput.value},${tempScale.clientHeight}`
    if (!force && key === tempScaleSeen) return
    tempScaleSeen = key
    const params = weatherParams()
    const band = seaLevelTemperatureBand(params.temperatureOffset, params.temperatureContrast, params.planet)
    const rect = tempScale.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    if (tempScale.width !== w || tempScale.height !== h) { tempScale.width = w; tempScale.height = h }
    const c = tempScale.getContext('2d')
    if (!c) return
    c.clearRect(0, 0, w, h)
    const bandW = Math.round(10 * dpr)
    const pickX = rect.right + 2
    const values: (number | null)[] = []
    for (let i = 0; i <= TEMP_SCALE_SAMPLES; i++) {
      const screenY = rect.top + (rect.height * i) / TEMP_SCALE_SAMPLES
      const ground = pickPlane(pickX, screenY)
      if (!ground) { values.push(null); continue }
      // The map's plane is centred on the origin (ToroidalMapView places
      // the copies at centerZ ± worldHeight), so z = 0 is the equator and
      // the poles lie at ±H/2: half a turn from the row fraction.
      const v = (((ground.z / WORLD_HEIGHT + 0.5) % 1) + 1) % 1
      const row = Math.min(band.length - 1, Math.max(0, Math.floor(v * band.length)))
      values.push(band[row])
    }
    const step = h / TEMP_SCALE_SAMPLES
    for (let i = 0; i < TEMP_SCALE_SAMPLES; i++) {
      const v = values[i]
      if (v === null) continue
      const [r, g, b] = temperatureColor(v)
      c.fillStyle = `rgb(${r},${g},${b})`
      c.fillRect(0, Math.floor(i * step), bandW, Math.ceil(step) + 1)
    }
    // Ticks where the band crosses a multiple of 10 °C between two samples.
    c.fillStyle = 'rgba(31, 35, 40, 0.85)'
    c.font = `${Math.round(9 * dpr)}px 'IBM Plex Sans', system-ui, sans-serif`
    c.textBaseline = 'middle'
    for (let i = 0; i < TEMP_SCALE_SAMPLES; i++) {
      const a = values[i]
      const b = values[i + 1]
      if (a === null || b === null) continue
      const lo = Math.ceil(Math.min(a, b) / 10) * 10
      if (lo > Math.max(a, b) || lo === Math.min(a, b)) continue
      const y = Math.round(step * (i + (lo - a) / (b - a || 1)))
      c.fillRect(bandW, y, Math.round(4 * dpr), 1)
      c.fillText(String(lo), bandW + Math.round(6 * dpr), y)
    }
  }

  function toggleOverlay(id: OverlayId): void {
    if (!overlayAvailable[id]()) return
    overlaysOn[id] = !overlaysOn[id]
    updateOverlays()
  }

  // Expand the worker's packed relief bytes into the RGBA "paper" bases —
  // shared rendering with the worldmap screen, see map/paperBase.ts.
  function buildSimplifiedBase(): Uint8ClampedArray | null {
    if (!lastRelief) return null
    if (!simplifiedBaseCache) simplifiedBaseCache = buildPaperBase(lastRelief)
    return simplifiedBaseCache
  }

  // The paper WITHOUT the hillshade modulation — the base for the relief
  // compositor, whose meshes are lit for real (see
  // ToroidalMapView.reliefTexture).
  let unshadedBaseCache: Uint8ClampedArray | null = null
  function buildUnshadedBase(): Uint8ClampedArray | null {
    if (!lastRelief) return null
    if (!unshadedBaseCache) unshadedBaseCache = buildUnshadedPaperBase(lastRelief)
    return unshadedBaseCache
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
  // source for the muted terrain wash. Does not composite. The relief
  // compositor's unshaded paper is only worth building once eroded terrain
  // exists (before that its output is never shown).
  function applyBase(): void {
    const base = buildSimplifiedBase()
    if (base) overlay.setBase(base)
    if (erosionRunCount >= 1) {
      const unshaded = buildUnshadedBase()
      if (unshaded) reliefOverlay.setBase(unshaded)
    }
  }

  // A field vector as a bearing on the SCREEN, in degrees, clockwise from up.
  //
  // The readout draws the arrow and no letters. This world is a flat torus: it
  // has no poles (the top and bottom edges are one glued seam — climateField.ts)
  // and no meridian, so "north-east" is a word borrowed from a sphere and is not
  // a fact about anything here. The arrow says all that is true — which way the
  // air or the water goes across the map you are looking at.
  //
  // Hence the screen, not the raster, is the frame of reference. The raster the
  // map wears reaches the screen MIRRORED VERTICALLY: +y in the raster is UP on
  // screen, which is why the volcano cones draw their apex at +y to point up
  // (drawVolcanoes). A layer painted into the raster is mirrored with it and
  // stays consistent; this arrow is drawn in the page, outside that mirror, so
  // it is put into the screen's frame here. That is not a correction of the
  // picture — the picture IS the world as it is seen.
  //
  // So: u is eastward (+x) and reaches the screen as it is, while UP on screen
  // is +v, not −v. atan2(u, v), with no further turn. Getting this wrong is not
  // subtle to look at but it is easy to reason wrong about, so the check is in
  // the arrow beside the map's own wind arrows: they must agree.
  //
  // Null where the vector is too short to point anywhere — a calm belt has no
  // direction, and the row is left out rather than given a dash.
  function bearing(u: number, v: number): number | null {
    if (Math.hypot(u, v) < 1e-4) return null
    const angle = Math.atan2(u, v) // 0 = up on screen, increasing clockwise
    return ((((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * 180) / Math.PI
  }

  // ── The hover readout ──────────────────────────────────────────────────────
  //
  // WHAT a cell reports is decided by the STEP, not by which layers happen to be
  // switched on. The readout used to append one line per active overlay, so the
  // same point answered differently depending on the switch column — yet a point
  // has its values whatever is painted over it. One row list per step; a step
  // with nothing to add returns none and the card is the height line alone.
  //
  // EVERY ENTRY IS A FUNCTION, for the two reasons the legend table gives right
  // above: t() must run at hover time, because the generator is the one screen
  // that does not rebuild on a language switch, and the rows read live data.

  // The hovered cell, resolved once per hover into every grid the rows need.
  // `i` indexes the climate/ecology grid, `fine` the full-resolution rasters.
  interface ProbeCell {
    i: number
    gx: number
    gy: number
    fine: number
    land: boolean
    metres: number
  }

  const rowsForStep: Record<StepId, (cell: ProbeCell) => ProbeRow[]> = {
    // Step 0 is about which world, not about what is on the map.
    world: () => [],
    // The planet acts through the stages after it; nothing of its own to probe.
    planet: () => [],
    genesis: (cell) => {
      const rows: ProbeRow[] = []
      if (lastMantle && mantleResX > 0) {
        // The buoyancy field has no unit a reader could check — what it says is
        // which way the mantle moves and how strongly, so it is reported as the
        // normalised ±1 the tint is drawn from rather than as a bare number.
        const mi = mantleCellOf(cell)
        const v = mantleNorm ? mantleNorm[mi] : lastMantle[mi]
        const strength = Math.abs(v).toFixed(2)
        rows.push({ label: t('readout.row.mantle'), value: v >= 0 ? t('readout.mantle.up', { v: strength }) : t('readout.mantle.down', { v: strength }) })
      }
      const age = cratonAgeAt(cell)
      if (age !== null) rows.push({ label: t('readout.row.crustAge'), value: t('readout.crustAge', { v: String(Math.round(age * 100)) }) })
      return rows
    },
    tectonics: (cell) => {
      const rows: ProbeRow[] = []
      if (lastBoundaryMask) {
        const bi = Math.min(lastBoundaryMask.length - 1, cell.fine)
        rows.push({ label: t('readout.row.boundary'), value: lastBoundaryMask[bi] ? t('readout.boundary.yes') : t('readout.boundary.no') })
      }
      const age = cratonAgeAt(cell)
      if (age !== null) rows.push({ label: t('readout.row.crustAge'), value: t('readout.crustAge', { v: String(Math.round(age * 100)) }) })
      return rows
    },
    climate: (cell) => {
      const rows: ProbeRow[] = []
      if (lastTemperature) rows.push({ label: t('readout.row.temperature'), value: t('readout.temperature', { v: String(Math.round(lastTemperature[cell.i])) }) })
      if (lastSeasonality && lastSeasonality[cell.i] !== OCEAN_AMPLITUDE) {
        // The field is the full peak-to-peak swing (seasonalTemperature adds
        // ±half of it), so the ± figure is half the field.
        rows.push({ label: t('readout.row.season'), value: t('readout.seasonSwing', { v: (lastSeasonality[cell.i] / 2).toFixed(1) }) })
      }
      if (lastPrecipitation && lastPrecipitation[cell.i] !== OCEAN_PRECIP) {
        rows.push({ label: t('readout.row.precipitation'), value: t('readout.precipitation', { v: String(Math.round(lastPrecipitation[cell.i])) }) })
      }
      if (lastMonsoonIndex && lastMonsoonIndex[cell.i] !== OCEAN_PRECIP) {
        // The magnitude. The sign is the phase, and the chart below draws that
        // far better than a minus sign in front of a number would.
        rows.push({ label: t('readout.row.monsoon'), value: Math.abs(lastMonsoonIndex[cell.i]).toFixed(2) })
      }
      if (lastWind) {
        const u = lastWind[cell.i * 2]
        const v = lastWind[cell.i * 2 + 1]
        const b = bearing(u, v)
        // The raw magnitude is a relative one, so it goes out through the m/s
        // anchor rather than as itself (CLIMATE_TUNING.windSpeedMsPerUnit). The
        // band pattern tapers to zero at each cell edge (climate/wind.ts), so a
        // calm belt reads 0.0 m/s and loses its arrow, which is the truth.
        const speed = Math.hypot(u, v) * CLIMATE_TUNING.windSpeedMsPerUnit
        rows.push({ label: t('readout.row.wind'), value: t('readout.metresPerSecond', { v: speed.toFixed(1) }), bearing: b ?? undefined })
      }
      if (lastCurrents && !cell.land) {
        const u = lastCurrents[cell.i * 2]
        const v = lastCurrents[cell.i * 2 + 1]
        const b = bearing(u, v)
        if (b !== null && Math.hypot(u, v) > 0.02) {
          const warm = v * (cell.gy + 0.5 - climateResY / 2) > 0 // poleward = warm (see drawCurrents)
          rows.push({ label: t('readout.row.current'), value: warm ? t('readout.current.warm') : t('readout.current.cold'), bearing: b })
        }
      }
      if (lastBiomes) rows.push({ label: t('readout.row.biome'), value: t(biomeLabelKey(lastBiomes[cell.fine]) as TKey) })
      return rows
    },
    erosion: (cell) => {
      const rows: ProbeRow[] = []
      if (lastDischargeField && lastMaxDischarge > 0 && lastDischargeField[cell.fine] / lastMaxDischarge >= 0.01) {
        // Below 1% of the largest stream this is distributed rain, not a
        // channel, and naming a flow there would invent a river.
        // Grouped thousands once a river is big enough to need them, one
        // decimal while it is small enough for one to mean something.
        const m3s = lastDischargeField[cell.fine] * DISCHARGE_TO_M3S
        const flow = m3s >= 100 ? Math.round(m3s).toLocaleString(getLocale()) : m3s.toFixed(1)
        rows.push({ label: t('readout.row.discharge'), value: t('readout.cubicMetresPerSecond', { v: flow }) })
      }
      if (lastLakeDepth && lastLakeDepth[cell.fine] > 0) {
        rows.push({ label: t('readout.row.lakeDepth'), value: t('readout.metres', { v: String(Math.round(elevationToMeters(lastLakeDepth[cell.fine]) - elevationToMeters(0))) }) })
      }
      if (lastPrecipitationEffective && lastPrecipitationEffective[cell.i] !== OCEAN_PRECIP) {
        rows.push({ label: t('readout.row.effectivePrecip'), value: t('readout.precipitation', { v: String(Math.round(lastPrecipitationEffective[cell.i])) }) })
      }
      return rows
    },
    ecology: (cell) => {
      const rows: ProbeRow[] = []
      if (lastBiomes) rows.push({ label: t('readout.row.biome'), value: t(biomeLabelKey(lastBiomes[cell.fine]) as TKey) })
      // The picked field, which is the one the map is painting — the others are
      // a column of numbers nobody asked for.
      const field = lastEcologyFields[selectedEcologyField]
      if (field && ecologyResX > 0) {
        const ex = Math.min(ecologyResX - 1, Math.floor((cell.gx / Math.max(1, climateResX)) * ecologyResX))
        const ey = Math.min(ecologyResY - 1, Math.floor((cell.gy / Math.max(1, climateResY)) * ecologyResY))
        const v = field[ey * ecologyResX + ex]
        if (v !== ECOLOGY_OCEAN) {
          rows.push({ label: t(`resource.${selectedEcologyField}.label` as TKey), value: t('readout.percent', { v: String(Math.round(v * 100)) }) })
        }
      }
      return rows
    },
    // Migration leaves the generator for a screen of its own; it keeps the
    // height line until it does.
    migration: () => [],
  }

  // Craton age 0..1 (1 = formed at epoch 0) on the mantle grid, or null where
  // there is no crust — the field marks ocean with -1.
  function cratonAgeAt(cell: ProbeCell): number | null {
    if (!lastCratonAge || mantleResX === 0) return null
    const v = lastCratonAge[mantleCellOf(cell)]
    return v >= 0 ? v : null
  }

  function mantleCellOf(cell: ProbeCell): number {
    const mx = Math.min(mantleResX - 1, Math.floor((cell.gx / Math.max(1, climateResX || mantleResX)) * mantleResX))
    const my = Math.min(mantleResY - 1, Math.floor((cell.gy / Math.max(1, climateResY || mantleResY)) * mantleResY))
    return my * mantleResX + mx
  }

  // Twelve months of temperature. This adds NOTHING to the model: the climate is
  // an annual mean plus a seasonal amplitude (climate/seasonality.ts), which IS
  // a sinusoid over the year — this draws the curve that was already computed.
  // The top of the map is the northern hemisphere (see shiftedYNorm), warmest in
  // July; the southern half runs the opposite way.
  function temperatureYear(cell: ProbeCell): number[] | null {
    if (!lastTemperature || !lastSeasonality) return null
    const amp = lastSeasonality[cell.i]
    if (amp === OCEAN_AMPLITUDE) return null
    const mean = lastTemperature[cell.i]
    const north = shiftedYNorm(cell.gy, climateResY, 0) < 0.5
    const sign = north ? 1 : -1
    // Index 6 = July, the northern peak; cos is 1 there.
    return Array.from({ length: 12 }, (_, m) => mean + sign * (amp / 2) * Math.cos(((m - 6) / 12) * 2 * Math.PI))
  }

  // Twelve months of rainfall, and the whole year is now the model's own. The
  // heights follow from the two numbers the worker ships, because the monsoon
  // index is (precipN − precipS) / (precipN + precipS + floor) and the annual
  // field is their mean (climate/monsoon.ts). The PHASE follows from that index's
  // SIGN, which is why the hemisphere does not appear here: a positive index
  // means the rain falls while the top hemisphere is in summer, wherever the cell
  // lies. Until the index was signed this had to assume the wet season was the
  // local summer — right for the tropics, half a year wrong for a Mediterranean
  // winter-rain climate.
  function precipitationYear(cell: ProbeCell): number[] | null {
    if (!lastPrecipitation || !lastMonsoonIndex) return null
    const annual = lastPrecipitation[cell.i]
    const index = lastMonsoonIndex[cell.i]
    if (annual === OCEAN_PRECIP || index === OCEAN_PRECIP) return null
    // Half the difference between the two seasons, signed like the index.
    const half = (index * (2 * annual + CLIMATE_TUNING.monsoonSeasonalityFloor)) / 2
    return Array.from({ length: 12 }, (_, m) => {
      // Index 6 = July, the top hemisphere's summer, where cos is 1.
      const northSummer = Math.cos(((m - 6) / 12) * 2 * Math.PI)
      return Math.max(0, (annual + half * northSummer) / 12)
    })
  }

  // Build the card for the cell under the cursor. Null when the map has not even
  // an elevation to report, which is only true before the first render.
  // mapX/mapY are full-res texels.
  function describeCell(mapX: number, mapY: number): HTMLElement | null {
    if (!lastCoarseElevation) return null
    const ex = Math.min(elevationResX - 1, Math.floor((mapX / MAP_WIDTH) * elevationResX))
    const ey = Math.min(elevationResY - 1, Math.floor((mapY / MAP_HEIGHT) * elevationResY))
    const metres = Math.round(elevationToMeters(lastCoarseElevation[ey * elevationResX + ex]))
    const fine = Math.min(MAP_HEIGHT - 1, Math.floor(mapY)) * MAP_WIDTH + Math.min(MAP_WIDTH - 1, Math.floor(mapX))
    const cell: ProbeCell = {
      gx: climateResX > 0 ? Math.min(climateResX - 1, Math.floor((mapX / MAP_WIDTH) * climateResX)) : 0,
      gy: climateResY > 0 ? Math.min(climateResY - 1, Math.floor((mapY / MAP_HEIGHT) * climateResY)) : 0,
      i: 0,
      fine,
      land: metres >= 0,
      metres,
    }
    cell.i = cell.gy * climateResX + cell.gx

    const stepId = STEP_IDS[panelIndex]
    const charts: ProbeChart[] = []
    // The charts belong to the Climate step: they are the two fields it computes,
    // and elsewhere they would be a year drawn beside rows about the mantle.
    if (stepId === 'climate') {
      const temp = temperatureYear(cell)
      if (temp) charts.push({ label: t('readout.chart.temperature'), kind: 'line', values: temp })
      const prec = precipitationYear(cell)
      if (prec) charts.push({ label: t('readout.chart.precipitation'), kind: 'bars', values: prec })
    }

    return buildProbeCard({
      heading: metres >= 0 ? t('readout.metres', { v: String(metres) }) : t('readout.metresDeep', { v: String(-metres) }),
      kind: cell.land ? t('readout.kind.land') : t('readout.kind.ocean'),
      land: cell.land,
      rows: climateResX > 0 || stepId === 'genesis' || stepId === 'tectonics' ? rowsForStep[stepId](cell) : [],
      months: t('readout.months').split(','),
      charts,
    })
  }

  // THE PLANET PREVIEW (planet/sampleWorld.ts): while the Planet step is
  // open and the world has no plates yet, the map shows the sample world
  // with the climate the controls make on it. The real base is kept aside
  // and put back on leaving; the climate fields are the preview's for as
  // long as it stands and are cleared with it, so nothing downstream ever
  // sees them as the world's climate.
  let planetPreviewShown = false
  let planetPreviewRealBase: { base: Uint8ClampedArray; relief: Uint8Array } | null = null
  let planetPreviewDebounce: ReturnType<typeof setTimeout> | undefined
  function requestPlanetPreview(): void {
    postToWorker({ type: 'planetPreview', width: MAP_WIDTH, height: MAP_HEIGHT, weather: weatherParams() })
  }
  // A Planet control moved: the world's own climate when it has plates to
  // compute one on, the sample world's otherwise.
  function requestPlanetForcing(): void {
    if (archeanFinalised || hasHandover) {
      if (tectonicsRunning) return
      requestClimate()
      return
    }
    clearTimeout(planetPreviewDebounce)
    planetPreviewDebounce = setTimeout(requestPlanetPreview, 150)
  }
  function handlePlanetPreviewData(message: WorkerPlanetPreviewDataMessage): void {
    if (STEP_IDS[panelIndex] !== 'planet') return // left the step while it computed
    if (!planetPreviewShown) {
      planetPreviewShown = true
      planetPreviewRealBase = lastColoredBase && lastRelief ? { base: lastColoredBase, relief: lastRelief } : null
    }
    lastColoredBase = new Uint8ClampedArray(message.buffer)
    lastRelief = new Uint8Array(message.relief)
    simplifiedBaseCache = null
    unshadedBaseCache = null
    terrainTintCache = null
    applyBase()
    lastTemperature = new Float32Array(message.temperature)
    lastWind = new Float32Array(message.wind)
    lastCurrents = new Float32Array(message.currents)
    lastPrecipitation = new Float32Array(message.precipitation)
    lastSeasonality = new Float32Array(message.seasonalAmplitude)
    lastMonsoonIndex = new Float32Array(message.monsoonIndex)
    lastBiomes = new Uint8Array(message.biomes)
    climateResX = message.resX
    climateResY = message.resY
    updateOverlays()
  }
  function leavePlanetPreview(): void {
    if (!planetPreviewShown) return
    planetPreviewShown = false
    if (planetPreviewRealBase) {
      lastColoredBase = planetPreviewRealBase.base
      lastRelief = planetPreviewRealBase.relief
      simplifiedBaseCache = null
      unshadedBaseCache = null
      terrainTintCache = null
      applyBase()
    }
    planetPreviewRealBase = null
    clearClimate()
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
    // A fresh climate stales the rivers and the ecology that were derived from
    // the previous one. Retuning a climate slider used to leave both standing,
    // so the ecology overlay went on showing values computed from a climate that
    // no longer existed. The hydrology's own refinement is exempt: it carries
    // `refinement`, and the pass that sent it is recomputing that work itself.
    if (!message.refinement) invalidateAfter('climate')
    climateResolve?.()
    climateResolve = null
  }

  // Invalidate the (now stale) climate when an upstream step changes the
  // topography — the rasters no longer match. Recomputed on the next climate-
  // panel open.
  // WHAT A CHANGE STALES, from the one declaration both sides read.
  //
  // This cascade used to be written out here (invalidateClimate called hydrology
  // and ecology, ecology called migration) AND again in the worker — two copies of
  // one rule, which had already drifted apart: this side dropped the climate on
  // every topography change while the worker kept it, so the two disagreed about
  // what the world currently was. Both now derive it from generator/pipeline/stages.ts.
  //
  // Exhaustive over StageId, so a stage added to the table is a compile error here
  // rather than a mirror nobody remembered to clear.
  // A stage was asked to run and could not. Release whatever was waiting for it:
  // the in-flight flag that disabled the controls, and any promise the save chain
  // is holding. Before this existed the worker simply returned, so the spinner ran
  // for ever and a save begun in that state never finished — silently, because
  // nothing had gone wrong loudly.
  function handleStageDeclined(message: WorkerStageDeclinedMessage): void {
    switch (message.stage) {
      case 'erosion':
        // No run of its own since phase 5.1; nothing was waiting.
        break
      case 'climate':
        climateInFlight = false
        climateStatus.textContent = ''
        climateResolve?.()
        climateResolve = null
        break
      case 'hydrology':
        hydrologyInFlight = false
        hydrologyResolve?.()
        hydrologyResolve = null
        break
      case 'ecology':
        ecologyInFlight = false
        ecologyResolve?.()
        ecologyResolve = null
        break
      case 'migration':
        migrationInFlight = false
        break
      default:
        break
    }
    updateControlsDisabled()
    updateProgress()
  }

  function clearStage(id: StageId): void {
    switch (id) {
      case 'planet':
      case 'genesis':
      case 'tectonics':
      case 'erosion':
        // No mirror of their own on this side — the map IS their output, and it is
        // replaced by the next render rather than cleared.
        return
      case 'climate':
        clearClimate()
        return
      case 'hydrology':
        clearHydrology()
        return
      case 'ecology':
        clearEcology()
        return
      case 'migration':
        clearMigration()
        return
    }
  }

  // `id` produced something new, so everything reading it is stale. Not `id`'s own
  // mirror — the caller says whether that survives.
  function invalidateAfter(id: StageId): void {
    for (const downstream of downstreamOf(id)) clearStage(downstream)
  }

  // Clears ONE stage's mirrors. The cascade is not here any more — it comes from
  // the declared chain, via invalidateAfter below.
  function clearClimate(): void {
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
    updateOverlays() // climate overlays no longer available
  }

  function handleHydrologyData(message: WorkerHydrologyDataMessage): void {
    lastRiverData = { points: new Float32Array(message.riverPoints), lengths: new Uint32Array(message.riverLengths), regimes: new Uint8Array(message.riverRegimes) }
    drawRivers()
    // Lakes only arrive on a re-route (empty buffer = unchanged, keep the last).
    if (message.lakeDepth.byteLength > 0) lastLakeDepth = new Float32Array(message.lakeDepth)
    if (message.waterTable.byteLength > 0) lastWaterTable = new Float32Array(message.waterTable)
    if (message.waterBodies) lastWaterBodies = message.waterBodies
    if (message.waterLevel.byteLength > 0) lastWaterLevel = new Float32Array(message.waterLevel)
    if (message.waterSurface.byteLength > 0) lastWaterSurface = new Uint8Array(message.waterSurface)
    if (message.coastType.byteLength > 0) lastCoastType = new Uint8Array(message.coastType)
    if (message.coast) lastCoast = { reaches: message.coast.reaches, cells: new Int32Array(message.coast.cells) }
    if (message.sedimentBasins) lastSedimentBasins = message.sedimentBasins
    if (lastWaterLevel && lastWaterSurface) mapView.setWaterLevels(lastWaterLevel, lastWaterSurface, lastCoastType)
    if (message.watersheds.byteLength > 0) lastWatersheds = new Uint16Array(message.watersheds)
    if (message.discharge.byteLength > 0) lastDischargeField = new Float32Array(message.discharge)
    if (message.maxDischarge > 0) lastMaxDischarge = message.maxDischarge
    // Riparian-refined biomes replace the climate step's water-free ones, and
    // the precipitation they came from rides along for the save.
    if (message.biomes.byteLength > 0) lastBiomes = new Uint8Array(message.biomes)
    if (message.precipitationEffective.byteLength > 0) lastPrecipitationEffective = new Float32Array(message.precipitationEffective)
    hydrologyInFlight = false
    updateControlsDisabled()
    updateProgress()
    updateOverlays() // rivers/lakes + refreshed biomes now available
    hydrologyResolve?.()
    hydrologyResolve = null
    // On the Ecology panel, fish (freshwater) depends on this hydrology, so
    // (re)compute the ecology fields now that rivers/lakes are fresh. Skipped
    // during a save (the save flow drives the compute chain itself).
    if (panelIndex === ECOLOGY_PANEL_INDEX && !saveChainActive) requestEcology()
  }

  function clearHydrology(): void {
    lastRiverData = null
    // A baked network describes ONE elevation raster. Erode again and its
    // channels sit beside the valleys they were cut for — worse than showing
    // nothing, because it looks authoritative.
    bakedRiverDisplay = null
    lastLakeDepth = null
    lastWaterTable = null
    lastWaterBodies = null
    lastWaterLevel = null
    lastWaterSurface = null
    lastCoastType = null
    lastCoast = null
    lastSedimentBasins = null
    mapView.setWaterLevels(null, null)
    // Derived from the channel set, so it stales with it.
    lastPrecipitationEffective = null
    riverLayer?.setPolylines(new Float32Array(0), new Uint32Array(0))
    riverLayer?.setEnabled(false)
    compositeOverlays()
  }

  // Posts a hydrology compute. Needs a computed climate (the worker caches its
  // precipitation as the river water source); every caller posts climateRun
  // first when it is missing — the worker's mailbox is ordered, so the pair
  // arrives in pipeline order. Self-guards a running sim.
  function requestHydrology(): void {
    if (tectonicsRunning) return
    hydrologyInFlight = true
    updateControlsDisabled()
    updateProgress()
    postToWorker({ type: 'hydrologyRun' })
  }

  // The climate panel's sliders in MODEL units — one reading shared by the
  // climate compute and (since the stage-2 coupling) the erosion request,
  // whose water forcing evaluates the same weather chain with them.
  const weatherParams = () => ({
    temperatureOffset: Number(tempBandInput.value),
    temperatureContrast: Number(contrastInput.value) / 100,
    humidity: Number(humidityInput.value) / 100,
    // The thermal equator sits at the map's middle since 2026-09-26 (the
    // shift slider is gone; the map draws the equator instead).
    equatorOffset: 0,
    // The Planet stage's forcing, in model units (planet/planetForcing.ts).
    planet: {
      obliquityDeg: Number(obliquityInput.value),
      eccentricity: DEFAULT_PLANET_FORCING.eccentricity,
      precessionDeg: DEFAULT_PLANET_FORCING.precessionDeg,
      solarConstant: DEFAULT_PLANET_FORCING.solarConstant,
      landPlantsFromMa: DEFAULT_PLANET_FORCING.landPlantsFromMa,
      rotationHours: Number(rotationInput.value),
    },
  })

  // Posts a climate compute with the current band-slider offset. Fired on
  // opening the climate panel and by the slider (debounced) for live re-tuning.
  function requestClimate(): void {
    if (tectonicsRunning) return
    climateStatus.textContent = '…'
    climateInFlight = true
    updateControlsDisabled()
    updateProgress()
    postToWorker({ type: 'climateRun', ...weatherParams() })
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
    ecologyResolve?.()
    ecologyResolve = null
  }

  function clearEcology(): void {
    lastEcologyFields = {}
    updateOverlays()
  }

  // --- initial migration ---

  function clearMigration(): void {
    lastMigration = null
    migrationMaxDensity = 0
    migrationMaxFlow = 0
    updateOverlays()
  }

  // Greedily pick one origin per race at the highest-carrying-capacity land cells,
  // spaced apart (torus distance) so the races don't start on top of each other.
  function autoPlaceMigrationOrigins(): void {
    const cc = lastEcologyFields.carryingCapacity
    if (!cc) return
    const rx = ecologyResX
    const ry = ecologyResY
    const minDistSq = (rx * 0.22) * (rx * 0.22)
    const excluded = new Uint8Array(rx * ry)
    const chosen: number[] = []
    for (let k = 0; k < MIGRATION_RACES.length; k++) {
      let best = -1
      let bestV = -Infinity
      for (let i = 0; i < cc.length; i++) {
        if (cc[i] === ECOLOGY_OCEAN || excluded[i]) continue
        if (cc[i] > bestV) { bestV = cc[i]; best = i }
      }
      if (best < 0) break
      chosen.push(best)
      const by = Math.floor(best / rx)
      const bx = best - by * rx
      for (let i = 0; i < cc.length; i++) {
        const gy = Math.floor(i / rx)
        const gx = i - gy * rx
        const dx = Math.min(Math.abs(gx - bx), rx - Math.abs(gx - bx))
        const dy = Math.min(Math.abs(gy - by), ry - Math.abs(gy - by))
        if (dx * dx + dy * dy < minDistSq) excluded[i] = 1
      }
    }
    migrationOrigins = chosen.map((cell, race) => ({ cell, race }))
  }

  function handleMigrationData(message: WorkerMigrationDataMessage): void {
    lastMigration = {
      race: new Int8Array(message.race),
      density: new Float32Array(message.density),
      flow: new Float32Array(message.flow),
      predecessor: new Int32Array(message.predecessor),
      resX: message.resX,
      resY: message.resY,
    }
    let maxD = 0
    for (const v of lastMigration.density) if (v > maxD) maxD = v
    migrationMaxDensity = maxD
    let maxF = 0
    for (const v of lastMigration.flow) if (v > maxF) maxF = v
    migrationMaxFlow = maxF
    migrationInFlight = false
    updateControlsDisabled()
    updateProgress()
    updateOverlays()
  }

  // Posts a migration compute with the enabled races' origins + the sliders. Needs
  // ecology (carrying capacity, cached in the worker) — the panel ensures it first.
  function requestMigration(): void {
    if (tectonicsRunning || !hasEcologyData() || migrationOrigins.length === 0) return
    const origins = migrationOrigins.filter((o) => migrationRaceEnabled[o.race])
    if (origins.length === 0) { clearMigration(); return } // all races off → nothing
    migrationInFlight = true
    updateControlsDisabled()
    updateProgress()
    postToWorker({ type: 'migrationRun', origins, spreadBudget: Number(migrationSpreadInput.value), seaCrossing: MIGRATION_INPUTS.seaCrossing.toModel(Number(migrationSeaInput.value)) })
  }

  // Ensures the upstream chain (climate → hydrology → ecology) is computed, then
  // auto-places origins (first time) and computes migration. Runs on panel open;
  // no panel switch (the computes are worker-side).
  async function ensureMigration(): Promise<void> {
    if (tectonicsRunning || erosionRunCount < 1) return
    if (lastTemperature === null) await awaitCompute((r) => { climateResolve = r }, requestClimate)
    if (lastRiverData === null) await awaitCompute((r) => { hydrologyResolve = r }, requestHydrology)
    if (!hasEcologyData()) await awaitCompute((r) => { ecologyResolve = r }, requestEcology)
    if (migrationOrigins.length === 0) autoPlaceMigrationOrigins()
    requestMigration()
  }

  // Posts an ecology compute with the current top-slider values. Needs a computed
  // climate (its cached temperature+precipitation feed productivity); the ecology
  // panel ensures that first. Self-guards a running sim.
  function requestEcology(): void {
    // Needs a computed climate (the worker no-ops without it, which would leave
    // ecologyInFlight stuck). Hydrology is optional (fish falls back to marine).
    if (tectonicsRunning || lastTemperature === null) return
    ecologyInFlight = true
    updateControlsDisabled()
    updateProgress()
    const w = (f: EcologyFieldId): number => (abundance.get(f) ?? ECOLOGY_ABUNDANCE.default) / 100
    postToWorker({
      type: 'ecologyRun',
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

  worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
    const message = event.data

    if (message.type === 'elevationField') {
      // Canonical surfaces shared between the displaced map plane and the
      // draped river ribbons, so they agree everywhere by construction (see
      // elevationSurface.ts). With a MESH (phase 4.4: an eroded or restored
      // world) both levels and the ribbons read the mesh itself through
      // map/meshSurface — its gradient lights the relief with ridges the
      // grid's vertices cannot hold. Without one (the tectonic preview),
      // the decimated raster drives the half-res mesh and the full raster
      // the fine mesh, as before.
      if (message.mesh) {
        const decoded = decodeMesh(torusDomain(message.width, message.height), { count: message.mesh.count, nodes: new Float32Array(message.mesh.nodes), connectivity: new Uint8Array(message.mesh.connectivity) })
        const surface = createMeshSurface(createMeshSampler(decoded, new Float32Array(message.mesh.z)), RELIEF_HEIGHT_SCALE)
        reliefCoarseSurface = surface
        reliefFineSurface = surface
      } else {
        const full = new Float32Array(message.elevation)
        const decimated = downsampleElevation(full, message.width, message.height, RELIEF_DECIMATION)
        reliefCoarseSurface = createElevationSurface(decimated.data, decimated.resX, decimated.resY, RELIEF_HEIGHT_SCALE)
        reliefFineSurface = createElevationSurface(full, message.width, message.height, RELIEF_HEIGHT_SCALE)
      }
      mapView.setReliefSurfaces(reliefCoarseSurface, reliefFineSurface)
      // The shores are found on the PHYSICAL raster at draw time — the one
      // the hydrology set its levels against, not the display copy.
      mapView.setWaterElevation(new Float32Array(message.raw), message.width, message.height)
      // The surfaces are metre-true now; exaggeration is a view property
      // (see mapSceneSettings). This screen is a map register throughout —
      // and the ribbons must carry the same scale as the ground they drape
      // on, or they sink inside it (see ToroidalRibbonOverlay.setHeightScale).
      mapView.setHeightScale(MAP_EXAGGERATION)
      riverLayer?.setHeightScale(MAP_EXAGGERATION)
      riverLayer?.setHeightSurface(ribbonLevel === 'fine' ? reliefFineSurface : reliefCoarseSurface)
      return
    }

    if (message.type === 'genesisStatus') {
      handleGenesisStatus(message)
      return
    }

    if (message.type === 'stageDeclined') {
      handleStageDeclined(message)
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
    if (message.type === 'planetPreviewData') {
      handlePlanetPreviewData(message)
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

    if (message.type === 'migrationData') {
      handleMigrationData(message)
      return
    }

    // Retain the overlay source data + feed the base raster to the compositor
    // so a toggle can re-composite without a worker round-trip, then draw the
    // current layer set.
    // A render arriving while the Planet preview stands (the world being
    // made or remade under it — the water control regenerates the Archean)
    // is the truth the preview is keeping aside: it goes into the stash and
    // the sample world stays on the map until the step is left. Everything
    // else the render carries (mantle, ages, counters) is taken as always.
    const underPreview = planetPreviewShown && STEP_IDS[panelIndex] === 'planet'
    if (planetPreviewShown && !underPreview) {
      planetPreviewShown = false
      planetPreviewRealBase = null
      clearClimate()
    }
    lastBoundaryMask = new Uint8Array(message.boundaryMask)
    lastRaftLabels = message.raftLabels
    if (underPreview) {
      planetPreviewRealBase = { base: new Uint8ClampedArray(message.buffer), relief: new Uint8Array(message.relief) }
    } else {
      lastColoredBase = new Uint8ClampedArray(message.buffer)
      lastRelief = new Uint8Array(message.relief)
    }
    lastMantle = new Float32Array(message.mantle)
    mantleNorm = mantleTintNorm(lastMantle)
    lastCratonAge = new Float32Array(message.cratonAge)
    mantleResX = message.mantleResX
    mantleResY = message.mantleResY
    lastCoarseElevation = new Float32Array(message.elevation)
    elevationResX = message.elevationResX
    elevationResY = message.elevationResY
    lastHotspots = message.hotspots
    lastVolcanoes = message.volcanoes
    simplifiedBaseCache = null // rebuilt lazily from the fresh relief
    unshadedBaseCache = null
    terrainTintCache = null // rebuilt lazily from the fresh colour render
    applyBase()
    handleSimEvents(message.events)
    // Applies the current overlay states over the fresh base + syncs the column
    // (boundaries/names data now exists → their rows become available).
    updateOverlays()

    lastLandFraction = message.landFraction
    // Every epoch erodes (phase 5.1): an epoch render while the plates run is
    // one eroding epoch more on this world. Counted here, off the render that
    // reports it, rather than at the start gesture — the count is what the
    // relief, the bake and the panels past erosion gate on, and it must say
    // what the map shows.
    if (tectonicsRunning && message.epoch > lastEpoch) erosionRunCount += 1
    lastEpoch = message.epoch
    lastPlateCount = message.plateCount
    lastContinentCount = message.raftLabels.length
    updateStats()
    updateProgress()
    updateNavState() // epoch progress may unlock the Erosion panel
    // The counters this render just reported are what the baseline is made of, so
    // a load or a regenerate takes its reading here rather than before the round
    // trip, when lastEpoch still belonged to the previous world.
    if (markCleanOnNextRender) {
      markCleanOnNextRender = false
      markWorldEstablished()
    } else {
      updateSaveIndicator()
    }

    // Catch the derived stages up with the world that just arrived. Gated
    // exactly as the steps are: a save taken before the tectonic minimum has no
    // climate to restate, and one taken before erosion no ecology.
    //
    // The chain is driven here rather than left to ensureDataFor, which is the
    // PANEL's version of this and stops short on purpose: hydrology only
    // continues into ecology while the ecology panel is the one on screen (see
    // handleHydrologyData), and after a load it is not. This is the same
    // sequence compute-on-save runs, for the same reason — the stages are
    // ordered, and each needs the one before it to have landed.
    if (restoredFromSave && !message.intermediate) {
      restoredFromSave = false
      void catchUpAfterRestore()
    }

    // Relief preview: re-sync the gate off the fresh erosion state, then pull
    // the matching elevation raster for the frame just shown — for the
    // intermediate epoch pictures too. They used to be skipped (8 MB a
    // round), which left the water's height raster at the run's start
    // while the picture moved on: the shores drew as a ghost outline of
    // an older coast (picture check 2026-09-26). The pictures come every
    // HISTORY_DEFAULTS.renderEvery-th epoch now, so the round is rare.
    syncReliefGate()
    if (erosionRunCount >= 1) {
      postToWorker({ type: 'requestElevationField' })
    }

    // Safety auto-stop once this run reaches its armed target epoch (see
    // startSim / autoStopAtEpoch) — reuses the manual-pause path (stopSim),
    // so the play/pause button and everything else it toggles stay in sync.
    // Guarded by tectonicsRunning, so it's a no-op during erosion redraws (which
    // run while stopped) and can't re-fire before the next deliberate start
    // re-arms it.
    if (tectonicsRunning && message.epoch >= autoStopAtEpoch) {
      stopSim()
    }

    // Intermediate renders (see WorkerRenderedMessage.intermediate) are the
    // epoch redraws while the plates still run — the map/stats above reflect
    // them live, but the run has not settled, so what follows a settled
    // terrain waits for the render that is not intermediate.
    if (!message.intermediate) {
      const runJustSettled = tectonicsSettling
      tectonicsSettling = false
      updateControlsDisabled()
      updateProgress()
      // The rivers are the erosion panel's readout (the hydrology stage has no
      // panel of its own): when the run settles — the plates stopped, the last
      // epoch's erosion in — run the chain right away instead of waiting for
      // a panel switch. The render above has just invalidated climate and
      // hydrology (every fresh topography does), so both are posted, in
      // pipeline order. erosionRunCount 0 is a run that stopped before its
      // first epoch — un-eroded terrain gets no rivers. The save chain
      // sequences its own computes.
      if (runJustSettled && erosionRunCount >= 1 && !saveChainActive) {
        if (lastTemperature === null) requestClimate()
        if (lastRiverData === null) requestHydrology()
      }
    }
  }

  // Genesis now starts an ARCHEAN world, not a plate simulation: no plates exist
  // until finalizeArchean hands over. See docs/decisions/archean-genesis.md.
  const initArchean = (seed: string, vigour: number, water: number): void => {
    lastEpoch = 0
    archeanRunning = false
    postToWorker({
      type: 'genesisInit',
      seed,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      epochIntervalMs: EPOCH_INTERVAL_MS,
      mantleDiffusion: vigourToDiffusion(vigour),
      seaLevelOffset: metersToElevation(waterSliderToOffsetM(water)),
      renderOptions: {},
    })
  }
  // The world the screen opens on counts as established too — otherwise the badge
  // is lit from the first frame of every session, which is exactly how a warning
  // stops being read.
  markCleanOnNextRender = true
  initArchean(initialSeed, ARCHEAN_INPUTS.mantleVigour.default, ARCHEAN_INPUTS.water.default)

  // --- Archean controls -----------------------------------------------------
  const setArcheanRunning = (running: boolean): void => {
    archeanRunning = running
    // The button says the state in words since it moved into the column, where
    // there is room for them — no icon beside it, the same as "Create world" in
    // step 0. Saying it again is also how the button follows a language switch.
    const label = t(running ? 'generator.action.runArchean.labelActive' : 'generator.action.runArchean.label')
    toggleArcheanButton.setAttribute('aria-label', label)
    toggleArcheanButton.querySelector('.gen-action__label')!.textContent = label
  }
  // Says the button for the first time: it starts stopped, and until this runs
  // it carries an icon and an empty word.
  setArcheanRunning(archeanRunning)

  toggleArcheanButton.addEventListener('click', () => {
    if (archeanRunning) {
      postToWorker({ type: 'genesisStop' })
      setArcheanRunning(false)
      updateOverlays()
      updateProgress()
      return
    }
    postToWorker({ type: 'genesisStart' })
    setArcheanRunning(true)
    updateOverlays()
  })

  resetArcheanButton.addEventListener('click', () => {
    postToWorker({ type: 'resetStage', stage: 'genesis' })
    setArcheanRunning(false)
    lastArcheanEpochs = 0
    archeanFinalised = false
    hasHandover = false
    // The gate to plate tectonics reads this, so a restart has to close it
    // again — the next status message will fill it in from the new run.
    archeanStabilised = 0
    updateNavState()
  })

  // The three-stage progress indicator. The stabilised fraction is the one quantity
  // that reads the phase cleanly — measured over 600 epochs it runs 6% → 54% → 91%,
  // monotone, while crust fraction keeps climbing and the age spread just grows
  // forever. It also lines up with the map: several separate cratons hold until
  // roughly 60%, and past ~85% the destructible pool is gone, so the world stops
  // changing shape and only accumulates land.
  //
  // Deliberately a hint, not a hard stop — "lots of land, one supercontinent" is a
  // legitimate world to start from, and a supercontinent closing the Archean is
  // what actually happened (Kenorland, ~2.7 Ga).
  // The three bands were checked against what the land actually does, over three seeds
  // from epoch 100 to 400. They hold up — but the wording did not:
  //
  //   stabilised     continents >=5% of land     biggest mass
  //     0-20%              5-6                     13-24%
  //    20-70%              4-6                     23-54%
  //     >70%               2-3                     41-88%
  //
  // The late band used to read "running on now only adds land, not structure", which
  // is the opposite of the truth: above 70% the continents assemble into one mass —
  // and then break it up again. One seed went from 88% of all land in a single
  // continent at epoch 350 to 29% across four at epoch 400. That is a Wilson cycle
  // running inside the Archean, and it is the most structural thing in the whole
  // phase.
  // Wording reworked 2026-08-06 (user: the old lines were confusing without
  // knowing the mechanics): each hint now tells you what you GET if you stop
  // now, not what the simulation is doing internally. The late line
  // deliberately drops the Wilson-cycle "and will tear it apart again" —
  // true, but it read as a warning against the very thing it announces.
  //
  // Thresholds re-verified 2026-08-06 after stabilisedFraction went
  // area-weighted and consolidation/compaction landed (three seeds, 500
  // epochs): 20% crosses at epochs 43-130, 70% at 158-225 — which is exactly
  // when the largest landmass is measurably assembling. The measured band
  // table above predates that re-verification; its numbers are stale but its
  // three-band judgement still holds.
  // The tectonics' judgement, the Archean's twin: the climate step needs
  // MIN_TECTONIC_EPOCHS, and the run stops itself at autoStopAtEpoch.
  const TECTONICS_LATE_EPOCHS = 10
  const tectonicsStage = (epoch: number): { hint: string; advice: string; stage: 'early' | 'window' | 'late' } => {
    if (epoch < MIN_TECTONIC_EPOCHS) return { stage: 'early', hint: t('generator.panel.tectonics.stage.early'), advice: t('generator.panel.tectonics.stage.early.advice', { min: MIN_TECTONIC_EPOCHS }) }
    if (epoch >= autoStopAtEpoch - TECTONICS_LATE_EPOCHS) return { stage: 'late', hint: t('generator.panel.tectonics.stage.late'), advice: t('generator.panel.tectonics.stage.late.advice', { epoch: autoStopAtEpoch }) }
    return { stage: 'window', hint: t('generator.panel.tectonics.stage.window'), advice: t('generator.panel.tectonics.stage.window.advice') }
  }

  // The state and its advice are two lines of one judgement: what the
  // Archean is doing, and what a stop now would give (or that it is too
  // early for one).
  const archeanStage = (stabilised: number): { hint: string; advice: string; stage: 'early' | 'window' | 'late' } => {
    if (stabilised < 0.2) return { stage: 'early', hint: t('generator.panel.genesis.stage.early'), advice: t('generator.panel.genesis.stage.early.advice') }
    if (stabilised < 0.7) return { stage: 'window', hint: t('generator.panel.genesis.stage.window'), advice: t('generator.panel.genesis.stage.window.advice') }
    return { stage: 'late', hint: t('generator.panel.genesis.stage.late'), advice: t('generator.panel.genesis.stage.late.advice') }
  }

  function handleGenesisStatus(message: WorkerGenesisStatusMessage): void {
    lastArcheanEpochs = message.epoch
    updateSaveIndicator()
    statCrust.textContent = String(Math.round(message.crustFraction * 100))
    statCratons.textContent = String(message.cratonCount)
    statStabilised.textContent = String(Math.round(message.stabilisedFraction * 100))
    // The bar is the same number, drawn — set from the fraction rather than
    // from the text, so rounding stays a matter of what is READ.
    statCrustBar.style.width = `${Math.min(100, message.crustFraction * 100)}%`
    statStabilisedBar.style.width = `${Math.min(100, message.stabilisedFraction * 100)}%`
    statWorldAge.textContent = formatWorldAge(message.worldAgeMa)
    // One source for both readouts: the disc's colour and the pill's wording
    // are the same three-stage judgement, so they can never disagree.
    archeanStabilised = message.stabilisedFraction
    archeanNarrated = true
    updateProgress()
    // The stabilised fraction is what opens the gate to plate tectonics, so the
    // bar has to be repainted as it climbs — otherwise the next step stays
    // greyed out until something else happens to ask.
    updateNavState()
  }

  // True from the stop gesture until the settled render arrives (the last
  // epoch's, or the stop's own) — what lets the 'rendered' handler tell the
  // settle of a run from any other plain render.
  let tectonicsSettling = false
  const stopSim = (): void => {
    if (!tectonicsRunning) return
    tectonicsRunning = false
    tectonicsSettling = true
    postToWorker({ type: 'tectonicsStop' })
    updateOverlays()
    sayTectonicsButton(false)
    updateControlsDisabled()
    updateProgress()
  }

  const startSim = (): void => {
    if (tectonicsRunning) return
    tectonicsRunning = true
    updateOverlays()
    // Re-arm the safety auto-stop for another MAX_TECTONICS_EPOCHS from
    // wherever this run begins (see MAX_TECTONICS_EPOCHS / the 'rendered'
    // handler), so restarting after a stop halts again 100 epochs later.
    autoStopAtEpoch = lastEpoch + MAX_TECTONICS_EPOCHS
    // Running tectonics will change the topography → any computed climate is
    // stale. The eroded terrain is NOT dropped: the epochs erode it on (phase
    // 5.1), so the count of eroding epochs carries on from where it was.
    invalidateAfter('tectonics')
    postToWorker({ type: 'tectonicsStart', alluvium: Number(alluviumInput.value), rockContrast: Number(rockContrastInput.value), weather: weatherParams() })
    sayTectonicsButton(true)
    updateControlsDisabled()
    updateProgress()
  }

  toggleSimButton.addEventListener('click', () => {
    if (tectonicsRunning) stopSim()
    else startSim()
  })

  // Micro-tile debug inspector: re-simulates a window around the largest river
  // mouth at fine resolution in the worker (~15-20 s) and shows the baked image
  // in a floating viewer. Derived detail only — the macro world is untouched,
  // so nothing needs invalidating and the result needs no persistence: closing
  // the viewer discards it, clicking again recomputes deterministically.
  // Load a previously-saved world (top-left folder button). Intended handler:
  // open a file picker for a saved snapshot (the export format — world_*.json
  // metadata + the .f32 elevation + .oceanage.f32 rasters), parse it, and
  // --- Save / load a world as a .zip (world.yaml recipe+status + state.json
  // sim snapshot + oceanAge.f32 + elevation.f32 + preview.png). See
  // docs/decisions/... (the save/load design). The deterministic parts could be
  // replayed from the recipe, but the snapshot is stored so a 300-epoch world
  // loads instantly and survives generator changes.

  // The world.yaml recipe (spec) + how far it was taken (status).
  // The DOM read into a typed recipe. worldSpec.ts owns the order and the nesting;
  // which control feeds which key needs no table here at all — WORLD_SPEC_FIELDS
  // names the InputParam, and sliderBindings knows the element that param produced.
  // That correspondence used to be written out a THIRD time, as a twelve-entry map
  // from spec path to input; it is now the same one the markup already recorded.
  function readSpec(): WorldSpec {
    const values: Record<string, number> = {}
    for (const field of WORLD_SPEC_FIELDS) {
      const leaf = field.path.split('.').pop() as EcologyFieldId
      // The thirteen ecology abundance nudges share one declaration, so they have
      // no binding of their own and are found by their field id.
      const input = sliderBindings.get(field.input)?.input
      values[field.path] = input ? Number(input.value) : (abundance.get(leaf) ?? field.input.default)
    }
    return { seed: seedInput.value, values }
  }

  // --- unsaved changes ---------------------------------------------------------

  // What a save would capture, as one comparable string: the recipe AND how far
  // the world was taken. Both halves, because a save holds both — "the sliders are
  // where they were" would call a world with forty more epochs on it unchanged.
  //
  // Derived on demand rather than a dirty flag someone sets. A flag has to be set
  // at every mutation and cleared at every save, and the one that gets forgotten is
  // the one that makes the icon lie — which is worse than no icon, because it is
  // believed.
  function worldSignature(): string {
    const spec = readSpec()
    return JSON.stringify([worldName, spec.seed, spec.values, lastArcheanEpochs, lastEpoch, erosionRunCount])
  }

  function markWorldEstablished(): void {
    savedSignature = worldSignature()
    updateSaveIndicator()
  }

  // Where the last save in THIS session went, and when. The signature above
  // answers "has it changed since"; it cannot answer "and where does it sit",
  // because a signature that matches is equally true of a world downloaded as a
  // .zip and one uploaded to the server. Held only for the session: the title
  // bar states what this run of the generator did, and a world reopened
  // tomorrow starts from what the save itself says.
  let lastSave: { target: SaveTarget; at: Date } | undefined

  // Whether the load screen is covering the generator. A plain flag and
  // not a read of the chooser itself, because updateSaveIndicator runs from
  // here and the chooser is built several hundred lines further down — asking
  // it would be the temporal dead zone that once blanked this whole screen.
  let chooserOpen = false

  function saveState(): TitleBarSaveState {
    if (worldSignature() !== savedSignature) {
      return lastSave === undefined && savedSignature === '' ? { kind: 'new' } : { kind: 'unsaved' }
    }
    if (!lastSave) return { kind: 'new' }
    return { kind: lastSave.target === 'server' ? 'server' : 'local', at: lastSave.at }
  }

  // --- leaving a world that is not saved ---------------------------------------

  // The window that asks. Built once and reused: the question is the same
  // wherever a world would be thrown away.
  const confirmDialog = createConfirmDialog(root)

  // Runs `go`, but asks first where the world would be lost by it.
  //
  // Both ways out of a world come through here — the wordmark and the save
  // menu's "open world" — because the loss is the same either way and a guard
  // written twice is a guard one of the two paths eventually loses. The state
  // is the one the title bar shows: `new` is a world that was never written
  // anywhere, `unsaved` one that moved since it was. The two other states are
  // a world safely at rest, and those simply go.
  async function leaveWorld(go: () => void): Promise<void> {
    // Nothing to lose behind the world list: the world it covers is the one it
    // is about to replace, and it was never chosen.
    if (chooserOpen) return go()
    const { kind } = saveState()
    if (kind !== 'new' && kind !== 'unsaved') return go()
    const discard = await confirmDialog.ask({
      titleKey: 'common.confirm.discard.title',
      bodyKey: kind === 'new' ? 'common.confirm.discard.new' : 'common.confirm.discard.unsaved',
      confirmKey: 'common.confirm.discard.action.discard',
    })
    if (discard) go()
  }

  // Closing the tab loses the same world, and the browser will not let a page
  // ask its own question there: setting `returnValue` is the whole API, and the
  // wording is the browser's. So this only decides WHETHER to ask.
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    // Same exception as above: nothing is lost while the world list is up.
    if (chooserOpen) return
    const { kind } = saveState()
    if (kind !== 'new' && kind !== 'unsaved') return
    event.preventDefault()
    // Firefox still wants the legacy assignment; every engine ignores the text.
    event.returnValue = ''
  }
  window.addEventListener('beforeunload', onBeforeUnload)

  function updateSaveIndicator(): void {
    // The title bar's status line IS the unsaved marker now. The badge on the
    // floppy said the same thing twice, one of them in a symbol.
    titleBar.setSaveState(saveState())
    // Nothing while the chooser is up. The generator has already built a world
    // behind it, so there IS a seed to show — showing it would say a world is
    // open when the question on screen is still which one.
    titleBar.setWorld(chooserOpen ? null : { name: worldName, seed: seedInput.value })
    // Nor anything to save there: the world behind the list is the one the
    // list is about to replace, and offering to write it would be offering to
    // keep a world nobody has chosen yet.
    saveMenu.setVisible(!chooserOpen)
  }

  // One delegated listener instead of one per control: every slider, including the
  // thirteen ecology fold-outs, sits under root, and `input` bubbles.
  root.addEventListener('input', () => updateSaveIndicator())

  function buildWorldYaml(): string {
    const name = worldName || seedInput.value || 'world'
    return [
      'apiVersion: casas-eternas/v1alpha1',
      'kind: FlatWorld',
      'metadata:',
      `  name: ${name}`,
      // The world's own identity, stable across further erosion and across
      // re-saves — the key the server's world store is addressed by. Distinct
      // from the TERRAIN's identity (deriveWorldId), which is supposed to move
      // whenever the terrain does; see the note under status.
      `  uid: ${worldUid}`,
      'spec:',
      ...specToYamlLines(readSpec()),
      'status:',
      // Only what state.json does NOT already carry. tectonicsRun and archeanEpochs
      // used to sit here and in spec, duplicating the snapshot's own `epoch` and
      // `archeanEpochs` — two sources for one fact, and nothing read the yaml copies.
      // The erosion count has no home in the snapshot, so this stays load-bearing.
      `  erosionRun: ${erosionRunCount}`,
      // How many times this world has been written. The server's optimistic
      // lock compares it, so two machines editing one world collide loudly
      // instead of one silently overwriting the other.
      `  revision: ${worldRevision}`,
      // PROVENANCE, never a key (see app/buildVersion.ts): which build wrote
      // this stand. Regenerating the same recipe on another build may well
      // produce different terrain, and this is what lets a reader say so.
      `  generator: ${BUILD_VERSION}`,
      // NOT recorded here: the terrain's content id (world/identity's
      // deriveWorldId). It would let a listing say "the server holds different
      // terrain" without downloading 8 MB — but it hashes the DEQUANTISED
      // precipitation layer, and the generator holds raw floats, so a value
      // written here would differ from the one every reader computes. A hash
      // that is subtly wrong is worse than an absent one; readers derive it
      // from the save, the way the queryable reader does (world/save).
      '',
    ].join('\n')
  }

  // Refresh every slider's readout label from its input value — used after a
  // load sets the inputs programmatically (which doesn't fire input events).
  function syncSliderLabels(): void {
    mantleVigourLabel.textContent = mantleVigourInput.value
    waterLabel.textContent = waterInput.value
    obliquityLabel.textContent = obliquityInput.value
    rotationLabel.textContent = rotationInput.value
    const t = Number(tempBandInput.value)
    tempBandLabel.textContent = t > 0 ? `+${t}` : String(t)
    humidityLabel.textContent = humidityInput.value
    contrastLabel.textContent = contrastInput.value
    alluviumLabel.textContent = alluviumInput.value
    rockContrastLabel.textContent = rockContrastInput.value
    carryingCapacityLabel.textContent = carryingCapacityInput.value
    const c = Number(concentrationInput.value)
    concentrationLabel.textContent = c > 0 ? `+${c}` : String(c)
    provinceLabel.textContent = provinceInput.value
    showAbundanceFor(pickedEcologyField)
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

  // Bakes the "query layers" + manifest into the save (see
  // docs/decisions/queryable-world-save.md): every computed field, quantised per
  // its layer spec, plus a manifest describing them — so the game server can look
  // up any world value by sampling, with no generation code. Bakes whatever the
  // main thread has cached (climate/hydrology/ecology from the panels visited);
  // layers absent from the cache are simply omitted from the manifest.
  function bakeQueryLayers(zip: JSZip, forcing: { uplift: Float32Array; erodibility: Float32Array; resX: number; resY: number } | null, mesh: MeshPayload | undefined): void {
    type ManifestLayer = { name: string; file: string; kind: 'raster' | 'vector' | 'table'; resX?: number; resY?: number; dtype?: string; encoding?: { scale: number; offset: number }; unit?: string; landOnly?: boolean }
    const layers: ManifestLayer[] = []
    // Elevation is always present (post-generation); carried raw as elevation.f32
    // (it doubles as the restore raster).
    layers.push({ name: 'elevation', file: 'elevation.f32', kind: 'raster', resX: MAP_WIDTH, resY: MAP_HEIGHT, dtype: 'f32', encoding: { scale: 1, offset: 0 }, unit: 'relative', landOnly: false })

    // The erosion engine's coarse forcing, from the worldData reply rather
    // than a screen-side stash: it exists whenever the sim does, independent
    // of the climate gate below — a bake erodes before it needs climate.
    if (forcing) {
      for (const spec of FORCING_LAYERS) {
        const src = spec.name === 'uplift' ? forcing.uplift : forcing.erodibility
        zip.file(`layers/${spec.name}.${spec.dtype}`, bakeLayer(src, spec))
        layers.push({ name: spec.name, file: `layers/${spec.name}.${spec.dtype}`, kind: 'raster', resX: forcing.resX, resY: forcing.resY, dtype: spec.dtype, encoding: { scale: spec.scale, offset: spec.offset }, unit: spec.unit, landOnly: spec.landOnly })
      }
    }

    // Climate/hydrology/ecology are only baked once they've been computed
    // (compute-on-save ensures that when the world has been eroded).
    if (climateResX > 0 && lastPrecipitation) {
      const rx = climateResX
      const ry = climateResY
      const landMask = new Float32Array(rx * ry)
      for (let i = 0; i < landMask.length; i++) landMask[i] = lastPrecipitation[i] !== OCEAN_PRECIP ? 1 : 0
      const sources: Partial<Record<string, Float32Array | Uint8Array>> = {
        landMask,
        temperature: lastTemperature ?? undefined,
        precipitation: lastPrecipitation ?? undefined,
        precipitationEffective: lastPrecipitationEffective ?? undefined,
        biome: lastBiomes ?? undefined,
        seasonalAmplitude: lastSeasonality ?? undefined,
        monsoonIndex: lastMonsoonIndex ?? undefined,
        lakeDepth: lastLakeDepth ?? undefined,
        waterTable: lastWaterTable ?? undefined,
      }
      for (const f of Object.keys(lastEcologyFields) as EcologyFieldId[]) sources[f] = lastEcologyFields[f]
      for (const spec of WORLD_LAYERS) {
        const src = sources[spec.name]
        if (!src) continue
        // Dimensions from the spec, not from this loop's climate rx/ry: biome is
        // baked on the world raster (see LayerSpec.fullRes). A wrong pair here
        // would not throw — the buffer's length is whatever the source is, and
        // only the manifest says how to fold it into rows.
        const [lx, ly] = spec.grid === 'world' ? [MAP_WIDTH, MAP_HEIGHT] : [rx, ry]
        zip.file(`layers/${spec.name}.${spec.dtype}`, bakeLayer(src, spec))
        layers.push({ name: spec.name, file: `layers/${spec.name}.${spec.dtype}`, kind: 'raster', resX: lx, resY: ly, dtype: spec.dtype, encoding: { scale: spec.scale, offset: spec.offset }, unit: spec.unit, landOnly: spec.landOnly })
      }
      // Rivers are a DISCHARGE RASTER, not polylines — baked at map resolution
      // like biome, but written here because it needs a unit conversion first.
      //
      // The polyline layer that used to sit here was written by one place and
      // read by none: the client re-derives its rivers (deterministically, from
      // elevation + precipitation, both of which are in this
      // save) or fetches a baked artifact, and a game server cannot answer
      // "how big is this river" from a line whose only attribute is a drawing
      // width clamped at four pixels. It also went stale the moment an
      // amplified bake existed, giving the save and the map two different
      // answers to the same question.
      //
      // A field answers by sampling, exactly as biome and lakeDepth do, and it
      // costs less: 109 KB compressed against 303 KB of JSON.
      if (lastDischargeField) {
        const m3s = new Float32Array(lastDischargeField.length)
        for (let i = 0; i < m3s.length; i++) m3s[i] = lastDischargeField[i] * DISCHARGE_TO_M3S
        zip.file(`layers/${DISCHARGE_LAYER.name}.${DISCHARGE_LAYER.dtype}`, bakeLayer(m3s, DISCHARGE_LAYER))
        layers.push({
          name: DISCHARGE_LAYER.name, file: `layers/${DISCHARGE_LAYER.name}.${DISCHARGE_LAYER.dtype}`, kind: 'raster',
          resX: MAP_WIDTH, resY: MAP_HEIGHT, dtype: DISCHARGE_LAYER.dtype,
          encoding: { scale: DISCHARGE_LAYER.scale, offset: DISCHARGE_LAYER.offset },
          unit: DISCHARGE_LAYER.unit, landOnly: DISCHARGE_LAYER.landOnly,
        })
      }
    }
    // The standing-water list (ADAPTIVE_MESH_PLAN.md phase 1): a JSON table
    // beside the rasters — the truth `lakeDepth` derives from
    // (hydrology.lakeDepthFromBodies), in this raster's texel coordinates.
    // Its arrival is what formatVersion 2 says; a version-1 reader simply
    // does not see the entry.
    if (lastWaterBodies) {
      zip.file('layers/waterBodies.json', JSON.stringify(lastWaterBodies))
      layers.push({ name: 'waterBodies', file: 'layers/waterBodies.json', kind: 'table' })
    }
    // The coast reaches (F5), the same way: a table, cells as indices into
    // this raster.
    if (lastCoast) {
      zip.file('layers/coast.json', JSON.stringify({ reaches: lastCoast.reaches, cells: Array.from(lastCoast.cells) }))
      layers.push({ name: 'coast', file: 'layers/coast.json', kind: 'table' })
    }
    // The sediment basins (F1): what this session's erosion deposited, with
    // provenance — a loaded save cannot re-derive them, so the table is
    // written only when the session has them.
    if (lastSedimentBasins && lastSedimentBasins.length > 0) {
      zip.file('layers/sedimentBasins.json', JSON.stringify(lastSedimentBasins))
      layers.push({ name: 'sedimentBasins', file: 'layers/sedimentBasins.json', kind: 'table' })
    }
    // The adaptive mesh (ADAPTIVE_MESH_PLAN.md phase 4.3): the terrain
    // proper, from which `elevation.f32` is rasterised. Three files under
    // `mesh/`, described by one manifest entry; `formatVersion` 3 says a
    // save may carry one, 4 that it may carry the sediment column as a
    // fourth (phase 5.2), 5 that the column's layers carry the climate at
    // deposition (phase 5.4). A world whose history has not run carries none.
    if (mesh) {
      zip.file('mesh/nodes.f32', mesh.nodes)
      zip.file('mesh/connectivity.bin', mesh.connectivity)
      zip.file('mesh/z.f32', mesh.z)
      if (mesh.column) zip.file('mesh/column.bin', mesh.column)
    }
    const manifest = {
      formatVersion: 5,
      // The same provenance string status.generator carries — a real build id
      // since 2026-08-11, where a static 'casas-eternas/v1alpha1' had stood
      // saying nothing.
      generatorVersion: BUILD_VERSION,
      world: { width: MAP_WIDTH, height: MAP_HEIGHT, topology: 'torus' },
      layers,
      mesh: mesh ? { nodes: mesh.count, files: { nodes: 'mesh/nodes.f32', connectivity: 'mesh/connectivity.bin', z: 'mesh/z.f32', column: mesh.column ? 'mesh/column.bin' : undefined } } : undefined,
    }
    zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  }

  // Save flow: worker replies with the sim snapshot + rasters → zip it up (recipe
  // + snapshot + baked query layers + manifest + preview).
  // Where the next serialized world goes. Set by the save affordance before the
  // worker is asked for the data, because by the time the archive exists the
  // question is already answered — and asking afterwards would mean holding a
  // 30 MB blob while a menu is open.
  let pendingSaveTarget: SaveTarget = 'download'

  // Hands the finished archive to its destination. Download is the fallback for
  // everything: a world that could not be uploaded must still not be lost.
  async function deliverArchive(blob: Blob, filename: string): Promise<void> {
    if (pendingSaveTarget === 'browser') {
      const kept = await keepWorldInBrowser(worldUid, blob, {
        name: worldName || seedInput.value || 'world',
        seed: seedInput.value,
        revision: worldRevision,
        erosionRun: erosionRunCount,
        savedAt: new Date().toISOString(),
        generator: BUILD_VERSION,
      }, await makePreviewBlob())
      if (kept) {
        ctx.notifications.show({ message: t('notify.save.browser.stored'), icon: '/icons/ok.png', durationMs: 4000 })
        markWorldEstablished()
        return
      }
      // The archive still reaches the user, for the same reason a failed
      // upload falls back to one: a world is the thing here that cannot be
      // recomputed, so no failure path may end with it nowhere.
      ctx.notifications.show({ message: t('notify.save.browser.failed'), icon: '/icons/warning.png', durationMs: 8000 })
      downloadBlob(blob, filename)
      return
    }
    if (pendingSaveTarget !== 'server') {
      downloadBlob(blob, filename)
      markWorldEstablished()
      return
    }
    const endTransfer = serverIndicator.beginTransfer()
    try {
      const outcome = await uploadWorld(worldUid, blob)
      if (outcome.ok) {
        ctx.notifications.show({ message: t('notify.save.server.stored'), icon: '/icons/ok.png', durationMs: 4000 })
        markWorldEstablished()
        return
      }
      if (outcome.reason === 'conflict') {
        // Deliberately no automatic retry: overwriting is exactly what the
        // server's lock exists to prevent, and a world is the one thing here
        // that cannot be recomputed. The archive still reaches the user.
        ctx.notifications.show({ message: t('notify.save.server.conflict'), icon: '/icons/warning.png', durationMs: 8000 })
      } else {
        ctx.notifications.show({ message: t('notify.save.server.failed'), icon: '/icons/warning.png', durationMs: 8000 })
        void serverIndicator.refresh()
      }
      downloadBlob(blob, filename)
    } finally {
      endTransfer()
    }
  }

  async function handleWorldData(message: WorkerWorldDataMessage): Promise<void> {
    const zip = new JSZip()
    // Stamp the identity BEFORE the yaml is built — it is the one thing in the
    // recipe that is not read off a control. A world minted here keeps its uid
    // for every later save; regenerate() is the only thing that clears it.
    if (worldUid === '') worldUid = newWorldUid()
    // A bake is NOT a save. Bumping the revision here would advance the counter
    // the server's optimistic lock compares against, so the next real upload
    // would collide with a write that never happened.
    if (pendingBakeFactors.length === 0) worldRevision += 1
    zip.file('world.yaml', buildWorldYaml())
    // A world saved during the Archean has no plate simulation yet — it carries its own
    // snapshot instead. The phase is a pause, so it has to be savable there; before this
    // the save button posted its request and the worker silently declined.
    if (message.archean) {
      zip.file('archean.json', JSON.stringify(message.archean.snapshot))
      zip.file('archean.mantle.f32', message.archean.mantle)
      zip.file('archean.streak.i16', message.archean.streak)
      zip.file('elevation.f32', message.elevation)
      const archeanPreview = await makePreviewBlob()
      if (archeanPreview) zip.file('preview.png', archeanPreview)
      const archeanBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
      // An Archean save has no climate, so a bake of it would stop after
      // erosion and yield a world with no rivers. It is still routed through
      // runBakeOrder rather than dropped: that path reports the reason and,
      // more importantly, clears the "a bake is running" state. Returning here
      // with it still set would disable the start button until the screen
      // reloads. (The erosion gate makes this unreachable from the UI — this
      // is the belt to that suspender.)
      if (pendingBakeFactors.length > 0) {
        await runBakeOrder(archeanBlob)
        return
      }
      await deliverArchive(archeanBlob, `${(worldName || seedInput.value || 'world').replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`)
      return
    }
    zip.file('state.json', JSON.stringify(message.snapshot))
    zip.file('mantle.f32', message.mantle)
    zip.file('lattice.acc.f32', message.latticeAccumulated)
    zip.file('lattice.lock.i16', message.latticeLockedEpochs)
    zip.file('lattice.class.i8', message.latticeLastClassCode)
    zip.file('oceanAge.f32', message.oceanAge)
    zip.file('elevation.f32', message.elevation)
    bakeQueryLayers(zip, message.forcingResX > 0
      ? { uplift: new Float32Array(message.uplift), erodibility: new Float32Array(message.erodibility), resX: message.forcingResX, resY: message.forcingResY }
      : null, message.mesh)
    const preview = await makePreviewBlob()
    if (preview) zip.file('preview.png', preview)
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
    // The bake reads this archive back rather than being handed the rasters:
    // see bakeFromArchive for why the save is the only representation whose
    // artifact key the world map will actually look for.
    if (pendingBakeFactors.length > 0) {
      await runBakeOrder(blob)
      return
    }
    const safeName = (worldName || seedInput.value || 'world').replace(/[^a-zA-Z0-9_-]/g, '_')
    await deliverArchive(blob, `${safeName}.zip`)
  }

  // Await one compute step: set its resolver, request it; the data handler
  // resolves when it lands. Safe because save is only reachable while idle.
  const awaitCompute = (setResolver: (r: () => void) => void, request: () => void): Promise<void> =>
    new Promise((resolve) => { setResolver(resolve); request() })

  // The generator's first screen (see WorldChooser). Built here, beside the
  // other two ways into a world, and opened at the foot of this function.
  const worldChooser = createWorldChooser(root, {
    // A new world starts at step 0, wherever the generator happened to be
    // standing when the list was reopened.
    onNewWorld: () => {
      closeWorldChooser()
      showPanel(panelIndexOf('world'))
    },
    // Same path a picked file takes — `loadWorldFromZip` closes the chooser
    // once the archive has actually turned out to be a world.
    onOpenArchive: (archive) => { void loadWorldFromZip(new File([archive], 'world.zip')) },
    onPickFile: () => pickLocalWorldFile(),
  })

  // Back to the world list. The step bar is for steps WITHIN a world; leaving
  // one is a different kind of move, and it hangs off the world's name in the
  // title bar — the place that says which world you are in.
  function openWorldChooser(): void {
    if (chooserOpen) return
    chooserOpen = true
    // The generator's own furniture steps aside as one: the list is about
    // WHICH world, and a step bar underneath it would be answering a question
    // nobody has asked yet. One place does this, and startup goes through it
    // too — the first opening used to hide them separately, and when that line
    // drifted the load screen came up sitting on top of the steps.
    stepBar.setVisible(false)
    sidebar.setVisible(false)
    updateSaveIndicator()
    worldChooser.open()
  }

  function closeWorldChooser(): void {
    if (!chooserOpen) return
    chooserOpen = false
    stepBar.setVisible(true)
    sidebar.setVisible(true)
    worldChooser.close()
    // The bar has been showing no world; now there is one to name.
    updateSaveIndicator()
  }

  // Recompute what a restored world does not carry: the derived stages exist
  // only as live rasters in this screen, so a world read back from a save has
  // a terrain and a simulation and nothing after them. Awaited step by step —
  // climate feeds hydrology, both feed ecology — and quietly: nothing here is
  // a user's request, it is the screen catching up with the world it was just
  // handed. The step bar repaints as each lands (updateControlsDisabled).
  async function catchUpAfterRestore(): Promise<void> {
    // Each request is guarded against one already being in flight: landing on
    // the Ecology step and loading a world there would otherwise have the
    // panel's own chain and this one both post the same compute. Waiting is
    // still right in that case — the resolver is called by whichever request
    // lands, not by the one that asked.
    if (lastEpoch < MIN_TECTONIC_EPOCHS) return
    if (lastTemperature === null) {
      await awaitCompute((r) => { climateResolve = r }, () => { if (!climateInFlight) requestClimate() })
    }
    if (erosionRunCount < 1) return
    if (lastRiverData === null) {
      await awaitCompute((r) => { hydrologyResolve = r }, () => { if (!hydrologyInFlight) requestHydrology() })
    }
    if (!hasEcologyData()) {
      await awaitCompute((r) => { ecologyResolve = r }, () => { if (!ecologyInFlight) requestEcology() })
    }
  }

  async function saveTo(target: SaveTarget): Promise<void> {
    pendingSaveTarget = target
    await saveWorld()
    // After saveWorld, so a failed save does not claim a resting place — and
    // only for the two targets that ARE one. A download is an export: it hands
    // the world to the user and nothing here holds it afterwards, so recording
    // it would make the bar claim a place the world is not.
    if (target !== 'download') lastSave = { target, at: new Date() }
    updateSaveIndicator()
    // Saving to the server is exactly what unblocks 8K, so the buttons are
    // re-evaluated here rather than leaving a greyed-out control that has just
    // become possible.
    void refreshBakeButtons()
  }

  // --- Ordering an amplification bake from the erosion panel ----------------
  //
  // The bake IS an erosion pass at a finer grid — upsample, seed roughness,
  // erode, re-derive hydrology — which is why it is commissioned from here
  // rather than beside the river-density slider that reads its result.
  //
  // It goes through the SAVE, always, and that is the load-bearing decision.
  // The obvious shortcut is to bake from the rasters this screen already
  // holds, and it produces a wrong cache key: an artifact is addressed by
  // `deriveWorldId`, which hashes the precipitation layer as STORED (u16 at
  // 8000/65535), while the generator holds raw floats. The buildWorldYaml
  // comment says the same thing about not writing that id into the recipe.
  // A bake keyed off the raw floats would run correctly, write real bytes,
  // and be invisible to the world map for ever — the same silent class of
  // failure as a pipeline-version mismatch. Serialising and reading back
  // through `readWorldInputs` makes the key right by construction, because
  // it is the identical reader the map and the server's baker use.
  // The bakes the next save cycle should run, in the order they will run.
  // Several at once is the point: the chips SELECT tiers, the one start button
  // orders them, and this client works through them one after the other —
  // coarsest first, so the tier a map can already use arrives soonest.
  let pendingBakeFactors: number[] = []
  let bakeRunning = false

  // Which tier the chips have selected, as a factor (2 → 4K, 4 → 8K). ONE
  // value, radio-style, finest first in the row (user decision 2026-08-16):
  // under derived tiers the finest bake carries every coarser view as its
  // downsample, so ordering several tiers is redundant — the standalone 4K is
  // only the stopgap before an 8K exists. Default = the designated finest.
  // 16K's chip exists and stays disabled — its help card says what it waits
  // on (tiled artifacts).
  let selectedBakeFactor: number = AMPLIFY_FINEST_STAGE

  // Look for the finest baked network this world already has and show it.
  //
  // Finest first: the whole point of the search is "best available", and 8K
  // carries roughly seven times the channel length of 4K. Silent when there is
  // nothing — an absent artifact is the normal state, not a failure.
  async function adoptBestBakedRivers(worldUidForLookup: string, worldIdForLookup: string): Promise<void> {
    const pipelineVersion = amplificationPipelineVersion()
    const store = await getArtifactStore()
    for (const factor of [4, 2]) {
      const key = artifactKey(worldUidForLookup, worldIdForLookup, pipelineVersion, String(factor))
      const hit = await readAmplificationArtifact(store, key).catch(() => null)
      if (!hit) continue
      showBakedRivers(hit.artifact.riverPoints, hit.artifact.riverLengths, hit.artifact.riverRegimes, factor)
      return
    }
  }

  // One tier of one archive. Deliberately does NOT own `bakeRunning`: the
  // caller runs a whole ORDER of these in sequence, and the first tier
  // clearing the flag would re-enable the start button with the rest of the
  // order still to run.
  async function bakeFromArchive(archive: Blob, factor: number): Promise<void> {
    const level = `${factor * 2}K`
    const inputs = await readWorldInputs(await archive.arrayBuffer())
    if (!inputs || !inputs.climate) {
      // No climate means no discharge, so the bake would stop after erosion
      // and produce a world with no rivers — which is the Archean case.
      ctx.notifications.show({ message: t('notify.bake.failed', { reason: '' }), icon: '/icons/warning.png', durationMs: 8000 })
      return
    }

    const pipelineVersion = amplificationPipelineVersion()
    const key = artifactKey(inputs.worldUid, inputs.worldId, pipelineVersion, String(factor))
    const store = await getArtifactStore()
    if (await amplificationArtifactExists(store, key).catch(() => false)) {
      // Already made, by this machine or another. Saying so beats spending
      // minutes to reproduce bytes that are addressed by content anyway.
      ctx.notifications.show({ message: t('notify.bake.exists', { level }), icon: '/icons/ok.png', durationMs: 6000 })
      void adoptBestBakedRivers(inputs.worldUid, inputs.worldId)
      return
    }

    // Waiting wears the SERVER's icon whatever the deployment is, because that
    // is what is true: the server holds the request until something is free to
    // take it, and where it will run is not yet a fact about the world.
    let toast = ctx.notifications.show({
      message: t('notify.bake.waiting', { level }),
      icon: '/icons/server_load.png',
      sticky: true,
    })
    const settle = (message: string, icon: string, durationMs: number): void => {
      ctx.notifications.dismiss(toast)
      ctx.notifications.show({ message, icon, durationMs })
    }

    // Once it IS running, the icon says where — a Kubernetes Job on another node
    // looks different from a subprocess beside the server, and that is worth
    // seeing while you wait seven minutes.
    //
    // A second notification rather than a patched one, and that follows the rule
    // rather than working around it: NotificationPatch allows only the message
    // and the bar to change, on the grounds that a moved icon "would read as a
    // second event" — and here it is one. Waiting for a machine and running on
    // it are two different things.
    //
    // Resolved BEFORE the poll loop so the swap is synchronous. Awaiting inside
    // it would reassign `toast` after the same tick had already written to the
    // old one, which is a race with no symptom except a progress bar that skips.
    const status = await getServerStatus()
    const runningIcon = status.bakeRunner === 'kubernetes' ? '/icons/kubernetes.png' : '/icons/server_load.png'
    let announcedRunning = false
    const announceRunning = (): void => {
      if (announcedRunning) return
      announcedRunning = true
      ctx.notifications.dismiss(toast)
      toast = ctx.notifications.show({
        message: t('notify.bake.running', { level }),
        icon: runningIcon,
        sticky: true,
      })
    }

    // The server when it can, this browser when it cannot. Measured: 78 s
    // against 232 s for the same stage, and the tab stays responsive.
    const onServer = inputs.worldUid !== '' && isStoredOnServer(inputs.worldUid) && (await canCommissionBakes())
    if (onServer) {
      const order = await commissionBake(inputs.worldUid, factor, AMPLIFY_EROSION_ROUNDS)
      if (!order.ok) {
        settle(order.reason === 'unknownWorld' ? t('notify.bake.needsUpload') : t('notify.bake.failed', { reason: order.message ?? '' }), '/icons/warning.png', 12000)
        return
      }
      const outcome = await followBake(order.job.id, pipelineVersion, (job) => {
        if (!bakeIsWaiting(job)) announceRunning()
        ctx.notifications.update(toast, {
          message: t(bakeIsWaiting(job) ? 'notify.bake.waiting' : 'notify.bake.running', { level }),
          progress: bakeFraction(job),
        })
      })
      if (!outcome.ok) {
        settle(
          outcome.reason === 'mismatch'
            ? t('notify.bake.mismatch', { serverVersion: outcome.serverVersion, clientVersion: outcome.clientVersion })
            : t('notify.bake.failed', { reason: outcome.message }),
          '/icons/warning.png', 15000,
        )
        return
      }
      settle(t('notify.bake.done', { level, width: outcome.result.width, height: outcome.result.height, seconds: Math.round(outcome.result.durationMs / 1000) }), '/icons/server_clean.png', 15000)
      void adoptBestBakedRivers(inputs.worldUid, inputs.worldId)
      return
    }

    // No server: only what a tab can survive. 8K is the ~2.6 GB that kills it,
    // and the button is disabled for exactly this reason — reaching here means
    // the world lost its server between the check and the click.
    //
    // Being signed out lands here too, and it is worth saying which of the two
    // it is: "needs a server" sends someone to check a deployment that is fine.
    if (!AMPLIFY_BAKE_STAGES.includes(factor)) {
      const missing = await needsSignIn()
      settle(t(missing ? 'generator.panel.erosion.bake.needsSignIn' : 'generator.panel.erosion.bake.needsServer'), '/icons/warning.png', 10000)
      return
    }
    try {
      const baked = await bakeStageInBrowser(
        {
          macro: inputs.elevations, macroWidth: inputs.width, macroHeight: inputs.height,
          factor, detailSeed: inputs.detailSeed, erosionRounds: AMPLIFY_EROSION_ROUNDS,
          lithoSeed: inputs.lithoSeed,
          alluvium: inputs.erosionControls.alluvium,
          rockContrast: inputs.erosionControls.rockContrast,
          uplift: inputs.uplift?.data,
          erodibility: inputs.erodibility?.data,
          forcingResX: inputs.uplift?.resX, forcingResY: inputs.uplift?.resY,
          precipitation: inputs.climate.data,
          temperature: inputs.temperature?.data,
          monsoonIndex: inputs.biomeInputs?.monsoonIndex.data,
          climateResX: inputs.climate.resX, climateResY: inputs.climate.resY,
        },
        (phase, fraction) => {
          ctx.notifications.update(toast, {
            message: t('notify.bake.running', { level }),
            progress: amplifyPhaseFraction(phase, fraction),
          })
        },
      )
      await writeAmplificationArtifact(store, key, baked.artifact, baked.durationMs, inputs.seedText).catch(() => false)
      showBakedRivers(baked.artifact.riverPoints, baked.artifact.riverLengths, baked.artifact.riverRegimes, factor)
      settle(t('notify.bake.done', { level, width: baked.artifact.width, height: baked.artifact.height, seconds: Math.round(baked.durationMs / 1000) }), '/icons/server_clean.png', 15000)
    } catch {
      settle(t('notify.bake.failed', { reason: '' }), '/icons/warning.png', 12000)
    }
  }

  // The whole order, one tier after the other against the SAME archive — the
  // client-side sequence the chips select. Sequential on purpose: the browser
  // path cannot run two bakes at once, a server bake saturates the worker
  // cap anyway, and one moving progress toast at a time is readable where two
  // racing ones are not. A failed tier does not stop the rest — the artifacts
  // are independent, and 4K failing for a browser reason says nothing about
  // 8K on the server.
  async function runBakeOrder(archive: Blob): Promise<void> {
    const factors = pendingBakeFactors
    pendingBakeFactors = []
    try {
      for (const factor of factors) await bakeFromArchive(archive, factor)
    } finally {
      // Owned here, not by the tiers: the first settling tier would otherwise
      // re-enable the start button with the rest of the order still to run.
      bakeRunning = false
      void refreshBakeButtons()
    }
  }

  // "4K" is factor 2 and "8K" is factor 4 — the label is the WIDTH, the factor
  // is the refinement. Kept explicit here rather than computed at each site,
  // because confusing the two silently bakes the wrong tier.
  const bakeTierChips = [...root.querySelectorAll<HTMLButtonElement>('[data-bake-tier]')]
  const bakeStartButton = root.querySelector<HTMLButtonElement>('[data-action="bake-detail"]')!

  // A disabled control KEEPS its help card. The first cut swapped data-help for
  // a native `title` — exactly one of the two, since the card replaces the
  // native tooltip and both at once shows two — and that traded the styled
  // explanation for a plain delayed one at the very moment it was needed most.
  // Each card's text already names what its tier requires, so the disabled
  // state says "not now" and the card says "why".
  async function refreshBakeButtons(): Promise<void> {
    const saved = worldUid !== '' && isStoredOnServer(worldUid)
    const server = await canCommissionBakes()
    // 4K needs nothing but a world: without a server it bakes here, which is
    // what the browser can survive at this tier. 8K is the ~2.6 GB that
    // kills a tab, so it is server-only — and the server bakes from the
    // STORED world, which is the second condition and the one more often
    // missing while a world is still being made. 16K does not exist yet.
    // Deliberately WITHOUT bakeRunning: that is a transient the chips show
    // by being disabled, not a reason to move a selection.
    const usable = (factor: number): boolean =>
      factor === 2 ? true
      : factor === 4 ? server && saved
      : false
    // Selection follows availability: a selected tier whose requirement just
    // went away (signed out, world no longer on the server) must not stay
    // selected — the start button would commission it into a late failure.
    // Radio semantics, so it falls back to the finest usable tier instead of
    // to nothing.
    if (!usable(selectedBakeFactor)) selectedBakeFactor = 2
    for (const chip of bakeTierChips) {
      const factor = Number(chip.dataset.bakeTier)
      chip.disabled = bakeRunning || !usable(factor)
      chip.setAttribute('aria-pressed', String(factor === selectedBakeFactor))
    }
    // The gate the tiers share: a bake refines ERODED terrain. Before the
    // first macro pass there is no climate either (compute-on-save has the
    // same erosionRunCount >= 1 condition), so a bake ordered earlier ran the
    // whole save cycle only to fail with "no rivers" at the end. The card on
    // this button names the precondition.
    bakeStartButton.disabled = bakeRunning || erosionRunCount < 1
  }

  for (const chip of bakeTierChips) {
    chip.addEventListener('click', () => {
      // Radio, not toggle: clicking the selected chip keeps it selected —
      // there is always exactly one tier to bake.
      selectedBakeFactor = Number(chip.dataset.bakeTier)
      void refreshBakeButtons()
    })
  }
  bakeStartButton.addEventListener('click', () => orderAmplification())
  void refreshBakeButtons()

  function orderAmplification(): void {
    if (bakeRunning || erosionRunCount < 1) return
    bakeRunning = true
    void refreshBakeButtons()
    // Routed through the ordinary save request: the worker owns the world
    // data, and asking it here is the same question the save button asks.
    // pendingSaveTarget is forced away from 'server' so a bake never uploads.
    // (Still an array downstream — the order machinery predates the
    // single-select chips and one entry rides it fine.)
    pendingSaveTarget = 'download'
    pendingBakeFactors = [selectedBakeFactor]
    void saveWorld()
  }

  function pickLocalWorldFile(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.zip'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file) void loadWorldFromZip(file)
    })
    input.click()
  }

  async function saveWorld(): Promise<void> {
    // Neither phase may be stepping: a snapshot taken mid-epoch would capture a world
    // the simulation has already moved past.
    if (tectonicsRunning || archeanRunning) return
    // Compute-on-save: bake everything the world's current pipeline stage allows,
    // independent of which panels were visited. Climate/hydrology/ecology need
    // eroded terrain (same gate as their panels) — pre-erosion, only elevation is
    // baked. No panel switch: the computes run in the worker regardless of the view.
    if (erosionRunCount >= 1) {
      saveChainActive = true
      try {
        await awaitCompute((r) => { climateResolve = r }, requestClimate)
        await awaitCompute((r) => { hydrologyResolve = r }, requestHydrology)
        await awaitCompute((r) => { ecologyResolve = r }, requestEcology)
      } finally {
        saveChainActive = false
      }
    }
    postToWorker({ type: 'serializeWorld' })
  }

  // Load flow: unzip → set the UI from the recipe/status → restore the sim in
  // the worker (no replay) → the render it posts back displays the world.
  async function loadWorldFromZip(file: File): Promise<void> {
    let zip: JSZip
    let yaml: string
    let snapshot: PlateSimulationSnapshot | undefined
    let oceanAge: ArrayBuffer
    let elevation: ArrayBuffer
    // Optional: saves written before these were persisted have no such entries, and
    // the worker falls back to regenerating the mantle and starting the lattice empty
    // — exactly what every load used to do.
    let archeanPayload: { snapshot: unknown; mantle: ArrayBuffer; streak: ArrayBuffer } | undefined
    let mantle: ArrayBuffer | undefined
    let lattice: { accumulated: ArrayBuffer; lockedEpochs: ArrayBuffer; lastClassCode: ArrayBuffer } | undefined
    // The mesh terrain (formatVersion 3); a save without one restores the
    // raster alone, as every save did before.
    let meshPayload: MeshPayload | undefined
    try {
      zip = await JSZip.loadAsync(file)
      const yamlFile = zip.file('world.yaml')
      const archeanFile = zip.file('archean.json')
      const stateFile = zip.file('state.json')
      const oceanFile = zip.file('oceanAge.f32')
      const elevFile = zip.file('elevation.f32')
      if (!yamlFile || !elevFile) throw new Error('missing files')
      if (archeanFile) {
        // Archean save: no plate simulation, no ocean age, no lattice.
        const mantleF = zip.file('archean.mantle.f32')
        const streakF = zip.file('archean.streak.i16')
        if (!mantleF || !streakF) throw new Error('missing files')
        archeanPayload = {
          snapshot: JSON.parse(await archeanFile.async('string')),
          mantle: await mantleF.async('arraybuffer'),
          streak: await streakF.async('arraybuffer'),
        }
      }
      yaml = await yamlFile.async('string')
      elevation = await elevFile.async('arraybuffer')
      if (!archeanPayload) {
        if (!stateFile || !oceanFile) throw new Error('missing files')
        snapshot = JSON.parse(await stateFile.async('string'))
        oceanAge = await oceanFile.async('arraybuffer')
        const mantleFile = zip.file('mantle.f32')
        mantle = mantleFile ? await mantleFile.async('arraybuffer') : undefined
        const accFile = zip.file('lattice.acc.f32')
        const lockFile = zip.file('lattice.lock.i16')
        const clsFile = zip.file('lattice.class.i8')
        lattice = accFile && lockFile && clsFile
          ? { accumulated: await accFile.async('arraybuffer'), lockedEpochs: await lockFile.async('arraybuffer'), lastClassCode: await clsFile.async('arraybuffer') }
          : undefined
        const nodesFile = zip.file('mesh/nodes.f32')
        const connFile = zip.file('mesh/connectivity.bin')
        const zFile = zip.file('mesh/z.f32')
        if (nodesFile && connFile && zFile) {
          const nodes = await nodesFile.async('arraybuffer')
          const columnFile = zip.file('mesh/column.bin')
          meshPayload = { count: nodes.byteLength / 8, nodes, connectivity: await connFile.async('arraybuffer'), z: await zFile.async('arraybuffer'), column: columnFile ? await columnFile.async('arraybuffer') : undefined }
        }
      }
    } catch {
      ctx.notifications.show({ message: t('notify.open.invalidFile'), icon: '/icons/folder.png', durationMs: 6000 })
      return
    }

    // Past the point where the archive can turn out not to be a world.
    worldCreated = true
    closeWorldChooser()
    // An opened world lands on the mantle, NOT on step 0: that step warns that
    // changing it discards the simulation, and dropping someone there the
    // moment they open a finished world is an invitation to destroy it.
    showPanel(GENESIS_PANEL_INDEX)

    stopSim()
    // Drop any pending debounced regenerate — it would fire an `init` after the
    // restore and overwrite the loaded world.
    if (regenerateTimer !== undefined) clearTimeout(regenerateTimer)
    ctx.notifications.clearAll()
    overlay.clearMarkers()
    invalidateAfter('tectonics')

    const seed = readYamlValue(yaml, 'spec.seed') ?? ''
    // One read of the recipe instead of a regex per key, with every gap filled by
    // the control's declared default.
    //
    // That last part is a deliberate change (2026-08-09). Genesis and erosion used
    // to fall back to whatever the slider happened to show while the other eight
    // fields fell back to their default — two rules for one question, with nothing
    // saying why. A missing key means the save predates the knob, and those worlds
    // were generated with its default; keeping the user's last slider position
    // instead makes loading depend on what they were doing beforehand.
    const spec = specFromYaml(yaml, seed)
    seedInput.value = seed
    // A world saved before step 0 existed was named after its seed, so this
    // reads back as it always did rather than needing a migration.
    worldName = readYamlValue(yaml, 'metadata.name') ?? seed
    worldNameInput.value = worldName
    // Identity, or a derived one for a save written before the field existed.
    // Deriving rather than rolling a fresh id is what keeps the same legacy
    // file opened on two machines a SINGLE world in the store — see
    // identity.deriveWorldUid.
    worldUid = readYamlValue(yaml, 'metadata.uid') || deriveWorldUid(new Uint8Array(elevation))
    worldRevision = Number(readYamlValue(yaml, 'status.revision') ?? 0)
    // Both 8K preconditions just changed: this world now has an identity, and
    // one opened FROM the server is by definition stored there. Without this
    // the buttons keep answering for the empty screen they were built on —
    // which reads as "needs a server" while a server is plainly working.
    //
    // The status is RE-PROBED first rather than read from the shared cache.
    // That cache is resolved once per page load and never expires on its own,
    // so a probe that failed while the server was still coming up would keep
    // reporting "no server" for the rest of the session. Opening a world is
    // the right moment to ask again — and if it came from the server, it is
    // also proof the answer should be yes.
    void refreshServerStatus().then(() => refreshBakeButtons())
    // If this world already HAS a baked network, preview it rather than the
    // 2k one. The key comes from the archive that is right here, read through
    // the same reader the map and the baker use — deriving it from the loaded
    // rasters instead would hash raw floats where every reader hashes the
    // stored (quantised) precipitation, and find nothing for ever.
    //
    // Deliberately after everything else and unawaited: it is a nicety, the
    // load must not wait on a zip being parsed a second time, and a world with
    // no artifact simply keeps its own rivers.
    // Asked as the narrow question it is. `readWorldInputs` would decode seven
    // layers — including the full-res biome raster — to hand back an id and a
    // slider value; opening the world and asking for its identity touches
    // elevation and precipitation and stops there.
    void file.arrayBuffer()
      .then((bytes) => openWorld(bytes))
      .then(async (loaded) => {
        if (loaded) return adoptBestBakedRivers(loaded.recipe.worldUid, await loaded.worldId())
      })
      .catch(() => undefined)
    mantleVigourInput.value = String(spec.values['genesis.mantleVigour'])
    waterInput.value = String(spec.values['genesis.water'])
    obliquityInput.value = String(spec.values['planet.obliquity'])
    rotationInput.value = String(spec.values['planet.rotation'])
    // How far the Archean got, read from whichever snapshot the file carries — the yaml
    // used to hold a second copy of this under spec. An Archean save reopens IN the
    // Archean, so the tectonics panel must still be able to finalise it.
    lastArcheanEpochs = archeanPayload ? (archeanPayload.snapshot as { epoch: number }).epoch : (snapshot?.archeanEpochs ?? 0)
    // A save WITH an Archean payload reopens inside the Archean, so the Tectonics
    // panel must still be able to commit it. A save without one is already past
    // that point — and saying so is what stops the panel from trying to commit an
    // Archean that ended before this file was written.
    archeanFinalised = !archeanPayload
    // A file carries the world as it stood, never the hand-over behind it — so
    // there is nothing for the tectonics reset to rewind to, whichever phase the
    // save is in.
    hasHandover = false
    setArcheanRunning(false)
    tempBandInput.value = String(spec.values['planet.greenhouse'])
    humidityInput.value = String(spec.values['climate.humidity'])
    contrastInput.value = String(spec.values['climate.contrast'])
    alluviumInput.value = String(spec.values['tectonics.alluvium'])
    rockContrastInput.value = String(spec.values['tectonics.rockContrast'])
    carryingCapacityInput.value = String(spec.values['ecology.carryingCapacity'])
    concentrationInput.value = String(spec.values['ecology.concentration'])
    provinceInput.value = String(spec.values['ecology.provinceStrength'])
    for (const f of ECOLOGY_WEIGHT_FIELDS) abundance.set(f, Number(spec.values[ecologyWeightPath(f).replace('spec.', '')]))
    syncSliderLabels()
    erosionRunCount = Number(readYamlValue(yaml, 'status.erosionRun') ?? 0)
    // lastEpoch is set from the restore render's reported epoch (status
    // .tectonicsRun == the snapshot's epoch), so no need to set it here.

    markCleanOnNextRender = true
    restoredFromSave = true
    postToWorker({ type: 'restoreWorld', seed, snapshot: snapshot!, oceanAge: oceanAge!, elevation, mantle, lattice, mesh: meshPayload, archean: archeanPayload as never, mantleDiffusion: vigourToDiffusion(Number(mantleVigourInput.value)) })
  }


  // Dragging the band slider live-recomputes the climate (debounced) once a
  // world exists — the worker no-ops if there's no elevation yet. Recomputes
  // only while not running tectonics (topography would be mid-change).
  let climateDebounce: ReturnType<typeof setTimeout> | undefined
  tempBandInput.addEventListener('input', () => {
    const v = Number(tempBandInput.value)
    tempBandLabel.textContent = v > 0 ? `+${v}` : String(v)
    clearTimeout(climateDebounce)
    climateDebounce = setTimeout(requestPlanetForcing, 150)
  })
  // Humidity + contrast: percentage sliders, same debounced live-recompute.
  const wireClimateSlider = (input: HTMLInputElement, label: HTMLElement): void => {
    input.addEventListener('input', () => {
      label.textContent = input.value
      if (tectonicsRunning) return
      clearTimeout(climateDebounce)
      climateDebounce = setTimeout(requestClimate, 150)
    })
  }
  wireClimateSlider(humidityInput, humidityLabel)
  wireClimateSlider(contrastInput, contrastLabel)

  // Ecology top sliders (carrying capacity + concentration): live-recompute
  // (debounced) — cheap (a single pass over the coarse climate grid). Concentration
  // shows a signed value (+ clumped / − even).
  let ecologyDebounce: ReturnType<typeof setTimeout> | undefined
  const scheduleEcology = (): void => {
    if (tectonicsRunning) return
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
    selectedEcologyField = pickedEcologyField
    updateOverlays()
  }

  // THE ABUNDANCE NUDGES ARE VALUES, NOT CONTROLS. There are thirteen of them
  // and one slider: the slider shows whichever resource the overlay picker is
  // painting, and writes into this map. Thirteen hidden inputs would have done
  // the same and made the DOM the store, which is what the fold-out was — three
  // category buttons revealing up to four sliders, listing every resource a
  // SECOND time next to the picker that already lists them all.
  const abundance = new Map<EcologyFieldId, number>(ECOLOGY_WEIGHT_FIELDS.map((f) => [f, ECOLOGY_ABUNDANCE.default]))
  const abundanceRow = root.querySelector<HTMLElement>('[data-value="abundance-row"]')!
  const abundanceLabel = root.querySelector<HTMLElement>('[data-value="abundance-label"]')!
  const abundanceValue = root.querySelector<HTMLElement>('[data-value="abundance-value"]')!
  const abundanceInput = root.querySelector<HTMLInputElement>('.abundance-input')!

  // Point the slider at a field. Called when the pick changes and when a save is
  // read — never on hover, because hovering a lever previews the aggregate and
  // the slider would flick away from the resource being tuned.
  function showAbundanceFor(field: EcologyFieldId): void {
    const value = abundance.get(field)
    abundanceRow.hidden = value === undefined
    if (value === undefined) {
      // Emptied rather than left standing: the row is hidden, and a name left
      // in it would be a stale answer to "which resource" the moment anything
      // showed it again.
      abundanceLabel.textContent = ''
      return
    }
    abundanceLabel.textContent = t('generator.ecology.fieldAbundance', { label: t(`resource.${field}.label` as TKey) })
    abundanceRow.dataset.help = `resource.${field}`
    abundanceInput.value = String(value)
    abundanceValue.textContent = String(value)
  }
  abundanceInput.addEventListener('input', () => {
    abundance.set(pickedEcologyField, Number(abundanceInput.value))
    abundanceValue.textContent = abundanceInput.value
    scheduleEcology()
  })

  // The three main levers preview the aggregate on hover. Told apart from the
  // fold-out's nudge rows — which carry data-ecofield too — by the class the
  // column's renderer gives them, not by their depth: they sit in a section
  // now, so "direct child" stopped being true.
  const ecologyPanel = root.querySelector<HTMLElement>('[data-stage="ecology"]')!
  for (const el of ecologyPanel.querySelectorAll<HTMLElement>('.gen-param[data-ecofield]')) {
    el.addEventListener('mouseenter', () => previewField(el.dataset.ecofield as EcologyFieldId))
  }
  // Leaving the whole panel clears the preview (moving between sliders keeps it,
  // so no flicker) — the previewed overlay disappears when the mouse is away.
  ecologyPanel.addEventListener('mouseleave', clearPreview)

  // Migration panel: 3 race enable/disable icon-toggles + the 3 sliders. Spread +
  // sea-crossing recompute (debounced); arrow threshold is a render-only knob
  // (the arrow tree — Phase 3), so it just recomposites.
  const migrationRacesContainer = root.querySelector<HTMLElement>('[data-value="migration-races"]')!
  MIGRATION_RACES.forEach((race, i) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'icon-button ecology-cat is-active'
    // Species name + help from the catalog (species.*), and data-help so
    // the shared hover card explains what clicking one does.
    // The key stays on the button, not just its answer, so a language switch
    // finds it again (see i18n/relabel) — the icon carries no word of its own.
    btn.dataset.tAria = `species.${race.id}.label`
    btn.setAttribute('aria-label', t(`species.${race.id}.label` as TKey))
    btn.dataset.help = `species.${race.id}`
    const img = document.createElement('img')
    img.src = `/icons/${race.icon}.png`
    img.alt = ''
    btn.appendChild(img)
    btn.addEventListener('click', () => {
      migrationRaceEnabled[i] = !migrationRaceEnabled[i]
      btn.classList.toggle('is-active', migrationRaceEnabled[i])
      requestMigration()
    })
    migrationRacesContainer.appendChild(btn)
  })

  // EVERYTHING THE SCREEN SAYS ITSELF, said again — what onLocaleChange calls
  // after `relabel` has done the markup.
  //
  // A string that stands in the markup carries its key, and relabel finds it.
  // A string the screen COMPOSES does not: a button that says whether it is
  // running, a label built from two keys, the legend beside the map. Those
  // exist only as the answer, and the one way back to the question is to ask it
  // again.
  //
  // One function rather than a list inside onLocaleChange, because that list
  // does not grow by itself. Three of these were missing, and the two run
  // buttons carried a comment saying they followed a language switch while
  // nobody called them.
  function sayScreen(): void {
    setArcheanRunning(archeanRunning)
    sayTectonicsButton(tectonicsRunning)
    showAbundanceFor(pickedEcologyField)
    // The species buttons are an icon and an accessible name, and they live in
    // the old panel row, which relabel(sidebar.body) does not reach.
    relabel(migrationRacesContainer)
    // The pill's words are read from the catalog on every update.
    updateProgress()
    renderLegends()
  }
  let migrationDebounce: ReturnType<typeof setTimeout> | undefined
  const scheduleMigration = (): void => {
    if (tectonicsRunning) return
    clearTimeout(migrationDebounce)
    migrationDebounce = setTimeout(requestMigration, 150)
  }
  migrationSpreadInput.addEventListener('input', () => { migrationSpreadLabel.textContent = migrationSpreadInput.value; scheduleMigration() })
  migrationSeaInput.addEventListener('input', () => { migrationSeaLabel.textContent = migrationSeaInput.value; scheduleMigration() })
  migrationThresholdInput.addEventListener('input', () => { migrationThresholdLabel.textContent = migrationThresholdInput.value; updateOverlays() })

  // Per-panel reset: that stage's controls back to their declared defaults, then
  // recompute. Which controls those are comes from the stage table — see resetInputs.
  resetClimateButton.addEventListener('click', () => {
    resetInputs('climate')
    requestClimate()
  })
  resetEcologyButton.addEventListener('click', () => {
    resetInputs('ecology')
    // The thirteen abundance nudges are not named controls — they share one range
    // and reach the save as a group (ECOLOGY_ABUNDANCE_GROUPS), so they are not in
    // the stage's `inputs` and are reset here.
    for (const f of ECOLOGY_WEIGHT_FIELDS) abundance.set(f, ECOLOGY_ABUNDANCE.default)
    showAbundanceFor(pickedEcologyField)
    requestEcology()
  })
  resetMigrationButton.addEventListener('click', () => {
    resetInputs('migration')
    migrationRaceEnabled.fill(true)
    for (const btn of migrationRacesContainer.querySelectorAll('.ecology-cat')) btn.classList.add('is-active')
    migrationOrigins = [] // re-auto-place at the default cradles
    if (lastEcologyFields.carryingCapacity) autoPlaceMigrationOrigins()
    requestMigration()
  })

  // --- Phase 2b: drag a migration origin marker to reposition it ---
  const originGhost = document.createElement('div')
  originGhost.className = 'migration-origin-ghost'
  originGhost.hidden = true
  root.appendChild(originGhost)
  let draggingOriginRace = -1

  // Pointer → full-res map texel (Babylon picking; wraps with the torus tiling).
  const pointerToTexel = (): { mx: number; my: number } | null => {
    const pick = scene.pick(scene.pointerX, scene.pointerY)
    const uv = pick?.hit ? pick.getTextureCoordinates() : null
    return uv ? { mx: uv.x * MAP_WIDTH, my: uv.y * MAP_HEIGHT } : null
  }
  // Nearest land cell (coarse grid) to a texel; spirals out if it lands on ocean.
  const snapToLandCell = (mx: number, my: number): number => {
    const cc = lastEcologyFields.carryingCapacity
    if (!cc) return -1
    const rx = ecologyResX
    const ry = ecologyResY
    const wrap = (i: number, m: number): number => ((i % m) + m) % m
    const gx0 = wrap(Math.floor((mx / MAP_WIDTH) * rx), rx)
    const gy0 = wrap(Math.floor((my / MAP_HEIGHT) * ry), ry)
    const isLand = (i: number): boolean => cc[i] !== ECOLOGY_OCEAN
    if (isLand(gy0 * rx + gx0)) return gy0 * rx + gx0
    for (let r = 1; r < Math.max(rx, ry); r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const ni = wrap(gy0 + dy, ry) * rx + wrap(gx0 + dx, rx)
        if (isLand(ni)) return ni
      }
    }
    return -1
  }
  scene.onPointerObservable.add((info) => {
    if (panelIndex !== MIGRATION_PANEL_INDEX || !lastMigration) return
    const { resX, resY } = lastMigration
    if (info.type === PointerEventTypes.POINTERDOWN) {
      const t = pointerToTexel()
      if (!t) return
      const hitR = MAP_WIDTH * 0.03
      let best = -1
      let bestD = hitR
      for (const o of migrationOrigins) {
        if (!migrationRaceEnabled[o.race]) continue
        const gy = Math.floor(o.cell / resX)
        const gx = o.cell - gy * resX
        const ox = ((gx + 0.5) / resX) * MAP_WIDTH
        const oy = ((gy + 0.5) / resY) * MAP_HEIGHT
        const dx = Math.min(Math.abs(t.mx - ox), MAP_WIDTH - Math.abs(t.mx - ox))
        const dy = Math.min(Math.abs(t.my - oy), MAP_HEIGHT - Math.abs(t.my - oy))
        const d = Math.hypot(dx, dy)
        if (d < bestD) { bestD = d; best = o.race }
      }
      if (best >= 0) {
        draggingOriginRace = best
        setCameraPanEnabled(false)
        const [r, g, b] = MIGRATION_RACES[best].rgb
        originGhost.style.background = `rgb(${r},${g},${b})`
        originGhost.style.left = `${info.event.clientX}px`
        originGhost.style.top = `${info.event.clientY}px`
        originGhost.hidden = false
      }
    } else if (info.type === PointerEventTypes.POINTERMOVE && draggingOriginRace >= 0) {
      originGhost.style.left = `${info.event.clientX}px`
      originGhost.style.top = `${info.event.clientY}px`
    } else if (info.type === PointerEventTypes.POINTERUP && draggingOriginRace >= 0) {
      const t = pointerToTexel()
      originGhost.hidden = true
      setCameraPanEnabled(true)
      const race = draggingOriginRace
      draggingOriginRace = -1
      if (t) {
        const cell = snapToLandCell(t.mx, t.my)
        const o = migrationOrigins.find((o) => o.race === race)
        if (cell >= 0 && o) { o.cell = cell; requestMigration() }
      }
    }
  })

  const regenerate = (): void => {
    stopSim()
    ctx.notifications.clearAll()
    overlay.clearMarkers()
    invalidateAfter('tectonics')
    migrationOrigins = [] // fresh world → re-auto-place origins on the next migration open
    erosionRunCount = 0
    // A genuinely different world, so it must not inherit the previous one's
    // identity — otherwise saving would overwrite that world on the server.
    // Note this is regenerate() only: running more tectonics or resetting
    // erosion also zero erosionRunCount, but those are the SAME world evolving.
    worldUid = ''
    worldRevision = 0
    archeanFinalised = false
    hasHandover = false
    markCleanOnNextRender = true
    initArchean(seedInput.value, Number(mantleVigourInput.value), Number(waterInput.value))
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
  // A reset inside a panel undoes THAT panel's work and returns its own input —
  // here, the world exactly as the Archean handed it over. It used to call
  // `regenerate`, which restarts the Archean at an epoch that has no crust yet, so
  // pressing reset in the tectonics panel deleted every continent.
  resetButton.addEventListener('click', () => {
    // A world opened from a file has no hand-over behind it — the save carries the
    // world as it stood, not the state tectonics started from. Say so rather than
    // letting the button look broken; a control that silently does nothing is the
    // same defect the Genesis save button had.
    if (!hasHandover) {
      ctx.notifications.show({ message: 'Nothing to reset to — this world was loaded, not generated here', icon: '/icons/reset.png', durationMs: 5000 })
      return
    }
    stopSim()
    ctx.notifications.clearAll()
    overlay.clearMarkers()
    invalidateAfter('tectonics')
    migrationOrigins = []
    erosionRunCount = 0
    postToWorker({ type: 'resetStage', stage: 'tectonics' })
    updateNavState() // topography is back to the hand-over → re-lock erosion onwards
  })
  // The seed no longer rebuilds the world as you type it. It used to, because
  // it sat in the Genesis panel where every control is a live knob; in step 0
  // it is one half of the world's identity, and "Create world" is the moment
  // the answer is given. Typing a seed and watching six steps of work vanish
  // under the keystrokes is not an edit, it is an accident.
  seedInput.addEventListener('input', () => updateNavState())
  randomizeButton.addEventListener('click', () => {
    seedInput.value = randomSeed()
    // A click is not an `input` event, so the delegated listener above does not
    // see it. The title bar shows the seed, thus it must be told, the same as
    // the name dice does.
    updateSaveIndicator()
    updateNavState()
  })

  worldNameInput.addEventListener('input', () => {
    worldName = worldNameInput.value
    // Renaming touches nothing the world is made of, so it needs no rebuild —
    // only the places that say the name out loud.
    updateSaveIndicator()
    updateNavState()
  })
  rollNameButton.addEventListener('click', () => {
    worldName = randomWorldName()
    worldNameInput.value = worldName
    updateSaveIndicator()
    updateNavState()
  })

  createWorldButton.addEventListener('click', () => {
    if (isBusy()) return
    if (!worldName.trim()) {
      worldName = randomWorldName()
      worldNameInput.value = worldName
    }
    if (!seedInput.value.trim()) seedInput.value = randomSeed()
    worldCreated = true
    regenerate()
    showPanel(panelIndexOf('planet'))
  })
  mantleVigourInput.addEventListener('input', () => {
    mantleVigourLabel.textContent = mantleVigourInput.value
    regenerateDebounced()
  })
  waterInput.addEventListener('input', () => {
    waterLabel.textContent = waterInput.value
    regenerateDebounced()
  })
  // The astronomical controls act on the climate: label, then the same
  // debounced recompute the climate sliders use (which in turn marks the
  // erosion stale, as its forcing reads the same chain).
  for (const [input, label] of [[obliquityInput, obliquityLabel], [rotationInput, rotationLabel]] as const) {
    input.addEventListener('input', () => {
      label.textContent = input.value
      requestPlanetForcing()
    })
  }
  // THE PANELS ARE THE STAGES. Back steps to the previous one or leaves for the
  // title screen; next steps forward and stops at the last.
  //
  // That correspondence was always true and was expressed as arithmetic on panel
  // numbers — `index === 2`, `index < CLIMATE_PANEL_INDEX`, a title list whose
  // order had to be kept in step by hand. Declared instead: the ORDER comes from
  // the pipeline chain (STAGES), each panel says which stage it is in the markup
  // (`data-stage`), and the titles are a Record over StageId, so a stage added to
  // the chain is a compile error here rather than a panel that silently shifts.
  // Looked up BY STAGE rather than taken in document order, so the markup and the
  // chain have to agree about which panel is which instead of merely happening to.
  const panels = STEP_IDS.map((id) => {
    // `data-stage` alone, not `.panel[data-stage]`: step 0 lives in the sidebar
    // and deliberately does NOT wear the foot row's `panel` class, which is
    // what silently emptied this lookup and aborted the whole screen build.
    // The data attribute is the contract; the class is a look.
    const el = root.querySelector<HTMLElement>(`[data-stage="${id}"]`)
    if (!el) throw new Error(`no panel markup for step ${id}`)
    return el
  })
  let panelIndex = 0

  // Each more-detailed panel needs its upstream step settled, else it operates on
  // unfinished data (the hydrology test series proved rivers/lakes on un-eroded
  // terrain are badly wrong: giant undrained lakes, unnatural drainage). So the
  // forward step is gated: entering Climate/Erosion needs some tectonics,
  // everything past Erosion needs at least one erosion pass. Returns why entry
  // is blocked, or null if allowed. Values are tunable.
  const MIN_TECTONIC_EPOCHS = 30
  // The Archean's own gate. Half the world stabilised is well past the point
  // where stopping is a choice rather than an accident: the narration calls
  // 20% the opening of the window, and handing over below that leaves plate
  // tectonics a world of proto-cratons that are still dissolving.
  const MIN_ARCHEAN_STABILISED = 0.5
  const entryRequirementUnmet = (index: number): string | null => {
    const erosionPanel = panelIndexOf('erosion')
    // Nothing exists before step 0 is answered — the steps after it all work on
    // the world it names and seeds.
    if (index > panelIndexOf('world') && !worldCreated) return t('notify.gate.needsWorld')
    // Genesis hands its world to plate tectonics, so the hand-over is what
    // every later step stands on. A world opened from a file has one already,
    // which is what archeanFinalised/hasHandover answer.
    if (index >= panelIndexOf('tectonics') && !archeanFinalised && !hasHandover && archeanStabilised < MIN_ARCHEAN_STABILISED) {
      return t('notify.gate.needsArchean', { min: Math.round(MIN_ARCHEAN_STABILISED * 100), current: Math.round(archeanStabilised * 100) })
    }
    // Climate sits BEFORE erosion since the stage-2 coupling (its sliders
    // shape the erosion's water forcing), so the tectonics gate covers both:
    // climate computes on the tectonic terrain and needs one to exist.
    if (index >= panelIndexOf('climate') && index <= erosionPanel && lastEpoch < MIN_TECTONIC_EPOCHS) return t('generator.notify.needsTectonics', { min: MIN_TECTONIC_EPOCHS, current: lastEpoch })
    // Everything past Erosion, rather than the panels named one by one: the
    // gate is about the stages the user has to run for themselves. The rest
    // compute on entry, so they gate on what they are all derived from — and a
    // panel added after this one is covered without anyone remembering to.
    if (index > erosionPanel && erosionRunCount < 1) return t('generator.notify.needsErosion')
    return null
  }
  // Migration is carried as `aside`: it is reachable but not part of the chain
  // the other steps form, and it leaves the generator for a screen of its own
  // later. Dropping it from the bar now would make it unreachable — the arrows
  // that used to reach it are gone — which is a feature removed by accident
  // rather than decided.
  // The column, and step 0 moving into it. The other steps keep their controls
  // in the panel row along the foot for now; each moves in its own step, so a
  // broken one is always traceable to the step that broke it.
  const sidebar = createSidebar(root)
  // Step 0's markup carries its keys rather than its strings, so a language
  // switch can find them again (see i18n/relabel). Nothing stands in it until
  // this runs.
  const worldPanel = panels[panelIndexOf('world')]
  relabel(worldPanel)

  // The step's own overlays, as switches in the column (see OverlayList). The
  // bar over the map stays for now: it is the only door to the terrain colour
  // and to the Ecology fields, which pick ONE field rather than combining, so
  // a row of switches would say something untrue about them. Both doors drive
  // the same `overlaysOn`, and refreshOverlayBar paints both.
  //
  // Which overlays belong to a step: the stage that COMPUTES a layer owns it.
  // Erosion shows the hydrology group, because rivers and lakes are what the
  // solve produces; step 0 and Ecology show nothing, and the section hides.
  const overlayList = createOverlayList({
    onToggle: (id) => toggleOverlay(id as OverlayId),
    // One pick group, two kinds of member: a layer the step shows one at a time,
    // or — in Ecology — a resource field the one layer paints. The id says which.
    onPick: (id) => (isOverlayId(id) || id === NO_PICK ? pickExclusiveOverlay(id) : selectEcologyField(id as EcologyFieldId)),
  })
  // The steps whose controls have moved out of the panel row at the foot and
  // into the column. The rest follow one per step, in pipeline order.
  sidebar.body.append(overlayList.element, worldPanel, panels[panelIndexOf('planet')], panels[GENESIS_PANEL_INDEX], panels[TECTONICS_PANEL_INDEX], panels[CLIMATE_PANEL_INDEX], panels[panelIndexOf('erosion')], panels[ECOLOGY_PANEL_INDEX])
  relabel(sidebar.body)

  const stepBar = createStepBar(root, {
    steps: STEPS.map((s) => ({ id: s.id, aside: s.aside === true })),
    onSelect: (index) => {
      if (index === panelIndex) return
      const reason = entryRequirementUnmet(index)
      if (reason) {
        // Answered rather than refused: the bar stays clickable precisely so a
        // blocked step can say what it is waiting for.
        ctx.notifications.show({ message: reason, icon: '/icons/erosion.png', durationMs: 4000 })
        return
      }
      if (isBusy()) return
      // LEAVING GENESIS FORWARD IS WHAT ENDS THE ARCHEAN — it used to hang off
      // the next arrow, and hangs off the same gesture here: any move to a
      // later step, not merely the adjacent one.
      if (STEP_IDS[panelIndex] === 'genesis' && index > GENESIS_PANEL_INDEX) commitGenesis()
      showPanel(index)
    },
  })

  // Whether a step has actually been run. Two-valued on purpose — see the note
  // in StepBar about the third state the design draws. Each stage answers with
  // the thing that only exists once it has computed, rather than with a counter
  // kept beside it, so the bar cannot claim a step the screen does not hold.
  const stageComputed: Record<StepId, () => boolean> = {
    // Step 0 is never "computed" — it is answered. It counts as settled the
    // moment the world has both halves of its identity.
    world: () => worldName.trim() !== '' && seedInput.value.trim() !== '',
    // Answered, like step 0: its values are set, not computed.
    planet: () => worldCreated,
    genesis: () => lastArcheanEpochs > 0 || hasHandover,
    tectonics: () => lastEpoch > 0,
    climate: () => lastTemperature !== null,
    erosion: () => erosionRunCount >= 1,
    ecology: () => hasEcologyData(),
    migration: () => lastMigration !== null,
  }

  // The bar shows the whole chain at once, so it is repainted as a whole:
  // every step's status and every step's gate, from one reading of the state.
  // A per-step update would be four calls that can disagree.
  const updateNavState = (): void => {
    const busy = isBusy()
    stepBar.setState({
      current: panelIndex,
      steps: STEP_IDS.map((id, index) => {
        const settled = stageComputed[id]()
        return {
          // Step 0 reports the shape it set rather than a computation it did
          // not do, which is what the design's chip shows: "Flat · set".
          status: id === 'world'
            ? `${t('generator.world.topology.flat.label')} · ${t('generator.step.status.set')}`
            : t(settled ? 'generator.step.status.computed' : 'generator.step.status.pending'),
          settled,
          // The busy lock is the same one the controls get: stepping away
          // mid-simulation would leave a half-run stage behind.
          blocked: index !== panelIndex && (busy || entryRequirementUnmet(index) !== null),
        }
      }),
    })
  }
  // The data panels are where their own step gets computed, so entering one asks
  // for whatever is missing. Deliberately NOT derived from the chain's dependsOn,
  // even though it looks like it should be: the order matters (the pipeline caches
  // precipitation as the river source, so climate must be posted before hydrology)
  // and Ecology's branch is a continuation rather than a request — when hydrology
  // has to be recomputed, ecology follows once it lands (see handleHydrologyData)
  // instead of being asked for twice. A generic loop would lose both, and there is
  // no harness on this side to notice. See docs/design/generator-pipeline.md.
  const ensureDataFor = (index: number): void => {
    // The Planet step shows its controls on the climate: the world's own
    // once it has plates, the sample world's before.
    if (index === panelIndexOf('planet') && worldCreated && lastTemperature === null) requestPlanetForcing()
    if (index === CLIMATE_PANEL_INDEX && lastTemperature === null) requestClimate()
    // The erosion panel carries the hydrology readout: entering it with eroded
    // terrain but no rivers (a reopened session, a mid-chain revisit) computes
    // them, exactly as the settle of a pass does. Un-eroded terrain gets none —
    // rivers/lakes on it are badly wrong (the old hydrology panel's gate).
    if (index === panelIndexOf('erosion') && erosionRunCount >= 1 && lastRiverData === null) {
      if (lastTemperature === null) requestClimate()
      requestHydrology()
    }
    // Ecology reads both — productivity/biomes from climate, fish freshwater from
    // rivers and lakes.
    if (index === ECOLOGY_PANEL_INDEX) {
      if (lastTemperature === null) requestClimate()
      if (lastRiverData === null) requestHydrology()
      else if (!hasEcologyData()) requestEcology()
    }
    // Migration ensures the whole upstream chain, auto-places origins the first
    // time, then computes.
    if (index === MIGRATION_PANEL_INDEX && lastMigration === null) void ensureMigration()
  }

  // Show a panel. It navigates, asks for the data that panel needs, and sets the
  // overlay defaults for it — and since 2026-08-09 it does NOT commit anything:
  // the Archean hand-over moved to the gesture that means it (see commitGenesis).
  const showPanel = (index: number): void => {
    if (STEP_IDS[index] !== 'planet') leavePlanetPreview()
    panelIndex = index
    sidebar.setStep(STEP_IDS[index])
    // Which layers this step offers, and which of them are showing. Both come
    // from the step table (steps.ts): this used to be a grouping over there plus
    // ten lines of `overlaysOn.x = index === Y` here, which is how the column
    // came to list layers the map was already showing.
    const stepDef = step(STEP_IDS[index])
    overlayList.setRows(
      stepDef.overlays.map((id) => ({ id, helpBase: overlayKey(id), icon: OVERLAY_META[id].icon })),
      [
        // The way out of a pick group, first and the default (2026-09-22): a
        // step that paints one of its layers at a time starts painting none.
        ...(stepDef.exclusive.length > 0 ? [{ id: NO_PICK, helpBase: 'overlay.none', icon: '/icons/clear.png' }] : []),
        ...stepDef.exclusive.map((id) => ({ id, helpBase: overlayKey(id), icon: OVERLAY_META[id].icon })),
        ...stepDef.fields.map((field) => ({ id: field, helpBase: `resource.${field}`, icon: `/icons/${FIELD_ICON[field]}.png` })),
      ],
      stepDef.pickTitle,
    )
    for (const id of OVERLAY_IDS) overlaysOn[id] = stepDef.defaults.includes(id)
    // A step that paints a resource field starts on the first one it offers.
    if (stepDef.fields.length > 0) {
      selectedEcologyField = stepDef.fields[0]
      pickedEcologyField = selectedEcologyField
      showAbundanceFor(pickedEcologyField)
    }
    ecologyHoverField = null // drop any stale hover preview when switching steps
    panels.forEach((panel, i) => {
      panel.hidden = i !== index
    })
    ensureDataFor(index)
    // The Archean's narration in the pill belongs to the Genesis step: it
    // describes what the Archean is doing right now, which stops being true
    // the moment the phase is handed over (see updateProgress).
    updateProgress()
    if (lastColoredBase) updateOverlays()
    updateNavState()
  }

  // Cursor readout over the map (reusable module; reports the hovered cell's
  // height plus any active climate overlays). Always enabled, and — since the
  // height line is there from the first render on — now effectively always
  // showing, where it used to self-hide until a data-bearing overlay was on.
  // That's deliberate on a worldgen tool screen: a height readout is what makes
  // the metre calibration checkable by hovering.
  hoverTooltip = createMapHoverTooltip({
    scene,
    host: root,
    textureWidth: MAP_WIDTH,
    textureHeight: MAP_HEIGHT,
    describe: describeCell,
  })

  // Control-help tooltips: one delegated listener on the screen root drives the
  // hover help card for every element carrying data-help (the overlay icons for
  // now; more controls as they get keys).
  const helpTooltip = createHelpTooltip(root)

  showPanel(0)

  // Once at startup, so the title bar opens showing the seed and "not saved
  // yet" rather than an empty strip waiting for the first slider to move.
  //
  // It has to run HERE, not beside createTitleBar and not beside the `input`
  // listener: worldSignature() reads readSpec(), which reads `abundance` —
  // a `const` declared further down this function. Called any earlier it hits
  // that binding's temporal dead zone, the ReferenceError aborts the whole
  // screen build, and the generator comes up blank.
  updateSaveIndicator()

  // Last, so the list is drawn over a generator that is already standing: the
  // world behind it is what "Neue Welt erstellen" hands over, with nothing to
  // wait for. Through the same door as every later opening.
  openWorldChooser()

  // LEAVING GENESIS FORWARD IS WHAT ENDS THE ARCHEAN: plate tectonics begins, seeds
  // are placed on the convection cells, and the rafts/ages/mantle carry over
  // (finalizeArchean). Stopping the Archean is only ever a pause; this is the
  // commit, and the Genesis panel's reset button is the way back.
  //
  // It used to live inside showPanel, which made a VIEW function the thing that
  // performed an irreversible step — so every path that merely displayed the
  // Tectonics panel ran it, including stepping BACK to it from Erosion and any
  // future caller that just wanted to show a panel. It ran on those paths only
  // harmlessly, and only because a flag happened to be set by then; that flag
  // carrying two meanings is what broke loading a world earlier today.
  //
  // Now it hangs off the gesture that means it: pressing forward out of Genesis.
  const commitGenesis = (): void => {
    if (lastArcheanEpochs <= 0 || archeanFinalised) return
    archeanFinalised = true
    // This IS the hand-over: the worker keeps a snapshot of it, so from here on
    // tectonics can be rewound to this moment.
    hasHandover = true
    postToWorker({ type: 'genesisStop' })
    postToWorker({ type: 'genesisFinalize' })
    setArcheanRunning(false)
    // Plate outlines and continent names unblock here — this is where plates and
    // continents start existing.
    updateOverlays()
  }


  ctx.overlay.appendChild(root)

  return {
    scene,
    dispose() {
      stopSim()
      sidebar.dispose()
      stepBar.dispose()
      worldChooser.dispose()
      titleBar.dispose()
      helpTooltip.dispose()
      storagePanel.dispose()
      serverIndicator.dispose()
      saveMenu.dispose()
      confirmDialog.dispose()
      window.removeEventListener('beforeunload', onBeforeUnload)
      hoverTooltip?.dispose()
      riverLayer?.dispose()
      overlay.dispose()
      mapView.dispose()
      worker.terminate()
      // scene.dispose() doesn't remove the camera module's own 'wheel'
      // listener on the shared canvas, so the rig has to be disposed by hand
      // (see orbitSwoopCamera's equivalent comment).
      disposeCamera()
      scene.dispose()
    },
  }
}
