---
id: DES-0031
title.en: The incubator
title.de: Der Inkubator
summary.en: The incubator shows a world's level 1 and grows on it what lived
  there before the game: the wild plants and the wood, the animals, and the
  people's prehistory in steps — the old stone age as a graph, the new
  stone age as a simulation that ends at the first city. All on one cell
  mesh of 10 km, computed by the crate casas-incubator; one chronicle and
  one overlay list over all steps.
summary.de: Der Inkubator zeigt Level 1 einer Welt und lässt darauf wachsen,
  was vor dem Spiel dort lebte: die Wildpflanzen und das Holz, die Tiere
  und die Vorgeschichte der Menschen in Schritten — die Altsteinzeit als
  Graph, die Jungsteinzeit als Simulation, die bei der ersten Stadt endet.
  Alles auf einem Zellnetz von 10 km, gerechnet vom Crate casas-incubator;
  eine Chronik und eine Overlay-Liste über alle Schritte.
area: mechanics
stage: building
createdAt: 2026-10-26
updatedAt: 2026-10-28
related: [DEC-0046, DEC-0047, DEC-0048, DES-0023]
---

This note is the map of the incubator's screen. The people's prehistory,
its steps and why, is [DES-0032](./prehistory-in-three-steps.md). The
rules and their numbers are in the crate (`engine/crates/casas-incubator`),
each next to its constant, with the measurements that set it.

## Where this starts

The generator makes a world's terrain, water, climate and ecology. The
game needs more: what lives on that world and where people are when the
game begins, shortly before the bronze age. The incubator grows that on
the world, as a screen of its own (`client/src/screens/incubator/`).

It began on 2026-10-23 on the save's world raster (level 0), moved to
level 1 on 2026-10-25 ([DEC-0046](../decisions/level-waters.md)) and to a
cell mesh of its own on 2026-10-26
([DEC-0047](../decisions/incubator-cells.md)). Since 2026-10-27 all of it
is computed by the crate `casas-incubator`
([DEC-0048](../decisions/incubator-history-engine.md)).

## The screen

- **The ground.** Level 1 on the generator's globe (a sphere) or as a flat
  map (a torus). The chart worker (`chartWorker.ts`) paints the terrain and
  keeps the level-1 node under each texel, so everything per node can be
  read per texel.
- **The steps.** A step bar as the generator's: 1 the old stone age, 2 the
  new stone age. A step gives the controls — a click sets step 1's origin,
  the history's actions are step 2's — not what the map shows. The flora and the fauna are grown on the
  way in, with the cells, as rows of the load panel (`ui/loadPanel`).
- **The overlay list** (`layerPanel.ts`): a column of its own, every
  overlay of the world in groups — the switches ("Global", the geology,
  the climate) and the picks of one choice with "none" (the settlement, the
  plants, the wood, the animals, the ecology, the climate over land and
  sea, the weather, the resources). An overlay is off only where its data
  is not made yet, never because of the step (2026-10-28). What it shows
  follows the time: the history's data from the history's start on, step
  1's before it.
- **The overlays.** Entries of one table (`TRIALS` in `IncubatorScreen.ts`):
  whether it is on, how it paints, its legend, its tooltip rows. They paint
  into one raster at half the chart's size (`incubatorOverlay.ts`), laid
  over the map by a material plugin (`map/overlayMaterialPlugin.ts`).
- **The marks.** Villages, camps, centres, the origin and the sources are
  symbols on the world (`incubatorSymbols.ts`), sized in km, sharp at any
  zoom; so are the lines — the routes, the crossings, the trade.
- **The legend** in a box of its own that folds (`ui/legend`), and **the
  tooltip** on hover: the height, the Köppen class, the biome, the carrying
  capacity, the arable land, and each overlay's rows.

## The chronicle

The right column (`chroniclePanel.ts`), after the design canvas
(`Inkubator.dc.html`). One chronicle, each step's built on the one
before: a step shows it up to its own end, with its events and those of
the steps before it.

- **The time**, counted up from the people's departure (year 0): in step 1
  to step 1's end; in step 2 on to the history's end, its first city, or
  to step 1's end while there is no history.
- **The playback**: one event back, play or stop, one event forward, the
  speed 1× / 4× / 16× (1× = 100 years a second), a slider under the year.
- **The counts** at the time shown: people (a wider column), villages,
  camps, centres.
- **The axis**: the epochs as bands, the people over the time on a
  logarithmic scale (step 1's from its density where people came by then,
  then step 2's own count), the cold of the climate history, a handle at
  the time shown.
- **The events**, read from the log (`historyLogShared.ts`): step 1's in
  step 1; after it the history's, which holds step 1's before its own: the
  departure, the first crossing to each landmass of 100 000 km² or more,
  the farming and herding centres, each domesticate's first taming, the
  extinctions on large landmasses, the first village, the first trade
  route, the large famines (30 % of their square's people and 10 000 or
  more), the people over 100 000, 1 M and 10 M, the copper hammered and
  smelted, the first city. The event at the time shown is "now", the ones
  after it "later"; a click goes to its time and turns or pans the view to
  its cell (`WorldView.lookAt`).
- **The epochs**: the Palaeolithic, the Neolithic from the first farming
  centre, the Copper Age from the first smelting.

A landmass is named by its rank by area, 1 the largest. A place has no
name of its own yet ([DES-0033](./naming-languages.md)).

## The cells

One mesh for everything: the generator's field mesh at 10 km, unrelaxed.
On Morvane (a sphere, 20 000 km round) 1.47 M cells, some 95 km² each, six
neighbours (the sphere's twelve, five). Each cell takes level 1's nodes
under it through the chart's node map: land where most of its texels are,
its biome and Köppen class from its centre, its height and the ecology's
fields as the mean over its land, its sea depth from its shallowest sea
texel. Its rivers are level 1's river lines, the ephemeral ones left out;
the lakes and the coast are near or not. The landmasses are the connected
land. A texel shows the cell that owns it. Why a mesh:
[DEC-0047](../decisions/incubator-cells.md).

## The worker

`incubatorWorker.ts` holds the crate's WASM build and answers the screen's
requests in turn: the cells, the flora, the fauna, step 1, the history,
its kept states, its settlement. The modules the screen shares with it
live apart (`cellsShared.ts`, `peopleShared.ts`, `settleShared.ts`,
`historyLogShared.ts`, `historyPack.ts`): a module the screen imports must
not set `self.onmessage`.

## The flora

What people eat and use of the wild plants (39 archetypes, named after the
real species they stand for) and the wood they cut (12). Each has a
**niche** over the cells: a weight for each Köppen class, times its
responses to the height, the slope, the cover, the water (a river or a
lake near, a big river's floodplain), the coast and salt. And a **range**:
an origin on a landmass, by a chance that grows with the landmass's area,
and a spread by the cheapest way, through land it does not suit 30 times
dearer, never over the sea. A suitable cell outside the range is an empty
niche, drawn grey. Shown by use: the plants by starch, fat and protein,
fruit, fibre; the trees by the use of their wood (build, fuel, tool, boat,
resin); a group draws its members in stripes, at most three a cell.

## The fauna

The animals people hunt, tame, fish, wear or fear (23 archetypes), with
the same niche and range as the plants. The salmon swims up the rivers
from every suitable mouth; the shore's animals come along every coast that
suits them. How many: the herbivores share the ecology's game, each by its
niche among those in range; a predator follows the herbivores in its
range; the animals of the water are their niche. Shown by use: hunt, tame,
water, fur, danger. In a history, the game's shares at the time shown are
the history's kept states: the hunt thins them, a species gone from a
landmass is shown gone.

## The people

Step 1, the old stone age, and step 2, the history:
[DES-0032](./prehistory-in-three-steps.md). On the screen:

- **Step 1** is computed when the origin is set (a click in its step, or
  the land that feeds best in a tropical class) and not kept: it is
  derived from the origin in well under a second. Its overlays: the spread by age,
  the groups, the density; its routes and crossings, which are the routes
  in every step.
- **Step 2, the history**, runs in the worker on "Start history" (on
  Morvane some 3 s) and is played back: kept states every 2 500 years from
  its start and at its end, the people's count every 500 years, the log.
  The map mixes the kept states before and after the time shown. Its
  overlays: the spread, the lifeways or the density, the villages, the
  camps, the hamlets, the trade and its sources, the centres.
- **H1**: saved, a job runs the history natively on the server and keeps
  it as the artifact H1 ([DEC-0048](../decisions/incubator-history-engine.md));
  a world opens with the history saved last.

## Text

The plants, trees, animals, lifeways and the overlays have catalog keys
(`plant.*`, `wood.*`, `animal.*`, `incubator.*`). Demos that are tried and
removed again do not.

## Status

Building, 2026-10-28. Nothing is calibrated.
