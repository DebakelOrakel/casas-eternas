// THE PIPELINE, AS DATA. One entry per stage: what it depends on, how it runs,
// which controls shape it, which fields it produces.
//
// Declared first, on purpose, so it could be checked against the code that
// already existed (npm run harness:pipeline verifies every edge, every field
// name and every control against the save's own spec table) before anything
// depended on it. Read since by the runtime's invalidation (downstreamOf), the
// screen's step bar and its stage gates (screens/generator/steps.ts).
// See docs/design/generator-pipeline.md.
//
// WHY IT EXISTS. runtime.ts holds each stage's live state as module-level `let`s,
// and "this result is stale" is expressed by setting fields to null. That makes
// invalidation a set of hand-written rules — correct today, and correct only for
// as long as someone remembers to update them. The rules are the same rules for
// every stage, so they should be derived from the edges rather than restated:
//
//   - invalidation flows DOWNSTREAM only. Resetting ecology leaves the terrain,
//     the climate and the rivers exactly where they were.
//   - downstream INPUTS are never touched. A later stage's sliders are stated
//     intent; discarding them because an earlier stage re-ran would be data loss,
//     not cleanup.
import type { InputParam } from '../core/inputParams'
import { ARCHEAN_INPUTS } from '../archean/archeanInputParams'
import { PLANET_INPUTS } from '../planet/planetInputParams'
import { TECTONICS_INPUTS } from '../tectonics/tectonicsInputParams'
import { CLIMATE_INPUTS } from '../climate/climateInputParams'
import { ECOLOGY_INPUTS } from '../ecology/ecologyInputParams'
import { ECOLOGY_FIELD_IDS } from '../ecology/ecologyField'
import { MIGRATION_INPUTS } from '../migration/migrationInputParams'

// `genesis` rather than `archean` because that is what the two user-facing
// surfaces already say: the panel is Genesis and every save on disk carries
// `spec.genesis.*`. The module is `archean/` (the era) and the messages are
// `archeanInit`/`archeanStart` (the implementation) — three names for one stage,
// which step 3d is where it gets resolved, not here.
export type StageId = 'planet' | 'genesis' | 'tectonics' | 'erosion' | 'climate' | 'hydrology' | 'ecology' | 'migration'

// How a stage occupies time, which decides what controlling it looks like. This
// is a real difference in kind, not an accident: a steppable stage runs on a
// clock until told to stop and has no natural end, a progressive one has a
// defined end and reports a fraction on the way, a one-shot one simply returns.
export type StageKind = 'steppable' | 'progressive' | 'oneShot'

export interface Stage {
  id: StageId
  // The stages whose RESULT this one reads.
  //
  // An edge is about invalidation, NOT about a precondition: climate depends on
  // erosion because eroding the terrain makes the climate stale, but climate runs
  // perfectly well on a world that has never been eroded. Reading these as "must
  // run first" is the one way to misuse this table.
  dependsOn: readonly StageId[]
  kind: StageKind
  // The user-facing controls that shape this stage's result — keyed as the stage
  // knows them. Declared per stage rather than per module because the two do not
  // coincide: `surface/` holds the controls of both erosion and hydrology.
  inputs: Readonly<Record<string, InputParam>>
  // The registered world fields this stage produces. Overlaps are real and
  // deliberate: three stages write `elevation`, each refining the last, and
  // hydrology rewrites `biome` because riparian and salt-flat cells override the
  // climate classification.
  outputs: readonly string[]
}

export const STAGES: readonly Stage[] = [
  {
    // THE PLANET (ADAPTIVE_MESH_PLAN.md F2, decision 13): what depends on the
    // planet and not on the relief. Computes nothing itself — its values are
    // read by every climate pass (the forcing), and the genesis stands on the
    // planet — so a change here makes the whole world stale, which is what a
    // different planet is. Until phase 5 only the final climate reads the
    // astronomical controls; the per-epoch climate will read the same.
    id: 'planet',
    dependsOn: [],
    kind: 'oneShot',
    inputs: {
      obliquity: PLANET_INPUTS.obliquity,
      greenhouse: PLANET_INPUTS.greenhouse,
      rotation: PLANET_INPUTS.rotation,
    },
    outputs: [],
  },
  {
    id: 'genesis',
    dependsOn: ['planet'],
    kind: 'steppable',
    inputs: { mantleVigour: ARCHEAN_INPUTS.mantleVigour, water: ARCHEAN_INPUTS.water },
    // The Archean's real product is the hand-over — the plate simulation the era
    // ends in — which is not a field and so cannot be listed here. It renders an
    // elevation on the way, and that is the field a consumer can ask for.
    outputs: ['elevation'],
  },
  {
    id: 'tectonics',
    dependsOn: ['genesis'],
    kind: 'steppable',
    // The coupled history (phase 5.1): erosion runs inside every epoch, so
    // its material controls and the epoch's length are this stage's. The
    // epoch INTERVAL stays what it was — playback speed, never an input.
    inputs: { alluvium: TECTONICS_INPUTS.alluvium, rockContrast: TECTONICS_INPUTS.rockContrast },
    outputs: ['elevation'],
  },
  {
    id: 'climate',
    // BEFORE erosion since the stage-2 coupling (2026-08-16): the erosion
    // engine's water forcing evaluates the weather chain with the climate
    // panel's parameters, so a climate-slider change makes the EROSION
    // stale, not the other way round. The stage computes on the
    // pre-erosion terrain (the same input the forcing sees); the
    // post-erosion climate truth is the hydrology stage's refinement pass.
    dependsOn: ['planet', 'tectonics'],
    kind: 'oneShot',
    // The temperature offset is the planet's greenhouse control now.
    inputs: {
      humidity: CLIMATE_INPUTS.humidity,
      contrast: CLIMATE_INPUTS.contrast,
    },
    // Wind and ocean currents are computed and cached here too, and are neither
    // registered fields nor saved — the ecology step is their only consumer.
    // `landMask` is NOT produced here despite being a climate-grid field: the
    // save derives it from precipitation's ocean sentinel at write time.
    outputs: ['temperature', 'precipitation', 'seasonalAmplitude', 'monsoonIndex', 'biome'],
  },
  {
    id: 'erosion',
    // The climate edge is about the CONTROLS, not the fields: the forcing
    // evaluates the weather chain itself (erosionForcing.ts), but it does so
    // with the climate panel's sliders — so their change invalidates the
    // carved terrain.
    dependsOn: ['tectonics', 'climate'],
    kind: 'progressive',
    // Since phase 5.1 the erosion has no run of its own — it happens in the
    // tectonics' epochs. The stage stays for its panel (the bakes, the
    // overlays) and its place in the invalidation order; it computes nothing.
    inputs: {},
    outputs: ['elevation'],
  },
  {
    id: 'hydrology',
    // Two real edges: the rivers take their water from precipitation, and they
    // are routed over the terrain — over erosion's PRE-FILL field specifically,
    // so that basins still exist for lakes to fill.
    dependsOn: ['climate', 'erosion'],
    kind: 'oneShot',
    // No controls since the density slider died (P4/teardown) — and no panel
    // either: the stage runs after each erosion pass and on demand from the
    // stages downstream; its readout lives on the erosion panel.
    inputs: {},
    // Rewrites `biome` for riparian and salt-flat cells. River polylines and
    // watersheds are drawn but not registered fields.
    outputs: ['discharge', 'lakeDepth', 'precipitationEffective', 'biome'],
  },
  {
    id: 'ecology',
    dependsOn: ['climate', 'hydrology'],
    kind: 'oneShot',
    inputs: {
      carryingCapacity: ECOLOGY_INPUTS.carryingCapacity,
      concentration: ECOLOGY_INPUTS.concentration,
      provinceStrength: ECOLOGY_INPUTS.provinceStrength,
    },
    // Plus the thirteen per-field abundance nudges, which share one range and
    // reach the save through ECOLOGY_ABUNDANCE_GROUPS rather than as named
    // controls — see worldSpec.ts.
    outputs: [...ECOLOGY_FIELD_IDS],
  },
  {
    id: 'migration',
    // Reads the carrying capacity, and through it everything ecology read.
    dependsOn: ['ecology'],
    kind: 'oneShot',
    inputs: {
      spreadBudget: MIGRATION_INPUTS.spreadBudget,
      arrowThreshold: MIGRATION_INPUTS.arrowThreshold,
      seaCrossing: MIGRATION_INPUTS.seaCrossing,
    },
    // Deliberately empty. Migration produces four rasters (race, density, flow,
    // predecessor) that are registered nowhere and saved nowhere, because the
    // step may yet leave the generator for a screen of its own — which is also
    // why its controls carry inSpec: false.
    outputs: [],
  },
]

const BY_ID = new Map(STAGES.map((s) => [s.id, s]))

// Throws rather than returning undefined, for the same reason fieldSpec does: an
// id that is not a stage is a typo, and a typo that reads as "no stage" would
// make an invalidation silently do nothing.
export function stage(id: StageId): Stage {
  const found = BY_ID.get(id)
  if (!found) throw new Error(`unknown pipeline stage: ${id}`)
  return found
}

// Every stage that must be discarded when `id` changes — its dependants,
// transitively, in pipeline order. `id` itself is NOT included: whether the
// stage that changed keeps its own result is the caller's business (re-running
// it replaces the result, resetting it drops it), and folding that decision in
// here would leave no way to say the other one.
export function downstreamOf(id: StageId): readonly StageId[] {
  const affected = new Set<StageId>()
  let grew = true
  while (grew) {
    grew = false
    for (const s of STAGES) {
      if (affected.has(s.id)) continue
      if (s.dependsOn.some((d) => d === id || affected.has(d))) {
        affected.add(s.id)
        grew = true
      }
    }
  }
  return STAGES.filter((s) => affected.has(s.id)).map((s) => s.id)
}
