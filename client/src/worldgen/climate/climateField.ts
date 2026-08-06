// Climate is computed on a coarse grid — temperature/precipitation/wind are
// large-scale and smooth, so a small raster + sampling is plenty (see
// docs/decisions/climate-biomes.md). Elevation is read from the full-res field
// where fine detail matters (lapse, and later orographic rain shadow).
export const CLIMATE_RES_X = 256
export const CLIMATE_RES_Y = 128

// Normalized row position (0..1) shifted by `equatorOffset` and wrapped around the
// torus — the single place the "move the equator" knob lives. Every zonal climate
// field (temperature, wind, precipitation, seasonality) derives its latitude from a
// row's yNorm; subtracting the offset and wrapping cyclically slides the whole band
// (equator + poles) up/down the map so a continent stuck at the cold pole seam can be
// brought under the warm equator. `resY` is the caller's own grid height (some climate
// steps run on their own raster). Offset is a fraction of map height; +ve moves the
// equator toward the bottom.
export function shiftedYNorm(gridY: number, resY: number, equatorOffset: number): number {
  const y = (gridY + 0.5) / resY - equatorOffset
  return y - Math.floor(y)
}

// Latitude 0..1 for a climate-grid row: 0 at the equator (the horizontal
// midline) and 1 at the top/bottom edges — which are the same glued cold
// "pole" seam on the torus, so the two hemispheres come out mirror-symmetric.
// Uses the cell center (gy + 0.5). `equatorOffset` slides the band (see shiftedYNorm).
export function latitudeAt(gridY: number, equatorOffset = 0): number {
  const yNorm = shiftedYNorm(gridY, CLIMATE_RES_Y, equatorOffset)
  return Math.abs(yNorm - 0.5) * 2
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
