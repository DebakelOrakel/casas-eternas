import type { PeopleResult } from './people'

// THE INCUBATOR'S PEOPLE ARROWS (2026-10-25, a trial): the people's spread
// drawn as its rough directions (IncubatorScreen's people step).

// THE ARROWS: the routes' tree (people.ts, `from` and `flow`) as a
// few broad arrows of the spread's direction. A branch is a way at least
// ARROW_SHARE of all the land reached went through; where two such ways
// part, an arrow ends and two begin. Each is sampled every
// ARROW_STEP_CELLS cells and smoothed, and one shorter than
// ARROW_MIN_CELLS is left out. Its shaft is ARROW_MIN_TEXELS to
// ARROW_MAX_TEXELS wide (texels of the incubator's overlay, half the
// chart's), with the square root of its share; its head ARROW_HEAD times
// that.
const ARROW_SHARE = 0.02
const ARROW_STEP_CELLS = 25
const ARROW_MIN_CELLS = 30
const ARROW_MIN_TEXELS = 4
const ARROW_MAX_TEXELS = 17
const ARROW_HEAD = 2.4

export interface PeopleArrow {
  // In the overlay's texels, unwrapped along the arrow; with the arrival
  // there.
  points: { x: number; y: number; at: number }[]
  width: number
}

// `u`, `v`: the cells' centres on the chart, as fractions; `W` × `H` the
// overlay's texels.
export function arrowsOf(people: PeopleResult, u: Float32Array, v: Float32Array, W: number, H: number): PeopleArrow[] {
  const { from, flow, arrival, origin } = people
  if (origin < 0) return []
  const total = flow[origin]
  const least = Math.max(1, ARROW_SHARE * total)
  // The big ways' children of each cell.
  const children = new Map<number, number[]>()
  for (let c = 0; c < from.length; c++) {
    if (from[c] < 0 || flow[c] < least) continue
    const list = children.get(from[c])
    if (list) list.push(c)
    else children.set(from[c], [c])
  }
  const arrows: PeopleArrow[] = []
  // A branch from `start` (its first cell after `root`) down to its end
  // or its parting; the parting's branches follow.
  const stack: [number, number][] = (children.get(origin) ?? []).map((c) => [origin, c])
  while (stack.length > 0) {
    const [root, start] = stack.pop()!
    const cells = [root, start]
    let c = start
    for (;;) {
      const next = children.get(c) ?? []
      if (next.length !== 1) {
        for (const k of next) stack.push([c, k])
        break
      }
      c = next[0]
      cells.push(c)
    }
    if (cells.length < ARROW_MIN_CELLS) continue
    // Sampled, unwrapped, smoothed over three samples.
    const raw: { x: number; y: number; at: number }[] = []
    for (let k = 0; k < cells.length; k += ARROW_STEP_CELLS) raw.push(pointOf(cells[k]))
    if ((cells.length - 1) % ARROW_STEP_CELLS !== 0) raw.push(pointOf(cells[cells.length - 1]))
    for (let k = 1; k < raw.length; k++) {
      if (raw[k].x - raw[k - 1].x > W / 2) raw[k].x -= W
      else if (raw[k - 1].x - raw[k].x > W / 2) raw[k].x += W
    }
    const points = raw.map((p, k) => (k === 0 || k === raw.length - 1 ? p : {
      x: (raw[k - 1].x + 2 * p.x + raw[k + 1].x) / 4,
      y: (raw[k - 1].y + 2 * p.y + raw[k + 1].y) / 4,
      at: p.at,
    }))
    arrows.push({ points, width: ARROW_MIN_TEXELS + (ARROW_MAX_TEXELS - ARROW_MIN_TEXELS) * Math.sqrt(Math.min(1, flow[start] / total)) })
  }
  // The thin first, so the broad lie on top.
  return arrows.sort((a, b) => a.width - b.width)

  function pointOf(cell: number): { x: number; y: number; at: number } {
    return { x: u[cell] * W, y: v[cell] * H, at: arrival[cell] }
  }
}

// The arrows as far as the people came by `t`, onto a W × H raster, each
// texel through `plot` once an arrow: the shaft as a run of discs, the
// head a triangle past its last point.
export function drawArrows(plot: (x: number, y: number) => void, arrows: readonly PeopleArrow[], t: number, W: number, H: number): void {
  for (const arrow of arrows) {
    const shown = arrow.points.filter((p) => p.at <= t)
    if (shown.length < 2) continue
    const r = arrow.width / 2
    const head = arrow.width * ARROW_HEAD
    // The shaft stops short of the tip, where the head begins.
    const last = shown[shown.length - 1]
    const prev = shown[shown.length - 2]
    const dirX = last.x - prev.x
    const dirY = last.y - prev.y
    const len = Math.hypot(dirX, dirY) || 1
    const ux = dirX / len
    const uy = dirY / len
    const baseX = last.x - ux * Math.min(len, head)
    const baseY = last.y - uy * Math.min(len, head)
    const shaft = [...shown.slice(0, -1), { x: baseX, y: baseY, at: last.at }]
    // Each texel once: the shaft's texels are marked, then blended.
    const seen = new Set<number>()
    const mark = (x: number, y: number): void => {
      const key = y * W + (((x % W) + W) % W)
      if (y < 0 || y >= H || seen.has(key)) return
      seen.add(key)
      plot(((x % W) + W) % W, y)
    }
    for (let k = 1; k < shaft.length; k++) {
      const a = shaft[k - 1]
      const b = shaft[k]
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, r / 2)))
      for (let s = 0; s <= steps; s++) {
        const px = a.x + ((b.x - a.x) * s) / steps
        const py = a.y + ((b.y - a.y) * s) / steps
        for (let dy = Math.floor(-r); dy <= Math.ceil(r); dy++) {
          for (let dx = Math.floor(-r); dx <= Math.ceil(r); dx++) if (dx * dx + dy * dy <= r * r) mark(Math.round(px + dx), Math.round(py + dy))
        }
      }
    }
    // The head: the tip at the last point, the base `head` behind it,
    // `head` wide.
    const hw = head / 2
    const ax = last.x
    const ay = last.y
    const bx = baseX - uy * hw
    const by = baseY + ux * hw
    const qx = baseX + uy * hw
    const qy = baseY - ux * hw
    const minX = Math.floor(Math.min(ax, bx, qx))
    const maxX = Math.ceil(Math.max(ax, bx, qx))
    const minY = Math.floor(Math.min(ay, by, qy))
    const maxY = Math.ceil(Math.max(ay, by, qy))
    const side = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): number => (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const s1 = side(ax, ay, bx, by, x, y)
        const s2 = side(bx, by, qx, qy, x, y)
        const s3 = side(qx, qy, ax, ay, x, y)
        if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) mark(x, y)
      }
    }
  }
}
