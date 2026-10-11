// The climate step's refinement in the save (DEC-0036 phase 5, fork 5 as
// revised): its values per cell of the climate's field mesh, one Float32
// file per field under `refined/` (a month-stacked field holds months ×
// cells, month-major), described by `refined.json` — the mesh's cell count
// and spacing in metres, which a load checks (the mesh is rebuilt from the
// world's shape and size, not saved), the months, each field's file and
// unit, and the ENSO see-saw's period and strength.
//
// Float32, the values the session holds (climate/refinement.RefinedClimate):
// written and read back unchanged, so a loaded refinement is the session's
// to the bit and the generator adopts it without computing it again. The
// raster layers this replaces (formatVersion 6: one quantised layer per
// month and field, u8/u16) were coarser, clipped at their ranges and lost
// the sea's mark of the rain on the way.

import type { RefinedClimate } from '../../generator/climate/refinement'
import { REFINED_STORMS } from '../../generator/climate/refinement'

interface RefinedFieldSpec {
  name: string
  unit: string
  // A stack of the months, or one value per cell.
  months: boolean
  get(r: RefinedClimate): Float32Array
}

const cellField = (name: string, unit: string, get: (r: RefinedClimate) => Float32Array): RefinedFieldSpec => ({ name, unit, months: false, get })
const monthField = (name: string, unit: string, get: (r: RefinedClimate) => Float32Array): RefinedFieldSpec => ({ name, unit, months: true, get })

// Every field, in the order the save writes them. Vectors are east and
// south in each cell's own frame (the generator's Domain: +y south), the
// wind in its model unit (refined.json's `windUnitMs`: m/s per unit), the
// currents normalised to the fastest.
export const REFINED_SAVE_FIELDS: readonly RefinedFieldSpec[] = [
  monthField('temperature', '°C', (r) => r.temperature),
  // At the month's rate; OCEAN_PRECIP (−1) on the sea.
  monthField('precipitation', 'mm/yr', (r) => r.precipitation),
  monthField('pressure', 'hPa', (r) => r.pressure),
  monthField('windE', 'wind unit', (r) => r.windE),
  monthField('windS', 'wind unit', (r) => r.windS),
  cellField('currentE', 'relative', (r) => r.currentE),
  cellField('currentS', 'relative', (r) => r.currentS),
  cellField('currentAnomaly', '°C', (r) => r.currentAnomaly),
  cellField('upwelling', 'relative', (r) => r.upwelling),
  cellField('salinity', 'psu', (r) => r.salinity),
  cellField('deepWater', 'share', (r) => r.deepWater),
  cellField('fog', 'share', (r) => r.fog),
  cellField('foehn', 'share', (r) => r.foehn),
  cellField('rainVariability', 'share', (r) => r.reliability.rainVariability),
  cellField('ensoPattern', '', (r) => r.reliability.ensoPattern),
  ...REFINED_STORMS.map((name) => cellField(name, name === 'blizzard' ? 'share' : 'relative', (r) => r.storms[name])),
]

export interface RefinedMeta {
  cells: number
  spacingM: number
  months: number
  windUnitMs: number
  enso: { periodYears: number; strength: number }
  fields: { name: string; file: string; unit: string; months: boolean }[]
}

const fileOf = (name: string): string => `refined/${name}.f32`

// The refinement as the save's entries: refined.json's text and each
// field's file.
export function refinedEntries(r: RefinedClimate, windUnitMs: number): { meta: string; files: [string, ArrayBuffer][] } {
  const meta: RefinedMeta = {
    cells: r.cells,
    spacingM: r.spacingM,
    months: r.months,
    windUnitMs,
    enso: { periodYears: r.reliability.ensoPeriodYears, strength: r.reliability.ensoStrength },
    fields: REFINED_SAVE_FIELDS.map((f) => ({ name: f.name, file: fileOf(f.name), unit: f.unit, months: f.months })),
  }
  const files = REFINED_SAVE_FIELDS.map((f): [string, ArrayBuffer] => [fileOf(f.name), f.get(r).slice().buffer as ArrayBuffer])
  return { meta: JSON.stringify(meta), files }
}

// The refinement from refined.json and its files (`read` answers a file's
// bytes, null when it is missing). Throws on any field missing or of the
// wrong length: a partial set is not a refinement.
export async function refinedFromEntries(metaText: string, read: (file: string) => Promise<ArrayBuffer | null>): Promise<RefinedClimate> {
  const meta = JSON.parse(metaText) as Partial<RefinedMeta>
  const { cells, spacingM, months, enso } = meta
  if (typeof cells !== 'number' || typeof spacingM !== 'number' || typeof months !== 'number' || !enso) throw new Error('refined.json: no mesh or months')
  const values = new Map<string, Float32Array>()
  for (const f of REFINED_SAVE_FIELDS) {
    const bytes = await read(fileOf(f.name))
    const length = (f.months ? months : 1) * cells
    if (!bytes || bytes.byteLength !== length * 4) throw new Error(`refined: ${f.name} missing or not ${length} values`)
    values.set(f.name, new Float32Array(bytes))
  }
  const v = (name: string): Float32Array => values.get(name)!
  return {
    months,
    cells,
    spacingM,
    temperature: v('temperature'),
    precipitation: v('precipitation'),
    pressure: v('pressure'),
    windE: v('windE'),
    windS: v('windS'),
    currentE: v('currentE'),
    currentS: v('currentS'),
    currentAnomaly: v('currentAnomaly'),
    upwelling: v('upwelling'),
    salinity: v('salinity'),
    deepWater: v('deepWater'),
    fog: v('fog'),
    foehn: v('foehn'),
    reliability: { rainVariability: v('rainVariability'), ensoPattern: v('ensoPattern'), ensoPeriodYears: enso.periodYears, ensoStrength: enso.strength },
    storms: { cyclone: v('cyclone'), tornado: v('tornado'), blizzard: v('blizzard'), dust: v('dust'), thunder: v('thunder') },
  }
}
