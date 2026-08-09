// Tuning constants for continental-crust behaviour — the raft geometry both
// eras share.
//
// They lived in `tectonics/tectonicsParams.ts`, which made `archean/` import
// from `tectonics/` for something that is neither: the Archean and the tectonic
// phase BOTH grow, merge and split the same rafts, and both hand these values
// to the same `crust/` functions. Filing them under one era made the other
// reach across a boundary for a shared rule.
//
// Note that `crust/` itself does not read them. Its functions take the values as
// parameters (`mergeOverlappingRafts(rafts, overlapFactor, …)`), which is what
// lets the Archean pass its own where it deliberately differs — see
// ArcheanParams. This file is the shared DEFAULT the two callers agree on, not a
// hidden dependency of the functions.

// Raft merge (Phase 2c): two continents whose crust overlaps suture into one.
// The factor scales the sum of two blobs' radii into the center-distance that
// counts as overlapping — ~0.5 ≈ their coastlines meet (see mergeOverlappingRafts).
export const MERGE_OVERLAP_FACTOR = 0.5

// Blobs count as connected (same landmass) if their centers are within
// (ra+rb)*this. The comment here used to note that two blobs render as one
// landmass at ~0.7·(ra+rb) and then set the factor to 1.5 anyway, to stop thin
// multi-blob necks being mistaken for gaps.
//
// That overshot badly. At 1.5 rafts were grouped roughly three times looser than
// the coastline the renderer draws, so the raft bookkeeping — and the "Cratons"
// readout built on it — described a world nobody could see: measured at epoch 300,
// the code counted 1-3 rafts where the rendered land mask had 46-49 separate
// masses, every one of them substantial rather than a speck.
//
// The threshold follows from the geometry. Sea level sits at a raft field of ~0.625
// (elevationScale's margin profile) and the metaball kernel is (1 − d²/r²)², so two
// equal blobs stay visibly joined while each contributes half of that at their
// midpoint — a centre distance of 1.33 r, i.e. 0.664 × (ra+rb). That confirms the
// original ~0.7 estimate; only the conclusion drawn from it was wrong.
//
// 0.75 sits just above it, so a pair that is marginally connected on screen is not
// split — which is the hysteresis this factor is for, and it no longer fights
// MERGE_OVERLAP_FACTOR (0.5) three octaves away. Checked against the rendered mask
// over two seeds: 0.75 gives 54/48 rafts against 44/45 visible masses (slightly
// over-split, the safe direction), 0.6 gives 75/65, 0.9 gives 38/26.
export const RAFT_CONNECT_FACTOR = 0.75
