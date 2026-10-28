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

// Why 9000 m and not, say, 6000: the field was clamped to ±1, so the anchor
// set what fits. At 9000 m Everest (8848 m) lands at 0.98 — the clamp was
// spent almost exactly on the tallest thing that can exist. Since DEC-0036
// phase 8b-3 there is no ceiling: a height above 1 is a height (the save
// holds the mesh's z as float32), and the plate's flexure and the erosion
// bound it; the anchor is only the unit. Since phase 8e there is no floor
// in the history either: a trench on old floor stands 10–11 km deep
// (tectonics/trench.ts; the Marianas, 10.9 km, are −1.21). The synthesis
// (the engine's `compute_elevation`) keeps −1 under its trench deck.
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
export const INNER_SHELF = metersToElevation(-60) // -0.007  the shelf's middle
export const SLOPE_FOOT = metersToElevation(-3000) // -0.333  base of the continental slope
export const RIDGE_CREST = metersToElevation(-2600) // -0.289  mid-ocean ridge crest
export const ABYSSAL_FLOOR = metersToElevation(-5700) // -0.633  fully subsided old basin

// The sea stands at SEA_LEVEL; only the ice moves it (the coupled epoch's
// eustasy, PlateSimulation.eustaticM). There was a water control here, a
// shift of the solid surface against the sea of up to ±600 m; it moved the
// land by ±1.5 points only (DEC-0036 phase 8a) and went in phase 8b-1 —
// how much land a world has is the Archean's land share target now
// (archean/archeanLand.ts).

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
// So the profile is shaped rather than interpolated (the stops until
// 2026-10-27; what moved is below):
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
//
// 2026-10-27 (docs/decisions/shelf-and-sea.md): the stops moved seaward —
// the break from t = 0.45 to 0.25, the slope's foot from 0.15 to 0.10 — and
// a stop on the inner shelf (-60 m at 0.55) took the shoreline's place in
// the middle of a segment: the coastal plain's stop at 0.7957 puts the
// shoreline at t = 0.6729 as before (the segment's middle, where the
// smoothstep is steepest, as the paragraph above wants it), so the Archean's
// land and the shoreline field do not move. The shelf is twice as wide in t;
// at the hand-over the worlds' shelf was 5.7 % of the ocean against 2.7 %.
// The rust engine holds the profile (casas-engine elevation_scale.rs); this
// copy is its reasoning.
// The margin parameter at the foot of the continental slope — the first
// stop below; the trench's depression (elevationField.slabDepressionAt)
// ends here, seaward of the overriding plate's slope.
export const SLOPE_FOOT_T = 0.1
const MARGIN_STOPS: readonly (readonly [t: number, elevation: number])[] = [
  [SLOPE_FOOT_T, SLOPE_FOOT],
  [0.25, SHELF_BREAK],
  [0.55, INNER_SHELF],
  [0.7957197562366026, COASTAL_PLAIN],
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
// far WIDER band than the engine's raft FIELD_LO/FIELD_HI membership threshold (0.35 to
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
// erosion (talusSlope), precipitation (orographic lift), ecology (flatness)
// and the hillshade.
export const SLOPE_RECALIBRATION = 2

export function marginParameter(field: number): number {
  const t = Math.max(0, Math.min(1, (field - MARGIN_FIELD_LO) / (MARGIN_FIELD_HI - MARGIN_FIELD_LO)))
  return smoothstep(t)
}
