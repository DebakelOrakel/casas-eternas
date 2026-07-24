---
summary: Continental crust modeled as persistent "rafts" decoupled from the kinematic plates, so land/ocean ratio is emergent and conserved.
date: 2026-07-24
status: decided; Phases 1–4 implemented
---

# Continental Crust: Rafts Decoupled from Plates

**Status:** Decided, and **Phases 1–4 are implemented** — see
[Implementation status](#implementation-status-phases-14) at the end for
what was built and where it deviates from the design below. Revises the
"each plate is wholly continental or wholly oceanic" assumption from
[plate-tectonics-initial-state.md](./plate-tectonics-initial-state.md) —
that stays true for the *kinematics*, but crust type is no longer a plate
property.

## Goal

Make the land/ocean ratio an **emergent, conserved** outcome of the
simulation rather than a value fixed at spawn that only ever drifts. Get
the geology of crust formation right enough that continents behave like
real continents: nearly permanent, slowly growing, splitting and
re-welding across the supercontinent cycle.

## The problem with the current model

The flat generator conflates two things real geology keeps separate:
**a plate is assigned a crust type** (continental / oceanic), and its
whole Voronoi territory is that type. Consequences:

- **Land can only shrink.** Rifting always spawns a new *oceanic* plate
  ([applyRift]), converting continental territory to ocean, and nothing
  ever creates new continental crust back. Confirmed: land drifted 17% →
  7% over 100 epochs in a headless run. There is no homeostasis (the
  sphere version's `adaptContinentalWeights` was never ported, and there
  is no land-ratio knob).
- **It's geologically backwards.** Real oceanic crust is a fast conveyor
  (created at ridges, destroyed at subduction, all <200 Myr old); real
  continental crust is felsic, buoyant, *doesn't subduct*, is up to ~4 Gyr
  old, and **grows** over time via arc magmatism and terrane accretion.
  The current model has the oceanic half right and the continental half
  missing entirely.
- **Real plates aren't one crust type.** The North American plate carries
  the continent *and* the western half of the Atlantic seafloor; its
  boundary (the Mid-Atlantic Ridge) is far from any coastline. Continents
  are *rafts riding on* plates, not the plates themselves.

## Decision: the raft model

Two decoupled layers.

- **Plates** stay as the kinematic units — Voronoi seeds with Euler-pole
  motion, age, and boundary tectonics, exactly as today, **minus** their
  `type`/`baseElevation`/name. A plate is just a moving piece of
  lithosphere.
- **Continental crust** becomes a separate set of persistent **rafts**
  that ride on plates. Rafts are **conserved** (never subduct), **grow**
  at arcs, **merge** on collision, and **split** at rifts.
- **Oceanic crust** is the default everywhere a raft isn't, with an
  age-depth field driving its depth.
- **Land fraction = raft coverage** → emergent and conserved.

### Raft representation: metaball blobs

A raft is a set of soft **blobs** (center + radius); their union is the
continent's outline. A point is "continental" where the summed metaball
field exceeds a threshold — a distance-field query, so it stays analytic
and query-anywhere (fits the A3 model and the domain warp for ragged
coastlines), and small enough to keep in the frozen server snapshot.
Chosen over polygons (hard to grow/split/merge) and a full raster (fights
query-anywhere / transfer): blobs make irregular shapes from clusters, and
grow/merge/split are natural blob-set operations.

### Raft lifecycle (where the realism lives)

- **Motion:** each blob rides its host plate (the plate whose Voronoi cell
  contains the blob center) — advances with that plate's rotation each
  epoch, like terrain features do now. Host is re-resolved as it drifts.
- **Rift:** a plate rifts → new *oceanic* plate in the gap (unchanged).
  A raft on the rifting plate has its blobs partitioned across the rift
  line; a raft straddling it **splits** into two. No continental crust is
  created in the gap — rafts are conserved, just separated. This is
  continental breakup (Pangaea → continents), and it's what fixes the
  land-loss bug.
- **Subduction (ocean–continent convergence):** the oceanic plate
  subducts; the raft on the overriding side **grows** — a new/enlarged
  blob toward the trench each epoch (Andean-type arc magmatism building
  new crust).
- **Island arc (ocean–ocean convergence):** spawns a small proto-
  continental blob at the arc, which can later drift into and accrete onto
  a larger raft (terrane accretion).
- **Collision (continent–continent convergence):** two rafts **merge**
  into one (suturing); the fold-mountain range at the seam is already the
  existing feature system's job.
- **Conservation:** total raft area only grows (accretion/arcs) or holds
  (split/merge), never shrinks — so land grows slowly from its starting
  value, as on Earth. (If very long runs need a ceiling, a little
  subduction-erosion loss can be added later; omitted for now.)

### Oceanic crust age: an advected coarse field

Age-depth (ocean floor deepens as it ages away from the ridge) is modeled
with a **coarse full-surface age field** advected with plate motion each
epoch, reset to 0 at divergent boundaries (fresh crust). Oceanic baseline
= `OCEANIC_BASELINE − k·√age`. This is a deliberate, *bounded* exception to
the "no full-surface accumulator" stance: it's only the ocean-age scalar,
which is inherently smooth and large-scale (coarse resolution is plenty),
unlike the A1 uplift accumulator that stance rejected. Chosen over a
distance-to-nearest-ridge proxy (loses history — an old basin far from any
current ridge) because the user wants real spatial age.

### Baseline / rendering

`computeBlendedBaselines` becomes a **raft-membership field**: oceanic by
default (with age-depth), continental inside rafts, with a soft coastal
transition at raft edges (domain warp still ruffles it). Boundary
classification asks "is there a raft on side A / side B?" instead of
reading `plate.type`. The feature layer (capsule ridge/trench chains) is
unchanged — it hangs off boundary classification, not off plate type.
Continent names attach to rafts (a raft *is* a continent).

### Initialization knobs (revised)

The old sliders are re-cut, since "continental plate count" is meaningless
once plates have no type:

- **Plate count** — kept (kinematic plates).
- **Initial land fraction** (replaces continental-plate count) — sets the
  starting raft coverage directly (e.g. 10–40%), which then grows
  emergently. Matches the "you set the start, the sim evolves it"
  philosophy.
- **Clustering** — dispersed vs. supercontinent, since real continents are
  grouped (supercontinent cycle), not randomly scattered.
- **Craton count** — a "Continents" slider (direct control over how many
  separate continents to seed). Originally intended to be seed-derived to
  keep the UI minimal, but promoted to an explicit knob during Phase 1
  since direct control turned out to be wanted; land fraction is held by
  calibration regardless of the count.

Also at init, independent of rafts but the natural place for it:
**skewed plate sizes** instead of the old ~equal-area Poisson-disc cells,
since real plates span a ~400× size range (Pacific ↔ Juan de Fuca). Built
via non-uniform seed placement (per-seed skewed "reach"), not weighted
Voronoi — and the bigger lever turned out to be plate *count*: dropping the
range to 5–13 (default 8) measures out earthlike (largest plate ~15–18% of
the surface, ~7 plates cover 90%, like Earth's majors). The full 400× ratio
isn't reproduced, but that's Earth's microplate tail, not its major plates.

## Impact map

- **New:** `rafts.ts` — blob data structure; creation; growth (accretion);
  split (rift); merge (collision); motion (ride host plate); membership
  query.
- **Reworked:** `plateBaseline`/`computeBlendedBaselines` → raft-membership
  + ocean-age baseline field; `boundaryClassification` → crust type from
  rafts, not `plate.type`; `plateSimulation.stepEpoch` → raft advance /
  accretion / split / merge alongside the existing plate rift/merge; init
  (`plateSeeds`/`plateTypes`) → typeless plates + raft init + skewed sizes;
  the ocean-age field advection; UI sliders.
- **Unchanged:** plate kinematics (motion, Voronoi, boundary detection),
  the feature layer (capsule chains, trenches), erosion.
- **Export snapshot:** carries rafts (blob positions/radii) + the ocean-age
  field instead of per-plate types.

## Deferred / tuning (not design forks)

- Accretion rate (how fast continents grow at arcs) — a constant, tuned
  visually. Starting point: slow enough that land rises only modestly over
  a ~100-epoch run.
- Metaball threshold, blob radii, split/merge thresholds — visual tuning.
- Ocean-age field resolution and the age-depth coefficient.

## Implementation status (Phases 1–4)

Built 2026-07-24, all verified via a headless render harness:

- **Phase 1 — foundation.** `rafts.ts` (metaball blobs, `raftMembership`,
  `generateInitialRafts` with land-fraction calibration + clustering, rigid
  drift on a host plate). Baseline from raft membership
  (`computeRaftBaseline`). Land is emergent + conserved — the 17%→7% loss
  bug is gone. UI sliders re-cut (land fraction, clustering, continents).
- **Phase 2 — lifecycle.** Accretion at subduction arcs (continents grow →
  land rises over a run); merge on contact; breakup via a **continental
  rift** (a divergent boundary *under* a continent, deliberately separate
  from the plate rift, which fires at oceanic ridges). The supercontinent
  cycle oscillates over a run.
- **Phase 3 — ocean age.** `oceanAge.ts`: a coarse advected age field,
  reset at ridges, driving `OCEANIC_BASELINE − k·√age`.
- **Phase 4 — plate sizes.** Skewed non-uniform placement + the plate-count
  range drop above.

### Deviations from the design above

- **Breakup is limited by fixed plate motions.** Plates that converged to
  assemble a supercontinent keep converging, so divergence under it is
  scarce; the continental-rift trigger is deliberately lenient to
  compensate. Truly realistic breakup needs evolving Euler poles — a
  deferred, bigger feature (the "drift doesn't evolve" gap flagged in
  [plate-tectonics-initial-state.md](./plate-tectonics-initial-state.md)).
- **Boundary classification still reads a DERIVED plate type**
  (`derivePlateTypes` — continental if a raft covers the seed), a Phase-1
  bridge, not the direct "is there a raft on side A/B?" the design
  describes. Fine in practice; cleanup deferred.
- **Raft motion is rigid** (whole raft on one host plate), not per-blob.
- **Island-arc proto-continent birth** not built yet.
- `plate.type` / `baseElevations` / per-plate `continentNames` still exist
  as vestigial shims; continent labels are off pending per-raft labels.

## Remaining

- **Phase 5 cleanup:** remove the vestigial plate.type/baseElevations
  machinery; move the export snapshot to rafts + ocean-age; add the raft
  subsystem's architecture notes to [world-gen.md](../design/world-gen.md)
  (still a TODO — world-gen.md does not yet describe rafts).
- **Phase 2 optionals:** island-arc births; boundary classification from
  direct raft geometry.
- **Toggleable overlays** (plate lines / per-raft names / arrows).
- Revisit later whether further design decisions warrant their own docs.
