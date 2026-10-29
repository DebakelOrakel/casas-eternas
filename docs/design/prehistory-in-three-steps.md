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
updatedAt: 2026-10-29
related: [DES-0031, DES-0027, DES-0023, DEC-0048, DES-0035]
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
9 600 BC). Checked against sources on 2026-10-28
([DES-0035](./earth-prehistory-sources.md), with the references and
what is not verified).

| Years after farming | What |
|---|---|
| −3 400 | Settled villages before the farming (the Natufians, from some 13 000 BC) |
| −1 500 | Obsidian from Melos carried over the sea |
| ≈ 0 | Göbekli Tepe: a cult centre built by hunters |
| +1 000 | Cyprus settled with cattle, over some 70 km of open sea |
| +1 400 … +2 100 | Native copper hammered cold: beads, awls (copper-mineral beads from −900) |
| +2 500 | Large villages of some hundreds to a few thousand people (Çatalhöyük) |
| +2 600 | Pottery |
| +3 100 | Milk |
| +3 300 … +3 460 | The 8.2 ka event: some 160 years of cold, in Europe about −1 °C and −20 % rain |
| +3 500 | The farming spreads by boat along the Mediterranean coast (Cardial in the west +4 200) |
| +3 100 … +5 500 | The first centres: temples with a hinterland, ranks (Ubaid) |
| +4 100 | Reed boats in the Gulf |
| +4 300 | The green Sahara dries from here; people go to the Nile |
| +4 500 | Copper smelted: the copper age begins |
| +5 000 | Varna: graves of gold and copper, an elite |
| +6 000 … +6 500 | Cities (Uruk; some 40 000 people, not verified), writing, the state |
| +6 100 … +6 400 | The wheel; the sail on the Nile |
| +6 600 | Tin bronze in regular use (the bronze age's label: 3 300 BC, mostly arsenical copper) |
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
- **The rising sea**: a cell the sea or the ice covers sends its people
  to the neighbours that still carry, as far as they have room; the rest
  die. A large loss of a landmass's shelf is told in the chronicle (a
  coast goes under, as Doggerland).
- **The cold spells**: one or two from the world's seed, 2 000 to 10 000
  years after step 2's start, each 160 years, as the 8.2 ka event: the
  land carries a little less and the rain of the droughts is a fifth
  less. Told in the chronicle.
- **The sea**: no open sea until ships fit for trade. Boats go along
  the coast and to land in sight, 100 km of open water at most (Cyprus,
  some 70 km off and seen from the coast, was settled at +1 000).
- **The copper**: a farmers' village that stood 1 000 years within 20
  days of a deposit finds it and hammers it; one that knew it 3 000 years
  smelts it. Both pass on by contact. It feeds no one: it is rank.
- **The towns**: a farmers' village draws a share of the people within a
  day of it, more with the copper, more with the smelting.
- **Its end**: the first city, a town of 10 000 (Çatalhöyük had some
  hundreds to a few thousand, Uruk perhaps 40 000; DES-0035).

The numbers and the measurements that set them are next to their
constants in simulation.rs.

**Decided, not built (2026-10-28):**

- **The peoples.** A people is a set of joined cells whose people meet
  and so stay alike. Each cell carries a few cultural traits, seeded from
  step 1's groups (the descent, which no one in the world knows). Traits
  drift slowly; neighbours with much contact (people, few days between
  them) grow alike, mountains, deserts and the sea part them. The
  innovations (the farming, the copper) are traits that spread by
  contact; farmers who spread carry their traits. Foragers who take the
  farming keep theirs where they stay about as many as the farmers; where
  they are far fewer, the farmers' traits replace theirs (2026-10-29: in
  Europe the farmers who came replaced most of the hunters, as the genes
  show). It is decided once the farmers have grown in the cell, not when
  the fields come. The farming and the copper pass over the
  peoples' borders and carry no traits. The peoples are the clusters of alike, joined
  cells. A language is, for now, a slow trait among them; their names
  come later ([DES-0033](./naming-languages.md)).
  Some 100 to 300 peoples on a world as Morvane (the earth's new stone
  age: some 3 to 10 archaeological cultures a million km²).
  Built 2026-10-29 (`casas-incubator` peoples.rs): the traits, the
  farmers' replacement, the split of large peoples, the peoples' lasting
  ids and their tree; their storage in H1 and the overlay (Völker); the
  chronicle's events (2026-10-29, Status).
- **The peoples in the chronicle (2026-10-29).** Of the big peoples
  alone, and of a people of a share of the land lived in (0.5 %): a
  people splits (both parts so large), merges into another, vanishes
  (dies out or falls under big for good), turns to farming (its farmers'
  share by people over a half, once). Not the peoples of step 2's start:
  they are just there, and so are their splits in step 2's first 5 000
  years (kin branches that part as they drift). Two peoples whose border
  is near the distance that parts them part and join again; a split or a
  merge is told when it held 5 000 years (the two peoples' hearts apart,
  or in one people, at each step since), a people gone of a people that
  lived 5 000 years.
- **No rank in step 2 (2026-10-29).** Step 2 gives each people what rank
  grows from — its surplus (the farmers' share, the arable land, the
  density), its largest town, its copper, its exchange — and step 3
  derives the rank from them, with the land's circumscription, at its
  start ([DES-0034](./polities-from-the-land.md)). Step 2 stays the
  tribes'; the power is step 3's.
- **The exchange, not the trade.** The far exchange of the new stone age
  went from village to village ("down the line"): no traders, no fixed
  routes, no dependency; goods of rank (obsidian, shells, copper), less
  of them at each stop. Step 2's trade links become this: over land and
  along the coast, never over the open sea. Step 3 reads where which goods
  came from. Organised far trade (traders, caravans, ships, the tin) is
  step 3's. Built 2026-10-28: the fall-off and the large villages' draw
  (settle.rs); where which goods came from is not kept yet.
- **The climate's events, in this order:** (1) the rising sea drowns
  cells, their people go to the neighbours, and a large loss is told in
  the chronicle (a coast goes under, as Doggerland) — built 2026-10-28;
  (2) one or two cold spells drawn from the seed, as the 8.2 ka event,
  some centuries of more drought and cold through the droughts already
  there, told in the chronicle — built 2026-10-28; (3) the land drying,
  as the green Sahara's end, a wetter early Holocene in the subtropics
  that fades toward today — looked at again with the towns, as a cause of
  centres in river valleys. Not built.

### The climate in step 2

What step 2 needs is the ice age's end:

- **The sea rises** from −50 m to today's level: coasts go under, their
  people move to the neighbours, a large loss is told in the chronicle.
- **The land dries.** On the earth the green Sahara ends near +6 000,
  and people move into the river valleys. A cause of centres. Not built.
- **Single events**, such as the 8.2 ka cold event: one or two cold
  spells of 160 years, more drought and some cold, so hunger and people
  leaving.

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
time axis, each step's built on the one before: a step shows it up to its
own end. It reads only a log. Step 1 does not simulate, so it writes
events derived from the graph (the departure, the first landing on each
landmass); the history's log holds step 1's before its own. Steps 2 and 3
write their events as they happen. One log in game time, the one
[DES-0023](./game-knowledge.md) proposes.

## The interfaces first

Each step reads only what the one before gives:

| Step | Reads | Gives |
|---|---|---|
| 1 | L1, the origin | per cell: arrival time, predecessor, group, foragers; its span; log |
| 2 | step 1's result | H1: kept states, lifeways, villages, copper, towns, its start and end; the peoples (ids per kept state, their tree); log |
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
- 2026-10-28: step 2 crosses 100 km of open water at most (450 km
  before). A centre keeps others of its lifeway away on its own landmass
  only: an island's centre had kept Morvane's largest landmass from
  farming. On Morvane over six origins: 7.4 % of the land farmed, no
  crossing over 100 km, the city at +25 500 to +42 000 after step 2's
  start.
- 2026-10-28: the exchange, the rising sea and the cold spells. The goods
  fall off by a decay of 5 days, not 8 (0.55 % at 26 days, the Anatolian
  obsidian's 0.5 % at 700 – 800 km), and a village draws them by its
  town; on Morvane 129 links carry goods (240 before), the farthest
  village 564 km from its source (611). The sea took 10 000 km² or more
  of a landmass 36 times in step 2's first 5 000 years; 50 000 km² or
  more (the chronicle's) 5 times, some 140 people moving from each (a
  dry shelf carries what the poorest land does). The cold spells at
  +6 750 and +7 525: 117 famines in their 350 years (488 in the whole
  history), 111 000 dead, the people 1 % fewer 500 years on than without
  them. Over six origins without the rain: 6.8 to 7.4 % farmed, 8.1 to
  8.5 M people, no crossing over 100 km; the city at +24 500 to +38 500,
  and on one far origin none in the span (its largest town 9 500): the
  far origins' cities stand near CITY_PEOPLE, and a small change moves
  them.
- 2026-10-28: a dry shelf carries what its coast carries and is crossed
  as fast (it carried as little as the poorest land: empty). On Morvane
  the five coasts that go under move 1 459 to 1 998 people each (58 to
  168 before); step 1 reaches 95.4 % of the land, as before.
- 2026-10-28: the copper's finds and smeltings keep others away on their
  own landmass only, as the centres; on Morvane nothing changes, the
  small torus test world's history does.
- 2026-10-29: the peoples, part 1 (`casas-incubator` peoples.rs): 8
  traits a cell, one the language, seeded from step 1's groups and their
  finer branches (0.3 % of the land), drifting by branch, pulled by the
  neighbours by people, ways' days and likeness; settlers carry theirs.
  The history stays the same bits. Peoples of 1 000 people and
  10 000 km² or more at the end: Morvane 165 (5.9 a million km² reached),
  Thalassor 189 (9.6), Zephyra 171 (7.9); the largest 5.3, 3.1, 4.0 % of
  the land lived in; 0.2 to 0.5 % of the lived cells in peoples under 10
  cells. On Morvane 117 at step 2's start, 155 at +5 000, 163 at
  +15 000: kin branches part as they drift, then the borders hold. The
  count hangs on the branches' share, not on the contact.
- 2026-10-29: the peoples, part 2. The fields that come from a farmer
  cell to a cell whose people are a tenth of the farmers' or fewer bring
  the farmers' traits (the herds the same; they replace next to
  nothing). A branch's joined part over 1 M km² parts in two at its
  middle by the ways' days. At each kept state the peoples get ids that
  last (by the overlap of their people with the last state's), with
  their splits, merges and descent. The history stays the same bits.
  Peoples at the end: Morvane 166 (largest 3.0 %), Morvane from origin
  473 575 153 (3.4 %; 35 % before the split), Thalassor 192 (3.1 %),
  Zephyra 169 (4.0 %). On Morvane 9 815 cells replaced, only 788 of
  another branch: the fields spread mostly inside the people that began
  them, and the peoples hardly change (11 mainly farmers by km², as
  before). The ids: 7.8 MB on Morvane (u16, the cells lived in); the
  history 10 to 16 % slower (5.3 s instead of 4.8 s).
- 2026-10-29: the replacement is decided later. The fields that come to
  a cell make it pending, with its people then (the foragers) and the
  cell they came from; once the foragers are a tenth or less of its
  people (the farmers grown in it), it takes that cell's traits as they
  are then. The herds the same. The history stays the same bits. On
  Morvane 23 584 cells replaced (9 815 before), 10 851 of another branch
  (788), a median of 50 years after the fields came; the herds 8 979
  (557). The peoples at the end: Morvane 167, from origin 473 575 155,
  Thalassor 192, Zephyra 173; the largest as before. The fields spread
  mostly inside the people that began them: the peoples hardly change.
- 2026-10-29: the peoples in H1 (the incubator's v3; `casas-incubator`
  pack.rs): each kept state's people id of each cell lived in, and the
  tree (by people: parent, group, born, ended, merged into, big; by
  people and kept state: people, km², farmers, heart). A people is big
  with 1 000 people and 10 000 km² at one kept state or more; the small
  isolated bands stay in the tree, flagged, for the chronicle to leave
  out. The other arrays keep their bytes. On Morvane (its own origin, no
  rain) 11.2 MB more on 149.5 MB: the ids 10.7 MB, the tree 0.4 MB;
  2 094 peoples, 220 big. The incubator's overlay Völker paints the
  peoples at the time shown, the hue by step 1's group, each people a
  step of hue, saturation and lightness of its own.
- 2026-10-29: the peoples in the chronicle (the incubator's v4;
  `casas-incubator` peoples.rs `Tree::tell`). The tree steps every 500
  years, not every 2 500; H1 keeps its ids and measures at the kept states
  as before. Splits, merges, peoples gone and turns to farming in the log,
  of the big peoples of 0.5 % of the km² lived in or more (some 28 M km²
  on the three worlds), a split, a merge or an end of a people that lived
  5 000 years. Morvane 34 splits, 4 merges, 0 gone, 27 turns to farming;
  Thalassor 29, 1, 0, 27; Zephyra (origin 783 702) 30, 2, 0, 13. The
  splits mostly in the first fifth of the history (28, 21, 27), the turns
  to farming in its second to fourth. The other arrays keep their bytes;
  the history takes 1.4, 0.6 and 1.9 s more (6.6, 3.2 and 8.5 s).
- 2026-10-29: the peoples without the stripes (the incubator's v5;
  `casas-incubator` peoples.rs). The overlay Völker showed straight,
  parallel bands of peoples, some one to a few cells across. Three
  causes, each seen in the cells' branches, traits and times replaced:
  (1) the fields pass on cell by cell at a chance of 1 where the land
  suits, and each cell took the traits of the one cell they came from:
  each people where the front left became a ray along the mesh; a
  replaced cell now takes the heart of the people with the most farmers
  among its neighbours. (2) Step 1's branches are subtrees of a search:
  wedges and bands with straight sides, without the replacement too; the
  seed makes them compact (each cell to the branch whose heart is nearest
  by the ways' days, one round). (3) The herds replaced where the
  foragers were few when they came, and the foragers rise and fall with
  the climate: rings of herder peoples (on Thalassor's north 7, 34, 8,
  33, 10, 55, 17, 49 % replaced by 500 years of coming); the herds now
  replace no traits. The history stays the same bits but the peoples and
  their events. The peoples at the end: Morvane 153 (167 before),
  Thalassor 189 (191), Zephyra (origin 783 702) 170 (173); the largest
  2.8, 3.2, 4.2 % (3.0, 3.1, 4.0). The peoples with a border over three
  times a disc's of their cells: 7, 16, 12 (38, 62, 71). The chronicle:
  Morvane 39 splits, 7 merges, 26 turns to farming (33, 5, 27);
  Thalassor 25, 2, 25 (28, 1, 30); Zephyra 52, 12, 10 (30, 2, 11).
- 2026-10-29: the chronicle's splits and merges once they held (the
  incubator's v6; `casas-incubator` peoples.rs `Tree::tell`). Zephyra's
  52 splits and 12 merges were mostly flaps: parts at their border's
  distance join and part again, and the ids swap (the larger overlap
  keeps the id), so that the guard of the lives held for the new id. In
  the history as the job runs it (with the rain's variability; 51 splits,
  10 merges): two parts of 186 000 and 192 000 km² told as 4 splits and 3
  merges from 57 500 to 78 000; of the 61 told 37 of a part told before
  (the same km² within 2 %); all 10 merges parted again 500 to 2 000
  years after. A split or a merge is told now when it held 5 000
  years by the two peoples' hearts, not when its id lived 5 000 years;
  not a split that undoes a join of the last 5 000 years, nor one of a
  part whose split is still kept back. That alone: Morvane 22 splits, 1
  merge (39, 7 before); Thalassor 19, 1 (25, 2); Zephyra 27, 0 (52, 12).
  Of these splits 21, 18 and 21 in step 2's first 4 500 years, then none
  until 13 000, 7 000 and 5 000 years: no split is told in step 2's first
  5 000 years. All: Morvane 1 split, 1 merge, 0 gone, 26 turns to
  farming; Thalassor 1, 1, 0, 25; Zephyra 6, 0, 0, 10. The splits by
  fifth of the history 0 0 1 0 0, 0 0 1 0 0, 3 3 0 0 0 (before 31 4 2 1
  1, 20 3 2 0 0, 42 8 2 0 0), the merges 0 0 1 0 0, 0 0 1 0 0, none
  (before 0 3 1 3 0, 0 0 2 0 0, 5 6 1 0 0). The peoples, their ids and
  all other arrays and events keep their bytes. The incubator's smoke worlds tell no split
  now (the torus's history is 7 000 years; the sphere's later splits all
  join again).
- 2026-10-29 (v6 still): splits, merges and peoples gone are told from 0.1 %
  of the land lived in, the turns to farming from 0.5 % as before: the
  user wanted a few more. Without rain (splits / merges / farming):
  Morvane 3 / 1 / 26, Thalassor 8 / 6 / 25, Zephyra 21 / 1 / 10. A lower
  share adds few splits (most later ones are flaps the hold drops) and
  many turns to farming, hence the two shares.

Open:

1. Step 2's times against the earth's (the copper, the smelting, the city
   after the farming).
2. The peoples' splits in the chronicle: few once they must hold 5 000
   years and not come in step 2's first 5 000 years (1, 1, 6 on the
   three worlds); a lower share of the land lived in to tell
   (SPLIT_TOLD_SHARE) would tell more (2026-10-29).
3. The far trade: where which goods came from, for step 3 (above, the
   exchange).
4. Step 1's sea-level curve: drawn from the world's seed, or a control.
5. The dry shelf's own land fields (idea, with the next generator round):
   the engine's ecology with the shelf down to −120 m as land, in today's
   climate, kept with level 1; it replaces the coast's values the shelf
   takes now.
