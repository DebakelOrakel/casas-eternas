import { wrapValue } from './field'
import { wrappedDelta } from './toroidal'

// THE DOMAIN (decision 11 of docs/decisions/adaptive-mesh.md, born with the
// Planet stage): the world's topology behind one interface — what a point
// set is periodic in, how far two points are apart, and what "latitude"
// means there. The torus is a declared mapping: the horizontal midline is
// the equator, the glued top/bottom seam the pole, both hemispheres
// mirror-symmetric; a sphere is a second domain with real latitude
// (docs/design/two-topologies.md). The planetary forcing acts on
// latitude(p) either way.
//
// The mesh (phase 4) reads only `delta*`, `wrap*` and `distanceSq`: every
// triangle is unwrapped into the frame of one of its own corners through
// `deltaX`/`deltaY`, so the triangulation code never sees a period. That is
// what makes the sphere a second implementation of THIS interface rather
// than a second triangulation. The neighbour search over a point set lives
// beside the mesh (`mesh/pointBuckets.ts`) because it needs the domain's
// extent, not its topology.
export interface Domain {
  readonly kind: 'torus'
  readonly width: number
  readonly height: number
  // Latitude 0..1 of a normalised row position y in 0..1: 0 at the equator,
  // 1 at the pole.
  latitude(yNorm: number): number
  // Which hemisphere a row lies in: true for the top ("north").
  north(yNorm: number): boolean
  // Shortest signed offset from b to a along each axis (the minimum-image
  // convention of core/toroidal.ts): `bx + deltaX(ax, bx)` is a's image
  // nearest to b.
  deltaX(ax: number, bx: number): number
  deltaY(ay: number, by: number): number
  // A coordinate brought back into [0, width) × [0, height).
  wrapX(x: number): number
  wrapY(y: number): number
  distanceSq(ax: number, ay: number, bx: number, by: number): number
}

// The torus, with the thermal equator slid by `equatorOffset` (fraction of
// the height, positive toward the bottom) — the climate's one "move the
// equator" knob, applied once here.
export function torusDomain(width: number, height: number, equatorOffset = 0): Domain {
  const shifted = (yNorm: number): number => {
    const y = yNorm - equatorOffset
    return y - Math.floor(y)
  }
  const deltaX = (ax: number, bx: number): number => wrappedDelta(ax, bx, width)
  const deltaY = (ay: number, by: number): number => wrappedDelta(ay, by, height)
  return {
    kind: 'torus',
    width,
    height,
    latitude: (yNorm) => Math.abs(shifted(yNorm) - 0.5) * 2,
    north: (yNorm) => shifted(yNorm) < 0.5,
    deltaX,
    deltaY,
    wrapX: (x) => wrapValue(x, width),
    wrapY: (y) => wrapValue(y, height),
    distanceSq: (ax, ay, bx, by) => {
      const dx = deltaX(ax, bx)
      const dy = deltaY(ay, by)
      return dx * dx + dy * dy
    },
  }
}
