import { DEFAULT_ARCHEAN_PARAMS } from '../generator/archean/archeanStep'
import { DEFAULT_NUCLEATION_PARAMS } from '../generator/archean/crustNucleation'
import { CLIMATE_TUNING } from '../generator/climate/climateTuneParams'
import { MERGE_OVERLAP_FACTOR, RAFT_CONNECT_FACTOR } from '../generator/crust/crustTuneParams'
import { DEFAULT_ERODIBILITY_FIELD_PARAMS } from '../generator/elevation/erodibilityField'
import { ELEVATION_TUNING } from '../generator/elevation/elevationTuneParams'
import { MANTLE_TUNING } from '../generator/mantle/mantleTuneParams'
import { COLUMN_TUNING } from '../generator/mesh/meshColumn'
import { MESH_TUNING } from '../generator/mesh/meshDensity'
import { HISTORY_DEFAULTS } from '../generator/pipeline/coupledEpoch'
import { COVER_TUNING } from '../generator/surface/cover'
import { DEFAULT_ENGINE_PARAMS } from '../generator/surface/erosionEngine'
import { SURFACE_TUNING } from '../generator/surface/surfaceTuneParams'
import { TECTONICS_TUNING } from '../generator/tectonics/tectonicsTuneParams'

// THE TUNING A WORLD'S RUNS READ: every tuning object and default the
// history reads — the Archean, the plates, the crust, the mantle, the
// mesh, the erosion, the climate inside the epochs. Not the ecology's and
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
  const groups: Record<string, unknown> = {
    archean: DEFAULT_ARCHEAN_PARAMS,
    nucleation: DEFAULT_NUCLEATION_PARAMS,
    climate: CLIMATE_TUNING,
    crust: { MERGE_OVERLAP_FACTOR, RAFT_CONNECT_FACTOR },
    erodibility: DEFAULT_ERODIBILITY_FIELD_PARAMS,
    elevation: ELEVATION_TUNING,
    mantle: MANTLE_TUNING,
    column: COLUMN_TUNING,
    mesh: MESH_TUNING,
    history: HISTORY_DEFAULTS,
    cover: COVER_TUNING,
    engine: DEFAULT_ENGINE_PARAMS,
    surface: SURFACE_TUNING,
    tectonics: TECTONICS_TUNING,
  }
  for (const [name, group] of Object.entries(groups)) flatten(name, group, out)
  return out
}
