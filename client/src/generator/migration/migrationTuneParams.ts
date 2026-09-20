import { SLOPE_RECALIBRATION, metersToElevation } from '../elevation/elevationScale'

// Algorithm tuning for the initial-migration spread. NOT user inputs — those
// are in migrationInputParams.ts, and the difference is what each one does to a
// world's identity: an input is recorded in the save and defines which world
// you get, a tuning constant defines how this generator computes it.
//
// Grouped into ONE object rather than exported as loose consts, and that is the
// whole point of the file. `derivePipelineVersion` (world/identity.ts)
// takes a `Record<string, number>` and hashes it, so a module whose constants
// are an object gets an automatic "my tuning changed" signal, while a module
// whose constants are scattered `export const`s can never have one. Today only
// the amplification bake feeds that hash; this is the shape that lets the rest
// follow.
//
// Derived values are stored derived, deliberately: `slopeCost` moves when
// SLOPE_RECALIBRATION moves, and the hash should notice that too — the
// algorithm's effective tuning really did change, whoever edited it.

const seaCrossingMaxDepth = metersToElevation(600)

export const MIGRATION_TUNING = {
  // Cost to enter a flat land cell, before slope and corridor terms.
  landBase: 1,
  // Steep terrain penalty (× slope). Scaled by SLOPE_RECALIBRATION (see
  // elevationScale.ts) — the slope this multiplies halved, and mountains should
  // stay as discouraging to cross as they were tuned to be.
  slopeCost: 14 * SLOPE_RECALIBRATION,
  // Coast and river cells are cheap highways.
  corridorDiscount: 0.5,
  // Discharge above this fraction of the maximum counts as a river corridor.
  riverDischargeFrac: 0.05,
  // Shallow water is costlier than land to cross.
  waterBase: 3,
  // Depth thresholds, restated in metres now that the elevation scale is anchored
  // (elevationScale.ts). The old bare 0.25 would read as 2250 m of open ocean
  // "still passable at seaCrossing = 1" — never the intent; on the old scale, where
  // ocean ran -0.45 to -1.0, a quarter unit was a shallow fringe. 600 m is the real
  // limit of the water proto-humans crossed: the shelf and the straits over it, not
  // the deep basins.
  //
  // This constraint only starts to MEAN anything now. Before, there was no shelf —
  // the coast dropped from continent to abyssal plain within a few cells — so at
  // the coarse climate grid these fields run on, shallow water barely existed as a
  // sampleable thing, and island hopping was near-impossible whatever the slider
  // said. With a real shelf there is finally passable water to cross.
  seaCrossingMaxDepth,
  // Per unit depth below sea level. Scaled with the depth limit, so the cost at
  // the deepest crossable water stays what it was tuned to be.
  waterDepthCost: 25 * (0.25 / seaCrossingMaxDepth),
} as const
