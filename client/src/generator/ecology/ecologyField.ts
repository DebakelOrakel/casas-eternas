// The Ecology layer: turns the finished climate/topography into named resource /
// suitability fields (see docs/decisions/ecology.md). Follows hydrology in the
// pipeline; a function, not a simulation. The carrying-capacity aggregate is the
// saturating combination of the subsistence fields, run through the two
// top-level knobs (carrying capacity = level, concentration = spatial structure).
//
// A LOCAL RULE, evaluated per NODE of the adaptive terrain mesh (DEC-0036
// phase 7, docs/decisions/fields-on-meshes.md fork 2; per pixel of the 2048
// raster before, docs/decisions/ecology-as-function.md): the climate sampled
// at the node (climate/climatePoints.ts — its temperature with the node's
// own lapse, the land fields over the land corners), the node's terrain and
// its slope, the water and the sea within a reach in metres (mesh/
// meshNeighbourhood.ts: the cells the reach touches, a mean by the area of
// each inside it), the tectonic features near it as halos in metres. Both
// shapes, one path: the distances are the globe's arcs on the sphere, the
// noise the globe's (Domain.noise); no pole row exists to average.
//
// The screen's maps and the migration read the fields' rasters
// (ecologyRasters: the chart, per pixel of the world raster from the nodes
// of the triangle under it, and per climate cell the mean of its land
// pixels) — no stage computes on them.

import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../climate/climateField'
import type { PointClimate } from '../climate/climatePoints'
import { Biome } from '../climate/biomes'
import { clamp01, smoothstep } from '../core/interpolation'
import { globeFrame, type Domain, type DomainGrid } from '../core/domain'
import { SEA_LEVEL, metersToElevation } from '../elevation/elevationScale'
import { ECOLOGY_TUNING, PASTURE_BY_BIOME, TIMBER_BY_BIOME } from './ecologyTuneParams'
import type { Volcano } from '../tectonics/volcanoes'
import type { LandBiomeId } from './ecologyTuneParams'
import { detExp, detPow } from '../core/detMath'
import { globeOctaveOn } from '../elevation/globeNoise'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'
import { boundaryDensity, discsAround, gaussianHalos, maxWithin, meanWithin, meshGeometry, neighbourhoods, slopeOf, type MeshGeometry, type Neighbourhoods } from '../mesh/meshNeighbourhood'
import { rasteriseNodePart, triangleRaster, type TriangleRaster } from '../mesh/meshRaster'

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
export function encodeFineField(field: Float32Array): Uint8Array {
  const out = new Uint8Array(field.length)
  for (let i = 0; i < field.length; i++) out[i] = field[i] === ECOLOGY_OCEAN ? ECOLOGY_FINE_OCEAN : Math.min(254, Math.max(0, Math.round(field[i] / ECOLOGY_FINE_STEP)))
  return out
}
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

// The fields per vertex slot of the terrain mesh (ECOLOGY_OCEAN on the sea,
// the fish's fishing grounds excepted).
export interface EcologyFields {
  fields: Record<EcologyFieldId, Float32Array>
}

// Everything the ecology step reads, per vertex slot of the terrain mesh.
// The hydrology (discharge, lakes, water table) is optional — without it,
// fish gets its marine component only (freshwater needs rivers/lakes).
export interface EcologyInputs {
  mesh: PeriodicTriangulation
  z: Float32Array
  // 1 on land (above the sea, or a terminal basin's dry floor — land
  // though at or below sea level), the points the climate was sampled at.
  land: Uint8Array
  // The climate at the nodes (climatePoints.climateAtPoints): the year's
  // and, for a refined climate, the months (arable's growing year), the
  // upwelling (the fish's cold water) and the rain's reliability (arable's
  // risk) — null where the climate was not refined.
  climate: PointClimate
  // The biome per node: the map's (the hydrology's riparian ones), or the
  // climate's own before the hydrology ran.
  biomes: Uint8Array
  discharge: Float32Array | null
  maxDischarge: number
  // Liquid water per node (a frozen basin feeds no fishery), elevation units.
  lakeDepth: Float32Array | null
  // 1 on a terminal basin's salt flat, or null (no hydrology yet).
  saltFlat: Uint8Array | null
  // The water table's depth below the surface per node, metres, −1 under
  // water (the hydrogeology), or null. And its oases: the springs in an
  // arid climate, world coordinates.
  waterTable: Float32Array | null
  oases: { x: number; y: number }[]
  volcanoes: Volcano[]
  // Collision-belt points — tin / lode-gold / gem provenance. Combines the
  // CURRENT fold-mountain features (on-crust, always where collision ranges are)
  // with the accumulated (advected) sutures for deep-time belts. Empty if the
  // world has had no continental collisions.
  orogenPoints: { x: number; y: number }[]
  // Continental-crust oldness 0..1 per node (1 = ancient craton core), −1
  // off the crust (crust/raftField.computeCratonOldnessField). Feeds iron.
  cratonAge: Float32Array
  warpSeed: number
  domain: Domain
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
// while only the sliders move (applyEcology).
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
  // (ecologyFine).
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

export function computeEcology(inputs: EcologyInputs, params: EcologyParams): EcologyFields {
  return applyEcology(prepareEcology(inputs), params)
}

export function prepareEcology(inputs: EcologyInputs): EcologyBase {
  const { mesh, z, land, climate, biomes, discharge, maxDischarge, lakeDepth, saltFlat, waterTable, oases, volcanoes, orogenPoints, cratonAge, warpSeed, domain } = inputs
  const T = ECOLOGY_TUNING
  const n = mesh.vertexSlots
  const unitM = domain.metresPerUnit
  const geo = meshGeometry(mesh, unitM)
  const sea = new Uint8Array(n)
  const seaF = new Float32Array(n)
  for (let v = 0; v < n; v++) {
    if (mesh.vAlive[v] && !land[v]) {
      sea[v] = 1
      seaF[v] = 1
    }
  }
  const months = climate.months
  const monthCount = months ? months.count : 1

  // Every node's biome (the sea's Ocean).
  const biomeAt = new Uint8Array(n)
  for (let v = 0; v < n; v++) biomeAt[v] = land[v] ? biomes[v] : Biome.Ocean

  // --- water and sea within reach -------------------------------------------
  // The neighbourhoods by their reach: the coast's (the sea a coast fishes,
  // the shelf it counts) about every node, the water's and the placer's
  // about the land's.
  const coast = neighbourhoods(geo, T.coastReachM)
  const water = neighbourhoods(geo, T.waterReachM, land)
  const placer = neighbourhoods(geo, T.placerReachM, land)
  const ecotone = neighbourhoods(geo, T.ecotoneReachM, land)

  // The sea's richness per sea node: a base, the share of shelf sea within
  // reach, the upwelling and the winter mixing (see the fish constants).
  const shelfFloor = SEA_LEVEL - metersToElevation(T.fishShelfDepthM)
  const shallow = new Float32Array(n)
  for (let v = 0; v < n; v++) if (sea[v] && z[v] > shelfFloor) shallow[v] = 1
  const shelfShare = meanWithin(coast, shallow)
  const seaRich = new Float32Array(n)
  const seaRichStatic = new Float32Array(n)
  for (let v = 0; v < n; v++) {
    if (!sea[v]) continue
    const rising = climate.upwelling ? clamp01(climate.upwelling[v] / T.fishUpwellingFull) : 0
    const cool = seaMixing(climate.temperature[v])
    seaRichStatic[v] = T.fishSeaBase + T.fishShelfW * shelfShare[v] + T.fishUpwellingW * rising
    seaRich[v] = seaRichStatic[v] + T.fishMixingW * cool
  }
  const richSeaNear = maxWithin(coast, seaRich)
  const seaShare = meanWithin(coast, seaF)

  // A big river's water per land node (√ of the discharge against the
  // world's largest, doubled, capped), and what lies within reach of it.
  const hasHydrology = !!discharge && maxDischarge > 0
  const river = new Float32Array(n)
  const riverRoot = new Float32Array(n)
  const riverWet = new Float32Array(n)
  const lake = new Float32Array(n)
  if (discharge && maxDischarge > 0) {
    for (let v = 0; v < n; v++) {
      if (!land[v]) continue
      const share = Math.max(0, discharge[v]) / maxDischarge
      riverRoot[v] = Math.sqrt(share)
      // Below `riverFloor` (√ of the share) a stream is no fishing water
      // and waters no field: every node has some discharge.
      river[v] = Math.min(1, Math.max(0, riverRoot[v] - T.riverFloor) * 2)
      riverWet[v] = Math.min(1, share * 4)
    }
  }
  if (lakeDepth) for (let v = 0; v < n; v++) if (lakeDepth[v] > 0) lake[v] = 1
  const riverNear = maxWithin(water, river)
  // Placer gold lies in a river's gravels and terraces, wider than its bed.
  const riverRootNear = maxWithin(placer, riverRoot)
  const riverWetNear = maxWithin(water, riverWet)
  const lakeNear = maxWithin(water, lake)
  // A hand-dug well within a herd's reach.
  let wellNear: Float32Array | null = null
  if (waterTable) {
    const shallowTable = new Float32Array(n)
    for (let v = 0; v < n; v++) if (waterTable[v] >= 0 && waterTable[v] <= T.wellDepthM) shallowTable[v] = 1
    wellNear = maxWithin(water, shallowTable)
  }
  // Waterlogged ground: the water table within `wetlandTableM` of the
  // surface (bog iron forms where ground water seeps out).
  const waterlogged = new Float32Array(n)
  if (waterTable) for (let v = 0; v < n; v++) if (waterTable[v] >= 0 && waterTable[v] <= T.wetlandTableM) waterlogged[v] = 1
  // The oases' gardens.
  const oasis = discsAround(geo, oases, T.waterReachM)

  // How much of the land around differs in biome (game's edges): the
  // boundary's length per area at each land node, averaged within reach.
  const differs = boundaryDensity(geo, land, (a, b) => land[b] === 1 && biomeAt[a] !== biomeAt[b], T.ecotoneCountedOnM)
  const edges = meanWithin(ecotone, differs)

  // The slope per node, the rise across `flatnessRunM`.
  const slope = slopeOf(geo, z)

  // --- per node --------------------------------------------------------------
  const arable = new Float32Array(n)
  const fish = new Float32Array(n)
  const game = new Float32Array(n)
  const pasture = new Float32Array(n)
  const salt = new Float32Array(n)
  const timber = new Float32Array(n)
  const flatness = new Float32Array(n)
  const wetland = new Float32Array(n)
  const aridity = new Float32Array(n)
  const craton = new Float32Array(n)
  const keep = months ? {
    arableFactor: new Float32Array(n), fieldWater: new Float32Array(n), edgeFactor: new Float32Array(n),
    nppYear: new Float32Array(n), saltCoast: new Float32Array(n), access: new Float32Array(n), freshwater: new Float32Array(n),
  } : null
  for (let v = 0; v < n; v++) {
    if (!land[v]) continue
    const flat = 1 / (1 + T.slopeK * slope[v] * T.flatnessRunM)
    flatness[v] = flat

    // The fields' water.
    const fieldWater = Math.max(riverNear[v], T.oasisW * oasis[v])
    const herdWater = hasHydrology || wellNear ? Math.max(riverNear[v], wellNear ? T.wellW * wellNear[v] : 0) : 1

    // The months: arable's growing year, game's productivity, salt's dry
    // warm season.
    let growing = 0
    let npp = 0
    let arid = 0
    for (let m = 0; m < monthCount; m++) {
      const t = months ? months.temperature[m * n + v] : climate.temperature[v]
      const p = months ? Math.max(0, months.precipitation[m * n + v]) : Math.max(0, climate.precipitation[v])
      if (t >= T.arableFrostC || !months) growing += productivity(t, p + T.arableIrrigationMm * fieldWater) / monthCount
      npp += productivity(t, p) / monthCount
      arid += aridWarm(t, p) / monthCount
    }
    const yearT = climate.temperature[v]
    const yearP = Math.max(0, climate.precipitation[v])

    // Arable (see the constants): the growing year × flatness × the
    // harvest's reliability, which a watered field does not need.
    const risk = climate.rainVariability ? T.arableRiskW * climate.rainVariability[v] * (1 - fieldWater) : 0
    arable[v] = growing * flat * Math.max(0, 1 - risk)
    const edgeFactor = 1 + T.ecotoneBonus * clamp01(edges[v] / T.ecotoneFullShare)
    const saltCoast = T.saltInteriorW + (T.saltCoastW - T.saltInteriorW) * Math.min(1, seaShare[v] / T.fishFullSeaShare)

    // Fish: the richest sea within reach, as far as the sea is at hand
    // (a straight coast in full), plus the rivers and lakes near.
    const access = Math.min(1, seaShare[v] / T.fishFullSeaShare)
    const freshwater = Math.min(1, T.fishRiverW * riverNear[v] + T.fishLakeW * lakeNear[v])
    fish[v] = 1 - detExp(-(access * richSeaNear[v] + freshwater))

    // Game: productivity, more where biomes meet.
    game[v] = npp * edgeFactor

    // Pasture: the biome's grazing, in dry land only as far as a herd
    // finds water (without hydrology nothing is known of it: the biome
    // decides).
    const b = biomeAt[v] as LandBiomeId
    const dry = hasHydrology || wellNear ? clamp01((T.pastureDryMm - yearP) / (T.pastureDryMm - T.pastureDryFullMm)) : 0
    pasture[v] = (PASTURE_BY_BIOME[b] ?? 0.1) * (1 - dry * (1 - herdWater))
    timber[v] = TIMBER_BY_BIOME[b] ?? 0.05

    // Salt: a salt flat in full; else the dry warm season, strongest on
    // a coast.
    const flatSalt = saltFlat && saltFlat[v] ? T.saltFlatW : 0
    salt[v] = clamp01(Math.max(flatSalt, arid * saltCoast))
    if (keep) {
      keep.arableFactor[v] = flat * Math.max(0, 1 - risk)
      keep.fieldWater[v] = fieldWater
      keep.edgeFactor[v] = edgeFactor
      keep.nppYear[v] = npp
      keep.saltCoast[v] = saltCoast
      keep.access[v] = access
      keep.freshwater[v] = freshwater
    }

    // Wetland (bog iron): flat, wet, water-fed lowland.
    const wet = lakeNear[v] > 0 ? 1 : Math.max(riverWetNear[v], T.wetlandTableW * waterlogged[v])
    wetland[v] = flat * wet * clamp01(yearP / 600)
    aridity[v] = aridWarm(yearT, yearP)
    craton[v] = Math.max(0, cratonAge[v])
  }

  // The fishing grounds: on the sea the fish field is the sea's own
  // richness, what a boat finds there.
  for (let v = 0; v < n; v++) if (sea[v]) fish[v] = 1 - detExp(-seaRich[v])

  // Material and prestige before the sliders. Copper = arc volcanoes; tin =
  // orogen belts (its radius a slider); iron = old cratons + bog iron.
  const arcVolcanoes = volcanoes.filter((p) => p.kind === 'arc')
  const obsidian = gaussianHalos(geo, thinPoints(volcanoes, T.obsidianKeep, warpSeed ^ 0x0b51d1a2), T.obsidianRadiusM)
  const toolStone = new Float32Array(n)
  for (let v = 0; v < n; v++) if (land[v]) toolStone[v] = Math.max(obsidian[v], T.flintBase * flatness[v])
  const copper = maskToLand(gaussianHalos(geo, thinPoints(arcVolcanoes, T.copperKeep, warpSeed ^ 0xc0bbe401), T.copperRadiusM), land)
  // Iron: the old-craton signal broken into deposits by a seeded noise (so it
  // fluctuates instead of reading as a flat 100%), plus bog iron in wetlands.
  const iron = new Float32Array(n)
  const ironNoise = noiseSampler(domain, T.ironDepositFreqX, T.ironDepositFreqY, (warpSeed ^ 0x51ed2701) | 0)
  for (let v = 0; v < n; v++) {
    if (!land[v]) continue
    const noise01 = (ironNoise(mesh.vx[v], mesh.vy[v]) + 1) / 2
    const deposit = T.ironDepositFloor + (1 - T.ironDepositFloor) * noise01
    iron[v] = clamp01(Math.max(T.ironCratonW * craton[v] * deposit, T.ironBogW * wetland[v]))
  }
  // Prestige (separate channel — no carrying-capacity contribution). Gold:
  // placer (carried down rivers) + lode at orogenic belts. Silver:
  // hydrothermal, near volcanic arcs. Gems: metamorphic/orogenic belts + arid
  // weathering (turquoise near copper, in applyEcology).
  const lode = gaussianHalos(geo, thinPoints(orogenPoints, T.goldLodeKeep, warpSeed ^ 0x601dfeed), T.goldLodeRadiusM)
  const arc = gaussianHalos(geo, thinPoints(arcVolcanoes, T.silverKeep, warpSeed ^ 0x5117e201), T.silverRadiusM)
  const gemBelt = gaussianHalos(geo, thinPoints(orogenPoints, T.gemKeep, warpSeed ^ 0x9e35c0de), T.gemRadiusM)
  const gold = new Float32Array(n)
  const silver = new Float32Array(n)
  for (let v = 0; v < n; v++) {
    if (!land[v]) continue
    const placerGold = Math.min(1, Math.max(0, riverRootNear[v] - T.goldPlacerSqrtFloor) * T.goldPlacerGain)
    gold[v] = clamp01(T.goldPlacerW * placerGold + T.goldLodeW * lode[v])
    silver[v] = clamp01(T.silverW * arc[v])
  }

  // The province layer (L2 of the concentration pipeline): volcanic soil and
  // a light seeded noise.
  const volcanic = gaussianHalos(geo, volcanoes, T.volcanicProvinceRadiusM)
  const provinceDeviation = new Float32Array(n)
  const provinceNoiseAt = noiseSampler(domain, T.provinceNoiseFreqX, T.provinceNoiseFreqY, warpSeed)
  for (let v = 0; v < n; v++) {
    if (!land[v]) continue
    provinceDeviation[v] = T.volcanicWeight * volcanic[v] + T.noiseWeight * provinceNoiseAt(mesh.vx[v], mesh.vy[v])
  }

  return {
    mesh, geo, domain, slots: n, land, sea,
    raw: { arable, fish, game, pasture, timber, salt, toolStone, copper, iron, gold, silver },
    gemBelt, aridity,
    tinPoints: thinPoints(orogenPoints, T.tinKeep, warpSeed ^ 0x71b2a903),
    provinceDeviation,
    seasonal: months && keep ? {
      months, ...keep, pastureYear: pasture, saltFlat, seaRichStatic, coast,
    } : null,
    raster: null,
  }
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

// The step's sliders on the physics: the per-field abundance, the carrying
// capacity's level and concentration, the province strength, tin's rarity.
// Cheap next to prepareEcology.
export function applyEcology(eco: EcologyBase, params: EcologyParams): EcologyFields {
  const T = ECOLOGY_TUNING
  const { slots: n, land, raw, geo } = eco
  // Fold-out nudges: per-field abundance multipliers, on copies so the base
  // stays as it was; they both scale the displayed field and (for
  // subsistence + salt) flow into the carrying-capacity combine below.
  const wmap = params.weights ?? {}
  const scaled = (arr: Float32Array, id: EcologyFieldId): Float32Array => {
    const out = arr.slice()
    const m = wmap[id] ?? 1
    // The fish are on the sea too (the fishing grounds).
    if (m !== 1) for (let v = 0; v < n; v++) if (land[v] || (id === 'fish' && eco.sea[v])) out[v] *= m
    return out
  }
  const arable = scaled(raw.arable, 'arable')
  const fish = scaled(raw.fish, 'fish')
  const game = scaled(raw.game, 'game')
  const pasture = scaled(raw.pasture, 'pasture')
  const salt = scaled(raw.salt, 'salt')

  // Saturating carrying-capacity base: subsistence sources complement with
  // diminishing returns (1 - e^-Σ w·x); salt adds a small preservation bonus (the
  // one sanctioned material→subsistence bleed).
  const base = new Float32Array(n)
  for (let v = 0; v < n; v++) {
    if (!land[v]) continue
    base[v] = 1 - detExp(-(T.wArable * arable[v] + T.wFish * fish[v] + T.wGame * game[v] + T.wPasture * pasture[v] + T.wSaltCc * salt[v]))
  }
  const carryingCapacity = concentrationPipeline(base, land, eco.provinceDeviation, params, geo.areaM2)

  const timber = scaled(raw.timber, 'timber')
  const toolStone = scaled(raw.toolStone, 'toolStone')
  const copper = scaled(raw.copper, 'copper')
  const tinRadius = T.tinRadiusM * (1 - 0.6 * Math.max(0, Math.min(1, params.tinRarity ?? 0)))
  const tin = scaled(maskToLand(gaussianHalos(geo, eco.tinPoints, tinRadius), land), 'tin')
  const iron = scaled(raw.iron, 'iron')
  const gold = scaled(raw.gold, 'gold')
  const silver = scaled(raw.silver, 'silver')
  const gemsRaw = new Float32Array(n)
  for (let v = 0; v < n; v++) if (land[v]) gemsRaw[v] = clamp01(T.gemOrogenW * eco.gemBelt[v] + T.gemAridW * eco.aridity[v] * copper[v])
  const gems = scaled(gemsRaw, 'gems')

  // Mask every per-resource field to the ocean sentinel so overlays skip
  // water — all but the fish, whose sea is its fishing grounds.
  const fields: Record<EcologyFieldId, Float32Array> = { carryingCapacity, arable, fish, game, pasture, timber, salt, toolStone, copper, tin, iron, gold, silver, gems }
  for (const id of ECOLOGY_FIELD_IDS) {
    const f = fields[id]
    for (let v = 0; v < n; v++) if (!land[v] && !(id === 'fish' && eco.sea[v])) f[v] = ECOLOGY_OCEAN
  }
  return { fields }
}

// --- the chart -----------------------------------------------------------------

// The fields as the screen and the migration read them: per pixel of the
// world raster (`width` × `height`, rasteriseNodeField's convention) from
// the nodes of the triangle under it — a land pixel (`pixelLand`, the
// raster's own land) from the land nodes, the fish's sea pixels from the
// sea nodes, linearly with the weights renormalised, never a blend with
// the ocean mark — and per cell of the climate's chart (CLIMATE_RES_X ×
// CLIMATE_RES_Y) the area mean of its land pixels: ECOLOGY_OCEAN where the
// texel under the cell's centre is sea, 0 on a land cell without a land
// pixel. `grid` is the world raster's (its cells' areas).
export interface EcologyRasters {
  resX: number
  resY: number
  fields: Record<EcologyFieldId, Float32Array>
  fine: { resX: number; resY: number; fields: Record<EcologyFieldId, Float32Array> }
}

export function ecologyRasters(eco: EcologyBase, fields: Partial<Record<EcologyFieldId, Float32Array>>, pixelLand: Uint8Array, grid: DomainGrid): EcologyRasters {
  const { resX: w, resY: h } = grid
  const fine = {} as Record<EcologyFieldId, Float32Array>
  const coarse = {} as Record<EcologyFieldId, Float32Array>
  for (const id of ECOLOGY_FIELD_IDS) {
    const f = fields[id]
    if (!f) continue
    fine[id] = ecologyFine(eco, f, pixelLand, w, h, id === 'fish')
    coarse[id] = toClimateCells(fine[id], pixelLand, grid)
  }
  return { resX: CLIMATE_RES_X, resY: CLIMATE_RES_Y, fields: coarse, fine: { resX: w, resY: h, fields: fine } }
}

// One field per pixel (see ecologyRasters). The pixels' triangles are found
// once per base and raster size (meshRaster.triangleRaster) and kept.
export function ecologyFine(eco: EcologyBase, field: Float32Array, pixelLand: Uint8Array, width: number, height: number, withSea: boolean): Float32Array {
  if (!eco.raster || eco.raster.width !== width || eco.raster.height !== height) eco.raster = triangleRaster(eco.mesh, width, height)
  const out = rasteriseNodePart(eco.mesh, field, eco.land, pixelLand, ECOLOGY_OCEAN, width, height, false, undefined, eco.raster)
  if (!withSea) return out
  const pixelSea = new Uint8Array(pixelLand.length)
  for (let p = 0; p < pixelSea.length; p++) pixelSea[p] = pixelLand[p] ? 0 : 1
  const seaPart = rasteriseNodePart(eco.mesh, field, eco.sea, pixelSea, ECOLOGY_OCEAN, width, height, false, undefined, eco.raster)
  for (let p = 0; p < out.length; p++) if (pixelSea[p]) out[p] = seaPart[p]
  return out
}

function toClimateCells(field: Float32Array, land: Uint8Array, grid: DomainGrid): Float32Array {
  const { resX: w, resY: h } = grid
  const nc = CLIMATE_RES_X * CLIMATE_RES_Y
  const sum = new Float64Array(nc)
  const count = new Float64Array(nc)
  for (let y = 0; y < h; y++) {
    const gy = Math.min(CLIMATE_RES_Y - 1, Math.floor((y / h) * CLIMATE_RES_Y))
    const a = grid.cellArea(y)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!land[i]) continue
      const c = gy * CLIMATE_RES_X + Math.min(CLIMATE_RES_X - 1, Math.floor((x / w) * CLIMATE_RES_X))
      sum[c] += field[i] * a
      count[c] += a
    }
  }
  const out = new Float32Array(nc)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    const cy = Math.min(h - 1, Math.floor(((gy + 0.5) / CLIMATE_RES_Y) * h))
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const c = gy * CLIMATE_RES_X + gx
      const centre = cy * w + Math.min(w - 1, Math.floor(((gx + 0.5) / CLIMATE_RES_X) * w))
      out[c] = !land[centre] ? ECOLOGY_OCEAN : count[c] > 0 ? sum[c] / count[c] : 0
    }
  }
  return out
}

// Deterministic mineralisation lottery (see the *_KEEP constants): hashes each
// point's integer position with the world seed + a per-resource salt and keeps
// the fraction that wins. Position-based (not index-based) so the surviving
// subset is stable as the feature list grows or reorders between epochs.
function thinPoints<P extends { x: number; y: number }>(points: P[], keepFraction: number, salt: number): P[] {
  if (keepFraction >= 1) return points
  const out: P[] = []
  for (const p of points) {
    let hsh = ((Math.floor(p.x) * 374761393 + Math.floor(p.y) * 668265263) ^ salt) | 0
    hsh = Math.imul(hsh ^ (hsh >>> 13), 1274126177)
    hsh = (hsh ^ (hsh >>> 16)) >>> 0
    if (hsh / 4294967296 < keepFraction) out.push(p)
  }
  return out
}

// Mask a point-influence field (copper/tin) to land only.
function maskToLand(field: Float32Array, land: Uint8Array): Float32Array {
  for (let i = 0; i < field.length; i++) if (!land[i]) field[i] = 0
  return field
}

// --- concentration pipeline (verified in Phase 1) ---------------------------

// By area (each node its Voronoi cell's, m²).
function landMean(field: Float32Array, land: Uint8Array, area: Float64Array): number {
  let sum = 0
  let total = 0
  for (let v = 0; v < field.length; v++) if (land[v]) { sum += field[v] * area[v]; total += area[v] }
  return total > 0 ? sum / total : 0
}

// Province noise (see Phase 1): smooth seeded value noise in [-1,1] at a coarse
// lattice frequency — broad "provinces", not fine texture. `lattice`: the
// noise's lattice over the domain (freqX × freqY cells), which wraps it.
function hashLattice(ix: number, iy: number, seed: number): number {
  let hsh = (ix * 374761393 + iy * 668265263 + seed * 1442695040) | 0
  hsh = (hsh ^ (hsh >>> 13)) * 1274126177
  hsh = hsh ^ (hsh >>> 16)
  return (hsh >>> 0) / 4294967295
}
// The noise at a world point, in [-1, 1], at a lattice of freqX × freqY
// cells over the world: the periodic chart lattice on the torus
// (provinceNoise), the globe's 3D lattice on the sphere (Domain.noise — one
// value at a pole, no seam, as rough east-west as north-south), of the same
// cell size along the equator.
function noiseSampler(domain: Domain, freqX: number, freqY: number, seed: number): (x: number, y: number) => number {
  const space = domain.noise
  const { width: w, height: h } = domain
  if (space.kind === 'chart') {
    const lattice = domain.grid(freqX, freqY)
    return (x, y) => provinceNoise(x / w, y / h, lattice, seed)
  }
  const frame = globeFrame()
  return (x, y) => {
    space.frame(x, y, frame)
    return globeOctaveOn(frame, freqX, domain, seed) * 2 - 1
  }
}
function provinceNoise(u: number, v: number, lattice: DomainGrid, seed: number): number {
  const gx = u * lattice.resX
  const gy = v * lattice.resY
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const fx = smoothstep(gx - x0)
  const fy = smoothstep(gy - y0)
  const c00 = hashLattice(lattice.wrapCol(x0), lattice.wrapRow(y0), seed)
  const c10 = hashLattice(lattice.wrapCol(x0 + 1), lattice.wrapRow(y0), seed)
  const c01 = hashLattice(lattice.wrapCol(x0), lattice.wrapRow(y0 + 1), seed)
  const c11 = hashLattice(lattice.wrapCol(x0 + 1), lattice.wrapRow(y0 + 1), seed)
  const top = c00 + (c10 - c00) * fx
  const bottom = c01 + (c11 - c01) * fx
  return (top + (bottom - top) * fy) * 2 - 1
}

// Runs the base subsistence aggregate through `normalise → L1 gamma
// (mean-preserving) → L2 province (mean-1) → gain`, so carrying capacity's gain
// changes only the level and concentration only the shape. Verified in Phase 1.
function concentrationPipeline(base: Float32Array, land: Uint8Array, dev: Float32Array, params: EcologyParams, area: Float64Array): Float32Array {
  const n = base.length
  let maxBase = 0
  for (let i = 0; i < n; i++) if (land[i] && base[i] > maxBase) maxBase = base[i]
  const norm = new Float32Array(n)
  if (maxBase > 0) for (let i = 0; i < n; i++) if (land[i]) norm[i] = base[i] / maxBase
  const meanNorm = landMean(norm, land, area)

  const gamma = detPow(2, params.concentration / 100)
  const shaped = new Float32Array(n)
  for (let i = 0; i < n; i++) if (land[i]) shaped[i] = detPow(norm[i], gamma)
  const meanShaped = landMean(shaped, land, area)
  const l1Scale = meanShaped > 0 ? meanNorm / meanShaped : 1
  for (let i = 0; i < n; i++) if (land[i]) shaped[i] *= l1Scale

  const strength = params.provinceStrength
  const meanDev = landMean(dev, land, area)
  const provincal = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    provincal[i] = shaped[i] * Math.max(0.1, 1 + strength * (dev[i] - meanDev))
  }
  const meanProv = landMean(provincal, land, area)
  const l2Scale = meanProv > 0 ? meanNorm / meanProv : 1

  const gain = params.carryingCapacity / 100
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = land[i] ? provincal[i] * l2Scale * gain : ECOLOGY_OCEAN
  return out
}
