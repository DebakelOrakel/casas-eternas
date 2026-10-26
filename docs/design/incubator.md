---
id: DES-0032
title.en: The incubator
title.de: Der Inkubator
summary.en: The incubator shows a world's level 1 and grows on it, step by
  step, what lived there before the game — the wild plants and the wood,
  the animals, the people's spread from one origin and their settlement:
  the lifeways, the farming's and the herding's centres, the villages and
  the trade. All on one cell mesh of 10 km, in one worker, from simple
  rules with first-guess numbers. A trial: it shows what the end state
  could look like before the details are simulated.
summary.de: Der Inkubator zeigt Level 1 einer Welt und lässt darauf Schritt für
  Schritt wachsen, was vor dem Spiel dort lebte — die Wildpflanzen und das
  Holz, die Tiere, die Ausbreitung der Menschen von einem Ursprung und ihre
  Besiedlung: die Lebensweisen, die Zentren von Ackerbau und Viehzucht,
  die Dörfer und der Handel. Alles auf einem Zellnetz von 10 km, in einem
  Worker, aus einfachen Regeln mit ersten Schätzwerten. Ein Versuch: Er
  zeigt, wie der Endzustand aussehen könnte, bevor die Details simuliert
  werden.
area: mechanics
stage: building
createdAt: 2026-10-26
related: [DEC-0046, DEC-0047, DES-0031, DES-0023, DES-0033]
---

This note is the map of the incubator. The rules and their numbers are in
the code, each next to its constant, with the measurements that set it;
this note says what there is, how it fits together and why. The module
named in each section holds the detail.

## Where this starts

The generator makes a world's terrain, water, climate and ecology. The
game needs more: what lives on that world and where people are when the
game begins, some 5 000 years before the bronze age. The incubator grows
that on the world, as a separate screen (`client/src/screens/incubator/`).

It began on 2026-10-23 as a proof of concept on the save's world raster
(level 0) and moved to level 1 on 2026-10-25 ([DEC-0046](../decisions/level-waters.md)).
Since 2026-10-26 it stands on a cell mesh of its own
([DEC-0047](../decisions/incubator-cells.md)).

It is a trial. The rules are simple, the numbers first guesses, compared
with the earth where a comparison exists. The aim is a picture of the end
state, to talk about what is needed; the simulation of the details comes
after, maybe in detMath or in the engine.

## The screen

- **The ground.** Level 1 on the generator's globe (a sphere) or as a flat
  map (a torus), on a white page with the generator's look. Zoom only as
  far as level 1 holds detail. The chart worker (`chartWorker.ts`) paints
  the terrain and keeps the level-1 node under each texel (a map at half
  the chart's size), so everything per node can be read per texel.
- **The steps.** A step bar as the generator's: 1 People, and a Testing
  step aside (T) for the demos. The flora and the fauna were steps 1 and 2
  until 2026-10-26; they are grown on the way in now, with the habitat's
  cells, as rows of the load panel (`ui/loadPanel`), their layers in the
  panel in every step. The people's preview (the rules) follows in its
  step, under the progress pill (`ui/progressPill`).
- **The layer panel** (`layerPanel.ts`, 2026-10-26, after the design
  canvas's "Overlays in Gruppen"): a column of its own beside the left
  one, shown and hidden by a button in it. Every layer, in every step:
  the switches the group "Global", first; the picks groups of one choice
  with "none" (the settlement, the plants, the wood, the animals, the
  ecology, the climate), the five that paint the overlay one at a time;
  a group of switches for the geology (the volcanoes, the plumes, of the
  save's snapshot). The climate's washes (`map/climateLayers.ts`, written
  apart from the screen so that the generator can take them over): the
  Köppen classes and the biomes are level 1's, and so is the coast every
  wash keeps to; the temperature, the precipitation, its span, the monsoon
  and the water balance exist only on the save's climate chart (256 × 128
  on Morvane), a coastal texel on its sea taking the nearest land value.
  The refinement's (`map/refinedLayers.ts`, the year's mean where it has
  months): the sea's (upwelling, salt) on level 1's sea, free to combine;
  the weather's nine on its land. A group "Climate" of switches over land
  and sea: the temperature and the pressure with its isobars, washes under
  the other layers; the wind's streaks with its calm belts; the currents'
  arrows. The tooltip reads the save's temperature and rain at the
  pointer, and the value of the climate layer shown (coarse: level 1 has
  no climate of its own). The geology's
  (`map/geologyLayers.ts`), switches: the volcanoes, the plumes and the
  continents' names of the save's snapshot; the cratons' age, level 1's
  per node; the mantle's buoyancy, the save's field mesh (`World.meshField`),
  under every other layer.
  A group folds; the
  head counts what is on, "all off", "defaults". The incubator's alone;
  the legend stays its own box.
- **The overlays.** Each step's layers are entries of one table (`TRIALS`
  in `IncubatorScreen.ts`): the steps it shows in, whether it is on, how it
  paints, its legend, its tooltip rows. They paint into one RGBA raster at
  half the chart's size (`incubatorOverlay.ts`), laid over the map by a
  material plugin (`map/overlayMaterialPlugin.ts`); an animation frame
  repaints that raster alone.
- **The marks.** Villages, centres, the origin and the sources are symbols
  in the views' surface (`incubatorSymbols.ts`, `view.symbols`), sized in
  km on the world, sharp at any zoom. So are the lines — the spread's
  arrows, the trade, the crossings: pieces of a line that join, and a head
  (`lineSymbols`); painted into the overlay until 2026-10-26.
- **The legend** in a separate box that folds (`ui/legend`), as the
  generator's.
- **The tooltip** on hover: the height, the Köppen class, the biome, the
  carrying capacity, the arable land, and each active layer's own rows.
- **The time.** Counted up from the people's departure, year 0 to
  65 000, in the chronicle on the right
  ([DES-0031](./incubator-chronicle.md)): the playback at 1× / 4× / 16×
  (1× = 100 years a second), the counts, the events, a click to travel to
  one.

## The cells

One mesh for everything: the generator's field mesh at 10 km, unrelaxed
(`cells.ts`). On Morvane (a sphere, 20 000 km round) 1.47 M cells, some
95 km² each, six neighbours (the sphere's twelve, five). Each cell takes
level 1's nodes under it through the chart's node map: land where most of
its texels are, its biome and Köppen class from its centre, its height and
the ecology's fields as the mean over its land, its sea depth from its
shallowest sea texel. Its rivers are level 1's river lines, the ephemeral
ones left out; the lakes and the coast are near or not. The landmasses
are the connected land. The same map of texels to cells draws the overlay:
a texel shows the cell that owns it.

The habitat (`habitat.ts`) is that per-cell view of the world, shared by
every step. Why a mesh and why these choices:
[DEC-0047](../decisions/incubator-cells.md).

## One worker

`incubatorWorker.ts` holds the habitat and what each step made, and
answers the screen's requests in turn: the cells, then the flora, the
fauna, the people, the settlement. A later step reads the earlier ones in
the worker (the people's boats from the trees, the settlement's fields and
herds from the plants and the animals). Measured on Morvane: the cells 8 s,
the flora 1.8 s, the fauna 1.6 s, the people 0.3 s, the settlement 0.3 s.

A module the screen imports must not set `self.onmessage`: in the window,
that handler is the window's. What the screen and the worker share lives in
modules of its own (`peopleShared.ts`, `settleShared.ts`).

## The flora

What people eat and use of the wild plants (`plants.ts`, 39 archetypes,
named after the real species they stand for) and the wood they cut
(`trees.ts`, 12). Each has a **niche** over the habitat (`niche.ts`): a
weight for each Köppen class, times its responses to the height, the
slope, the cover (open land or forest), the water (a river or a lake
near, a big river's floodplain), the coast and salt. And a **range**: an
origin on a landmass, with a chance by the landmass's area, and a spread
by the cheapest way, through land it does not suit 30 times dearer, never
over the sea. A suitable cell outside the range is an empty niche, drawn
grey.

The plants are shown by use: starch, fat and protein, fruit, fibre. The
trees by the use of their wood: build, fuel, tool, boat, resin. A group
draws its members in diagonal stripes, each in its colour, at most three a
cell. The aim: every cell where gathering can feed people has starch,
fat or protein and fruit in reach; the tundra and the desert keep their
gaps.

## The fauna

The animals people hunt, tame, fish, wear or fear (`animals.ts`, 23
archetypes), with the same niche and range as the plants (`fauna.ts`).
The salmon swims up the rivers from every suitable mouth; the shore's
animals (shellfish, seal) come along every coast that suits them. How many:
the herbivores share the ecology's game, each by its niche among those in
range; a predator follows the herbivores in its range; the animals of the
water are their niche. Shown by use: hunt, tame, water, fur, danger.

Once people are shown, the animals change with the time shown: the hunt thins the
hunted ones by the people's density, the herds and the fields push the
wild herbivores and the predators back (by the lifeways' shares), and the
big game dies out on a landmass the people came to new, by its chance,
half again on an island. Africa's case, the people's own landmass, keeps
its big game. It goes cell by cell, 1 000 to 2 000 years behind the
people's front; once less than a tenth of its cells are left, the rest go
too. On Morvane 16 of 29 such cases end in the span; the others keep a
larger part where people never came.

## The people

**The spread** (`people.ts`). From one origin (a click, or the land that
feeds best in a tropical class), the cheapest ways in years over the
cells. Over land the front moves 0.05 to 0.5 km a year by the carrying
capacity, slower up a slope, twice as fast along a river or a coast; ice
is not crossed. The shelf down to 120 m is dry land until year 60 000. Open
water is crossed as far as the time's reach, which grows from 30 to 450 km
over the span; beyond 60 km only with boats, which people carry on once
they passed boat wood. On Morvane it reaches 83 % of the ice-free land.
Shown as the age of the spread, with its routes as a tree of smoothed,
continuous lines, as wide as the square root of the people living beyond
them at the time shown, heads at the tips and at the front while it
moves, as the generator's migration arrows (`peopleArrows.ts`), and the
origin marked. The crossings to a landmass of
100 000 km² or more are the routes' own lines, blue over the sea (the open
water, the shelf between its stretches; not the dry shelf walked before
it), with the year they landed as text. The boats are dugouts, rafts and
bark canoes: good for a daring crossing, not for trade.

**The settlement** (`settle.ts`, `settleShared.ts`). Everything is a time
per cell, so the state at any time is a function and the animation needs
no snapshots:

- **The farming** begins at up to five centres 1 500 km apart, where
  people lived 10 000 years, two domesticable starch plants or more grow
  and the arable land is good: the first 11 000 years before the game,
  the next 1 000 to 3 000 years after. It spreads 1 km a year from them,
  five times slower through land it cannot farm, never over the sea.
- **The herding** begins at up to three centres of its own (two tamable
  herd animals or more, good pasture; the first 8 000 years before the
  game), and at the farming's centres 1 000 years after the fields. It
  spreads 2 km a year: the earth's nomads took the steppes late and fast.
- **The domesticates.** A farming centre tames the domesticable starch
  plants that grow wild there, and 1 000 years later its herd animals; a
  herding centre its herd animals. Each spreads in a wave of its own
  where it suits the land (its niche, beyond its wild range), as wheat
  went to Europe; where two meet, a cell holds both, as the earth's farmers
  sowed several crops. Not over the sea: the crops stay on their
  continent, so that not every crop ends up everywhere. Before, a wave
  needed a wild one in every cell. On Morvane the fields kept their extent
  (15 362 → 15 179 cells), the herds halved (10 258 → 5 740): the herds
  are only the tamed ones now. 14 domestications. Shown hatched in the plants' and the
  animals' views, the tooltip naming what is cultivated or kept. Almost
  all of it lies in the wild range anyway (outside: 29 crop cells, 84 herd
  cells): the wild plants and animals already cover their niche on a
  landmass.
- **The clearing.** People clear the forest only as far as they need it: a
  hectare a farmer for the fields, the fallow and the village, 0.3 a
  herder for the grazing, at most half a cell. The trees there show
  fainter, not gone. On Morvane at the end 9 % of a cell in the median,
  23.5 % at most.
- **The lifeways' shares.** A cell holds several at once: the foragers
  always a little, the fishers, herders and farmers by the fish, pasture
  and arable land, each grown with the time since it came. The density is
  each share of its own lifeway's density (foragers 0.1, fishers 1,
  herders 1.5, farmers 15 people a km², scaled by the carrying capacity).
  Shown in stripes as wide as the shares; the tooltip lists them.
- **The villages**: where farmers or fishers are the most, the densest
  cell of its neighbourhood.
- **The trade**: each village linked to its three nearest within 150 km;
  from the sources of tool stone, salt and copper the goods go down the
  links, less each step.

On Morvane at the end: two farming and two herding centres, 17.7 M people
(13 M of them farmers), 640 villages; one cell in twelve that people
reached holds two lifeways or more.

The people's layers, in order: the spread, the lifeways or the density
(one at a time), the trade, the villages, the sources, the centres with
the origin (on by default).

## The testing step

Demos that may come back elsewhere: the catchments of level 1's rivers,
cut by a threshold.

## Text

The plants, trees, animals, lifeways and the layers have catalog keys
(`plant.*`, `wood.*`, `animal.*`, `incubator.*`). Demos that are tried and
removed again do not.

## Next

- **The chronicle** ([DES-0031](./incubator-chronicle.md)): the time, the
  events, travel to them.
- **Boats**: the crossings made visible, harbours where boat wood grows by
  the coast.
- **The trade again**: the foragers' camps as nodes too.
- **Names** for places; **epochs** for the time.
- **The port**: once the rules settle, to detMath or the engine.

## One history, and later a simulation

The flora, the fauna and the people compute in turn but are not three simulations: the flora and
the fauna are maps, and the people's part is a time per cell (when people,
the fields, the herds came; when an animal went), from which the state at
any time is a function. That is fast (some 12 s on Morvane for all of it)
and lets the time go back and forth freely.

**Next form (not built): one history.** One pass in the worker that makes
every time in the order of its causes — the flora, the fauna, the spread,
the farming and the herding, the animals' loss — and the steps only show
it. Still a time per cell, still a function of the time.

**Later: a simulation in time steps** ([DES-0033](./incubator-simulation.md)), for feedback: the game thinned, the
land feeds fewer, people move on; droughts, hunger, people leaving. It
costs what the history does not: the state is no longer a function of the
time, so going back needs snapshots or a replay; minutes instead of
seconds; more memory; and it must be deterministic for the engine. Worth it
when the crises are wanted, with the port to detMath or the engine.

## Status

Building, 2026-10-26. Everything above is built as a trial; nothing is
calibrated.
