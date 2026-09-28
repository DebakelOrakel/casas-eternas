// THE STEPS, AS DATA. One entry per step: which pipeline stage it drives, which
// map layers it offers, and which of those are showing when you enter it.
//
// A STEP is not a STAGE. Step 0 names and seeds the world and also drives the
// planet stage, whose controls are values you set rather than a run you start;
// hydrology is a stage with no step of its own, because its rivers and lakes
// are the readout of the erosion solve — so its layers are offered by the
// Erosion step. The pipeline table (generator/pipeline/stages.ts) says what
// computes what; this one says what you SEE and WHEN.
//
// WHY IT EXISTS. The same question — "what belongs to this step?" — used to be
// answered in four places that could disagree, and did: a per-stage grouping of
// the overlay bar named every layer exactly ONCE, while the screen switched the
// mantle and the plumes on for Tectonics as well. The bar then offered them
// under Genesis while Tectonics showed them, and the column's count said "0 / 2"
// with five layers on the map. A layer belongs to as many steps as it is useful
// in, which is what `overlays` says and a grouping could not.
import { STAGES, type StageId } from '../../generator/pipeline/stages'
import { ECOLOGY_ABUNDANCE_GROUPS } from '../../generator/ecology/ecologyInputParams'
import type { EcologyFieldId } from '../../generator/ecology/ecologyField'
import type { OverlayId } from './overlays'

export type StepId = 'world' | 'genesis' | 'tectonics' | 'climate' | 'erosion' | 'ecology' | 'migration'

export interface Step {
  id: StepId
  // The stage this step drives.
  stage: StageId
  // The layers the column offers, in the order it lists them. A layer may
  // appear in several steps — the mantle field is the Archean's subject and
  // still drives the plates afterwards.
  overlays: readonly OverlayId[]
  // Layers the step shows ONE AT A TIME. Same shape as `fields` below — a pick,
  // not a set of switches — but of ordinary layers. Two kinds of thing end up
  // here: full-map washes, which physically cannot share the map (the later one
  // covers the earlier, and what is left is a colour on no legend), and layers
  // the step simply asks one at a time. The second is a reading decision, not a
  // rendering one.
  //
  // Disjoint from `overlays`, and at most one member is in `defaults`: the
  // group has a "none" (the screen adds it, first and selected), and since
  // 2026-09-22 a step starts on it unless it names a layer.
  exclusive: readonly OverlayId[]
  // The catalog base for the pick group's heading. The group asks a different
  // question in each step, so the step names it; unset means no heading.
  pickTitle?: string
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
    // Name, seed and the planet. The planet acts through the climate, so the
    // step shows the climate's own layers — on the sample world until the
    // world has plates, then on the world itself. The washes and the wind are
    // one at a time. (Step 1 was the planet alone until 2026-09-28; its three
    // sliders did not earn a step.)
    //
    // No terrain wash (2026-09-28). Temperature is on at entry: the planet
    // sliders act on it first.
    id: 'world',
    stage: 'planet',
    overlays: ['temperature'],
    exclusive: ['precipitation', 'seasonality', 'monsoon', 'wind', 'currents'],
    pickTitle: 'generator.section.climateFields',
    defaults: ['temperature'],
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
    exclusive: [],
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
    exclusive: [],
    defaults: ['terrain', 'boundaries', 'names', 'mantle', 'hotspots', 'volcanoes'],
    fields: [],
  },
  {
    id: 'climate',
    stage: 'climate',
    // TEMPERATURE IS THE STEP'S GROUND. It drives everything else here —
    // seasonality is its annual amplitude, the biomes are classified from it —
    // so it is a switch that stays on, not one answer among many.
    //
    // Everything else is one question at a time. For the washes that is forced:
    // precipitation, seasonality, monsoon and biomes all paint the whole map.
    // Wind and currents are strokes and could combine; they are in the group
    // because the step asks them one at a time, which is a choice.
    //
    // No terrain wash by default: a colour wash under a temperature ramp reads
    // as a third colour.
    overlays: ['terrain', 'names', 'temperature'],
    exclusive: ['precipitation', 'seasonality', 'monsoon', 'biomes', 'pressure', 'wind', 'currents'],
    pickTitle: 'generator.section.climateFields',
    defaults: ['names', 'temperature'],
    fields: [],
  },
  {
    id: 'erosion',
    stage: 'erosion',
    // The hydrology stage has no step: rivers and lakes are what this solve
    // produces, so they are offered here.
    overlays: ['terrain', 'names', 'rivers', 'waterBalance', 'watersheds', 'biomes'],
    exclusive: [],
    defaults: ['terrain', 'names', 'rivers'],
    fields: [],
  },
  {
    id: 'ecology',
    stage: 'ecology',
    overlays: ['terrain', 'names', 'biomes', 'rivers'],
    exclusive: [],
    // The resource layer comes on with the step — it is the reason you are
    // here — painting whichever field the picker below starts on.
    defaults: ['names', 'ecology'],
    fields: ['carryingCapacity', ...RESOURCE_FIELDS],
    pickTitle: 'generator.section.resources',
  },
  {
    id: 'migration',
    stage: 'migration',
    overlays: ['terrain', 'names', 'migration'],
    exclusive: [],
    defaults: ['names', 'migration'],
    fields: [],
    aside: true,
  },
]

// A pick group with no member on, or with two, is a radio that cannot say what
// the map is showing; a layer that is both a switch and a pick is two answers to
// one question. Checked here rather than left to the screen, for the same reason
// the pipeline order is.
for (const s of STEPS) {
  const both = s.exclusive.filter((id) => s.overlays.includes(id))
  if (both.length > 0) throw new Error(`generator step ${s.id} lists ${both} as both a switch and a pick`)
  const chosen = s.exclusive.filter((id) => s.defaults.includes(id))
  if (chosen.length > 1) {
    throw new Error(`generator step ${s.id} must default to at most one of its exclusive layers, not ${chosen.length}`)
  }
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
const UNSTEPPED: readonly StageId[] = ['hydrology']

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
