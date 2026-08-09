// The world's elevation scale, anchored in real metres — the single place that
// says what a height value MEANS. Everything else in the pipeline reads its
// reference heights from here instead of carrying its own private idea of the
// scale.
//
// Elevation is a signed -1..1 field with 0 = sea level. The signed zero is the
// point of the convention: every land/ocean test is a sign test, with no magic
// threshold to keep in sync across the eight modules that make one. That part
// was always sound and doesn't change.
//
// What DID need fixing is what the numbers on that scale mean. The land half
// used to be calibrated by eye against "make continents read as clearly higher
// than ocean" — RAFT_CONTINENTAL_BASELINE sat at 0.35 while the ocean floor sat
// at -0.45 or below. Nothing said how many metres either was, so the two halves
// drifted into meaning different things, and climate/temperature.ts ended up
// carrying a LAND_LAPSE_REF = 0.35 constant whose entire job was to undo the
// land baseline again, because physically that plateau was supposed to BE
// lowland at sea-level temperature, not 1.9 km of Tibet. Two conventions in one
// field, with one module quietly translating between them.
//
// An explicit metre anchor removes the ambiguity: a height is a height, the
// reference points below are checkable against the real Earth, and the
// translation hack disappears.
import { METERS_PER_CELL } from '../core/mapConfig'
import { smoothstep } from '../core/interpolation'

export const ELEVATION_METERS = 9000

export const metersToElevation = (m: number): number => m / ELEVATION_METERS
export const elevationToMeters = (e: number): number => e * ELEVATION_METERS

// Sea level. Lives here rather than in erosion.ts (where it originally landed
// because the flood fill was the first thing that needed it) — it's a property
// of the scale, not of the erosion model.
export const SEA_LEVEL = 0

// IS THIS CELL LAND — the one definition, next to the datum it tests against.
//
// It was written out six times across the climate producers, in two polarities
// (`e <= SEA_LEVEL && !dry` for ocean, `e > SEA_LEVEL || dry` for land), which is
// exactly how a definition drifts: the copies agreed, but nothing made them.
//
// The `dryLand` term is what makes it more than a sign test. A terminal basin
// whose floor lies below sea level but holds no water IS land — the Caspian
// problem — and every field that skips ocean must skip it the same way, or the
// biome map and the ecology mask disagree about the same cell.
export function isLandAt(elevation: number, dryLand = false): boolean {
  return elevation > SEA_LEVEL || dryLand
}

// Why 9000 m and not, say, 6000: the field is clamped to ±1, so the anchor sets
// what fits. At 9000 m Everest (8848 m) lands at 0.98 — the clamp is spent
// almost exactly on the tallest thing that can exist, wasting no range and
// clipping nothing. At 6000 m every peak above 6 km would flatten into the
// clamp, which is the failure mode this whole recalibration exists to remove.
// Trenches are the one thing that still overflows (the Marianas would want
// -1.22); they're narrow and rare enough that clipping them is an acceptable
// trade for keeping the far more common land relief exact.
//
// The reference heights the rest of the pipeline builds on. Earth values, so
// they can be checked rather than argued about:
//   - LAND_BASE is modal lowland, not mean land elevation (840 m). Continental
//     crust with no tectonic uplift on it should read as a coastal plain; mean
//     land elevation already includes the mountains that uplift adds on top.
//   - RIDGE_CREST / ABYSSAL_FLOOR bracket the ocean floor's age-depth curve
//     (see elevationField.ts): fresh crust at a spreading ridge, and the depth
//     old crust asymptotes to once it has finished subsiding.
//   - SHELF_BREAK / SLOPE_FOOT shape the continental margin (see marginProfile
//     below), and are the reason a coastline no longer sits on a cliff.
export const LAND_BASE = metersToElevation(360) // +0.040  continental interior
export const COASTAL_PLAIN = metersToElevation(60) // +0.007  inner edge of the coastal plain
export const SHELF_BREAK = metersToElevation(-140) // -0.016  outer edge of the shelf
export const SLOPE_FOOT = metersToElevation(-3000) // -0.333  base of the continental slope
export const RIDGE_CREST = metersToElevation(-2600) // -0.289  mid-ocean ridge crest
export const ABYSSAL_FLOOR = metersToElevation(-5700) // -0.633  fully subsided old basin

// How much water this planet was given, as a shift of the solid surface relative to
// sea level, in metres.
//
// SEA_LEVEL stays 0 — that signed zero is load-bearing, since every land/ocean test
// is a sign test and several are hardcoded (applyMountainRedistribution's
// `elevation <= 0`, the renderer's land bit). "More water" and "sea level rises"
// are the same statement in two coordinate systems; expressed with sea level pinned
// at zero, more water means the solid surface sits LOWER relative to it. That is
// also the isostatically honest description: added water loads the basins,
// continents float relatively lower, and freeboard decreases.
//
// **Implemented as one subtraction, not as an offset on the six anchors below.**
// Those two are identical: the margin profile is built entirely from the anchors,
// and elevation is baseline + uplift + detail, so shifting every anchor by −Δ and
// subtracting Δ from the finished baseline produce the same field. The subtraction
// is a single argument to computeRaftBaseline; the anchor version would mean making
// six exported constants mutable module state, which every importer would then have
// to read at call time. Same result, far less to go wrong.
//
// ±600 m, down from ±1350 (2026-08-06) — recalibrated to the range the terrain
// actually RESPONDS in, measured on Archean worlds (two seeds, 600 epochs):
// raising by +675 m already drowned 100% of the land (crust tops sit below
// ~650 m), while the entire −675…−1350 m stretch changed land area by under
// one point (the young ocean floor lies at −2600 m, so lowering exposes only
// the margin band). At ±1350 three quarters of the slider's travel therefore
// did nothing visible — the user-reported "the water knob has no effect".
// ±600 spreads the same visible response across the whole travel instead.
// (The old "half to one and a half Earth oceans" framing described water
// VOLUME faithfully but not what a player can see happen.)
export const WATER_OFFSET_MAX_M = 600

// UI slider 0..100 (50 = Earth-like) → the metre shift.
export function waterSliderToOffsetM(slider: number): number {
  return ((slider - 50) / 50) * WATER_OFFSET_MAX_M
}

// The continental margin's shape, as a curve from open ocean (t = 0) to
// continental interior (t = 1).
//
// This replaced a straight lerp from the ocean baseline to the land baseline
// across the raft membership band, and it is what actually fixes the steep
// coastline. Under a linear mapping the shoreline necessarily falls wherever
// elevation happens to cross zero — which, with land at +0.35 and ocean at
// -0.45 or below, was the middle of the band, i.e. the STEEPEST point of the
// whole transition. Every coast was a cliff by construction, and dropping the
// land baseline to a realistic freeboard would have made it worse, not better:
// at +0.04 over a -0.63 floor, zero crossing moves to ~94% of the way up the
// band, pushing the coastline into the very edge where the curve is sharpest.
//
// Earth doesn't work that way. The isostatic transition crosses sea level almost
// horizontally, which is exactly why continental shelves exist: a wide, nearly
// flat apron sitting just below the waterline, and only THEN the shelf break and
// the continental slope dropping to the abyssal plain. The big drop is real —
// the continental slope is the steepest large-scale feature on the planet — but
// it happens far offshore and underwater, where nobody reads it as a cliff at
// the coast.
//
// So the profile is shaped rather than interpolated:
//
//   t = 0.00   abyssal floor (age-dependent, supplied by the caller)
//   t = 0.15   SLOPE_FOOT      foot of the continental slope
//   t = 0.45   SHELF_BREAK     outer shelf edge — the slope's top
//   t = 0.80   COASTAL_PLAIN   inner edge of the coastal plain
//   t = 1.00   LAND_BASE       continental interior
//
// Note what is NOT in that list: sea level. Putting a control point AT 0 was the
// first attempt and it overshot the goal badly — smoothstep has zero derivative
// at a segment end, so the shoreline came out perfectly flat (measured 0.1 m/km,
// against ~2-5 m/km for a real coastal plain). A flat shoreline is its own
// failure: coastline position stops being set by the crust geometry and starts
// being set by whatever noise is layered on top, and it moves tens of kilometres
// for a few metres of perturbation. Sea level instead falls INSIDE the
// SHELF_BREAK→COASTAL_PLAIN segment, where the curve is genuinely rising.
//
// The stop positions come from a grid search against Earth-derived targets
// (shoreline 2-5 m/km, shelf 70-150 km wide, continental slope 40-70 m/km and
// well offshore), then checked for robustness across blob radii 60-220 px and
// crustal ages 0-180. Across that whole range the shoreline gradient stays
// between 1.0 and 3.7 m/km, the shelf between 43 and 160 km, and — the property
// this all exists for — the steepest point of the profile is always at least
// 70 km offshore and below -1400 m. That is the continental slope, which is
// supposed to be steep. The coast is not.
const MARGIN_STOPS: readonly (readonly [t: number, elevation: number])[] = [
  [0.15, SLOPE_FOOT],
  [0.45, SHELF_BREAK],
  [0.8, COASTAL_PLAIN],
  [1.0, LAND_BASE],
]

// Smoothstep so the segment joins have no slope discontinuity — a piecewise
// LINEAR profile puts a visible crease at every control point, and the shelf
// break is precisely where a crease would read as the artifact this is meant to
// remove.

// Elevation at margin parameter `t` (0 = open ocean, 1 = continental interior).
// `abyssalFloor` is passed in rather than read from the constant above because
// the deep end is age-dependent (see elevationField.oceanFloorAtAge): young
// crust near a ridge sits ~3 km shallower than a fully subsided basin, and the
// margin has to meet whatever floor is actually there.
export function marginProfile(t: number, abyssalFloor: number): number {
  if (t <= 0) return abyssalFloor
  if (t >= 1) return LAND_BASE
  let fromT = 0
  let fromE = abyssalFloor
  for (const [stopT, stopE] of MARGIN_STOPS) {
    if (t <= stopT) return fromE + (stopE - fromE) * smoothstep((t - fromT) / (stopT - fromT))
    fromT = stopT
    fromE = stopE
  }
  return LAND_BASE
}

// The margin parameter is its own smoothstep over the raw metaball field, with a
// far WIDER band than rafts' own FIELD_LO/FIELD_HI membership threshold (0.35 to
// 0.65). Deliberately decoupled: membership answers "is this continental crust"
// — which drives plate typing, accretion, mantle insulation and rift eligibility
// — while this answers "what height is the crust here", and the two questions
// want different bands. A margin needs physical width to hold a shelf and a
// slope; reusing the narrow membership band compressed the entire ocean-to-
// continent transition into ~150 km, which is most of why it read as a wall.
// HI = 1.0 is the field value at a lone blob's centre, so a continent (always
// several overlapping blobs) sits comfortably at full interior height.
export const MARGIN_FIELD_LO = 0.08
export const MARGIN_FIELD_HI = 1.0

// A real-world terrain angle, expressed in the units the erosion code measures
// slope in: elevation units of rise per CELL of run (see runThermalErosion's
// `drop / distance`, where distance is 1 or √2 cells). Converting needs both
// scales — the vertical one from this module and the horizontal one from
// mapConfig — which is exactly why an angle stated as a bare number was so easy
// to get wrong.
//
// Worked example: a 45° slope is 7800 m of rise across one 7800 m cell, which is
// 7800/9000 = 0.867 elevation units per cell. So the grid units are almost the
// same size as tan(θ) here, but only by coincidence of the two scales — don't
// assume that.
export function slopeFromAngle(degrees: number): number {
  return Math.tan((degrees * Math.PI) / 180) * (METERS_PER_CELL / ELEVATION_METERS)
}

export function angleFromSlope(slope: number): number {
  return (Math.atan(slope * (ELEVATION_METERS / METERS_PER_CELL)) * 180) / Math.PI
}

// How much gentler land slopes became under the recalibration, measured rather
// than derived: identical seed and epoch count, land-cell elevation differences
// over a 4 px step, before vs after. Interior land (coastal cells excluded, so
// this isn't just the new shelf showing up) went from median 0.0083 / p90 0.0586
// to 0.0031 / p90 0.0331 — a factor of ~2.
//
// The cause is not the metre anchor, which is a pure offset and cancels in a
// difference. It's the margin profile: continental interior used to be a FLAT
// plateau at 0.35 ending in a cliff, and is now a gentle ramp from the coast up
// to LAND_BASE, spread across hundreds of kilometres.
//
// Every constant that reads an elevation DIFFERENCE was tuned against the old
// distribution, so each is scaled by this to preserve the behaviour it was tuned
// for. They are eye-tuned visual/gameplay knobs, not physical quantities — the
// honest move is to keep them where they were, not to re-guess them. Applied in
// erosion (talusSlope), precipitation (orographic lift), ecology (flatness),
// migration (terrain cost) and the hillshade.
export const SLOPE_RECALIBRATION = 2

export function marginParameter(field: number): number {
  const t = Math.max(0, Math.min(1, (field - MARGIN_FIELD_LO) / (MARGIN_FIELD_HI - MARGIN_FIELD_LO)))
  return smoothstep(t)
}

// The raft-field value at which land begins — the single answer to "is there crust
// here", for everyone who needs to ask.
//
// It existed implicitly as the zero crossing of marginProfile, and everything that
// needed the answer guessed its own: the mantle's membership band sat at 0.35-0.65,
// and the Archean's "already crust here" test at 0.15. Measured against the rendered
// coastline, that last one treated one and a half to two times the land area as
// occupied — a belt of open water around every island in which no new crust could
// form, so crust could never grow onto an existing shore and always arrived as a
// separate island instead.
//
// Solved numerically rather than written down, so it follows MARGIN_STOPS and the
// LO/HI band instead of drifting from them the moment either is retuned.
export const SHORELINE_FIELD = ((): number => {
  let lo = MARGIN_FIELD_LO
  let hi = MARGIN_FIELD_HI
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (marginProfile(marginParameter(mid), ABYSSAL_FLOOR) > 0) hi = mid
    else lo = mid
  }
  return (lo + hi) / 2
})()
