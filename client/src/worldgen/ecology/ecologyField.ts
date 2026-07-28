// The Ecology layer: turns the finished climate/topography into named resource /
// suitability fields (see docs/decisions/ecology.md). Follows hydrology in the
// pipeline; a function, not a simulation. The carrying-capacity aggregate is the
// saturating combination of the subsistence fields, run through the two
// top-level knobs (carrying capacity = level, concentration = spatial structure).
//
// PHASE 2a: subsistence split (arable / game / pasture) + the aggregate. Fish
// (currents/coast/freshwater), material (timber/salt/tool-stone/metals) and
// prestige (gold/silver/gems) grow the field set in later sub-steps; the field
// registry + selector already carry them.

import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleElevationAtCell } from '../climate/climateField'
import { OCEAN_PRECIP } from '../climate/precipitation'
import { Biome } from '../climate/biomes'
import { clamp01, smoothstep } from '../core/interpolation'
import { downsampleMax, wrapValue } from '../core/field'
import { SLOPE_RECALIBRATION } from '../elevation/elevationScale'

// Ocean sentinel for the output fields (matches the climate fields' convention):
// a cell the ecology layer doesn't score (open water) reads -1.
export const ECOLOGY_OCEAN = -1

// The field ids the ecology step produces. Grows per sub-step; the worker sends
// every field, the screen's selector lists them (see ecologyColors' metadata).
export type EcologyFieldId =
  | 'carryingCapacity'
  | 'arable' | 'fish' | 'game' | 'pasture'
  | 'timber' | 'salt' | 'toolStone' | 'copper' | 'tin' | 'iron'
  | 'gold' | 'silver' | 'gems'

export interface EcologyParams {
  // Global carrying-capacity gain (%). 100 = neutral; scales the LEVEL only.
  carryingCapacity: number
  // Spatial structure, -100..100. 0 = physics as-is; +ve clumps, -ve evens.
  // Mean-preserving (shape only). See ecology.md Theme 1 (L1).
  concentration: number
  // L2 "province" strength (volcanic-soil fertility + light noise). Mean-1
  // multiplicative. Fold-out knob (0 = off).
  provinceStrength?: number
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

export interface Volcano {
  x: number
  y: number
  thickness: number
  kind: 'hotspot' | 'flood' | 'arc'
}

// Everything the ecology step reads. Climate fields are on the coarse grid;
// elevation/discharge/lakeDepth are full-res (worldWidth×worldHeight), sampled/
// downsampled here. Hydrology (discharge/lakeDepth) is optional — without it,
// fish gets its marine component only (freshwater needs rivers/lakes).
export interface EcologyInputs {
  temperature: Float32Array // climate grid, °C (SST-adjusted on ocean)
  precipitation: Float32Array // climate grid, mm/yr (OCEAN_PRECIP on water = land mask)
  biomes: Uint8Array // climate grid
  currents: Float32Array // climate grid, interleaved [u,v,…], 0 on land
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

// How suitable each biome is for grazing (pasture). Open grassland/savanna best;
// dense forest and ice worst; tundra/steppe support thin herding.
const PASTURE_BY_BIOME: Record<number, number> = {
  [Biome.Grassland]: 1.0,
  [Biome.Savanna]: 0.9,
  [Biome.Woodland]: 0.55,
  [Biome.Tundra]: 0.35,
  [Biome.TemperateForest]: 0.2,
  [Biome.TemperateRainforest]: 0.12,
  [Biome.Boreal]: 0.15,
  [Biome.Desert]: 0.12,
  [Biome.TropicalRainforest]: 0.06,
  [Biome.Ice]: 0.0,
}

// Weights of each subsistence source in the saturating carrying-capacity combine
// (arable dominant — farming supports the densest populations). Kept LOW enough
// that the combine (1 - e^-Σw·x) doesn't saturate near 1 for ordinary land — so
// carrying capacity spreads across the whole ramp (desert ~0.1 … rich coast
// ~0.8) instead of everything reading as lush green, which was hiding both the
// level knob and the province mottling. Recalibrated 2026-07-26.
const W_ARABLE = 1.1
const W_FISH = 0.6
const W_GAME = 0.45
const W_PASTURE = 0.35

// Fish tuning. Marine = coastal shelf base + upwelling (adjacent-ocean current
// strength); freshwater = big rivers + lake presence.
const FISH_SHELF_BASE = 0.35
const FISH_UPWELLING_W = 0.65
const FISH_RIVER_W = 0.6
const FISH_LAKE_W = 0.5

// Arable flatness sensitivity: steeper ground is progressively harder to farm.
// Scaled by SLOPE_RECALIBRATION (see elevationScale.ts): flatness reads raw
// elevation differences, which halved, so without this every slope on the map
// would suddenly count as farmable. Used here and in flatnessAt (wetland, tool
// stone).
const SLOPE_K = 8 * SLOPE_RECALIBRATION
// Ecotone (biome-boundary) game bonus and its cap.
const ECOTONE_BONUS = 0.18


// --- subsistence fields (climate grid) --------------------------------------

// Arable land: productivity modulated by terrain flatness (steep = poor). Slope
// is read from the full-res elevation across the cell's climate-grid neighbours.
function computeArable(temperature: Float32Array, precipitation: Float32Array, elevation: Float32Array, land: Uint8Array, worldW: number, worldH: number): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      if (!land[i]) continue
      const npp = productivity(temperature[i], precipitation[i])
      const eC = sampleElevationAtCell(elevation, gx, gy, worldW, worldH)
      const eE = sampleElevationAtCell(elevation, (gx + 1) % CLIMATE_RES_X, gy, worldW, worldH)
      const eS = sampleElevationAtCell(elevation, gx, (gy + 1) % CLIMATE_RES_Y, worldW, worldH)
      const slope = Math.hypot(eE - eC, eS - eC)
      const flatness = 1 / (1 + SLOPE_K * slope)
      out[i] = npp * flatness
    }
  }
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
      out[i] = npp * (1 + (ecotone ? ECOTONE_BONUS : 0))
    }
  }
  return out
}

// Pasture: open grazing land by biome (see PASTURE_BY_BIOME).
function computePasture(biomes: Uint8Array, land: Uint8Array): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let i = 0; i < out.length; i++) {
    if (!land[i]) continue
    out[i] = PASTURE_BY_BIOME[biomes[i]] ?? 0.1
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
// coastal the cell is × (a shelf base + upwelling read from adjacent-ocean
// current strength — boundary currents/gyre edges are the great fisheries).
// Freshwater = big rivers + nearby lakes. Saturating combine of the two.
function computeFish(land: Uint8Array, currents: Float32Array, coarseDischarge: Float32Array | null, maxDischarge: number, coarseLake: Float32Array | null): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      if (!land[i]) continue
      // Coastalness + upwelling from the 8 neighbours' ocean cells.
      let oceanN = 0
      let upwelling = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const j = wrapValue(gy + dy, CLIMATE_RES_Y) * CLIMATE_RES_X + wrapValue(gx + dx, CLIMATE_RES_X)
          if (land[j]) continue
          oceanN++
          const mag = Math.hypot(currents[j * 2], currents[j * 2 + 1])
          if (mag > upwelling) upwelling = mag
        }
      }
      const coastalness = oceanN / 8
      const marine = coastalness * (FISH_SHELF_BASE + FISH_UPWELLING_W * upwelling)
      let freshwater = 0
      if (coarseDischarge && maxDischarge > 0) freshwater += FISH_RIVER_W * Math.min(1, Math.sqrt(coarseDischarge[i] / maxDischarge) * 2)
      if (coarseLake && coarseLake[i] > 0) freshwater += FISH_LAKE_W
      freshwater = Math.min(1, freshwater)
      out[i] = 1 - Math.exp(-(marine + freshwater))
    }
  }
  return out
}

// --- material fields (separate channel; salt also lightly feeds carrying cap) --

// How much usable timber each biome yields (forests high, open/cold low).
const TIMBER_BY_BIOME: Record<number, number> = {
  [Biome.TropicalRainforest]: 1.0,
  [Biome.TemperateRainforest]: 0.9,
  [Biome.TemperateForest]: 0.85,
  [Biome.Boreal]: 0.8,
  [Biome.Woodland]: 0.5,
  [Biome.Savanna]: 0.2,
  [Biome.Grassland]: 0.1,
  [Biome.Tundra]: 0.05,
  [Biome.Desert]: 0.02,
  [Biome.Ice]: 0.0,
}

// Metal / stone influence radii (world fraction). Tin is tightest → the rare,
// clustered bottleneck; copper broader (arc belts); obsidian tight (point sources).
const COPPER_RADIUS_FRAC = 0.04
const TIN_RADIUS_FRAC = 0.038
const OBSIDIAN_RADIUS_FRAC = 0.03
const FLINT_BASE = 0.15
// Salt: below this precip a cell reads arid; coasts evaporate best.
const SALT_ARID_PRECIP = 500
const SALT_COAST_W = 1.0
const SALT_INTERIOR_W = 0.35
// Salt's small bonus to carrying capacity (preservation → denser settlement).
const W_SALT_CC = 0.15
// Iron: broad craton signal + bog-iron in wetlands. Deposit noise breaks the
// (nearly uniform) craton signal into banded-iron-style deposits, so iron stays
// common but fluctuates rather than reading as a flat 100%.
const IRON_CRATON_W = 0.9
const IRON_BOG_W = 0.7
const IRON_DEPOSIT_FREQ_X = 13
const IRON_DEPOSIT_FREQ_Y = 7
const IRON_DEPOSIT_FLOOR = 0.35

// Prestige (rare & clustered — the point). Gold = placer (rivers) + lode (orogens);
// silver = hydrothermal near volcanic arcs; gems = metamorphic (orogens) + arid
// weathering (turquoise near copper). None feed carrying capacity.
const GOLD_LODE_RADIUS_FRAC = 0.03
const SILVER_RADIUS_FRAC = 0.035
const GEM_RADIUS_FRAC = 0.028
const GOLD_PLACER_W = 0.7
const GOLD_LODE_W = 0.9
const SILVER_W = 0.9
const GEM_OROGEN_W = 0.85
const GEM_ARID_W = 0.6


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
  return 1 / (1 + SLOPE_K * Math.hypot(eE - eC, eS - eC))
}

function computeTimber(biomes: Uint8Array, land: Uint8Array): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let i = 0; i < out.length; i++) if (land[i]) out[i] = TIMBER_BY_BIOME[biomes[i]] ?? 0.05
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
      const dryness = clamp01(1 - precipitation[i] / SALT_ARID_PRECIP)
      const warmth = clamp01(temperature[i] / 25)
      const arid = dryness * warmth
      const coast = coastalnessAt(land, gx, gy)
      out[i] = clamp01(arid * (SALT_INTERIOR_W + (SALT_COAST_W - SALT_INTERIOR_W) * coast))
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
function computeToolStone(volcanoes: Volcano[], elevation: Float32Array, land: Uint8Array, worldW: number, worldH: number): Float32Array {
  const obsidian = rasterisePointField(volcanoes, OBSIDIAN_RADIUS_FRAC, worldW, worldH)
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      if (!land[i]) continue
      out[i] = Math.max(obsidian[i], FLINT_BASE * flatnessAt(elevation, gx, gy, worldW, worldH))
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
      const noise01 = (provinceNoise((gx + 0.5) / CLIMATE_RES_X, (gy + 0.5) / CLIMATE_RES_Y, IRON_DEPOSIT_FREQ_X, IRON_DEPOSIT_FREQ_Y, seed) + 1) / 2
      const deposit = IRON_DEPOSIT_FLOOR + (1 - IRON_DEPOSIT_FLOOR) * noise01
      out[i] = clamp01(Math.max(IRON_CRATON_W * craton * deposit, IRON_BOG_W * wetland[i]))
    }
  }
  return out
}

// Gold: placer (carried down rivers) + lode at orogenic belts.
function computeGold(coarseDischarge: Float32Array | null, maxDischarge: number, orogenLode: Float32Array, land: Uint8Array): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let i = 0; i < out.length; i++) {
    if (!land[i]) continue
    const placer = coarseDischarge && maxDischarge > 0 ? Math.min(1, Math.sqrt(coarseDischarge[i] / maxDischarge) * 2) : 0
    out[i] = clamp01(GOLD_PLACER_W * placer + GOLD_LODE_W * orogenLode[i])
  }
  return out
}

// Silver: hydrothermal, near volcanic arcs.
function computeSilver(arcField: Float32Array, land: Uint8Array): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let i = 0; i < out.length; i++) if (land[i]) out[i] = clamp01(SILVER_W * arcField[i])
  return out
}

// Gems: metamorphic/orogenic belts + arid weathering (turquoise near copper).
function computeGems(orogenField: Float32Array, copper: Float32Array, temperature: Float32Array, precipitation: Float32Array, land: Uint8Array): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let i = 0; i < out.length; i++) {
    if (!land[i]) continue
    const aridity = clamp01(1 - precipitation[i] / SALT_ARID_PRECIP) * clamp01(temperature[i] / 25)
    out[i] = clamp01(GEM_OROGEN_W * orogenField[i] + GEM_ARID_W * aridity * copper[i])
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

const VOLCANIC_PROVINCE_RADIUS_FRAC = 0.05
const DEFAULT_PROVINCE_STRENGTH = 0.45
// Higher frequency → more mottling (broad smooth gradients read as "no variation").
// Weights are large because smooth value-noise has LOW variance (interpolation
// pulls values toward the mean), so it needs a big multiplier to produce visible
// deviation; the strength knob (0..1) then scales this. Volcanic provinces punch
// harder than the organic noise.
const PROVINCE_NOISE_FREQ_X = 11
const PROVINCE_NOISE_FREQ_Y = 6
const VOLCANIC_WEIGHT = 1.6
const NOISE_WEIGHT = 1.5

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

  const strength = params.provinceStrength ?? DEFAULT_PROVINCE_STRENGTH
  const volcanic = rasterisePointField(volcanoes, VOLCANIC_PROVINCE_RADIUS_FRAC, worldWidth, worldHeight)
  const dev = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    const gy = Math.floor(i / CLIMATE_RES_X)
    const gx = i - gy * CLIMATE_RES_X
    const noise = provinceNoise((gx + 0.5) / CLIMATE_RES_X, (gy + 0.5) / CLIMATE_RES_Y, PROVINCE_NOISE_FREQ_X, PROVINCE_NOISE_FREQ_Y, warpSeed)
    dev[i] = VOLCANIC_WEIGHT * volcanic[i] + NOISE_WEIGHT * noise
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
  const { temperature, precipitation, biomes, currents, elevation, discharge, maxDischarge, lakeDepth, volcanoes, orogenPoints, cratonAge, warpSeed, worldWidth, worldHeight } = inputs
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
  const arable = scaleField(computeArable(temperature, precipitation, elevation, land, worldWidth, worldHeight), 'arable')
  const fish = scaleField(computeFish(land, currents, coarseDischarge, maxDischarge, coarseLake), 'fish')
  const game = scaleField(computeGame(temperature, precipitation, biomes, land), 'game')
  const pasture = scaleField(computePasture(biomes, land), 'pasture')
  const salt = scaleField(computeSalt(temperature, precipitation, land), 'salt')

  // Saturating carrying-capacity base: subsistence sources complement with
  // diminishing returns (1 - e^-Σ w·x); salt adds a small preservation bonus (the
  // one sanctioned material→subsistence bleed).
  const base = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    base[i] = 1 - Math.exp(-(W_ARABLE * arable[i] + W_FISH * fish[i] + W_GAME * game[i] + W_PASTURE * pasture[i] + W_SALT_CC * salt[i]))
  }
  const carryingCapacity = concentrationPipeline(base, land, volcanoes, warpSeed, worldWidth, worldHeight, params)

  // Material (separate channel). Copper = arc volcanoes; tin = orogen belts (rarer
  // with tinRarity → tighter radius); iron = old cratons + bog iron.
  const arcVolcanoes = volcanoes.filter((v) => v.kind === 'arc')
  const timber = scaleField(computeTimber(biomes, land), 'timber')
  const toolStone = scaleField(computeToolStone(volcanoes, elevation, land, worldWidth, worldHeight), 'toolStone')
  const copper = scaleField(maskToLand(rasterisePointField(arcVolcanoes, COPPER_RADIUS_FRAC, worldWidth, worldHeight), land), 'copper')
  const tinRadius = TIN_RADIUS_FRAC * (1 - 0.6 * Math.max(0, Math.min(1, params.tinRarity ?? 0)))
  const tin = scaleField(maskToLand(rasterisePointField(orogenPoints, tinRadius, worldWidth, worldHeight), land), 'tin')
  const wetland = computeWetland(precipitation, coarseDischarge, maxDischarge, coarseLake, elevation, land, worldWidth, worldHeight)
  const iron = scaleField(computeIron(cratonAge, wetland, land, warpSeed), 'iron')

  // Prestige (separate channel — no carrying-capacity contribution).
  const gold = scaleField(computeGold(coarseDischarge, maxDischarge, rasterisePointField(orogenPoints, GOLD_LODE_RADIUS_FRAC, worldWidth, worldHeight), land), 'gold')
  const silver = scaleField(computeSilver(maskToLand(rasterisePointField(arcVolcanoes, SILVER_RADIUS_FRAC, worldWidth, worldHeight), land), land), 'silver')
  const gems = scaleField(computeGems(rasterisePointField(orogenPoints, GEM_RADIUS_FRAC, worldWidth, worldHeight), copper, temperature, precipitation, land), 'gems')

  // Mask every per-resource field to the ocean sentinel so overlays skip water.
  const perResource = [arable, fish, game, pasture, timber, salt, toolStone, copper, tin, iron, gold, silver, gems]
  for (let i = 0; i < n; i++) if (!land[i]) for (const f of perResource) f[i] = ECOLOGY_OCEAN

  return { resX: CLIMATE_RES_X, resY: CLIMATE_RES_Y, fields: { carryingCapacity, arable, fish, game, pasture, timber, salt, toolStone, copper, tin, iron, gold, silver, gems } }
}
