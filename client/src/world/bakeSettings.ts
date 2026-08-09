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
