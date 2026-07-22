type Rgb = [number, number, number]

const ARROW_COLOR: Rgb = [15, 15, 15]
const ARROW_THICKNESS_PX = 2
const ARROWHEAD_LENGTH_PX = 12
const ARROWHEAD_ANGLE_RAD = (25 * Math.PI) / 180

function plotPixel(buffer: Uint8Array, width: number, height: number, x: number, y: number, color: Rgb, thickness: number): void {
  const half = Math.floor(thickness / 2)
  for (let oy = -half; oy <= half; oy++) {
    for (let ox = -half; ox <= half; ox++) {
      // Wrapped indexing (not clamped) — an arrow whose seed sits near an
      // edge can dip across the map's own wraparound seam, same as
      // anything else on this map.
      const wrappedX = (((x + ox) % width) + width) % width
      const wrappedY = (((y + oy) % height) + height) % height
      const index = (wrappedY * width + wrappedX) * 4
      buffer[index] = color[0]
      buffer[index + 1] = color[1]
      buffer[index + 2] = color[2]
      buffer[index + 3] = 255
    }
  }
}

function plotLine(buffer: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, color: Rgb, thickness: number): void {
  const dx = x1 - x0
  const dy = y1 - y0
  const length = Math.sqrt(dx * dx + dy * dy)
  const steps = Math.max(1, Math.ceil(length))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    plotPixel(buffer, width, height, Math.round(x0 + dx * t), Math.round(y0 + dy * t), color, thickness)
  }
}

// Draws a velocity arrow (shaft + two-line arrowhead) from each seed
// point, directly into an already-rendered RGBA map buffer — on top of
// plate colors/boundaries, not a separate overlay, so it can never end up
// misaligned with the cells it's pointing out of.
export function drawPlateArrows(
  buffer: Uint8Array,
  width: number,
  height: number,
  seeds: { x: number; y: number }[],
  velocities: { vx: number; vy: number }[],
): void {
  for (let i = 0; i < seeds.length; i++) {
    const { x, y } = seeds[i]
    const { vx, vy } = velocities[i]
    const endX = x + vx
    const endY = y + vy
    plotLine(buffer, width, height, x, y, endX, endY, ARROW_COLOR, ARROW_THICKNESS_PX)

    const angle = Math.atan2(vy, vx)
    for (const wingSign of [-1, 1]) {
      const wingAngle = angle + Math.PI + wingSign * ARROWHEAD_ANGLE_RAD
      const wingX = endX + Math.cos(wingAngle) * ARROWHEAD_LENGTH_PX
      const wingY = endY + Math.sin(wingAngle) * ARROWHEAD_LENGTH_PX
      plotLine(buffer, width, height, endX, endY, wingX, wingY, ARROW_COLOR, ARROW_THICKNESS_PX)
    }
  }
}
