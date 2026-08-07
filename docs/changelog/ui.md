# Changelog — UI

Controls, overlays, rendering, save/load, notifications. See [README](./README.md) for the
format. (The legacy sphere and mars screens are out of scope and not tracked here.)

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
