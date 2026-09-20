import { wrapValue } from './field'
// Shortest signed offset from b to a on a line of the given period that
// wraps — e.g. on a period of 100, the offset from 95 to 5 is +10 (via
// the wrap), not -90 (the direct route). round(), not floor()/ceil(), is
// what picks the wrapped path specifically when it's shorter than the
// direct one.
export function wrappedDelta(a: number, b: number, period: number): number {
  let delta = a - b
  delta -= period * Math.round(delta / period)
  return delta
}

// Squared distance between two points on a torus of the given
// width/height — the minimum-image-convention distance used throughout
// this world's generation (seed spacing, nearest-seed rasterization) so
// every distance check agrees on what "near" means across the wrap.
export function toroidalDistanceSq(ax: number, ay: number, bx: number, by: number, width: number, height: number): number {
  const dx = wrappedDelta(ax, bx, width)
  const dy = wrappedDelta(ay, by, height)
  return dx * dx + dy * dy
}

// Rotates (x, y) by `angle` radians about (centerX, centerY), staying
// correct on a torus by working in the center's own locally-unwrapped
// frame (a flat torus does not admit an arbitrary rotation as a *global*
// isometry — it would contradict itself at the wrap seam — but rotating
// one bounded neighborhood around its own nearby local center is
// perfectly well-posed) and re-wrapping the result back into
// [0, width) x [0, height) afterward. Used for both plate seeds and their
// attached terrain features, so both move together under the same
// per-plate rotation.
export function rotateAroundCenter(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  angle: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const rx = wrappedDelta(x, centerX, width)
  const ry = wrappedDelta(y, centerY, height)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const rotatedX = rx * cos - ry * sin
  const rotatedY = rx * sin + ry * cos
  return {
    x: wrapValue((centerX + rotatedX), width),
    y: wrapValue((centerY + rotatedY), height),
  }
}
