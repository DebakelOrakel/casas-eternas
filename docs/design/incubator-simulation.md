---
id: DES-0033
title.en: The incubator's simulation
title.de: Die Simulation des Inkubators
summary.en: The incubator's rules are times per cell, made once, without
  feedback. A simulation runs the 100 000 years before the game in steps,
  on request, as a job in the browser, and is played back afterwards: the
  people's numbers by lifeway per cell, their spread, the animals they
  hunt, the fields, the villages and camps, the trade, droughts — every
  process reading the others' state, every event written to a log the
  chronicle shows. Not deterministic yet; exported later to the engine,
  as the generator's was.
summary.de: Die Regeln des Inkubators sind Zeitpunkte pro Zelle, einmal
  gerechnet, ohne Rückkopplung. Eine Simulation rechnet die 100 000 Jahre
  vor dem Spiel in Schritten, auf Anfrage, als Job im Browser, und wird
  danach abgespielt: die Menschen pro Zelle nach Lebensweise, ihre
  Ausbreitung, das Wild, das sie jagen, die Felder, Dörfer und Lager, der
  Handel, Dürren — jeder Prozess liest den Zustand der anderen, jedes
  Ereignis kommt in ein Protokoll, das die Chronik zeigt. Noch nicht
  deterministisch; später in die Engine exportiert, wie die des Generators.
area: mechanics
stage: building
createdAt: 2026-10-26
related: [DES-0032, DES-0031, DES-0023]
---

## Where this starts

The incubator ([DES-0032](./incubator.md)) grows what lived on a world
before the game from simple rules. Each rule gives a time per cell: when
people came, when the fields, when the herds, when an animal went. The
state at any time is a function of those times, which is fast (some 12 s
on Morvane for all of it) and lets the time go back and forth freely.

What it cannot do is feedback. The game does not thin because people hunt
it, so they never move on for hunger; an animal dies out because a draw
says so, not because it was hunted out; the fields do not fail in a dry
decade. The rules decide an order of causes once (the flora, the fauna,
the spread, the farming, the loss) and every later one reads the earlier
ones, never the other way. Droughts, famines, people leaving, a trade
route that carries grain because a valley's harvest failed — none of it
can appear.

DES-0032's last section saw this coming: a simulation in time steps is
worth it once crises are wanted. They are now (2026-10-26: "lass uns mal
überlegen mit Dürren zu spielen").

## The shape

**Two stages.**

- **The preview**, at once, as a world opens: the people's spread as the
  rules give it now, its end state and its routes, over the flora and the
  fauna as they were before people. Less than today: no lifeways, no
  villages, no trade; it shows where people will be, roughly.
- **The simulation**, on request: a button starts a job in the browser (a
  worker, the progress pill), which runs 100 000 years in steps. When it
  is done, the chronicle plays it back — the time, the jumps, the speed,
  the events — and every layer shows the simulation's state at the time
  shown.

The rules of today become the preview and the template of the processes:
their numbers (speeds, densities, reaches, lags) are the processes' first
values.

**The span: 100 000 years**, the people's departure in year 0, the game in
year 100 000. More time than the 65 000 of the rules; it can be changed.

**Not deterministic yet.** The same request should give the same result
in the same browser (a seeded random), so that a played-back step can be
computed again from the nearest stored state. Bit-equal results between
builds come with the export.

**Exported later**, as the generator's engine was
([DEC-0044](../decisions/rust-engine.md)): the steps written as functions
over typed arrays, no DOM, no screen state, so that a port to the Rust
engine — and a job on the server — is a translation, not a redesign.

## The state

Per land cell of the incubator's mesh (cells.ts; on Morvane 0.5 M of
1.47 M cells), for a first form:

- the people per lifeway (foragers, fishers, herders, farmers), per km²;
- the game per animal group (the fauna's uses: hunt, tame, water, fur,
  danger), as a share of what the land carries without people;
- the herds kept and the crops sown, which and how many;
- the share of the forest cleared;
- a village or a camp, and since when;
- the stores: a year's food put by, so that one bad step is not a famine.

The world's own, read once: the habitat (height, slope, biome, Köppen,
rivers, lakes, coast, the ecology's fields), the flora and the fauna as
they were before people, the climate (the save's, with the rain's
variability and the ENSO see-saw, below).

## A step

A step of some 25 to 50 years (open, below). In it, in this order:

1. **The weather of the step** (below): each region's rain this step, off
   its mean by its variability.
2. **The food**: per cell what each lifeway gets — the game for the
   foragers, the fish for the fishers, the pasture for the herds, the
   fields for the farmers, each under the step's rain.
3. **The people**: each lifeway grows toward what its food carries, or
   shrinks; the stores take the first shortfall.
4. **Leaving**: where people are more than the food carries, a part
   leaves for the neighbours, by the cost of the way — slope, rivers as
   fast ways, the sea only by boat and only by chance (dugouts and rafts:
   good for a daring crossing, not for trade). The spread is this, not a
   shortest way any more.
5. **The game**: hunted by the foragers by their numbers, pushed out by
   the herds and the fields, grown back toward the land's. A species
   gone from a landmass is an extinction — the result, not a draw.
6. **The lifeways**: farming and herding begin where people lived long
   beside the wild crops or herd animals (the domestication's centres
   become what happens, not what is placed), and spread by contact: a
   cell takes a lifeway its neighbours have when it feeds more there.
7. **Villages and camps**: a village where a settled lifeway is dense
   enough, a camp where foragers or herders gather; either is left when
   its people go.
8. **Trade**: over the villages and camps, goods by name — tool stone,
   salt, copper from their sources; grain and wool from the fields and
   herds; boat wood — along ways that cost by the ground, down the line
   from one to the next.
9. **The events** of the step into the log (below).

## Droughts

The save's climate has what a drought needs (generator/climate/
reliability.ts): per land cell the annual rain's **variability** (its
coefficient of variation, 0.3 = one year in three off by 30 %) and the
**ENSO see-saw**'s mark (−1 drier in the warm phase … +1 wetter), with
the see-saw's period and strength for the world (Morvane: 4 years).

A first form:

- The rain of a step per region (a landmass's part, some hundreds of km,
  so that a drought is a place, not a cell): its mean times
  (1 + variability × an anomaly). The anomaly is a random walk of the
  region's own, plus the see-saw's phase times its mark — so that a
  see-saw's regions dry together, and a drought can last more than one
  step.
- A dry step lowers what the fields and the pasture give, by its
  shortfall; the game less, the fish not at all. The stores take the
  first; a second dry step is a famine.
- A famine: people die, people leave, villages are given up; a herding
  people may take a farming valley. Each is an event.

What is open: the step against the drought's length (a drought lasts years
to decades; a step of 50 years would smear it — hence 25), how far the
regions reach, whether a step holds an average and a worst year.

## The log and the chronicle

Every event of a step goes into a log: a time, a kind, a place, what it
was (a village begun or given up, a crossing, a domestication, an
extinction, a drought, a famine, a trade route, a population threshold).
The chronicle ([DES-0031](./incubator-chronicle.md)) reads it instead of
working its events out of the rules' times. It is the event log in game
time [DES-0023](./game-knowledge.md) proposes as the game's truth.

## Playing back

The state at every step does not fit: some 10 to 20 MB a step, 2 000 to
4 000 steps. Instead:

- a full state every **2 500 years** (40 of them, a few hundred MB);
- a time between two is computed again from the one before — at most 50
  to 100 steps, a second or so;
- the log whole.

The result is an artifact: first in the browser (OPFS), later on the
server, keyed by the world, the origin and the simulation's version.

## What it costs

Not measured. Estimated: some 1 000 to 4 000 steps over 0.5 M land
cells, in TypeScript in a worker, a few minutes. Measured on the first
skeleton (below) before anything else is built on it.

## The way there

1. **This note**, its open questions answered; a decision where a fork
   hardens.
2. **The skeleton**: the loop, the people (one lifeway) and their
   leaving, the stored states and the playback. Compared with the
   rules' spread on Morvane.
3. **The game and the hunt.**
4. **The lifeways and the domestication.**
5. **Droughts.**
6. **Villages, camps, trade.**
7. **The chronicle from the log.** The rules' layers become the preview.

## Open questions

1. **The step**: 25 years, measured on the skeleton: the whole run costs
   0.33 s, so a finer one is open to the droughts.
2. **The regions** a drought takes: a landmass's part of a fixed size,
   or the climate's cells (78 km on Morvane)?
3. **The preview**: is the spread alone enough, or the lifeways too?
4. **The origin**: as now (a click, or the best tropical land), the
   simulation run again for another?
5. **Where the result lives**: the browser first, the server later — and
   who may run one there.

## Status

Building, 2026-10-26. **The skeleton** (`simulation.ts`): the people, one
lifeway, 4 000 steps of 25 years with three sub-steps of settling; a full
cell settles its empty neighbours by a chance from the rules' speeds (a
diffusion on cells of 10 km would be stable only in steps of some 2
years); the shelf walked until 10 000 years before the game; the
crossings over open water made once (the shortest between each pair of
landmasses) and tried at 2 % a step within the time's reach. It gives the
spread in the rules' form, so the settlement and the chronicle read it as
they read the rules'. On Morvane: 0.33 s (40 s while every settled cell
was visited a step; now the front and the growing cells alone), 82.2 % of
the ice-free land reached against the rules' 82.9 %, 28 crossings.

"Start history" and a reset (origin and people back to the rules') are
the people step's buttons. The span of the whole incubator is 100 000
years since (`SPAN_YEARS`). The kept states are not played back yet.
