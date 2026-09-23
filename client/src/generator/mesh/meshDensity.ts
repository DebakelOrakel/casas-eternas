// THE DENSITY RULE (decision 1 of docs/decisions/adaptive-mesh.md): the
// target node spacing at a point, from four local quantities —
//
//     h = clamp(min(h_relief, h_discharge, h_curvature, h_column), h_min, h_max)
//
// with the deep ocean floor at one fixed spacing. ONE function for the macro mesh
// and for every tile; the two differ only by `budget`, a scalar on the
// result (1 for the macro mesh, smaller for a tile). Every term is a length
// in metres so the constants read as what they are:
//
//   h_relief     = reliefPerNodeM / slope — one node per `reliefPerNodeM`
//                  of height difference; a 5 % slope at 100 m gives 2 km.
//   h_discharge  = minSpacingM · sqrt(dischargeRefM3s / Q) — the spacing
//                  reaches the floor at the reference discharge and grows
//                  as the square root below it (four times less water,
//                  twice the spacing), so trunk rivers densify and
//                  headwaters do not. Q is water AND ice flux once the ice
//                  model exists (design/glacial.md).
//   h_curvature  = curvatureFactor / |κ| — a fraction of the radius of
//                  curvature, so a crest or a valley floor is resolved
//                  across, not only along.
//   h_column     = columnSpacingM where the sediment column is thicker
//                  than columnThresholdM, else unbounded — inert until
//                  phase 5 puts columns on the nodes.
//
// Below `deepOceanBelowM` none of the terms applies and the spacing is
// `oceanSpacingM` outright: the engine never computes there (the deep
// ocean is frozen, erosionEngineState.ts), so a ridge flank or a trench
// wall resolved at kilometres would be nodes carrying nothing. Measured
// on the first build: with the relief term active under the sea, three
// of four million nodes sat on the ocean floor. The shelf and the
// continental slope above the threshold are land-like — the coast
// iso-line and the deltas live there.
//
// The constants are MEASURED, not decided (ADAPTIVE_MESH_PLAN.md phase
// 4.1): `npm run harness:mesh measure <save.zip>` reports node counts on
// a real save, and the numbers here are what those measurements settled
// on. They will be part of every artifact's identity through the
// constants hash (decision 2) once the mesh produces one (the save and
// the bake switch in phases 4.3–4.5; until then no key depends on them).
//
// Measured 2026-09-23 on a saved 2048×1024 world with 26 % land
// (relief and discharge from the save's rasters, sampled bilinearly):
//
//     minSpacingM  maxSpacingM  deepOceanBelowM   nodes     land      ocean   build
//        2000        16000          -1000         1.91 M    1.01 M    0.90 M   14 s
//        2000        16000           -300         1.35 M    1.03 M    0.32 M   10 s
//        3900        16000           -300         0.89 M    0.66 M    0.23 M    7 s
//        2000         7800           -300         1.67 M    1.34 M    0.33 M   19 s   <- chosen
//
// with the relief term active under the sea (no deep-ocean cut-off) the
// first build had 4.1 M nodes, 3.1 M of them on the ocean floor. The
// binding term on land is relief for three nodes in four, the floor for
// most of the rest; discharge binds on some 60 000 trunk-river nodes and
// curvature never does at these constants (relief reaches the floor
// first). A remesh on the unchanged state after a build removes about
// 1 % (nodes the refine placed under the removal threshold of a
// neighbour's target); the second one moves nothing — the hysteresis
// band holds.
//
// The ceiling is ONE MACRO CELL (METERS_PER_CELL) and not the 16 km the
// first measurements ran with: the plains' micro-relief (elevationField's
// fineValue, 20 m) has a 15.6 km octave that the raster samples at 7.8 km
// and a 16 km node spacing would alias away — and it is what makes lowland
// drainage dendritic (elevationTuneParams.plainDetailMax). While the
// consumers still read a 2048 rasterisation of the mesh, the mesh is
// nowhere coarser than that raster on land; the price was +25 % nodes.
// The golden worlds (35 % land at most) build 1.6–4.2 M nodes.
export const MESH_TUNING = {
  // Spacing floor and ceiling on land (the shelf and the continental slope
  // count as land here), and the one spacing of the deep ocean floor.
  minSpacingM: 2000,
  maxSpacingM: 7800,
  oceanSpacingM: 40000,
  deepOceanBelowM: -300,
  reliefPerNodeM: 100,
  dischargeRefM3s: 5000,
  curvatureFactor: 0.5,
  columnThresholdM: 50,
  columnSpacingM: 4000,
  // The remeshing hysteresis (decision 8): an edge longer than insertRatio
  // times the target gets a node, a node whose spacing is below removeRatio
  // times the target goes. The band between the two is what keeps a mesh
  // from oscillating between epochs.
  insertRatio: 1.5,
  removeRatio: 0.5,
}

// Target spacing in metres. `slope` is rise over run (m/m), `dischargeM3s`
// the water flux, `curvaturePerM` the height field's Laplacian-type
// curvature in 1/m, `columnM` the sediment column, `heightM` the height
// above sea level (the deep-ocean test).
export function targetSpacingM(slope: number, dischargeM3s: number, curvaturePerM: number, columnM: number, heightM: number, budget = 1): number {
  const T = MESH_TUNING
  if (heightM < T.deepOceanBelowM) return T.oceanSpacingM * budget
  let h = T.maxSpacingM
  if (slope > 0) h = Math.min(h, T.reliefPerNodeM / slope)
  if (dischargeM3s > 0) h = Math.min(h, T.minSpacingM * Math.sqrt(T.dischargeRefM3s / dischargeM3s))
  const k = Math.abs(curvaturePerM)
  if (k > 0) h = Math.min(h, T.curvatureFactor / k)
  if (columnM > T.columnThresholdM) h = Math.min(h, T.columnSpacingM)
  if (h < T.minSpacingM) h = T.minSpacingM
  return h * budget
}
