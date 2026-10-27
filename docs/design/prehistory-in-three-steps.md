---
id: DES-0034
title.en: The prehistory in three steps
title.de: Die Vorgeschichte in drei Schritten
summary.en: The incubator did two things in one simulation: the peopling of
  the world and the neolithic. They have different causes and need
  different tools. Step 1, the old stone age, is a reachability graph, not
  a simulation. Step 2, the new stone age, is the incubator's simulation
  and makes H1: the cultures, the groups and the languages at the game's
  start. Step 3, the bronze age, is not the incubator: it is the game's own
  rules, run without a player. One chronicle reads all three.
summary.de: Der Inkubator machte zwei Dinge in einer Simulation: die
  Besiedlung der Welt und die Jungsteinzeit. Sie haben verschiedene Ursachen
  und brauchen verschiedene Werkzeuge. Schritt 1, die Altsteinzeit, ist ein
  Erreichbarkeitsgraph, keine Simulation. Schritt 2, die Jungsteinzeit, ist
  die Simulation des Inkubators und macht H1: die Kulturen, die Gruppen und
  die Sprachen beim Spielstart. Schritt 3, die Bronzezeit, ist nicht der
  Inkubator: Es sind die Regeln des Spiels, ohne Spieler gerechnet. Eine
  Chronik liest alle drei.
area: mechanics
stage: idea
createdAt: 2026-10-27
related: [DES-0032, DES-0033, DES-0031, DES-0027, DES-0023, DEC-0048]
---

## Where this starts

The incubator's simulation ([DES-0033](./incubator-simulation.md)) runs
100 000 years in one loop: the spread of people over the world, the
farming, the villages, the trade. A first form of it exists. Looking at
it raised three problems:

- **Two epochs in one loop.** The spread out of one origin is the old
  stone age (some 70 000 to 15 000 years ago on the earth). The farming,
  the villages and the trade are the new stone age. Their causes are not
  the same, and one set of rules serves neither well.
- **The ice age was a means, not a cause.** The glacial cycle was put in
  so that people could walk to the other landmasses of the test world.
  On the map its effect is small, because the generator's shelf is steep
  (below).
- **Worlds that do not fit.** Island chains, far landmasses, a narrow
  shelf: a simulation that must reach everything needs cheats for each.

The game begins in the new stone age: after the farming, before the
bronze. What the incubator must give the game is not the way the people
went, but its traces: who lives where and how many, who is related to
whom (the groups, the cultures, the languages), where the farming began
and how far it went, and what is far, late or empty.

## The earth's timeline

For scale, the Near East, with year 0 at the farming's start (some
9 600 BC). Numbers from memory, ±500 years; not checked against
sources yet.

| Years after farming | What |
|---|---|
| −2 000 | Settled villages before the farming (the Natufians) |
| ≈ 0 | Göbekli Tepe: a cult centre built by hunters |
| −1 500 | Obsidian from Melos carried over the sea |
| +600 … +1 500 | Native copper hammered cold: beads, awls |
| +1 000 | Cyprus settled with cattle, over some 70 km of open sea |
| +2 500 | Large villages of up to 5 000 people (Çatalhöyük), no ranks |
| +2 600 | Pottery |
| +3 500 | The farming spreads by boat along the Mediterranean coast; reed boats in the Gulf |
| +3 500 … +5 000 | The first centres: temples with a hinterland, ranks (Ubaid) |
| +4 500 | Copper smelted: the copper age begins |
| +5 000 | Varna: graves of gold and copper, an elite |
| +5 500 … +6 000 | Plough, wheel, wool, milk, draught animals; the sail on the Nile |
| +6 000 … +6 300 | Cities (Uruk, some 40 000 people), writing, the state |
| +6 300 | Tin bronze: the bronze age (3 300 BC) |
| +6 600 | Plank boats |

Other regions keep their own pace: Europe farms from some 6 500 BC and
has bronze from some 2 200 BC; the Americas have almost none. The
intervals are a property of the world, not a constant.

What follows from it:

- **Boats are older than the farming.** Open sea up to some 100 km is
  neolithic or older. The Austronesians settled the Pacific with
  outriggers and no metal: the high sea needs a culture, not bronze.
- **Copper changes the society, not the economy.** It is first an
  ornament, then a sign of rank.
- **Bronze makes trade a dependency.** Tin is almost never near copper,
  so trade over long distances becomes a need, not a luxury. From it
  come the control of trade routes, warriors, horse and chariot, palaces
  and states.

The game's start is at some +3 000 to +5 000: after the large villages,
near the first centres and the first copper.

## Step 1: the old stone age — a graph

No simulation. A cost distance over the cell mesh, from one or more
origins:

- Over land, the cost follows the terrain and the biome, as the rules'
  spread did ([DES-0032](./incubator.md)).
- Over water, a crossing is allowed up to a reach that grows with the
  time. The sea level as a curve over the time sets which shelf is dry
  land: the land bridges.
- The result per cell: the arrival time, and the predecessor. The
  predecessors make a tree, and **the tree is the relationship**: where
  two branches parted is where two groups parted. The language families
  come from it.
- The people per cell follow from the carrying capacity: foragers at
  their density.

Controls: the origins (a click on the globe), the reach over the sea
across the time, the lowest sea level. Perhaps a few for the flora and
the fauna, which the loading screen makes today.

Land that the graph does not reach stays empty. That is a property of
the world and a part of the game (a frontier, an island found late), not
an error to correct. New Zealand was settled about 1 300 AD.

The graph is deterministic and fast, so it is derived like a cache: what
is kept is the input (the origins, the controls), not the result.

## Step 2: the new stone age — the simulation, H1

The incubator's simulation, from the farming's start to the game's start,
reading step 1's result as its first state. It makes H1
([DEC-0048](../decisions/incubator-history-engine.md)).

What belongs here:

- the farming begins in centres (the conditions of DES-0033 stay valid)
  and spreads over the foragers: it pushes them back, they take it on,
  or they mix;
- **the cultures, the groups and the languages**, which the current
  simulation does not make: the tree of step 1 as the base, split and
  mixed by the spread of the farming;
- the lifeways and the density, the villages;
- the boats along the coast: fishing, settling by sea, contact;
- droughts, famines, people leaving.

What goes to step 3: the centres with ranks, the long-distance trade as
a system, the copper. The current simulation has some of it already
(central places, trade by days); it was taken too early.

It runs live in the incubator, with controls, as now. Changes only on a
button, as in the generator.

### The climate in step 2

No ice age: the farming begins after it, in the Holocene. What step 2
needs is its end:

- **The sea rises.** At the farming's start it is still some 40 to 60 m
  lower and reaches today's level near +4 500 (Doggerland and the Gulf
  are flooded). Villages on the coast go under; the chronicle gets its
  floods.
- **The land dries.** On the earth the green Sahara ends near +6 000,
  and people move into the river valleys. A cause of centres, so close
  to step 3.
- **Single events**, such as the 8.2 ka cold event: some centuries of
  drought and cold, so hunger and people leaving.

A curve of sea level and wetness, from the end of the ice age to
today's level. No climate simulation.

The glacial cycle belongs to step 1, as the low sea level that makes the
land bridges.

## Step 3: the bronze age — the game's rules

Not part of the incubator. A proof of concept for the game's engine: the
rules the computer plays by when no player acts. New rules, a small
empire simulation: centres, ranks, copper and then bronze as a
technology, trade as a dependency. It reads H1. More in its own doc.

## One chronicle

The chronicle ([DES-0031](./incubator-chronicle.md)) stays, over all
three steps. It reads only a log, as now (DES-0033). Step 1 does not
simulate, so it writes events derived from the graph: "the island X
reached at −40 000", "the groups A and B part". Steps 2 and 3 write
their events as they happen. One log in game time, the one
[DES-0023](./game-knowledge.md) proposes.

## The interfaces first

Each step reads only what the one before gives:

| Step | Reads | Gives |
|---|---|---|
| 1 | L1, origins, controls | per cell: arrival time, predecessor, foragers; the tree; log |
| 2 | step 1's result | H1: per cell the people by lifeway and group; the groups, cultures and languages; log |
| 3 | H1 | the game's state; log |

With these fixed, each step can be rebuilt alone.

## The generator's shelf

The shelf is narrow: 2.6 to 4 % of the ocean against 7.3 % on the earth
([DES-0027](./calibration-backlog.md), item 8). Three things hang on
it: the land bridges of step 1, the coast lost by the rising sea of
step 2, and the deltas. It is a generator problem, not one of the
incubator, and it is fixed in the generator.

It does not need to come first. Step 1 works on any sea floor; a steep
shelf only gives fewer bridges. But step 1 gives the measurement the fix
needs: how much land is dry at −120 m, how many landmasses are joined.
So step 1 first, the shelf against that measurement, and both before
step 2's coast and sea level are tuned.

## Status

Idea, 2026-10-27. Nothing built. The current simulation (DES-0033) is the
first form of step 2 and holds parts of steps 1 and 3. Open:

1. The interfaces in detail, above all how a group and a language are
   stored per cell.
2. Step 1's sea-level curve: drawn from the world's seed, or a control.
3. What of the current simulation moves to step 3, and what step 2
   keeps while step 3 does not exist.
4. The timeline above, checked against sources.
