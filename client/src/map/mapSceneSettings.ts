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

// The generator's own relief preview is a map register throughout (it never
// descends), but a gentler one — it is a working view over a world being
// tuned, not a presentation of a finished one.
export const WORLDGEN_EXAGGERATION = 3

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

// The worldmap's amplification bake runs in STAGES, coarse first (see
// docs/decisions/worldmap-amplification.md): each factor is baked in turn
// and swapped in when it lands, so a usable amplified world arrives early
// and sharpens later instead of the screen waiting for the deepest tier.
//
// Measured 2026-08-07 (2 erosion rounds, full chain incl. hydrology):
//   factor 2 → 4096x2048, ~102 s,  ~0.2 GB peak
//   factor 4 → 8192x4096, ~444 s,  ~3 GB peak
//
// The 8k tier is the decided target (docs/decisions/worldmap-amplification.md)
// but is NOT shipped yet: tried in Safari the same day, it exhausted the tab's
// memory and the browser reloaded the page. Note what that means for the
// screen's own safety net — a stage that takes the whole tab down cannot be
// caught by `worker.onerror`, so "degrade to the last good result" does not
// cover this failure mode at all.
//
// 8k therefore waits on the memory work rather than on a flag: see
// docs/design/amplification-artifacts.md (memory audit first, then basin
// decomposition with per-basin workers). Re-adding 4 here before that lands
// just reproduces the crash.
// SPLIT 2026-08-08, when the server learned to bake. One number was answering
// two questions with very different costs:
//
//   BAKE   producing a stage costs ~2.6 GB at 8192² — the tab death above.
//   FETCH  finding one already baked costs a download and a downsample.
//
// So the client bakes only what it can survive baking, and DISPLAYS whatever a
// server has already made. A stage it may fetch but not bake simply does not
// appear when the server has nothing — the crash path stays closed, because
// nothing falls back to baking it.
export const AMPLIFY_BAKE_STAGES = [2]

// The display ceiling, and it is a memory argument rather than a taste one.
// Holding one amplified raster costs width × height × 4 bytes as Float32:
//
//   factor 2   4096×2048     33 MB
//   factor 4   8192×4096    134 MB
//   factor 8  16384×8192    537 MB
//
// 134 MB is a raster a tab can hold beside a map it is already showing; 537 MB
// is asking for the same failure by a different route. Raising this to 8 wants
// an actual measurement of a 16k DISPLAY first — and nothing bakes 16k today,
// so it would only buy a failed request per world load.
export const AMPLIFY_FETCH_STAGES = [2, 4]

// The map/relief texture's resolution, fixed for the session so the map view
// never has to be rebuilt when a bake stage lands. 4096x2048 is the
// recommendation from the decision doc's texture question: it matches the
// first bake stage exactly, sharpens the flat map over the 2048 source, and
// costs ~34 MB per texture (the 8k alternative is 134 MB each, for detail
// the relief meshes already carry as geometry).
export const PAPER_TEXTURE_WIDTH = 4096
export const PAPER_TEXTURE_HEIGHT = 2048

// Erosion rounds the bake runs on the amplified field — the decision doc's
// open "pass budget", now measured (2026-08-07, synthetic world, mean local
// relief on land above 1 km): seeded 162 m → 197 m after ONE round, 202 /
// 204 / 206 m after 2 / 3 / 5. The first round delivers ~80 % of the gain;
// everything after is diminishing returns at a linear ~50 s per round at
// 4096². Two rounds keeps the valley-widening the second round exists for
// (thermal acting on banks the first round steepened) without paying for
// the flat part of the curve. The goal is visible tributary structure, not
// equilibrium.
export const AMPLIFY_EROSION_ROUNDS = 2

// Altitude band (world units) over which the grid fades in during the near
// descent: invisible above ~40 km (hexes would be subpixel moiré), fully
// drawn below ~16 km (a hex is ≥ ~10 px there).
export const HEXGRID_FADE_HIGH_ALTITUDE = 0.05
export const HEXGRID_FADE_LOW_ALTITUDE = 0.02
