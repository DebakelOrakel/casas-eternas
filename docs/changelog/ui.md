# Changelog — UI

Controls, overlays, rendering, save/load, notifications. See [README](./README.md) for the
format. (The legacy sphere and mars screens are out of scope and not tracked here.)

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
