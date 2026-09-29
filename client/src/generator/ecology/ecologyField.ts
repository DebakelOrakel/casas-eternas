// The Ecology layer: turns the finished climate/topography into named resource /
// suitability fields (see docs/decisions/ecology.md). Follows hydrology in the
// pipeline; a function, not a simulation. The carrying-capacity aggregate is the
// saturating combination of the subsistence fields, run through the two
// top-level knobs (carrying capacity = level, concentration = spatial structure).
//
// PHASE 2a: subsistence split (arable / game / pasture) + the aggregate. Fish
// (sea/coast/freshwater), material (timber/salt/tool-stone/metals) and
// prestige (gold/silver/gems) grow the field set in later sub-steps; the field
// registry + selector already carry them.

import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleElevationAtCell } from '../climate/climateField'
import { OCEAN_PRECIP } from '../climate/precipitation'
import { clamp01, smoothstep } from '../core/interpolation'
import { downsampleBox, downsampleMax, wrapValue } from '../core/field'
import { SEA_LEVEL, metersToElevation } from '../elevation/elevationScale'
import { ECOLOGY_TUNING, PASTURE_BY_BIOME, TIMBER_BY_BIOME } from './ecologyTuneParams'
import type { Volcano } from '../tectonics/volcanoes'
import type { LandBiomeId } from './ecologyTuneParams'

// Ocean sentinel for the output fields (matches the climate fields' convention):
// a cell the ecology layer doesn't score (open water) reads -1.
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

export interface EcologyFields {
  resX: number
  resY: number
  fields: Record<EcologyFieldId, Float32Array>
}

// Everything the ecology step reads. Climate fields are on the coarse grid;
// elevation/discharge/lakeDepth are full-res (worldWidth×worldHeight), sampled/
// downsampled here. Hydrology (discharge/lakeDepth) is optional — without it,
// fish gets its marine component only (freshwater needs rivers/lakes).
export interface EcologyInputs {
  temperature: Float32Array // climate grid, °C (SST-adjusted on ocean)
  precipitation: Float32Array // climate grid, mm/yr (OCEAN_PRECIP on water = land mask)
  biomes: Uint8Array // climate grid
  // The climate step's upwelling (refinement.ts, the cold-water part), climate
  // grid, 0 on land; null for a climate that was not refined (the
  // history's), where the fish lose that term.
  upwelling: Float32Array | null
  // The climate step's months (refinement.ts): temperature °C and rain at
  // the month's rate, mm/yr, month-major on the climate grid; and the rain's
  // year-to-year spread (reliability.ts, a coefficient of variation per land
  // cell). Both null for a climate that was not refined: arable then reads
  // the annual means and takes no risk.
  months: { temperature: Float32Array; precipitation: Float32Array; count: number } | null
  rainVariability: Float32Array | null
  elevation: Float32Array // full-res
  discharge: Float32Array | null // full-res river discharge, or null (no hydrology yet)
  maxDischarge: number // reference max discharge over land
  lakeDepth: Float32Array | null // full-res lake depth, or null
  volcanoes: Volcano[]
  // Collision-belt points — tin / lode-gold / gem provenance. Combines the
  // CURRENT fold-mountain features (on-crust, always where collision ranges are)
  // with the accumulated (advected) sutures for deep-time belts. Empty if the
  // world has had no continental collisions.
  orogenPoints: { x: number; y: number }[]
  // Coarse (resX×resY) continental-crust oldness 0..1 (1 = ancient craton core),
  // -1 over ocean — see rafts.computeCratonOldnessField. Feeds iron.
  cratonAge: Float32Array
  warpSeed: number
  worldWidth: number
  worldHeight: number
}

// --- shared helpers ---------------------------------------------------------

// Terrestrial net primary productivity, Miami-model style (0..1): limited by
// whichever of temperature and precipitation is scarcer (Liebig's law of the
// minimum). The ecological backbone of both arable land and wild game.
function productivity(tempC: number, precipMm: number): number {
  const nppTemp = 1 / (1 + Math.exp(1.315 - 0.119 * tempC))
  const nppPrecip = 1 - Math.exp(-0.000664 * Math.max(0, precipMm))
  return Math.min(nppTemp, nppPrecip)
}

// --- subsistence fields (climate grid) --------------------------------------

// Arable land: the growing year × terrain flatness (steep = poor; slope read
// from the full-res elevation across the cell's climate-grid neighbours) ×
// the harvest's reliability. The growing year is the mean of the months'
// productivity: a month below `arableFrostC` grows nothing, and a month
// takes its own rain, plus what a big river brings to its fields
// (irrigation, up to `arableIrrigationMm` at the rate of a year). So a
// monsoon or a Mediterranean year is read as it is, not as its mean, and
// the Nile's banks are farmland in a desert. A harvest is less worth where
// the rain fails often: × (1 − `arableRiskW` × the rain's variability), and
// a river takes that risk away as far as it waters the fields. Without
// months (a climate that was not refined) the annual means stand in.
function computeArable(temperature: Float32Array, precipitation: Float32Array, months: EcologyInputs['months'], rainVariability: Float32Array | null, river: Float32Array | null, elevation: Float32Array, land: Uint8Array, worldW: number, worldH: number): Float32Array {
  const T = ECOLOGY_TUNING
  const n = CLIMATE_RES_X * CLIMATE_RES_Y
  const out = new Float32Array(n)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      if (!land[i]) continue
      const water = river ? river[i] : 0
      let growing = 0
      if (months) {
        for (let m = 0; m < months.count; m++) {
          const t = months.temperature[m * n + i]
          if (t < T.arableFrostC) continue
          growing += productivity(t, months.precipitation[m * n + i] + T.arableIrrigationMm * water) / months.count
        }
      } else {
        growing = productivity(temperature[i], precipitation[i] + T.arableIrrigationMm * water)
      }
      const risk = rainVariability ? T.arableRiskW * rainVariability[i] * (1 - water) : 0
      const eC = sampleElevationAtCell(elevation, gx, gy, worldW, worldH)
      const eE = sampleElevationAtCell(elevation, (gx + 1) % CLIMATE_RES_X, gy, worldW, worldH)
      const eS = sampleElevationAtCell(elevation, gx, (gy + 1) % CLIMATE_RES_Y, worldW, worldH)
      const slope = Math.hypot(eE - eC, eS - eC)
      const flatness = 1 / (1 + T.slopeK * slope)
      out[i] = growing * flatness * Math.max(0, 1 - risk)
    }
  }
  return out
}

// How much water a big river brings to the cell's fields, 0..1: the
// fish's freshwater scale (√ of the discharge against the world's largest,
// doubled, capped).
function riverWater(coarseDischarge: Float32Array | null, maxDischarge: number): Float32Array | null {
  if (!coarseDischarge || maxDischarge <= 0) return null
  const out = new Float32Array(coarseDischarge.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.sqrt(Math.max(0, coarseDischarge[i]) / maxDischarge) * 2)
  return out
}

// Wild game / forage: ecosystem productivity plus an ecotone bonus at biome
// boundaries (forest↔grassland, land↔water edges are the richest hunting).
function computeGame(temperature: Float32Array, precipitation: Float32Array, biomes: Uint8Array, land: Uint8Array): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      if (!land[i]) continue
      const npp = productivity(temperature[i], precipitation[i])
      const here = biomes[i]
      // Ecotone: any 4-neighbour with a different biome (incl. ocean edge) marks
      // a boundary cell.
      const left = biomes[gy * CLIMATE_RES_X + ((gx - 1 + CLIMATE_RES_X) % CLIMATE_RES_X)]
      const right = biomes[gy * CLIMATE_RES_X + ((gx + 1) % CLIMATE_RES_X)]
      const up = biomes[((gy - 1 + CLIMATE_RES_Y) % CLIMATE_RES_Y) * CLIMATE_RES_X + gx]
      const down = biomes[((gy + 1) % CLIMATE_RES_Y) * CLIMATE_RES_X + gx]
      const ecotone = here !== left || here !== right || here !== up || here !== down
      out[i] = npp * (1 + (ecotone ? ECOLOGY_TUNING.ecotoneBonus : 0))
    }
  }
  return out
}

// Pasture: open grazing land by biome (see PASTURE_BY_BIOME).
function computePasture(biomes: Uint8Array, land: Uint8Array): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let i = 0; i < out.length; i++) {
    if (!land[i]) continue
    // The table is exhaustive over land biomes, so the `??` is not covering a
    // forgotten entry — it covers the two modules disagreeing about what land
    // IS. `land` here comes from `precipitation !== OCEAN_PRECIP`; the biome id
    // comes from `elevation <= SEA_LEVEL` in climate/biomes.ts. They normally
    // agree, nothing enforces it, and without the fallback a disagreement would
    // write `undefined` into a Float32Array — a NaN, not a wrong number.
    // Removable once part C1 leaves one land mask.
    out[i] = PASTURE_BY_BIOME[biomes[i] as LandBiomeId] ?? 0.1
  }
  return out
}

// Max of a full-res field over each coarse climate cell's footprint — rivers/
// lakes are thin, so a footprint max ("is there a big river/lake in this cell")
// beats a single centre sample.
// Bound to the climate grid, which is the only resolution this module reduces to.
const toClimateGrid = (fullRes: Float32Array, worldWidth: number, worldHeight: number): Float32Array =>
  downsampleMax(fullRes, worldWidth, worldHeight, CLIMATE_RES_X, CLIMATE_RES_Y)

// Fish: a subsistence source for coastal + riverine/lake land. Marine = how
// coastal the cell is × the richest sea next to it. A sea is rich where
// nutrients come up into the light: where cold water wells up along a coast
// (Peru, Namibia, California), where a cool sea mixes every winter (the
// North Sea, the Grand Banks), and on a shallow shelf. Warm seas stay
// layered and poor (the Caribbean, the Red Sea). Freshwater = big rivers +
// nearby lakes. Saturating combine of the two.
// `seaTemperature` is the climate's temperature, read on the sea cells;
// `shelf` the share of each cell that is shallow sea (shelfShare).
function computeFish(land: Uint8Array, seaTemperature: Float32Array, upwelling: Float32Array | null, shelf: Float32Array, coarseDischarge: Float32Array | null, maxDischarge: number, coarseLake: Float32Array | null): Float32Array {
  const T = ECOLOGY_TUNING
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      if (!land[i]) continue
      // Coastalness + the richest sea among the 8 neighbours' ocean cells.
      let oceanN = 0
      let richest = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const j = wrapValue(gy + dy, CLIMATE_RES_Y) * CLIMATE_RES_X + wrapValue(gx + dx, CLIMATE_RES_X)
          if (land[j]) continue
          oceanN++
          const rising = upwelling ? clamp01(upwelling[j] / T.fishUpwellingFull) : 0
          const cool = seaMixing(seaTemperature[j])
          const rich = T.fishSeaBase + T.fishShelfW * shelf[j] + T.fishUpwellingW * rising + T.fishMixingW * cool
          if (rich > richest) richest = rich
        }
      }
      // A straight coast (3 of the 8 neighbours sea) reaches the sea in
      // full: the share of sea around a cell said more about the grid's
      // coastline than about the fishing (an island of one cell got twice
      // a straight coast's fish).
      const coastalness = Math.min(1, oceanN / T.fishFullSeaNeighbours)
      const marine = coastalness * richest
      let freshwater = 0
      if (coarseDischarge && maxDischarge > 0) freshwater += T.fishRiverW * Math.min(1, Math.sqrt(coarseDischarge[i] / maxDischarge) * 2)
      if (coarseLake && coarseLake[i] > 0) freshwater += T.fishLakeW
      freshwater = Math.min(1, freshwater)
      out[i] = 1 - Math.exp(-(marine + freshwater))
    }
  }
  return out
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

// The share of each climate cell that is shelf sea, 0..1: sea no deeper
// than `fishShelfDepthM`.
function shelfShare(elevation: Float32Array, worldW: number, worldH: number): Float32Array {
  const floor = -metersToElevation(ECOLOGY_TUNING.fishShelfDepthM)
  const shallow = new Float32Array(elevation.length)
  for (let k = 0; k < elevation.length; k++) shallow[k] = elevation[k] <= SEA_LEVEL && elevation[k] > SEA_LEVEL + floor ? 1 : 0
  return downsampleBox(shallow, worldW, worldH, CLIMATE_RES_X, CLIMATE_RES_Y)
}

// --- material fields (separate channel; salt also lightly feeds carrying cap) --

// Fraction of a land cell's 8 neighbours that are ocean.
function coastalnessAt(land: Uint8Array, gx: number, gy: number): number {
  let ocean = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue
      const j = ((gy + dy + CLIMATE_RES_Y) % CLIMATE_RES_Y) * CLIMATE_RES_X + ((gx + dx + CLIMATE_RES_X) % CLIMATE_RES_X)
      if (!land[j]) ocean++
    }
  }
  return ocean / 8
}

// Terrain flatness 0..1 at a climate cell (from full-res elevation neighbours).
function flatnessAt(elevation: Float32Array, gx: number, gy: number, worldW: number, worldH: number): number {
  const eC = sampleElevationAtCell(elevation, gx, gy, worldW, worldH)
  const eE = sampleElevationAtCell(elevation, (gx + 1) % CLIMATE_RES_X, gy, worldW, worldH)
  const eS = sampleElevationAtCell(elevation, gx, (gy + 1) % CLIMATE_RES_Y, worldW, worldH)
  return 1 / (1 + ECOLOGY_TUNING.slopeK * Math.hypot(eE - eC, eS - eC))
}

function computeTimber(biomes: Uint8Array, land: Uint8Array): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let i = 0; i < out.length; i++) if (land[i]) out[i] = TIMBER_BY_BIOME[biomes[i] as LandBiomeId] ?? 0.05  // fallback: see computePasture
  return out
}

// Salt: arid evaporation, strongest on warm dry coasts (salt pans), weaker in
// arid interiors (rock-salt / playa proxy).
function computeSalt(temperature: Float32Array, precipitation: Float32Array, land: Uint8Array): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      if (!land[i]) continue
      const dryness = clamp01(1 - precipitation[i] / ECOLOGY_TUNING.saltAridPrecip)
      const warmth = clamp01(temperature[i] / 25)
      const arid = dryness * warmth
      const coast = coastalnessAt(land, gx, gy)
      out[i] = clamp01(arid * (ECOLOGY_TUNING.saltInteriorW + (ECOLOGY_TUNING.saltCoastW - ECOLOGY_TUNING.saltInteriorW) * coast))
    }
  }
  return out
}

// Wetland: flat, wet, water-fed lowland (bog-iron country). Internal — feeds iron.
function computeWetland(precipitation: Float32Array, coarseDischarge: Float32Array | null, maxDischarge: number, coarseLake: Float32Array | null, elevation: Float32Array, land: Uint8Array, worldW: number, worldH: number): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      if (!land[i]) continue
      const flat = flatnessAt(elevation, gx, gy, worldW, worldH)
      let water = 0
      if (coarseDischarge && maxDischarge > 0) water += Math.min(1, (coarseDischarge[i] / maxDischarge) * 4)
      if (coarseLake && coarseLake[i] > 0) water = 1
      const moisture = clamp01(precipitation[i] / 600)
      out[i] = flat * water * moisture
    }
  }
  return out
}

// Tool-stone: obsidian (volcanic point sources) with a low flint baseline on flat
// lowland (sedimentary proxy).
function computeToolStone(volcanoes: Volcano[], elevation: Float32Array, land: Uint8Array, worldW: number, worldH: number, warpSeed: number): Float32Array {
  const obsidian = rasterisePointField(thinPoints(volcanoes, ECOLOGY_TUNING.obsidianKeep, warpSeed ^ 0x0b51d1a2), ECOLOGY_TUNING.obsidianRadiusFrac, worldW, worldH)
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      if (!land[i]) continue
      out[i] = Math.max(obsidian[i], ECOLOGY_TUNING.flintBase * flatnessAt(elevation, gx, gy, worldW, worldH))
    }
  }
  return out
}

// Iron: broad old-craton signal (cratonAge oldness) broken into deposits by a
// seeded noise (so it fluctuates instead of reading as a flat 100%), plus bog
// iron in wetlands.
function computeIron(cratonAge: Float32Array, wetland: Float32Array, land: Uint8Array, warpSeed: number): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  const seed = (warpSeed ^ 0x51ed2701) | 0
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      if (!land[i]) continue
      const craton = Math.max(0, cratonAge[i])
      const noise01 = (provinceNoise((gx + 0.5) / CLIMATE_RES_X, (gy + 0.5) / CLIMATE_RES_Y, ECOLOGY_TUNING.ironDepositFreqX, ECOLOGY_TUNING.ironDepositFreqY, seed) + 1) / 2
      const deposit = ECOLOGY_TUNING.ironDepositFloor + (1 - ECOLOGY_TUNING.ironDepositFloor) * noise01
      out[i] = clamp01(Math.max(ECOLOGY_TUNING.ironCratonW * craton * deposit, ECOLOGY_TUNING.ironBogW * wetland[i]))
    }
  }
  return out
}

// Gold: placer (carried down rivers) + lode at orogenic belts.
function computeGold(coarseDischarge: Float32Array | null, maxDischarge: number, orogenLode: Float32Array, land: Uint8Array): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let i = 0; i < out.length; i++) {
    if (!land[i]) continue
    const placer = coarseDischarge && maxDischarge > 0 ? Math.min(1, Math.max(0, Math.sqrt(coarseDischarge[i] / maxDischarge) - ECOLOGY_TUNING.goldPlacerSqrtFloor) * ECOLOGY_TUNING.goldPlacerGain) : 0
    out[i] = clamp01(ECOLOGY_TUNING.goldPlacerW * placer + ECOLOGY_TUNING.goldLodeW * orogenLode[i])
  }
  return out
}

// Silver: hydrothermal, near volcanic arcs.
function computeSilver(arcField: Float32Array, land: Uint8Array): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let i = 0; i < out.length; i++) if (land[i]) out[i] = clamp01(ECOLOGY_TUNING.silverW * arcField[i])
  return out
}

// Gems: metamorphic/orogenic belts + arid weathering (turquoise near copper).
function computeGems(orogenField: Float32Array, copper: Float32Array, temperature: Float32Array, precipitation: Float32Array, land: Uint8Array): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let i = 0; i < out.length; i++) {
    if (!land[i]) continue
    const aridity = clamp01(1 - precipitation[i] / ECOLOGY_TUNING.saltAridPrecip) * clamp01(temperature[i] / 25)
    out[i] = clamp01(ECOLOGY_TUNING.gemOrogenW * orogenField[i] + ECOLOGY_TUNING.gemAridW * aridity * copper[i])
  }
  return out
}

// Deterministic mineralisation lottery (see the *_KEEP constants): hashes each
// point's integer position with the world seed + a per-resource salt and keeps
// the fraction that wins. Position-based (not index-based) so the surviving
// subset is stable as the feature list grows or reorders between epochs.
function thinPoints<T extends { x: number; y: number }>(points: T[], keepFraction: number, salt: number): T[] {
  if (keepFraction >= 1) return points
  const out: T[] = []
  for (const p of points) {
    let h = ((Math.floor(p.x) * 374761393 + Math.floor(p.y) * 668265263) ^ salt) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    h = (h ^ (h >>> 16)) >>> 0
    if (h / 4294967296 < keepFraction) out.push(p)
  }
  return out
}

// Mask a point-influence field (copper/tin) to land only.
function maskToLand(field: Float32Array, land: Uint8Array): Float32Array {
  for (let i = 0; i < field.length; i++) if (!land[i]) field[i] = 0
  return field
}

// --- concentration pipeline (verified in Phase 1) ---------------------------

function landMean(field: Float32Array, land: Uint8Array): number {
  let sum = 0
  let n = 0
  for (let i = 0; i < field.length; i++) if (land[i]) { sum += field[i]; n += 1 }
  return n > 0 ? sum / n : 0
}

// Province noise (see Phase 1): smooth seeded value noise in [-1,1], toroidal, at
// a coarse lattice frequency — broad "provinces", not fine texture.
function hashLattice(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695040) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  h = h ^ (h >>> 16)
  return (h >>> 0) / 4294967295
}
function provinceNoise(u: number, v: number, freqX: number, freqY: number, seed: number): number {
  const gx = u * freqX
  const gy = v * freqY
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const fx = smoothstep(gx - x0)
  const fy = smoothstep(gy - y0)
  const c00 = hashLattice(wrapValue(x0, freqX), wrapValue(y0, freqY), seed)
  const c10 = hashLattice(wrapValue(x0 + 1, freqX), wrapValue(y0, freqY), seed)
  const c01 = hashLattice(wrapValue(x0, freqX), wrapValue(y0 + 1, freqY), seed)
  const c11 = hashLattice(wrapValue(x0 + 1, freqX), wrapValue(y0 + 1, freqY), seed)
  const top = c00 + (c10 - c00) * fx
  const bottom = c01 + (c11 - c01) * fx
  return (top + (bottom - top) * fy) * 2 - 1
}

// Rasterises a soft Gaussian "influence" field (0..1, union-max) around a set of
// world-space points into the climate grid — reused for volcanic-soil provinces,
// copper (arc volcanoes), tin (sutures), obsidian, etc. Radius as a fraction of
// the smaller world dimension; stamps only near each point, so cost is O(points).
function rasterisePointField(points: { x: number; y: number }[], radiusFrac: number, worldWidth: number, worldHeight: number): Float32Array {
  const field = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  if (points.length === 0) return field
  const radiusWorld = Math.min(worldWidth, worldHeight) * radiusFrac
  const radiusCellsX = Math.ceil((radiusWorld / worldWidth) * CLIMATE_RES_X) * 3
  const radiusCellsY = Math.ceil((radiusWorld / worldHeight) * CLIMATE_RES_Y) * 3
  const cellW = worldWidth / CLIMATE_RES_X
  const cellH = worldHeight / CLIMATE_RES_Y
  const inv2r2 = 1 / (2 * radiusWorld * radiusWorld)
  for (const v of points) {
    const cx = Math.floor((v.x / worldWidth) * CLIMATE_RES_X)
    const cy = Math.floor((v.y / worldHeight) * CLIMATE_RES_Y)
    for (let dy = -radiusCellsY; dy <= radiusCellsY; dy++) {
      const gy = ((cy + dy) % CLIMATE_RES_Y + CLIMATE_RES_Y) % CLIMATE_RES_Y
      for (let dx = -radiusCellsX; dx <= radiusCellsX; dx++) {
        const gx = ((cx + dx) % CLIMATE_RES_X + CLIMATE_RES_X) % CLIMATE_RES_X
        const wdx = Math.min(Math.abs(dx * cellW), worldWidth - Math.abs(dx * cellW))
        const wdy = Math.min(Math.abs(dy * cellH), worldHeight - Math.abs(dy * cellH))
        const bump = Math.exp(-(wdx * wdx + wdy * wdy) * inv2r2)
        const i = gy * CLIMATE_RES_X + gx
        if (bump > field[i]) field[i] = bump
      }
    }
  }
  return field
}

// Runs the base subsistence aggregate through `normalise → L1 gamma
// (mean-preserving) → L2 province (mean-1) → gain`, so carrying capacity's gain
// changes only the level and concentration only the shape. Verified in Phase 1.
function concentrationPipeline(base: Float32Array, land: Uint8Array, volcanoes: Volcano[], warpSeed: number, worldWidth: number, worldHeight: number, params: EcologyParams): Float32Array {
  const n = base.length
  let maxBase = 0
  for (let i = 0; i < n; i++) if (land[i] && base[i] > maxBase) maxBase = base[i]
  const norm = new Float32Array(n)
  if (maxBase > 0) for (let i = 0; i < n; i++) if (land[i]) norm[i] = base[i] / maxBase
  const meanNorm = landMean(norm, land)

  const gamma = Math.pow(2, params.concentration / 100)
  const shaped = new Float32Array(n)
  for (let i = 0; i < n; i++) if (land[i]) shaped[i] = Math.pow(norm[i], gamma)
  const meanShaped = landMean(shaped, land)
  const l1Scale = meanShaped > 0 ? meanNorm / meanShaped : 1
  for (let i = 0; i < n; i++) if (land[i]) shaped[i] *= l1Scale

  const strength = params.provinceStrength
  const volcanic = rasterisePointField(volcanoes, ECOLOGY_TUNING.volcanicProvinceRadiusFrac, worldWidth, worldHeight)
  const dev = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    const gy = Math.floor(i / CLIMATE_RES_X)
    const gx = i - gy * CLIMATE_RES_X
    const noise = provinceNoise((gx + 0.5) / CLIMATE_RES_X, (gy + 0.5) / CLIMATE_RES_Y, ECOLOGY_TUNING.provinceNoiseFreqX, ECOLOGY_TUNING.provinceNoiseFreqY, warpSeed)
    dev[i] = ECOLOGY_TUNING.volcanicWeight * volcanic[i] + ECOLOGY_TUNING.noiseWeight * noise
  }
  const meanDev = landMean(dev, land)
  const provincal = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    provincal[i] = shaped[i] * Math.max(0.1, 1 + strength * (dev[i] - meanDev))
  }
  const meanProv = landMean(provincal, land)
  const l2Scale = meanProv > 0 ? meanNorm / meanProv : 1

  const gain = params.carryingCapacity / 100
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = land[i] ? provincal[i] * l2Scale * gain : ECOLOGY_OCEAN
  return out
}

// --- entry point ------------------------------------------------------------

export function computeEcology(inputs: EcologyInputs, params: EcologyParams): EcologyFields {
  const { temperature, precipitation, biomes, upwelling, months, rainVariability, elevation, discharge, maxDischarge, lakeDepth, volcanoes, orogenPoints, cratonAge, warpSeed, worldWidth, worldHeight } = inputs
  const n = CLIMATE_RES_X * CLIMATE_RES_Y
  const land = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (precipitation[i] !== OCEAN_PRECIP) land[i] = 1

  // Fold-out nudges: per-field abundance multipliers, applied in place so they
  // both scale the displayed field and (for subsistence + salt) flow into the
  // carrying-capacity combine below.
  const wmap = params.weights ?? {}
  const scaleField = (arr: Float32Array, id: EcologyFieldId): Float32Array => {
    const m = wmap[id] ?? 1
    if (m !== 1) for (let i = 0; i < arr.length; i++) if (land[i]) arr[i] *= m
    return arr
  }

  const coarseDischarge = discharge ? toClimateGrid(discharge, worldWidth, worldHeight) : null
  const coarseLake = lakeDepth ? toClimateGrid(lakeDepth, worldWidth, worldHeight) : null

  // Subsistence.
  const arable = scaleField(computeArable(temperature, precipitation, months, rainVariability, riverWater(coarseDischarge, maxDischarge), elevation, land, worldWidth, worldHeight), 'arable')
  const fish = scaleField(computeFish(land, temperature, upwelling, shelfShare(elevation, worldWidth, worldHeight), coarseDischarge, maxDischarge, coarseLake), 'fish')
  const game = scaleField(computeGame(temperature, precipitation, biomes, land), 'game')
  const pasture = scaleField(computePasture(biomes, land), 'pasture')
  const salt = scaleField(computeSalt(temperature, precipitation, land), 'salt')

  // Saturating carrying-capacity base: subsistence sources complement with
  // diminishing returns (1 - e^-Σ w·x); salt adds a small preservation bonus (the
  // one sanctioned material→subsistence bleed).
  const base = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    base[i] = 1 - Math.exp(-(ECOLOGY_TUNING.wArable * arable[i] + ECOLOGY_TUNING.wFish * fish[i] + ECOLOGY_TUNING.wGame * game[i] + ECOLOGY_TUNING.wPasture * pasture[i] + ECOLOGY_TUNING.wSaltCc * salt[i]))
  }
  const carryingCapacity = concentrationPipeline(base, land, volcanoes, warpSeed, worldWidth, worldHeight, params)

  // Material (separate channel). Copper = arc volcanoes; tin = orogen belts (rarer
  // with tinRarity → tighter radius); iron = old cratons + bog iron.
  const arcVolcanoes = volcanoes.filter((v) => v.kind === 'arc')
  const timber = scaleField(computeTimber(biomes, land), 'timber')
  const toolStone = scaleField(computeToolStone(volcanoes, elevation, land, worldWidth, worldHeight, warpSeed), 'toolStone')
  const copper = scaleField(maskToLand(rasterisePointField(thinPoints(arcVolcanoes, ECOLOGY_TUNING.copperKeep, warpSeed ^ 0xc0bbe401), ECOLOGY_TUNING.copperRadiusFrac, worldWidth, worldHeight), land), 'copper')
  const tinRadius = ECOLOGY_TUNING.tinRadiusFrac * (1 - 0.6 * Math.max(0, Math.min(1, params.tinRarity ?? 0)))
  const tin = scaleField(maskToLand(rasterisePointField(thinPoints(orogenPoints, ECOLOGY_TUNING.tinKeep, warpSeed ^ 0x71b2a903), tinRadius, worldWidth, worldHeight), land), 'tin')
  const wetland = computeWetland(precipitation, coarseDischarge, maxDischarge, coarseLake, elevation, land, worldWidth, worldHeight)
  const iron = scaleField(computeIron(cratonAge, wetland, land, warpSeed), 'iron')

  // Prestige (separate channel — no carrying-capacity contribution).
  const gold = scaleField(computeGold(coarseDischarge, maxDischarge, rasterisePointField(thinPoints(orogenPoints, ECOLOGY_TUNING.goldLodeKeep, warpSeed ^ 0x601dfeed), ECOLOGY_TUNING.goldLodeRadiusFrac, worldWidth, worldHeight), land), 'gold')
  const silver = scaleField(computeSilver(maskToLand(rasterisePointField(thinPoints(arcVolcanoes, ECOLOGY_TUNING.silverKeep, warpSeed ^ 0x5117e201), ECOLOGY_TUNING.silverRadiusFrac, worldWidth, worldHeight), land), land), 'silver')
  const gems = scaleField(computeGems(rasterisePointField(thinPoints(orogenPoints, ECOLOGY_TUNING.gemKeep, warpSeed ^ 0x9e35c0de), ECOLOGY_TUNING.gemRadiusFrac, worldWidth, worldHeight), copper, temperature, precipitation, land), 'gems')

  // Mask every per-resource field to the ocean sentinel so overlays skip water.
  const perResource = [arable, fish, game, pasture, timber, salt, toolStone, copper, tin, iron, gold, silver, gems]
  for (let i = 0; i < n; i++) if (!land[i]) for (const f of perResource) f[i] = ECOLOGY_OCEAN

  return { resX: CLIMATE_RES_X, resY: CLIMATE_RES_Y, fields: { carryingCapacity, arable, fish, game, pasture, timber, salt, toolStone, copper, tin, iron, gold, silver, gems } }
}
