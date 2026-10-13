---
title: World
anchor: generator.step.world
order: 0
---

The first step decides which world comes into being and on which planet.
It computes nothing yet: the map shows a sample world (on a sphere, a
sample globe), and the climate on it follows every slider at once. So you
see what a planet does to the weather before you spend time on its
history.

## What this step does {#does}

- It gives the world a name and a seed.
- It shows the world's shape, flat or sphere.
- It sets up the planet: axial tilt, day length, greenhouse, temperature
  contrast and humidity.

Every later step uses these values. Once the world is created, they are
locked: a change would make everything after it outdated. To change them,
use Reset first; Create world then makes the world again with the new
values and discards what was computed.

## Concepts {#concepts}

### Seed {#generator.world.seed}

The number that every random decision of the generator follows from. The
same seed with the same parameters gives the same world, on every machine
and in every browser. The die beside it picks a new one.

### Name {#generator.world.name}

Only a name: it shows in the title bar, in saves and in file names. It
changes nothing about the world.

### Topology {#generator.world.topology}

The world's shape: how the edges of the map join. You pick it when you
create the world, in the menu of "Create new world"; after that it is
fixed, and step 0 only shows it. There are two shapes.

Flat is a flat torus: leave at the right and you come back at the left;
leave at the top and you come back at the bottom. Plates, winds and ocean
currents go round without an edge. The horizontal middle of the map is
the equator, and the top and bottom edges together are the pole.

Sphere is a globe with two poles; it wraps only from east to west. Its
axis follows the axial tilt. In this step you see the globe side on, so
the tilt shows whole; the other steps look down on it from above the
north pole. A sphere world runs the steps up to Ecology; Finishing and
Migration are locked for it.

## Parameters {#parameters}

The defaults are Earth's.

### Axial tilt {#generator.panel.planet.obliquity}

How far the axis leans, 10° to 40° (Earth: 23.5°). More tilt gives
stronger seasons and a flatter gradient from the equator to the poles;
the world's mean temperature stays. Hotter summers melt more ice, so a
small tilt grows ice caps and a large one shrinks them.
The scale stops at 10° because below it the seasons disappear, and the
monsoon with them; above 40° the climate leaves the range the model is
tuned for. On a sphere the globe shows the equator and the two polar
circles as bands; the polar circles move with the tilt.

### Day length {#generator.panel.planet.rotation}

How long one turn takes, 16 to 36 hours. A slow spin widens the trade-wind
belt to about 45° latitude, a fast one squeezes it to about 20°. The
deserts move with the belt. A turning globe turns faster or slower with
the day length.

### Greenhouse {#generator.panel.planet.greenhouse}

Warms or cools the whole world evenly, −20 °C to +20 °C.

### Contrast {#generator.panel.climate.contrast}

How sharply the temperature falls from the equator to the poles, 30 % to
170 %. Below 100 % the world is more even; above it the tropics get hotter
and the poles colder. The world's mean temperature stays; the greenhouse
moves that.

### Humidity {#generator.panel.climate.humidity}

Scales the rainfall of the whole world, 40 % to 200 %.

Contrast and humidity belong to the climate but stand here: the history in
the plate tectonics step wears the land down under exactly this weather.
So they must be fixed before it, like the planet itself.

## Controls {#controls}

### Create world {#generator.world.create}

Makes the world from the seed and the values of this step, and opens the
Mantle step. If a world exists already, it asks first: everything
computed for it is discarded.

### Reset {#generator.action.resetPlanet}

Puts all five sliders back to their defaults. Over a created world it
also unlocks them, so you can change them.

### Back to this world's values {#generator.action.revertPlanet}

Shows where Reset was, once the sliders are unlocked. It puts step 0
back to the values the world was made with and locks it again.
