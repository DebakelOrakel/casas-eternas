// Sampling and resampling for the coarse toroidal scalar fields worldgen is full
// of — ocean age, mantle buoyancy, raft membership, every climate and ecology
// layer. They are all the same shape of thing (a Float32Array plus a resolution,
// wrapping in both axes), but there was no shared vocabulary for them, so seven
// sampler functions and eight bilinear interpolations had grown up one per
// module.
//
// Not all seven were the same operation, and this module deliberately does NOT
// merge the ones that only looked alike:
//
//  - `climate/climateField.sampleElevationAtCell` reads a FULL-RES raster at a
//    coarse cell's centre. That is the inverse direction — coarse index in,
//    fine-grid value out — and it stays where it is.
//  - `climate/precipitation.elevationAtWorld` likewise reads the full-res
//    elevation raster, not a coarse field.
//
// What did merge, being character-for-character identical in each pair:
//  - oceanCurrents' `sampleWrapped` and precipitation's `sampleGridWrapped`
//    -> sampleBilinearGrid
//  - rafts' `sampleMembershipField` and worldSave's `sampleAt` -> sampleNearestWorld
//  - ecology's and worldSave's `downsampleMax` -> downsampleMax
// plus oceanAge's own bilinear-in-world-coordinates sampler -> sampleBilinearWorld.

// Wrap a value into [0, n) for any sign. The one-liner that had nine private
// copies across eight files.
// A wrapped 2-D index on a resX×resY grid — the helper oceanCurrents,
// seasonality and monsoon each used to write for themselves (BUG_BOUNTY 34).
export function wrapIndex2(x: number, y: number, resX: number, resY: number): number {
  return wrapValue(y, resY) * resX + wrapValue(x, resX)
}

export function wrapValue(v: number, n: number): number {
  return ((v % n) + n) % n
}

// Bilinear sample at FRACTIONAL GRID coordinates, wrapping in both axes.
// Coordinates are cell indices, not world units, and a whole number lands exactly
// on a cell — i.e. cell centres sit at integers here, which is the convention the
// climate advection steps are written in.
export function sampleBilinearGrid(field: Float32Array, resX: number, resY: number, fx: number, fy: number): number {
  const x = wrapValue(fx, resX)
  const y = wrapValue(fy, resY)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = (x0 + 1) % resX
  const y1 = (y0 + 1) % resY
  const tx = x - x0
  const ty = y - y0
  const top = field[y0 * resX + x0] * (1 - tx) + field[y0 * resX + x1] * tx
  const bottom = field[y1 * resX + x0] * (1 - tx) + field[y1 * resX + x1] * tx
  return top * (1 - ty) + bottom * ty
}

// Bilinear sample at WORLD coordinates. Note the −0.5: this convention puts cell
// centres at (i + 0.5)·cellSize, so a world point exactly on a cell's centre
// samples that cell's value alone. That is a different convention from
// sampleBilinearGrid above, and the difference is real rather than an accident —
// merging the two would shift every sample by half a cell.
export function sampleBilinearWorld(
  field: Float32Array, resX: number, resY: number,
  x: number, y: number, worldWidth: number, worldHeight: number,
): number {
  const gx = (x / worldWidth) * resX - 0.5
  const gy = (y / worldHeight) * resY - 0.5
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const fx = gx - x0
  const fy = gy - y0
  const x0m = wrapValue(x0, resX)
  const y0m = wrapValue(y0, resY)
  const x1m = (x0m + 1) % resX
  const y1m = (y0m + 1) % resY
  const v00 = field[y0m * resX + x0m]
  const v10 = field[y0m * resX + x1m]
  const v01 = field[y1m * resX + x0m]
  const v11 = field[y1m * resX + x1m]
  const top = v00 + (v10 - v00) * fx
  const bottom = v01 + (v11 - v01) * fx
  return top + (bottom - top) * fy
}

// A whole raster resampled UP onto a finer grid, bilinear and torus-wrapped.
// Lives here rather than in its original home (elevationMapImage's preview
// upscale) because the amplification bake needs the identical operation —
// see docs/decisions/worldmap-amplification.md. Note what upscaling alone
// does NOT do: it adds no information, so the result is smooth at every
// scale below the source grid (the "compositing caveat" in
// docs/design/resolution-strategy.md). Whatever needs detail down there has
// to come from a finer PROCESS on top, not from this function.
export function upscaleBilinearToroidal(src: Float32Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): Float32Array {
  const dst = new Float32Array(dstWidth * dstHeight)
  const fx = srcWidth / dstWidth
  const fy = srcHeight / dstHeight
  for (let y = 0; y < dstHeight; y++) {
    const sy = y * fy
    const y0 = Math.floor(sy)
    const ty = sy - y0
    const y0m = wrapValue(y0, srcHeight)
    const y1m = (y0m + 1) % srcHeight
    for (let x = 0; x < dstWidth; x++) {
      const sx = x * fx
      const x0 = Math.floor(sx)
      const tx = sx - x0
      const x0m = wrapValue(x0, srcWidth)
      const x1m = (x0m + 1) % srcWidth
      const v00 = src[y0m * srcWidth + x0m]
      const v10 = src[y0m * srcWidth + x1m]
      const v01 = src[y1m * srcWidth + x0m]
      const v11 = src[y1m * srcWidth + x1m]
      const top = v00 + (v10 - v00) * tx
      const bottom = v01 + (v11 - v01) * tx
      dst[y * dstWidth + x] = top + (bottom - top) * ty
    }
  }
  return dst
}

// Nearest-cell sample at world coordinates, torus-wrapped. For consumers that
// threshold the result rather than using its magnitude, where interpolation would
// only cost time.
export function sampleNearestWorld(
  field: Float32Array, resX: number, resY: number,
  x: number, y: number, worldWidth: number, worldHeight: number,
): number {
  const gx = Math.min(resX - 1, Math.floor((wrapValue(x, worldWidth) / worldWidth) * resX))
  const gy = Math.min(resY - 1, Math.floor((wrapValue(y, worldHeight) / worldHeight) * resY))
  return field[gy * resX + gx]
}

// Full-resolution raster down to a coarse grid, taking the MAXIMUM over each
// footprint rather than a mean or a centre sample. For thin features — rivers,
// lakes — a footprint max is the only reduction that doesn't lose them entirely
// between coarse cell centres.
// Full-resolution raster down to a coarse grid by the MEAN over each
// footprint — the right reduction for a continuous field like elevation,
// where downsampleMax would raise every coarse cell to its highest peak.
// The derived bake tiers lean on this being deterministic: same input,
// same bytes, whoever computes it (docs/decisions/derived-bake-tiers.md).
export function downsampleBox(fullRes: Float32Array, fullW: number, fullH: number, resX: number, resY: number): Float32Array {
  const out = new Float32Array(resX * resY)
  const fw = fullW / resX
  const fh = fullH / resY
  for (let gy = 0; gy < resY; gy++) {
    const y0 = Math.floor(gy * fh)
    const y1 = Math.floor((gy + 1) * fh)
    for (let gx = 0; gx < resX; gx++) {
      const x0 = Math.floor(gx * fw)
      const x1 = Math.floor((gx + 1) * fw)
      let sum = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += fullRes[y * fullW + x]
      out[gy * resX + gx] = sum / ((y1 - y0) * (x1 - x0))
    }
  }
  return out
}

export function downsampleMax(fullRes: Float32Array, fullW: number, fullH: number, resX: number, resY: number): Float32Array {
  const out = new Float32Array(resX * resY)
  const fw = fullW / resX
  const fh = fullH / resY
  for (let gy = 0; gy < resY; gy++) {
    const y0 = Math.floor(gy * fh)
    const y1 = Math.floor((gy + 1) * fh)
    for (let gx = 0; gx < resX; gx++) {
      const x0 = Math.floor(gx * fw)
      const x1 = Math.floor((gx + 1) * fw)
      // Seeded from the block's first value, not 0: a block below zero
      // everywhere has a real maximum too (an empty block stays 0).
      let m = x1 > x0 && y1 > y0 ? fullRes[y0 * fullW + x0] : 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = fullRes[y * fullW + x]; if (v > m) m = v }
      out[gy * resX + gx] = m
    }
  }
  return out
}
