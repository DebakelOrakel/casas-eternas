# Changelog — Worldgen

Simulation layers of the flat-torus world generator. See [README](./README.md) for the format.
(The legacy sphere generator is out of scope and not tracked here.)

## 2026-08-11
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
