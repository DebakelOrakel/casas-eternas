---
summary: The climate step refines today's climate on the final geography. A pressure field and a terrain-aware wind, a 12-month energy balance with moisture transport, better ocean currents, Köppen classes that feed the biomes, and fields for phenomena and for the reliability of rain. Budget 20–40 s; the epochs keep the cheap model, except two current-solver terms.
date: 2026-09-28
area: generator
stage: decided
status: discussed and agreed 2026-09-28; nothing built. The order at the end is the build order. Constants are not measured. The decided forks are at the end; none is open.
---

# Climate refinement

## The split

The tectonic history carries the paleoclimate. It runs the cheap model
once per epoch (`generator/climate/`, 256×128, sub-second), because
erosion, ice and cover need a climate for each epoch and each epoch must
stay cheap.

The climate step runs once, on the final geography. It computes today's
climate with more physics and feeds biomes and ecology. It does not feed
erosion. It has no controls of its own: it computes and shows. If new
controls come, they are planet properties and go to step 0.

Budget: 20–40 s in the worker pool. A run of minutes is permitted only as
an encapsulated job at the end (for example a higher resolution, see D).

## What the cheap model does not have

- The wind is a pure function of latitude. Land and sea do not change it.
- The year has two seasons, which the monsoon index compares. There are no
  monthly values.
- The current solver is `∇²ψ = curl` with `ψ = 0` on all land. The gyres
  are symmetric, and no net flow passes between two landmasses.
- The biomes are Whittaker: annual mean temperature and annual
  precipitation. A dry summer and a wet summer with the same total give the
  same biome.

## A. Pressure and wind

- A pressure field from the land–sea temperature contrast for each month:
  thermal lows over hot land, cold highs over winter land, the subtropical
  highs over the oceans.
- The wind comes from the pressure gradient, with Coriolis and surface
  friction. Mountains block and channel it.
- The result: highs and lows as real vortices in the wind layer, jets, gap
  winds and lee effects (föhn).

## B. Twelve months

- An energy balance model: small heat capacity on land, large heat capacity
  on sea. Heat diffuses, and the ocean currents transport it. Sea ice
  follows from the balance and changes the albedo. The model runs until the
  annual cycle repeats.
- Moisture: evaporation, transport with the wind from A, precipitation,
  each month. This replaces the two-season monsoon approximation.
- Output: monthly temperature and precipitation.

## Köppen

The monthly values give Köppen–Geiger classes (Af, BWh, Csa, Dfb, ET and
the rest). **The biomes may change in this step** (agreed 2026-09-28):
Köppen feeds the biome classification, and a world can look different
after the step than before it. Köppen is also a layer of its own.

## Ocean currents

1. **Western intensification.** Add the β term (`β·∂ψ/∂x`, Stommel/Munk).
   Narrow, fast, warm currents on the western side of a basin (Gulf Stream,
   Kuroshio). Broad, slow, cold flow on the eastern side.
2. **Wind from A.** The wind-stress curl gets its x term, and each basin
   gets its own gyres.
3. **Island rule.** One ψ constant for each landmass instead of `ψ = 0` for
   all land. Net flow between continents becomes possible. A free zonal
   band around the torus gives a circumpolar current that isolates a pole
   thermally.
4. **Upwelling.** Ekman transport at eastern boundaries and at the equator.
   The result is cold coasts, fog deserts and a marine productivity field
   (fish) for ecology.
5. **Thermohaline circulation.** Later, as an estimate for each basin from
   evaporation minus precipitation and from the basin's opening to the
   pole. No salinity or depth model.

**Items 1 and 3 also go into the epochs** (agreed 2026-09-28): they are in
the shared solver and cost little. They change the golden hashes. Measure
the cost per epoch before and after; the solver was a bottleneck once
(0.6 s per epoch, 2026-09-26).

## C. Phenomena

These are derived from A, B and the currents. They are fields, not
simulations. Build order:

1. **Fog coasts** (cold upwelling plus onshore wind) and **föhn** (lee
   warming and drying). They change Köppen and the biomes.
2. Tropical cyclone tracks: sea above 26.5 °C, 5–20° latitude, low shear;
   the tracks follow the wind.
3. Tornado alleys: warm moist air from the sea meets dry lee air over a
   plain, under a jet.
4. Lake-effect snow, blizzard zones, dust belts, thunderstorm frequency.

## Reliability

Köppen and the biomes are means over decades. Internal variability does not
change them much, but the game needs it: drought years, flood years, failed
harvests. An ENSO-like mode is derived, not simulated: a wide equatorial
ocean with a cold upwelling tongue on its eastern side gets a see-saw, and
the coasts on both sides get a high year-to-year variance of rain. Output:
a field of rain reliability.

Milanković cycles are out of scope here. They belong to the tectonic
history, where one epoch (20 kyr) is about one precession period, so the
cycles alias. That is a separate topic.

## Overview

| Phenomenon | Source | Climate step | Final refinement | Epochs | Feeds |
|---|---|---|---|---|---|
| Pressure cells (highs, lows) | land–sea contrast (A) | yes | – | – | wind, currents |
| Terrain wind, jets | pressure + relief (A) | yes | yes: valleys, passes | – | rain, föhn |
| 12 months of temperature and rain | energy balance (B) | yes | yes: lapse rate only | – | Köppen, seasons |
| Sea ice | energy balance (B) | yes | – | – | albedo, coasts |
| Köppen and biomes | monthly values | yes, 2048 | yes, reclassified | cheap Whittaker | game, ecology |
| Western boundary currents | β term | yes | – | yes | coastal climate |
| Passages, circumpolar current | island rule | yes | – | yes | polar ice |
| Upwelling, marine productivity | Ekman | yes | – | – | fog, resources |
| Thermohaline circulation | estimate per basin | later | – | – | high-latitude heat |
| Fog coasts | upwelling + onshore wind | yes | yes: coastline | – | Köppen (BWn), biomes |
| Föhn | lee side (A) | yes | yes | – | Köppen, biomes |
| Valley and katabatic winds | relief | – | yes | – | local climate |
| Local rain shadows | relief | coarse | yes | – | biomes |
| Valley fog | relief + cold | – | yes | – | biomes, game |
| Lake-effect snow | lakes + cold air | yes | yes: shoreline | – | winter, game |
| Tropical cyclone tracks | sea > 26.5 °C, wind | yes | – | – | game (disasters) |
| Tornado alleys | moist/dry air + jet | yes | – | – | game |
| Blizzard zones | cold air + wind | yes | – | – | game |
| Dust belts | desert + wind | yes | – | – | game, soils |
| Thunderstorm frequency | heat + moisture | yes | – | – | game (fires) |
| Rain reliability | monthly values | yes | – | – | game (drought years) |
| ENSO pattern | equatorial basin + upwelling | yes | – | – | game (see-saw) |
| Heavy rain as erosivity | cyclones, monsoon | – | – | later | erosion |

Milanković cycles are not in this table (see above).

## Save

The game does not simulate the climate. It reads fields.

- The save holds the 12 monthly fields of temperature and precipitation
  (256×128, about 0.4–0.8 MB quantised). The game reads the season from
  them, and the final refinement classifies from them.
- The save holds the reliability field and the ENSO pattern (sign and
  strength of the rain anomaly in one phase per cell, plus one period for
  the world). The game rolls a phase each year and applies phase × pattern
  × strength.
- The save holds the phenomena as fields.
- Köppen and biomes at 2048 stay in the save, as today.
- This is a new save format version.

## Final refinement

A later, possibly long step at the end, together with the bakery step
(the mesh-level bakes). It runs where the fine terrain exists:

- It reclassifies Köppen and biomes on the fine terrain, per mesh node,
  and stores them with the terrain as an artifact.
  `map/mapPresentation.reclassifyBiomes` then goes away: loading reads
  artifacts and classifies nothing.
- It refines only the phenomena that depend on the terrain (the "final
  refinement" column above). Large-scale phenomena stay on the 256 grid.
- The bake pipeline version goes up; old bake artifacts become invalid.

## Erosivity (later)

The epochs need means over 20 kyr, so phenomena matter there only where
they change erosion. The one candidate is heavy rain: cyclone coasts and
monsoons erode more than the same annual total as drizzle. A factor in the
erosion forcing would be cheap, but it is a calibration topic of its own.

## D. Resolution

Stay on 256×128 first. Go to 512×256 when the rain shadows are too coarse.
Full resolution is a candidate for an encapsulated job at the end.

## Possible controls (step 0)

- Eccentricity and perihelion: unequal seasons between the hemispheres.
- Ocean heat transport strength.

Nothing more. A "storm activity" control would be a factor without
physics.

## Build order

1. Currents 1 + 3 in the shared solver (epochs and step), golden reset.
2. A: pressure and wind.
3. Currents 2 + 4.
4. B: twelve months, sea ice.
5. Köppen, feeding the biomes.
6. C1: fog coasts, föhn.
7. Reliability field.
8. C2–C4.
9. Currents 5, controls, D: when needed.
10. Final refinement: with the bakery step.

## Forks decided 2026-09-28

1. **Köppen replaces Whittaker.** The biome enum changes; ecology and the
   save follow. The new enum is proposed with step 5.
2. **Hydrology reruns on the refined climate.** Water balance, terminal
   lakes and the riparian bonus read the refined precipitation. A river
   that loses its rain becomes ephemeral; the regime classification
   (wadis) already handles that case.
3. **The last epoch's cheap climate is not kept**, unless the refinement
   needs it. Current plan: it does not. At most B uses it as the start
   state for its spin-up, which shortens the time to a repeating cycle
   but does not change the result.
4. **12 months.**
5. **Determinism.** The climate step at 256×128 runs in one process.
   Estimate: B is about 32 k cells × 12 months × some 100 steps × 5–10
   years to converge, a few seconds single-threaded; A adds a Poisson
   solve per month. The long runs of the final refinement use the pool.
   There, every solver is Jacobi (not Gauss–Seidel) with a partition that
   does not depend on the thread count, so the result is bit-identical
   for any pool size.
6. **Layers and keys** are proposed with each build step.
7. **Trigger.** Start and reset buttons, as in the tectonics step. Start
   is disabled after a complete run and becomes active again after a
   reset or when the result becomes stale. A step-0 slider change after
   the run discards the result: the climate must be computed again. It
   does not rerun by itself (20–40 s for each slider movement is too
   much); the step shows that the result is gone and start is active.
