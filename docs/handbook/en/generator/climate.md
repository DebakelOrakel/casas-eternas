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

### Air pressure and wind {#pressure-wind}

Over hot land air rises and the pressure falls; over cold land in winter
heavy air gathers into a high. Over the subtropical oceans lie steady
highs. The wind flows from high to low and is turned aside by the planet's
spin. Mountains slow it and steer it.

### Twelve months {#months}

Land warms fast and cools fast, the sea slowly. So the temperature swings
much more in the interior of the continents than on the coasts. The
tropical rain belt moves with the sun; where it stays for only part of
the year, there are rainy and dry seasons.

### Ocean currents {#currents}

The wind drives the sea into large gyres. On the western side of the
oceans they flow narrow and fast and carry warm water toward the poles.
Where the wind pushes the water away from the coast, cold, rich water
rises from the deep: cool, dry coasts with rich fishing grounds.

### Climate classes {#koppen}

The Köppen–Geiger scheme: tropical, dry, temperate, cold and polar,
refined by when it rains and how hot the summer gets. It rests on the
twelve months. Two places with the same rain in a year can have different
classes if the rain falls in different seasons. The biomes follow from
the class.

### Weather phenomena {#weather}

Fog, föhn, cyclones, tornadoes, blizzards, dust and thunderstorms. They
are statistics, not a forecast: the map shows where and how often they
occur. So does how much the rain varies from year to year: drought years
and flood years.

### Rivers and lakes {#rivers}

What is left of the rain after evaporation runs off. The rivers follow
the relief the history carved. Where water gathers in a basin, a lake
forms. If the basin has no outlet and the climate is dry, it becomes a
salt lake.

## Controls {#controls}

### Month {#generator.climate.month}

Which month the climate overlays show, or the annual mean. Available once
the climate is computed.

### Play the months {#generator.climate.play}

Runs through the months again and again. Stopping shows the year again.
