---
title: Climate
anchor: generator.step.climate
order: 3
---

Today's climate on the finished world. The history had only a coarse
climate in each epoch, just enough for erosion. This step computes once,
and in more detail: air pressure, winds and ocean currents, temperature
and rain for each of the twelve months. The climate classes, the biomes
and the rivers follow from them.

## What this step does {#does}

- It computes air pressure and wind, which follow land, sea and mountains.
- It computes the ocean currents from that wind, with upwelling and
  salinity.
- It computes temperature and precipitation for twelve months and sorts
  the land into climate classes.
- It lets rivers, lakes and biomes form again on this climate.

The step has no controls of its own; it computes by itself as soon as you
enter it and takes a few seconds. How warm or wet the world is, you set
in the World step.

## Concepts {#concepts}

{{concept pressure-and-wind}}

{{concept seasons}}

{{concept ocean-currents}}

{{concept climate-classes}}

{{concept weather-phenomena}}

{{concept rivers-and-lakes}}

## Controls {#controls}

### Month {#generator.climate.month}

Which month the climate overlays show, or the annual mean. Available once
the climate is computed.

### Play the months {#generator.climate.play}

Runs through the months again and again. Stopping shows the year again.
