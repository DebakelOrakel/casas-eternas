---
title: Mantle
anchor: generator.step.genesis
order: 1
---

The Archean, 4.0 to 2.5 billion years ago. There are no plates and no
mountains yet, only a hot mantle under an ocean that is flat almost
everywhere. The first crust forms above rising mantle, the flow pushes it
around, and what survives long enough becomes cratons: the old cores of
the continents to come.

## What this step does {#does}

- It forms crust above hot mantle under the ocean.
- It moves the crust with the flow of the mantle, without plates.
- It destroys young crust again above sinking mantle. Crust that lasts
  through that time stabilises into a craton.
- It lets cratons collide and merge until a supercontinent forms.

You start and stop the run yourself. When you stop decides how much land
the world has and how many continents.

## Concepts {#concepts}

### Mantle convection {#convection}

The mantle turns over slowly: hot rock rises, cooler rock sinks. The crust
rides on this flow. Continents hold the heat in below them; so over time
an upwelling grows under them that later tears them apart again.

### Young crust {#young-crust}

New crust forms only above the ocean, where the mantle is hot and stays
hot for a while. While it is young it can sink back into the mantle: if
it lies above a downwelling, it disappears. That gives a balance instead
of more and more land.

### Craton {#craton}

Crust that has survived for about 125 million years is stable: it no
longer sinks and stays for good. Cratons are rigid. They move as a whole,
collide and grow into large landmasses.

### Stopping and moving on {#stop}

Stop is a pause: you can resume the run. The result becomes final only
when you start plate tectonics. Then the plates form from the mantle's
convection cells, so their number follows from the world. Restart
discards the young world and begins the Archean again.

## Figures {#stats}

### Stabilised {#generator.panel.genesis.stat.stabilised}

How much of the crust, by area, has already become craton. It tells how
far the Archean has come:

- below 20 %: crust is still forming. Let the run go on.
- 20 % to 70 %: the cratons drift on their own. A stop now gives a world
  of many islands and small continents.
- above 70 %: the continents merge. A stop now gives a supercontinent.

Plate tectonics opens from 50 %.

### Cratons {#generator.panel.genesis.stat.cratons}

How many separate landmasses there are. The number rises while crust
forms and falls when cratons merge.

### Crust {#generator.panel.genesis.stat.crust}

How much of the world's surface is covered by crust, that is, land.

### Age {#generator.panel.genesis.stat.age}

How long the Archean has run. One epoch is 5 million years.

## Parameters {#parameters}

### Mantle vigour {#generator.panel.genesis.mantleVigour}

How strongly the mantle turns over, 1 to 10 (default 4). More activity
moves the crust faster and tears it apart more often.

### Water {#generator.panel.genesis.water}

How much water the world has, 0 to 100 (default 50). It moves sea level
up or down by as much as 600 m. The crust stays the same; with more water
more of it lies under the sea, with less water more of it above.
