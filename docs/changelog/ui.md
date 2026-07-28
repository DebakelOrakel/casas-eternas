# Changelog — UI

Controls, overlays, rendering, save/load, notifications. See [README](./README.md) for the
format. (The legacy sphere and mars screens are out of scope and not tracked here.)

## 2026-07-28
- **new** Genesis: Archean UI — genesis-phase controls for the Archean simulation. `worldgen.panel.genesis`
- **new** Genesis: plate preview — pausing the Archean shows the plates a hand-off would produce, from the very seeds the hand-off would use. `world.overlay`
- **changed** Hydrology: new water level wired into the map view.
- **new** Overlays: craton age — crust painted pale sand where it just formed, deep russet where it is as old as the world, so a continent's growth around an ancient core becomes visible. `world.overlay`
- **changed** Overlays: the mantle tint saturates against the field's own 90th percentile instead of a fixed divisor, so it reads the same in both phases. `world.overlay.mantle`
- **fixed** Overlays: plate boundaries stay visible while tectonics runs — they used to vanish exactly while the plates were moving. `world.overlay`
- **dropped** Overlays: plate velocity arrows — a debug layer that had no toggle left.
- **changed** Layout: the tectonics readout is land / continents / plates / age; the epoch counter is gone. `worldgen.panel.tectonics`
- **fixed** Layout: the Archean narration band is confined to the Genesis panel; a `display: flex` rule outranked `[hidden]`, so the last Archean sentence stayed on screen for the rest of the run. `worldgen.panel.genesis`
- **changed** Save/Load: the world.yaml recipe is grouped by pipeline stage (genesis / erosion / climate / hydrology / ecology) and no longer repeats what state.json already carries. `common.action.saveWorld`
- **fixed** Save/Load: a saved world now carries the mantle field and the boundary-detection lattice — without them a reloaded world drifted off the trajectory it was saved on. `common.action.saveWorld`

## 2026-07-26
- **changed** Ecology: UI detailed — category fold-outs with per-field abundance sliders. `worldgen.panel.ecology`
- **changed** Layout: UI reworked and improved (panel flow). `worldgen.panel`
- **changed** Save/Load: file format updated; save robustness and portability improved. `common.action.saveWorld`

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
