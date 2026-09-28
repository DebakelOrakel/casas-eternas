// WHAT A WORLD FIELD IS, separately from where it happens to be stored.
//
// `LayerSpec` used to carry both, and its own comment on `fullRes` admitted the
// problem: "a property of the source field, not of this format". A field's grid,
// its unit and whether it means anything over ocean are true of the field
// wherever it lives — in the worker's memory, in a save, in an artifact. Only
// `dtype`/`scale`/`offset` describe one particular storage form.
//
// Splitting them is what lets a consumer ask "what is `temperature`, and at what
// resolution" without first deciding which source it is going to read from —
// which is the whole point of the world-data facade (part C of
// docs/design/architecture-unification.md).

// The grids a queryable field can live on. There are two, and the difference is
// deliberate rather than incidental: climate and ecology are regional quantities
// and stay coarse (see docs/design/resolution-strategy.md), while anything a
// game asks about a PLACE — elevation, biome, lakes, rivers — has to be on the
// world raster or it cannot answer.
//
// `oceanAge` and the mantle field have grids of their own and are NOT here: they
// are restore rasters for the generator, not queryable layers. Whether oceanAge
// should become one is an open question in queryable-world-save.md, and this
// registry is where it would land if it does.
export type FieldGrid = 'world' | 'climate'

import { ECOLOGY_FIELD_IDS } from '../../generator/ecology/ecologyField'
import { REFINED_MONTHS } from '../../generator/climate/pressure'

export interface FieldSpec {
  name: string
  grid: FieldGrid
  // Physical unit, for a reader that has only the manifest. Empty for
  // dimensionless fields and enum ids.
  unit: string
  // Whether the field has meaning only on land. Ocean cells carry each
  // producer's own sentinel, so this is what tells a consumer to consult the
  // land mask rather than to trust the stored number.
  landOnly: boolean
}

const world = (name: string, unit: string, landOnly: boolean): FieldSpec => ({ name, grid: 'world', unit, landOnly })
const climate = (name: string, unit: string, landOnly: boolean): FieldSpec => ({ name, grid: 'climate', unit, landOnly })

// The ecology aggregate plus the 13 resources — all coarse, all land-only, all
// dimensionless suitability/abundance. Taken from the producer rather than
// relisted here: this order is the save's layer order, and the two lists had to
// agree with nothing making them.
export const ECOLOGY_FIELD_NAMES: readonly string[] = ECOLOGY_FIELD_IDS

// Every field a consumer can ask a world for. Order is the save's write order for
// the ones that are baked; the rest follow.
export const WORLD_FIELDS: readonly FieldSpec[] = [
  // Not a quantised layer — carried as raw f32 because it doubles as the
  // restore raster — but a queryable field like any other, and the manifest
  // lists it as one.
  world('elevation', 'relative', false),
  climate('landMask', '', false),
  climate('temperature', '°C', false),
  climate('precipitation', 'mm/yr', true),
  climate('precipitationEffective', 'mm/yr', true),
  world('biome', 'biomeId', false),
  climate('seasonalAmplitude', '°C', true),
  climate('monsoonIndex', '', true),
  // The Köppen–Geiger class id (generator/climate/koppen.ts KOPPEN_CODES),
  // 0 on the sea; the refinement's when the world has one.
  climate('koppen', 'koppenId', false),
  world('lakeDepth', 'depth', true),
  // The water table's depth below the surface, metres (phase 5a); 0 at a
  // channel or a seep, the depth of a well elsewhere.
  world('waterTable', 'm', true),
  ...ECOLOGY_FIELD_NAMES.map((name) => climate(name, '', true)),
  world('discharge', 'm3/s', false),
  // The erosion engine's coarse forcing (docs/design/erosion-v2.md): uplift
  // is the features' activity-weighted U (normalized to the world's peak,
  // negative in rifts), erodibility the crust-history hardness multiplier
  // BEFORE the seed-procedural lithology noise, which is applied at whatever
  // grid consumes it. Written so the amplification bake can erode with the
  // engine without carrying the simulation; meaningful over ocean too
  // (submarine features uplift, oceanic crust has a hardness).
  climate('uplift', 'relative', false),
  climate('erodibility', '', false),
]

// THE CLIMATE STEP'S REFINEMENT (docs/design/climate-refinement.md), one field
// per month rather than a stack, so every reader that samples a field can
// sample a month: `pressure.01` is January. Wind in m/s with v positive toward
// the map's bottom (south), as the climate grid's vectors are; the currents'
// two components normalised to the fastest (relative), 0 on land.
export const refinedMonthField = (base: 'temperature' | 'precipitation' | 'pressure' | 'windU' | 'windV', month: number): string => `${base}.${String(month).padStart(2, '0')}`
const MONTHS = Array.from({ length: REFINED_MONTHS }, (_, i) => i + 1)
export const REFINED_FIELDS: readonly FieldSpec[] = [
  ...MONTHS.map((m) => climate(refinedMonthField('temperature', m), '°C', false)),
  // At the month's rate, mm/yr; the year's total is the mean of the twelve.
  ...MONTHS.map((m) => climate(refinedMonthField('precipitation', m), 'mm/yr', true)),
  ...MONTHS.map((m) => climate(refinedMonthField('pressure', m), 'hPa', false)),
  ...MONTHS.map((m) => climate(refinedMonthField('windU', m), 'm/s', false)),
  ...MONTHS.map((m) => climate(refinedMonthField('windV', m), 'm/s', false)),
  climate('currentU', 'relative', false),
  climate('currentV', 'relative', false),
  // The sea-surface anomaly of the currents and the upwelling, °C, 0 on land.
  climate('currentAnomaly', '°C', false),
  // Ekman upwelling, positive where cold water comes up (relative), 0 on land.
  climate('upwelling', 'relative', false),
]

const BY_NAME = new Map([...WORLD_FIELDS, ...REFINED_FIELDS].map((f) => [f.name, f]))

// Throws rather than returning undefined: a name that is not a field is a typo
// or a field someone forgot to register, and both are better loud.
export function fieldSpec(name: string): FieldSpec {
  const spec = BY_NAME.get(name)
  if (!spec) throw new Error(`unknown world field: ${name}`)
  return spec
}
