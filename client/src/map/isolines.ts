// Isolines of a scalar field on a grid that wraps in both axes (marching
// squares). The first user is the pressure layer's isobars.
//
// A square joins four cell centres, (x + 0.5, y + 0.5) to the next ones, and
// the last column and row join the first ones across the seam. So a segment
// can reach up to one cell past the right or bottom edge; drawIsolines draws
// the path again one map-width and one map-height back, which puts that part
// on the other side.

// The segments of one level: [x0, y0, x1, y1, …] in grid units.
export interface Isoline {
  level: number
  segments: Float32Array
}

export function traceIsolines(field: Float32Array, resX: number, resY: number, levels: readonly number[]): Isoline[] {
  const out: Isoline[] = []
  for (const level of levels) {
    const seg: number[] = []
    for (let y = 0; y < resY; y++) {
      const y1 = (y + 1) % resY
      for (let x = 0; x < resX; x++) {
        const x1 = (x + 1) % resX
        // Corners clockwise from the top left: a b / d c.
        const a = field[y * resX + x]
        const b = field[y * resX + x1]
        const c = field[y1 * resX + x1]
        const d = field[y1 * resX + x]
        const code = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0)
        if (code === 0 || code === 15) continue
        const cx = x + 0.5
        const cy = y + 0.5
        // The crossing on each edge, by linear interpolation.
        const top = (): [number, number] => [cx + (level - a) / (b - a), cy]
        const right = (): [number, number] => [cx + 1, cy + (level - b) / (c - b)]
        const bottom = (): [number, number] => [cx + (level - d) / (c - d), cy + 1]
        const left = (): [number, number] => [cx, cy + (level - a) / (d - a)]
        const push = (p: [number, number], q: [number, number]): void => { seg.push(p[0], p[1], q[0], q[1]) }
        // The saddles (5, 10) are split by the square's mean.
        const high = (a + b + c + d) / 4 > level
        switch (code) {
          case 1: case 14: push(left(), bottom()); break
          case 2: case 13: push(bottom(), right()); break
          case 3: case 12: push(left(), right()); break
          case 4: case 11: push(top(), right()); break
          case 6: case 9: push(top(), bottom()); break
          case 7: case 8: push(left(), top()); break
          case 5:
            if (high) { push(left(), top()); push(bottom(), right()) } else { push(left(), bottom()); push(top(), right()) }
            break
          case 10:
            if (high) { push(left(), bottom()); push(top(), right()) } else { push(left(), top()); push(bottom(), right()) }
            break
        }
      }
    }
    out.push({ level, segments: Float32Array.from(seg) })
  }
  return out
}

// Strokes the segments scaled from the grid to the map, with the style the
// caller has set on `c`; `emphasis` picks the levels that get `emphasisWidth`.
export function drawIsolines(c: CanvasRenderingContext2D, lines: readonly Isoline[], o: {
  resX: number
  resY: number
  width: number
  height: number
  lineWidth: number
  emphasis?: (level: number) => boolean
  emphasisWidth?: number
}): void {
  const sx = o.width / o.resX
  const sy = o.height / o.resY
  for (const line of lines) {
    const path = new Path2D()
    const s = line.segments
    for (let i = 0; i < s.length; i += 4) {
      path.moveTo(s[i] * sx, s[i + 1] * sy)
      path.lineTo(s[i + 2] * sx, s[i + 3] * sy)
    }
    c.lineWidth = o.emphasis?.(line.level) ? (o.emphasisWidth ?? o.lineWidth) : o.lineWidth
    for (const [dx, dy] of [[0, 0], [-o.width, 0], [0, -o.height], [-o.width, -o.height]]) {
      c.save()
      c.translate(dx, dy)
      c.stroke(path)
      c.restore()
    }
  }
}
