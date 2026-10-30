// The ecology's vocabulary on the client: the field ids, the fine fields'
// codec and the step's knobs. The rules and their tuning run in the engine
// (engine/crates/casas-generator/src/ecology/); their TypeScript copy, which
// nothing ran, was removed 2026-10-29.

// Ocean sentinel for the output fields (matches the climate fields' convention):
// a node the ecology layer doesn't score (open water) reads -1.
export const ECOLOGY_OCEAN = -1

// The field ids the ecology step produces. Grows per sub-step; the worker sends
// every field, the screen's selector lists them (see ecologyColors' metadata).
//
// An array with the type derived from it, rather than a union with the names
// retyped wherever a list is needed. The save's field registry had the second
// copy, in the same order — and the order is the save's layer order, so the two
// had to agree without anything making them. Adding a field is one edit now.
export const ECOLOGY_FIELD_IDS = [
  'carryingCapacity',
  'arable', 'fish', 'game', 'pasture',
  'timber', 'salt', 'toolStone', 'copper', 'tin', 'iron',
  'gold', 'silver', 'gems',
] as const

export type EcologyFieldId = (typeof ECOLOGY_FIELD_IDS)[number]

// The fine fields travel to the screen as one byte per pixel: a value v
// (0..3, the save's range) as round(v / ECOLOGY_FINE_STEP), the sea as
// ECOLOGY_FINE_OCEAN. Fourteen fields at 2048×1024 are 29 MB so, 117 MB as
// floats.
export const ECOLOGY_FINE_OCEAN = 255
export const ECOLOGY_FINE_STEP = 3 / 254
export const decodeFineValue = (code: number): number => (code === ECOLOGY_FINE_OCEAN ? ECOLOGY_OCEAN : code * ECOLOGY_FINE_STEP)

export interface EcologyParams {
  // Global carrying-capacity gain (%). 100 = neutral; scales the LEVEL only.
  carryingCapacity: number
  // Spatial structure, -100..100. 0 = physics as-is; +ve clumps, -ve evens.
  // Mean-preserving (shape only). See ecology.md Theme 1 (L1).
  concentration: number
  // L2 "province" strength (volcanic-soil fertility + light noise), 0..1. Mean-1
  // multiplicative. Fold-out knob (0 = off). Required: its default is the
  // input declaration's (ecologyInputParams.provinceStrength), which this
  // module does not read — a default here would be a second copy of it.
  provinceStrength: number
  // Per-field abundance multipliers (fold-out nudges), default 1. Applied to the
  // field itself; for subsistence + salt it also scales their carrying-capacity
  // contribution. Metals share one "ore richness" knob (set on copper/tin/iron).
  weights?: Partial<Record<EcologyFieldId, number>>
  // Tin rarity 0..1 (higher = rarer / more clustered) — shrinks the tin radius.
  tinRarity?: number
}

// The fields that change over the year: the engine answers their months
// (world.ecologyMonth; the rule is ecology_month in the engine's
// ecology/ecology_field.rs).
export const SEASONAL_ECOLOGY_FIELDS = ['arable', 'fish', 'game', 'pasture', 'salt'] as const satisfies readonly EcologyFieldId[]
export type SeasonalEcologyFieldId = (typeof SEASONAL_ECOLOGY_FIELDS)[number]
export const isSeasonalEcologyField = (id: EcologyFieldId): id is SeasonalEcologyFieldId => (SEASONAL_ECOLOGY_FIELDS as readonly string[]).includes(id)
