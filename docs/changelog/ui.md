# Changelog — UI

Controls, overlays, rendering, save/load, notifications. See [README](./README.md) for the
format. (The legacy sphere and mars screens are out of scope and not tracked here.)

## 2026-10-02
- **new** Generator: opening a world made by an earlier version offers to make it again from its history with the same values, so it can be refined. `generator.replay`
- **changed** Generator: the jobs window shows each level of a job with its tiles and a projected end. `generator.jobs`
- **changed** Generator: the artifacts window groups by world and lists each level apart for server and browser, with why it is outdated. `generator.artifacts`

## 2026-10-01
- **changed** Generator: the Finishing step refines up to a chosen level and keeps what is already refined. `generator.finishing.depth`
- **changed** Generator: Refine the world now refines level 1 and then every tile with land, with live progress; the tile pick on the map is gone. `generator.finishing.refine`
- **changed** Generator: levels and tiles refined before today count as outdated and are refined again. `generator.artifacts`
- **fixed** Generator: saving while step 0 previews the sample world saves the world's own climate. `generator.step.world`
- **fixed** Generator: a run stopped during its first epoch counts as eroded, and later stops no longer count an epoch short. `generator.step.tectonics`
- **fixed** Generator: opening a world no longer keeps the previous world's peoples, basins or sediment. `generator.load`
- **fixed** Generator: the title bar says a world is saved only once the save has arrived, and a refused job order says why. `generator.jobs`
- **fixed** Generator: the finishing step counts a level only when it belongs to the world's current terrain. `generator.finishing`

## 2026-09-30
- **fixed** Generator: continent names stay on top of water, rivers and relief.
- **changed** Generator: zooming in no longer tilts the map; R and F tilt it, and zooming out brings it back to top-down.
- **new** Generator: the Finishing step refines one area of the world — a tile picked on the map — on the server (level 2). `generator.finishing`

## 2026-09-29
- **new** Generator: the Finishing step refines a world on the server (level 1); a Jobs window lists the fine simulation of your worlds, with its progress, and cancels it; the artifact window rebuilds an outdated level. `generator.jobs`
- **changed** Generator: the storage panel becomes a full-screen artifact window — this world's or all worlds' derived data, where it is kept, its levels, whether it is outdated, deletable where you may. `generator.artifacts`
- **changed** Generator: in the climate step, air pressure, water balance and watersheds are land layers, shown one at a time with the other land layers. `generator.section.land`
- **removed** Generator: the erosion step and its detail bake; the rivers, water balance and watersheds are shown in the climate step. `generator.step.climate`
- **changed** Generator: the climate refines by itself once the world is finished, and a loaded world takes its refined climate from the save. `generator.step.climate`
- **changed** Generator: the climate step's month slider gives way to a play button that runs through the months; stopping shows the year again. `generator.climate.play`
- **new** Generator: the ecology step plays the months of the seasonal resources — arable land, fish, game, pasture, salt — beside its reset button. `generator.ecology.month`
- **new** Generator: a last step, Finishing, for the detail jobs on the finished world (empty for now). `generator.step.finishing`
- **changed** Generator: the terrain colours change with height like an atlas's — green, yellow-green, khaki, ochre, brown, rock, snow — so ranges from 1300 m up stand out as mountains. `overlay.terrain`
- **changed** Generator: the map readout shows the climate class and biome under the height and the temperature as the year's span; the climate step's month slider stays in sight above its buttons. `readout`
- **changed** Generator: the climate step's washes come in three groups — land, sea, weather phenomena — one at a time within a group, combined across them; pressure, wind and currents are switches; each weather phenomenon is a layer with its own icon, and every pick group is a row of icon tiles. `generator.section`
- **fixed** Generator: "new world" in the world list starts fresh — new name and seed, default sliders, later steps locked — instead of leaving the last world open. `generator`
- **changed** Generator: once a world exists, step 0's seed and sliders are locked; the step's reset frees them and they preview on the sample world. While they differ from the world, the later steps show "out of date" and stay closed until "create world" takes the change (after asking) or the button returns to the world's values. `generator.confirm.recreate`
- **changed** Generator: the Archean's mantle and water sliders act from its next start instead of rebuilding the world. `generator.panel.genesis`

## 2026-09-28
- **dropped** Generator: the Climate step's coldest and warmest tiles. `generator.panel.climate`
- **dropped** Generator: closing the tab no longer asks first; leaving through the title bar still does. `generator`
- **changed** Generator: a step's figures and its buttons stay at the foot of the column while the sliders scroll. `generator`
- **changed** Generator: the Planet step is gone; its sliders are in the World step, with a reset of their own. `generator.action.resetPlanet`
- **changed** Generator: humidity and contrast moved from the Climate step to the World step, set before the history they shape. `generator.action.resetPlanet`
- **changed** Generator: the World step offers the ocean currents among its climate layers, and no terrain colour. `overlay.currents`
- **changed** Overlays: wind is drawn as streaks of moving air, and ocean currents as broad arrows that close into circuits around the gyres. `overlay.wind`
- **fixed** Overlays: a current is warm or cold by what it does to the sea's temperature, on the map and in the readout, not by the way it runs. `overlay.currents`

## 2026-09-22
- **new** Overlays: every group of layers the map paints one at a time starts on none of them, and can go back to none. `overlay.none`
- **changed** Rendering: coasts and lake shores are drawn where the terrain crosses the water level, so the cell staircase at zoom is gone. `overlay.rivers`

## 2026-09-20
- **changed** Overlays: the map readout reports the step's own values, not one line per switched-on layer, and says them in your language. `readout`
- **new** Overlays: the readout draws the year on the Climate step — a temperature curve and the monthly rainfall. `readout.chart`
- **fixed** Overlays: the readout's rainfall year puts the wet season where it really falls, instead of always in the local summer. `readout.chart`
- **changed** Overlays: the legend folds into a button and starts closed. `overlay.legend`
- **fixed** Overlays: the legend titles and the species names follow a language switch instead of staying English. `overlay.legend`
- **dropped** Title screen: the world map, Sphere and Mars are gone — three screens that had stopped being worked on, the map to be built again from scratch. `common.title.nav`
- **fixed** Notifications: a continent colliding, breaking up or becoming a supercontinent says so in your language. `notify.event`
- **changed** Save/Load: file sizes are counted in thousands everywhere, so a world reads the same size here as on disk.
- **fixed** Storage: the line saying how full the cache is now follows a language switch, and counts like every other size. `common.panel.storage.usage`
- **changed** Overlays: the readout says how fast the wind blows, in metres per second. `readout.metresPerSecond`
- **changed** Overlays: wind and currents in the readout are an arrow pointing where they go — no compass letters, because this world has no north. `readout.row.wind`
- **fixed** Worldmap: a world opened from a save no longer classifies its coasts from a rainfall value that was never there. `worldmap`
- **fixed** Generator: a world opened from a save no longer shows Climate and Ecology as uncomputed — the derived stages are recomputed as it arrives. `generator.step`
- **new** Generator: leaving a world that is not saved — or closing the tab — asks first. `generator`
- **changed** Generator: the save menu stays away while the world list is up. `titlebar`
- **fixed** The sign-in button and the server's save target stay away where there is nothing to sign in to. `titlebar`
- **changed** The sign-in window follows the new design: its own card on a dimmed page, with a line saying what an account is for. `signin`
- **changed** Generator: saving and opening a world live in a menu in the title bar; the floppy, the folder and the unsaved badge are gone. `titlebar`
- **changed** Generator: the title bar's name leads back to the title screen, and the world beside it is text again. `titlebar`
- **changed** The title bar carries the product's name, and says "Generator" only in the generator. `titlebar`
- **changed** The title screen stands on the same paper as the generator's own screens, in place of white. `title`
- **fixed** Generator: the map legend, the run buttons and the species names now follow a language switch. `generator`
- **changed** Generator: the Climate step shows precipitation, seasonality, monsoon, biomes, wind and currents one at a time, over the temperature it always paints. `generator.overlays`
- **changed** Generator: a step with more than three picks offers them as icon tiles instead of a list. `generator.overlays`
- **dropped** Generator: the resource layer has no legend any more — it paints one field from none to much. `generator.overlays`
- **changed** Generator: the Ecology step offers the abundance of the resource it is painting, in place of the category fold-out. `generator.step`
- **changed** Generator: the Ecology step's levers and its abundance nudges moved into the sidebar. `generator.step`
- **changed** Generator: the Erosion step's levers, its run button and the detail bake moved into the sidebar. `generator.step`
- **changed** Generator: the Climate step's levers and its min/max readout moved into the sidebar. `generator.step`
- **fixed** Safari: the generator's workers no longer fail on a reload, which left the map white. `generator`
- **changed** Generator: the overlay bar over the map is gone; every step offers its own layers in the sidebar, and a layer may belong to several steps. `generator.overlays`
- **fixed** Generator: Tectonics now lists the mantle, the plumes and the volcanoes it was already showing. `generator.overlays`
- **fixed** Generator: running the Archean no longer marks plate tectonics as computed, nor opens the climate step early. `generator.step`
- **new** Generator: a step is blocked until the step before it has done enough — the world must be created, and the Archean must be half stabilised. `generator.step`
- **new** Generator: the sidebar lists the current step's overlays as switches. `generator.overlays`
- **changed** Generator: the Genesis and Tectonics steps moved from the panel row at the foot into the sidebar, with their parameters, their counts and their run buttons. `generator.step`

## 2026-09-19
- **fixed** Generator: switching the language now also changes the load screen, the step bar, the sidebar and step 0, not the title bar alone. `generator`
- **new** Generator: a column along the left names the step you are on and says what it does; the map gives up the width rather than being covered. `generator.step`
- **new** Generator: a step 0 where a world gets its name, its seed and its shape before anything is simulated. `generator.world`
- **changed** Generator: the ‹ › arrows give way to a step bar along the foot, naming every step and which of them have been computed. `generator.step`
- **changed** Layout: the world's name in the title bar leads back to the list of worlds. `titlebar.world`
- **new** Generator: it opens on a list of worlds — those this browser keeps and those on the server together — where one can be opened, removed, uploaded from a file, or a new one started. `generator.load`
- **new** Save/Load: a world can be kept in the browser itself, beside storing it on the server and downloading it. `titlebar.save.browser`
- **new** Layout: one title bar across the top of every screen — which world is open, where it was last saved, the language, and who is signed in. The title screen's flag buttons give way to it. `titlebar`

## 2026-08-17
- **changed** Map: rivers end at the open lakes they feed, whose shores are drawn in the same pen the rivers are — one ink line from river to shore ring to outflow; across frozen lakes the rivers keep flowing. `worldmap`
- **changed** Map: rivers appear by size — the far view shows only the major rivers, and tributaries grow out of their trunks on the way down. `worldmap`

## 2026-08-14
- **changed** Map: the near view's terrain knows where the rivers are — valleys open toward the water, floodplains lie flat, and crests read as crests. `worldmap`

## 2026-08-13
- **new** Map: the 300 m hex grid knows which tile the pointer is over — the hovered hex lights up once the grid is fully visible in the descent. `worldmap`
- **changed** Title: the menu is localized and links to the documentation site, where the changelog now lives.

## 2026-08-12
- **changed** Title: the title screen wears its artwork along the bottom edge, with the menu reaching left from the screen's center; the changelog left the screen and will return as its own page.
- **fixed** Storage: leftovers from an older storage layout appear as their own deletable entry instead of haunting the total as bytes nothing lists. `common.panel.storage`
- **changed** Storage: the storage window groups artifacts per world, one line per terrain state and algorithm version — what used to read as duplicate 4K chips is now told apart; local and server render alike, and the footer button says plainly that it deletes local data. `common.panel.storage`
- **new** Load: every world lists its seed, UID, checksum and the build that wrote it, and can be deleted — the button arms on the first click and acts on the second. `common.panel.load`
- **changed** Save: the save window shows what is about to be written (seed, UID, revision) beside what the server already holds. `common.panel.save`

## 2026-08-11
- **changed** Map: rivers draw as dark ink lines on the paper map and turn to water blue through the descent. `worldmap`
- **fixed** Map: rivers in the descent view ride the near-field detail terrain instead of tunnelling under its bumps. `worldmap`
- **new** Map: lakes appear on the worldmap — depth-shaded in the paper's own water blue, with a drying rim like the coast's. `worldmap`
- **new** Map: a loaded world shows its rivers right away — the macro network is derived from the save at load instead of waiting for the first bake. `worldmap`
- **changed** Rendering: river widths now follow zoom continuously — a screen-constant map line handing over to the river's physical width on descent — instead of stepped profiles that let thin rivers vanish at middle zoom.
- **fixed** Rendering: river ribbons in the generator now rise with the exaggerated relief instead of sinking inside it at relief zoom. `worldgen`
- **fixed** Map: thin rivers no longer drop out at middle zoom — the watercolour pass had cost the scene its antialiasing. `worldmap`
- **changed** Rendering: the generator's relief uses the map's 6x vertical exaggeration, so terrain is tuned at the scale the map shows. `worldgen`
- **fixed** Map: a server that missed one 3-second probe at page load no longer makes the map bake stages the server already holds — the verdict is re-checked instead of sticking for the whole session. `worldmap`
- **fixed** Map: a bake already running on the server for this world is now followed — progress toast and all — instead of the map silently computing the same stage a second time. `worldmap`
- **changed** Erosion: 4K/8K select instead of start — a new bake button runs every selected resolution in turn, once the world has had an erosion pass; 16K is shown as coming. `worldgen.panel.erosion`

## 2026-08-09
- **changed** Bake: waiting for a machine and running on one are now two notifications — the second says where the work is happening, with the cluster's own mark when it is a Kubernetes Job.
- **new** Server: a badge on the server indicator when a sign-in is missing; clicking it opens the sign-in window, which also says who is signed in. `common.panel.signIn`
- **fixed** Load: a world list that could not be read no longer claims the server is empty, and an open that fails says so instead of looking like a click that did not register. `common.panel.load.unavailable`
- **fixed** Load: world previews appear again on a server that requires a sign-in — an image the browser fetches on its own carries no credentials. `common.panel.load`
- **fixed** Server: losing a session mid-work now says so once, instead of surfacing as a save that failed and a list that came back empty. `common.notify.signedOut`
- **changed** Storage: with no sign-in the client works exactly as it does with no server — worlds stay local and a 4K bake runs in this browser instead of failing. `common.server.loggedOut`
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
