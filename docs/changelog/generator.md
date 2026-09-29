# Changelog — Generator

Simulation layers of the flat-torus world generator. See [README](./README.md) for the format.
(The legacy sphere generator is out of scope and not tracked here.)

## 2026-09-29
- **changed** Climate: warm and cold ocean currents carry their warmth or cold further, so coasts beside them are milder or cooler. `overlay.currents`
- **changed** Climate: after refining, high plateaus heated in summer draw in a monsoon, so East Asia gets its summer rain. `generator.climate`
- **changed** Climate: after refining, continents are warmest in July (or January in the south), not a month or two later. `generator.climate.month`
- **changed** Climate: mountain rain falls on the slopes, not on the plateaus behind them. `generator.climate`
- **changed** Climate: after refining, the subtropical highs sit over the east of the oceans, so east coasts get rain and west coasts stay dry. `generator.climate`
- **changed** Climate: after refining, continents have stronger winters and summers, and coasts beside a cold sea get less rain. `generator.climate`
- **changed** Climate: mountains wring at most five times the plain's rain out of the air, not 28 times. `generator.climate`
- **changed** Climate: after refining, the wind cells and pressure bands move with the seasons like the rain belt, so winds turn and the trades and monsoons reverse over the year. `overlay.wind`
- **changed** Rivers: after refining the climate, whether a river runs dry follows the real months, snowmelt included, and not only how uneven the year is. `generator.panel.erosion`
- **new** Climate: the sea's salinity and where its cold, salty water sinks; the currents draw surface water toward it, warming the coasts on the way. A salinity layer shows it. `overlay.salinity`

## 2026-09-28
- **new** Climate: tropical cyclones, tornado alleys, blizzards, dust and thunderstorms under weather phenomena, kept in the save. `weather.cyclone`
- **new** Climate: the rain's year-to-year variability and an ENSO-like see-saw of equatorial basins, shown under weather phenomena and kept in the save. `weather.enso`
- **new** Climate: coastal fog and föhn — fog cools coasts beside a cold sea, föhn warms the lee of ranges; a weather-phenomena layer shows either. `overlay.weather`
- **changed** Climate: after refining, the biomes come from the real months, and rivers, lakes and ecology are computed again on the refined climate. `generator.action.runClimate`
- **changed** Climate: biomes follow the Köppen–Geiger class of the twelve months; four new biomes — Mediterranean scrub, steppe, tropical dry forest, cold desert. `biome`
- **new** Climate: a climate-class layer shows the Köppen–Geiger classes. `overlay.koppen`
- **changed** Climate: the seasonal shift of the rain bands is strongest at the equator and small beyond 30°. `generator.climate`
- **new** Climate: refining computes the year month by month — temperature from an energy balance, rain from each month's winds; temperature and rain follow the month slider. `generator.climate.month`
- **new** Save: a world keeps its climate refinement — pressure and wind per month, currents and upwelling — and opens with it. `generator.save`
- **changed** Climate: after refining, the currents follow the new winds, and upwelling cools the sea at the equator's eastern side and along coasts; an upwelling layer shows where. `overlay.upwelling`
- **new** Climate: a refine button computes air pressure and winds for each month; a month slider picks what the layers show, and a pressure layer draws highs, lows and isobars. `generator.action.runClimate`
- **changed** Climate: ocean currents run fast along the western side of a basin and pass between landmasses. `overlay.currents`

## 2026-09-27
- **changed** Planet: the preview world is a real one, Astrakan, in place of the three domes. `generator.panel.planet`
- **changed** Generator: the hover readout lists what the step's layers say at the point, and the legend what is on — both from one table per layer, so a step cannot offer a layer the readout does not know. `generator.readout`
- **new** Generator: each step remembers which layers you had on; a new or a loaded world starts every step on its defaults. `generator.overlays`
- **new** Ecology: an off entry among the resource picks; while nothing or the carrying capacity is picked the panel shows the three levers, a picked resource shows its own slider. `generator.panel.ecology`
- **new** Save: world.yaml records every run of the Archean and the tectonics — the slider values it ran on, its epochs and the build — under `history`. `generator.save`
- **changed** Tectonics: an epoch is one million years, fixed — the epoch-length slider is gone. `generator.panel.tectonics`
- **fixed** Hydrology: coasts that drop straight into deep water no longer show lakes at the shore — the water there could not reach the sea in the model's own graph and stood at the land's next spill. `generator.panel.hydrology`
- **new** Hydrology: the rivers and lakes overlay has a legend — perennial, seasonal and ephemeral rivers, lakes, ice, and the cliff, beach and marsh coasts. `overlay.rivers`
- **new** Generator: a scale bar at the map's lower right, a round length in kilometres that follows the zoom. `generator.scaleBar`

## 2026-09-26
- **changed** Generator: the progress indicator names what is being computed; the Archean and the tectonics fill a disc as they advance through their window, the other stages let rings rise like a plume; the Archean's narration moved from its band over the map into the pill and stands there after the stop. `generator.progress`
- **changed** Climate: the equator is drawn on the map and a temperature scale stands beside it; the slider that shifted the warm belt is gone — the climate runs inside the history now, and a belt moved afterwards no longer matched the land it had shaped. `generator.panel.climate`
- **changed** Tectonics: the history's live picture and its climate refresh every third epoch, the epochs between reuse the last weather — about half the wait per epoch; the full-density bake keeps every epoch. `generator.panel.tectonics`

## 2026-09-25
- **fixed** Hydrology: lakes no longer appear in the ocean after a history — the water bodies are read from the terrain as the epoch left it, not from before the coast and the sea level moved it. `generator.panel.hydrology`
- **changed** Tectonics: the history runs on a coarser mesh in the generator — an epoch takes about a tenth of the time, the land looks the same; the full density is the bake's. `generator.panel.tectonics`

## 2026-09-23
- **new** Tectonics: the sea works the coast through the history — waves cut exposed shores back into cliffs and platforms, and the sand they and the rivers supply drifts along the shore into beaches, bars and spits where the coast turns. `generator.panel.tectonics`
- **new** Tectonics: ice is part of the history — each epoch's climate grows glaciers and ice sheets that carve troughs and fjords, plane summits at the snowline, leave moraines at their ends and draw the sea down while they stand; the ice you see at the end is that epoch's, and land under it is glacier. `generator.panel.tectonics`
- **changed** Climate: the coldest climate class is a polar desert, not an ice cap — ice is what the glaciers make of it. `biome.iceCap`
- **new** Hydrology: the ground has water — springs where gravel lies on clay or rock, oases where they surface in the desert, rivers that keep flowing through the dry season on permeable ground, and a water table with a well's depth everywhere. `generator.panel.hydrology`
- **new** Tectonics: a young range rises as a train of parallel ridges and valleys — the crust buckles across the collision — before any river has cut one. `generator.panel.tectonics`
- **new** Tectonics: slopes fail by their rock — hard rock stands steeper, soft fill slumps — creep lays down scree at the foot of a slope as a layer of its own, and in the cold the ground itself creeps downhill. `generator.panel.tectonics`
- **new** Tectonics: vegetation holds the ground — forested land erodes less and stands steeper than bare rock, desert and tundra barely more than bare, and a river's banks are held by the same cover. `generator.panel.tectonics`
- **new** Tectonics: the climate runs with the history — every epoch has its own weather on the terrain of the moment, the rain of that epoch is what carves it, ice grows where the epoch is cold and draws the sea down while it stands, lakes remember how long they have stood, and every sediment layer keeps the climate it formed under. `generator.panel.tectonics`
- **new** Tectonics: the crust floats — a range that erodes rises back, a basin that fills sinks, and the weight of a range bends the plate beside it into a foreland basin; old cratons bend least, young ocean floor most. `generator.panel.tectonics`
- **new** Tectonics: rivers carry gravel and mud apart — torrents shed the coarse, which settles in fans near the range and wears to fine on its way, while the fine runs far — and a deposit may dam its valley into a lake that silts up to a plain. `generator.panel.tectonics`
- **new** Tectonics: what the rivers lay down is kept as layers — each epoch's deposits with their thickness and the rock they came from — and a valley filled with sediment erodes as sediment, not as the bedrock under it. `generator.panel.tectonics`
- **changed** Tectonics: the erosion runs inside every tectonic epoch — the terrain drifts with its plates, is rebuilt where crust is made or lost, and erodes as it goes; the erode button is gone, and the epoch length, floodplains and rock contrast sliders sit on the tectonics step. `generator.panel.tectonics`
- **changed** Erosion: the erosion runs on an adaptive mesh built from the tectonics at every point, dense on ridges and along rivers, coarse at sea — the save carries the mesh, the map still shows its rasterisation. `generator.panel.erosion`
- **changed** Hydrology: lakes and the river network are computed on the mesh the erosion carved, so a river follows the valley the erosion cut rather than a re-routing of the map's raster. `generator.panel.hydrology`
- **changed** Rendering: the relief's shading reads the mesh's own slopes, so ridges finer than the relief grid still light and shade. `generator.overlay`

## 2026-09-22
- **new** Hydrology: every river reach knows whether it flows all year, dries up in the dry season or only runs after rain — from its catchment's climate — and the map draws the last two dashed and dotted. `generator.panel.hydrology`
- **fixed** Hydrology: server bakes now carry the water bodies and the river graph like browser bakes do. `generator.panel.hydrology`
- **new** Planet: a step before the mantle sets the planet — axial tilt, greenhouse, day length and water — and the climate follows it: tilt sets the seasons and the pole-to-equator gradient, a slow spin widens the trade-wind belt. The step shows the climate layers on a sample world until the world has plates, then on the world itself. The greenhouse moved here from the climate step. `generator.step.planet`
- **fixed** Climate: sea cells no longer carry a wrong-sign half-degree seasonal swing, which bent the monsoon winds on every coast. `generator.panel.climate`
- **changed** Erosion: the landscape age reads in million years — one step of the engine is 20 000 years, so the slider runs from 0.2 to 8 Myr. `generator.panel.erosion.age`
- **new** Hydrology: glaciers have a thickness — ice forms where the climate makes it and flows down the valleys as ice sheets and tongues, drawn as ice bodies on the map and carried by the 4K/8K bakes. `generator.panel.hydrology`
- **new** Erosion: the sediment the pass lays down is listed as basins — floodplains, fans and marine wedges with their volume and the rock of the catchments that fed them — and saved with the world. `generator.panel.erosion`
- **new** Coast: every stretch of shore knows what it is — cliff, beach, marsh, delta or bare rock — from the wind that reaches it, the land behind it and the rivers that feed it, and the map draws cliffs, beaches and marshes along the shore. `generator.panel.hydrology`
- **new** Hydrology: dry valleys — wadis — appear in arid catchments where the rain that does fall has carved a valley, drawn dotted. `generator.panel.hydrology`
- **new** Elevation: the mantle lifts the ground above its upwellings and lets it sag over downwellings — a broad swell of a few hundred metres under a continent that sits on hot mantle, gone when the upwelling moves on. `generator.panel.tectonics`
- **new** Hydrology: rivers wide enough to show one get a course — a meander belt with oxbows where the ground is gentle, braided threads where it is steep, distributaries at a sediment-laden mouth — from their own discharge, slope and banks. `generator.panel.hydrology`
- **new** Hydrology: the river network is data — reaches with discharge, width, slope, sediment load and bank material between sources, junctions, lake inlets, outlets and mouths, each mouth with its catchment; the drawn rivers follow it. `generator.panel.hydrology`
- **new** Hydrology: every lake and terminal sea is saved as a water body with its level and outlet, and the lake layer follows from that list. `generator.panel.hydrology`

## 2026-09-20
- **changed** Climate: the world now knows which half of the year a place gets its rain in, not only how uneven the year is. `generator.panel.climate`

## 2026-08-17
- **changed** Erosion: rebuilt on a mass-conserving engine — sediment now goes somewhere instead of vanishing, rain shapes where valleys carve, and the new Landscape age, Floodplains and Rock contrast sliders replace Strength and Drainage. `worldgen.panel.erosion`
- **changed** Erosion: the 4K/8K detail bakes run the same engine — they now carve the world's own rock and rain (with floodplains along the valleys), and old bakes are re-baked on next view. `worldgen.panel.erosion.bake`
- **changed** Erosion: server bakes run multi-threaded — a 4K bake finishes in under half a minute, an 8K in about two. `worldgen.panel.erosion.bake`
- **changed** Worldmap: sharpening to the finest bake no longer shifts the terrain — coarser views are exact downscales of it, and only the quick preview before it arrives is still its own sketch. `worldgen.panel.erosion.bake`
- **changed** Climate: the climate panel moved before erosion, and its settings now shape where valleys carve — a humid world erodes differently from an arid one. `worldgen.panel.climate`
- **changed** Hydrology: how many rivers a region carries now follows its climate — arid land runs nearly dry instead of every desert getting token rivers. `worldgen.panel.erosion`
- **dropped** Hydrology: its panel and the river-density slider — rivers and lakes now compute and appear on the Erosion panel right after each pass. `worldgen.panel.erosion`
- **changed** Erosion: the bake picker selects one resolution, finest first — the finest bake derives every coarser view, so there is nothing left to order twice. `worldgen.panel.erosion.bake`
- **fixed** Climate: the panel reorder had dragged the old overlay defaults along — Climate no longer opens with the mantle showing, and Erosion keeps its terrain wash. `worldgen.panel.climate`
- **changed** Elevation: mountain mass saturates isostatically instead of plateauing toward the 9000 m ceiling — the vast ultra-high decks and their frozen brim-full lakes are gone, and crests still sharpen with crustal thickness.
- **new** Hydrology: lakes in permanently freezing climates are glaciers — their own biome, ice on the map instead of blue water, no riparian greening and no fishery. `world.biome.glacier`

## 2026-08-16
- **fixed** Tectonics: crustal age now runs on one continuous clock across the Archean handover — young worlds' craton-age overlay stops reading everything as newborn, age-dependent ores (iron, tin, gems) place correctly, and late-Archean crust is no longer wrongly recycled for ages after the eon ends. `worldgen.panel.tectonics`
- **changed** Erosion: the pass computes noticeably faster — progress reporting no longer stalls the simulation between updates. `worldgen.panel.erosion`

## 2026-08-15
- **changed** Hydrology: water follows its true downhill course instead of snapping to the grid's eight directions, so streams stop running in long grid-parallel streaks and meet each other more often. `worldgen.panel.hydrology`

## 2026-08-14
- **fixed** Hydrology: rivers now reach the sea they drain into instead of stopping one raster cell short. `worldgen.panel.hydrology`
- **changed** Hydrology: an amplified bake re-floods its lakes too, so lake shores are as fine as the terrain around them. `worldgen.panel.hydrology`

## 2026-08-11
- **fixed** Hydrology: rivers no longer break into dashes where they cross flat ground — the channel criterion starts a river, only the sea ends one. `worldgen.panel.hydrology`
- **changed** Erosion: river mouths now grade to the sea surface instead of the sea bed — estuary-deep drowned mouths stay, the long carved ocean arms are gone. `worldgen.panel.erosion`

## 2026-08-09
- **fixed** Climate: biome boundaries no longer step along the 62 km climate grid — the classification interpolates its climate inputs instead of taking the containing cell's. `world.overlay.biomes`

## 2026-08-08
- **changed** Climate: biomes are classified per map cell instead of per 62 km climate cell, so mountains get a treeline and salt flats keep their real outline. `world.overlay.biomes`
- **changed** Hydrology: channels now form on steep ground at smaller catchments, so mountains carry rivers instead of almost none. `worldgen.panel.hydrology`
- **changed** Hydrology: amplified bakes now draw a denser river network the finer they get, instead of repeating the macro one. `worldgen.panel.hydrology`

## 2026-08-07
- **changed** Ecology: metals, gems and obsidian concentrate into scattered deposits again instead of blanketing the map — only a fraction of volcanoes and orogens is mineralised, with tighter halos. `world.overlay.resources`
- **changed** Ecology: gold placer needs a genuinely large river now, not every stream. `world.overlay.resources`
- **fixed** Ecology: metal and gem overlays leave barren land as terrain — deposit halos fade out instead of tinting 0%. `world.overlay.resources`
- **changed** Elevation: mountains grow ridgelines — ranges read as crests and spurs instead of smooth bulges, in every world the generator makes.
- **fixed** Erosion: the delta threshold is now rescaled for finer grids like the constants around it, so a refined run stops building deltas from coastal trickles.

## 2026-08-06
- **changed** Genesis: continents assemble into a supercontinent within the Archean's natural span, instead of long after it. `worldgen.panel.genesis`
- **changed** Genesis: continents compact into massifs instead of drifting as strings of beads. `worldgen.panel.genesis`
- **changed** Genesis: the water slider's range now matches what the terrain visibly responds to. `worldgen.panel.genesis`
- **changed** Genesis: clearer phase hints, a continuous progress sweep, and ages shown in Ma only. `worldgen.panel.genesis`
- **new** Biomes: alpine — high mountains above the treeline are their own biome instead of reading as arctic tundra. `world.biome`
- **new** Elevation: plains carry a fine, slope-conditioned detail texture (render-only) instead of staying billiard-smooth.
- **fixed** Tectonics: plate merges stop at a floor of three plates, so a world can no longer collapse into a single frozen plate. `world.event`
- **changed** Hydrology: shallow terrain dimples no longer count as lakes — a lake needs a real basin under it. `world.overlay.rivers`
- **dropped** Hydrology: endorheic (closed) lakes — every lake overflows into a river now; basins too dry to overflow stay dry. `world.overlay.rivers`
- **new** Hydrology: landlocked seas are terminal basins — rivers end in them, and the climate sets their water level. `world.overlay.rivers`
- **new** Biomes: salt flats — the exposed floor of a shrunken terminal sea. `world.biome`
- **changed** Climate: refines once after hydrology — exposed basin floors join as land, deep ones with the heat of their depth. `worldgen.panel.climate`
- **changed** Hydrology: terminal seas count the rain that falls on them as inflow. `world.overlay.rivers`
- **changed** Biomes: the salt crust narrows to the band where the water last stood; the slopes above are hot desert rock. `world.biome`
- **fixed** Hydrology: rivers draw as one continuous line through the lakes and hollows they cross. `world.overlay.rivers`
- **changed** Erosion: lowlands carry real micro-relief now, so plains rivers branch into dendritic networks instead of running as a few straight trunks. `worldgen.panel.erosion`
- **changed** Erosion: delta plains slope gently seaward and their lobes grow rounded instead of as one-cell staircase arms. `worldgen.panel.erosion`
- **fixed** Erosion: coastal cliffs no longer pile talus into the sea — steep coasts stay steep instead of growing tall raised aprons. `worldgen.panel.erosion`

## 2026-08-01
- **new** Erosion: rivers carry their sediment to the sea and build deltas at the mouths. `worldgen.panel.erosion`

## 2026-07-30
- **fixed** Crust: "is there crust here" is one shared answer now, so new crust can grow onto an existing shore. `world.event`
- **fixed** Crust: continents are named by land area, and no longer during the Archean. `world.event`
- **changed** Tectonics: hotspot plumes come from the mantle field and drift with it, instead of five fixed points. `world.overlay.mantle`
- **new** Genesis: the Archean shows its plumes. `world.overlay`

## 2026-07-28
- **new** Genesis: Archean core — genesis sliders start a short Archean sim; crust nucleates only where hot *and* ocean. `worldgen.panel.genesis`
- **changed** Genesis: Archean tuned for the hand-off into tectonics. `worldgen.panel.genesis`
- **changed** Genesis: mantle vigour now drives the per-epoch mantle mixing — fewer plates, bigger landmasses. `worldgen.panel.genesis`
- **dropped** Genesis: vigour as the mantle's *initial* smoothing — washed out within ~40 epochs, so the slider did nothing. `worldgen.panel.genesis`
- **changed** Hydrology: new water level integrated into elevation/hydrology. `worldgen.panel.hydrology`
- **fixed** Crust: crust sink — land conserved instead of growing unbounded; rafts cycle properly. `world.event`
- **fixed** Crust: cratons weld on contact — rafts advect with the mean flow across their blobs instead of drifting apart. `world.event`
- **fixed** Crust: raft connectivity — rafts now grouped to match the drawn coastline. `world.event`

## 2026-07-27
- **changed** Elevation: recalibrated across the board — metre anchor (1.0 = 9000 m), GDH1 ocean age-depth, shelf-margin profile. `world.readout`
- **changed** Erosion: step tuned (strength + drainage-refresh levers). `worldgen.panel.erosion`
- **dropped** Erosion: deposition budget — deltas attempted, reverted; erosion deletes its material by design. `worldgen.panel.erosion`

## 2026-07-26
- **new** Migration: initial migration (anthropology proto) — user-placed origins → least-cost dispersal → arrow-tree. `worldgen.panel.migration`
- **new** Ecology: prestige resources — gold, silver, gems. `world.resource`
- **new** Ecology: material resources — copper/tin/iron (geological), timber, salt, tool-stone. `world.resource`
- **new** Ecology: fish — marine subsistence from upwelling. `world.resource.fish`
- **new** Ecology: carrying-capacity / sustainability field. `world.resource.carryingCapacity`
- **changed** Ecology: sim prepared for the ecology phase.
- **new** Climate: monsoon season — migrating ITCZ + land-sea wind reversal → wet-dry seasons, savannas. `world.overlay.monsoon`
- **changed** Climate: model tuned; equator offset lever added. `worldgen.panel.climate`

## 2026-07-25
- **new** Tectonics: mantle field coupled to plate motion — the supercontinent (Wilson) cycle emerges. `world.overlay.mantle`
- **new** Tectonics: seafloor spreading — new ocean floor at rifts, with ocean-age tracking.
- **new** Volcanism: hotspot island chains + overlay. `world.overlay.mantle`
- **new** Volcanism: flood-basalt provinces at continental breakup.
- **new** Volcanism: subduction-arc chains.
- **new** Hydrology: tectonic rift lakes — depth-capped grabens fill into deep lakes. `world.overlay.rivers`
- **new** Climate: ocean currents — wind-stress-curl gyres → sea-surface temperature. `world.overlay.currents`
- **new** Climate: seasonal fluctuations — seasonal temperature amplitude. `world.overlay.seasonality`
- **new** Biomes: Whittaker classification. `world.biome`
- **new** Hydrology: river network — precipitation-weighted D8 discharge, spline-smoothed. `world.overlay.rivers`
- **new** Hydrology: erosion-driven endorheic lakes — inflow vs. evaporation balance. `world.overlay.rivers`
- **changed** Hydrology: fed back into biomes — riparian greening (Nile effect).
- **changed** Erosion: step tuned.
- **dropped** Erosion: Braun-Willett incision routing — too subtle against the existing clamp; shipped strength + drainage sliders instead. `worldgen.panel.erosion`

## 2026-07-24
- **changed** Crust: continents reworked as metaball rafts decoupled from plates — land/ocean ratio emergent and conserved. `world.event`
- **changed** Crust: raft lifecycle reworked — accretion, collision, breakup.
- **changed** Tectonics: plate age modelled as a local field; plate sizes reworked (fewer, more size-skewed).
- **changed** Tectonics: simulation tuned; realism improved.
- **new** Climate: temperature gradient — latitudinal temperature + elevation lapse rate. `world.overlay.temperature`
- **new** Climate: wind bands — prescribed three-cell winds (Hadley / Ferrel / Polar). `world.overlay.wind`
- **new** Climate: precipitation — moisture advection + orographic rain shadow. `world.overlay.precipitation`

## 2026-07-23
- **new** Erosion: erosion phase — hybrid stream-power (MFD area, D8 incision) + thermal talus, priority-flood pit fill. `worldgen.panel.erosion`
- **changed** Tectonics & erosion: improved.

## 2026-07-22
- **changed** Topology: the world becomes a flat torus — new 2D map generator supersedes the (now legacy) sphere generator.

## 2026-07-21
- **new** Erosion: basic erosion pass. `worldgen.panel.erosion`
- **changed** Tectonics: plate tectonics + visuals improved.

## 2026-07-20
- **new** Tectonics: plate tectonics — Voronoi plates, Euler-pole motion, initial erosion pass. `worldgen.panel.tectonics`
