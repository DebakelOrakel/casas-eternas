---
title: The engine
anchor: generator.overview.engine
order: 0
---

The generator does not paint a world, it lets one grow. It simulates
four billion years of the planet's history: first a mantle without
plates, then plates that carry continents, while the weather wears the
land down. The climate, the rivers and what the land yields follow from
the relief that stands at the end.

## How a world grows {#grows}

1. **World.** You choose the planet: its shape, tilt, day length,
   greenhouse, temperature contrast and humidity, and the seed.
2. **Mantle.** The Archean, from 4.0 billion years ago. Crust forms
   above hot mantle and drifts with its flow. What lasts becomes a craton,
   until the land you asked for stands.
3. **Plate tectonics.** The Proterozoic. Plates move at a few centimetres
   a year and carry the continents. Where crust converges, mountains rise;
   where it parts, new sea floor forms. In every epoch rivers, glaciers
   and waves wear the land down, under a coarse climate of that time.
4. **Climate.** Today's climate on the finished relief, month by month:
   pressure, winds, ocean currents, temperature and rain. The climate
   classes, the biomes and the rivers follow from it.
5. **Ecology.** What the land yields, and how many people it can carry.
6. **Finishing.** The server computes the world again, much denser.

Each step reads only what the steps before it made. A step you accept
fixes its result; a change to an earlier step makes the later ones
outdated.

## Time {#time}

The history runs in epochs. In the Archean an epoch is 5 million years,
in plate tectonics 1 million years. You decide how long each era runs:
you start and stop it yourself.

## Simulated, not invented {#simulated}

Mountains, valleys, lakes, ice and deserts are not placed: they are what
the history left. That is why two worlds from two seeds differ in kind,
not only in detail, and why the planet's values change the world as a
whole. A colder planet has more ice, and its ice grinds its mountains
lower.

The same seed with the same values gives the same world, on every machine
and in every browser.

## The shapes {#shapes}

A world is flat (a torus without an edge) or a sphere with two poles.
Both run the same steps with the same sliders.

{{concept globe}}
