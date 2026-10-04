---
id: DEC-0011
title.en: Archean Genesis: deriving the tectonic starting state
title.de: Archaikum: den tektonischen Startzustand herleiten
summary.en: Replace the Genesis sliders with a short, watchable Archean simulation —
  crust nucleates over oceanic mantle upwellings, drifts on the mantle flow
  with no plates, and stabilises into cratons; plate count and land fraction
  become emergent.
summary.de: Die Genesis-Regler werden durch eine kurze, beobachtbare Simulation des
  Archaikums ersetzt — Kruste entsteht über ozeanischen Mantelaufströmen,
  driftet ohne Platten auf der Mantelströmung und stabilisiert sich zu
  Kratonen; Plattenzahl und Landanteil ergeben sich daraus.
area: generator
stage: built
createdAt: 2026-07-28
updatedAt: 2026-08-12
concepts: [generator.concept.craton, generator.concept.young-crust, generator.concept.mantle-convection]
related: [DEC-0003, DEC-0006]
---

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

Every step is covered by the golden-hash harness — `client/scripts/golden.mjs`, run
with `npm run harness:golden` (and `npm run harness:golden:record` to re-baseline) — except the panel
wiring, which is the same gap, and the same manual check, as the worker refactor.

The harness builds its worlds through the Archean and the handover, i.e. the way the
program does. It previously called the old `createPlateSimulation` with the four
sliders this design retires, so it was guarding a path nothing reached while the live
path went unguarded; it was switched over before that code was deleted, so the
deletion could be checked against the real pipeline rather than against nothing.

## Craton rigidity — why continents assemble at all

Merging cratons was, for a while, pure bookkeeping. `mergeOverlappingRafts`
computed a suture, raised a collision event and passed the continent's name to the
survivor — and then the next epoch re-advected every blob by its own local flow and
undid it. Cratons approached, touched, and drifted apart again. No continent ever
assembled, at any vigour setting.

The omission was one-sided reasoning. Blob-wise advection was chosen so that a
continent straddling two convection cells would be pulled apart, which is right;
what was missed is that nothing then held a continent *together* either.

A raft now moves by the mean flow across its blobs plus `1 - rigidity` of each
blob's own departure from that mean. Swept over two seeds at 250 epochs:

| rigidity | biggest landmass | separate masses | break-ups / 100 epochs |
|---|---|---|---|
| 0.00 | 10-11% | 48 / 46 | 555 / 518 |
| 0.50 | 18-27% | 29 / 30 | 272 / 295 |
| 0.80 | 23-25% | 28 / 23 | 200 / 177 |
| 0.90 | 27-41% | 12 / 18 | 129 / 123 |
| **0.95** | **43-70%** | **12 / 12** | **95 / 98** |
| 1.00 | 65-85% | 7 / 7 | 64 / 69 |

Two things the measurement settled:

- **There was no trade-off to balance.** The worry was that rigid cratons could
  never break up again, since differential stretching is the Archean's only rifting
  mechanism (the tectonic phase tears continents at rifts, which needs plates that
  do not exist yet). But break-ups survive even at rigidity 1.0, because
  `recycleUnstabilisedCrust` eats blobs out of a raft's middle and disconnects it
  that way. The old value was not buying break-ups; it was shredding the crust, at
  five and a half fragmentations per epoch.
- **0.95 rather than 1.0 all the same.** At exactly 1.0 the differential term is
  zero and the only way left to break a continent is to have its middle recycled
  away — being pulled apart across two convection cells stops happening at all. The
  measurement shows that mode still contributes at 0.95 (95 break-ups against 64).

Rigidity is a tuning constant, not a slider. It stands for the strength of
continental lithosphere, which is a material property of the world rather than a
matter of taste — and a second knob acting on continent count and size would fight
the mantle-vigour one, which is exactly the confusion `mantleRms` produced.

## Open questions

- **Stabilisation age**: needs to be tuned against the resulting crust fraction
  and the size distribution of the cratons. Too low and everything survives (the
  runaway returns); too high and nothing does.
- ~~**Mantle vigour as a knob**~~ — **resolved, and the suspicion above was right.**

  It was first wired to `createMantleField`'s *initial* smoothing, on the reasoning
  that changing the field's starting scale steers the world without touching the
  tuned epoch dynamics. Measurement killed that: the per-epoch diffusion erases the
  initial smoothing. Field roughness by starting pass count — 2.53× spread at epoch
  0, 1.35× by epoch 10, **1.13× by epoch 40**, against a phase nobody stops before
  epoch 150. A full sweep of the slider confirmed the consequence: craton count,
  plate count and land fraction all moved non-monotonically, by no more than two
  seeds differed at the *same* setting.

  The knob is now `evolveMantleField`'s per-epoch diffusion, Archean-only
  (`ArcheanParams.diffusion`; the tectonic phase keeps `DIFFUSION_PASSES`, whose
  "over-diffusing starved the doming/breakup" warning still applies there). It
  cannot wash out, because it is reapplied every epoch. Plate count against slider
  position, three seeds at 250 epochs:

  | vigour | 10 | 8 | 6 | 4 (default) | 2 | 1 |
  |---|---|---|---|---|---|---|
  | diffusion | 0.000 | 0.111 | 0.444 | 1.000 | 1.778 | 2.250 |
  | plates | 24.3 | 17.3 | 10.3 | 9.7 | 6.3 | 5.0 |

  Two details worth keeping:

  - The mapping is **quadratic**, because half the swing (24 → 13 plates) happens
    below diffusion 0.25 and nothing at all happens above ~1.7. A linear slider
    spent a third of its travel in the saturated tail and crammed the upper half of
    the range into its last step — it read as a switch, not a control.
  - The default is **4, not the middle**: that is the setting mapping to diffusion
    1.0, which is what the Archean ran at before the knob existed. "Default" means
    unchanged behaviour rather than halfway along a slider.

  Land fraction does *not* follow this knob monotonically, which is the point — how
  much land there is stays the water slider's job. `mantleRms` was measured as the
  other candidate and rejected for exactly that reason: it is monotone but it is a
  land dial in disguise (47% land at 0.25, 20% at 0.40, 2% at 0.55).
- **Does the Archean produce sutures the Ecology layer should see?** Archean
  collisions would be the oldest orogens, and sutures already feed tin/lode-gold/
  gem provenance. Almost certainly yes, but the age stamping needs to be
  consistent with the tectonic epochs that follow.

## Status

decided and BUILT 2026-07-28 (Archean core landed the same day); tuned
repeatedly since — supercontinent timing, water offsets ±600 m, compaction
and blob consolidation 2026-08-06
