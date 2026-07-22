import type { PlateType } from './plateTypes'
import { wrappedDelta } from './toroidal'

export interface ContinentLabelPlacement {
  plateIndex: number
  name: string
  centerX: number
  centerY: number
  // Radians — the plate's own principal (long) axis, from a 2D PCA over
  // its pixel mask. Labels lay their baseline along this rather than a
  // fixed horizontal, the same way a real map labels an elongated
  // landmass along its own shape instead of always flat.
  angle: number
  // Actual footprint extent along/across that axis, measured by
  // projecting every pixel the plate owns (not by the covariance's own
  // spread, which describes variance, not a hard boundary) — this is
  // what the renderer sizes/fits text against so a label stays inside
  // its own coastline instead of overflowing into a neighbor.
  alongExtent: number
  perpExtent: number
}

// Finds, for every continental plate with a name, where and how to lay
// its label out: center, principal-axis angle, and the actual usable
// extent along and across that axis. Pure geometry — no font, no canvas,
// no drawing; this module only has to run inside the simulation worker
// (which has cellIds but no Canvas2D), and hands off a small per-plate
// summary for whichever context actually draws text (see
// WorldGenScreen.ts).
//
// Two full-image passes are needed, not one: the principal axis angle
// comes from a covariance matrix over every pixel's offset from the
// plate's own centroid, and the actual along/across extent then needs to
// project every pixel onto THAT angle — which isn't known until the
// first pass finishes. Both passes are only ever taken over continental,
// named plates (oceanic ones are skipped immediately), and reuse
// wrappedDelta so a plate whose territory straddles the map's own seam
// still gets a sane offset instead of one that jumps across the whole
// map width/height.
export function computeContinentLabelPlacements(
  cellIds: Uint16Array,
  types: PlateType[],
  names: (string | null)[],
  centroids: { x: number; y: number }[],
  width: number,
  height: number,
): ContinentLabelPlacement[] {
  const plateCount = types.length
  const isLabeled = (plateIndex: number): boolean => types[plateIndex] === 'continental' && names[plateIndex] !== null

  const sumDxDx = new Float64Array(plateCount)
  const sumDyDy = new Float64Array(plateCount)
  const sumDxDy = new Float64Array(plateCount)
  const counts = new Uint32Array(plateCount)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const plateIndex = cellIds[y * width + x]
      if (!isLabeled(plateIndex)) continue
      const centroid = centroids[plateIndex]
      const dx = wrappedDelta(x, centroid.x, width)
      const dy = wrappedDelta(y, centroid.y, height)
      sumDxDx[plateIndex] += dx * dx
      sumDyDy[plateIndex] += dy * dy
      sumDxDy[plateIndex] += dx * dy
      counts[plateIndex] += 1
    }
  }

  // Standard 2D covariance-matrix principal-axis formula (the same one
  // image-moment-based orientation calculations use). This gives an
  // AXIS, not a direction — a line has no inherent "forward", so the
  // formula is only meaningful modulo π (atan2 covers a full 2π range,
  // twice what the axis itself distinguishes). Left as-is, this
  // routinely comes back pointing "backward" for a given continent's
  // natural reading direction, which rendered its name rotated 180°: not
  // just mirrored but upside down at once, since a half-turn flips both
  // axes together rather than just reflecting left-right. Normalizing
  // into (-π/2, π/2] picks whichever of the two equally-valid
  // representations points generally rightward, so the label's local
  // +x — the direction text is actually laid out along, see
  // continentLabelRenderer.ts — always reads left-to-right on screen.
  const angles = new Float64Array(plateCount)
  for (let i = 0; i < plateCount; i++) {
    if (counts[i] === 0) continue
    let angle = 0.5 * Math.atan2(2 * sumDxDy[i], sumDxDx[i] - sumDyDy[i])
    if (angle > Math.PI / 2) angle -= Math.PI
    else if (angle <= -Math.PI / 2) angle += Math.PI
    angles[i] = angle
  }

  const alongMin = new Float64Array(plateCount).fill(Infinity)
  const alongMax = new Float64Array(plateCount).fill(-Infinity)
  const perpMin = new Float64Array(plateCount).fill(Infinity)
  const perpMax = new Float64Array(plateCount).fill(-Infinity)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const plateIndex = cellIds[y * width + x]
      if (!isLabeled(plateIndex)) continue
      const centroid = centroids[plateIndex]
      const dx = wrappedDelta(x, centroid.x, width)
      const dy = wrappedDelta(y, centroid.y, height)
      const cosA = Math.cos(angles[plateIndex])
      const sinA = Math.sin(angles[plateIndex])
      const along = dx * cosA + dy * sinA
      const perp = -dx * sinA + dy * cosA
      if (along < alongMin[plateIndex]) alongMin[plateIndex] = along
      if (along > alongMax[plateIndex]) alongMax[plateIndex] = along
      if (perp < perpMin[plateIndex]) perpMin[plateIndex] = perp
      if (perp > perpMax[plateIndex]) perpMax[plateIndex] = perp
    }
  }

  const placements: ContinentLabelPlacement[] = []
  for (let i = 0; i < plateCount; i++) {
    const name = names[i]
    if (name === null || counts[i] === 0) continue
    placements.push({
      plateIndex: i,
      name,
      centerX: centroids[i].x,
      centerY: centroids[i].y,
      angle: angles[i],
      alongExtent: alongMax[i] - alongMin[i],
      perpExtent: perpMax[i] - perpMin[i],
    })
  }
  return placements
}
