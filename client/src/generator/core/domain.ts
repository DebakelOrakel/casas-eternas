// THE DOMAIN (decision 11 of docs/decisions/adaptive-mesh.md, born with the
// Planet stage): the world's topology behind one interface — what a point
// set is periodic in and what "latitude" means there. The torus is a
// declared mapping: the horizontal midline is the equator, the glued
// top/bottom seam the pole, both hemispheres mirror-symmetric; a sphere is
// a second domain with real latitude (docs/design/two-topologies.md). The
// planetary forcing acts on latitude(p) either way.
//
// Only the latitude is served today: the neighbour search, the distance
// and the periodicity of the mesh (phase 4) join here when the mesh does.
export interface Domain {
  readonly kind: 'torus'
  readonly width: number
  readonly height: number
  // Latitude 0..1 of a normalised row position y in 0..1: 0 at the equator,
  // 1 at the pole.
  latitude(yNorm: number): number
  // Which hemisphere a row lies in: true for the top ("north").
  north(yNorm: number): boolean
}

// The torus, with the thermal equator slid by `equatorOffset` (fraction of
// the height, positive toward the bottom) — the climate's one "move the
// equator" knob, applied once here.
export function torusDomain(width: number, height: number, equatorOffset = 0): Domain {
  const shifted = (yNorm: number): number => {
    const y = yNorm - equatorOffset
    return y - Math.floor(y)
  }
  return {
    kind: 'torus',
    width,
    height,
    latitude: (yNorm) => Math.abs(shifted(yNorm) - 0.5) * 2,
    north: (yNorm) => shifted(yNorm) < 0.5,
  }
}
