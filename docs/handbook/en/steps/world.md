---
title: World
anchor: generator.step.world
order: 0
---

The first step decides which world comes into being and on which planet.
It computes nothing yet: the map shows a sample world, and the climate on
it follows every slider at once. So you see what a planet does to the
weather before you spend time on its history.

## What this step does {#does}

- It gives the world a name and a seed.
- It sets the topology: how the edges of the map join.
- It sets up the planet: axial tilt, day length, greenhouse, temperature
  contrast and humidity.

Every later step uses these values. If you change one, everything after
it is outdated and must be computed again.

## Concepts {#concepts}

### Seed {#generator.world.seed}

The number that every random decision of the generator follows from. The
same seed with the same parameters gives the same world, on every machine
and in every browser. The die beside it picks a new one.

### Name {#generator.world.name}

Only a name: it shows in the title bar, in saves and in file names. It
changes nothing about the world.

### Topology {#generator.world.topology}

How the edges of the map join. Today the world is a flat torus: leave at
the right and you come back at the left; leave at the top and you come
back at the bottom. Plates, winds and ocean currents go round without an
edge. The horizontal middle of the map is the equator, and the top and
bottom edges together are the pole. The sphere is planned but not
available yet.

## Parameters {#parameters}

The defaults are Earth's. Reset puts all five back to them.

### Axial tilt {#generator.panel.planet.obliquity}

How far the axis leans, 10° to 40° (Earth: 23.5°). More tilt gives
stronger seasons and a flatter gradient from the equator to the poles.
The scale stops at 10° because below it the seasons disappear, and the
monsoon with them; above 40° the climate leaves the range the model is
tuned for.

### Day length {#generator.panel.planet.rotation}

How long one turn takes, 16 to 36 hours. A slow spin widens the trade-wind
belt to about 45° latitude, a fast one squeezes it to about 20°. The
deserts move with the belt.

### Greenhouse {#generator.panel.planet.greenhouse}

Warms or cools the whole world evenly, −20 °C to +20 °C.

### Contrast {#generator.panel.climate.contrast}

How sharply the temperature falls from the equator to the poles, 30 % to
170 %. Below 100 % the world is more even; above it the tropics get hotter
and the poles colder.

### Humidity {#generator.panel.climate.humidity}

Scales the rainfall of the whole world, 40 % to 200 %.

Contrast and humidity belong to the climate but stand here: the history in
the plate tectonics step wears the land down under exactly this weather.
So they must be fixed before it, like the planet itself.
