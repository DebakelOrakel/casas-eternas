---
summary: Spatial substrate and initial per-plate parameters for the tectonics simulation.
date: 2026-07-20
status: decided
---

# Plate Tectonics: Initial State

**Status:** Decided — substrate, simulation depth, and initial per-plate
parameters all settled.

**Superseded (substrate only):** the A2 substrate decided below (continuous
unit-sphere points, geodesic Voronoi) was later replaced by a flat torus for
the shipped generator — see
[world-topology-torus.md](./world-topology-torus.md) for what changed and
why. Simulation depth (B2) and the per-plate parameters below are
topology-independent and still apply unchanged.

## Goal

Define the starting spatial substrate and initial per-plate parameters for the
tectonics simulation, chosen so it can plausibly produce realistic,
boundary-driven mountain formation (fold ranges, subduction arcs, rifts) as
its primary output.

The long-term direction is a simulation that behaves like real plate
tectonics over deep time: plates don't just drift and collide once, they
rift apart and later re-collide across multiple epochs, the way real
continents split and reform (supercontinent-cycle style). A full multi-epoch
simulation is an explicit stretch goal, not a v1 requirement — but whatever
initial state we settle on here shouldn't foreclose that direction. A
single-epoch v1 should be extensible toward multi-epoch simulation later
without a fundamental rework of the substrate.

"As close to real plate tectonics as possible, while still fun to generate"
is the guiding tension for every option below.

## Options

### A. Spatial substrate (where plate seeds live)

This is about the substrate the *simulation* runs on, not how the planet is
later rendered. Whether the renderer ends up using a cube-sphere, an
icosphere, or something else is a separate, independently-deferrable
decision — it only gets coupled to this one if the option chosen here is
itself grid-locked (A1, A3, A4 below). Only A2 fully decouples the two: a
continuous field can be sampled by whatever render grid we pick later
without reprojection. That decoupling is a point in A2's favor, not a
reason to skip this decision.

- **A1. Cube-sphere grid** — reuse the rendering/LOD grid directly, snap
  seeds to cells. Simplest, one grid to reason about. Inherits the
  cube-sphere's corner distortion (8 corners) into plate geometry, which has
  no geological meaning. Ties the tectonics substrate to whatever the
  render grid turns out to be.
- **A2. Continuous unit-sphere points** — plate seeds as free 3D points
  (e.g. Fibonacci-sphere or spherical Poisson-disc placement), Voronoi
  cells via geodesic distance. No grid bias. Fully independent of whatever
  render grid gets chosen later — that grid just queries this field.
  Two coordinate systems to keep straight instead of one.
- **A3. Icosahedral/geodesic grid** — subdivided icosahedron, the classic
  "hex-globe" substrate. More uniform than cube-sphere but has its own
  distortion points (12 pentagon defects). Still grid-locked like A1.
- **A4. Lat-long raster** — simplest to reason about, worst fit for a
  sphere (pole singularity, heavy area distortion near poles). Likely ruled
  out.

### B. Simulation depth (how much tectonic history do we actually simulate)

- **B1. Single-epoch** — plates spawn once with a type/age/drift, one
  convergence pass (or a short fixed number of steps) settles the final
  geography. Continents are whatever shape falls out of that one pass.
  Simpler, no notion of "history," nothing to rift or re-collide.
- **B2. Multi-epoch** — plates drift over many simulated steps; boundaries
  can diverge (rift, spawning new oceanic crust) as well as converge; a
  plate that was one landmass can split, and separated landmasses can
  later collide again. Continents and mountain ranges become a record of
  accumulated history rather than a single pass — this is the "as close to
  real as possible" direction. Substantially more to design and tune
  (how many epochs, how do splits/merges work, when does it stop).

These two axes interact: A2 (free points, geodesic distance) generalizes
more naturally to B2, since rifting/splitting a plate is just adding new
seed points and re-partitioning — no grid-cell bookkeeping involved. A1
would need extra work to handle a plate's cube-sphere cell membership
changing mid-simulation as it splits.

### C. Initial per-plate parameters (whichever substrate/depth we pick)

- **Continent count** — user-settable parameter: number of initial
  continental-plate seeds. Only fixes the *starting point* — under B2 the
  count drifts over the run as continents rift apart (more) or collide and
  fuse (fewer).
- **Type** (continental / oceanic) — random placement given the continent
  count above: exactly N seeds get continental, the rest oceanic;
  randomness is in position/identity, not in whether the target count is
  hit.
- **Land/ocean ratio** — a separate knob from continent count: how much
  total surface area continents cover, independent of how many separate
  ones there are. Likely achieved by weighting how much area continental
  seeds claim (not just seed counts), exact mechanism left for later.
- **Age** (scalar) — not a spawn-time parameter. Falls out of B2: tracked
  and updated by the simulation (new crust at a rift starts young, crust
  consumed at a subduction zone stops existing). Drives the
  oceanic-oceanic subduction tiebreak (older/denser subducts) and mountain
  character (young collision = jagged/tall, old = eroded/rounded).
- **Drift (Euler-pole rotation, not a vector)** — on a sphere, rigid-body
  motion is a rotation about an axis, not a translation; a per-plate
  "drift vector" doesn't stay meaningful as a point moves across curved
  surface without constant re-projection, and structurally can't produce
  the along-boundary velocity variation real boundaries have. Each plate
  instead gets a random rotation axis (a 3D unit vector — the Euler pole)
  and an angular speed at spawn; a point's velocity anywhere on the plate
  is a direct calculation from those two values. Both evolve over epochs
  rather than staying fixed, reacting to current boundary state
  (subduction/rift → accelerate, active continent-continent collision →
  decelerate/lock). Lightweight and reactive, not a force/mantle
  simulation — full mantle-convection-driven drift stays a further-out
  stretch item on top of this.

## Decision

- **Substrate: A2** — continuous unit-sphere points, geodesic-distance
  Voronoi. Fully decoupled from whatever render grid comes later.
- **Seed** — user-choosable. Every "random" piece above (continent
  positions/type assignment, drift vectors, land/ocean weighting) is
  derived from this single value, so a given seed always regenerates the
  same starting state and the same epoch-by-epoch history under B2. A
  random seed is generated if the user doesn't supply one.
- **Simulation depth: B2** — multi-epoch. Plates rift and re-collide over
  the run rather than settling in a single pass; mountains and continents
  are a record of accumulated history. Chosen over B1 for being both more
  realistic and more fun to run/watch, at the cost of more to design and
  tune (rift/merge rules, epoch count, stopping condition — left for a
  follow-up decision, not this doc).
- **Initial per-plate parameters:**
  - Continent count — user-settable starting parameter; changes over the
    run under B2.
  - Type — random placement given that count (exact N continental, rest
    oceanic).
  - Land/ocean ratio — separate user-settable parameter from continent
    count, controlling total area rather than number of continents.
  - Age — not a spawn parameter; falls out of B2, tracked by the
    simulation.
  - Drift — Euler-pole rotation (axis + angular speed), not a vector;
    randomized at spawn, then evolves per epoch based on current boundary
    state (subduction/rift accelerate, collision decelerates/locks); full
    mantle-convection-driven drift remains a further-out stretch item.

## Follow-up resolutions

Status of the follow-ups named above, as of the first working
implementation (`client/src/worldgen/plates.ts`, `crust.ts`):

- **Area-weighting mechanism — resolved.** Continental seeds get an
  additive weight in the Voronoi cost function, calibrated at generation
  via binary search against sampled points to hit the target ratio. A
  single weight calibrated once and left alone drifted badly over long
  runs — one run swung from 36% land down to 9% purely from plates
  rotating into a crowded configuration, no tectonic event involved — so
  each continental plate's weight is now also nudged every epoch toward
  its fair share of the target ratio (`adaptContinentalWeights`),
  reusing the boundary-detection pass's own sampling as the area signal
  rather than a separate measurement.
- **Age-tracking rules — resolved.** Age increments every epoch and
  resets to 0 for a plate born from a rift, driving both effects named
  above: the oceanic-oceanic subduction tiebreak (older/denser subducts)
  and mountain character (younger collisions build faster; the
  multiplier decays by half every ~150 epochs).
- **Rift/merge mechanics — resolved**, mechanism and thresholds both.
  See [plate-tectonics-simulation.md](./plate-tectonics-simulation.md)
  for why the exact threshold values are a tuning detail rather than a
  design fork.
- ~~**Drift-update rules — not resolved, and this is a real gap, not just
  an unaddressed followup.**~~ **Resolved 2026-07-25.** The Decision above states drift should
  "evolve per epoch based on current boundary state." The current
  implementation never does this: every plate's Euler-pole axis and
  angular speed are fixed at spawn for its entire life. Full
  mantle-convection-driven drift was already flagged above as a
  further-out stretch item, but even the lighter reactive version decided
  here (subduction/rift accelerates, active collision decelerates/locks)
  hasn't been built. See [evolving-euler-poles.md](./evolving-euler-poles.md)
  M1–M3: plate motion is now fitted each epoch to an evolving mantle-convection
  field (the fuller version, not just the lighter reactive one this bullet
  originally asked for), superseding the fixed-at-spawn motion described above.
- **Epoch stopping condition — still open.** Not addressed. May not
  need one, since world creation is user-driven (click to advance a
  chosen number of epochs) rather than something that runs
  unsupervised — worth confirming that's actually sufficient rather than
  assuming it, if unattended/batch world creation ever becomes a goal.

Boundary convergence/elevation modeling built on this kinematic model is
decided separately in
[plate-tectonics-simulation.md](./plate-tectonics-simulation.md).
