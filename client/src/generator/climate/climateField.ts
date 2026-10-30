// The climate's CHART: the CLIMATE_RES_X × CLIMATE_RES_Y raster the
// climate's field mesh is drawn on for the screen and a save's readers
// (climateChart.ts) — no stage computes on it since DEC-0036 (phase 3 the
// climate, phase 7 its readers) — and the latitude and the calendar, which
// the field mesh reads per cell.
import { torusDomain } from '../core/domain'
import { detCos } from '../core/detMath'

export const CLIMATE_RES_X = 256
export const CLIMATE_RES_Y = 128

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
// gradient itself in a later phase). Read today by the chart's elevation
// readout.
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
