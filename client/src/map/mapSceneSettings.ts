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

// World-Y units per display-elevation unit, METRE-TRUE: 1.0 elevation =
// ELEVATION_METERS of real height, mapped through the map's horizontal scale
// (METERS_PER_CELL per raster cell, MAP_WIDTH cells across MAP_WORLD_WIDTH
// world units). Exaggeration deliberately does NOT live here — it is a
// property of the VIEW (see the constants below), applied as a vertical
// scale on the meshes, so it can change with the zoom without recomputing a
// single height.
export const RELIEF_HEIGHT_SCALE = (ELEVATION_METERS / (METERS_PER_CELL * MAP_WIDTH)) * MAP_WORLD_WIDTH

// Vertical exaggeration per REGISTER. The map register may exaggerate and
// has to: at its ~480 km view width a 6.4 km peak is 2.7 % of the frame —
// about 43 pixels — and reads as a gentle bulge no matter how well the
// terrain is eroded, because that is what a mountain looks like from 480 km
// up. 6x puts it near 130 px, which is the difference between "there is a
// rise here" and "there is a mountain range here". Relief and panorama maps
// routinely use 4-10x for exactly this reason.
//
// Near the ground the same factor would be grotesque (that peak would stand
// 38 km tall), and the world is supposed to be metre-true there — see the
// 1:1 decision in docs/design/hex-world-view.md. So the two registers get
// their own values and the descent interpolates between them: the
// exaggeration fades out exactly where the map becomes a world.
export const MAP_EXAGGERATION = 6
export const NEAR_EXAGGERATION = 1

// The generator's preview shares MAP_EXAGGERATION. It used to run a gentler
// 3x on the grounds that it is a working view rather than a presentation —
// which meant tuning terrain at a vertical scale the map never shows. The
// one-map-two-screens unification (docs/design/hex-world-view.md, decided
// 2026-08-09) removed the difference.

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
export const HEX_COLUMNS = Math.round(WORLD_WIDTH_M / HEX_WIDTH_M)
export const HEX_ROWS = 2 * Math.round(WORLD_HEIGHT_M / (HEX_WIDTH_M * (Math.sqrt(3) / 2)) / 2)
export const HEX_COL_SPACING = MAP_WORLD_WIDTH / HEX_COLUMNS
export const HEX_ROW_SPACING = MAP_WORLD_HEIGHT / HEX_ROWS

// The map/relief texture's resolution, fixed for the session so the map view
// never has to be rebuilt when a bake stage lands. 4096x2048 is the
// recommendation from the decision doc's texture question: it matches the
// first bake stage exactly, sharpens the flat map over the 2048 source, and
// costs ~34 MB per texture (the 8k alternative is 134 MB each, for detail
// the relief meshes already carry as geometry).
export const PAPER_TEXTURE_WIDTH = 4096
export const PAPER_TEXTURE_HEIGHT = 2048

// Altitude band (world units) over which the grid fades in during the near
// descent: invisible above ~40 km (hexes would be subpixel moiré), fully
// drawn below ~16 km (a hex is ≥ ~10 px there).
export const HEXGRID_FADE_HIGH_ALTITUDE = 0.05
export const HEXGRID_FADE_LOW_ALTITUDE = 0.02
