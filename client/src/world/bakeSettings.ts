// What a level bake is asked to do (pipeline/meshBakeStage): how many
// erosion rounds it runs. Hashed into the level's artifact key
// (world/meshArtifacts.meshPipelineVersion), so it decides which cached
// level answers for a world.
//
// The raster amplification bake's tiers (factor 2/4/8, the designated finest
// tier and its family members) lived here too, and went on 2026-09-29: the
// detail comes from the mesh levels and their tile jobs
// (docs/decisions/adaptive-mesh.md, fork 3). The rounds' measurements below
// are the raster bake's, the only ones made yet.

// ENGINE ITERATIONS a level bake runs (the v2 engine's age axis; the
// constant keeps its wire name — the Go bake module and every job JSON speak
// it, and its Go default mirrors this value).
//
// v1's value was 2 ROUNDS, a different unit entirely (each round a full
// multi-mechanism pass; measured 2026-08-07, ~80 % of the relief gain in
// round one). For the engine, measured 2026-08-16 on a real 2048 save at
// factor 2 (4096×2048, single thread, channel lowering vs the seeded field):
//
//   age  6: channels p90  66 m, land mean −19 m, coast drift +0.28 pts, 28 s
//   age 12: channels p90 106 m, land mean −35 m, coast drift +0.41 pts, 39 s
//   age 24: channels p90 185 m, land mean −62 m, coast drift +0.62 pts, 62 s
//
// 12 lands the carving in the register v1's bake was tuned for (84→167 m
// mean incision) at moderate whole-land denudation — a CALIBRATION
// PLACEHOLDER until the coastline status rule (erosion-v2 P3 step ②) pins
// the drift and a visual pass judges the look. The negative channel p50 in
// those runs is not an error: the ξ–q engine aggrades floodplains while its
// p90 tail carves, which v1's pure-incision model could not do.
export const AMPLIFY_EROSION_ROUNDS = 12
