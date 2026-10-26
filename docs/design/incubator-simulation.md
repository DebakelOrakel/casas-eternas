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

## Progression: conditions, not dates

The rules set dates (2026-10-26): the farming from 11 000 years before the
game, a centre every 1 000 to 3 000 years after; the herding from 8 000;
the land bridges until 10 000; the reach over the sea growing evenly with
the time. Every world runs the same calendar, whatever it is like.

The simulation sets none. An event has a chance a step that follows from
the state, and its date comes out:

1. **A climate history of the world**: a glacial cycle over the span, its
   depth, its maximum and how fast it ends drawn once from the world's
   seed. From it the sea level (the shelf, the land bridges), the ice's
   edge (land that opens as it melts), the dryness of the cold, and a warm,
   stable climate as a condition of the farming — on the earth it began
   only in the Holocene. Still a curve, but one cause instead of a date a
   rule; the droughts sit in it.
2. **Knowledge grows with people and contact**: a region's knowledge grows
   with its people and its exchange with its neighbours, and a small
   isolated group loses some (Henrich: the cumulative culture of
   connected populations). From it the boats' reach — many people on a
   coast with boat wood build better boats — and the readiness to tame.
3. **Settled before farming**: where fish or wild plants are rich enough,
   people stay and grow dense (the Natufians, the Jōmon); a settled, dense
   people tames, by a chance growing with its density, how long it has
   been settled, its wild crops and its knowledge. The centres come where
   that comes together best, several apart.
4. **The herding two ways**: farmers tame the herd animals near them;
   hunters who follow a herd long enough tame it without fields (the
   reindeer).

Calibrated by the rates, not by dates: a world should give the world's
timeline (Status) on the mean — the large landmasses by some 40 000, the
farming by 65 000 … 70 000, the far islands late; a world poor in crops farms late or never, and rightly.
The rules stay the preview, with their dates.

Order: the climate history first (the sea, the bridges and the droughts
hang on it), then knowledge and boats, then the settling and the taming.

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

**The climate history** (`climateHistory.ts`, the same day): the cold
curve drawn from the seed (Morvane: deepest at year 82 380, depth 0.85,
the melt 10 600 years); the sea's drop in proportion (to 120 m at cold
1); the ice grown out of today's glaciers over the cold climates (Köppen
D, E) up to 800 km at cold 1; what the land carries lowered by the cold,
the cold climates most. Every 500 years the cells' carrying is made
again; a cell under the ice or the sea is left, and may be settled again.

On the way, two faults of the skeleton came out: a crossing could land on
a coast of ice, where its people were 0 — and still settled the land
beyond (the skeleton's 82 % on Morvane were that); and with one crossing
a pair of landmasses, every sea km counted, Morvane's first continent was
258 km of open water from any other coast people can live on. Now: the
crossings join REGIONS (the habitable land's connected parts, a landmass
the ice cuts being several), the reach limits the longest stretch of open
water (a sea cell beside land ends it: boats keep to the coast, past the
ice), a voyage is 3 000 km at most, 32 crossings a pair of regions. On
Morvane: 98.5 % of the ice-free land reached (the rules 82.9 %), 1 182
crossings, the arrival's median at year 43 700; 4.1 s. More than the
rules: the boats' reach still grows evenly with the time — knowledge
(above) is to rein it in.

**Knowledge and boats** (the same day): a region's knowledge moves every
500 years toward log10(1 + its people / 10 000), a tenth of the way up, a
fiftieth down; people who cross bring 0.8 of theirs; a coast's reach is
30 km + 150 km × its region's knowledge, 450 at most. On Morvane: 50.2 %
of the ice-free land reached, 951 of 2 712 regions (most of them small
pockets the ice leaves), the arrival's median at year 11 200 and its
90th percentile at 96 700 (land the melting ice opens); the first
continent (4 M km²) at knowledge 1.57, a reach of 266 km, the largest
region (15 M km²) reached late, at 0.46; 3.4 s. Uncalibrated.

**The game and the hunt** (the same day): a cell's small game and big
game, a share each of what the land holds, grow back (5 % a year, the big
0.2 %) and are hunted by the people there by their density (2 % and 1 % a
year at the foragers' full density); the big game of the people's own
landmass, which grew up with them, at a tenth of that. The foragers live
half on plants, the rest on the game, so a hunted-out land feeds fewer. A
species of the big game is gone from a landmass when its cells there
hold less than a tenth of it — the history's extinctions take the rules'
drawn ones' place. On Morvane: 23 extinctions, the first from year 3 500
on the landmasses reached early, many more at the end as the ice frees
land and people with it; the reach 32.6 % of the land against 34.7 %
without the hunt; 9.6 s (a cell is grown again only when what it carries
moved by 2 % or more).

Then the big game by species: each its own share, a vulnerable one (the
rules' MEGAFAUNA weights, the elephant 0.8 … the aurochs 0.2) growing back
slower and hunted harder; the people's own landmass's big game hunted at
3 % (at 10 % its elephants went too). On Morvane: 18 extinctions, the
elephant first (from year 7 000), the horse, the camel; the aurochs holds
to the end but on one landmass. The kept states hold the game too, in a
compact form (the people in 16 bits, the shares in 8: some 5.5 MB a state,
225 MB for 41), and the animals' layers show it in a history: the big
game by its species' share, the hunted ones by the small game's. 14.5 s.

**The farming and the herding** (the same day), no dates: every 500 years
each region's best cell may become a centre, by a chance, once the climate
is stable (warm and calm 2 000 years: the Holocene), people have lived
there 5 000 years, the region knows enough, and wild crops (two or more,
good arable land) or herd animals (two or more, good pasture) are there;
1 500 km from any centre of the same lifeway (across the lifeways it
kept the farming from the one place fit for it). A farming centre tames
its wild crops, its herd animals 1 000 years later. The domesticates
spread step by step over the cells people live in (the fields 1 km a
year, the herds 2), each where it suits; the fields carry up to 100 times
the people, the herds 10. The settlement takes these in the rules' place
(settle.ts `given`). On Morvane: the farming at year 93 500 (millet,
rice, yam, cassava), its herds at 94 500, two herding centres at 97 500
and 98 000; the fields on 8 536 cells, the herds on 3 135. 18 s.

**The world's timeline** (the same day, asked for): the departure in year
0, the large landmasses reached by some 40 000, the cold deepest at 40 …
55 % of the span (it was 76 … 86 %, after the earth: no farming before
year 85 000), a stable warmth from some 60 000, the first fields by
65 000 … 70 000, some 30 000 years of farming before the game. With it
the ice reaches 400 km from today's glaciers at cold 1 (800 shut half of
Morvane for most of the cold), a cell settles its neighbours from a third
of what it carries, the knowledge counts its people by 3 000; in the
rules the farming from 67 000, the herding from 70 000, the bridges until
60 000.

**The crossings from empty coasts** (the same day): a coast set out when
its people were a third of what it carries — 0 of 0 under the ice, and on
coasts never reached. A third of Morvane's crossings came from nowhere;
they made its "6 of 7 large landmasses in the first century", and gave
`from` circles that left whole continents without routes. A coast sets
out with people only now. Honestly reached, 3 of 7: the way to the
largest (16 M km²) runs over some 100 regions of 1 to 10 cells along a
cold coast, each a crossing at 2 % a step. Two cheats, asked for ("not
100 % realistic, but it works"):

- **The seafaring**: a crossing brings its source's reach knowledge in
  full, and it never falls; every 500 years it passes both ways along the
  crossings made. The reach takes the larger of it and the region's
  knowledge.
- **The stepping stones**: from a region of fewer than 100 cells people
  set out with any people, every crossing at 50 % a step.

On Morvane: all 7 large landmasses, 4 of them by year 6 825, the 3 cold
ones (under the ice) once it melts, 61 600 … 66 850; the fields from
62 000, the herds from 60 000; some 24 M people at the end.

**Fewer marks** (the same day): the routes cut at 3 % of all the land
reached (0.5 % at first), and only the landings the chronicle tells (the
first on each landmass) keep their branch under it: 66 lines on Morvane,
190 before. A domesticate is tamed once on a landmass — a centre counts
only the wild ones not tamed there yet — and the chronicle tells its
first taming only; the herding at 10 % (20 %).

**The fishers, the villages, the people** (the same day): where the fish
are rich (0.5 or more), people who have lived there 3 000 years stay and
grow dense, the fish carrying up to 10 times the people where no fields
do. Every 500 years the densest cell of the farmers or the fishers with
no village near founds one (the rules' measures: 2 a km² and 3 rings for
the farmers, 0.3 and 5 for the fishers); a village whose people fall
under half of that is left. The people over the span are the
simulation's own count. The settlement takes the villages and the count
in the rules' place and lays the trade on them; the screen shows a
village from its founding to its leaving. Before, a history's villages
and people were the rules', from its times. On Morvane: the first
village (fishers) at year 3 500, 55 by 30 000, 224 at 65 000, 394 at the
end, none left; some 470 000 people through the cold, 2.5 M at 70 000,
5.7 M at the end (the rules 24 M).

**The waves through unsuiting land** (the same day): the fields and the
herds spread through suiting cells alone, so they ran out along the
arable and pasture strips in fronds, and half the suiting cells were never
reached (88 420 of 184 704 on Morvane); a cell that had passed its first
domesticate on passed none it took later. Now a wave crosses land it does
not suit 5 (fields) and 3 (herds) times slower, kept nowhere there, as
the rules' do; every domesticate a cell takes puts it on the front. On
Morvane: 4 % of the suiting cells left unreached; the fields on 40 618
cells, the herds on 83 338; 686 villages, 8.7 M people at the end.

**The routes' tree made after the run** (the same day): `from` as settled
(each cell to the neighbour that settled it, by a chance) drew the routes
as hair, and reached the origin from a seventh of the land. Now the tree
is made after the run: the shortest ways from the origin over the cells
reached, never to a cell settled more than 1 000 years before the one it
leaves. The routes cut at 1 % of the land reached: 34 lines on Morvane.
The quickest ways, at the simulation's speeds, ran along the rivers and
the coasts in zigzags (a line 1.27 times its chord, now 1.12). A line's
width follows the land reached beyond it, 8 to 50 km (the people beyond,
to 110 km, swelled it where it entered the fields).

**The droughts** (the same day): the land in squares of 300 km a
landmass (818 on Morvane). Each step a square's rain is its mean times
1 + 0.25 × its variability (the save's, a year's: a step's mean of 25
years varies less) × an anomaly — its own random walk (0.6 of the last),
and in a step with a strong ENSO (30 % × the see-saw's strength) 1.5 ×
its mark. Under 0.75 a step is dry; two in a row the stores take, more
are a famine: the fields and the pasture give the rain's share, the
plants and the game half the shortfall less, the people more than that
die at once, a village under half its least is left. The famines go into
a log of the simulation's own (`famines`); the chronicle tells those
that cost 30 % of their square's people and 10 000 or more, the ones on
a landmass within 1 000 years of each other as one. On Morvane some 650
famines, 12 told (29 by the 10 000 alone, 92 by the share alone), most
of them after the farming began; 2.7 M people lost over the span. With the
year's variability whole and a famine from the second dry step: 71 814
famines, 3 597 told.

**The map shows the history's people** (the same day): in a history the
density, the clearing and the cells lived in are the kept state's at the
time shown (every 2 500 years, the last before it), no longer the rules'
density from the history's times; a cell people left (the ice, the sea, a
famine) is empty. The lifeways' shares stay the times' — the history's
own arrival, fields and herds, weighed as the rules weigh them.

**The log** (the same day, `historyLogShared.ts`): the simulation writes
every event when it happens — the departure, each crossing (`first` when
it was the first arrival on its landmass by any way), the centres, the
domesticates, the extinctions, the villages founded and given up, the
famines, the people's marks (100 000, 1 M, 10 M, between the counts);
the settlement adds the first trade. For the rules a log of the same form
is made from their times (`settle.ts` rulesLog). The chronicle reads the
log alone and picks what it tells (the first taming of each domesticate,
the first village, the first crossing to a large landmass, the large
famines); the crossings drawn are the told ones. On Morvane a history's
log holds some 2 600 events (1 567 crossings, 694 villages, 301 famines).

**Between the kept states** (the same day): the people at the time shown
are the kept states before and after it, mixed by the time (the one
before alone until the one after comes from the worker), so the map no
longer jumps every 2 500 years; the game still does. A kept state the
screen let go was never asked for again; now it is.

**The flight** (the same day): of those a famine's land does not carry,
half die; the rest leave for the cells around its square that no famine
holds, as far as each has room (up to 1.5 times what it carries; they
thin out to it as the people do), and the rest of them die too. On
Morvane some 450 000 fled and 2.7 M died over the span: the cells around
are mostly full. Herders taking a famine's farmland were tried the same
day and never came: a farming cell that suits the herds has them already
from the domesticates' waves, and the fields cannot be given up while the
lifeways are times that only go forward — that waits for lifeways held
as a state.
