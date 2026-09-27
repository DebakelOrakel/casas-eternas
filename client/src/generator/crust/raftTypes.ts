// Continental crust modeled as persistent "rafts" that ride on the kinematic
// plates, decoupled from them — see docs/decisions/continental-crust-rafts.md. A
// raft is a set of soft metaball blobs whose union is one continent's outline.
//
// The shared vocabulary: what a raft IS, and what its lifecycle reports when
// continents collide or tear apart. Split out so the field query, the lifecycle
// operations and the generator can each be imported without dragging the others
// along.

export interface RaftBlob {
  x: number
  y: number
  radius: number
  // World epoch this piece of continental crust formed — on the CONTINUOUS
  // axis (core/worldTime.worldEpoch): archean stamps count from the world's
  // first epoch, tectonic-era stamps continue past the handover instead of
  // restarting with the tectonic clock (they did until 2026-08-16, which made
  // a fresh margin read older than an Archean core on young worlds). 0 for
  // the original cratonic nuclei (oldest), the accretion epoch for margin
  // blobs welded on at subduction arcs (younger). Gives a real old-interior/young-margin craton-age
  // gradient (continents grow by marginal accretion) that the Ecology layer
  // samples for iron (old cratons). Optional so pre-existing saved rafts, which
  // lack it, simply read as age 0 (oldest). See docs/decisions/ecology.md P2.
  birthEpoch?: number
}

export interface Raft {
  id: number
  // The continent's name (rafts, not plates, are continents now).
  name: string | null
  blobs: RaftBlob[]
  // Freshly-split halves get this stamp so they don't instantly re-weld:
  // mergeOverlappingRafts skips any pair where either side is still within
  // its window. Lets a breakup stay visible instead of splitting and merging
  // back on consecutive epochs (a band-aid over the fixed-Euler-pole ceiling
  // — see the raft decision doc). Absent/0 = mergeable now.
  noMergeUntilEpoch?: number
}

// What a raft collision (mergeOverlappingRafts) reports for the event/overlay
// layer: the two continents' names (either may be null) plus the suture
// geometry — a point on the collision seam and the tangent the seam runs
// along (perpendicular to the convergence direction, i.e. along the
// fold-mountain belt). The map marker draws a short band there.
export interface RaftMergeEvent {
  nameA: string | null
  nameB: string | null
  x: number
  y: number
  tangentX: number
  tangentY: number
}

// A persisted collision-belt record: the accumulated history of every raft
// suture, kept for the world's life (NOT pruned like terrain features) so
// deep-time orogens survive as the Ecology layer's provenance for tin, lode
// gold, and metamorphic gems. One is appended per RaftMergeEvent (see
// plateSimulation.stepEpoch); `epoch` stamps when the collision happened, so an
// old suture can read differently from a fresh one. See docs/decisions/ecology.md P1.
export interface Suture {
  x: number
  y: number
  // Unit tangent along the collision seam (the fold-mountain belt's long axis).
  tangentX: number
  tangentY: number
  // When the collision happened, on the continuous world-epoch axis
  // (core/worldTime.worldEpoch — same axis as RaftBlob.birthEpoch).
  epoch: number
}

// What a continental breakup (splitRaftAtRift) reports: the parent
// continent's name plus the rift axis — a point on the tear and the
// direction the rift line runs (perpendicular to the divergence normal).
export interface RaftSplitEvent {
  parentName: string | null
  x: number
  y: number
  axisX: number
  axisY: number
}
