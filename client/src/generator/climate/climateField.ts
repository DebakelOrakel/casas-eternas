// Climate is computed on a coarse grid — temperature/precipitation/wind are
// large-scale and smooth, so a small raster + sampling is plenty (see
// docs/decisions/climate-biomes.md). Elevation is read from the full-res field
// where fine detail matters (lapse, and later orographic rain shadow).
import { isLandAt } from '../elevation/elevationScale'
import { torusDomain, type Domain } from '../core/domain'
import { CLIMATE_TUNING } from './climateTuneParams'
import { detCos } from '../core/detMath'

export const CLIMATE_RES_X = 256
export const CLIMATE_RES_Y = 128

// AN ISLAND'S CLIMATE. A land pixel whose four nearest climate cells are all
// sea has no land climate to interpolate: an island under a cell's size
// (~62 km). It read the ocean sentinel instead — no rain, a desert, salt —
// so every small tropical island and island arc came out a salt desert
// (2026-10-01, structure review). It gets the mean of the land cells of its
// climate row: the latitude's land climate, wet in the tropics and dry in
// the subtropics. Not the nearest land cell, whose coast can be another
// climate entirely.
//
// The mean of `field` (from `offset`, one climate grid of it) over the
// cells `isLand` marks, per climate row; a row without land takes the mean
// of all land, a world without land 0. `rowArea`: a cell's area in a row
// (DomainGrid.cellArea), for that mean of all land — 1 on the torus, cos φ
// on the sphere, whose polar rows' cells counted whole made the polar land
// weigh as much as the equator's. A row's own mean needs none: its cells
// are all one size.
export function zonalLandMean(field: ArrayLike<number>, isLand: (i: number) => boolean, offset = 0, rowArea?: (gy: number) => number): Float32Array {
  const out = new Float32Array(CLIMATE_RES_Y)
  const rowHas = new Uint8Array(CLIMATE_RES_Y)
  let total = 0
  let totalCount = 0
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    let sum = 0
    let count = 0
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      if (!isLand(i)) continue
      sum += field[offset + i]
      count++
    }
    if (count > 0) {
      out[gy] = sum / count
      rowHas[gy] = 1
    }
    const a = rowArea ? rowArea(gy) : 1
    total += sum * a
    totalCount += count * a
  }
  const fallback = totalCount > 0 ? total / totalCount : 0
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) if (!rowHas[gy]) out[gy] = fallback
  return out
}

// The calendar. The top hemisphere (the rows before the equator, small y)
// has its summer in January and the bottom one in July: the map is drawn
// mirrored in y (the canvas's +y is up on screen), so the top rows are the
// half at the BOTTOM of the screen, and the screen's upper half — the north
// a reader sees, whose winds also turn as the north's do there — must have
// the northern calendar. Until 2026-09-29 it was the other way round, and
// the north on screen had its summer in January. The energy balance's
// equinox (ebmVernalEquinoxYear) and the rain belt's peak
// (refineItczPeakYear) are set to agree with this; everything that builds
// or reads a year by hemisphere goes through the two helpers below.
export const TOP_SUMMER_MONTH = 0

// 1 in the top hemisphere's warmest month, −1 six months later.
export function topSummerCos(month: number): number {
  return detCos(((month - TOP_SUMMER_MONTH) / 12) * 2 * Math.PI)
}

// Whether a month lies in the top hemisphere's summer half (the six months
// around TOP_SUMMER_MONTH, October–March).
export function inTopSummerHalf(month: number): boolean {
  return (((month - TOP_SUMMER_MONTH + 3) % 12) + 12) % 12 < 6
}

// Normalized row position (0..1) shifted by `equatorOffset` and wrapped around the
// torus — the single place the "move the equator" knob lives. Every zonal climate
// field (temperature, wind, precipitation, seasonality) derives its latitude from a
// row's yNorm; subtracting the offset and wrapping cyclically slides the whole band
// (equator + poles) up/down the map so a continent stuck at the cold pole seam can be
// brought under the warm equator. `resY` is the caller's own grid height (some climate
// steps run on their own raster). Offset is a fraction of map height; +ve moves the
// equator toward the bottom.
export function shiftedYNorm(gridY: number, resY: number, equatorOffset: number): number {
  return shiftedNorm((gridY + 0.5) / resY, equatorOffset)
}

// The same for a point's row position y / height (0..1) — a field mesh
// cell's (climateMesh.yNorm), DEC-0036 phase 3.
export function shiftedNorm(yNorm: number, equatorOffset: number): number {
  const y = yNorm - equatorOffset
  return y - Math.floor(y)
}

// Latitude 0..1 (0 the equator, 1 a pole) of a shifted row position.
export function latitudeOfNorm(shifted: number): number {
  return Math.abs(shifted - 0.5) * 2
}

// Where a row sits in the zonal bands when they follow the season: its
// shiftedYNorm moved by `beltShift` (a fraction of the map's height, + toward
// the top), in full at the equator and down to `precipBeltShiftFloor` of it
// from `precipBeltTaperDeg` poleward — the equatorial rain belt follows the
// sun some 10–15°, the subtropical highs and the wind cells some 4–5°. The
// rain (precipitation.ts), the wind cells (wind.ts) and the pressure bands
// (pressure.ts) all move by it, so they move together. 0 is the year's mean
// position, exactly.
//
// `shape`: on the torus the pole is the seam where the top and the bottom
// meet, and the bands slide across it, as they did. On the sphere the pole
// is a point and does not move: the shift goes linearly to 0 over the last
// `beltShiftPoleTaperDeg` before each pole, so the polar cell stretches and
// shrinks with the season and its end stays at the pole (DEC-0035, fork 5).
// Without this the cells slid 4.4° past the pole, and the banded wind at
// the pole row was 0.3–0.55 (2.4–4.4 m/s) in its local frame: a ring of
// vectors that point all ways around the pole, not one vector.
export function beltYNorm(trueNorm: number, beltShift: number, shape: Domain['kind'] = 'torus'): number {
  if (beltShift === 0) return trueNorm
  const lat = Math.abs(trueNorm - 0.5) * 2
  let reach = CLIMATE_TUNING.precipBeltShiftFloor + (1 - CLIMATE_TUNING.precipBeltShiftFloor) * Math.max(0, 1 - (lat * 90) / CLIMATE_TUNING.precipBeltTaperDeg)
  if (shape === 'sphere') reach *= Math.min(1, ((1 - lat) * 90) / CLIMATE_TUNING.beltShiftPoleTaperDeg)
  const shifted = trueNorm + beltShift * reach
  return shifted - Math.floor(shifted)
}

// Latitude 0..1 for a climate-grid row: 0 at the equator (the horizontal
// midline) and 1 at the top/bottom edges — which are the same glued cold
// "pole" seam on the torus, so the two hemispheres come out mirror-symmetric.
// Uses the cell center (gy + 0.5). `equatorOffset` slides the band (see shiftedYNorm).
export function latitudeAt(gridY: number, equatorOffset = 0): number {
  // The domain object (core/domain.ts) owns the mapping; this is its
  // climate-grid reading.
  return torusDomain(CLIMATE_RES_X, CLIMATE_RES_Y, equatorOffset).latitude((gridY + 0.5) / CLIMATE_RES_Y)
}

// Full-res elevation sample at a climate cell's center, for lapse etc. The
// climate grid maps linearly onto the world; a single center sample is enough
// for a smooth field like temperature (orographic precip will sample the fine
// gradient itself in a later phase).
// Samples the dry-basin land-override mask (see hydrology's LakeFields.dryBasin)
// at the same full-res point sampleElevationAtCell reads, so the two can never
// disagree about which pixel represents a coarse cell. Null mask = no override.
export function sampleDryLandAtCell(
  dryLand: Uint8Array | null | undefined,
  gridX: number,
  gridY: number,
  worldWidth: number,
  worldHeight: number,
): boolean {
  if (!dryLand) return false
  const worldX = Math.min(worldWidth - 1, Math.floor(((gridX + 0.5) / CLIMATE_RES_X) * worldWidth))
  const worldY = Math.min(worldHeight - 1, Math.floor(((gridY + 0.5) / CLIMATE_RES_Y) * worldHeight))
  return dryLand[worldY * worldWidth + worldX] === 1
}

export function sampleElevationAtCell(
  elevation: Float32Array,
  gridX: number,
  gridY: number,
  worldWidth: number,
  worldHeight: number,
): number {
  const worldX = Math.min(worldWidth - 1, Math.floor(((gridX + 0.5) / CLIMATE_RES_X) * worldWidth))
  const worldY = Math.min(worldHeight - 1, Math.floor(((gridY + 0.5) / CLIMATE_RES_Y) * worldHeight))
  return elevation[worldY * worldWidth + worldX]
}

// The land test on the CLIMATE grid: sample the full-res elevation and the
// dry-basin mask at this coarse cell, then apply the one definition. Callers
// used to inline both samples and the comparison; six copies, two polarities.
export function isLandAtCell(
  elevation: Float32Array,
  dryLand: Uint8Array | null | undefined,
  gridX: number,
  gridY: number,
  worldWidth: number,
  worldHeight: number,
): boolean {
  return isLandAt(
    sampleElevationAtCell(elevation, gridX, gridY, worldWidth, worldHeight),
    sampleDryLandAtCell(dryLand, gridX, gridY, worldWidth, worldHeight),
  )
}
