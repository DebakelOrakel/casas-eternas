import { ELEVATION_METERS } from '../worldgen/elevation/elevationScale'
import { MAP_HEIGHT, MAP_WIDTH, METERS_PER_CELL } from '../worldgen/core/mapConfig'

// Shared scene scale + relief-preview settings for the flat map screens
// (worldgen, worldmap). One module on purpose: both screens render the same
// world through the same ToroidalMapView machinery, and these numbers ARE
// the shared look — a screen with its own copy would drift the moment
// someone tunes one of them.

// One toroidal period of the map, in Babylon world units.
export const MAP_WORLD_WIDTH = 20
export const MAP_WORLD_HEIGHT = 10

// World-Y units per display-elevation unit: 1.0 elevation = ELEVATION_METERS
// of real height, mapped through the map's horizontal scale (METERS_PER_CELL
// per raster cell, MAP_WIDTH cells across MAP_WORLD_WIDTH world units) —
// times a mild exaggeration. Eyeballed 2026-08-07: at these screens'
// 500–1500 km view widths, metre-true relief is a few pixels tall and simply
// doesn't register. The GAME's near-ground view keeps the 1:1 decision (see
// docs/design/hex-world-view.md); these previews are a map register, and
// maps exaggerate.
export const RELIEF_EXAGGERATION = 2
export const RELIEF_HEIGHT_SCALE = (ELEVATION_METERS / (METERS_PER_CELL * MAP_WIDTH)) * MAP_WORLD_WIDTH * RELIEF_EXAGGERATION

// Decimation of the full-res elevation raster into the canonical coarse
// preview surface — one coarse-relief-mesh vertex per decimated cell, so
// this must stay in step with ToroidalMapView's COARSE_SUBDIVISIONS.
export const RELIEF_DECIMATION = 2

// Eased zoom beyond which the displaced relief replaces the flat plane —
// below it the displacement is subpixel while its triangles are at their
// most multiplied (many wrap copies in frame). Zoom is exponential in t
// (see worldgenCamera): 0.14 ≈ 14 world units of visible width, 0.31 ≈ 7.5.
export const RELIEF_MIN_ZOOM = 0.14
// Eased zoom beyond which the FULL-res relief level takes over from the
// half-res one (silhouettes at raster sharpness). Deep enough that the
// frustum holds at most a wrap copy or two of its ~4M triangles.
export const RELIEF_FINE_ZOOM = 0.31

// Scene units per real metre (the horizontal scale the relief height scale
// above is built on) — for expressing real-world lengths in scene units.
export const UNITS_PER_METER = MAP_WORLD_WIDTH / (METERS_PER_CELL * MAP_WIDTH)

// The near regime's (worldmap perspective descent) deepest camera altitude.
// ~2.5 km real: view width ends up a handful of km — the scale where the
// 300 m hex grid (docs/design/hex-world-view.md) will be comfortably
// readable once it exists.
export const NEAR_MIN_ALTITUDE = 2500 * UNITS_PER_METER

// --- The 300 m hex grid (docs/design/hex-world-view.md: one hex ≈ one
// Hufe). Pointy-top: flat-to-flat runs HORIZONTALLY, so the column spacing
// is the decided 300 m and the row spacing is the hex geometry's
// √3/2 · width. Both spacings are then SNAPPED so an integer number of
// columns / an EVEN number of rows (the pattern repeats every two rows)
// tiles one toroidal period exactly — otherwise the grid would seam at the
// wrap. The snap distorts the hexes by ~0.003%: invisible.
const HEX_WIDTH_M = 300
const WORLD_WIDTH_M = METERS_PER_CELL * MAP_WIDTH
const WORLD_HEIGHT_M = METERS_PER_CELL * MAP_HEIGHT
const HEX_COLUMNS = Math.round(WORLD_WIDTH_M / HEX_WIDTH_M)
const HEX_ROWS = 2 * Math.round(WORLD_HEIGHT_M / (HEX_WIDTH_M * (Math.sqrt(3) / 2)) / 2)
export const HEX_COL_SPACING = MAP_WORLD_WIDTH / HEX_COLUMNS
export const HEX_ROW_SPACING = MAP_WORLD_HEIGHT / HEX_ROWS

// Linear refinement of the worldmap's amplification bake (see
// docs/decisions/worldmap-amplification.md): 2 → 4096x2048 (~3.9 km/cell),
// 4 → 8192x4096 (~1.95 km/cell, the decided target). Phase 1 ships at 2
// deliberately — the plumbing is verified at a quarter of the memory and
// time before the target resolution is switched on in phase 4.
export const AMPLIFY_FACTOR = 2

// Altitude band (world units) over which the grid fades in during the near
// descent: invisible above ~40 km (hexes would be subpixel moiré), fully
// drawn below ~16 km (a hex is ≥ ~10 px there).
export const HEXGRID_FADE_HIGH_ALTITUDE = 0.05
export const HEXGRID_FADE_LOW_ALTITUDE = 0.02
