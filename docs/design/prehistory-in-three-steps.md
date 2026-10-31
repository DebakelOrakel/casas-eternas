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
area: incubator
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

Controls: the origin (a click on the globe). Since 2026-10-30 also two
sliders in the step's column: the reach over the sea at the step's end
(100 to 1 000 km, default 450; it grows from 30 km), and the lowest sea
level, the sea's drop at the coldest (60 to 150 m, default 120). The sea
curve keeps its shape, only its depth changes, and step 2 continues the
same curve. A change makes step 1 again, as a new origin does. The
controls are part of H1's input and of its key (`H1:<cell>:r<km>:s<m>`, a
default left out, so a history at the defaults keeps its key;
`casas-incubator` peopling.rs `Controls`).

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
- **The land drying**: the dry climates (Köppen BW, BS) between 10° and
  35° are a class wetter from step 2's start (a desert carries and grazes
  as a steppe, a steppe carries as a savanna), and dry once, from 4 000
  to 6 000 years after it (from the seed): abrupt at the belt's poleward
  edge, 2 000 years later and over 2 000 years at its equatorward edge,
  as the green Sahara's end. A cell with a river stays wet. A drying
  cell sends the people it carries no more to the neighbours, as the
  rising sea; the first large loss of each landmass is told in the
  chronicle.
- **The sea**: no open sea until ships fit for trade. Boats go along
  the coast and to land in sight, 100 km of open water at most (Cyprus,
  some 70 km off and seen from the coast, was settled at +1 000).
- **The copper**: a farmers' village that stood 500 years within 20
  days of a deposit finds it and hammers it; one that knew it 2 500 years
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
  (settle.rs). Built 2026-10-30: where which goods came from, in H1
  (settle.rs `Goods`, pack.rs): each source of the far trade (its cell,
  its good — tool stone, salt or copper — and the village its goods
  leave from) and, by village, its share of each source's goods, as the
  links weigh them. The landmass of a source is that of its cell. Like
  the links, it is the trade of the history's end, over all its villages
  and camps.
- **The climate's events, in this order:** (1) the rising sea drowns
  cells, their people go to the neighbours, and a large loss is told in
  the chronicle (a coast goes under, as Doggerland) — built 2026-10-28;
  (2) one or two cold spells drawn from the seed, as the 8.2 ka event,
  some centuries of more drought and cold through the droughts already
  there, told in the chronicle — built 2026-10-28; (3) the land drying,
  as the green Sahara's end, a wetter early Holocene in the subtropics
  that fades toward today — looked at again with the towns, as a cause of
  centres in river valleys. Built 2026-10-29 (Status).

### The climate in step 2

What step 2 needs is the ice age's end:

- **The sea rises** from −50 m to today's level: coasts go under, their
  people move to the neighbours, a large loss is told in the chronicle.
- **The land dries.** On the earth the green Sahara ends near +6 000,
  and people move into the river valleys. A cause of centres. Built
  2026-10-29 (`casas-incubator` climate_history.rs, simulation.rs THE
  LAND DRYING).
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
- 2026-10-29 (v6 still): the land drying (`casas-incubator`
  climate_history.rs and simulation.rs THE LAND DRYING). Step 1 keeps
  its bits. With the rain, against before: the dry belt is 9.9 M km² on
  Morvane, 3.9 M on Thalassor, 7.5 M on Zephyra (origin 783 702), 3 % of
  it with a river; 8.7 M, 3.5 M and 7.0 M km² dry again from +5 000 to
  +10 000, 171 000, 24 000 and 126 000 people move away; the chronicle
  tells 3, 2 and 1 (at 250 000 km² in 500 years, once a landmass; at
  each such step 9, 13 and 8). The people at step 2's start 18, 5 and
  25 % more (the belt's 1.8, 1.8 and 2.2 times). In the belt the share
  of the people near a river at +10 000: 20.1 % (8.5 before), 14.3 (8.5),
  14.6 (10.1). The milestones hardly move: Morvane the herding 500 years
  earlier, the copper, the smelting and the city 500 later (+24 500);
  Thalassor the same; Zephyra the smelting at +18 500 (+22 500), no city
  in the span as before; the land farmed the same (7.4, 9.0, 4.7 %), the
  people at the end −1.9, +0.8 and +1.6 %. The farmers' villages near a
  river 40.0, 22.2 and 42.7 % (38.8, 21.9, 41.6), and no large town in
  the belt, as before: the drying moves the belt's foragers and herders
  to its rivers, but the belt holds no centre, so it makes none in a
  river valley.
- 2026-10-29 (v6 still): step 2's times toward the earth's, the tuning
  alone; step 1 keeps its bits. With the rain, six origins on each world
  (Zephyra from 783 702 and five cells of its largest landmass), the
  median before → after; the farming from step 2's start, the rest from
  the first farming. The first farming: Morvane +5 500 → +1 000,
  Thalassor +3 500 → +1 500, Zephyra +5 500 → +1 500 (500 to 6 000; the
  earth's 0 to 1 500). It waited on the stable climate alone (the
  knowledge and the settled years were met from +1 500): the curve is the
  sea's, and the warmth came before the sea (the Holocene began with the
  sea near −60 m); stable now under 0.5 for 1 000 years (0.15 for 2 000),
  at +500 on all three, and the first farming waits on its chance. The
  copper: +19 500 → +18 500, +4 500 → +4 000, +11 000 → +11 500 (the
  earth's +1 400 … +2 100). It waits on the way to it: the first centres
  are 1 100 to 3 900 km from rich copper, the generator's copper lies in
  the mountains alone, and the fields' front (1 km a year, as the
  earth's) brings a farmers' village within 20 days 3 500 to 22 000 years
  after the first farming; 32 days changed nothing. A village needs 500
  years, not 1 000 (the copper minerals were known before the farming).
  The smelting: +23 500 → +21 500, +8 000 → +7 000, +14 000 → +14 500,
  3 000 years after the copper on each world (3 500; the earth's 2 600 …
  3 300): it smelts 2 500 years after it knew the copper (3 000). The
  city: Morvane +34 500 → +34 500 (one origin of six none, as before),
  Thalassor +12 500 → +12 500, Zephyra none (the earth's +6 000 …
  +6 500). It waits on a hinterland of 22 200 people within a day of a
  village that smelts: at Morvane's one such seat (27 600 people) the
  city comes when the smelting reaches it; on Zephyra the densest
  hinterland is 18 800 people (20.5 a km² at its seat, arable 0.32), its
  town at most 8 500. The land farmed, the people and the big peoples
  hardly move: 6.7 to 7.4, 9.0, 4.7 % farmed; 8.0 to 8.5, 7.7 to 8.2
  (2 000 years shorter: its city earlier), 5.3 M people; 144 to 168, 170
  to 194, 159 to 187 big peoples. The herding now comes with the farming
  (median −500 … +500 after it; +1 000 … +4 500 before). The smoke torus's
  history is 4 000 years (7 000), and no merge of it holds 5 000 years
  to be told.
- 2026-10-29 (v6 still): step 2's times on the generator's v15 ecology
  (DEC-0052, DEC-0053: arable land of 0.3 or more on 26.9, 31.2 and
  15.3 % of the land of Morvane, Thalassor and Zephyra, 10.7, 15.6 and
  5.3 before; copper near the fields), the tuning alone. Measured on L1
  stores with the new ecology on the old mesh, with the rain, the six
  origins of the last line on each world; the median from the first
  farming, v14 → v15 with the tuning before → after. The first farming
  from step 2's start: Morvane +1 000 → +1 000, Thalassor +1 500 → +500,
  Zephyra +1 500 → +1 000. The copper: +18 500 → +3 500 → +2 500,
  +4 000 → +1 500 → +1 500, +11 500 → +8 000 → +8 000 (the earth's
  +1 400 … +2 100). It waits on the way to the copper: COPPER_DAYS 32 (20),
  the obsidian's reach, brings Morvane's finds 500 to 1 000 years
  earlier; Zephyra's fields fill 3.2 M km² by +6 500 with no rich copper
  within 32 days. The smelting: +21 500 → +6 500 → +5 500, +7 000 →
  +4 500 → +4 500, +14 500 → +10 500 (2 of 6 before the city) → +11 000
  (the earth's some +4 500), 3 000 after the copper. The city: +34 500 →
  +9 500 → +9 500, +12 500 → +6 500 → +6 000, none → +11 500 → +13 500
  (the earth's +6 000 … +6 500); from step 2's start 10 500, 6 500 and
  14 500. The farmers are denser (FARM_GAIN × the arable land: the farmed
  cells' p90 17 a km², 4.6 before), the largest hinterlands 46 000 to
  50 000 people on Morvane, 25 000 to 33 000 on Thalassor, 79 000 to
  86 000 on Zephyra (some 22 000 before): a town of Zephyra's densest
  farmland was a city without the copper, and Zephyra had its city before
  the smelting from 4 of 6 origins. TOWN_SHARE 0.1 (0.15) and SMELT_SHARE
  0.25 (0.2), a smelting town's 0.45 as before: the city after the
  smelting from 18 of 18 origins, Thalassor's 1 500 years after it, as on
  the earth. Morvane's city waits on the smelting at a dense seat: the
  copper is found where the hinterlands are 1 400 to 4 700 people, and
  the smelting reaches one of 22 000 or more 3 000 to 5 000 years later;
  the fronts pass a cell a step at most (some 0.4 km a year at 10 km and
  25 years, below FARM_KM_A and COPPER_KM_A: COPPER_KM_A 2 changed
  nothing). The land farmed 6.8, 9.0, 4.7 → 10.7, 7.6, 10.1 % (the
  histories 10 500, 6 500 and 14 500 years long, 35 500, 14 000 and
  46 500 before); the people at the end 8.1, 7.7, 5.3 → 23.7, 6.3,
  24.0 M; the big peoples 159, 176, 169 → 145, 163, 172; 3, 2, 2 farming
  centres. The chronicle (the own origin, Zephyra 783 702, with the rain;
  splits / merges / turns to farming): Morvane 3 / 0 / 39, Zephyra 11 / 3
  / 28; drowned 5, 10, 10, drying 3, 2, 1, cold spells 2, 0 (Thalassor's
  history ends before them), 2. The peoples' stripes are back (border over
  three times a disc's: Morvane 23, Zephyra 23; v14 4 and 12), the same
  before and after the tuning: the replacement's rays along a wide front
  of fields (`kin_of`), none without the replacement. Step 1 reaches the
  same share of the land from each origin (Morvane 95.4 %), 4 to 12 % more
  foragers, the landings within 130 years; Thalassor's own origin is
  another (996 766, a landmass of 3.7 M km²: 14.8 % of the land reached,
  72.0 % from 149 889 before), and from it step 2 has no copper in reach
  and no city in the span, 95 big peoples at the end.
- 2026-10-29 (v6 still): the fronts at their km a year (simulation.rs
  THE FRONTS' TIMES). A front cell passed on by a chance of km_a × 25
  years over the km, 1 at most, and a cell reached passed on from the
  next step only: one cell a step, 0.3 to 0.45 km a year for the fields,
  the herds, the copper and the smelting on the three worlds' 10 km
  cells (FARM_KM_A and COPPER_KM_A 1, HERD_KM_A 2). Now each front cell
  keeps when it took what it passes on, a hop takes its km over the km a
  year (times the barrier where the land does not suit), and a step's
  hops come in their times' order: the fields 0.9 to 1.0, the herds 1.8
  to 2.0 (1.0 or less where the land that suits them is thin), the copper
  and the smelting 1.0 km a year (the earliest arrival over 50-km bands
  of mesh distance from the first centre or find, six origins a world).
  Deterministic: no draw for a hop. The same origins and harness as the
  line before; the median from the first farming, before → after. The
  first farming from step 2's start the same (1 000, 500, 1 000). The
  copper: Morvane +2 500 → +2 500, Thalassor +1 500 → +2 500, Zephyra
  +8 000 → +11 000; the smelting +5 500 → +5 000, +4 500 → +5 500,
  +11 000 → +14 000 (3 000 after the copper as before); the city +9 500
  → +6 000, +6 000 → +7 000, +13 500 → +14 000, after the smelting from
  18 of 18 origins (Zephyra's in its climate step). The faster fields
  fill a region before its own centre comes: a second centre comes later
  (Thalassor's, on the copper's landmass, at +2 000, +1 000 before; its
  six origins are two histories), and Zephyra's copper waits on its
  first centre's fields, 3 700 km from the find, across some 400 km of
  thin arable land the fields cross from +3 400 to +7 700. Morvane's
  city no longer waits on the smelting's way to a dense seat. The land
  farmed 10.7, 7.6, 10.1 → 10.7, 10.1, 9.8 %; the people 23.7, 6.3, 24.0
  → 33.5, 9.8, 23.5 M; the big peoples 145, 163, 172 → 139, 162, 168.
  No retuning: COPPER_VILLAGE_YEARS 0 (500) brought the copper and the
  smelting 500 years earlier and Zephyra's city before the smelting from
  2 of 6 origins. The stripes (border over three times a disc's, the own
  origin, Zephyra 783 702, without the rain): Morvane 17 → 25, Thalassor
  11 → 7, Zephyra 24 → 31; of them farmed more than half 11 → 8, 8 → 3,
  14 → 18.
- 2026-10-29 (v6 still): the peoples without the stripes again
  (`casas-incubator` peoples.rs THE STRIPES AGAIN, FIELDS_AROUND). Two
  causes, seen in the cells' peoples, branches and times replaced: (1)
  on a wide front of fields the farmers who decided before a cell are
  the few behind it, its neighbours to the sides pending as it is, and
  the people of the most farmers among its neighbours was the ray
  behind it; (2) where the fields are a strip (a valley, a coastal
  plain, the arable land's fringe) the strip took one people along its
  length, through the foragers' peoples, with a mosaic edge. Now a
  replaced cell takes the nearest heart of a farmer people on its
  landmass (where none, its fields' centre): the farmer peoples part
  the land they take as the seed's branches do, and grow as blobs that
  split (THE SPLIT) into compact daughters. And it is replaced only
  where the fields are on 0.85 of the lived km² within 40 km of it: in
  a strip the foragers keep their traits. Either alone did not do (the
  centre's people alone grew as a ring around its daughters). Without
  the rain, Morvane, Thalassor from 149 889 and from its own origin,
  Zephyra from 783 702: the peoples with a border over three times a
  disc's 25 → 19, 41 → 10, 7 → 4, 31 → 12 (of them farmed more than
  half 8 → 12, 15 → 4, 3 → 3, 18 → 8); with the rain, by the tree's ids
  (Thalassor from 149 889) 21 → 15, 23 → 7, 30 → 12. The fields replaced
  52 913 → 38 031, 37 429 → 27 103, 7 714 → 4 687, 38 547 → 30 661; the
  big peoples 164 → 171, 178 → 169, 89 → 100, 169 → 178; the largest
  5.9 → 3.3, 3.8 → 3.2, 9.7 → 6.0, 2.9 → 4.1 % of the land lived in. The
  chronicle with the rain (splits / merges / gone / turns to farming):
  Morvane 0/0/0/20 → 0/0/0/32, Thalassor 0/0/2/21 → 0/0/1/26, Zephyra
  23/1/0/17 → 15/0/0/22. All other arrays and events keep their bytes;
  Morvane's history 2.6 → 3.0 s.
- 2026-10-30: where the far trade's goods came from, in H1 (the
  incubator's v6, unreleased: four arrays after the peoples; settle.rs
  `Goods`). The history runs the settlement once more at its end and
  keeps the goods alone; the settlement's pack stays as it was. All
  other arrays and events keep their bytes (incubatorSmoke: the history
  without the goods, the peoples and the settlement are the reference's).
  The smoke test's worlds: the torus 13 sources, 232 shares, H1 +0.12 %;
  the sphere 22 sources, 1 768 shares, +0.44 %.
- 2026-10-30 (v6 still): the dry shelf's own ecology and the flood silt
  (TEG-13, TEG-108). Level 1 holds the ecology's fields of the shelf down
  to 120 m, computed with the shelf as land in today's climate
  ([DEC-0049](../decisions/shelf-and-sea.md), Status); a dry shelf cell
  carries what that gives it (`ground_of`), not its coast's. And the
  generator's arable land has the flood silt of the large rivers
  ([DEC-0052](../decisions/arable-crops.md), the flood silt). Measured on
  L1 stores of the three worlds with the new ecology on their mesh, with
  the rain, the six origins of each world; medians, before → after. The
  shelf's carrying capacity at the mean 0.50, 0.57, 0.42 (the land's
  0.40, 0.39, 0.28: lowlands at a warm coast, with fish); with it alone
  the people at the end 33.7 → 35.0 M, 9.8 → 10.9 M, 23.5 → 23.4 M, the
  people the rising sea moves (all its events) 5 100 → 4 800, 22 700 →
  21 900, 23 200 → 20 300. With both: farming centres in the dry belt
  (cells of Köppen B) over the six origins 7 → 10 on Morvane, 0 → 5 on
  Thalassor, 0 → 0 on Zephyra; all of them in the steppes (BS), none in
  the deserts (BW): a floodplain some kilometres wide is diluted in a
  cell of 10 km, whose arable land is the mean over its land, and a centre
  needs CENTRE_ARABLE 0.5. The cells of B with arable land of 0.5 or more
  1.70 → 2.22, 1.22 → 1.40, 1.04 → 1.13 % of the belt. The history's
  length 7 000 → 6 750, 7 500 → 9 500, 15 000 → 16 500 years; the people
  at the end 33.7 → 33.1 M, 9.8 → 13.3 M, 23.5 → 23.7 M; the land farmed
  10.7 → 10.8, 10.1 → 11.1, 9.9 → 9.9 %. The smoke test's sphere tells no
  merge with seed 29 now; seed 5 reaches all.
- 2026-10-31 (v6 still): the post-glacial rebound (TEG-22;
  `casas-incubator` climate_history.rs THE REBOUND). The ice pushes the
  crust down by 0.28 of its thickness (a plastic ice sheet's profile, some
  3 000 m at 400 km from its margin), and the crust follows the ice with
  a time constant of 4 000 years (the earth's 3 400 to 4 200). A cell of
  the ice's land below the sea of its time is sea, in step 1 and step 2:
  where the ice melts the sea comes in, and the land comes up out of it.
  No sinking beyond the ice's margin, no peripheral bulge. The land of
  the former ice under the sea (Morvane, Thalassor, Zephyra): at step 2's
  start 11 000, 167 000 and 41 000 km²; at its most 58 000 km² at +4 500,
  629 000 at +3 000, 451 000 at +4 500 (the melt's end); half of it up
  again 2 000 and 3 500 years later on Thalassor and Zephyra, not before
  Morvane's history ends; at the histories' ends (origins 514 170, 149 889, 783 702) 31 000 km²
  left at +7 000, 74 000 at +7 500, 39 000 at +15 000. Step 1 reaches the same land
  (95.4, 73.0, 84.9 %). Step 2's times over the six origins of each world
  (medians from step 2's start, before → after; the copper, the smelting,
  the city): Morvane +3 750 → +4 500, +6 750 → +7 500, +7 500 → +8 750;
  Thalassor +3 500 → +2 500, +6 500 → +5 500, +8 000 → +7 500; Zephyra
  +13 000 → +13 000, +16 000 → +15 500, +16 500 → +16 500. The rebound
  floods land no one lives in yet (the ice left it), and it moves the
  histories by their draws: the land farmed and the people at the end
  hardly change. The incubator's map draws the coast by the sea's drop
  alone: it does not show the sunk land (until the next entry). The smoke
  test's sphere reaches no herding centre and no told merge with seed 5
  now; seed 4 reaches all.
- 2026-10-31 (v6 still): the rebound on the map and in the chronicle
  (TEG-22). The map's "Ice and sea level" layer draws the sunk land as
  sea at the time shown, in step 1 and step 2, from the crate's runs
  (climate_history.rs `flooded_runs`, through the WASM build's
  `floodedRuns`; no copy in TypeScript); the old stone age's people are
  not drawn on it. The log tells where the sea comes into the land the ice
  left (`seaFloodsIce`) and where it comes up again (`landRises`), per
  landmass, REBOUND_TOLD_KM2 (100 000 km²) or more in a CLIMATE_YEARS
  (simulation.rs THE REBOUND'S COASTS). The climate alone moves them: on
  Morvane none (at most 19 000 km² a step), on Thalassor five floods
  from +1 000 to +3 000 (104 000 to 165 000 km²) and a rise at +4 000
  (100 000), on Zephyra a flood at +4 500 (110 000).

Open:

1. Step 2's times against the earth's (2026-10-29, Status, v15
   ecology, the fronts at their km a year): the farming, the smelting's
   interval and Morvane fit; Thalassor's copper, smelting and city are
   one climate step late (+2 500, +5 500, +7 000: its second centre at
   +2 000); the copper on Zephyra waits on the way from its fields to
   its copper (+11 000), its city on the smelting (+14 000). TOWN_GROWTH_A
   0.001 would bring the cities 500 to 1 000 years earlier. To tune again
   when the generator's height and climate rounds of v15 are in
   (2026-10-30): the threshold of a farming centre (CENTRE_ARABLE 0.5:
   13 to 20 % of the land has arable land of 0.5 or more on the v15
   ecology, 1 % before), the times of the copper and the city, Zephyra's
   city, the number of peoples.
2. The peoples' splits in the chronicle: few once they must hold 5 000
   years and not come in step 2's first 5 000 years (1, 1, 6 on the
   three worlds); a lower share of the land lived in to tell
   (SPLIT_TOLD_SHARE) would tell more (2026-10-29).
3. Done 2026-10-30: the far trade's sources of the goods in H1, for
   step 3 (above, the exchange; Status).
4. Done 2026-10-31: step 1's sea-level curve stays drawn from the
   world's seed; its depth is a control (2026-10-30, Step 1), its shape
   is part of the world (TEG-8).
5. Done 2026-10-30: the dry shelf's own land fields (Status; TEG-13).
6. The peoples' stripes on the v15 ecology: the rays are gone
   (2026-10-29, Status). What is left are farmer peoples the shape of
   their farmland (Morvane's north coastal plain: one people some
   1 000 km by 150 km) and forager peoples with farmers' enclaves or
   left between two farmed regions; the measure (border over three
   times a disc's) counts the enclaves' borders too.
7. Done 2026-10-31: the origin when none is given is the one of the
   landmasses of 1 M km² or more from which step 1 reaches the most land
   (TEG-7). Before, the land that fed best: Thalassor's (996 766) on a
   landmass of 3.7 M km², 14.8 % of the land reached, no city in step 2;
   Zephyra's 7.5 %. Now Morvane 95.4 %, Thalassor 73.1 %, Zephyra
   85.0 %; the largest landmass alone gave Morvane 50.7 %.
8. No farming centre in the deserts (BW) since the flood silt either
   (2026-10-30, Status): the floodplain is narrower than a cell, and a
   cell's arable land is the mean over its land. Decided 2026-10-30: no
   centre in the deserts (on the earth the Nile was no origin; the
   fields came from the Levant). But a cell suits the fields when its
   land's best share reaches FARM_ARABLE, not its mean, so that the fields
   reach a desert's floodplain; the carrying capacity keeps the mean.
   With TEG-10.
9. The large eruptions (incubator v6, TEG-21): an eruption as Toba or
   Santorini, an event in step 2's chronicle, with ash, cold years and
   people who leave. Level 1 holds what it reads since 2026-10-30: per
   volcano its place, size, kind, crust and whether it is active
   ([DEC-0051](../decisions/volcanic-islands.md), Status, with the
   explosivity rule proposed from the earth's VEI scale). Not built.
