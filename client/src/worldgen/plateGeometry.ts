// Circular mean per axis (not a plain arithmetic mean) — a cell can wrap
// around the map's own seam, and averaging raw x/y coordinates across a
// wrap gives a nonsense midpoint on the far side of the map. Treating
// each axis as an angle around its own period and averaging sin/cos
// handles the wrap correctly; the seed itself isn't a reliable stand-in
// for this since a Voronoi cell's generator point can sit well off its
// own territory's actual visual center, especially once drift and rifts
// have reshaped it.
function accumulateCircularMean(sinSum: Float64Array, cosSum: Float64Array, index: number, coordinate: number, period: number): void {
  const angle = (coordinate / period) * Math.PI * 2
  sinSum[index] += Math.sin(angle)
  cosSum[index] += Math.cos(angle)
}

function circularMeanToCoordinate(sinSum: number, cosSum: number, period: number): number {
  const angle = Math.atan2(sinSum, cosSum)
  const normalized = ((angle / (Math.PI * 2)) % 1) + 1
  return (normalized % 1) * period
}

// Each plate's true visual center on a wrapping map (not its possibly
// off-territory seed position) — used to anchor the velocity arrows
// (elevationMapImage.ts). Continent-name placement uses raft blob geometry
// instead now (raftLabelLayout.ts), not plate centroids.
export function computePlateCentroids(cellIds: Uint16Array, plateCount: number, width: number, height: number): { x: number; y: number }[] {
  const sinSumX = new Float64Array(plateCount)
  const cosSumX = new Float64Array(plateCount)
  const sinSumY = new Float64Array(plateCount)
  const cosSumY = new Float64Array(plateCount)
  const counts = new Uint32Array(plateCount)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const plateIndex = cellIds[y * width + x]
      accumulateCircularMean(sinSumX, cosSumX, plateIndex, x, width)
      accumulateCircularMean(sinSumY, cosSumY, plateIndex, y, height)
      counts[plateIndex] += 1
    }
  }

  return Array.from({ length: plateCount }, (_, i) =>
    counts[i] > 0
      ? { x: circularMeanToCoordinate(sinSumX[i], cosSumX[i], width), y: circularMeanToCoordinate(sinSumY[i], cosSumY[i], height) }
      : { x: 0, y: 0 },
  )
}
