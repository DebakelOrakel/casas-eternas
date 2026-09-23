import { Biome } from '../climate/biomes'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../climate/climateField'

// THE COVER (ADAPTIVE_MESH_PLAN.md phase 5.5): how much of the ground the
// vegetation holds, in [0, 1] per climate cell from the epoch's coarse
// biome classification. ONE value with three readers, so the three cannot
// disagree about what a forest is: the fluvial erodibility falls with it
// (a rooted slope sheds less), the hillslope's critical slope rises with
// it (roots hold a steeper face), and the river course reads it as the
// bank strength it always had (phase 3: vegetation holds banks) — the
// table below IS that table, moved here. Kappa is untouched: the
// diffusivity is the soil's, not the plants'.
//
// Before the land-plants moment (planet/planetForcing.landPlantsFromMa,
// the Planet stage's schedule) everything is bare: cover 0 everywhere,
// which leaves the erosion exactly as it was — the coefficients multiply
// by one, and the raster drivers, which pass no cover, run bare too.
export const COVER_TUNING = {
  // K × (1 − erodibilityDrop × cover): a full cover cuts at this share
  // less than bare rock. Unmeasured; the calibration on 2048 owns it.
  erodibilityDrop: 0.6,
  // S_c × (1 + criticalSlopeRise × cover): the hillslope's critical slope
  // under a full cover, relative to bare. Unmeasured.
  criticalSlopeRise: 0.5,
} as const

// Per biome, the same value the river course's banks use (0.2 for water,
// ice, salt and desert; 0.9 for the rainforests).
export const COVER_BY_BIOME: Record<number, number> = {
  [Biome.Ocean]: 0.2, [Biome.Ice]: 0.2, [Biome.Tundra]: 0.35, [Biome.Boreal]: 0.7, [Biome.Grassland]: 0.5,
  [Biome.Woodland]: 0.7, [Biome.TemperateForest]: 0.85, [Biome.TemperateRainforest]: 0.9, [Biome.Desert]: 0.2,
  [Biome.Savanna]: 0.45, [Biome.TropicalRainforest]: 0.9, [Biome.Alpine]: 0.4, [Biome.SaltFlat]: 0.2, [Biome.Glacier]: 0.2,
}

// The cover per climate cell from the biomes; all zero before the plants.
export function coverField(biomes: Uint8Array, plantsPresent: boolean): Float32Array {
  const cover = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  if (!plantsPresent) return cover
  for (let i = 0; i < cover.length; i++) cover[i] = biomes[i] === Biome.Ocean ? 0 : (COVER_BY_BIOME[biomes[i]] ?? 0.5)
  return cover
}
