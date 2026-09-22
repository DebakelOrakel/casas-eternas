import type { InputParam } from '../../generator/core/inputParams'
import { ARCHEAN_INPUTS } from '../../generator/archean/archeanInputParams'
import { CLIMATE_INPUTS } from '../../generator/climate/climateInputParams'
import { PLANET_INPUTS } from '../../generator/planet/planetInputParams'
import { SURFACE_INPUTS } from '../../generator/surface/surfaceInputParams'
import { ECOLOGY_ABUNDANCE, ECOLOGY_ABUNDANCE_GROUPS, ECOLOGY_INPUTS } from '../../generator/ecology/ecologyInputParams'
import { readRecipeNumber } from './recipeYaml'

// The RECIPE half of a world save — `spec:` in world.yaml — as one ordered table
// that both writes and reads it.
//
// It used to be two hand-maintained lists in GeneratorScreen: a `buildWorldYaml`
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
  // Paths the same value was written under before (a control that moved
  // stage): read when the current path is absent, so an older save keeps the
  // world it describes. Never written.
  legacyPaths?: readonly string[]
}

const abundanceFields: SpecField[] = ECOLOGY_ABUNDANCE_GROUPS.flatMap((group) =>
  group.fields.map((field) => ({
    path: `ecology.${group.id}.${field}`,
    // All thirteen share one range and one default; only their labels differ.
    input: { ...ECOLOGY_ABUNDANCE, i18n: '', inSpec: true } as InputParam,
  })),
)

export const WORLD_SPEC_FIELDS: readonly SpecField[] = [
  // The Planet stage (2026-09-22, F2) opens the file: `greenhouse` lived
  // under climate as tempOffset and is read back from there for the saves
  // written before. (`water` visited the planet the same day and went back
  // to the genesis; the alias reads the few saves written in between.)
  { path: 'planet.obliquity', input: PLANET_INPUTS.obliquity },
  { path: 'planet.greenhouse', input: PLANET_INPUTS.greenhouse, legacyPaths: ['climate.tempOffset'] },
  { path: 'planet.rotation', input: PLANET_INPUTS.rotation },
  { path: 'genesis.mantleVigour', input: ARCHEAN_INPUTS.mantleVigour },
  { path: 'genesis.water', input: ARCHEAN_INPUTS.water, legacyPaths: ['planet.water'] },
  { path: 'erosion.landscapeAge', input: SURFACE_INPUTS.landscapeAge },
  { path: 'erosion.alluvium', input: SURFACE_INPUTS.alluvium },
  { path: 'erosion.rockContrast', input: SURFACE_INPUTS.rockContrast },
  // Climate's file order is NOT the panel's order (the panel shows the equator
  // offset second). Kept as it was written, because changing it would rewrite
  // every save for no gain.
  { path: 'climate.humidity', input: CLIMATE_INPUTS.humidity },
  { path: 'climate.contrast', input: CLIMATE_INPUTS.contrast },
  { path: 'climate.equatorOffset', input: CLIMATE_INPUTS.equatorOffset },
  // hydrology.riverDensity left the spec with erosion-v2 P4: the slider is a
  // draw filter now, and a spec field would dirty the save for a display
  // choice. Old saves carrying the key are read the usual partial-spec way —
  // the unknown line is simply ignored.
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
    let value = readRecipeNumber(yaml, `spec.${field.path}`)
    for (const legacy of field.legacyPaths ?? []) value ??= readRecipeNumber(yaml, `spec.${legacy}`)
    values[field.path] = value ?? field.input.default
  }
  return { seed, values }
}
