// Evenly spaced flow lines over a vector field on the torus, and the pieces
// they are cut into: one mark per piece (map/vectorMarks.ts) — wind as
// tapered strokes ("comets"), ocean currents as broad arrows. Pure
// arithmetic: a sampler in, points out. It does not know which field it
// traces.
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
// line crossing the seam stays one path; the caller wraps the points it
// uses.
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

// The pieces of every line, each with the index of its line: `length` px
// with `gap` px between them, the first piece at a phase of its own per line
// (hash of the line's index), so the pieces of neighbouring lines do not
// stand in rows. `closeLoops`: a loop (a gyre) is cut as a closed circuit,
// head to tail with no gap and from its start; otherwise it is cut as an
// open line. The wind strokes and the current arrows were cut this way
// when they were painted into the map texture (until 2026-10-11).
export function flowLinePieces(lines: FlowLine[], length: number, gap: number, closeLoops: boolean): { line: number; points: FlowPoint[] }[] {
  const out: { line: number; points: FlowPoint[] }[] = []
  lines.forEach((line, li) => {
    const closed = closeLoops && line.loop
    const pts = closed ? [...line.points, line.points[0], line.points[1]] : line.points
    const g = closed ? 0 : gap
    for (const points of chunks(pts, length, g, closed ? 0 : hash(li) * (length + g))) out.push({ line: li, points })
  })
  return out
}
