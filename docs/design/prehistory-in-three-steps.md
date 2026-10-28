---
id: DES-0032
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
stage: building
createdAt: 2026-10-27
updatedAt: 2026-10-28
related: [DES-0031, DES-0027, DES-0023, DEC-0048]
---

## Where this starts

The incubator's simulation, as it stood on 2026-10-27, ran 100 000 years
in one loop: the spread of people over the world, the farming, the
villages, the trade. Looking at it raised three problems:

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

The game's start is shortly before the bronze: after the copper, at the
first city (step 2's end, below).

## Step 1: the old stone age — a graph

No simulation. A cost distance over the cell mesh, from one or more
origins:

- Over land, the cost follows the terrain and the biome.
- Over water, a crossing is allowed up to a reach that grows with the
  time. The sea level as a curve over the time sets which shelf is dry
  land: the land bridges.
- The result per cell: the arrival time, and the predecessor. The
  predecessors make a tree, and **the tree is the relationship**: where
  two branches parted is where two groups parted. The language families
  come from it.
- The people per cell follow from the carrying capacity: foragers at
  their density.

Controls: the origin (a click on the globe). The reach over the sea and
the lowest sea level as controls are not built.

Land that the graph does not reach stays empty. That is a property of
the world and a part of the game (a frontier, an island found late), not
an error to correct. New Zealand was settled about 1 300 AD.

The graph is deterministic and fast, so it is derived like a cache: what
is kept is the input (the origins, the controls), not the result.

## Step 2: the new stone age — the simulation, H1

The incubator's simulation (`casas-incubator` simulation.rs), from step
1's end to the first city, reading step 1's result as its first state. It
makes H1 ([DEC-0048](../decisions/incubator-history-engine.md)). For the
world's people, history begins here: they know their neighbours, not
where their forebears came from.

**Its start.** Step 1 ends when the melting ice brings the sea up to 50 m
below today's (on the earth some 40 to 60 m when the farming began). The
people stand where step 1 brought them, at the carrying capacity, with
step 1's arrival and predecessor; each region's knowledge is what its
people give. Nothing of step 1 is kept again but its log.

**A step** of 25 years, on the cells people live in:

- **The climate**, every 500 years: the rest of the glacial cycle's end,
  the sea rising, the land freed by the ice; a stable warmth (the
  Holocene) is a condition of the farming.
- **The people** grow toward what the land carries; a full cell settles
  its empty neighbours (land step 1 did not reach, or that the ice or the
  sea gave back).
- **The game**: hunted by the people, grown back; a species gone from a
  landmass is an extinction.
- **The farming and the herding**: a region's best cell becomes a centre
  by a chance, where people lived long beside two wild crops or herd
  animals and the region knows enough; the domesticates spread from cell
  to cell where they suit (1 and 2 km a year). The fields carry up to 100
  times the people, the herds 10.
- **The fishers**: where the fish are rich, people stay and grow dense.
- **Villages and camps**: the central places of the settled, more than a
  day and a half apart; the foragers' and herders' camps move with them.
- **The droughts**: the rain per square of 300 km, a random walk with
  ENSO; a long dry spell is a famine, people die and flee, villages are
  given up.
- **The copper**: a farmers' village that stood 1 000 years within 20
  days of a deposit finds it and hammers it; one that knew it 3 000 years
  smelts it. Both pass on by contact. It feeds no one: it is rank.
- **The towns**: a farmers' village draws a share of the people within a
  day of it, more with the copper, more with the smelting.
- **Its end**: the first city, a town of 10 000 (Çatalhöyük had some
  5 000, Uruk some 40 000).

The numbers and the measurements that set them are next to their
constants in simulation.rs.

**Decided, not built (2026-10-28):**

- **No crossing of the open sea** in step 2, until ships fit for trade:
  small boats along the coast and to what is in sight of land stay (the
  fishers, the islands off a coast). Today step 2 still crosses up to
  450 km.
- **The peoples.** A people is a set of joined cells whose people meet
  and so stay alike. Each cell carries a few cultural traits, seeded from
  step 1's groups (the descent, which no one in the world knows). Traits
  drift slowly; neighbours with much contact (people, few days between
  them) grow alike, mountains, deserts and the sea part them. The
  innovations (the farming, the copper) are traits that spread by
  contact; farmers who spread carry their traits, foragers who take the
  farming keep theirs. The peoples are the clusters of alike, joined
  cells. A language is, for now, a slow trait among them; their names
  come later ([DES-0033](./naming-languages.md)).

### The climate in step 2

What step 2 needs is the ice age's end:

- **The sea rises** from −50 m to today's level: coasts go under (not
  told in the chronicle yet).
- **The land dries.** On the earth the green Sahara ends near +6 000,
  and people move into the river valleys. A cause of centres. Not built.
- **Single events**, such as the 8.2 ka cold event: some centuries of
  drought and cold, so hunger and people leaving. Not built.

The glacial cycle (`casas-incubator` climate_history.rs) is one curve
drawn from the world's seed: its depth makes step 1's land bridges, its
end is step 2's start.

## Step 3: the bronze age — the game's rules

Not part of the incubator. A proof of concept for the game's engine: the
rules the computer plays by when no player acts. New rules, a small
empire simulation: polities, ranks, bronze as a technology (the tin),
trade as a dependency. It reads H1. Its polities:
[DES-0034](./polities-from-the-land.md).

## One chronicle

The chronicle ([DES-0031](./incubator.md)) is one over all steps, on one
time axis. It reads only a log. Step 1 does not simulate, so it writes
events derived from the graph (the departure, the first landing on each
landmass); the history's log holds step 1's before its own. Steps 2 and 3
write their events as they happen. One log in game time, the one
[DES-0023](./game-knowledge.md) proposes.

## The interfaces first

Each step reads only what the one before gives:

| Step | Reads | Gives |
|---|---|---|
| 1 | L1, the origin | per cell: arrival time, predecessor, group, foragers; its span; log |
| 2 | step 1's result | H1: kept states, lifeways, villages, copper, towns, its start and end; the peoples (not built); log |
| 3 | H1 | the game's state; log |

With these fixed, each step can be rebuilt alone.

## The generator's shelf

The shelf was narrow: 2.6 to 4 % of the ocean against 7.3 % on the earth
([DES-0027](./calibration-backlog.md), item 8). The land bridges of step
1, the coast lost by the rising sea of step 2 and the deltas hang on it.
Step 1 gave the measurement, and the generator was fixed:
[DEC-0049](../decisions/shelf-and-sea.md), with the ice that holds the sea
([DEC-0050](../decisions/seasons-and-ice.md)) and the volcanic islands
([DEC-0051](../decisions/volcanic-islands.md)).

## Status

Building since 2026-10-27:

- 2026-10-27: step 1 (`casas-incubator` peopling.rs), shown in the
  incubator's first step.
- 2026-10-28: step 2 begins where step 1 ends and keeps nothing of it
  again but its log. Step 1 lost its limit on a voyage since the last
  landing: its search keeps one way a cell, and the limit closed cells to
  later, fresher ways (on Morvane 27 % of the land reached instead of
  79 %). Step 2 has the copper and the towns and ends at its first city.
  On Morvane (v14): the first farming at year 59 500, the copper at
  65 000, the smelting at 69 000, the city at 79 500 — some 20 000 years
  after the farming (on the earth some 6 000). 6.8 % of the land farmed:
  the generator's arable land is short (10.7 % of the land at 0.3 or
  more).

Open:

1. Step 2's times against the earth's (the copper, the smelting, the city
   after the farming).
2. The peoples (above) and how they are stored per cell.
3. The far trade: step 2 still shows it (the settlement's links and
   sources); whether it belongs to step 2 or 3.
4. Step 1's sea-level curve: drawn from the world's seed, or a control.
5. The timeline above, checked against sources.
