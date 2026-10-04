---
id: DEC-0002
title.en: Plate Tectonics: Simulation
title.de: Plattentektonik: Simulation
summary.en: How the tectonics simulation actually produces terrain, mountain formation
  above all.
summary.de: Wie die Tektonik-Simulation das Gelände tatsächlich erzeugt, vor allem die
  Gebirgsbildung.
area: generator
stage: built
createdAt: 2026-07-20
updatedAt: 2026-08-12
concepts: [generator.concept.plate-boundaries]
related: [DEC-0001, DEC-0006]
---

**Status:** Partially decided — elevation model settled (A3), rift/merge
mechanics follow from it but exact thresholds are still open. Computational
envelope (C) deliberately deferred — more a tuning/implementation concern
than a design fork, revisit closer to build time.

## Goal

Generate a realistic, "living" feeling world through the tectonics
simulation itself — pushing geological plausibility as far as is fun and
tractable on consumer hardware, not as far as is theoretically possible.
Mountain formation is the single highest-priority output of this whole
system: ranges should read as the record of real plate history (collision
type, boundary shape, how long it's been active) rather than as tuned
noise. Every other aspect of realism in this doc is secondary to that.

Builds on [plate-tectonics-initial-state.md](./plate-tectonics-initial-state.md):
substrate is free 3D points on the sphere (A2), the simulation runs
multi-epoch (B2), and plates carry type/age/drift that evolve over the run.
This doc is about what happens *during* those epochs — how boundaries turn
into terrain, and how plates split/merge as the epochs play out.

(The substrate later became a flat torus, not a sphere — see
[world-topology-torus.md](./world-topology-torus.md). Everything below is
topology-independent — "distance to a boundary curve" doesn't care whether
the curve lives on a sphere or a torus — and needed no change when that
happened.)

Model direction takes its cue from Cordonnier et al., "Large Scale Terrain
Generation from Tectonic Uplift and Fluvial Erosion" (Eurographics 2016) —
the closest thing to an established best practice for this exact problem:
treat uplift as a forcing function and elevation as a response with memory,
rather than either a one-shot heuristic or a full geophysical simulation.

## Options

### A. Elevation / mountain formation model — Decided: A3

This is the core decision — how convergence at a boundary becomes an
actual mountain range.

Convergence itself is computed from plate kinematics: each plate rotates
about an Euler pole (see the kinematics revision noted in
[plate-tectonics-initial-state.md](./plate-tectonics-initial-state.md)),
so relative velocity at any point along a shared boundary is a direct
calculation, not a lookup — and it varies continuously along the
boundary's length (head-on collision fading into oblique shear along the
same boundary is a natural consequence, not something hand-authored).
That per-point relative velocity decomposes into a normal component
(convergent/divergent) and a tangential component (transform/shear),
giving continuous classification along a boundary rather than one label
per whole segment.

- **A1. Per-tile accumulated uplift** — every point on the surface holds a
  value that gains convergence-derived uplift each step and decays over
  time. Duration falls out naturally — a boundary that's stayed convergent
  for many epochs keeps compounding — but it's heavy full-surface state,
  and this style of accumulator is prone to needing constant decay/threshold
  tuning to keep ranges looking like ranges instead of round blobs. Also
  sits awkwardly against "evaluate the field at any point on demand," since
  the accumulated value has to live somewhere per-point rather than being
  derived fresh.
- **A2. Stateless distance-field from classified boundaries** — classify
  each current boundary segment as convergent / divergent / transform,
  further split by the plate types on each side (continental-continental →
  fold mountains, oceanic-continental → asymmetric subduction arc +
  trench, oceanic-oceanic → island arc; divergent → rift valley or
  mid-ocean ridge). Elevation at any point becomes a pure function of
  distance to the nearest relevant boundary segment and its
  classification. Cheap, fully stateless, fits the "query the field
  anywhere" approach the substrate decision already committed to — but has
  no memory: a boundary active for 10 epochs looks identical to one that
  just formed, which loses a real axis of realism (older, longer-active
  collisions build taller ranges; e.g. Himalaya vs. a young island arc).
  Its query-anywhere property carries forward into A3 below.
- **A3. Hybrid** — persistent state lives along the boundary
  *curves* themselves, not the full surface and not one scalar per whole
  segment: each point along a boundary curve accumulates something like
  cumulative crustal shortening/thickness, driven each epoch by that
  point's current convergence rate (from the decomposition above) and
  relaxed/consumed by later phases (erosion, mainly — out of scope here).
  This is real forcing-and-response with memory, at a fraction of A1's
  state — a 1D field along a handful of curves, not a 2D accumulator over
  the whole sphere. The full elevation field stays exactly what A2
  proposed — a stateless distance-field falloff, evaluable at any point,
  fitting the "query the field anywhere" approach the substrate decision
  already committed to — except the falloff's amplitude at each spot comes
  from the accumulated thickness at the nearest point on the boundary
  curve, not a flat per-segment constant. Converting accumulated thickness
  to actual elevation should use a simple isostasy-style relation (more
  buoyant/thicker crust sits higher) rather than a flat linear scale —
  cheap (a per-point formula, not a simulation) and ties back to why
  continents and ocean floors sit at different baseline elevations in the
  first place.

### B. Rift / merge mechanics

Deferred from the Initial State doc — under B2, plates need rules for
splitting and fusing across epochs. Mechanism is settled as a consequence
of A3: both events are threshold crossings on the same per-boundary-curve
accumulated state, not a separate system.

- **When does a plate split?** A divergent boundary curve's accumulated
  extension crosses a threshold and spawns a new seed at the rift.
- **When do two plates effectively become one?** A continent-continent
  convergent boundary curve's accumulated thickness/locking crosses a
  threshold, held for enough consecutive epochs.
- Still open: the actual threshold values and how many consecutive epochs
  "locked" needs to hold — tuning detail, not a design fork, left for
  later.

### C. Computational / performance envelope

"As close to real as possible while still fun" is a budget, not just a
goal — plate count, epoch count, and the authoritative simulation
resolution all trade fidelity against how fast you can run a batch of
epochs and look at the result (per the earlier call that you want to run
N epochs, view, run more, without needing a fast interactive framerate but
without wanting to wait minutes between looks either). This likely isn't
a single either/or choice so much as a set of tunable ceilings to pick
deliberately rather than let fall out of whatever the first working
implementation happens to cost.

## Decision

- **Elevation/mountain model: A3.** Persistent state lives along boundary
  curves (cumulative crustal shortening/thickness per point), the full
  elevation field stays a stateless distance-field query over that state,
  and thickness converts to elevation via a simple isostasy-style
  relation. Chosen for realism — this is a forcing/response model with
  real memory, per Cordonnier et al., rather than either a memoryless
  lookup or a full-surface accumulator.
- **Rift/merge (B): mechanism resolved**, as a direct consequence of A3
  — both are threshold crossings on the same boundary-curve state. Exact
  threshold values are a tuning detail, not decided here.

Deferred: C (computational/performance envelope) — agreed this is a tuning
concern to revisit later, not a real design decision to make now.

## Implementation refinements (A3, built)

A3 shipped, then got a round of realism work aimed specifically at making
mountains read as mountains. These are refinements *within* A3, not
reopenings of the decision above; recorded so the shape isn't rediscovered
from the code.

- **Ridge lines, not blob clouds (capsule falloff).** A terrain feature is
  an *oriented* segment, not an isotropic blob: elevation falls off over a
  short distance *across* the boundary tangent and a long distance *along*
  it (`elevationField.ts`). Consecutive features on one boundary overlap
  end-to-end into a continuous linear range instead of a row of domes. The
  cross-section uses distance to a *finite* capsule segment, not an
  ellipse — an ellipse's long axis overshoots at boundary curves and threw
  "starburst" needles out into the ocean. Feature contributions are
  normalized by `÷max(1, weightSum)` (not `÷weightSum`), so an isolated
  feature keeps its natural falloff instead of being flattened to a plateau.
- **Asymmetry + trenches.** Ocean–continent subduction builds an
  asymmetric arc on the overriding side plus a paired trench offset toward
  the downgoing plate (a real cross-section, not a symmetric bump).
- **Ridged multifractal on the uplift.** Uplift amplitude is modulated by a
  cached ridged-multifractal field (`ridgedNoise.ts`) so ranges get
  fractal spurs and crestlines rather than smooth humps. Cached per world
  (a pure function of position + warp seed), not recomputed per epoch.
- **Erosion as a coupled finishing pass, not a separate stage.** The
  dedicated erosion step stayed, but as a *finishing* pass that couples
  uplift with stream-power incision and thermal (slope-limited) diffusion
  in a relaxation loop (`erosion.ts`), rather than three independent
  post-effects. Peak-weathering was **removed** — it was redundant once the
  ridged multifractal shapes crests directly.
- **Oceanic feature subsidence.** Purely-oceanic features decay their
  thickness a little each epoch (`OCEANIC_SUBSIDENCE_DECAY_PER_EPOCH`),
  countering the fact that every oceanic boundary interaction only ever
  *adds* uplift — without it, old seafloor slowly accumulated ridge/arc
  uplift and drifted above sea level. (This replaced an earlier per-plate
  age-subsidence baseline, now gone with the plate-type baseline; ocean
  depth proper comes from the raft subsystem's ocean-age field.)

Crust type feeding all of the above is no longer a plate property — see
[continental-crust-rafts.md](./continental-crust-rafts.md).

## Status

built — the doc grew with the sim, and several original choices were
reworked in place (peak-weathering removed, subsidence replaced; crust type
moved to the raft model, see continental-crust-rafts.md)
