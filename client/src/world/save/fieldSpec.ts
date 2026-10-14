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
// `oceanAge`, the mantle field and the climate step's refinement live on
// field meshes of their own (DEC-0036) and are NOT here: the save holds
// their mesh values (oceanAge.f64, mantle.f64, refined/ — see
// refinedFields.ts) for the generator's restore, not queryable layers.
// Every field here is a VIEW since DEC-0036's save step — the save holds no
// raster: the reader (world/query.ts) makes each from what the save does
// hold — the elevation and the lakes from the terrain mesh, the climate's
// on its chart (`climate`, 256 × 128) from its mesh values, the land's per
// node on the world raster, the forcing from the snapshot.
// Whether oceanAge should become one is an open question in
// queryable-world-save.md, and this registry is where it would land if it
// does.
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
  world('biome', 'biomeId', false),
  climate('seasonalAmplitude', '°C', true),
  climate('monsoonIndex', '', true),
  // The Köppen–Geiger class id (generator/climate/koppen.ts KOPPEN_CODES),
  // 0 on the sea; the refinement's when the world has one. Per node since
  // DEC-0036 phase 7, its own lapse at every node.
  world('koppen', 'koppenId', false),
  world('lakeDepth', 'depth', true),
  // The water table's depth below the surface, metres (phase 5a); 0 at a
  // channel or a seep, the depth of a well elsewhere.
  world('waterTable', 'm', true),
  // No ecology fields since 2026-09-29: the ecology is a rule evaluated
  // where one looks (docs/decisions/ecology-as-function.md), computed on
  // load, not stored.
  // The river discharge, m³/s, per node since DEC-0036 phase 7b (the save's
  // mesh/discharge.f32), each land pixel its nearest node's.
  world('discharge', 'm3/s', false),
  // The erosion engine's coarse forcing (docs/design/erosion-v2.md): uplift
  // is the features' rate of crustal thickening, mm/yr (DEC-0036 phase 8g;
  // until then normalized to the world's peak; negative in rifts and
  // trenches), erodibility the crust-history hardness multiplier
  // BEFORE the seed-procedural lithology noise, which is applied at whatever
  // grid consumes it. Not in the save since DEC-0036's save step: the
  // reader derives both from state.json (erosionForcing.coarseForcingFields),
  // as the generator does; meaningful over ocean too (submarine features
  // uplift, oceanic crust has a hardness).
  climate('uplift', 'mm/yr', false),
  climate('erodibility', '', false),
]

const BY_NAME = new Map(WORLD_FIELDS.map((f) => [f.name, f]))

// Throws rather than returning undefined: a name that is not a field is a typo
// or a field someone forgot to register, and both are better loud.
export function fieldSpec(name: string): FieldSpec {
  const spec = BY_NAME.get(name)
  if (!spec) throw new Error(`unknown world field: ${name}`)
  return spec
}
