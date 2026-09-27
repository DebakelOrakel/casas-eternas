import { readRecipeNumber, readRecipeValue } from './recipeYaml'
import { WORLD_SPEC_FIELDS, valuesToYamlLines } from './worldSpec'
import type { SpecField } from './worldSpec'

// HOW the world came about, run by run — the half of the recipe `spec` does
// not hold. `spec` is the sliders as they stand at the save; a world whose
// sliders were moved between two runs was made by values the spec no
// longer shows. This block keeps them: one entry per run of the Archean
// and of the tectonics, with the values it ran on, how many epochs, and
// which build ran it (a world continued on a newer build is two worlds'
// worth of code, and this is what says where the seam is).
//
// A run is cut where its values reach the worker — the start gesture; the
// sliders do not reach a running simulation (tectonics reads them at
// start, the Archean regenerates on a change), so the count per entry is
// exact. Same values and build as the last entry → the run extends it
// rather than opening a new one; the list says what changed, not how
// often the button was pressed.
//
// Documentation first (2026-09-27): nothing replays it yet. A replay
// would also need the resets and the loads in order, and the generator
// string is a build id, not an algorithm version. The lists follow the
// world's own resets: a tectonics reset empties the tectonics list (the
// hand-over is where it starts again), a fresh Archean empties both.
//
// Written as numbered maps rather than YAML lists, because the recipe
// reader (recipeYaml.ts) walks dotted paths and knows no sequences:
// `history.tectonics.0.epochs`.
export interface WorldRun {
  epochs: number
  generator: string
  values: Record<string, number>
}

export interface WorldHistory {
  genesis: WorldRun[]
  tectonics: WorldRun[]
}

export const emptyWorldHistory = (): WorldHistory => ({ genesis: [], tectonics: [] })

// The controls each stage's run reads. The tectonics' epoch is coupled
// (phase 5.1): its erosion is forced by the climate, which the climate and
// the planet controls set, so all three groups are the run's values.
export const GENESIS_RUN_FIELDS: readonly SpecField[] = WORLD_SPEC_FIELDS.filter((f) => f.path.startsWith('genesis.'))
export const TECTONICS_RUN_FIELDS: readonly SpecField[] = WORLD_SPEC_FIELDS.filter((f) => /^(planet|tectonics|climate)\./.test(f.path))

export function runValues(fields: readonly SpecField[], values: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const field of fields) out[field.path] = values[field.path]
  return out
}

function sameRun(run: WorldRun, values: Record<string, number>, generator: string): boolean {
  if (run.generator !== generator) return false
  for (const key of Object.keys(values)) if (run.values[key] !== values[key]) return false
  return true
}

// A run begins: extends the last entry when nothing changed, opens one otherwise.
export function openRun(runs: WorldRun[], values: Record<string, number>, generator: string): void {
  const last = runs[runs.length - 1]
  if (last && sameRun(last, values, generator)) return
  runs.push({ epochs: 0, generator, values: { ...values } })
}

// Epochs ran: counted on the last entry. A list with no entry (a save from
// before this block, continued) gets one with the values the run reads now.
export function tallyRun(runs: WorldRun[], epochs: number, values: Record<string, number>, generator: string): void {
  if (epochs <= 0) return
  if (runs.length === 0) openRun(runs, values, generator)
  runs[runs.length - 1].epochs += epochs
}

// The `history:` block, omitted entirely while there is nothing to tell —
// a save with no run reads exactly as one from before the block existed.
export function historyToYamlLines(history: WorldHistory): string[] {
  const lines: string[] = []
  const group = (name: string, runs: WorldRun[], fields: readonly SpecField[]): void => {
    if (runs.length === 0) return
    lines.push(`  ${name}:`)
    runs.forEach((run, index) => {
      lines.push(`    ${index}:`)
      lines.push(`      epochs: ${run.epochs}`)
      lines.push(`      generator: ${run.generator}`)
      lines.push('      values:')
      lines.push(...valuesToYamlLines(fields, run.values, 4))
    })
  }
  group('genesis', history.genesis, GENESIS_RUN_FIELDS)
  group('tectonics', history.tectonics, TECTONICS_RUN_FIELDS)
  return lines.length > 0 ? ['history:', ...lines] : []
}

// Reads it back; a save without the block has empty lists. A value a run
// did not record (a control added later) reads as the control's default,
// the same rule the spec follows.
export function historyFromYaml(yaml: string): WorldHistory {
  const group = (name: string, fields: readonly SpecField[]): WorldRun[] => {
    const runs: WorldRun[] = []
    for (let index = 0; ; index++) {
      const base = `history.${name}.${index}`
      const epochs = readRecipeNumber(yaml, `${base}.epochs`)
      if (epochs === undefined) break
      const values: Record<string, number> = {}
      for (const field of fields) values[field.path] = readRecipeNumber(yaml, `${base}.values.${field.path}`) ?? field.input.default
      runs.push({ epochs, generator: readRecipeValue(yaml, `${base}.generator`) ?? '', values })
    }
    return runs
  }
  return { genesis: group('genesis', GENESIS_RUN_FIELDS), tectonics: group('tectonics', TECTONICS_RUN_FIELDS) }
}
