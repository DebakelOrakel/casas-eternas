---
id: DES-0026
title.en: A second engine — worlds made procedurally, with the same layers
title.de: Eine zweite Engine — Welten prozedural erschaffen, mit denselben Layern
summary.en: Idea sketch: a second way to make a world that skips the simulated Archean and
  plate tectonics. It lays out plates first, gives some of them continental
  crust by noise, derives the boundary types from the plates' motions, raises
  ranges, trenches, ridges and rifts along them, invents the history the
  later stages read (ocean age, craton age, old sutures), and lets the
  existing mesh erosion cut the valleys and rivers. Its world carries the
  same layers as a simulated one after the tectonics step, so every later
  step runs on it unchanged. Steps that shape a world on purpose (islands,
  inland seas, bays) fit it naturally. The simulated generator stays.
summary.de: Ideenskizze: eine zweite Art, eine Welt zu erschaffen, die das simulierte
  Archaikum und die Plattentektonik überspringt. Sie legt zuerst Platten an,
  gibt einem Teil davon per Noise kontinentale Kruste, leitet die Grenztypen
  aus der Plattenbewegung ab, setzt Gebirge, Gräben, Rücken und Rifts daran,
  erfindet die Geschichte, die spätere Stufen lesen (Ozeanalter, Kratonalter,
  alte Nähte), und lässt die vorhandene Netz-Erosion Täler und Flüsse
  schneiden. Ihre Welt trägt dieselben Layer wie eine simulierte nach dem
  Tektonik-Schritt, so dass alle späteren Schritte unverändert darauf laufen.
  Schritte, die eine Welt gezielt formen (Inseln, Binnenmeere, Buchten),
  passen gut dazu. Der simulierte Generator bleibt.
area: generator
stage: idea
createdAt: 2026-10-12
updatedAt: 2026-10-12
related: [DEC-0036, DEC-0035, DEC-0029, DES-0017]
---

Records a conversation (2026-10-12), during the calibration after
[fields-on-meshes.md](../decisions/fields-on-meshes.md) (DEC-0036).

## What it is, and what it is not

A **second way to make a world**, beside the simulated one. The simulated
generator (the Archean, the plates, the coupled history) stays and stays
the main path; this engine does not replace it and does not feed it.

- The procedural world is **finished at the tectonics step**: it has its
  terrain and the history the later stages read, and nothing goes on
  simulating its plates. Steps 1 and 2 are done for it (shown as set, as a
  loaded world without a hand-over shows them).
- It carries **the same layers** a simulated world has after the
  tectonics step, so the climate, the hydrology, the biomes, the ecology
  and the finishing step run on it unchanged, and a reader of its save
  sees a world like any other.
- It does **not** need the simulation's inner state: no mantle, no rafts,
  no detection lattice, no plate snapshot to continue from.

## The building blocks

1. **Plates first, land second.** Voronoi plates over the Domain with a
   motion each (EulerMotion on the sphere, RigidMotion on the torus — both
   exist). Then some plates, or parts of them, get continental crust by
   domain-warped noise, brought to the target land share. In the other
   order (land by noise, plates laid over it independently) the coasts and
   the ranges do not belong to each other; plates first gives, for
   example, an Andes where an ocean plate meets a continent.
2. **Boundary types from the relative motion** — convergent, divergent,
   transform, as the plates' boundary detection already classifies them:
   - ocean–continent convergence: trench, coastal range, volcanic arc;
   - continent–continent: a broad high plateau and range (Himalaya class);
   - ocean–ocean convergence: trench and island arc;
   - divergent at sea: a mid-ocean ridge; on land: a rift with grabens and
     rift lakes;
   - transform: offset ridges, little relief.
   Ranges are ridged noise along the distance to the boundary, with the
   range and trench profiles the elevation already has.
3. **The history, invented rather than simulated:**
   - **ocean age** = distance from the ridge ÷ spreading speed, so the
     ocean depth follows GDH1 as it does today;
   - **craton age**: old in a continent's interior, younger toward its
     margins (what the iron and other resources read);
   - **old, worn ranges** (Appalachian class) as weak ridge lines along
     "fossil" sutures inside the continents;
   - hotspot chains: a few plumes, with their trails along the plates'
     motion.
4. **Valleys and rivers — real, not faked.** The invented landscape goes
   onto the adaptive terrain mesh, and the existing mesh erosion runs a
   number of epochs over it, without tectonics. That cuts real valleys,
   river networks and lakes, and deposits sediment — the part where
   procedural generators usually fall short is the part this project
   already has.
5. **Everything after it unchanged**: the climate, the hydrology, the
   biomes, the ecology, the finishing step read only the terrain and the
   invented history.

## Steps that shape the world on purpose

A procedural world invites steps the simulation cannot offer, because the
world is laid out rather than grown:

- **sprinkling islands**: archipelagos, volcanic island chains along a
  hotspot trail or an arc;
- **forcing fragments**: an inland sea, a bay, a strait, a peninsula, a
  rift valley, a high plateau — placed or requested, then fitted into the
  plate layout so they still have a cause;
- **continents by request**: one supercontinent, a scatter of islands, two
  hemispheres of land and sea.

They act on the layout before the erosion runs, so the erosion makes them
look grown.

## What it needs from the rest

- **Terrain without a simulation.** Today the terrain mesh's baseline is
  computed from the plates' rafts (`solidBaselineAt`). A procedural world
  has no rafts: the terrain needs a form whose baseline is stored or zero,
  instead of faked rafts. The same form would help a loaded world.
- **The save.** The same format; `world.yaml` names the engine (e.g.
  `engine: procedural`), and the engine enters the world id's hash. Its
  save holds the layers a simulated world has, without `mantle.f64`,
  `state.json` and the lattice.
- **The screen.** Where a world is made ("Create new world"), a choice of
  engine, as the shape is chosen today; steps 1 and 2 shown as done.
- **New i18n keys and spec fields** — to be proposed before they are
  built.

## For it

- **Speed**: a world in seconds instead of minutes — previews, a quick
  start in the game, test worlds for the tiles later.
- **Controlled worlds for calibration**: "one supercontinent", "an island
  world", "a range at the pole" — the climate and the hydrology can be
  calibrated on worlds whose layout is known, without the simulation's
  chance.
- **A comparison**: where a simulated world looks wrong, a procedural one
  shows whether the terrain or the chain after it is the cause.

## Against it, what to watch

- **The look**: noise continents tend to be blobs. Plates first and a
  strong domain warp help; they rarely match a grown world.
- **Two ways to make a world** are two ways to test; the later steps must
  not start to depend on which one made the world.
- **The invented history must be consistent with the terrain** (old ocean
  floor deep, young ridges shallow, ranges where plates converge), or the
  later stages read a contradiction.

## Open questions

- Which parameters does the engine expose (plate count, land share,
  roughness, number of old sutures, …), and which of them are shared with
  the simulated path?
- How many erosion epochs make it look grown, and at what cost?
- Do the shaping steps (islands, fragments) belong to this engine only, or
  could the simulated path take some of them after its history?
- Continent names: the simulated path names rafts; the procedural one
  names its continents directly.

## Status

2026-10-12: IDEA — recorded on the user's request; to be built after the
calibration (DEC-0036 phase 8), if at all.
