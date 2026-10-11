// Shared between whatever generates the map raster and whatever displays
// it, so the two can't drift out of sync — same rationale as
// worldgen-sphere/textureConfig.ts, independently written for this map.
export const MAP_WIDTH = 2048
export const MAP_HEIGHT = 1024

// The map's HORIZONTAL scale, per shape — the counterpart to elevationScale's
// vertical one. Both shapes keep the 2048 × 1024 raster; what a cell measures
// is the shape's (DEC-0035 fork 6, docs/decisions/two-shapes.md), and the
// generator reads it from the Domain (`domain.metresPerUnit`,
// `domain.metresAround`), never from here: `make lint` refuses these two
// names outside core/ and the few places that mean the torus's own scale.
//
// The torus: about a quarter of Earth's surface area (~127.5 Mkm²) spread
// over the grid above, which puts one cell at 7.8 km on a side — 15 974 km
// around. This number was already load-bearing — elevationField sizes
// mountain ranges against it, and the worldgen resolution decisions are
// argued in terms of it. Anything that converts between a real-world
// gradient and this grid's rise-over-run needs BOTH this and
// ELEVATION_METERS; see elevationScale.slopeFromAngle.
export const TORUS_METERS_PER_CELL = 7800

// The sphere: 20 000 km round the equator (R = 3 183 km), so 9 765.625 m per
// cell at the equator and 1.273e8 km² — 99.5 % of the torus's area. With the
// torus's cell the sphere had 16 000 km and 64 % of the area (fork 6).
export const SPHERE_EQUATOR_METERS = 20_000_000
