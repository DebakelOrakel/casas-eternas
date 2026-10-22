// A feature is a mountain *range* (or arc/ridge), or a *trench* — the
// paired negative depression on the subducting side of a subduction/
// island arc (see plateSimulation.ts's trench deposit). Both are oriented
// ridge features; the distinction keeps a trench from ever merging into
// its own arc's range feature in the engine's `find_or_create_feature_index`
// (same plate pair, only offset apart), and lets the engine's
// `compute_elevation` give a trench a
// narrower, deeper cross-section than a broad range.
export type FeatureKind = 'range' | 'trench'

export interface TerrainFeature {
  x: number
  y: number
  // Signed relative crustal thickness change from baseline, driving
  // elevation via isostasy (elevationField.ts): positive means the crust
  // has thickened (mountains, arcs, ridges), negative means it's thinned
  // (rift valleys stretching/sinking) — see boundaryClassification's
  // elevationSign for which boundary characters deposit which sign. This
  // is the rendering-relevant accumulator, separate from the lattice's
  // own signed rift/merge trigger state in plateSimulation.ts.
  thickness: number
  // Unit vector along the boundary curve at this feature's location (the
  // ridge's own long axis) — perpendicular to the seed-to-seed normal at
  // deposit time. The engine's `compute_elevation` uses it for an anisotropic falloff:
  // long along this tangent (so features spaced along one boundary blend
  // into a single continuous linear range instead of a row of round
  // blobs), narrow across it (so the range reads as a ridge with a crest,
  // not a dome). Refreshed toward the current boundary tangent whenever a
  // feature is deposited onto again, so an active range keeps following
  // its boundary as it reorients; a feature drifting inactively keeps a
  // slightly stale tangent, which is harmless since it's decaying anyway.
  tangentX: number
  tangentY: number
  kind: FeatureKind
  // The two plates on either side of the boundary that created this
  // feature — kept as an unordered pair (see the engine's
  // `find_or_create_feature_index`)
  // even for asymmetric uplift, where only one side actually builds
  // terrain, so a *different* boundary that happens to share only one of
  // these plates can't merge into and deposit onto this feature. Confirmed
  // empirically without this: an unrelated rift boundary drifted within
  // the engine's MERGE_RADIUS_M of an established fold-mountain feature (both merely
  // touching the same plate on their own far sides) and canceled it —
  // thickness went from a steady climb to strongly negative within ~25
  // epochs.
  plateA: number
  plateB: number
  // Which plate's motion actually carries this feature — one of
  // plateA/plateB *by value* (not by position, since the engine's `detect_boundaries` can
  // relabel which plate is "A" vs "B" for the same physical boundary
  // across epochs) for asymmetric uplift, where only the owning side's
  // own crust the arc/range physically rides on. 'both' for symmetric
  // collisions (fold mountains, mid-ocean ridges): averages both plates'
  // velocity at the feature's position instead of attaching to either
  // plate alone (see the engine's `advance_terrain_features`) — attaching a symmetric
  // collision's shared range to just one side was confirmed empirically
  // to pull the two sides' deposits apart (45px within 40 epochs),
  // fragmenting one ridge into two separately-drifting mounds.
  movesWithPlate: number | 'both'
  // Whether this feature rides on oceanic crust and should subside as it
  // ages away from its boundary — island arcs, mid-ocean ridges, and
  // trenches (all oceanic), as opposed to continental fold mountains and
  // subduction-arc ranges, which persist. Set from the boundary character
  // at creation (see plateSimulation.ts). Drives the extra age-depth decay
  // that keeps drifted oceanic features from cluttering the ocean: real
  // oceanic crust cools and sinks as it moves off the ridge, so an old,
  // drifted mid-ocean-ridge/arc feature should fade, while a continental
  // range stays put.
  subsides: boolean
  // Epochs since this feature last received a deposit — reset to 0 in
  // the engine's `step_epoch` whenever it's touched, incremented
  // every other epoch. Drives pruning: without it, every feature ever
  // created (even ones whose boundary went inactive epochs ago, decaying
  // toward zero thickness) stays in this array forever, since nothing
  // else ever removes one. Confirmed empirically that this is the actual
  // cause of the simulation slowing down over a long run — features grew
  // from 237 to 7625 over 550 epochs, and per-render time grew right
  // alongside it (561ms to 8.8s) since every pixel's elevation query
  // scans nearby features.
  epochsSinceDeposit: number
  // Whether this feature is a volcanic arc — a subduction arc (oceanic-continental
  // convergent) or island arc (oceanic-oceanic convergent), the two boundary
  // characters that build a chain of volcanoes (Andes, Cascades, Aleutians), as
  // opposed to (non-volcanic) continental fold mountains or a mid-ocean ridge. Set
  // from the boundary character at deposit time in plateSimulation.ts. A pure render
  // hint: the screen flags these with volcano markers, distinct from the hotspot
  // (plateB = -1) and flood-basalt (plateB = -2) volcanoes. Optional so old
  // deserialized features (which lack it) simply read as non-volcanic.
  volcanic?: boolean
  // The boundary's shortening rate at this feature, km/Myr, signed like the
  // thickness (negative: a rift's extension, a trench's share): the
  // convergence its boundary points closed in the epoch, times the boundary
  // character's rate and the age multiplier (the deposit before
  // upliftPerKm), as a moving mean with a half-life of
  // the engine's TECTONICS_TUNING.shortening_half_life_ma (DEC-0036 phase 8g). Only the
  // boundary pass sets it: a hotspot or a flood basalt shortens nothing.
  // The history's uplift rate is made from it (the engine's uplift_field.rs).
  // Optional so old deserialized features (which lack it) read as 0.
  shorteningKmPerMyr?: number
}
