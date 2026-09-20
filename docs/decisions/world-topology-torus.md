---
summary: The shipped generator's substrate is a flat torus (wraps in x and y), not the unit-sphere substrate plate-tectonics-initial-state.md decided — this document records that pivot, retroactively.
date: 2026-07-23
area: generator
stage: built
status: decided; implemented
---

# World Topology: Flat Torus, Not a Sphere

**Status:** Decided and implemented well before this document existed —
written up on 2026-08-06 because the pivot away from
[plate-tectonics-initial-state.md](./plate-tectonics-initial-state.md)'s A2
sphere substrate had never been recorded anywhere in the repo. It only
existed as an assistant's memory of a conversation, which is exactly the
kind of fact that should not depend on an AI's memory persisting. This
document is the missing record, not a new decision — nothing in the code
changes as a result of writing it.

## What changed

[plate-tectonics-initial-state.md](./plate-tectonics-initial-state.md)
decided **A2: continuous unit-sphere points** — plate seeds as free 3D
points on a unit sphere, Voronoi cells via geodesic distance, Euler poles as
3D rotation axes. `client/src/worldgen-sphere/` is that implementation, and
it still exists in the tree.

The shipped generator (`client/src/worldgen/`) does not do this. Its
substrate is a **flat torus**:

- A 2D plane of `MAP_WIDTH × MAP_HEIGHT` pixels (`core/mapConfig.ts`,
  currently 2048×1024) that wraps independently in both axes — not a
  bounded rectangle, not a sphere.
- Distance is wrapped-Cartesian, the minimum-image convention
  (`toroidalDistanceSq` in `core/toroidal.ts`), not geodesic distance on a
  curved surface.
- "Euler pole" motion is not a 3D rotation axis. It is a 2D drift + spin
  about a plate's own centroid (`plateMotion.ts`), advanced each epoch by
  rotating in the centroid's own **locally-unwrapped frame** and
  re-wrapping the result — because a flat torus does not admit an
  arbitrary rotation as a *global* isometry the way a sphere does (a
  rotation about an off-center point contradicts itself at the wrap seam
  if applied globally; it is well-posed only as a local operation around
  each plate's own nearby center). See `rotateAroundCenter`'s own comment
  in `core/toroidal.ts`.
- Erosion, hydrology, and the mantle field all wrap in *both* axes
  (`flowRouting.ts`'s D8 neighbor lookup, `mantleField.ts`'s Poisson solve),
  where the sphere version only wrapped longitude and clamped at the poles.

Climate (`docs/decisions/climate-biomes.md`) layers a **second, independent
decree** on top of this: for latitude purposes only, it treats the y-axis as
an equirectangular cylinder projection of a sphere (an explicit "pure design
decree, no physical justification needed," per that document). That is not
a partial reversion to sphere geometry — the tectonic/erosion/hydrology
substrate underneath stays the flat torus described above; only climate's
own latitude bookkeeping borrows the cylinder framing.

## Why a torus instead of a sphere

Reconstructed from context, since the original decision predates any
written rationale:

- It fits [vision.md](../vision.md)'s eventual gameplay shape better than a
  sphere/cube-sphere does — a flat, wrapping playable map with local hex
  overlays doesn't need a planet's polar geometry at all.
- It removes pole handling as a concern everywhere in the pipeline
  (tectonics, erosion, hydrology, mantle flow) — no clamped rows, no
  area-distortion correction (`cellAreaWeight` in the sphere tree's grid
  code), no polar singularity for wind/currents to navigate.
- It is a strictly simpler substrate than A2 was already chosen to be
  simpler than A1/A3 for: no polyhedron, no corner or pentagon defects, no
  geodesic-distance computation — wrapped-Cartesian distance is exact and
  cheap.

If there was more to the original reasoning than this, it's worth folding
in here later; nothing above should be read as claiming certainty about
motivations this document wasn't present for.

## Consequences

- `client/src/worldgen-sphere/` and `client/src/screens/worldgen-sphere/`
  are **legacy** — kept for reference, out of scope for the current
  worldgen branch (see the `project-branch-scope-worldgen` memory note).
- [plate-tectonics-initial-state.md](./plate-tectonics-initial-state.md)'s
  A2 decision (unit-sphere) is superseded by this document for the shipped
  generator. That document is left as the historical record of the
  substrate/depth/parameter fork, not rewritten — its A2 write-up is simply
  no longer what runs.
- [plate-tectonics-simulation.md](./plate-tectonics-simulation.md)'s A3
  elevation model (boundary-curve state + stateless distance-field
  falloff) is **topology-independent in its own reasoning** and needed no
  change at all when the substrate changed underneath it — it never
  assumed sphere geometry, only "distance to a boundary curve," which a
  flat torus still gives it for free.
- [evolving-euler-poles.md](./evolving-euler-poles.md) was written directly
  against the torus (drift+spin, not a 3D axis) and needs no correction.

## Errata added elsewhere

Both `plate-tectonics-initial-state.md` and `plate-tectonics-simulation.md`
now carry a pointer to this document near their own substrate discussion.
`plate-tectonics-initial-state.md`'s "Follow-up resolutions" section also
had a stale entry ("Drift-update rules — not resolved") that is no longer
true as of `evolving-euler-poles.md` M1–M3; marked resolved there, not
here, to keep the correction next to the claim it corrects.
