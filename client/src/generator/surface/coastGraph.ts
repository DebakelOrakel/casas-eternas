// THE COAST AS A FEATURE (ADAPTIVE_MESH_PLAN.md F5, docs/design/coast.md
// "Forerunner"): the shoreline cut into REACHES with attributes like a
// river's, and a coast TYPE per reach from them — a classification with no
// process behind it. The coast process (the engine's surface/coastal.rs, phase 7) runs on
// the same line in the history; this is the picture after the stop.
//
// On the terrain mesh since DEC-0036 phase 7b (it walked the 2048 raster
// before): a coast node is a land node with a sea node among its
// neighbours (the engine's coastal.rs `find_shore` — the line the history's waves and drift
// work on), and reaches are walks from coast node to coast node along the
// mesh's edges, cut at river mouths and every `coastReachM` metres. Per
// node:
//
//   exposure  wave energy from the wind: speed² × fetch, the fetch being
//             the open water UPWIND of the node (the direction the waves
//             come from) up to `coastFetchCapKm`, marched in steps of
//             `coastGraphFetchStepM` (the engine's `shore_exposure`), normalised to
//             the world's 90th-percentile coast and clamped, so it is
//             relative (0..1; the top tenth reads 1). Measured 2026-09-22
//             on golden alpha against the maximum instead: the median
//             coast read 0.01 and nine of ten reaches came out rocky —
//             a few storm coasts set the scale for all.
//   relief    the highest land of the terrain's surface at the node and
//             at the eight compass points `coastReliefStepM` around it,
//             metres above the sea: a steep coast is what waves can cut a
//             cliff into.
//   hardness  the erodibility K factor (1 neutral, below 1 hard) from the
//             erosion forcing's field.
//   supply    river sediment reaching the node: every sea mouth's load
//             spread over `coastSupplyReachKm`, relative to the world's
//             90th-percentile fed coast like the exposure.
//
// From those the type, in this order (the first rule that fits): DELTA
// within `coastDeltaReachM` of a mouth whose course is one; MARSH where the
// water is calm, the land flat and river sediment arrives; CLIFF where the
// coast is steep and exposed and the rock not soft; BEACH where sediment
// arrives or the waves work a low coast; ROCKY for the sheltered, unfed,
// hard rest. A reach takes the type most of its nodes have.
export type CoastType = 'rocky' | 'cliff' | 'beach' | 'marsh' | 'delta'

export interface CoastReach {
  id: number
  // The reach's coast nodes in walk order (CoastGraph.nodes).
  nodeStart: number
  nodeCount: number
  lengthKm: number
  // Means over the nodes (exposure, relief m, hardness) and the summed
  // relative supply.
  exposure: number
  reliefM: number
  hardness: number
  supply: number
  type: CoastType
  // The river reach that ends on this coast reach, -1 for none.
  mouthReach: number
}
