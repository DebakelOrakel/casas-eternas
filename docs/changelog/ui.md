# Changelog — UI

Controls, overlays, rendering, save/load, notifications. See [README](./README.md) for the
format. (The legacy sphere and mars screens are out of scope and not tracked here.)

## 2026-08-09
- **new** Save: a warning badge on the save button while the world differs from the last one saved, loaded or generated; its hover card says so. `common.action.saveWorld.unsaved`
- **fixed** Panels: a step that cannot run yet releases the controls and names what it is waiting for, instead of leaving the spinner turning. `worldgen.panel`
- **changed** Climate: retuning a climate slider stales the rivers and ecology derived from the old one, instead of leaving them on the map. `worldgen.panel.climate`
- **fixed** Tectonics: the reset button returns to the hand-over every time — only the first one used to, later ones landed on a drifted world. `worldgen.panel.tectonics`
- **fixed** Save/Load: opening a world no longer loses it when you step to the Tectonics panel, if a Genesis had been run earlier in the same session. `worldgen.panel.tectonics`
- **changed** World map: biomes are re-derived from the amplified terrain after every bake stage, so the wash follows the ridges and valleys the bake carved instead of being upscaled from the macro map. `world.biome`
- **fixed** Save: the lake layer is written at map resolution — it used to report every lake as at least 62 km across, four times their real area. `world.overlay.rivers`

## 2026-08-08
- **changed** Save: the biome layer is written at map resolution, so a loaded world's biomes are as detailed as the terrain. `world.biome`
- **fixed** World map: the biome tooltip named a different biome than the one painted under the cursor near every boundary. `world.biome`
- **changed** Rendering: the generator previews the baked river network when one exists, instead of only its own macro one. `worldgen.panel.hydrology`
- **new** Controls: 4K and 8K buttons in the erosion panel order an amplification bake; 8K needs a server and a saved world, and says so when it cannot. `worldgen.panel.erosion`
- **new** Notifications: can show a progress bar and update in place, for work that runs for minutes. `common.notify`
- **new** Server: a status indicator in every screen's top-left corner says where worlds would go — no server, unreachable, local, or shared. `common.server`
- **changed** World map: the cache button moved from the bottom bar up next to the load button, matching the generator.
- **changed** Storage: the storage button carries a real hover card instead of a debug tooltip, and is called Storage — it will hold worlds as well as the cache. `common.action.storage`
- **new** Save: with a server present, the save button opens a window showing what the server holds for this world, and offers to update it there or download a .zip. `common.panel.save`
- **new** World map: a debug control cycles between the resolutions a world actually has — macro, 4k, 8k — so they can be compared directly instead of from memory.
- **changed** World map: an 8k world baked on the server is now shown — the client displays whatever resolution it can find, while still only baking what a browser tab survives. `world`
- **new** Storage: baked terrain is now shared through the server — a world baked on one machine downloads on the next instead of costing minutes again. `world`
- **changed** Storage: the window lists what this machine holds and what the server holds separately, each with its own delete. `common.panel.storage`
- **new** Load: with a server present, the load button opens a browsable list of server worlds with thumbnails — open one, or download it; opening a local .zip stays one click away. Works in the generator and the world map. `common.panel.load`

## 2026-08-07
- **new** Rendering: 3D relief preview — eroded terrain unlocks a deeper zoom and a zoom-coupled camera tilt over a metre-true displaced map plane with draped rivers.
- **new** Controls: WASD pans the map; Q/E rotate the view while zoomed in, and zooming out returns it to north-up.
- **changed** Rendering: river ribbons narrow toward physical widths at relief zoom instead of keeping their map-scale line widths.
- **changed** Rendering: the relief preview is now truly lit — real vertex normals under a camera-relative sun on an unshaded texture, instead of the baked map hillshade.
- **changed** Controls: zoom is exponential with wheel-delta-scaled steps — every step changes the view by the same percentage, and trackpads glide instead of jumping.
- **new** Title screen: a "Herederos del Mundo" entry leads to the world-map screen (the renamed game-screen placeholder).
- **new** World map: loads a saved world through its baked manifest layers and shows the flat paper map with an elevation/biome hover readout — no generator involved.
- **new** World map: the lit 3D relief with deep zoom, tilt and rotation works here too, driven by the saved elevation raster.
- **new** World map: zooming past the deepest map view hands over seamlessly to a perspective descent — altitude-driven zoom down to ~2.5 km with a horizon, gradient sky and distance haze; the sun settles into a world-fixed position near the ground.
- **new** World map: the 300 m hex grid fades in during the descent — drawn in the terrain shader, welded to the ground, seamless across the world wrap.
- **new** Controls: R/F adjust the view pitch during the descent (40–80° band); zooming back out returns to the standard curve.
- **new** World map: near-field terrain detail — a camera-following patch synthesizes deterministic sub-cell relief from the saved raster, so low flight stops being silky-smooth.
- **new** World map: the amplification bake starts — a loaded world is upsampled and seeded with roughness in its own worker, then swapped in under the running map. `world`
- **new** World map: the bake now erodes the amplified world, with the erosion constants rescaled for the finer cells — carving tributary valleys the saved raster never had. `world`
- **new** World map: rivers — re-routed on the amplified terrain so they run in the new valleys, drawn as ribbons that drape onto the relief. `world.overlay.rivers`
- **changed** World map: the bake now runs in stages, each swapped in as it lands, with the map texture sharpening alongside — shipping at 4096 for now, since 8192 exhausts a browser tab's memory.
- **new** World map: baked worlds are cached on disk — reopening one skips the minutes of amplification and loads in about a second. `world`
- **new** Cache manager: a window listing every cached world with its size and the resolutions baked for it, deleting one or all — reachable from the world map and the generator.
- **changed** World map: mountains grow ridgelines — the bake now adds ridged relief at crest scale rather than range scale, so ranges read as crests and spurs instead of smooth bulges. `world`
- **changed** Rendering: vertical exaggeration now follows the view — mountains rise markedly on the map and settle to true scale as you descend.
- **changed** World map: the bake carves deeper valleys — it no longer lifts terrain back toward the shape it is carving into.
- **new** World map: biome colouring — the saved biome layer washed over the paper map, with organic boundaries instead of climate-grid squares, and a button to compare against plain paper. `world.biome`

## 2026-08-06
- **new** Overlays: water balance — rainfall minus evaporation, arid to humid. `world.overlay.waterBalance`
- **new** Overlays: watersheds — each river system's catchment in its own colour. `world.overlay.watersheds`
- **new** Map hover: rivers report their flow in m³/s. `world.hover.discharge`
- **changed** Localization: every worldgen panel control now follows the language switch and carries a hover help card. `worldgen.panel`
- **new** Overlays: the category buttons explain which layers they hold. `world.overlay.group`
- **changed** Localization: biome names in the legend and the map readout follow the language switch. `world.biome`

## 2026-07-31
- **fixed** Save/Load: a world can be saved while it is still in the Archean; the button did nothing there. `common.action.saveWorld`

## 2026-07-30
- **changed** Overlays: the mantle overlay split into mantle field, volcanoes and hotspot plumes. `world.overlay.mantle`
- **changed** Overlays: a fold-out hangs under its own category button, icons on one row. `world.overlay`
- **fixed** Overlays: craton age is masked to the coastline instead of the full blob radius. `world.overlay.cratonAge`

## 2026-07-29
- **new** Title screen: mission-statement list → a Changelog viewer, category tabs rendering the `docs/changelog` files inline. `common`
- **new** Localization: i18n runtime + full EN/DE catalogs (tsc-gated) + a title-screen EN/DE switch; overlay-icon labels wired first. `world.overlay`
- **new** Tooltips: shared white card + a delegated `data-help` control-help tooltip; wired to the overlay icons. `world.overlay`
- **changed** Overlays: one button per pipeline stage instead of one per overlay — fifteen icons became seven; a click folds that stage out, hovering a neighbour switches, leaving the bar closes it. `world.overlay`
- **changed** Overlays: colour now means "has data", a dot under the icon means "on the map" — the two used to share one opacity ramp. `world.overlay`
- **changed** Climate: the temperature overlay comes on when you enter the panel, so a fresh compute lands on a map instead of a blank one. `worldgen.panel.climate`
- **changed** Layout: the Archean narration line moved down next to the compute bar, whose colour states the same judgement. `worldgen.panel.genesis`
- **fixed** Ecology: the resource grouping existed twice and had already drifted — `metals`/silver-gold against `metal`/gold-silver, and one of them names a key in world.yaml. `worldgen.panel.ecology`

## 2026-07-28
- **new** Genesis: Archean UI — genesis-phase controls for the Archean sim. `worldgen.panel.genesis`
- **new** Genesis: plate preview — pausing the Archean shows the plates the hand-off would produce. `world.overlay`
- **changed** Hydrology: new water level wired into the map view.
- **new** Overlays: craton age — crust coloured by age, pale (young) to russet (old). `world.overlay`
- **changed** Overlays: mantle tint scales to the field's 90th percentile, consistent across phases. `world.overlay.mantle`
- **fixed** Overlays: plate boundaries stay visible while tectonics runs. `world.overlay`
- **dropped** Overlays: plate velocity arrows — a debug layer with no toggle left.
- **changed** Layout: tectonics readout is land / continents / plates / age; epoch counter gone. `worldgen.panel.tectonics`
- **fixed** Layout: Archean narration band no longer lingers past the Genesis panel. `worldgen.panel.genesis`
- **changed** Save/Load: world.yaml grouped by pipeline stage, no longer duplicating state.json. `common.action.saveWorld`
- **fixed** Save/Load: saved worlds now carry the mantle field + boundary lattice, so reloads stay on trajectory. `common.action.saveWorld`

## 2026-07-26
- **changed** Ecology: UI detailed — category fold-outs with per-field abundance sliders. `worldgen.panel.ecology`
- **changed** Layout: UI reworked and improved (panel flow). `worldgen.panel`
- **changed** Save/Load: file format updated; robustness + portability improved. `common.action.saveWorld`

## 2026-07-25
- **new** Overlays: hover tooltip — per-cell map readout. `world.readout`
- **new** Climate: more control levers. `worldgen.panel.climate`
- **changed** Overlays: experience overhauled — unified top toolbar + right-side legends. `world.overlay`
- **changed** Rendering: map colours overhauled — watercolour relief.
- **changed** Title screen: overhauled. `common.title`
- **fixed** Layout: scaling on very small screens.
- **fixed** Localization: language mix cleaned up — UI text unified. `common`

## 2026-07-24
- **new** Save/Load: a world serializes to a `.zip` (recipe + snapshot + rasters + preview). `common.action.saveWorld`
- **changed** Events: event system + overlays reworked. `world.event`

## 2026-07-23
- **new** Notifications: toast system. `common.notify`
- **new** Save/Load: first (very simple) download function. `common.action.saveWorld`
- **new** Rendering: debug 3D relief view.
- **changed** Events: plate-event highlighting improved. `world.event`

## 2026-07-22
- **changed** Camera: extracted from the scene into a reusable module.

## 2026-07-21
- **new** Overlays: icons and overlays added. `world.overlay`
- **changed** Layout: UI and view adjusted.
