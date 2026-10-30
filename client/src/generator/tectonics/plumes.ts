// Mantle plumes, derived from the mantle field rather than scattered at random.
//
// **A plume is a persistent upwelling.** That is the same definition the Archean
// already uses to decide where crust nucleates (crustNucleation's upwellingStreak),
// which is the point: one rule on both sides of the hand-off instead of two.
//
// They used to be five uniformly random points, created once at the hand-off and
// never moved again — "fixed for the world's life". Two things were wrong with that:
//
//  - **Real plumes drift**, just slowly. The Hawaiian plume moved roughly 15° south
//    between ~80 and ~50 Ma, which is part of why the Hawaiian-Emperor chain has a
//    bend in it. Inter-hotspot drift runs 1-2 cm/yr against plate speeds of 5-10.
//  - **The world already had them moving, on the other side of the hand-off.** In the
//    Archean the plume role is played by the mantle field's upwellings, and that
//    pattern reorganises completely across the phase (correlation against its start
//    falls to 0.21). So the same physical thing flipped from mobile to frozen at the
//    hand-off — and in the wrong direction, since the Archean mantle was the hotter,
//    more vigorous one.
//
// Deriving them from the field rather than giving the fixed points a random walk is
// deliberate, and it is the same move that fixed plate motion (see
// docs/decisions/evolving-euler-poles.md, which sets out to model the CAUSE instead of
// scripting the effect). A random walk would be motion without a reason, untethered
// from the field that drives everything else here.
//
// Three properties fall out for free rather than needing to be tuned:
//
//  - **Speed.** The field's pattern changes at ~0.996 correlation per epoch, while
//    plates are re-fitted to its flow every epoch and move fast. Plumes are therefore
//    automatically much slower than the plates riding over them — the real
//    relationship, with no ratio to calibrate.
//  - **Bent chains.** A plume that creeps while the plate above it races produces
//    exactly the geometry the Hawaiian-Emperor bend records.
//  - **Clustering.** Real plumes cluster (at the margins of the deep mantle's two
//    large provinces) rather than being uniformly spread. Field-derived plumes
//    inherit the field's own spatial organisation; uniformly random points cannot.

// The sites, their motion and their retirement are the engine's
// (tectonics/plumes.rs, with its thresholds); the screen gets them with the
// snapshot after the hand-over and with the engine's render in the Archean.
export interface Plume {
  x: number
  y: number
  // Identity, so a plume is more than its position in an array — retiring one splices
  // the list, and without an id "the same plume" would silently become "whichever is
  // now at that index". The chain a plume builds is the reason it exists, so losing
  // track of which is which loses the feature.
  id: number
  birthEpoch: number
}
