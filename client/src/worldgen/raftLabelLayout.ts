import type { Raft } from './rafts'
import type { ContinentLabelPlacement } from './continentLabelLayout'
import { wrappedDelta } from './toroidal'

// Label geometry for each named raft, computed straight from its blob set —
// cheap (no raster pass, unlike the per-plate computeContinentLabelPlacements
// this replaced): center at the area-weighted blob centroid, angle from a
// weighted PCA over the blob centers (so the label lies along the continent's
// long axis, like a real map labeling an elongated landmass along its shape),
// and along/across extents from the blobs' spread plus their own radii so the
// text renderer can size the label to fit inside the continent.
//
// Wrapping is handled by working in a local frame anchored on the largest
// blob (every other blob expressed as a wrappedDelta offset from it), so a
// continent straddling the map seam still gets a sane center and axis instead
// of one smeared across the whole width. Reuses ContinentLabelPlacement so
// the existing drawContinentLabel renderer works unchanged; `plateIndex`
// carries the raft id (the renderer ignores it, it's just a stable key).
export function computeRaftLabelPlacements(rafts: Raft[], width: number, height: number): ContinentLabelPlacement[] {
  const placements: ContinentLabelPlacement[] = []
  for (const raft of rafts) {
    if (!raft.name || raft.blobs.length === 0) continue
    let anchor = raft.blobs[0]
    for (const b of raft.blobs) if (b.radius > anchor.radius) anchor = b
    const pts: { dx: number; dy: number; r: number; w: number }[] = []
    let sumW = 0
    let meanX = 0
    let meanY = 0
    for (const b of raft.blobs) {
      const dx = wrappedDelta(b.x, anchor.x, width)
      const dy = wrappedDelta(b.y, anchor.y, height)
      const w = b.radius * b.radius
      pts.push({ dx, dy, r: b.radius, w })
      sumW += w
      meanX += dx * w
      meanY += dy * w
    }
    meanX /= sumW
    meanY /= sumW
    let cxx = 0
    let cyy = 0
    let cxy = 0
    for (const p of pts) {
      const ox = p.dx - meanX
      const oy = p.dy - meanY
      cxx += p.w * ox * ox
      cyy += p.w * oy * oy
      cxy += p.w * ox * oy
    }
    const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
    const ax = Math.cos(angle)
    const ay = Math.sin(angle)
    let along = 0
    let perp = 0
    for (const p of pts) {
      const ox = p.dx - meanX
      const oy = p.dy - meanY
      const a = Math.abs(ox * ax + oy * ay) + p.r
      const pp = Math.abs(-ox * ay + oy * ax) + p.r
      if (a > along) along = a
      if (pp > perp) perp = pp
    }
    const centerX = (((anchor.x + meanX) % width) + width) % width
    const centerY = (((anchor.y + meanY) % height) + height) % height
    placements.push({ plateIndex: raft.id, name: raft.name, centerX, centerY, angle, alongExtent: along * 2, perpExtent: perp * 2 })
  }
  return placements
}
