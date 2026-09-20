// THE STEPS, AS DATA. One entry per step: which pipeline stage it drives, which
// map layers it offers, and which of those are showing when you enter it.
//
// A STEP is not a STAGE. Step 0 names and seeds the world and drives no stage at
// all; hydrology is a stage with no step of its own, because its rivers and
// lakes are the readout of the erosion solve — so its layers are offered by the
// Erosion step. The pipeline table (worldgen/pipeline/stages.ts) says what
// computes what; this one says what you SEE and WHEN.
//
// WHY IT EXISTS. The same question — "what belongs to this step?" — used to be
// answered in four places that could disagree, and did: a per-stage grouping of
// the overlay bar named every layer exactly ONCE, while the screen switched the
// mantle and the plumes on for Tectonics as well. The bar then offered them
// under Genesis while Tectonics showed them, and the column's count said "0 / 2"
// with five layers on the map. A layer belongs to as many steps as it is useful
// in, which is what `overlays` says and a grouping could not.
import { STAGES, type StageId } from '../../worldgen/pipeline/stages'
import { ECOLOGY_ABUNDANCE_GROUPS } from '../../worldgen/ecology/ecologyInputParams'
import type { EcologyFieldId } from '../../worldgen/ecology/ecologyField'
import type { OverlayId } from './overlays'

export type StepId = 'world' | 'genesis' | 'tectonics' | 'climate' | 'erosion' | 'ecology' | 'migration'

export interface Step {
  id: StepId
  // The stage this step drives, or null for step 0, which computes nothing.
  stage: StageId | null
  // The layers the column offers, in the order it lists them. A layer may
  // appear in several steps — the mantle field is the Archean's subject and
  // still drives the plates afterwards.
  overlays: readonly OverlayId[]
  // Of those, the ones showing when the step is entered. Entering a step is a
  // statement about what you want to look at, so this is a reset, not a memory.
  defaults: readonly OverlayId[]
  // Resource fields, which are a PICK rather than a set of switches: the layer
  // paints one field over the whole land, so a second could only overwrite the
  // first. Empty everywhere but Ecology.
  fields: readonly EcologyFieldId[]
  // Reachable, but not a link in the chain — migration leaves the generator for
  // a screen of its own later, and dropping it from the bar now would make it
  // unreachable by accident rather than by decision.
  aside?: boolean
}

// Flat list of the per-field abundance controls, derived from the grouping the
// save uses, so the picker and the save can never disagree about which fields
// exist.
const RESOURCE_FIELDS: readonly EcologyFieldId[] = ECOLOGY_ABUNDANCE_GROUPS.flatMap((g) => [...g.fields])

export const STEPS: readonly Step[] = [
  {
    id: 'world',
    stage: null,
    // Nothing to look at yet: the step is about which world, not about what the
    // map is showing. The colour wash is offered so the map is not dead.
    overlays: ['terrain'],
    defaults: [],
    fields: [],
  },
  {
    id: 'genesis',
    stage: 'genesis',
    // No continent names: nothing is named until the hand-over, so the row
    // would be permanently unavailable. No plate outlines either — the Archean
    // has no plates, and the preview of the ones a hand-over would produce is
    // an answer the world has not taken yet.
    overlays: ['terrain', 'mantle', 'hotspots', 'cratonAge'],
    defaults: ['terrain', 'mantle', 'hotspots', 'cratonAge'],
    fields: [],
  },
  {
    id: 'tectonics',
    stage: 'tectonics',
    // The mantle and its plumes again: they drove the Archean and they drive
    // the plates, and this is the step where you watch them do it. The plate
    // outlines belong HERE ALONE — they are what this step makes, and on a
    // climate or a resource map they are a grid over somebody else's subject.
    overlays: ['terrain', 'boundaries', 'names', 'mantle', 'hotspots', 'volcanoes'],
    defaults: ['terrain', 'boundaries', 'names', 'mantle', 'hotspots', 'volcanoes'],
    fields: [],
  },
  {
    id: 'climate',
    stage: 'climate',
    // No terrain wash by default: the climate layers are the point here, and a
    // colour wash under a temperature ramp reads as a third colour.
    overlays: ['terrain', 'names', 'temperature', 'seasonality', 'precipitation', 'monsoon', 'wind', 'currents', 'biomes'],
    defaults: ['names', 'temperature'],
    fields: [],
  },
  {
    id: 'erosion',
    stage: 'erosion',
    // The hydrology stage has no step: rivers and lakes are what this solve
    // produces, so they are offered here.
    overlays: ['terrain', 'names', 'rivers', 'waterBalance', 'watersheds', 'biomes'],
    defaults: ['terrain', 'names', 'rivers'],
    fields: [],
  },
  {
    id: 'ecology',
    stage: 'ecology',
    overlays: ['terrain', 'names', 'biomes', 'rivers'],
    // The resource layer comes on with the step — it is the reason you are
    // here — painting whichever field the picker below starts on.
    defaults: ['names', 'ecology'],
    fields: ['carryingCapacity', ...RESOURCE_FIELDS],
  },
  {
    id: 'migration',
    stage: 'migration',
    overlays: ['terrain', 'names', 'migration'],
    defaults: ['names', 'migration'],
    fields: [],
    aside: true,
  },
]

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
const UNSTEPPED: readonly StageId[] = ['hydrology']

// The table used to be derived from STAGES, which meant a stage added to the
// pipeline became a step nobody had written a label for. Declared instead, and
// checked here: every stage is either driven by exactly one step or named above
// as unstepped, and the steps run in pipeline order. It fails at startup rather
// than half a screen later.
const stepped = STEPS.map((s) => s.stage).filter((id): id is StageId => id !== null)
for (const s of STAGES) {
  if (!stepped.includes(s.id) && !UNSTEPPED.includes(s.id)) {
    throw new Error(`pipeline stage ${s.id} has no generator step and is not listed as unstepped`)
  }
}
const pipelineOrder = STAGES.map((s) => s.id).filter((id) => stepped.includes(id))
if (String(pipelineOrder) !== String(stepped)) {
  throw new Error(`generator steps are out of pipeline order: ${stepped} vs ${pipelineOrder}`)
}
