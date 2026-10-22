import type { PointClimate } from '../climate/climatePoints'
import { clamp01 } from '../core/interpolation'
import { type Domain } from '../core/domain'
import { ECOLOGY_TUNING } from './ecologyTuneParams'
import { detExp } from '../core/detMath'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'
import { maxWithin, type MeshGeometry, type Neighbourhoods } from '../mesh/meshNeighbourhood'
import { type TriangleRaster } from '../mesh/meshRaster'

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

// --- shared helpers ---------------------------------------------------------

// Terrestrial net primary productivity, Miami-model style (0..1): limited by
// whichever of temperature and precipitation is scarcer (Liebig's law of the
// minimum). The ecological backbone of both arable land and wild game.
function productivity(tempC: number, precipMm: number): number {
  const nppTemp = 1 / (1 + detExp(1.315 - 0.119 * tempC))
  const nppPrecip = 1 - detExp(-0.000664 * Math.max(0, precipMm))
  return Math.min(nppTemp, nppPrecip)
}

// How well a sea at this temperature (°C) mixes its nutrients up, 0..1: in
// full from `fishMixFullC` down to `fishMixIceC` (cool seas turn over in
// winter), gone at `fishMixWarmC` (a warm sea stays layered) and below the
// sea ice.
function seaMixing(tempC: number): number {
  const T = ECOLOGY_TUNING
  if (tempC < T.fishMixIceC) return clamp01(1 - (T.fishMixIceC - tempC) / T.fishMixIceSpanC)
  return clamp01((T.fishMixWarmC - tempC) / (T.fishMixWarmC - T.fishMixFullC))
}

const aridWarm = (tempC: number, precipMm: number): number => clamp01(1 - precipMm / ECOLOGY_TUNING.saltAridPrecip) * clamp01(tempC / 25)

// --- the fields ---------------------------------------------------------------

// The physics of the ecology, every field before the step's sliders: the
// expensive part, which depends on the world alone. The worker keeps it
// while only the sliders move (the engine's apply_ecology).
export interface EcologyBase {
  mesh: PeriodicTriangulation
  geo: MeshGeometry
  domain: Domain
  slots: number
  land: Uint8Array
  // 1 on the alive nodes that are not land: the fish's sea.
  sea: Uint8Array
  raw: Record<Exclude<EcologyFieldId, 'carryingCapacity' | 'tin' | 'gems'>, Float32Array>
  // Gems' two parts (the copper they weather from is scaled by the slider).
  gemBelt: Float32Array
  aridity: Float32Array
  // Tin's belt points, thinned (its radius is a slider: tinRarity).
  tinPoints: { x: number; y: number }[]
  // The province layer's deviation per land node (volcanic soil + noise),
  // before its mean is taken off.
  provinceDeviation: Float32Array
  // What a month's fields need (ecologyMonth); null for a climate without
  // months (not refined).
  seasonal: EcologySeasons | null
  // The pixels' triangles for the fields' rasters, made on the first
  // (the engine's ecology_fine).
  raster: TriangleRaster | null
}

// The fields that change over the year, and what their months are made of:
// per node the parts that do not change with the month, and the climate's
// months to read the rest from.
export const SEASONAL_ECOLOGY_FIELDS = ['arable', 'fish', 'game', 'pasture', 'salt'] as const satisfies readonly EcologyFieldId[]
export type SeasonalEcologyFieldId = (typeof SEASONAL_ECOLOGY_FIELDS)[number]
export const isSeasonalEcologyField = (id: EcologyFieldId): id is SeasonalEcologyFieldId => (SEASONAL_ECOLOGY_FIELDS as readonly string[]).includes(id)

interface EcologySeasons {
  months: NonNullable<PointClimate['months']>
  // Arable: flatness × the harvest's reliability, and the water on the fields.
  arableFactor: Float32Array
  fieldWater: Float32Array
  // Game: the edge bonus; pasture: the year's grazing and the year's mean
  // productivity it is set against.
  edgeFactor: Float32Array
  pastureYear: Float32Array
  nppYear: Float32Array
  // Salt: the coast's weight and the salt flats.
  saltCoast: Float32Array
  saltFlat: Uint8Array | null
  // Fish: a sea node's richness without its winter mixing, the land's
  // reach to the sea and its fresh water, the coast's neighbourhoods.
  seaRichStatic: Float32Array
  access: Float32Array
  freshwater: Float32Array
  coast: Neighbourhoods
}

// One month of a field that changes over the year (SEASONAL_ECOLOGY_FIELDS),
// per node, `month` 1..12, with the field's abundance slider; null when the
// climate has no months. Each is what the land gives in that month on the
// field's own scale, so the twelve months average to its year:
// - arable: the month's growth (none below the frost) × flatness × reliability;
// - game: the month's productivity × the edge bonus;
// - pasture: the year's grazing × the month's productivity against the year's;
// - salt: a salt flat in full, else the month's warm dryness × the coast;
// - fish: the sea's richness with the month's mixing (on the sea and within
//   the land's reach), plus the fresh water.
export function ecologyMonth(eco: EcologyBase, field: SeasonalEcologyFieldId, month: number, weight = 1): Float32Array | null {
  const S = eco.seasonal
  if (!S) return null
  const T = ECOLOGY_TUNING
  const { slots: n, land, sea } = eco
  const m = Math.max(0, Math.min(S.months.count - 1, month - 1)) * n
  const out = new Float32Array(n).fill(ECOLOGY_OCEAN)
  if (field === 'fish') {
    const rich = new Float32Array(n)
    for (let v = 0; v < n; v++) {
      if (!sea[v]) continue
      rich[v] = S.seaRichStatic[v] + T.fishMixingW * seaMixing(S.months.temperature[m + v])
      out[v] = weight * (1 - detExp(-rich[v]))
    }
    const near = maxWithin(S.coast, rich)
    for (let v = 0; v < n; v++) if (land[v]) out[v] = weight * (1 - detExp(-(S.access[v] * near[v] + S.freshwater[v])))
    return out
  }
  for (let v = 0; v < n; v++) {
    if (!land[v]) continue
    if (field === 'salt' && S.saltFlat && S.saltFlat[v]) { out[v] = weight * clamp01(T.saltFlatW); continue }
    const t = S.months.temperature[m + v]
    const p = Math.max(0, S.months.precipitation[m + v])
    let value: number
    if (field === 'arable') value = (t >= T.arableFrostC ? productivity(t, p + T.arableIrrigationMm * S.fieldWater[v]) : 0) * S.arableFactor[v]
    else if (field === 'game') value = productivity(t, p) * S.edgeFactor[v]
    else if (field === 'pasture') value = S.nppYear[v] > 0 ? S.pastureYear[v] * productivity(t, p) / S.nppYear[v] : 0
    else value = clamp01(aridWarm(t, p) * S.saltCoast[v])
    out[v] = weight * value
  }
  return out
}
