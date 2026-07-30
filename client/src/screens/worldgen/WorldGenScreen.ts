import { Color4, PointerEventTypes, Scene } from '@babylonjs/core'
import { createHexMapCamera } from '../../camera/hexMapCamera'
import { createToroidalMapView } from '../../map/ToroidalMapView'
import { createMapHoverTooltip } from '../../map/MapHoverTooltip'
import { createToroidalRibbonOverlay } from '../../map/ToroidalRibbonOverlay'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { MAP_HEIGHT, MAP_WIDTH } from '../../worldgen/core/mapConfig'
import JSZip from 'jszip'
import type { WorkerArcheanStatusMessage, WorkerClimateDataMessage, WorkerHydrologyDataMessage, WorkerEcologyDataMessage, WorkerMigrationDataMessage, WorkerErosionProgressMessage, WorkerInboundMessage, WorkerRenderedMessage, WorkerWorldDataMessage } from '../../worldgen/plateSimulationWorker'
import { drawContinentLabels } from '../../worldgen/render/continentLabelRenderer'
import type { ContinentLabelPlacement } from '../../worldgen/render/continentLabelRenderer'
import { elevationToMeters, metersToElevation, waterSliderToOffsetM } from '../../worldgen/elevation/elevationScale'
import { formatWorldAge, worldAgeMa } from '../../worldgen/core/worldTime'
import type { SimEvent, PlateSimulationSnapshot } from '../../worldgen/tectonics/plateSimulation'
import { eventCategory } from '../../worldgen/tectonics/plateSimulation'
import { MapOverlayCompositor } from '../../ui/mapOverlay/MapOverlayCompositor'
import { temperatureColor, precipitationColor, amplitudeColor, monsoonColor, temperatureLegendStops, precipitationLegendStops, amplitudeLegendStops, monsoonLegendStops } from '../../worldgen/climate/climateColors'
import { OCEAN_PRECIP } from '../../worldgen/climate/precipitation'
import { OCEAN_AMPLITUDE } from '../../worldgen/climate/seasonality'
import { biomeColor, biomeLabel, biomeLegend, Biome } from '../../worldgen/climate/biomes'
import { ECOLOGY_FIELD_META, ecologyFieldColor, ecologyFieldLegendStops } from '../../worldgen/ecology/ecologyColors'
import { ECOLOGY_OCEAN, type EcologyFieldId } from '../../worldgen/ecology/ecologyField'
import { WORLD_LAYERS, bakeLayer, downsampleMax } from '../../worldgen/worldSave/worldLayers'
import { t, type TKey } from '../../i18n/i18n'
import { createHelpTooltip } from '../../ui/help/HelpTooltip'
import './worldgen.css'

// The ecology per-field abundance weights persisted in world.yaml (keys `w_<field>`).
// The one grouping of ecology resources — used by the panel's abundance fold-out, by
// the overlay bar's Ecology category, and by the nesting in world.yaml.
//
// It was briefly two lists, and they had already drifted: the panel called the third
// group `metals` and ordered prestige silver-gold-gems, the save called it `metal` and
// ordered it gold-silver-gems. One of them names a key in the save format, so a
// divergence here is not cosmetic.
const ECOLOGY_CATEGORIES: readonly { readonly id: string; readonly icon: string; readonly fields: readonly EcologyFieldId[] }[] = [
  { id: 'subsistence', icon: 'wheat', fields: ['arable', 'fish', 'game', 'pasture'] },
  { id: 'material', icon: 'stone_axe', fields: ['timber', 'salt', 'toolStone'] },
  { id: 'metal', icon: 'ecology', fields: ['copper', 'tin', 'iron'] },
  { id: 'prestige', icon: 'crown', fields: ['gold', 'silver', 'gems'] },
]
// Flat list DERIVED from the grouping, so a field can never be in the save under one
// group and in the UI under none.
const ECOLOGY_WEIGHT_FIELDS: EcologyFieldId[] = ECOLOGY_CATEGORIES.flatMap((c) => [...c.fields])
const ecologyWeightPath = (field: EcologyFieldId): string =>
  `spec.ecology.${ECOLOGY_CATEGORIES.find((c) => c.fields.includes(field))!.id}.${field}`
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
const MIGRATION_RACES: { id: string; label: string; icon: string; rgb: [number, number, number] }[] = [
  { id: 'human', label: 'Humans', icon: 'human', rgb: [86, 116, 200] },
  { id: 'dwarf', label: 'Dwarves', icon: 'dwarf', rgb: [96, 176, 92] },
  { id: 'beaver', label: 'Beavers', icon: 'beaver', rgb: [216, 76, 58] },
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
// Mantle vigour — the one Genesis knob besides the seed and water.
//
// It sets how hard the Archean mantle stirs each epoch (ArcheanParams.diffusion),
// inverted for the UI so the slider reads "more vigorous → higher": less stirring
// leaves a finer-grained buoyancy field, so more and smaller convection cells, so
// more and smaller cratons and, after the handover, more and smaller plates. Turn it
// down and crust collects into fewer, larger continents instead.
//
// It used to set createMantleField's INITIAL smoothing, on the reasoning that this
// left the tuned epoch dynamics alone. Measurement showed the per-epoch diffusion
// erases that initial smoothing within a few dozen epochs — nine tenths of the
// difference gone by epoch 40, against a phase nobody stops before epoch 150 — and a
// full sweep confirmed the slider moved craton count, plate count and land fraction
// no more than two seeds at the same setting differed. See DEFAULT_INITIAL_SMOOTHING.
//
// This replaced four sliders — plate count, land fraction, craton count and
// clustering — that all specified an OUTCOME. Those are now emergent: plate count
// falls out of the convection cells (finalizeArchean), and land fraction out of
// crust production against recycling. See docs/decisions/archean-genesis.md.
const MANTLE_VIGOUR_MIN = 1
const MANTLE_VIGOUR_MAX = 10
// 4, not the middle of the range: it is the setting vigourToDiffusion maps to exactly
// 1.0, which is what the Archean ran at before this knob existed and what the tectonic
// phase still uses. "Default" therefore means "unchanged behaviour" rather than
// "halfway along a slider". It sits below centre because the response curve is
// quadratic, so most of the useful travel lies above it.
const MANTLE_VIGOUR_DEFAULT = 4
// Water delivered to the planet, 0..100 with 50 = Earth-like. Together with crust
// production this is what sets the land fraction — but as a RESULT of two physical
// quantities rather than as a number you dial. See elevationScale.WATER_OFFSET_MAX_M.
const WATER_DEFAULT = 50
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
  MANTLE_DIFFUSION_MAX * ((MANTLE_VIGOUR_MAX - vigour) / (MANTLE_VIGOUR_MAX - MANTLE_VIGOUR_MIN)) ** MANTLE_DIFFUSION_CURVE

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

export const createWorldGenScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)

  const { dispose: disposeCamera, getFocus: getCameraFocus, setPanEnabled: setCameraPanEnabled } = createHexMapCamera({
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
            <img src="/icons/dice.png" alt="" />
          </button>
        </span>
      </label>
      <label class="field field--icon-row">
        <span class="field-row">
          <button type="button" class="icon-button" data-action="reset-archean" aria-label="Restart the Archean">
            <img src="/icons/reset.png" alt="" />
          </button>
          <span class="field field--inline">
            <span class="field-label">Mantle vigour: <span data-value="mantle-vigour-label">${MANTLE_VIGOUR_DEFAULT}</span></span>
            <input
              type="range"
              class="mantle-vigour-input"
              min="${MANTLE_VIGOUR_MIN}"
              max="${MANTLE_VIGOUR_MAX}"
              step="1"
              value="${MANTLE_VIGOUR_DEFAULT}"
            />
          </span>
          <span class="field field--inline">
            <span class="field-label">Water: <span data-value="water-label">${WATER_DEFAULT}</span></span>
            <input type="range" class="water-input" min="0" max="100" step="1" value="${WATER_DEFAULT}" />
          </span>
          <button type="button" class="icon-button" data-action="toggle-archean" aria-label="Run the Archean">
            <img src="/icons/mantle.png" alt="" />
          </button>
          <span class="tectonics-stats">
            <span class="stat"><span class="stat-num"><span data-value="stat-crust">–</span><span class="stat-unit">%</span></span><span class="stat-label">Crust</span></span>
            <span class="stat"><span class="stat-num" data-value="stat-cratons">–</span><span class="stat-label">Cratons</span></span>
            <span class="stat"><span class="stat-num"><span data-value="stat-stabilised">–</span><span class="stat-unit">%</span></span><span class="stat-label">Stabilised</span></span>
            <span class="stat"><span class="stat-num" data-value="stat-world-age">–</span><span class="stat-label">Age</span></span>
          </span>
        </span>
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
            <span class="stat"><span class="stat-num"><span data-value="stat-land">–</span><span class="stat-unit">%</span></span><span class="stat-label">Land</span></span>
            <span class="stat"><span class="stat-num" data-value="stat-continents">–</span><span class="stat-label">Continents</span></span>
            <span class="stat"><span class="stat-num" data-value="stat-plates">–</span><span class="stat-label">Plates</span></span>
            <span class="stat"><span class="stat-num" data-value="stat-tect-age">–</span><span class="stat-label">Age</span></span>
          </span>
        </span>
      </label>
    </div>
    <div class="panel" data-panel="2">
      <button type="button" class="icon-button panel-reset" data-action="reset-erosion" aria-label="Revert to tectonics result">
        <img src="/icons/reset.png" alt="" />
      </button>
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
          <button type="button" class="icon-button" data-action="erode" aria-label="Run erosion">
            <img src="/icons/erosion.png" alt="" />
          </button>
        </span>
      </label>
    </div>
    <div class="panel" data-panel="3">
      <button type="button" class="icon-button panel-reset" data-action="reset-climate" aria-label="Reset climate to defaults">
        <img src="/icons/reset.png" alt="" />
      </button>
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
      <button type="button" class="icon-button panel-reset" data-action="reset-ecology" aria-label="Reset ecology to defaults">
        <img src="/icons/reset.png" alt="" />
      </button>
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
      <!-- Generated from ECOLOGY_CATEGORIES so the ids here cannot drift from the
           ones the fold-out and world.yaml use; they already had once. -->
      <span class="ecology-cat-buttons">${ECOLOGY_CATEGORIES.map((c) => `
        <button type="button" class="icon-button ecology-cat" data-eco-cat="${c.id}" aria-label="${c.id}"><img src="/icons/${c.icon}.png" alt="" /></button>`).join('')}
      </span>
      <div class="ecology-foldout" data-value="ecology-foldout" hidden></div>
    </div>
    <div class="panel" data-panel="6">
      <button type="button" class="icon-button panel-reset" data-action="reset-migration" aria-label="Reset migration to defaults">
        <img src="/icons/reset.png" alt="" />
      </button>
      <label class="field">
        <span class="field-label">Spread: <span data-value="migration-spread-label">120</span></span>
        <input type="range" class="migration-spread-input" min="20" max="400" step="10" value="120" aria-label="Migration spread extent" />
      </label>
      <label class="field">
        <span class="field-label">Arrows: <span data-value="migration-threshold-label">50</span></span>
        <input type="range" class="migration-threshold-input" min="0" max="100" step="5" value="50" aria-label="Arrow prune threshold" />
      </label>
      <label class="field">
        <span class="field-label">Sea crossing: <span data-value="migration-sea-label">30</span>%</span>
        <input type="range" class="migration-sea-input" min="0" max="100" step="5" value="30" aria-label="Sea crossing" />
      </label>
      <span class="ecology-cat-buttons" data-value="migration-races"></span>
    </div>
  `

  const seedInput = root.querySelector<HTMLInputElement>('.seed-input')!
  const mantleVigourInput = root.querySelector<HTMLInputElement>('.mantle-vigour-input')!
  const mantleVigourLabel = root.querySelector<HTMLElement>('[data-value="mantle-vigour-label"]')!
  const waterInput = root.querySelector<HTMLInputElement>('.water-input')!
  const waterLabel = root.querySelector<HTMLElement>('[data-value="water-label"]')!
  const resetArcheanButton = root.querySelector<HTMLButtonElement>('[data-action="reset-archean"]')!
  const toggleArcheanButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-archean"]')!
  const statCrust = root.querySelector<HTMLElement>('[data-value="stat-crust"]')!
  const statCratons = root.querySelector<HTMLElement>('[data-value="stat-cratons"]')!
  const statWorldAge = root.querySelector<HTMLElement>('[data-value="stat-world-age"]')!
  const statStabilised = root.querySelector<HTMLElement>('[data-value="stat-stabilised"]')!
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
  const resetClimateButton = root.querySelector<HTMLButtonElement>('[data-action="reset-climate"]')!
  const resetEcologyButton = root.querySelector<HTMLButtonElement>('[data-action="reset-ecology"]')!
  const resetMigrationButton = root.querySelector<HTMLButtonElement>('[data-action="reset-migration"]')!
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
  const migrationSpreadInput = root.querySelector<HTMLInputElement>('.migration-spread-input')!
  const migrationSpreadLabel = root.querySelector<HTMLElement>('[data-value="migration-spread-label"]')!
  const migrationThresholdInput = root.querySelector<HTMLInputElement>('.migration-threshold-input')!
  const migrationThresholdLabel = root.querySelector<HTMLElement>('[data-value="migration-threshold-label"]')!
  const migrationSeaInput = root.querySelector<HTMLInputElement>('.migration-sea-input')!
  const migrationSeaLabel = root.querySelector<HTMLElement>('[data-value="migration-sea-label"]')!
  const tempMaxLabel = root.querySelector<HTMLElement>('[data-value="temp-max"]')!
  const tempMinLabel = root.querySelector<HTMLElement>('[data-value="temp-min"]')!
  const statLand = root.querySelector<HTMLElement>('[data-value="stat-land"]')!
  const statTectAge = root.querySelector<HTMLElement>('[data-value="stat-tect-age"]')!
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
  // Latest stabilised fraction, so updateProgress can render the bar without the
  // status message being in scope.
  let archeanStabilised = 0
  // Set once the Archean has been handed over, so re-entering the Tectonics panel
  // doesn't finalise a world that is already past that point. Cleared by a
  // regenerate or an Archean reset.
  let archeanFinalised = false
  // Any worker computation in flight: tectonics ticking, an erosion pass, or a
  // climate/hydrology compute. While busy, ALL bottom-panel controls are disabled
  // except the ACTIVE process's stop button (the only allowed action).
  let erosionOpInFlight = false
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
  let erosionProgressFraction = 0
  const isBusy = (): boolean => tectonicsRunning || erosionOpInFlight || climateInFlight || hydrologyInFlight || ecologyInFlight || migrationInFlight

  // Disable every panel control while a compute runs; the running process keeps its
  // stop button live (tectonics = toggle-sim, erosion = erode, which becomes a stop).
  const updateControlsDisabled = (): void => {
    const busy = isBusy()
    randomizeButton.disabled = busy
    resetButton.disabled = busy
    resetErosionButton.disabled = busy
    resetClimateButton.disabled = busy
    resetEcologyButton.disabled = busy
    resetMigrationButton.disabled = busy
    loadWorldButton.disabled = busy
    saveWorldButton.disabled = busy
    // Stop buttons of the active process stay enabled.
    toggleSimButton.disabled = busy && !tectonicsRunning
    erodeButton.disabled = busy && !erosionOpInFlight
    // Genesis inputs (debounced-)regenerate the whole world, so lock them while busy;
    // the erosion/climate/river sliders are left live for tuning (they only affect the
    // next pass, not the one in flight).
    for (const el of [seedInput, mantleVigourInput, waterInput]) el.disabled = busy
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
      delete computeProgressFill.dataset.stage
    } else if (archeanRunning) {
      // Determinate, unlike the tectonic stepper's indeterminate bar: the Archean
      // HAS a meaningful progress measure — the stabilised fraction, which runs
      // monotonically from ~0 to ~90% across the phase. Its three-stage colour is
      // the same judgement the banner text states, from the same call.
      computeProgress.hidden = false
      computeProgress.classList.remove('is-indeterminate')
      computeProgressFill.style.width = `${Math.round(archeanStabilised * 100)}%`
      computeProgressFill.dataset.stage = archeanStage(archeanStabilised).stage
    } else if (tectonicsRunning || climateInFlight || hydrologyInFlight || ecologyInFlight || migrationInFlight) {
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
  // Entering this panel commits the Archean — see showPanel.
  const TECTONICS_PANEL_INDEX = 1
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
  // Initial-migration panel — its own step after ecology. Three races (icon toggles),
  // origins auto-placed at good cradles, least-cost dispersal → density + arrow tree.
  const MIGRATION_PANEL_INDEX = 6
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
    if (!lastCratonAge) return
    for (let y = 0; y < MAP_HEIGHT; y++) {
      const gy = Math.min(mantleResY - 1, Math.floor((y / MAP_HEIGHT) * mantleResY))
      for (let x = 0; x < MAP_WIDTH; x++) {
        const gx = Math.min(mantleResX - 1, Math.floor((x / MAP_WIDTH) * mantleResX))
        const age = lastCratonAge[gy * mantleResX + gx]
        if (age < 0) continue // ocean — no crust here
        const [r, g, b] = cratonAgeColor(age)
        const p = (y * MAP_WIDTH + x) * 4
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

  // Lake depth at which the blue tint reaches full saturation. Set just above the
  // measured 99th percentile (859 m) so the ramp spends its range on the depths
  // lakes actually have, with only genuinely deep rift basins pinned at the end.
  const LAKE_SHADE_SATURATION_M = 900

  // Lakes ARE a texture layer (filled water areas, low-frequency — texture blur
  // on zoom is far less objectionable than for thin rivers). Blue tint over cells
  // with water depth, slightly deeper = darker. lakeDepth is full-res (= map
  // resolution), so it indexes the pixel buffer directly.
  function paintLakes(data: Uint8ClampedArray): void {
    if (!lastLakeDepth) return
    for (let i = 0; i < lastLakeDepth.length; i++) {
      const d = lastLakeDepth[i]
      if (d <= 0) continue
      // Deeper → richer blue, saturating at LAKE_SHADE_SATURATION_M. Was a bare
      // `d * 6`, i.e. full saturation at 0.167 elevation units — fine when land
      // spanned most of the scale, but on the metre-anchored one that is 1500 m,
      // and the measured 90th-percentile lake is 223 m deep, so nearly every lake
      // would have rendered at the palest end of the ramp.
      const shade = Math.min(1, elevationToMeters(d) / LAKE_SHADE_SATURATION_M)
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
    const s = Math.max(0, Math.min(1, Number(migrationThresholdInput.value) / 100))
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
    { id: 'wind', label: 'Wind', enabled: false, hidden: true, paint: drawWind },
    { id: 'currents', label: 'Currents', enabled: false, hidden: true, paint: drawCurrents },
    { id: 'lakes', label: 'Lakes', enabled: false, hidden: true, paintPixels: paintLakes },
    // Events are always on — a persistent notification-coupled marker layer,
    // not a user toggle.
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
  // `labelKey` is the world.overlay catalog key (see i18n/locales/en/world.json);
  // `t(labelKey + '.label')` is the button's tooltip/aria text. The id and the key
  // slug match except 'ecology' → 'resources'. (Legend titles below are not yet
  // localized — a later step.)
  const OVERLAY_DEFS: { id: string; icon: string; labelKey: string; available: () => boolean; legend?: LegendSpec | (() => LegendSpec) }[] = [
    { id: 'terrain', icon: '/icons/colours.png', labelKey: 'world.overlay.terrain', available: () => lastColoredBase !== null },
    // Plate outlines are meaningless during the Archean (no plates exist) and, in
    // the tectonic phase, they redraw every epoch while running — which reads as
    // flicker rather than information. Available only when something is paused.
    // Available from the tectonic phase on, running or not — the plates are the thing
    // you are watching there, and hiding them mid-run (which is what `!tectonicsRunning`
    // used to do) removed them exactly when they were moving.
    //
    // In Genesis it appears only while the Archean is PAUSED, where it previews the
    // plates a handover would produce (see the worker's convectionCellSeeds call).
    // Running, it is deliberately gone: the convection reorganises every epoch, so a
    // live preview would flicker between answers none of which the world has taken.
    { id: 'boundaries', icon: '/icons/voronoi.png', labelKey: 'world.overlay.boundaries', available: () => lastBoundaryMask !== null && (archeanFinalised || !archeanRunning) },
    // Blocked during the Archean: proto-cratons are not continents yet, they merge
    // and fragment constantly, and naming something that dissolves ten epochs later
    // is noise. finalizeArchean names them all when plate tectonics begins.
    { id: 'names', icon: '/icons/continent_name.png', labelKey: 'world.overlay.names', available: () => archeanFinalised && lastRaftLabels.length > 0 },
    {
      id: 'mantle', icon: '/icons/mantle.png', labelKey: 'world.overlay.mantle', available: () => lastMantle !== null,
      legend: { type: 'swatches', title: t('world.overlay.mantle.legend.title'), items: [
        { label: t('world.overlay.mantle.legend.upwelling'), rgb: [225, 85, 55] },
        { label: t('world.overlay.mantle.legend.downwelling'), rgb: [55, 110, 210] },
      ] },
    },
    // Split out of the mantle overlay. It used to carry the field tint, the volcanic
    // cones and the plume rings under one button with one static legend — which in the
    // Genesis panel promised a "Volcano" and a "Hotspot plume" that can never appear
    // there, because the Archean has neither. Three buttons, three honest legends.
    {
      id: 'volcanoes', icon: '/icons/volcano.png', labelKey: 'world.overlay.volcanoes', available: () => lastVolcanoes.length > 0,
      legend: { type: 'swatches', title: t('world.overlay.volcanoes.legend.title'), items: [
        { label: t('world.overlay.volcanoes.legend.hotspot'), rgb: [220, 55, 30], shape: 'cone' },
        { label: t('world.overlay.volcanoes.legend.arc'), rgb: [235, 120, 30], shape: 'cone' },
        { label: t('world.overlay.volcanoes.legend.flood'), rgb: [120, 25, 20], shape: 'cone' },
      ] },
    },
    {
      id: 'hotspots', icon: '/icons/hotspot.png', labelKey: 'world.overlay.hotspots', available: () => lastHotspots.length > 0,
      legend: { type: 'swatches', title: t('world.overlay.hotspots.legend.title'), items: [
        { label: t('world.overlay.hotspots.legend.plume'), rgb: [255, 140, 0], shape: 'ring' },
      ] },
    },
    {
      id: 'cratonAge', icon: '/icons/craton.png', labelKey: 'world.overlay.cratonAge',
      // Available as soon as any crust exists, which in the Archean is within a few
      // epochs of the first upwelling standing still long enough.
      available: () => lastCratonAge !== null && lastCratonAge.some((v) => v >= 0),
      legend: { type: 'gradient', title: 'Craton age', unit: '% of world age', stops: cratonAgeLegendStops },
    },
    { id: 'temperature', icon: '/icons/temperature.png', labelKey: 'world.overlay.temperature', available: () => lastTemperature !== null, legend: { type: 'gradient', title: 'Temperature', unit: '°C', stops: temperatureLegendStops } },
    { id: 'seasonality', icon: '/icons/seasonality.png', labelKey: 'world.overlay.seasonality', available: () => lastSeasonality !== null, legend: { type: 'gradient', title: 'Seasonality', unit: '°C range', stops: amplitudeLegendStops } },
    { id: 'wind', icon: '/icons/wind.png', labelKey: 'world.overlay.wind', available: () => lastWind !== null },
    { id: 'currents', icon: '/icons/gyres.png', labelKey: 'world.overlay.currents', available: () => lastCurrents !== null },
    { id: 'precipitation', icon: '/icons/rain.png', labelKey: 'world.overlay.precipitation', available: () => lastPrecipitation !== null, legend: { type: 'gradient', title: 'Precipitation', unit: 'mm/yr', stops: precipitationLegendStops } },
    { id: 'monsoon', icon: '/icons/weather.png', labelKey: 'world.overlay.monsoon', available: () => lastMonsoonIndex !== null, legend: { type: 'gradient', title: 'Monsoon index', unit: '', stops: monsoonLegendStops } },
    { id: 'biomes', icon: '/icons/biomes.png', labelKey: 'world.overlay.biomes', available: () => lastBiomes !== null, legend: { type: 'swatches', title: 'Biomes', items: biomeLegend() } },
    { id: 'rivers', icon: '/icons/river.png', labelKey: 'world.overlay.rivers', available: () => lastRiverData !== null },
    {
      id: 'ecology', icon: '/icons/ecology.png', labelKey: 'world.overlay.resources', available: hasEcologyData,
      legend: () => ({ type: 'gradient', title: ECOLOGY_FIELD_META[selectedEcologyField].label, unit: '', stops: ecologyFieldLegendStops(selectedEcologyField) }),
    },
    // TODO(icon): reuses the human species icon — a dedicated migration icon later.
    {
      id: 'migration', icon: '/icons/human.png', labelKey: 'world.overlay.migration', available: () => lastMigration !== null,
      legend: { type: 'swatches', title: 'Peoples', items: MIGRATION_RACES.map((r) => ({ label: r.label, rgb: r.rgb })) },
    },
  ]
  // Desired on/off per overlay (persists as availability comes and goes). Voronoi
  // + names + mantle default on (they show as soon as their data exists); terrain
  // default on too but is re-set per panel in showPanel (on for the shaping panels,
  // off for the neutral data panels); other data overlays default off.
  const overlaysOn: Record<string, boolean> = {}
  for (const def of OVERLAY_DEFS) overlaysOn[def.id] = def.id === 'boundaries' || def.id === 'names' || def.id === 'terrain' || def.id === 'mantle'

  // The bar carries one button per pipeline stage rather than one per overlay —
  // fifteen icons in a row read as a wall, and most of them belong to a stage you are
  // not looking at. Clicking a stage folds its overlays out beneath the bar; the
  // Ecology panel's category fold-out is the model.
  //
  // `terrain` stays outside the grouping: it is not a data layer of any one stage but
  // the map's own colouring, and it is the one people reach for constantly.
  //
  // A stage with a single overlay does NOT fold out — its button toggles that overlay
  // directly. Otherwise opening a category would reveal one identical button, which is
  // a click that buys nothing.
  const OVERLAY_GROUPS: { id: string; icon: string; labelKey: string; members: string[]; ecologyFields?: EcologyFieldId[] }[] = [
    { id: 'genesis', icon: '/icons/mantle.png', labelKey: 'worldgen.panel.genesis.title', members: ['mantle', 'cratonAge', 'volcanoes', 'hotspots'] },
    { id: 'tectonics', icon: '/icons/tectonics.png', labelKey: 'worldgen.panel.tectonics.title', members: ['boundaries', 'names'] },
    { id: 'climate', icon: '/icons/temperature.png', labelKey: 'worldgen.panel.climate.title', members: ['temperature', 'seasonality', 'wind', 'currents', 'precipitation', 'monsoon', 'biomes'] },
    { id: 'hydrology', icon: '/icons/river.png', labelKey: 'world.overlay.rivers.label', members: ['rivers'] },
    // Ecology carries the aggregate plus every resource field. The fields duplicate
    // the panel's own fold-out at the bottom, deliberately: down there they set
    // ABUNDANCE, up here they choose what the map paints — same list, different job.
    { id: 'ecology', icon: '/icons/ecology.png', labelKey: 'world.overlay.resources.label', members: [], ecologyFields: ['carryingCapacity', ...ECOLOGY_WEIGHT_FIELDS] },
    { id: 'migration', icon: '/icons/human.png', labelKey: 'world.overlay.migration.label', members: ['migration'] },
  ]
  const defOf = (id: string): (typeof OVERLAY_DEFS)[number] => OVERLAY_DEFS.find((d) => d.id === id)!

  const overlayBar = document.createElement('div')
  overlayBar.className = 'overlay-bar'
  const overlayButtons: Record<string, HTMLButtonElement> = {}
  const groupButtons: Record<string, HTMLButtonElement> = {}
  const groupPanels: Record<string, HTMLElement> = {}
  const ecologyFieldButtons: Partial<Record<EcologyFieldId, HTMLButtonElement>> = {}
  let openGroup: string | null = null

  // `label` is the finished string; `helpBase` is the catalog prefix the hover help
  // card reads its label+sentence from (null = no card). Split because the category
  // buttons borrow the panel titles, which are `…title` keys with no `.help` sibling —
  // reusing them costs those three buttons their help card and saves six keys.
  function makeIconButton(icon: string, label: string, helpBase: string | null, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'overlay-icon'
    btn.setAttribute('aria-label', label)
    if (helpBase) btn.dataset.help = helpBase
    const img = document.createElement('img')
    img.src = icon
    img.alt = ''
    btn.appendChild(img)
    btn.addEventListener('click', onClick)
    return btn
  }

  const terrainDef = defOf('terrain')
  overlayButtons.terrain = makeIconButton(terrainDef.icon, t(`${terrainDef.labelKey}.label` as TKey), terrainDef.labelKey, () => toggleOverlay('terrain'))
  overlayBar.appendChild(overlayButtons.terrain)

  // Opening is a CLICK, but once something is open, hovering a neighbour switches to
  // it — the desktop menu-bar convention. Hover-to-open was considered and rejected:
  // this bar sits over the map, so moving the pointer across it to reach a control
  // would flash panels onto exactly what you are looking at, and with six buttons in a
  // row every trip to the far one crosses all the others.
  function setOpenGroup(id: string | null): void {
    openGroup = id
    for (const group of OVERLAY_GROUPS) {
      const panel = groupPanels[group.id]
      if (panel) panel.hidden = group.id !== id
    }
    overlayFoldout.hidden = id === null || !groupPanels[id]
    if (id !== null && !overlayFoldout.hidden) positionFoldoutUnder(groupButtons[id])
    // The backdrop has to reach past the fold-out or its icons would sit on the bare
    // map; carrying that height permanently would wash the map out for nothing. Same
    // mechanism the narration line uses on the bottom panel.
    overlayBackdrop.classList.toggle('has-foldout', !overlayFoldout.hidden)
  }

  // Hangs the fold-out under its own category button, then pulls it back inside the
  // viewport if that would push it off an edge — the Climate category carries seven
  // icons, which is wider than the distance from an outer button to the screen edge.
  function positionFoldoutUnder(button: HTMLButtonElement): void {
    overlayFoldout.style.left = `${button.offsetLeft + button.offsetWidth / 2}px`
    const box = overlayFoldout.getBoundingClientRect()
    const margin = 8
    const overshootRight = box.right - (window.innerWidth - margin)
    const overshootLeft = margin - box.left
    const correction = overshootRight > 0 ? -overshootRight : overshootLeft > 0 ? overshootLeft : 0
    if (correction !== 0) overlayFoldout.style.left = `${button.offsetLeft + button.offsetWidth / 2 + correction}px`
  }

  // Closing on mouse-leave keeps the map clear without a second click. The grace
  // period is what makes it bearable: the pointer clips a corner constantly on the way
  // from the category row to the row below it, and closing on every one of those would
  // read as the panel fighting back. Bound to the whole BAR, not to single buttons —
  // the fold-out is a child of it, so travelling between the two rows never leaves.
  const FOLDOUT_CLOSE_GRACE_MS = 180
  let foldoutCloseTimer: number | undefined
  overlayBar.addEventListener('mouseenter', () => {
    if (foldoutCloseTimer !== undefined) { clearTimeout(foldoutCloseTimer); foldoutCloseTimer = undefined }
  })
  overlayBar.addEventListener('mouseleave', () => {
    if (openGroup === null) return
    foldoutCloseTimer = window.setTimeout(() => { foldoutCloseTimer = undefined; setOpenGroup(null) }, FOLDOUT_CLOSE_GRACE_MS)
  })

  const overlayFoldout = document.createElement('div')
  overlayFoldout.className = 'overlay-foldout'
  overlayFoldout.hidden = true

  // Picking a resource field turns the ecology layer on and points it at that field.
  // Unlike every other overlay these are mutually exclusive — paintEcology renders ONE
  // field over the whole land, so a second could only overwrite the first. Clicking the
  // one already showing switches the layer off again.
  function selectEcologyField(field: EcologyFieldId): void {
    if (overlaysOn.ecology && selectedEcologyField === field) {
      overlaysOn.ecology = false
    } else {
      selectedEcologyField = field
      overlaysOn.ecology = true
    }
    updateOverlays()
  }

  for (const group of OVERLAY_GROUPS) {
    const single = group.members.length === 1 && !group.ecologyFields ? group.members[0] : null
    const btn = makeIconButton(group.icon, t(group.labelKey as TKey), single ? group.labelKey.replace(/\.label$/, '') : null, () => {
      if (single) toggleOverlay(single)
      else setOpenGroup(openGroup === group.id ? null : group.id)
    })
    btn.addEventListener('mouseenter', () => {
      if (openGroup !== null && !single) setOpenGroup(group.id)
    })
    groupButtons[group.id] = btn
    overlayBar.appendChild(btn)
    if (single) {
      overlayButtons[single] = btn
      continue
    }
    const panel = document.createElement('div')
    panel.className = 'overlay-group-panel'
    panel.hidden = true
    for (const id of group.members) {
      const def = defOf(id)
      const memberBtn = makeIconButton(def.icon, t(`${def.labelKey}.label` as TKey), def.labelKey, () => toggleOverlay(id))
      overlayButtons[id] = memberBtn
      panel.appendChild(memberBtn)
    }
    for (const field of group.ecologyFields ?? []) {
      const btn = makeIconButton(`/icons/${FIELD_ICON[field]}.png`, t(`world.resource.${field}.label` as TKey), `world.resource.${field}`, () => selectEcologyField(field))
      ecologyFieldButtons[field] = btn
      panel.appendChild(btn)
    }
    groupPanels[group.id] = panel
    overlayFoldout.appendChild(panel)
  }
  overlayBar.appendChild(overlayFoldout)
  root.appendChild(overlayBar)

  // Fading backdrop behind the top overlay bar (mirrors the bottom panel's fade),
  // so the icons read against a busy map.
  const overlayBackdrop = document.createElement('div')
  overlayBackdrop.className = 'overlay-bar-backdrop'
  root.appendChild(overlayBackdrop)

  // The phase hint sits just above the compute bar, at the bottom. It used to sit
  // under the overlay bar — until the bar grew a fold-out that landed on top of it —
  // and the move turned out to be the better place anyway: the bar's three-stage
  // COLOUR and this sentence come from the same archeanStage() call, so they say the
  // same thing and had no business being at opposite edges of the screen.
  const worldBanner = document.createElement('div')
  worldBanner.className = 'world-banner'
  worldBanner.hidden = true
  const worldHintEl = document.createElement('span')
  worldHintEl.className = 'world-banner-hint'
  worldBanner.appendChild(worldHintEl)
  root.appendChild(worldBanner)

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

  // Sync every button's disabled (unavailable) + active (on) look, at all three
  // levels: the standalone terrain button, the per-stage category buttons, and the
  // members inside a fold-out.
  function refreshOverlayBar(): void {
    for (const def of OVERLAY_DEFS) {
      // `ecology` has no button of its own — its fold-out offers the fields directly,
      // and the layer is on whenever one of them is picked.
      const btn = overlayButtons[def.id]
      if (!btn) continue
      const avail = def.available()
      btn.disabled = !avail
      btn.classList.toggle('is-disabled', !avail)
      btn.classList.toggle('is-active', avail && overlaysOn[def.id])
    }
    const ecoAvailable = defOf('ecology').available()
    for (const [field, btn] of Object.entries(ecologyFieldButtons) as [EcologyFieldId, HTMLButtonElement][]) {
      btn.disabled = !ecoAvailable
      btn.classList.toggle('is-disabled', !ecoAvailable)
      btn.classList.toggle('is-active', ecoAvailable && overlaysOn.ecology && selectedEcologyField === field)
    }
    for (const group of OVERLAY_GROUPS) {
      // A category is reachable when anything inside it is, and reads as active when
      // anything inside it is showing — so a collapsed fold-out still tells you
      // whether that stage is contributing to the map.
      const ids = group.ecologyFields ? ['ecology'] : group.members
      const avail = ids.some((id) => defOf(id).available())
      const anyOn = ids.some((id) => overlaysOn[id] && defOf(id).available())
      const btn = groupButtons[group.id]
      btn.disabled = !avail
      btn.classList.toggle('is-disabled', !avail)
      btn.classList.toggle('is-active', anyOn)
      if (!avail && openGroup === group.id) setOpenGroup(null)
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

  // Hover readout: the cell's height in metres, then one line per active climate
  // overlay (the reusable MapHoverTooltip resolves the cell; here we map it to
  // the coarse grids and read the computed fields). Null when there's nothing to
  // report at all. mapX/mapY are full-res texels.
  function describeClimateCell(mapX: number, mapY: number): string | null {
    const lines: string[] = []
    // Height first, and outside the climate guard — elevation exists from the
    // first render, long before any climate does, and it's the readout that
    // makes the metre calibration checkable by hovering (see elevationScale.ts).
    if (lastCoarseElevation) {
      const ex = Math.min(elevationResX - 1, Math.floor((mapX / MAP_WIDTH) * elevationResX))
      const ey = Math.min(elevationResY - 1, Math.floor((mapY / MAP_HEIGHT) * elevationResY))
      const m = Math.round(elevationToMeters(lastCoarseElevation[ey * elevationResX + ex]))
      lines.push(m >= 0 ? `${m} m` : `${-m} m deep`)
    }
    if (climateResX === 0) return lines.length ? lines.join('\n') : null
    const gx = Math.min(climateResX - 1, Math.floor((mapX / MAP_WIDTH) * climateResX))
    const gy = Math.min(climateResY - 1, Math.floor((mapY / MAP_HEIGHT) * climateResY))
    const i = gy * climateResX + gx
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
    climateResolve?.()
    climateResolve = null
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
    hydrologyResolve?.()
    hydrologyResolve = null
    // On the Ecology panel, fish (freshwater) depends on this hydrology, so
    // (re)compute the ecology fields now that rivers/lakes are fresh. Skipped
    // during a save (the save flow drives the compute chain itself).
    if (panelIndex === ECOLOGY_PANEL_INDEX && !saveChainActive) requestEcology()
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
    if (tectonicsRunning) return
    hydrologyInFlight = true
    updateControlsDisabled()
    updateProgress()
    postToWorker({ type: 'computeHydrology', riverDensity: Number(riverDensityInput.value) })
  }

  // Posts a climate compute with the current band-slider offset. Fired on
  // opening the climate panel and by the slider (debounced) for live re-tuning.
  function requestClimate(): void {
    if (tectonicsRunning) return
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
    ecologyResolve?.()
    ecologyResolve = null
  }

  // Ecology depends on climate (+ the sim's volcanoes), so any climate change
  // stales it — recomputed on the next ecology-panel open / slider tweak.
  function invalidateEcology(): void {
    lastEcologyFields = {}
    invalidateMigration() // migration reads ecology's carrying capacity
    updateOverlays()
  }

  // --- initial migration ---

  function invalidateMigration(): void {
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
    if (origins.length === 0) { invalidateMigration(); return } // all races off → nothing
    migrationInFlight = true
    updateControlsDisabled()
    updateProgress()
    postToWorker({ type: 'computeMigration', origins, spreadBudget: Number(migrationSpreadInput.value), seaCrossing: Number(migrationSeaInput.value) / 100 })
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

  worker.onmessage = (event: MessageEvent<WorkerRenderedMessage | WorkerErosionProgressMessage | WorkerClimateDataMessage | WorkerHydrologyDataMessage | WorkerEcologyDataMessage | WorkerMigrationDataMessage | WorkerWorldDataMessage | WorkerArcheanStatusMessage>) => {
    const message = event.data

    if (message.type === 'archeanStatus') {
      handleArcheanStatus(message)
      return
    }

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

    if (message.type === 'migrationData') {
      handleMigrationData(message)
      return
    }

    // Retain the overlay source data + feed the base raster to the compositor
    // so a toggle can re-composite without a worker round-trip, then draw the
    // current layer set.
    lastBoundaryMask = new Uint8Array(message.boundaryMask)
    lastRaftLabels = message.raftLabels
    lastColoredBase = new Uint8ClampedArray(message.buffer)
    lastRelief = new Uint8Array(message.relief)
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
    // Guarded by tectonicsRunning, so it's a no-op during erosion redraws (which
    // run while stopped) and can't re-fire before the next deliberate start
    // re-arms it.
    if (tectonicsRunning && message.epoch >= autoStopAtEpoch) {
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

  // Genesis now starts an ARCHEAN world, not a plate simulation: no plates exist
  // until finalizeArchean hands over. See docs/decisions/archean-genesis.md.
  const initArchean = (seed: string, vigour: number, water: number): void => {
    lastEpoch = 0
    archeanRunning = false
    postToWorker({
      type: 'archeanInit',
      seed,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      epochIntervalMs: EPOCH_INTERVAL_MS,
      mantleDiffusion: vigourToDiffusion(vigour),
      seaLevelOffset: metersToElevation(waterSliderToOffsetM(water)),
      renderOptions: {},
    })
  }
  initArchean(initialSeed, MANTLE_VIGOUR_DEFAULT, WATER_DEFAULT)

  // --- Archean controls -----------------------------------------------------
  const setArcheanRunning = (running: boolean): void => {
    archeanRunning = running
    toggleArcheanButton.querySelector('img')!.src = running ? '/icons/stop.png' : '/icons/mantle.png'
    toggleArcheanButton.setAttribute('aria-label', running ? 'Pause the Archean' : 'Run the Archean')
  }

  toggleArcheanButton.addEventListener('click', () => {
    if (archeanRunning) {
      postToWorker({ type: 'archeanStop' })
      setArcheanRunning(false)
      updateOverlays()
      updateProgress()
      return
    }
    postToWorker({ type: 'archeanStart' })
    setArcheanRunning(true)
    updateOverlays()
  })

  resetArcheanButton.addEventListener('click', () => {
    postToWorker({ type: 'archeanReset' })
    setArcheanRunning(false)
    lastArcheanEpochs = 0
    archeanFinalised = false
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
  const archeanStage = (stabilised: number): { hint: string; stage: 'early' | 'window' | 'late' } => {
    if (stabilised < 0.2) return { stage: 'early', hint: 'Crust is still ephemeral — nothing has settled yet.' }
    if (stabilised < 0.7) return { stage: 'window', hint: 'Several separate continents, still drifting. Good place to stop.' }
    return { stage: 'late', hint: 'Continents are merging into a supercontinent — and will tear it apart again.' }
  }

  function handleArcheanStatus(message: WorkerArcheanStatusMessage): void {
    lastArcheanEpochs = message.epoch
    statCrust.textContent = String(Math.round(message.crustFraction * 100))
    statCratons.textContent = String(message.cratonCount)
    statStabilised.textContent = String(Math.round(message.stabilisedFraction * 100))
    statWorldAge.textContent = formatWorldAge(message.worldAgeMa)
    // One source for both readouts: the gauge's colour and the banner's wording are
    // the same three-stage judgement, so they can never disagree.
    const { hint } = archeanStage(message.stabilisedFraction)
    archeanStabilised = message.stabilisedFraction
    worldHintEl.textContent = hint
    // Genesis only, same rule the panel switch applies. Guarded here too rather than
    // trusting that no Archean status can arrive once the phase has been handed over
    // — the visibility rule then lives in one condition instead of in the timing of
    // two messages.
    worldBanner.hidden = panelIndex !== 0
    // The backdrop grows to carry the line and shrinks back when there is none.
    panels[0].classList.toggle('has-banner', !worldBanner.hidden)
    updateProgress()
  }

  const stopSim = (): void => {
    if (!tectonicsRunning) return
    tectonicsRunning = false
    postToWorker({ type: 'stop' })
    updateOverlays()
    toggleSimIcon.src = '/icons/tectonics.png'
    toggleSimButton.setAttribute('aria-label', 'Run tectonics')
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
    if (tectonicsRunning) stopSim()
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
      // Grouped by the pipeline stage that owns each knob, in the order the panels
      // run. `seed` stays at the top: it is the world's identity, not a setting of
      // any one stage.
      `  seed: "${seedInput.value}"`,
      '  genesis:',
      `    mantleVigour: ${Number(mantleVigourInput.value)}`,
      `    water: ${Number(waterInput.value)}`,
      '  erosion:',
      `    erosionStrength: ${Number(strengthInput.value)}`,
      `    drainageRefresh: ${Number(refreshInput.value)}`,
      '  climate:',
      `    tempOffset: ${Number(tempBandInput.value)}`,
      `    humidity: ${Number(humidityInput.value)}`,
      `    contrast: ${Number(contrastInput.value)}`,
      `    equatorOffset: ${Number(equatorOffsetInput.value)}`,
      '  hydrology:',
      `    riverDensity: ${Number(riverDensityInput.value)}`,
      '  ecology:',
      `    carryingCapacity: ${Number(carryingCapacityInput.value)}`,
      `    concentration: ${Number(concentrationInput.value)}`,
      `    provinceStrength: ${Number(provinceInput.value)}`,
      ...ECOLOGY_CATEGORIES.flatMap((c) => [
        `    ${c.id}:`,
        ...c.fields.map((f) => `      ${f}: ${Number(foldoutInputs[f]?.value ?? 100)}`),
      ]),
      'status:',
      // Only what state.json does NOT already carry. tectonicsRun and archeanEpochs
      // used to sit here and in spec, duplicating the snapshot's own `epoch` and
      // `archeanEpochs` — two sources for one fact, and nothing read the yaml copies.
      // The erosion count has no home in the snapshot, so this stays load-bearing.
      `  erosionRun: ${erosionRunCount}`,
      '',
    ].join('\n')
  }

  // Refresh every slider's readout label from its input value — used after a
  // load sets the inputs programmatically (which doesn't fire input events).
  function syncSliderLabels(): void {
    mantleVigourLabel.textContent = mantleVigourInput.value
    waterLabel.textContent = waterInput.value
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
  // Reads a dotted path ("ecology.metal.iron") out of the recipe by tracking
  // indentation. It used to match the leaf name anywhere in the document, which
  // worked only as long as no two groups ever shared a key — an invariant nothing
  // enforced and the nesting makes easy to break.
  function readYamlValue(text: string, path: string): string | undefined {
    const stack: { indent: number; key: string }[] = []
    for (const line of text.split('\n')) {
      const match = line.match(/^(\s*)([\w-]+):\s*(.*)$/)
      if (!match) continue
      const [, indentText, key, rawValue] = match
      const indent = indentText.length
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
      stack.push({ indent, key })
      if (rawValue !== '' && stack.map((e) => e.key).join('.') === path) {
        return rawValue.replace(/^["']|["']$/g, '')
      }
    }
    return undefined
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
  function bakeQueryLayers(zip: JSZip): void {
    type ManifestLayer = { name: string; file: string; kind: 'raster' | 'vector'; resX?: number; resY?: number; dtype?: string; encoding?: { scale: number; offset: number }; unit?: string; landOnly?: boolean }
    const layers: ManifestLayer[] = []
    // Elevation is always present (post-generation); carried raw as elevation.f32
    // (it doubles as the restore raster).
    layers.push({ name: 'elevation', file: 'elevation.f32', kind: 'raster', resX: MAP_WIDTH, resY: MAP_HEIGHT, dtype: 'f32', encoding: { scale: 1, offset: 0 }, unit: 'relative', landOnly: false })

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
        biome: lastBiomes ?? undefined,
        seasonalAmplitude: lastSeasonality ?? undefined,
        monsoonIndex: lastMonsoonIndex ?? undefined,
        lakeDepth: lastLakeDepth ? downsampleMax(lastLakeDepth, MAP_WIDTH, MAP_HEIGHT, rx, ry) : undefined,
      }
      for (const f of Object.keys(lastEcologyFields) as EcologyFieldId[]) sources[f] = lastEcologyFields[f]
      for (const spec of WORLD_LAYERS) {
        const src = sources[spec.name]
        if (!src) continue
        zip.file(`layers/${spec.name}.${spec.dtype}`, bakeLayer(src, spec))
        layers.push({ name: spec.name, file: `layers/${spec.name}.${spec.dtype}`, kind: 'raster', resX: rx, resY: ry, dtype: spec.dtype, encoding: { scale: spec.scale, offset: spec.offset }, unit: spec.unit, landOnly: spec.landOnly })
      }
      // Rivers as vector polylines (texel coords: [x, y, widthPx, …] per polyline).
      if (lastRiverData) {
        zip.file('layers/rivers.json', JSON.stringify({ points: Array.from(lastRiverData.points), lengths: Array.from(lastRiverData.lengths) }))
        layers.push({ name: 'rivers', file: 'layers/rivers.json', kind: 'vector' })
      }
    }
    const manifest = {
      formatVersion: 1,
      generatorVersion: 'casas-eternas/v1alpha1',
      world: { width: MAP_WIDTH, height: MAP_HEIGHT, topology: 'torus' },
      layers,
    }
    zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  }

  // Save flow: worker replies with the sim snapshot + rasters → zip it up (recipe
  // + snapshot + baked query layers + manifest + preview).
  async function handleWorldData(message: WorkerWorldDataMessage): Promise<void> {
    const zip = new JSZip()
    zip.file('world.yaml', buildWorldYaml())
    zip.file('state.json', JSON.stringify(message.snapshot))
    zip.file('mantle.f32', message.mantle)
    zip.file('lattice.acc.f32', message.latticeAccumulated)
    zip.file('lattice.lock.i16', message.latticeLockedEpochs)
    zip.file('lattice.class.i8', message.latticeLastClassCode)
    zip.file('oceanAge.f32', message.oceanAge)
    zip.file('elevation.f32', message.elevation)
    bakeQueryLayers(zip)
    const preview = await makePreviewBlob()
    if (preview) zip.file('preview.png', preview)
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
    const safeName = (seedInput.value || 'world').replace(/[^a-zA-Z0-9_-]/g, '_')
    downloadBlob(blob, `${safeName}.zip`)
  }

  // Await one compute step: set its resolver, request it; the data handler
  // resolves when it lands. Safe because save is only reachable while idle.
  const awaitCompute = (setResolver: (r: () => void) => void, request: () => void): Promise<void> =>
    new Promise((resolve) => { setResolver(resolve); request() })

  saveWorldButton.addEventListener('click', () => { void saveWorld() })

  async function saveWorld(): Promise<void> {
    if (tectonicsRunning) return
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
    let snapshot: PlateSimulationSnapshot
    let oceanAge: ArrayBuffer
    let elevation: ArrayBuffer
    // Optional: saves written before these were persisted have no such entries, and
    // the worker falls back to regenerating the mantle and starting the lattice empty
    // — exactly what every load used to do.
    let mantle: ArrayBuffer | undefined
    let lattice: { accumulated: ArrayBuffer; lockedEpochs: ArrayBuffer; lastClassCode: ArrayBuffer } | undefined
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
      const mantleFile = zip.file('mantle.f32')
      mantle = mantleFile ? await mantleFile.async('arraybuffer') : undefined
      const accFile = zip.file('lattice.acc.f32')
      const lockFile = zip.file('lattice.lock.i16')
      const clsFile = zip.file('lattice.class.i8')
      lattice = accFile && lockFile && clsFile
        ? { accumulated: await accFile.async('arraybuffer'), lockedEpochs: await lockFile.async('arraybuffer'), lastClassCode: await clsFile.async('arraybuffer') }
        : undefined
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

    const seed = readYamlValue(yaml, 'spec.seed') ?? ''
    seedInput.value = seed
    mantleVigourInput.value = readYamlValue(yaml, 'spec.genesis.mantleVigour') ?? mantleVigourInput.value
    waterInput.value = readYamlValue(yaml, 'spec.genesis.water') ?? waterInput.value
    // A restored world is past the Archean: its state is loaded, not re-simulated.
    // Read from the snapshot, which is where the number actually lives — the yaml
    // used to carry a second copy under spec.
    lastArcheanEpochs = snapshot.archeanEpochs ?? 0
    setArcheanRunning(false)
    tempBandInput.value = readYamlValue(yaml, 'spec.climate.tempOffset') ?? '0'
    humidityInput.value = readYamlValue(yaml, 'spec.climate.humidity') ?? '100'
    contrastInput.value = readYamlValue(yaml, 'spec.climate.contrast') ?? '100'
    equatorOffsetInput.value = readYamlValue(yaml, 'spec.climate.equatorOffset') ?? '0'
    riverDensityInput.value = readYamlValue(yaml, 'spec.hydrology.riverDensity') ?? '55'
    strengthInput.value = readYamlValue(yaml, 'spec.erosion.erosionStrength') ?? strengthInput.value
    refreshInput.value = readYamlValue(yaml, 'spec.erosion.drainageRefresh') ?? refreshInput.value
    carryingCapacityInput.value = readYamlValue(yaml, 'spec.ecology.carryingCapacity') ?? '100'
    concentrationInput.value = readYamlValue(yaml, 'spec.ecology.concentration') ?? '0'
    provinceInput.value = readYamlValue(yaml, 'spec.ecology.provinceStrength') ?? '45'
    for (const f of ECOLOGY_WEIGHT_FIELDS) {
      const inp = foldoutInputs[f]
      if (inp) inp.value = readYamlValue(yaml, ecologyWeightPath(f)) ?? '100'
    }
    syncSliderLabels()
    erosionRunCount = Number(readYamlValue(yaml, 'status.erosionRun') ?? 0)
    // lastEpoch is set from the restore render's reported epoch (status
    // .tectonicsRun == the snapshot's epoch), so no need to set it here.

    postToWorker({ type: 'restoreWorld', seed, snapshot, oceanAge, elevation, mantle, lattice })
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
    if (tectonicsRunning) return
    clearTimeout(climateDebounce)
    climateDebounce = setTimeout(requestClimate, 150)
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
  wireClimateSlider(equatorOffsetInput, equatorOffsetLabel)

  // River density: live-recompute (debounced); a density-only change reuses the
  // worker's cached routing/discharge, so it's cheap.
  let hydrologyDebounce: ReturnType<typeof setTimeout> | undefined
  riverDensityInput.addEventListener('input', () => {
    riverDensityLabel.textContent = riverDensityInput.value
    if (tectonicsRunning) return
    clearTimeout(hydrologyDebounce)
    hydrologyDebounce = setTimeout(requestHydrology, 150)
  })

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
    selectedEcologyField = 'carryingCapacity'
    updateOverlays()
  }

  // Fold-out: three category icon-buttons in the base row; clicking one reveals
  // that category's per-field abundance sliders (each with its resource icon) in
  // the full-width sub-row (radio-style — one category open at a time). Hovering a
  // row previews that field.
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
      icon.src = `/icons/${FIELD_ICON[field]}.png`
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

  // Migration panel: 3 race enable/disable icon-toggles + the 3 sliders. Spread +
  // sea-crossing recompute (debounced); arrow threshold is a render-only knob
  // (the arrow tree — Phase 3), so it just recomposites.
  const migrationRacesContainer = root.querySelector<HTMLElement>('[data-value="migration-races"]')!
  MIGRATION_RACES.forEach((race, i) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'icon-button ecology-cat is-active'
    btn.title = race.label
    btn.setAttribute('aria-label', race.label)
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
  let migrationDebounce: ReturnType<typeof setTimeout> | undefined
  const scheduleMigration = (): void => {
    if (tectonicsRunning) return
    clearTimeout(migrationDebounce)
    migrationDebounce = setTimeout(requestMigration, 150)
  }
  migrationSpreadInput.addEventListener('input', () => { migrationSpreadLabel.textContent = migrationSpreadInput.value; scheduleMigration() })
  migrationSeaInput.addEventListener('input', () => { migrationSeaLabel.textContent = migrationSeaInput.value; scheduleMigration() })
  migrationThresholdInput.addEventListener('input', () => { migrationThresholdLabel.textContent = migrationThresholdInput.value; updateOverlays() })

  // Per-panel reset: restore that panel's sliders to their defaults + recompute.
  resetClimateButton.addEventListener('click', () => {
    tempBandInput.value = '0'; equatorOffsetInput.value = '0'; humidityInput.value = '100'; contrastInput.value = '100'
    tempBandLabel.textContent = '0'; equatorOffsetLabel.textContent = '0'; humidityLabel.textContent = '100'; contrastLabel.textContent = '100'
    requestClimate()
  })
  resetEcologyButton.addEventListener('click', () => {
    carryingCapacityInput.value = '100'; carryingCapacityLabel.textContent = '100'
    concentrationInput.value = '0'; concentrationLabel.textContent = '0'
    provinceInput.value = '45'; provinceLabel.textContent = '45'
    for (const f of ECOLOGY_WEIGHT_FIELDS) {
      const inp = foldoutInputs[f]
      const lbl = foldoutLabels[f]
      if (inp) inp.value = '100'
      if (lbl) lbl.textContent = '100'
    }
    requestEcology()
  })
  resetMigrationButton.addEventListener('click', () => {
    migrationSpreadInput.value = '120'; migrationSpreadLabel.textContent = '120'
    migrationThresholdInput.value = '50'; migrationThresholdLabel.textContent = '50'
    migrationSeaInput.value = '30'; migrationSeaLabel.textContent = '30'
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
    invalidateClimate()
    migrationOrigins = [] // fresh world → re-auto-place origins on the next migration open
    erosionRunCount = 0
    archeanFinalised = false
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
  resetButton.addEventListener('click', regenerate)
  seedInput.addEventListener('input', regenerateDebounced)
  randomizeButton.addEventListener('click', () => {
    seedInput.value = randomSeed()
    regenerate()
  })
  mantleVigourInput.addEventListener('input', () => {
    mantleVigourLabel.textContent = mantleVigourInput.value
    regenerateDebounced()
  })
  waterInput.addEventListener('input', () => {
    waterLabel.textContent = waterInput.value
    regenerateDebounced()
  })
  // Same back/next convention as the sphere screen: back steps to the
  // previous panel, or exits to the title screen from the first one;
  // next steps forward and is a no-op past the last panel. Generation
  // parameters (seed, plate counts) live on panel 0, tectonics on panel
  // 1, erosion on panel 2 — future panels slot in the same way via the
  // data-panel pattern, with one more entry in PANEL_TITLES to match.
  const PANEL_TITLES = ['Genesis', 'Tectonics', 'Erosion', 'Climate', 'Hydrology', 'Ecology', 'Migration']
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
    if ((index === CLIMATE_PANEL_INDEX || index === HYDROLOGY_PANEL_INDEX || index === ECOLOGY_PANEL_INDEX || index === MIGRATION_PANEL_INDEX) && erosionRunCount < 1) return 'First run erosion at least once — climate, rivers, ecology and migration need the eroded terrain.'
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
    // Leaving Genesis for Tectonics is what ENDS the Archean: plate tectonics
    // begins, seeds are placed on the convection cells, and the rafts/ages/mantle
    // carry over (finalizeArchean). Stopping the Archean is only ever a pause; this
    // is the commit, and the Genesis panel's reset button is the way back.
    if (index === TECTONICS_PANEL_INDEX && lastArcheanEpochs > 0 && !archeanFinalised) {
      archeanFinalised = true
      postToWorker({ type: 'archeanStop' })
      postToWorker({ type: 'archeanFinalize' })
      setArcheanRunning(false)
      // Plate outlines and continent names unblock here — this is where plates and
      // continents start existing.
      updateOverlays()
    }
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
    // Entering Migration ensures the whole upstream chain (climate → hydrology →
    // ecology), auto-places origins the first time, then computes the migration.
    if (index === MIGRATION_PANEL_INDEX && lastMigration === null) void ensureMigration()
    // The terrain colour wash is panel-contextual: on for the shaping panels
    // (Genesis/Tectonics/Erosion), off for the neutral data panels (Climate/
    // Rivers). Still toggleable in the bar within a panel; resets on switch.
    overlaysOn.terrain = index < CLIMATE_PANEL_INDEX
    // The mantle overlay is on for Genesis/Tectonics (where you watch the plates
    // drive), off from the Erosion panel (index 2) onward. Same per-panel reset.
    overlaysOn.mantle = index < 2
    // Volcanism follows the mantle: both are the tectonic phase's story, and neither
    // exists during Genesis (the Archean produces no features and no plumes).
    overlaysOn.volcanoes = index === TECTONICS_PANEL_INDEX
    // Plumes follow the mantle field into Genesis, because the Archean now has them
    // too — and there they are worth more than in the tectonic phase: they mark where
    // crust is about to nucleate, before anything is visible on the map.
    overlaysOn.hotspots = index < 2
    // Craton age is on in Genesis only. There it is the point of the phase — the
    // coastline alone cannot show that a continent grew by welding young crust onto
    // an old core. From the Tectonics panel on, the same map has to carry plates,
    // boundaries and names, so this stays available in the bar but off by default.
    overlaysOn.cratonAge = index === 0
    // The narration band belongs to Genesis. It describes what the Archean is doing
    // right now ("cratons are forming and still moving"), which stops being true the
    // moment the phase is handed over — and it was previously only ever shown, never
    // hidden, so the last Archean sentence stayed on screen for the rest of the run.
    const genesis = index === 0
    worldBanner.hidden = !genesis || worldHintEl.textContent === ''
    panels[0].classList.toggle('has-banner', !worldBanner.hidden)
    // Temperature comes on when you enter the Climate panel — the same reasoning as
    // rivers below, and the same mechanism: it is switched on even before the climate
    // has been computed (the entry above requests it), and handleClimateData's
    // updateOverlays() makes the layer visible the moment the data lands. Otherwise
    // entering the panel computed a climate and then showed a blank map until you
    // found the right button.
    overlaysOn.temperature = index === CLIMATE_PANEL_INDEX
    // Rivers/lakes come on automatically when you enter the Hydrology panel (the
    // reason you're there), off elsewhere — same per-panel reset. Once the compute
    // finishes, handleHydrologyData's updateOverlays() makes the layer visible.
    overlaysOn.rivers = index === HYDROLOGY_PANEL_INDEX
    // Carrying-capacity overlay comes on automatically in the Ecology panel (the
    // reason you're there), off elsewhere. handleEcologyData's updateOverlays()
    // makes it visible once the compute finishes.
    overlaysOn.ecology = index === ECOLOGY_PANEL_INDEX
    ecologyHoverField = null // drop any stale hover preview when switching panels
    // Migration density fill + origin markers come on in the Migration panel.
    overlaysOn.migration = index === MIGRATION_PANEL_INDEX
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
    describe: describeClimateCell,
  })

  // Control-help tooltips: one delegated listener on the screen root drives the
  // hover help card for every element carrying data-help (the overlay icons for
  // now; more controls as they get keys).
  const helpTooltip = createHelpTooltip(root)

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
      helpTooltip.dispose()
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
