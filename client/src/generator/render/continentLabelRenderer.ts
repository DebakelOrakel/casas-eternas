// Where and how to lay one continent's name out: center, principal-axis
// angle, and the usable extent along/across that axis (so the renderer can
// size the text to fit inside the landmass). Pure geometry, no font/canvas —
// produced by raftLabelLayout.ts (blob-PCA) and drawn by drawContinentLabel
// below. `plateIndex` is just a stable per-label key (the raft id), not a
// plate index — kept for name stability across redraws.
export interface ContinentLabelPlacement {
  plateIndex: number
  name: string
  centerX: number
  centerY: number
  angle: number
  alongExtent: number
  perpExtent: number
}

// Matches the title screen's own fantasy-map font (see title.css) —
// loaded globally via the Google Fonts link in index.html, so it's
// already available to any canvas 2D context in the document by the time
// this runs.
const FONT_FAMILY = 'Cinzel, serif'
const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 46
// Keeps a label comfortably inside its own coastline rather than
// touching it — extent is a hard pixel measurement of the plate's own
// footprint, not a stylistic margin.
const WIDTH_MARGIN_FACTOR = 0.82
const HEIGHT_MARGIN_FACTOR = 0.6
// Arc radius as a multiple of the label's own rendered width — large
// relative to the text, so the bend stays gentle rather than a
// pronounced curl. This is a fixed, purely decorative amount (an
// hand-lettered-map touch, echoing how a real illustrated map's labels
// often follow a coastline's own curve) — it is NOT what makes a long
// name fit a small continent; font-size shrinking below already handles
// that, and a name that still doesn't fit at the size floor is skipped
// rather than bent harder to force it.
const CURVE_RADIUS_FACTOR = 2.5

const LABEL_FILL = '#241a10'
// A strong, near-opaque halo so the name stays legible over busy terrain (mountain
// features, dark biomes) rather than vanishing into it — the stroke is drawn first
// (thick) and the fill on top. See STROKE_WIDTH_FACTOR.
const LABEL_STROKE = 'rgba(255, 255, 255, 0.95)'
const STROKE_WIDTH_FACTOR = 0.15

// Draws one continent's name along a gentle arc centered on its own
// principal axis — the classic "text on a path" technique: measure each
// character, walk them along a circular arc one at a time, rotating each
// to stay tangent to it. Picks the largest font size (within
// [MIN_FONT_SIZE, MAX_FONT_SIZE]) that still fits the plate's own
// measured footprint; skips the label entirely rather than drawing
// something illegible or overflowing if even the size floor doesn't fit.
export function drawContinentLabel(ctx: CanvasRenderingContext2D, placement: ContinentLabelPlacement): void {
  const { name, centerX, centerY, alongExtent, perpExtent } = placement
  // The principal-axis angle from PCA has an arbitrary ± sign, so first reduce it (mod π)
  // into (−π/2, π/2] so the text tilts at most a quarter-turn either way. THEN rotate a
  // further 180°: the map texture is displayed with a net 180° flip (a vertical mirror —
  // same one the volcano cones compensate with +y — combined with the horizontal mirror
  // the scale(−1, 1) below already cancels), so text laid out "upright" in buffer space
  // comes out upside down on screen. See docs / the [[project_worldgen_canvas_flip]] note.
  const readable = ((placement.angle + Math.PI / 2) % Math.PI + Math.PI) % Math.PI - Math.PI / 2
  const angle = readable + Math.PI
  const availableWidth = alongExtent * WIDTH_MARGIN_FACTOR
  const availableHeight = perpExtent * HEIGHT_MARGIN_FACTOR

  let fontSize = Math.min(MAX_FONT_SIZE, availableHeight)
  if (fontSize < MIN_FONT_SIZE) return
  ctx.font = `${fontSize}px ${FONT_FAMILY}`
  let textWidth = ctx.measureText(name).width
  if (textWidth > availableWidth) {
    fontSize *= availableWidth / textWidth
  }
  fontSize = Math.floor(fontSize)
  if (fontSize < MIN_FONT_SIZE) return

  ctx.font = `${fontSize}px ${FONT_FAMILY}`
  textWidth = ctx.measureText(name).width

  const arcRadius = Math.max(textWidth, 1) * CURVE_RADIUS_FACTOR
  const totalAngleSpan = textWidth / arcRadius

  ctx.save()
  ctx.translate(centerX, centerY)
  ctx.rotate(angle)
  // The buffer this canvas draws into ends up mirrored horizontally by
  // the time it reaches the screen (confirmed empirically: rendered
  // labels came out with each glyph individually mirror-flipped and
  // reading right-to-left, not just rotated) — something in the ground
  // mesh's UV mapping or the top-down camera's basis flips U, not a bug
  // in the character layout math itself, which places characters in the
  // correct left-to-right order in buffer space. Terrain never revealed
  // this because a horizontally-mirrored coastline still looks like a
  // perfectly plausible coastline; text is what makes an orientation bug
  // like this actually visible. Compensating here (mirror what we draw,
  // so the display's own mirror cancels it back out) is far less risky
  // than touching the mesh/camera setup, which the boundary lines
  // already depend on looking correct.
  ctx.scale(-1, 1)
  ctx.fillStyle = LABEL_FILL
  ctx.strokeStyle = LABEL_STROKE
  ctx.lineWidth = Math.max(1.5, fontSize * STROKE_WIDTH_FACTOR)
  ctx.lineJoin = 'round'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  let cumulativeWidth = 0
  for (const char of name) {
    const charWidth = ctx.measureText(char).width
    const charCenterOffset = cumulativeWidth + charWidth / 2
    const t = charCenterOffset / textWidth - 0.5
    const charAngle = t * totalAngleSpan
    const px = Math.sin(charAngle) * arcRadius
    const py = arcRadius - Math.cos(charAngle) * arcRadius

    ctx.save()
    ctx.translate(px, py)
    ctx.rotate(charAngle)
    // A gentle white glow under the outline keeps the name legible over varied terrain
    // (white land, dark mountain shade, coloured biomes) without being heavy.
    ctx.shadowColor = 'rgba(255, 255, 255, 0.8)'
    ctx.shadowBlur = Math.max(2, fontSize * 0.2)
    ctx.strokeText(char, 0, 0)
    ctx.shadowBlur = 0
    ctx.shadowColor = 'transparent'
    ctx.strokeText(char, 0, 0)
    ctx.fillText(char, 0, 0)
    ctx.restore()

    cumulativeWidth += charWidth
  }
  ctx.restore()
}

export function drawContinentLabels(ctx: CanvasRenderingContext2D, placements: ContinentLabelPlacement[]): void {
  for (const placement of placements) drawContinentLabel(ctx, placement)
}
