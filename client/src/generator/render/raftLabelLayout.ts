import type { ContinentLabelPlacement } from './continentLabelRenderer'
import type { Domain } from '../core/domain'
import type { Raft } from '../crust/raftTypes'

// Label geometry for each named raft, computed straight from its blob set —
// cheap (no raster pass, unlike the per-plate computeContinentLabelPlacements
// this replaced): center at the area-weighted blob centroid, angle from a
// weighted PCA over the blob centers (so the label lies along the continent's
// long axis, like a real map labeling an elongated landmass along its shape),
// and along/across extents from the blobs' spread plus their own radii so the
// text renderer can size the label to fit inside the continent.
//
// Wrapping is handled by working in a local frame anchored on the largest
// blob (every other blob expressed as the domain's delta from it), so a
// continent straddling the map seam still gets a sane center and axis instead
// of one smeared across the whole width. On the sphere that frame is the
// anchor's tangent plane (Domain.delta): the extents are true lengths, and
// the axis is a true direction in the anchor's east and south axes. The
// centre is then reached from the anchor along the globe (Domain.advance)
// and the axis carried to it (Domain.transport), so the placement holds at
// any latitude. On the torus advance is the wrapped sum and transport keeps
// the angle: the same numbers as before the sphere. Reuses ContinentLabelPlacement so
// the existing drawContinentLabel renderer works unchanged; `plateIndex`
// carries the raft id (the renderer ignores it, it's just a stable key).
export function computeRaftLabelPlacements(rafts: Raft[], domain: Domain): ContinentLabelPlacement[] {
  const placements: ContinentLabelPlacement[] = []
  const offset = { x: 0, y: 0 }
  const centre = { x: 0, y: 0 }
  for (const raft of rafts) {
    if (!raft.name || raft.blobs.length === 0) continue
    let anchor = raft.blobs[0]
    for (const b of raft.blobs) if (b.radius > anchor.radius) anchor = b
    const pts: { dx: number; dy: number; r: number; w: number }[] = []
    let sumW = 0
    let meanX = 0
    let meanY = 0
    for (const b of raft.blobs) {
      domain.delta(b.x, b.y, anchor.x, anchor.y, offset)
      const dx = offset.x
      const dy = offset.y
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
    let angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
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
    // If the area-weighted centre falls in an OCEAN GAP — inside no blob, which happens
    // for a two-lobe (dumbbell) continent — a label placed there floats off the land and
    // reads as missing. Re-anchor on the largest blob and size to it so the name always
    // sits on solid ground (solid/elongated continents, whose centre is on land, are
    // unchanged and keep their long spread-based label).
    let localX = meanX
    let localY = meanY
    const centreOnLand = pts.some((p) => Math.hypot(p.dx - meanX, p.dy - meanY) < p.r)
    if (!centreOnLand) {
      localX = 0 // the anchor (largest) blob's own centre, dx=dy=0 in this frame
      localY = 0
      along = anchor.radius
      perp = anchor.radius
    }
    domain.advance(anchor.x, anchor.y, localX, localY, centre)
    // The angle is computed again only when the transport turned the axis:
    // on the torus it does not, and the angle keeps its bits.
    if (localX !== 0 || localY !== 0) {
      domain.transport(ax, ay, anchor.x, anchor.y, centre.x, centre.y, offset)
      if (offset.x !== ax || offset.y !== ay) angle = Math.atan2(offset.y, offset.x)
    }
    placements.push({ plateIndex: raft.id, name: raft.name, centerX: centre.x, centerY: centre.y, angle, alongExtent: along * 2, perpExtent: perp * 2 })
  }
  return placements
}
