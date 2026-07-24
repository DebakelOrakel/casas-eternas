// Climate is computed on a coarse grid — temperature/precipitation/wind are
// large-scale and smooth, so a small raster + sampling is plenty (see
// docs/decisions/climate-biomes.md). Elevation is read from the full-res field
// where fine detail matters (lapse, and later orographic rain shadow).
export const CLIMATE_RES_X = 256
export const CLIMATE_RES_Y = 128

// Latitude 0..1 for a climate-grid row: 0 at the equator (the horizontal
// midline) and 1 at the top/bottom edges — which are the same glued cold
// "pole" seam on the torus, so the two hemispheres come out mirror-symmetric.
// Uses the cell center (gy + 0.5).
export function latitudeAt(gridY: number): number {
  const yNorm = (gridY + 0.5) / CLIMATE_RES_Y
  return Math.abs(yNorm - 0.5) * 2
}

// Full-res elevation sample at a climate cell's center, for lapse etc. The
// climate grid maps linearly onto the world; a single center sample is enough
// for a smooth field like temperature (orographic precip will sample the fine
// gradient itself in a later phase).
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
