# Changelog — Worldgen

Simulation layers of the flat-torus world generator. See [README](./README.md) for the format.
(The legacy sphere generator is out of scope and not tracked here.)

## 2026-07-28
- **new** Genesis: Archean core — the genesis sliders start a short Archean simulation; crust nuclei form only where it is hot *and* ocean. `worldgen.panel.genesis`
- **changed** Genesis: Archean tuned for the hand-off into the tectonics phase. `worldgen.panel.genesis`
- **changed** Genesis: mantle vigour drives the per-epoch mantle mixing — plate count follows it from ~24 down to ~5, and the largest landmass grows with it. `worldgen.panel.genesis`
- **dropped** Genesis: vigour as the mantle's *initial* smoothing — measured to wash out within ~40 epochs (2.53x spread at epoch 0, 1.13x by 40) against a phase nobody stops before 150, so the slider moved nothing by the time it was read. `worldgen.panel.genesis`
- **changed** Hydrology: new water level integrated into elevation/hydrology. `worldgen.panel.hydrology`
- **fixed** Crust: the crust sink — land is now conserved instead of growing unbounded; rafts run real supercontinent cycles. `world.event`
- **fixed** Crust: cratons weld on contact — a collision computed a suture and passed the continent's name on, then the next epoch advected every blob separately and undid it; rafts now move with the mean flow across their blobs, and the largest landmass grows from ~10% of all land to 43-70%. `world.event`
- **fixed** Crust: raft connectivity — rafts were grouped about three times looser than the coastline the renderer draws (3 rafts counted where the map showed 46 landmasses), which also drove the land-fraction drift and the plate-count collapse. `world.event`

## 2026-07-27
- **changed** Elevation: recalibrated across the board — metre anchor (1.0 = 9000 m), GDH1 ocean age-depth, shelf-margin profile. `world.readout`
- **changed** Erosion: step tuned (strength + drainage-refresh levers). `worldgen.panel.erosion`
- **dropped** Erosion: deposition budget — deltas attempted, then reverted; erosion deliberately deletes its material (no excavation budget). `worldgen.panel.erosion`

## 2026-07-26
- **new** Migration: initial migration (anthropology proto) — user-placed origins → least-cost dispersal → migration arrow-tree. `worldgen.panel.migration`
- **new** Ecology: prestige resources — gold, silver, gems. `world.resource`
- **new** Ecology: material resources — copper/tin/iron (geological), timber, salt, tool-stone. `world.resource`
- **new** Ecology: fish — marine subsistence from upwelling. `world.resource.fish`
- **new** Ecology: carrying-capacity / sustainability field (aggregate suitability). `world.resource.carryingCapacity`
- **changed** Ecology: sim prepared for the ecology phase.
- **new** Climate: monsoon season — migrating ITCZ + land-sea wind reversal → wet-dry seasons, savannas. `world.overlay.monsoon`
- **changed** Climate: model tuned; equator offset lever added (latitudinal shift). `worldgen.panel.climate`

## 2026-07-25
- **new** Tectonics: mantle field coupled to plate motion — the supercontinent (Wilson) cycle emerges. `world.overlay.mantle`
- **new** Tectonics: seafloor spreading — new ocean floor created at rifts, with ocean-age tracking.
- **new** Volcanism: hotspot island chains + overlay. `world.overlay.mantle`
- **new** Volcanism: flood-basalt provinces at continental breakup.
- **new** Volcanism: subduction-arc chains.
- **new** Hydrology: tectonic rift lakes — grabens depth-capped so they fill into deep Baikal/Tanganyika-type lakes. `world.overlay.rivers`
- **new** Climate: ocean currents — wind-stress-curl gyres → sea-surface temperature. `world.overlay.currents`
- **new** Climate: seasonal fluctuations — seasonal temperature amplitude. `world.overlay.seasonality`
- **new** Biomes: Whittaker classification. `world.biome`
- **new** Hydrology: river network — precipitation-weighted D8 discharge, spline-smoothed. `world.overlay.rivers`
- **new** Hydrology: erosion-driven endorheic lakes — inflow vs. evaporation balance. `world.overlay.rivers`
- **changed** Hydrology: fed back into biomes — riparian greening (Nile effect).
- **changed** Erosion: step tuned.
- **dropped** Erosion: Braun-Willett incision routing — built, then dropped as too subtle against the existing clamp; shipped strength + drainage-refresh sliders instead. `worldgen.panel.erosion`

## 2026-07-24
- **changed** Crust: continents reworked as metaball rafts decoupled from the plates — land/ocean ratio is emergent and conserved. `world.event`
- **changed** Crust: raft lifecycle reworked — accretion, collision, breakup.
- **changed** Tectonics: plate age modelled as a local field; plate sizes reworked (fewer, more size-skewed).
- **changed** Tectonics: simulation tuned; realism improved.
- **new** Climate: temperature gradient — latitudinal temperature + elevation lapse rate. `world.overlay.temperature`
- **new** Climate: wind bands — prescribed three-cell winds (Hadley / Ferrel / Polar). `world.overlay.wind`
- **new** Climate: precipitation — moisture advection + orographic rain shadow. `world.overlay.precipitation`

## 2026-07-23
- **new** Erosion: erosion phase — hybrid stream-power (MFD drainage area, D8 incision) + thermal talus, priority-flood pit filling. `worldgen.panel.erosion`
- **changed** Tectonics & erosion: improved.

## 2026-07-22
- **changed** Topology: the world becomes a flat torus — new 2D map generator supersedes the (now legacy) sphere generator.

## 2026-07-21
- **new** Erosion: basic erosion pass. `worldgen.panel.erosion`
- **changed** Tectonics: plate tectonics + visuals improved.

## 2026-07-20
- **new** Tectonics: plate tectonics — Voronoi plates, Euler-pole motion, with an initial erosion pass. `worldgen.panel.tectonics`
