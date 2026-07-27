// Shared between whatever generates the map raster and whatever displays
// it, so the two can't drift out of sync — same rationale as
// worldgen-sphere/textureConfig.ts, independently written for this map.
export const MAP_WIDTH = 2048
export const MAP_HEIGHT = 1024

// The map's HORIZONTAL scale, the counterpart to elevationScale's vertical one.
// The world is about a quarter of Earth's surface area (~127.5 Mkm²) spread over
// the grid above, which puts one cell at ~7.8 km on a side.
//
// This number was already load-bearing — elevationField sizes mountain ranges
// against it, and the worldgen resolution decisions are argued in terms of it —
// but it only existed inside comments, so anything needing it had to re-derive it
// by hand. Anything that converts between a real-world gradient and this grid's
// rise-over-run needs BOTH this and ELEVATION_METERS; see
// elevationScale.slopeFromAngle.
export const METERS_PER_CELL = 7800
