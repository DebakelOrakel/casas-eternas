import type { InputParam } from '../core/inputParams'
import { ARCHEAN_INPUTS } from '../archean/archeanInputParams'
import { CLIMATE_INPUTS } from '../climate/climateInputParams'
import { SURFACE_INPUTS } from '../surface/surfaceInputParams'
import { ECOLOGY_ABUNDANCE, ECOLOGY_ABUNDANCE_GROUPS, ECOLOGY_INPUTS } from '../ecology/ecologyInputParams'
import { readRecipeNumber } from './recipeYaml'

// The RECIPE half of a world save — `spec:` in world.yaml — as one ordered table
// that both writes and reads it.
//
// It used to be two hand-maintained lists in WorldGenScreen: a `buildWorldYaml`
// that concatenated strings out of `input.value`, and a load path that pulled
// the same keys back one regex at a time. Nothing tied them together, so a key
// added to one and forgotten in the other would save fine and silently load its
// default — which is exactly what happened to the migration sliders, present in
// the UI and in the worker message and absent from every save ever written.
//
// The order below IS the file order. Changing it changes the bytes of every
// world.yaml written afterwards, so it is a format decision, not formatting.

export interface SpecField {
  // Dotted path under `spec:`. Also the yaml nesting: `ecology.metal.tin` writes
  // three levels and reads back from `spec.ecology.metal.tin`.
  path: string
  // The control this value comes from — its default is what a save that predates
  // the key loads as.
  input: InputParam
}

const abundanceFields: SpecField[] = ECOLOGY_ABUNDANCE_GROUPS.flatMap((group) =>
  group.fields.map((field) => ({
    path: `ecology.${group.id}.${field}`,
    // All thirteen share one range and one default; only their labels differ.
    input: { ...ECOLOGY_ABUNDANCE, i18n: '', inSpec: true } as InputParam,
  })),
)

export const WORLD_SPEC_FIELDS: readonly SpecField[] = [
  { path: 'genesis.mantleVigour', input: ARCHEAN_INPUTS.mantleVigour },
  { path: 'genesis.water', input: ARCHEAN_INPUTS.water },
  { path: 'erosion.erosionStrength', input: SURFACE_INPUTS.erosionStrength },
  { path: 'erosion.drainageRefresh', input: SURFACE_INPUTS.drainageRefresh },
  // Climate's file order is NOT the panel's order (the panel shows the equator
  // offset second). Kept as it was written, because changing it would rewrite
  // every save for no gain.
  { path: 'climate.tempOffset', input: CLIMATE_INPUTS.tempOffset },
  { path: 'climate.humidity', input: CLIMATE_INPUTS.humidity },
  { path: 'climate.contrast', input: CLIMATE_INPUTS.contrast },
  { path: 'climate.equatorOffset', input: CLIMATE_INPUTS.equatorOffset },
  { path: 'hydrology.riverDensity', input: SURFACE_INPUTS.riverDensity },
  { path: 'ecology.carryingCapacity', input: ECOLOGY_INPUTS.carryingCapacity },
  { path: 'ecology.concentration', input: ECOLOGY_INPUTS.concentration },
  { path: 'ecology.provinceStrength', input: ECOLOGY_INPUTS.provinceStrength },
  ...abundanceFields,
]

// A world's recipe: the seed plus one number per field above.
export interface WorldSpec {
  seed: string
  values: Record<string, number>
}

// Emits the `spec:` block, seed first. Groups are opened when the path's parent
// changes, which is what reproduces the nesting without a second description of
// it — the table's order is the only thing that decides the layout.
export function specToYamlLines(spec: WorldSpec): string[] {
  const lines = [`  seed: "${spec.seed}"`]
  let open: string[] = []
  for (const field of WORLD_SPEC_FIELDS) {
    const parts = field.path.split('.')
    const parents = parts.slice(0, -1)
    for (let depth = 0; depth < parents.length; depth++) {
      if (open[depth] === parents[depth] && open.length > depth) continue
      lines.push(`${'  '.repeat(depth + 1)}${parents[depth]}:`)
      open = [...parents.slice(0, depth), parents[depth]]
    }
    lines.push(`${'  '.repeat(parents.length + 1)}${parts[parts.length - 1]}: ${spec.values[field.path]}`)
  }
  return lines
}

// Reads it back, every gap filled by the control's declared default.
//
// A missing key means the save predates that knob, and those worlds were
// generated with its default — so the default is the only answer that does not
// invent history. The load path used to answer this two ways (genesis and
// erosion kept whatever the slider happened to show, the other eight took the
// default); the split had no stated reason and was resolved in favour of one
// rule on 2026-08-09.
export function specFromYaml(yaml: string, seed: string): WorldSpec {
  const values: Record<string, number> = {}
  for (const field of WORLD_SPEC_FIELDS) {
    values[field.path] = readRecipeNumber(yaml, `spec.${field.path}`) ?? field.input.default
  }
  return { seed, values }
}
