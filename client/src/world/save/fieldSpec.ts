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
// dimensionless suitability/abundance.
export const ECOLOGY_FIELD_NAMES: readonly string[] = [
  'carryingCapacity', 'arable', 'fish', 'game', 'pasture',
  'timber', 'salt', 'toolStone', 'copper', 'tin', 'iron',
  'gold', 'silver', 'gems',
]

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
  world('lakeDepth', 'depth', true),
  ...ECOLOGY_FIELD_NAMES.map((name) => climate(name, '', true)),
  world('discharge', 'm3/s', false),
]

const BY_NAME = new Map(WORLD_FIELDS.map((f) => [f.name, f]))

// Throws rather than returning undefined: a name that is not a field is a typo
// or a field someone forgot to register, and both are better loud.
export function fieldSpec(name: string): FieldSpec {
  const spec = BY_NAME.get(name)
  if (!spec) throw new Error(`unknown world field: ${name}`)
  return spec
}
