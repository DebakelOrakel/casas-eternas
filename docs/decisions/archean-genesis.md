---
summary: Replace the Genesis sliders with a short, watchable Archean simulation — crust nucleates over oceanic mantle upwellings, drifts on the mantle flow with no plates, and stabilises into cratons; plate count and land fraction become emergent.
date: 2026-07-28
status: designed; not implemented
---

# Archean Genesis: deriving the tectonic starting state

**Status:** Designed, nothing built. Extends
[continental-crust-rafts.md](./continental-crust-rafts.md) — the raft model is
what makes this possible at all — and replaces the initial-state generation from
[plate-tectonics-initial-state.md](./plate-tectonics-initial-state.md).

## Goal

Today the Genesis panel asks the user to *dial in* the answer: plate count, land
fraction, craton count, clustering. Those values were themselves chosen to make
the simulation start somewhere reasonable — they encode an outcome, not a cause,
and they leave the obvious question unanswered: **why is this continent here?**

Replace them with a short simulation of the Archean that *produces* the starting
state, and move the remaining knobs to quantities that are physically real and
worth choosing (how much water this planet got, how vigorous its mantle is).

## Why the architecture already fits

Three pieces are in place, which is most of why this is worth doing now:

- **The mantle field is already the driver.** `evolveMantleField` →
  `computeMantleFlow` → `fitMotionsToFlow` drives the plates today. The Archean
  needs the same chain minus the last step.
- **Rafts are already decoupled from plates.** That is exactly what an Archean
  needs, because in the Archean *there are no plates* — plate tectonics initiates
  somewhere around 3.0–2.5 Ga (contested). Crust drifts directly on the mantle
  flow, and plates are seeded at the end, which is the physically correct order.
- **`RaftBlob.birthEpoch` already exists**, and `computeCratonOldnessField`
  already reads it to place iron in the Ecology layer. Today those ages are
  largely fiction ("0 for the original nuclei"). An Archean phase makes them real.

## Background: when was there water?

Relevant because it decides whether the Archean runs on a wet or dry planet.

The eon before the Archean is the **Hadean** (~4.54–4.03 Ga). The old picture of a
500-Myr dry hellscape has been substantially revised: zircons from the Jack Hills
(Western Australia), up to ~4.4 Ga, carry elevated δ¹⁸O signatures indicating they
crystallised from magmas that had interacted with **liquid water at or near the
surface**. Oceans therefore likely existed within ~150 Myr of Earth's formation
(the "cool early Earth" hypothesis).

**So the Archean runs on a wet planet, and this simulation starts with ocean
everywhere and no land.** The Hadean itself — magma ocean, no permanent crust —
is not worth simulating; it is the *initial condition*.

Where the water came from is genuinely unsettled, which is what makes water volume
a legitimate knob rather than a fudge: carbonaceous chondrites match Earth's D/H
ratio well and are the leading candidate; comets are largely excluded as the main
source (most measured have roughly double Earth's D/H); and an indigenous share
accreted with the planet has been revised upward.

---

## Decisions

### 1. Nucleation: hot **and** currently ocean

**This is the one that decides whether the result is cratons or porridge.**

`evolveMantleField` heats the mantle under continents and cools it under ocean:

```ts
if (membership > 0.5) field[i] += INSULATION_RATE   // continent insulates
else                  field[i] -= OCEAN_COOL_RATE   // ocean cools
```

So continents *create* upwellings beneath themselves. A naive "crust nucleates
over upwellings" rule is therefore a positive feedback — crust grows where crust
already is — and collapses into two or three blobs that eat everything.

Reality runs the other way: Archean crust formed over **oceanic** plateaus, by
plume-driven partial melting of hydrated basalt (the TTG suites). Only once a
craton exists does its insulation build the dome that later rifts it.

| Option | |
|---|---|
| **Chosen — mantle threshold + persistence, restricted to ocean** | Crust nucleates where the field is above a threshold, has been for N epochs, and the cell is not already crust. The persistence requirement stops flickering; the ocean requirement breaks the feedback. |
| Discrete plumes | Reuse the existing fixed hotspot points. Tidier, less organic. |
| Seed everywhere, select by survival | Nucleate randomly, let only crust over upwellings persist. More noise for the same result. |

### 2. Destruction: young crust recycles, stabilised crust does not

**Without a sink the model runs away** — this is not hypothetical, it is the
[open runaway bug](./continental-crust-rafts.md): land fraction goes 0.30 → 0.64–0.78
over 5 seeds because accretion has no counterweight. An Archean phase that
*produces* crust inherits that defect and moves it to the start.

The physical sink is real and well documented: most early crust was destroyed by
delamination and drips; what survived was crust that had stabilised into thick,
depleted, buoyant cratonic keels.

**Decision:** crust below a stabilisation age, sitting over a downwelling, is
destroyed. Above that age it is immune.

This buys three things at once:

- an **equilibrium** rather than a runaway, which is what delivers the
  "roughly balanced, but sometimes more and sometimes less land" requirement
  without prescribing a target;
- the **crust sink the tectonics phase already needs** — so it should be built
  first, independently, as a fix rather than as part of this feature;
- the answer to *cratons or porridge* — stabilisation is precisely what makes a
  craton a craton.

### 3. Movement: directly on the mantle flow, no plates

Crust advects on `computeMantleFlow`'s field rather than on plate motions. The
only code this needs is a variant of `advanceRafts`, which currently takes
`seeds`/`motions` and picks a host plate.

### 4. No topography in the Archean

Crust extent and age only — no terrain features, no mountains, no boundary
lattice. Elevation already derives from raft membership through the margin
profile, so land appears for free. Fewer moving parts, and nothing here needs
relief.

### 5. Plate count is emergent

When the Archean ends, Voronoi seeds are placed on the mantle convection cells.
The number of plates therefore falls out of the convection pattern rather than
being dialled — which is the same reasoning that makes land fraction emergent.

### 6. Water volume shifts the anchors, **not** sea level

The elevation scale stays exactly as it is: `-1..1`, `SEA_LEVEL = 0`. That signed
zero is load-bearing — every land/ocean test is a sign test, and several are
hardcoded (`applyMountainRedistribution`'s `elevation <= 0`, the renderer's
`elevation > 0` land bit). Moving sea level would mean auditing all of them and
giving up the property.

"More water" and "sea level rises" are the same statement in two coordinate
systems. Expressed with sea level pinned at zero, more water means the solid
surface sits **lower relative to it** — which is also the isostatically honest
description: added water loads the basins, continents float relatively lower, and
**freeboard decreases**.

Implementation is a single offset on the reference heights in `elevationScale.ts`:

```ts
const SEA_LEVEL_OFFSET_M = 0                    // the Genesis water knob
const anchor = (m: number) => metersToElevation(m - SEA_LEVEL_OFFSET_M)
export const LAND_BASE = anchor(360)
export const SHELF_BREAK = anchor(-140)
// …
```

Everything downstream follows: the margin profile is defined through these
anchors, the colour ramp is stated in metres *relative to sea level* and stays
correct, and the lapse rate keeps measuring from 0.

**The headroom is asymmetric and worth respecting.** More water (anchors down):
`ABYSSAL_FLOOR` is at −0.633 against a −1 clamp, so ~3300 m of room. Less water
(anchors up): peaks run at the +1 clamp, where 0.13% of cells already saturate
today. Earth's oceans correspond to ~2.7 km of globally-averaged depth, so a
range of roughly ±1350 m reads as "half to one-and-a-half Earth oceans" — roomy
downward, tight upward.

**Consequence worth having:** crust production and water volume become genuinely
independent. The same crustal history can be started as an archipelago world or a
Pangaea world without changing the simulation.

### 7. Start/stop, and when it becomes final

Mirrors the Tectonics panel exactly — the worker already has the machinery
(`start`/`stop` handlers, the interval stepper, the `renderInFlight` guard,
preview resolution while running and full resolution when paused). New entries in
the handler table, no new concept.

- **Stop is a pause, not a commit.** The simulation can be resumed.
- **It becomes final when the next phase is started**, with a reset back into the
  Archean available.

Stopping by eye rather than by a duration slider is deliberate: you see the result
instead of predicting it, which is the honest way to get "sometimes a lot of land,
sometimes little".

### 8. Save format needs nothing new

The save already stores both the recipe (`world.yaml`) and the full state
(`state.json`: seeds, motions, types, features, rafts, sutures, ages, epoch) plus
the `.f32` rasters. **The Archean's output *is* that initial state**, so it is
already serialised. Loading stays instant; the Archean only runs at creation. The
recipe gains the Archean parameters (seed, water volume, mantle vigour, and the
epoch at which the user stopped) so a world stays reproducible.

---

## What it looks like on screen

Deliberately a small simulation that shows something. The mantle overlay already
exists and is already enabled for the Genesis panel.

1. **No land.** Ocean everywhere, the mantle overlay showing red upwellings and
   blue downwellings.
2. **Crust patches appear over sustained red regions**, not scattered at random —
   like island groups surfacing.
3. **They drift** on the flow toward the downwellings and gather.
4. **They collide and weld**, many patches becoming few masses. Each collision
   leaves a suture.
5. **You stop when it looks right**, and the plates are seeded.

The visual core is **age colouring**: fresh crust bright, old crust dark. You then
watch an *age structure* emerge — oldest cores in the middle of the largest
masses, younger margins outward — which is the pattern real cratons have. This is
not decoration: `computeCratonOldnessField` already reads that age for iron
placement, so what you are watching form is literally the world's resource map.

A small readout — crust %, of which stabilised % — makes the equilibrium visible
as it settles.

## Cost

Cheap. Measured for comparison: the current tectonics does ~12 epochs/second
headless, and that includes the expensive parts an Archean epoch does not have
(the 32k-point boundary lattice, feature buckets, Voronoi). What remains is the
mantle solve (260 Gauss-Seidel iterations over 128×64, ~1 ms) and raft membership.

**A few hundred Archean epochs is well under a second of compute.** It is played
as an animation because it is nice to watch, not because it needs the time.

## Build order

1. **The crust sink first**, on its own, as a fix to the existing runaway. It is
   the precondition for the equilibrium this whole design rests on — and it is
   worth having regardless of whether the Archean gets built.
2. Mantle-flow raft advection (the `advanceRafts` variant).
3. Nucleation + stabilisation, headless, tuned against the crust-fraction
   equilibrium.
4. The panel: start/stop, age colouring, readout.
5. Water offset in `elevationScale.ts`.
6. Retire the plate-count / land-fraction / craton-count / clustering sliders.

Every step is covered by the golden-hash harness described in the worldgen
structure notes, except the panel wiring — same gap, and same manual check, as the
worker refactor.

## Open questions

- **Stabilisation age**: needs to be tuned against the resulting crust fraction
  and the size distribution of the cratons. Too low and everything survives (the
  runaway returns); too high and nothing does.
- **Mantle vigour as a knob**: a hotter early mantle should mean more, smaller
  convection cells and therefore more, smaller continents. Worth exposing, but the
  mapping to `evolveMantleField`'s constants needs checking — it may be
  `DIFFUSION_PASSES` and `DECAY_KEEP` rather than a single dial.
- **Does the Archean produce sutures the Ecology layer should see?** Archean
  collisions would be the oldest orogens, and sutures already feed tin/lode-gold/
  gem provenance. Almost certainly yes, but the age stamping needs to be
  consistent with the tectonic epochs that follow.
