---
summary: The climate step refines today's climate on the final geography. A pressure field and a terrain-aware wind, a 12-month energy balance with moisture transport, better ocean currents, Köppen classes that feed the biomes, and fields for phenomena and for the reliability of rain. Budget 20–40 s; the epochs keep the cheap model, except two current-solver terms.
date: 2026-09-28
area: generator
updated: 2026-09-28
stage: building
status: discussed and agreed 2026-09-28. Build steps 1 (β term, island rule), 2 (pressure and wind, the step's button, month slider and pressure layer) and 3 (currents from that wind, upwelling) BUILT 2026-09-28; the rest is not built. The order at the end is the build order. Constants are not measured. The decided forks are at the end; none is open.
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
5. **Salinity and the conveyor** (revised 2026-09-29: a field, not an
   estimate per basin). The sea surface's salinity from evaporation,
   rain, the rivers' outflow (the hydrology's discharge at the mouths) and
   the salt sea ice leaves behind, carried by the currents as the sea
   surface temperature is. Cold, salty water is dense: where it forms at
   high latitude, it sinks, and warm surface water is drawn after it along
   the currents (the Atlantic's overturning, some degrees of warmth on the
   coasts downstream). The salinity is a field of its own too: brackish
   estuaries, salty marginal seas. No depth model: the sinking's strength
   is read off the surface, and its pull is calibrated, not computed.

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
| Salinity, conveyor | evaporation, rain, rivers, ice, currents | later | – | – | high-latitude heat, estuaries |
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
   BUILT 2026-09-28: the solve went from 139 to 173 ms on Astrakan, about
   +11 ms per epoch (the climate runs every third epoch). West/east
   boundary speed 0.34/0.32 before, 0.32/0.08 after.
2. A: pressure and wind.
   BUILT 2026-09-28 (climate/pressure.ts, the `climateRefine` message).
   Display only: nothing reads the monthly wind yet, and the worker keeps
   no copy. Weak until B: the cheap seasonal swing peaks at 14 °C (Earth's
   interiors 40–60 °C), so the thermal part stays within ±3 hPa on Astrakan.
   Signs measured right (January cold high over the northern land, July
   heat low).
3. Currents 2 + 4.
   BUILT 2026-09-28 (climate/refinement.ts, oceanCurrents.computeUpwelling).
   The curl's x term is exactly 0 for the banded wind, so the epochs are
   unchanged. Near the equator only the eastern part of a basin cools
   (the thermocline tilt, eastwardInBasin). Measured on Astrakan: the
   equatorial sea −1.0 °C on average (the cold tongue), the subpolar band
   −0.4 °C, the whole refinement 0.38 s. The eastern coasts at 15–40° get
   little: at 30–40° the banded wind blows poleward, and the equatorward
   coast winds come from the subtropical highs' eastern flank, which A
   forms only with B's temperatures. The productivity field for ecology is
   the upwelling itself; ecology does not read it yet.
4. B: twelve months, sea ice.
   BUILT 2026-09-28 in part (climate/energyBalance.ts, refinement.ts): the
   cycle is a linear energy balance for the departure from the cheap
   model's annual mean, solved directly per harmonic (the year and the half
   year, no spin-up); the rain is computePrecipitation once a month with
   the month's air, the month's pressure wind and the rain belt following
   the sun. Calibrated on Astrakan and a synthetic continent at 25–72°:
   seasonal range at mid latitudes 9 °C at sea, 16–22 °C on coasts,
   28–33 °C inland (Earth 35–45); subtropical interiors 23–31 °C (Earth
   20–30); tropics 6 °C; polar coasts 24–30 °C (Earth ~30) once sea that
   freezes counts with land's heat capacity. Sea ice is that rule only: a
   linear model cannot let the ice come and go, so there is no ice field.
   Astrakan: the whole refinement 2.6 s, land rain 1021 mm/yr against the
   cheap 944, the wettest month to the driest 8.9 : 1 at the median —
   likely too seasonal; to check against Köppen. The progress pill shows
   the run; there is no stop yet (not needed at 3 s).
   The run was planned at 20–40 s: the worker
   reports its progress to the progress pill, and the button becomes a
   stop (`generator.action.runClimate.labelActive` exists for it).
   The save keeps the refinement since formatVersion 6 (2026-09-28): one
   climate-grid layer per month and component (`pressure.01`, `windU.01`,
   …, `currentU`, `currentAnomaly`, `upwelling`; world/save/refinedLayers.ts),
   and a load puts it back on the recomputed climate. B adds its monthly
   temperature and precipitation the same way.
5. Köppen, feeding the biomes.
   5a BUILT 2026-09-28 (climate/koppen.ts, Peel et al. 2007): the biomes
   of every path follow the class; where only annual figures exist (the
   epochs, the climate before refinement, the riparian pass) the months are
   synthesized from mean, range and the signed monsoon index. Four biomes
   added (ids 14–17). The Köppen layer shows the refinement's classes from
   real months, else the synthesized ones. The rain bands' seasonal shift now
   tapers with latitude (precipBeltTaperDeg, precipBeltShiftFloor): one shift
   for all made Astrakan 15–17 % Cs. After: synthesized Cs 4 %, refined Cs
   6 %, D 21 %, wet-to-dry month 4.8 : 1 at the median. Savanna (Aw) is
   short in the refined path (4 % against Af 12 %; Earth has Aw above Af).
   5b BUILT 2026-09-28: the refined climate takes the history's place in
   the worker (annual fields derived from the months, refinement.
   annualFromMonths), its biomes classified per pixel from the twelve
   interpolated months (biomes.computeBiomesFineFromMonths, 0.14 s at
   2048), everything downstream stale so rivers, lakes and ecology run on
   it; the riparian bonus scales each month's rain. The hydrology's dry-basin
   climate pass (v2) leaves a refined climate alone, so the refinement does
   not see the dry-basin override. A load refines again rather than reading
   its layers back (deterministic, and the worker needs the climate).
   Savanna had vanished (Aw went all to dry forest at the Whittaker bound of
   600 mm, below Köppen's own dry limit of ~780 mm); its own bound
   savannaMaxPrecipMm = 1400 brings it back: Astrakan synthesized 9.8 %,
   real months 4.8 %.
6. C1: fog coasts, föhn.
   BUILT 2026-09-28 (climate/phenomena.ts): shares of the year per cell,
   from the months' wind, the sea's anomaly and the relief; fog cools the
   coast's month toward the sea, föhn warms the lee, before the Köppen
   classes. One layer ("weather phenomena") with a pick in the step, agreed
   2026-09-28, catalog `weather.*`. Astrakan (a flat world, highest peak
   1700 m): fog on 194 land cells (38 above a fifth of the year, most at
   polar and subpolar coasts, some coastal desert), föhn on 84 (at most a
   quarter of the year). Constants unmeasured against Earth.
7. Reliability field.
   BUILT 2026-09-28 (climate/reliability.ts): the rain's coefficient of
   variation from its dryness (4.5/√mm, capped 0.8) and seasonality, plus an
   ENSO see-saw for equatorial basins with shores on both sides, strength
   from their west-to-east warmth and width, the land past the east end
   wetter and before the west end drier in the warm phase; period from the
   width (2–5 years). Astrakan: variability 12/20/47 % (p10/p50/p90), a
   basin of strength 0.30; a 150° test basin gives 4.5 years. In the save:
   layers rainVariability and ensoPattern, table enso (period, strength);
   the reliability is derived again on load, like the classes.
8. C2–C4.
   BUILT 2026-09-28 (climate/storms.ts, 0.09 s): cyclone tracks from warm
   tropical sea along the month's wind with a west and poleward drift,
   fading over land and cold water; tornado readiness from warm moist air,
   high ground upwind under a westerly, a plain; blizzards as cold, snowy,
   windy months; dust from dry thawed land carried downwind; thunder from
   heat and rain. Mean latitudes on Astrakan and a test world: cyclones
   15–16°, tornadoes 35–46°, blizzards 50–57°, dust 28°, thunder 17–18°
   (the first cut had cyclones at 10° and tornadoes at 21°: too little
   poleward drift, and wind from any side instead of the westerlies).
   In the save as layers; they read the relief, so a load reads them back
   rather than deriving them.
9. Currents 5 (salinity and the conveyor).
   BUILT 2026-09-29 (climate/salinity.ts; the refinement 2.6 → 3.6 s).
   The salt budget per sea cell (evaporation, rain, rivers, brine) carried
   by the currents and relaxed toward 35 psu. The rain model rains over
   land only, so the sea's rain is estimated from its zonal band factor
   times the local evaporation; the rivers are each land cell's surplus at
   its nearest sea cell (the routing runs after the climate). Sinking where
   the sea is near freezing and saltier than its latitude's mean: an
   absolute density threshold sank every polar sea or none, as the polar
   seas come out within 0.1 psu of each other (no moisture moves between
   oceans here). The sinking draws surface water after it: a potential flow
   into the sinks (oceanCurrents.computeSinkInflow), the sunk water rising
   spread over the whole sea, added to the wind's currents at 0.3 of their
   fastest; the salt is computed again on those. The overturning's warmth
   is the sea temperature's difference with and without the inflow, onto
   the coasts, in every month. (A first cut traced a warmth back along the
   wind's currents instead, which left the currents themselves untouched.)
   Astrakan: 34.2 psu at the equator, 37.1 in the subtropics, 35.5 at mid
   latitudes (Earth ~34.5, ~37, 34–35); sinking on 4 % of the sea at a
   mean 68°; the land beside it up to 2.3 °C warmer (0.6 of the wind's
   fastest gave up to 6 °C); the whole refinement 4.4 s. The controls: not wanted
   (2026-09-29: eccentricity and perihelion add little beyond the tilt,
   an ocean heat transport knob has no physics). D: when needed.
10. Final refinement: with the bakery step.

## Calibration on Earth

`node client/scripts/earthClimate.mjs [key=value …]` runs the climate on
Earth's relief (client/scripts/fixtures/earth-heightmap.png) and compares
47 places (Köppen class, January and July, annual rain) and the land's
Köppen group shares; since the Beck et al. map for 1991–2020 came in
(client/scripts/fixtures/earth-koppen.tif, 0.5°), also every land cell
against it — the share with the right class and group, and where each real
group ends up. The temperature error is also
given as a bias of the mean and of the swing, so the annual mean (the cheap
model, step 0) and the year's cycle (the energy balance) can be told apart.

2026-09-29, in order:

| Change | Class | Group | Swing bias | Rain | Groups off |
|---|---|---|---|---|---|
| Start | 9/47 | 22/47 | — | ×2.65 | 24 |
| Orographic rainout cap 0.85 → 0.15 | 9 | 22 | −2.8 °C | ×2.35 | 25 |
| Energy balance: wind carry 400 → 150 | 10 | 23 | −0.6 °C | ×2.22 | 18 |
| Sea evaporation at its surface, source anomaly 0.2 | 10 | 24 | −0.6 °C | ×2.49 | 8 |

"Groups off" in this table is against Beck 2018's rounded shares (A 19,
B 29, C 14, D 22, E 16). Against the 1991–2020 map (A 23, B 27, C 13,
D 22, E 15) the last row is 13 points off; per cell, 26 % of the land has
the right class and 63 % the right group. Of the real C land, 51 % comes
out B — the dry east coasts.

Against the map from here on:

| Change | Class | Group | Places class | Rain | Groups off | Real C → B |
|---|---|---|---|---|---|---|
| Start | 26 % | 63 % | 10/47 | ×2.49 | 13 | 51 % |
| Ocean highs from the basin's flank | 27 % | 65 % | 15/47 | ×2.06 | 19 | 30 % |
| Dry air mixed in where the air sinks (0.05) | 27 % | 65 % | 15/47 | ×2.06 | 16 | 34 % |
| Upslope read across the cell, lever 20 px (also the epochs) | 27 % | 66 % | 15/47 | ×1.98 | 16 | 34 % |
| Energy balance: land capacity 3·10⁷ → 1·10⁷, damping 2.1 → 8, carry 150 → 100 | 31 % | 65 % | 16/47 | ×2.04 | 17 | 35 % |

The last row fixes the year's phase: the northern land's warmest month was
August or September (the instrument now prints it), on Earth July; now
July on 80 % of it, August 15 %. The places' January and July errors fell
4.1 → 3.8 and 3.7 → 3.1 °C.

**The heightmap's scale was wrong until here.** The instrument read the
land up to 8849 m at 255; fitted on thirteen cities and plateaus the file
is linear at 61.6 m per level and cut off at some 5940 m, so every
highland stood 1.4–1.7 times too high (Lhasa 6200 m, Tibet −16 °C in
July). The rows above were measured on that relief; their direction
holds, their numbers are too low. With the scale right, and nothing else
changed:

| Change | Class | Group | Places class | Rain | Groups off | Real C → B |
|---|---|---|---|---|---|---|
| Heightmap at 61.6 m per level | 34 % | 70 % | 14/47 | ×1.98 | 6 | 35 % |
| Elevated heat source, 0.6 hPa/(km·°C) | 35 % | 71 % | 14/47 | ×1.91 | 7 | 32 % |
| Sea surface anomaly relaxed 0.15 → 0.1 per pass (also the epochs) | 35 % | 70 % | 15/47 | ×1.91 | 6 | 34 % |

**The calendar was upside down until here (fixed 2026-09-29).** The map
is drawn mirrored in y, so the grid's top rows are the screen's lower half;
the model gave them the July summer, and the screen's upper half — the
north a reader sees, whose winds turn as the north's do — had its summer
in January. The calendar now runs the other way (climateField.
TOP_SUMMER_MONTH, the energy balance's equinox and the rain belt's peak
moved by half a year), and the instrument lays Earth's north on the
bottom rows. The physics is the mirror image of before, so the annual
fields, the classes and the golden metrics did not move. The instrument
after it: cells 35 % class, 71 % group; places 17/47; the northern land
warmest in July (54 %) or June (37 %) — Earth's northern summer now falls
at aphelion, as it does on Earth.

**The sea's warmth carried inland with the wind** (2026-09-29, also the
epochs): the SST anomaly used to spread four cells onto every coast
alike; it is now carried along the wind from the sea the air last
crossed, e^(−d / 15 cells), and a lee coast gets 0.3 of its own shore's.
Oslo's year −4 → −1 °C, the places' annual error 2.54 → 2.47 °C, classes
17 → 18/47; the cells and shares did not move. The east coasts stayed as
warm as they were (Tokyo, New York, Beijing, Chicago +4..+6 °C): the cause
is the latitude profile. The cheap model's base is −25 + 55 cos φ;
Earth's zonal mean near sea level fits −30 + 56.5 cos φ (26.5 °C at the
equator, 13 °C at 40°, −2 °C at 60°), so the base runs 3–6 °C warm from
20° to 50° and some 3 °C in the tropics. Europe only looks right because
its missing North Atlantic warmth (off Norway +2.6 °C against Earth's +7)
cancels that. A step of its own.

**The latitude profile and the mass elevation effect** (2026-09-29, step 0,
so every world and the epochs). Earth's fitted profile (26.5 °C, −30 °C)
ran 2.7 °C cold here and shrank the A climates 22 → 15 % of the land: the
tropical highlands were already too cold (Brasília, Bogotá, Mexico City
−2..−5 °C), missing the warmth a broad high surface gives the air on it.
Kept: the equator at 28 °C, the pole at −25 °C, and +2 °C per km of the
land's height smoothed over three cells. The places' annual mean error
2.47 → 2.23 °C, its bias +1.0 → +0.3, January's 3.8 → 3.5 °C; Tibet's
warmest month 0 → 7 °C; the groups' shares 6 → 9 points off (C grows).
The golden worlds came out 1.2 °C cooler, with 4–6 % less rain and runoff.

**The continental winter, second try** (2026-09-29, dropped again). The
months below the year's mean deepened on land where the air is
continental and the month cold enough for snow. Three measures of
continentality: the land's share upwind along the banded wind; the cells
over land back to the sea plus the highest ground crossed (the
Cordillera keeps the Pacific out of the North American interior); the
same along the first pass's mean pressure wind, which carries Europe's
westerlies where the banded cells die out near 60°. The last kept Oslo
out of it (continentality 0.03), but Moscow came out as continental as
Yakutsk (0.77 each): the wind reaching Moscow comes from the west-south-
west over land, the one reaching Yakutsk from the Sea of Okhotsk. At a
deepening of 1 Winnipeg's January −5 → −17 °C (−16), Yakutsk's −16 → −29
(−38), Chicago −5 (−5), but Moscow −21 (−7), Denver −9 (−1), Tehran −7
(3), Anchorage −19 (−9); the cells' right group 71 → 73 %, the places'
January error 3.5 → 3.9 °C, the groups' shares 9 → 13 points off. At 0.5
a draw. What sets Yakutsk apart from Moscow on Earth is the Siberian High
and its inversions, and what sets Winnipeg apart the Arctic air the
ranges channel south — a winter circulation this model does not have. And
Europe's winters are too cold before any deepening (Moscow −10, Oslo −8),
which is the North Atlantic's missing warmth.

**The North Atlantic** (2026-09-29). The wind-driven currents carry the
Gulf Stream east across the ocean but not northeast to Norway: that branch
is the overturning's, which only the refinement has (step 9; it sinks in
the Norwegian Sea here, 0.89). Off Norway the refined sea is 4.3 °C over
its latitude (Earth some 7); a stronger inflow (conveyorFlow 0.5, 0.8)
raised it to 4.8 and moved no score. What made the northern coasts' winters
wrong was the energy balance: sea whose annual air mean fell below 0 °C
counted as frozen and swung like land, and with the cooler profile the
Nordic seas did (Reykjavik's year swung 28 °C, Earth 11). At −6 °C:
Reykjavik 14, the places' January error 3.5 → 3.3 °C, their swing error
5.2 → 4.7 °C, the rest as it was. The overturning's warmth now reaches the
land with the wind too (carryInland), as the currents' own anomaly does.

The step-0 temperatures, tried (2026-09-29). The places' annual means are
off in a regional pattern: highlands and the dry subtropics too cold
(Tehran −7 °C, Mexico City −6, Riyadh −5), the interiors and east coasts of
the northern continents too warm in winter (Yakutsk's January −16 °C
against −38, Winnipeg −4 against −16, Tokyo 19 against 5), northwestern
Europe too cold (Reykjavik, London). Tried and dropped: a continentality
term on the annual mean (the land's share around a cell, then along the
air's way upwind; subtropical warming, high-latitude cooling), a mass
elevation term (°C per km of smoothed height), a colder equator (28 °C),
and in the refinement a deeper continental winter below 5 °C. Each moved
some places right and as many wrong — the high-latitude cooling that
brought Yakutsk and Winnipeg near took Moscow to −23 °C in January and
Oslo, Reykjavik and Anchorage with it, as Europe already lacked the North
Atlantic's heat. What was kept: the sea surface anomaly, which came out at
a third of Earth's (off Norway +2.1 °C against some +7), now relaxes
slower (+2.6); Reykjavik's year is right, London's 2 °C instead of 4 too
cold. The rest of the North Atlantic's warmth is a matter of the currents'
speed there, not of the relaxation (at 0.05 the anomalies grew, the scores
did not).

The elevated heat source: a plateau heated in summer warms the middle of
the atmosphere, and a low forms over it that the sea-level reduction
cannot show. Tibet's July pressure 1016 → 1007 hPa, the wind over the Bay
of Bengal turns southwest, Beijing gets its summer rain (117 → 574 mm,
real 570). Delhi stays dry: it lies in the westerly on the low's south
side, off the Thar; the heat low over Pakistan that draws Earth's monsoon
trough along the Ganges is too shallow here. Tibet itself is still some
7 °C too cold in July: large plateaus are warmer than the free air at
their height (the mass elevation effect), which the cheap model's
uniform lapse does not know.

The monsoon, tried and left open (2026-09-29, before the heightmap fix): Nagpur and Kolkata get a
summer rain from the belt's shift, Delhi and Beijing none, and the summer
wind never turns southwest. A stronger thermal pressure (2–3 hPa/°C), a
stronger pressure wind (×2–3), the banded wind giving way where the
thermal part is strong, and the rain belt shifting further over land
(×1.5–2.5) each moved Delhi by under 60 mm and the scores not at all or
down. The Bay of Bengal's July pressure (1006 hPa, the band's trough
shifted north) stays below India's (1016): the heat low is too shallow to
draw the sea's air in. What a real monsoon needs here is a heat low that
beats the band's trough — likely the elevated heating of a plateau
(Tibet), which the sea-level reduction of the air hides. A topic of its
own.

The ocean highs: ±8 hPa from a basin's western shore to its eastern at
15–50°, smoothed as a mean over the sea; they enter the months' pressure
and wind, and under their western flank (below 0 hPa) the band's
subtropical dryness gives way. A test first: with the band factor's floor
lifted, Shanghai, New York, Sydney and Buenos Aires came out at 900–2200 mm
— the moisture was there, the band's dryness held it back. A high from the
sea's own anomaly (3–10 hPa/°C) dried the east coasts further: their warm
currents come out at +0.5 °C here. The groups' shares move away from
Earth's (C 18 % against 13) while the cells come closer; the cells are the
measure that counts where the classes lie.

The sinking air's mixing measured small: the deserts it was meant for stay
wet mostly from the upslope rainout (without it Riyadh 496 → 244 mm,
Tehran 445 → 148, Alice Springs 2051 → 431, Nairobi 6242 → 1717, Bogotá
5443 → 1357): a whole windward slope lies in one 62 km cell, so its rain
falls on the plateau above. That is the next thing to look at.

Done next: the rain model read the rise from 40 px upwind (up to 300 km)
to the cell's centre, so a plateau counted as a windward slope far behind
its rim. The rise is now read across the cell itself, edge to edge, and
scaled to a lever. Bogotá 5443 → 1880 mm, Alice Springs 2051 → 1330,
Tehran 445 → 330; Nairobi and Riyadh stay wet, their cells hold real
escarpments and their air is too moist. This is the shared rain function,
so the epochs' rain moved with it: at a lever of 20 px the golden worlds
lost 0–6 % of their rain; 10 px measured a little better on Earth (×1.93)
but took 10–19 % and halved a temperate rainforest, as it cuts every
smooth slope's rain too.

Tried and dropped, as they measured no better than what they replaced:

- A rain factor from the month's wind convergence instead of the zonal
  band. The banded wind's divergence dominates at 30–40° (±0.04 wind units
  per cell against ±0.03 from the thermal part), so the east coasts stayed
  dry; the monsoon's convergence is there (Delhi +0.037 in July, −0.033 in
  January) but too weak to carry the rain.
- A rain factor from the month's pressure (low wet, high dry, scaled so the
  bands alone give the band factor's range): class 10 against 10, groups
  13 against 9 points. The heat lows over the deserts rain as much as the
  monsoon's.
- An eddy diffusion of the moisture across the mean wind: at 0.05–0.1 per
  iteration the scores moved by one place or one point.
- A stronger thermal pressure (2–3 hPa/°C): groups 27–34 points off.

What is left, by place: the subtropical east coasts (Shanghai, Tokyo, New
York, Miami, Sydney, Buenos Aires) and the monsoon (Delhi, Kolkata,
Beijing) are too dry — the mean wind comes off the land there, and the
moisture the real coasts get comes with the storms of the western flank
of the subtropical highs, which a zonal high cannot give. Some interiors
and highlands are too wet (Alice Springs, Riyadh, Nairobi, Bogotá,
Brasília), from the upslope rainout of air that has not dried on its way
in. The dry subtropical summers are some 10 °C too cool (Madrid, Riyadh,
Tehran), which is the annual mean of step 0, not the cycle.

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
