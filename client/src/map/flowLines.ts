// Evenly spaced flow lines over a vector field on the torus, and two ways to
// draw them: wind as tapered strokes ("comets"), ocean currents as broad arrow
// ribbons. Pure drawing: a sampler in, canvas paths out. It does not know
// which field it draws.
//
// Spacing follows Jobard & Lefer (1997): a line grows from a seed, forward and
// back, until it comes closer than `separation × stopRatio` to a line already
// drawn, leaves the field (speed under `minSpeed`) or reaches `maxLength`.
// Seeds sit on a jittered grid, so the lines cover the map evenly instead of
// bunching where the field converges.
//
// A line that comes back to its own start closes into a LOOP — a gyre. Loops
// are drawn as one closed ribbon instead of a row of separate arrows.
//
// Coordinates are UNWRAPPED along a line (x may run past the map width), so a
// line crossing the seam stays one path; draw it through the caller's 3×3
// tile wrap.
import { wrapValue } from '../generator/core/field'

export type VectorSampler = (x: number, y: number) => [number, number]

export interface FlowPoint {
  x: number
  y: number
  // Speed at this point, as a fraction of the field's reference speed (0..1+).
  s: number
}

export interface FlowLine {
  points: FlowPoint[]
  loop: boolean
}

export interface FlowLineOptions {
  width: number
  height: number
  // Distance between neighbouring lines, in pixels.
  separation: number
  // A growing line stops at this fraction of `separation` from another line.
  stopRatio: number
  // Integration step, in pixels.
  step: number
  maxLength: number
  // Speed under which the field counts as calm (the line ends there).
  minSpeed: number
  // The speed that maps to s = 1.
  refSpeed: number
}

// Deterministic jitter, so the same field always draws the same lines.
function hash(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

export function traceFlowLines(sample: VectorSampler, o: FlowLineOptions): FlowLine[] {
  const cell = o.separation
  const gw = Math.max(1, Math.ceil(o.width / cell))
  const gh = Math.max(1, Math.ceil(o.height / cell))
  // Points of the lines already accepted, bucketed by wrapped grid cell.
  const buckets: number[][] = Array.from({ length: gw * gh }, () => [])
  const stopDist = cell * o.stopRatio
  const stopDist2 = stopDist * stopDist

  const bucketOf = (x: number, y: number): number => {
    const bx = Math.floor(wrapValue(x, o.width) / cell) % gw
    const by = Math.floor(wrapValue(y, o.height) / cell) % gh
    return by * gw + bx
  }
  // Torus distance², so a line near the seam sees its neighbour on the far side.
  const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
    let dx = Math.abs(wrapValue(ax, o.width) - wrapValue(bx, o.width))
    let dy = Math.abs(wrapValue(ay, o.height) - wrapValue(by, o.height))
    if (dx > o.width / 2) dx = o.width - dx
    if (dy > o.height / 2) dy = o.height - dy
    return dx * dx + dy * dy
  }
  const crowded = (x: number, y: number): boolean => {
    const bx = Math.floor(wrapValue(x, o.width) / cell)
    const by = Math.floor(wrapValue(y, o.height) / cell)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const b = wrapValue(by + dy, gh) * gw + wrapValue(bx + dx, gw)
        const pts = buckets[b]
        for (let k = 0; k < pts.length; k += 2) {
          if (dist2(x, y, pts[k], pts[k + 1]) < stopDist2) return true
        }
      }
    }
    return false
  }
  const unit = (x: number, y: number): [number, number, number] | null => {
    const [u, v] = sample(x, y)
    const m = Math.hypot(u, v)
    return m < o.minSpeed ? null : [u / m, v / m, m]
  }

  // Midpoint (RK2) steps in one direction; `dir` is +1 forward, −1 back.
  const grow = (x0: number, y0: number, dir: number, startX: number, startY: number): { pts: FlowPoint[]; loop: boolean } => {
    const pts: FlowPoint[] = []
    let x = x0
    let y = y0
    const maxSteps = Math.floor(o.maxLength / o.step)
    for (let i = 0; i < maxSteps; i++) {
      const a = unit(x, y)
      if (!a) break
      const mid = unit(x + a[0] * o.step * 0.5 * dir, y + a[1] * o.step * 0.5 * dir)
      if (!mid) break
      const nx = x + mid[0] * o.step * dir
      const ny = y + mid[1] * o.step * dir
      // Back at the seed after a real round: a closed gyre.
      if (dir > 0 && i * o.step > cell * 3 && dist2(nx, ny, startX, startY) < (o.step * 1.5) ** 2) {
        return { pts, loop: true }
      }
      if (crowded(nx, ny)) break
      x = nx
      y = ny
      pts.push({ x, y, s: mid[2] / o.refSpeed })
    }
    return { pts, loop: false }
  }

  const lines: FlowLine[] = []
  let seedIndex = 0
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const sx = (gx + 0.2 + 0.6 * hash(seedIndex++)) * cell
      const sy = (gy + 0.2 + 0.6 * hash(seedIndex++)) * cell
      if (sx >= o.width || sy >= o.height) continue
      const a = unit(sx, sy)
      if (!a || crowded(sx, sy)) continue
      const fwd = grow(sx, sy, 1, sx, sy)
      const points: FlowPoint[] = [{ x: sx, y: sy, s: a[2] / o.refSpeed }, ...fwd.pts]
      if (!fwd.loop) {
        const back = grow(sx, sy, -1, sx, sy)
        points.unshift(...back.pts.reverse())
      }
      if (points.length < 4) continue
      for (const p of points) buckets[bucketOf(p.x, p.y)].push(p.x, p.y)
      lines.push({ points, loop: fwd.loop })
    }
  }
  return lines
}

// Cut a line into pieces of `length` px with `gap` px between them.
function chunks(points: FlowPoint[], length: number, gap: number, phase: number): FlowPoint[][] {
  const out: FlowPoint[][] = []
  let current: FlowPoint[] = []
  let along = phase % (length + gap)
  for (let i = 0; i < points.length; i++) {
    if (i > 0) along += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    const inChunk = along % (length + gap) < length
    if (inChunk) current.push(points[i])
    else if (current.length > 0) {
      out.push(current)
      current = []
    }
  }
  if (current.length > 0) out.push(current)
  return out
}

// The tile offsets a piece must also be drawn at: the canvas does not wrap,
// and a piece that runs past an edge has to come back in on the far side.
// Only the pieces that cross an edge pay for it, not every line nine times.
function wrapOffsets(pts: FlowPoint[], width: number, height: number, pad: number): Array<[number, number]> {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const p of pts) {
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.y < y0) y0 = p.y
    if (p.y > y1) y1 = p.y
  }
  const out: Array<[number, number]> = []
  for (const oy of [-height, 0, height]) {
    if (y1 + oy + pad < 0 || y0 + oy - pad > height) continue
    for (const ox of [-width, 0, width]) {
      if (x1 + ox + pad < 0 || x0 + ox - pad > width) continue
      out.push([ox, oy])
    }
  }
  return out
}

// Wind: short strokes that taper from a thin, faint tail to a thicker head,
// many along each line, so the field reads as moving air rather than as a
// grid of signs. Faster air draws bolder. Batched into a few paths by
// position along the stroke and by speed — one stroke call per band.
const COMET_BANDS = 6
const COMET_SPEEDS = 3
export function drawComets(c: CanvasRenderingContext2D, lines: FlowLine[], style: {
  width: number
  height: number
  color: [number, number, number]
  length: number
  gap: number
  maxWidth: number
  // Multiplies every stroke's alpha; 1 when unset.
  opacity?: number
}): void {
  const [r, g, b] = style.color
  const opacity = style.opacity ?? 1
  const paths = Array.from({ length: COMET_BANDS * COMET_SPEEDS }, () => new Path2D())
  lines.forEach((line, li) => {
    for (const piece of chunks(line.points, style.length, style.gap, hash(li) * (style.length + style.gap))) {
      if (piece.length < 3) continue
      let mean = 0
      for (const p of piece) mean += p.s
      const sl = Math.min(COMET_SPEEDS - 1, Math.floor((mean / piece.length) * COMET_SPEEDS))
      const n = piece.length - 1
      for (const [ox, oy] of wrapOffsets(piece, style.width, style.height, style.maxWidth)) {
        for (let band = 0; band < COMET_BANDS; band++) {
          const i0 = Math.floor((band / COMET_BANDS) * n)
          const i1 = Math.max(i0 + 1, Math.floor(((band + 1) / COMET_BANDS) * n))
          const path = paths[band * COMET_SPEEDS + sl]
          path.moveTo(piece[i0].x + ox, piece[i0].y + oy)
          for (let i = i0 + 1; i <= Math.min(i1, n); i++) path.lineTo(piece[i].x + ox, piece[i].y + oy)
        }
      }
    }
  })
  c.lineCap = 'round'
  c.lineJoin = 'round'
  for (let band = 0; band < COMET_BANDS; band++) {
    const t = (band + 1) / COMET_BANDS
    for (let sl = 0; sl < COMET_SPEEDS; sl++) {
      const speed = (sl + 1) / COMET_SPEEDS
      c.strokeStyle = `rgba(${r}, ${g}, ${b}, ${opacity * (0.12 + 0.78 * t) * (0.4 + 0.6 * speed)})`
      c.lineWidth = 0.4 + style.maxWidth * t * (0.4 + 0.6 * speed)
      c.stroke(paths[band * COMET_SPEEDS + sl])
    }
  }
}

// Offset a polyline sideways by a per-point half-width: the left edge forward,
// the right edge back, as one closed outline.
function ribbonOutline(path: Path2D, pts: FlowPoint[], halfWidth: (i: number) => number, ox: number, oy: number): void {
  const n = pts.length
  const normal = (i: number): [number, number] => {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const m = Math.hypot(dx, dy) || 1
    return [-dy / m, dx / m]
  }
  for (let i = 0; i < n; i++) {
    const [nx, ny] = normal(i)
    const w = halfWidth(i)
    if (i === 0) path.moveTo(pts[i].x + nx * w + ox, pts[i].y + ny * w + oy)
    else path.lineTo(pts[i].x + nx * w + ox, pts[i].y + ny * w + oy)
  }
  for (let i = n - 1; i >= 0; i--) {
    const [nx, ny] = normal(i)
    const w = halfWidth(i)
    path.lineTo(pts[i].x - nx * w + ox, pts[i].y - ny * w + oy)
  }
  path.closePath()
}

// Currents: broad arrows along the lines — a ribbon that widens from its tail
// and ends in a head. Width follows the speed. An open line becomes a row of
// arrows with gaps; a loop becomes arrows head to tail with no gap, so the
// gyre reads as one continuous circuit. Each arrow takes its class (warm or
// cold, whatever the caller decides) from its middle point.
export function drawArrowRibbons(c: CanvasRenderingContext2D, lines: FlowLine[], style: {
  width: number
  height: number
  length: number
  gap: number
  maxHalfWidth: number
  classify: (p: FlowPoint, dx: number, dy: number) => number
  fills: readonly string[]
  outline: string
}): void {
  const paths = style.fills.map(() => new Path2D())
  const head = style.maxHalfWidth * 2.6
  lines.forEach((line, li) => {
    const pts = line.loop ? [...line.points, line.points[0], line.points[1]] : line.points
    const gap = line.loop ? 0 : style.gap
    for (const piece of chunks(pts, style.length, gap, line.loop ? 0 : hash(li) * (style.length + gap))) {
      if (piece.length < 4) continue
      // Split off the head: the last `head` px of the piece.
      let along = 0
      let cut = piece.length - 1
      while (cut > 1 && along < head) {
        along += Math.hypot(piece[cut].x - piece[cut - 1].x, piece[cut].y - piece[cut - 1].y)
        cut--
      }
      if (cut < 1) continue
      const shaft = piece.slice(0, cut + 1)
      const tip = piece[piece.length - 1]
      const base = piece[cut]
      const mid = piece[Math.floor(piece.length / 2)]
      const path = paths[style.classify(mid, tip.x - piece[0].x, tip.y - piece[0].y)]
      const w = (i: number): number => {
        const t = shaft.length > 1 ? i / (shaft.length - 1) : 1
        // A loop's pieces meet end to end, so they keep full width at the tail.
        const taper = line.loop ? 1 : 0.35 + 0.65 * t
        return style.maxHalfWidth * taper * (0.35 + 0.65 * Math.min(1, shaft[i].s))
      }
      const dx = tip.x - base.x
      const dy = tip.y - base.y
      const m = Math.hypot(dx, dy) || 1
      const hw = w(shaft.length - 1) * 2.1
      for (const [ox, oy] of wrapOffsets(piece, style.width, style.height, head)) {
        ribbonOutline(path, shaft, w, ox, oy)
        // The head: a triangle wider than the shaft.
        path.moveTo(base.x - (dy / m) * hw + ox, base.y + (dx / m) * hw + oy)
        path.lineTo(tip.x + ox, tip.y + oy)
        path.lineTo(base.x + (dy / m) * hw + ox, base.y - (dx / m) * hw + oy)
        path.closePath()
      }
    }
  })
  c.lineJoin = 'round'
  c.lineWidth = 1
  c.strokeStyle = style.outline
  paths.forEach((p, i) => {
    c.fillStyle = style.fills[i]
    c.fill(p, 'nonzero')
    c.stroke(p)
  })
}
