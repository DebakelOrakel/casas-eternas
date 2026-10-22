import { ENGINE_CONSTANTS } from '../generator/pipeline/engineConstants'
import { runParamConstants } from './runParams'

// THE TUNING A WORLD'S RUNS READ: every tuning object and default the
// history reads — the Archean, the plates, the crust, the mantle, the
// mesh, the erosion, the climate inside the epochs —, as the engine gives
// them (generator/pipeline/engineConstants.ts), by group. Not the ecology's and
// the migration's: no run reads them. Level 1 is the history replayed
// (world/replay.ts), so these are part of the mesh pipeline's version
// (meshArtifacts.MESH_BAKE_CONSTANTS, 2026-10-17) — a change to any of
// them makes the levels and the tiles again, and the worlds made before
// it are made by another pipeline (worldPipeline.ts).

// The tuning, flattened to named numbers: nested objects by dotted path,
// arrays by index, booleans as 0 and 1.
function flatten(prefix: string, value: unknown, out: Record<string, number>): void {
  if (typeof value === 'number') out[prefix] = value
  else if (typeof value === 'boolean') out[prefix] = value ? 1 : 0
  else if (Array.isArray(value)) value.forEach((v, i) => flatten(`${prefix}.${i}`, v, out))
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) flatten(`${prefix}.${k}`, v, out)
}

export function worldTuning(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, group] of Object.entries(ENGINE_CONSTANTS.tuning)) flatten(name, group, out)
  // And how the recorded control values become the runs' parameters
  // (runParams.ts, 2026-10-22).
  flatten('runParams', runParamConstants(), out)
  return out
}
