// What an amplification bake is asked to do — which tiers this client bakes,
// which it may fetch, and how many erosion rounds each gets.
//
// These lived in `map/mapSceneSettings.ts`, next to camera altitudes and
// exaggeration factors, because the map SCREEN is what triggers a bake. But they
// are not scene settings: `AMPLIFY_EROSION_ROUNDS` is hashed into the artifact
// key, so it decides which cached terrain answers for a world. That made
// `storage/` import from `map/` — an edge between two peers that had no business
// existing, and one this file exists to delete.

// The worldmap's amplification bake runs in STAGES, coarse first (see
// docs/decisions/worldmap-amplification.md): each factor is baked in turn
// and swapped in when it lands, so a usable amplified world arrives early
// and sharpens later instead of the screen waiting for the deepest tier.
//
// Measured 2026-08-07 (2 erosion rounds, full chain incl. hydrology):
//   factor 2 → 4096x2048, ~102 s,  ~0.2 GB peak
//   factor 4 → 8192x4096, ~444 s,  ~3 GB peak
//   factor 8 → 16384x8192, ~2515 s, 8.5 GB peak RSS   (2026-08-15, Node baker)
//
// The factor-8 row is a LOCAL measurement, not a shipped tier: nothing bakes
// or fetches it from the app. It is here because this is where the next
// person will look for what a tier costs — the full comparison (drainage
// density, valley depth per tier) is in docs/design/hex-world-view.md under
// the near-field plan's step 3.
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

// The DESIGNATED FINEST tier (docs/decisions/derived-bake-tiers.md): the one
// stage whose bake is authoritative below macro scale. Its artifact carries
// every coarser tier as a box-downsampled family member, so within the
// family a tier swap changes resolution, never terrain; the fetch ladder IS
// this constant plus the provisional stage-2 sketch (WorldMapScreen's
// loadTiers), which replaced the old AMPLIFY_FETCH_STAGES list.
//
// 8K is also the DISPLAY ceiling, and that is a memory argument rather than
// a taste one — holding one amplified raster costs width × height × 4 bytes
// as Float32:
//
//   factor 2   4096×2048     33 MB
//   factor 4   8192×4096    134 MB
//   factor 8  16384×8192    537 MB
//
// 134 MB is a raster a tab can hold beside a map it is already showing;
// 537 MB is asking for the tab death by another route. Raising this to 8
// wants the engine's MFD memory work first (stride-8 is ~16 GB at 16K) AND
// a measured 16K display story — until then the family's own coarser
// members are how a smaller device would step down, not a longer stage
// list.
export const AMPLIFY_FINEST_STAGE = 4

// ENGINE ITERATIONS the bake runs on the amplified field (the v2 engine's
// age axis; the constant keeps its wire name — the Go bake module and every
// job JSON speak it, and its Go default mirrors this value).
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
