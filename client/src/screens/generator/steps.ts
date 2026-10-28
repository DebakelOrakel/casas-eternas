// THE STEPS, AS DATA. One entry per step: which pipeline stage it drives, which
// map layers it is about, and which layers are its favourites.
//
// A STEP is not a STAGE. Step 0 names and seeds the world and also drives the
// planet stage, whose controls are values you set rather than a run you start;
// hydrology and erosion are stages with no step of their own: the erosion runs
// in the tectonics' epochs, and the rivers and lakes are the climate's readout,
// offered by the Climate step. The pipeline table (generator/pipeline/stages.ts) says what
// computes what; this one says what you SEE and WHEN.
//
// WHAT THE MAP CAN SHOW IS NOT THE STEP'S (2026-10-28). The layer panel
// holds every layer of the world in every step, in the world's groups
// (map/overlayGroups.ts); a layer is greyed out only while its data is not there. A
// step decides its controls, the layers its hover card reads out and its
// handbook page lists (`layers`), and its favourites, the panel's first
// group (`favourites`). A step turns no layer on or off: entering one
// changes only the favourites.
import { STAGES, type StageId } from '../../generator/pipeline/stages'
import type { OverlayId } from '../../map/overlays'
import { overlayGroupOf, resourceLayerId } from '../../map/overlayGroups'
import { PROGRESS_STEPS } from '../../world/worldProgress'

export type StepId = 'world' | 'genesis' | 'tectonics' | 'climate' | 'ecology' | 'finishing'

export interface Step {
  id: StepId
  // The stage this step drives.
  stage: StageId
  // The layers the step is about, in the order the hover card reads them
  // out. A layer may belong to several steps — the mantle field is the
  // Archean's subject and still drives the plates afterwards.
  layers: readonly OverlayId[]
  // THE FAVOURITES (2026-10-28): rows of the layer panel, by their id in
  // map/overlayGroups.ts, in the order the panel's first group shows
  // them. They are also what comes on as a world opens in this step and
  // on the panel's "Defaults", everything else off (favouritesToTurnOn:
  // of a group of one choice, the first listed). A resource field is its
  // row, `resource:<field>`.
  favourites: readonly string[]
  // What the bar's mark says instead of the number: the finishing's F. The
  // finishing holds the detail jobs on the finished world, and is outside the
  // numbering; it stays linked to the step before it, and it is the last
  // link of the chain that a world's progress is counted on.
  mark?: string
}

// The climate's washes and the pressure, in the order the hover card reads
// them out (the order of the panel's groups until the pressure became a
// switch, 2026-10-28).
const CLIMATE_WASHES: readonly OverlayId[] = [
  'precipitation', 'seasonality', 'monsoon', 'koppen', 'biomes', 'pressure', 'waterBalance', 'watersheds',
  'upwelling', 'salinity',
  'fog', 'foehn', 'rainVariability', 'enso', 'cyclone', 'tornado', 'blizzard', 'dust', 'thunder',
]

export const STEPS: readonly Step[] = [
  {
    // Name, seed and the planet. The planet acts through the climate, so the
    // step is about the climate's own layers — on the sample world until the
    // world has plates, then on the world itself. (Step 1 was the planet
    // alone until 2026-09-28; its three sliders did not earn a step.)
    //
    // The planet preview computes no refinement and no hydrology: only its
    // own layers are available on it (GeneratorScreen PLANET_PREVIEW_LAYERS).
    // Temperature is the favourite: the planet sliders act on it first.
    id: 'world',
    stage: 'planet',
    layers: ['temperature', 'wind', 'currents', 'precipitation', 'seasonality', 'monsoon', 'koppen'],
    favourites: ['temperature'],
  },
  {
    // No continent names: nothing is named until the hand-over. No plate
    // outlines either — the Archean has no plates, and its renders place
    // none.
    id: 'genesis',
    stage: 'genesis',
    layers: ['terrain', 'mantle', 'hotspots', 'cratonAge'],
    favourites: ['terrain', 'mantle', 'hotspots', 'cratonAge'],
  },
  {
    // The mantle and its plumes again: they drove the Archean and they drive
    // the plates, and this is the step where you watch them do it. The plate
    // outlines are what this step makes.
    id: 'tectonics',
    stage: 'tectonics',
    layers: ['terrain', 'boundaries', 'names', 'mantle', 'hotspots', 'volcanoes'],
    favourites: ['terrain', 'boundaries', 'names', 'mantle', 'hotspots', 'volcanoes'],
  },
  {
    // TEMPERATURE IS THE STEP'S GROUND. It drives everything else here —
    // seasonality is its annual amplitude, the biomes are classified from it —
    // so it is a switch that stays on, not one answer among many.
    //
    // No terrain wash among the favourites: a colour wash under a
    // temperature ramp reads as a third colour.
    //
    // The rivers, the water balance and the watersheds are the climate's
    // readout since the erosion step went (2026-09-29): the hydrology runs
    // on this step's refined climate.
    id: 'climate',
    stage: 'climate',
    layers: ['terrain', 'names', 'temperature', 'wind', 'currents', 'rivers', ...CLIMATE_WASHES],
    favourites: ['names', 'temperature'],
  },
  {
    // The resource layer is the reason you are here: its first field, the
    // carrying capacity, is a favourite.
    id: 'ecology',
    stage: 'ecology',
    layers: ['terrain', 'names', 'biomes', 'rivers', 'ecology'],
    favourites: ['names', resourceLayerId('carryingCapacity')],
  },
  {
    // The detail jobs on the finished world (2026-09-29): nothing yet — which
    // jobs belong here is decided when they are built.
    id: 'finishing',
    stage: 'finishing',
    layers: ['terrain', 'names', 'rivers', 'biomes'],
    favourites: ['terrain', 'names', 'rivers'],
    mark: 'F',
  },
]

// A favourite that is no row of the panel is a typo, and would be left out
// without a word. Checked here rather than left to the screen, for the same
// reason the pipeline order is. Several members of a group of one choice
// may be favourites; the first listed is the one that comes on.
for (const s of STEPS) {
  const unknown = s.favourites.filter((id) => !overlayGroupOf(id))
  if (unknown.length > 0) throw new Error(`generator step ${s.id} has favourites that are no layer row: ${unknown}`)
}

export const STEP_IDS: readonly StepId[] = STEPS.map((s) => s.id)

const BY_ID = new Map(STEPS.map((s) => [s.id, s]))

// Throws rather than returning undefined, for the same reason `stage()` does: an
// id that is not a step is a typo, and a typo that reads as "no step" would make
// a navigation silently do nothing.
export function step(id: StepId): Step {
  const found = BY_ID.get(id)
  if (!found) throw new Error(`unknown generator step: ${id}`)
  return found
}

// Stages that deliberately have no step of their own.
const UNSTEPPED: readonly StageId[] = ['hydrology', 'erosion']

// The table used to be derived from STAGES, which meant a stage added to the
// pipeline became a step nobody had written a label for. Declared instead, and
// checked here: every stage is either driven by exactly one step or named above
// as unstepped, and the steps run in pipeline order. It fails at startup rather
// than half a screen later.
const stepped = STEPS.map((s) => s.stage)
for (const s of STAGES) {
  if (!stepped.includes(s.id) && !UNSTEPPED.includes(s.id)) {
    throw new Error(`pipeline stage ${s.id} has no generator step and is not listed as unstepped`)
  }
}
const pipelineOrder = STAGES.map((s) => s.id).filter((id) => stepped.includes(id))
if (String(pipelineOrder) !== String(stepped)) {
  throw new Error(`generator steps are out of pipeline order: ${stepped} vs ${pipelineOrder}`)
}

// A world's progress (world/worldProgress.ts) is counted on this chain. The
// world layer names the steps again, since it may not import a
// screen; the two lists must agree, or a saved progress would name a step the
// bar does not have.
const chain = STEPS.map((s) => s.id)
if (String(chain) !== String(PROGRESS_STEPS)) {
  throw new Error(`generator step chain ${chain} does not match the progress steps ${PROGRESS_STEPS}`)
}
