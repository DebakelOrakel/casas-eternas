// The GRID half of the erosion-v2 forcing assembly: coarse fields in, the
// engine's fine-grid forcing out. Pure — no simulation state, no climate
// model, no save format — which is what lets it sit in surface/ and serve
// BOTH producers of coarse fields:
//
//   - the generator (the engine's erosion_forcing.rs), whose coarse U/K come from
//     the live tectonic sim and whose water forcing is the provisional
//     default-parameter climate;
//   - the amplification bake (runAmplification.ts), whose coarse U/K come
//     from the save's forcing layers and whose water forcing is the save's
//     REAL precipitation.
//
// One function, because the mapping from coarse fields + controls to what the
// engine actually reads is identity-relevant on both sides: the golden
// harness gates the generator's copy, and browser/server bakes must agree
// byte for byte on theirs. Two copies would agree only until one is edited.

// Decorrelates the erosion lithology lattice from the render's fine-detail
// noise, which shares warpSeed.
export const EROSION_LITHO_SEED_SALT = 0x51702e77

// Full lithology contrast at rockContrast 100 — the σ of the log-normal
// erodibility factor. 2.8 spans roughly ×16 between the softest and hardest
// bands at full contrast; the slider maps linearly onto it.
export const ROCK_CONTRAST_SIGMA_MAX = 2.8

export interface ErosionControlsV2 {
  alluvium?: number
  rockContrast?: number
}
