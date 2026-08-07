---
summary: Design for the 3D world view — a zoomable camera over the map, hex tiles only where land is developed, and edge "ports" as the contract between hexes and everything linear (rivers, roads, shorelines). The camera ladder down to the hex-scale descent view is BUILT (see the status section); tiles/ports/settlements remain design.
date: 2026-08-06
status: partially built (worldmap screen through the descent view, 2026-08-07) — hex/port/settlement layers still design-only
---

# Hex World View — Idea Sketch

Captures a design discussion about turning the game screen (to be renamed
"World") into a 3D view of a small cut-out of the world: a camera that
starts in a 2D-ish map mode and zooms down to near-ground level where the
world is rendered as hex tiles built on the fly from the existing data.
Everything below is a direction we liked, not a decision.

## Hex size: ~300 m flat-to-flat

Three independent constraints land on roughly the same number:

- **1/26 of a macro cell.** The quarter-Earth map runs at 7.8 km per
  raster cell (see [resolution-strategy.md](./resolution-strategy.md)),
  so 300 m divides it cleanly — one macro cell refines into a ~26×26 hex
  chunk, which lines up with the existing on-demand refinement direction
  (micro-tile prototype).
- **One hex ≈ 7.8 ha ≈ one historical Hufe** — the land one farmstead
  needs. "A farm is one tile" becomes nearly literal: the tile *is* the
  farm including its fields.
- **Rivers and roads fit.** Almost all real rivers are narrower than
  300 m, so one tile per river holds, and a road beside a river on the
  same tile is physically plausible (tile contents modelled as layers /
  slots — terrain + water + infrastructure + use — not "one thing per
  tile").

Global tile count at this size is ~1.6 billion — irrelevant, because
hexes only ever materialise as chunks near the camera; the rest of the
world stays macro raster.

## The core idea: the grid is the image of civilisation

Instead of hexifying all terrain (which turns nice valleys into
staircases), **only developed/claimed land becomes visible hex tiles** —
flattened plates with edges. Wilderness stays organic terrain rendered
straight from the heightfield, no averaged heights, no rounded hex
edges, no grid.

- The hex grid still exists *logically* everywhere (pathfinding,
  adjacency, "clear that forest tile") — only the visual hexification is
  gated on development.
- Developing a tile fixes a canonical height (median of the tile's fine
  relief) and turns it into a flat plate. Seams between developed
  neighbours get small blended steps; the seam against wilderness is
  celebrated rather than hidden: embankments, dry-stone walls, terrace
  edges — hillside development reads as terraced fields for free.
- Developability is graded, not binary: plains are cheap, forest needs
  clearing, swamp draining, hills terracing; steep rock and river tiles
  are never developable. Usable land becomes a scarce, *visible*
  resource, and the realistic worldgen pays directly into gameplay —
  floodplains are valuable because they earned it geologically.
- Two rules to pin early: **contiguity** (develop only adjacent to
  already-developed land or a settlement core — no lone plates in the
  mountains that read as render bugs) and **rewilding** (abandoned tiles
  decay back to wilderness over time — ruined terraces of a fallen line
  are pure wordless storytelling).

This doubles as the game's visual language: wilderness = organic
geometry, civilisation = imposed order. The vision docs want ideology
shown, never stated — a settlement eating into a wild valley floor as a
growing hex carpet *is* that statement.

## Ports: how linear features escape the grid

Rivers and paths shouldn't bend to the hex. Solution: **ports** — fixed
connection points on hex edges (model-railway / Townscaper style).

- **2 ports per edge**, at ⅓ and ⅔ (never at corners — three tiles meet
  there and the connection logic gets ambiguous). At 300 m hexes that's
  ~58 m apart: enough for a river and a road to pass the same edge side
  by side.
- **Ports belong to the edge, shared by both neighbours**, plus a
  tangent rule (curves cross the port perpendicular to the edge). Any
  tile interior can then be generated as an independent spline between
  its ports without knowing its neighbours, and nothing ever kinks at a
  seam — the property that makes on-the-fly chunk generation work.
- **Reservation, not stacking.** Rivers claim ports at worldgen time
  (they exist long before roads); roads take free ports. Wide rivers
  claim both ports of an edge. A road *crossing* a river is not a port
  conflict but an explicit structure (ford/bridge); road meeting a river
  port = jetty/harbour candidate. Port occupancy becomes gameplay
  grammar.
- **D8 gives the topology for free**: every river tile has n in-ports
  and at most one out-port, so confluences are "two splines merge into
  one" straight out of the existing routing.
- An optional **centre node** per tile (segments run port→centre) makes
  crossroads, village squares, and dead ends trivial.
- **Two rendering registers**: in wilderness the spline gets
  deterministic jitter from the tile seed (mule track meanders, stream
  follows the fine relief); on developed tiles it goes geometric (the
  built road ignores the terrain because it has subjugated it). Path
  upgrade = register switch: organic trail → surveyed road. Explicitly
  liked in the discussion: an upgraded road through wilderness develops
  its own tiles — a geometric band cutting through organic terrain, very
  visible, very Roman road. The more powerful the civilisation, the more
  geometry in the picture.
- In pure wilderness the ports are carried as metadata only (the river
  ribbon still comes from the fine hydrology raster); they become
  binding where geometry meets geometry — at the edge of developed
  plates and for anything built. When a tile beside a river is
  developed, the shared-edge port + width attribute is the seam
  contract: the plate is built exactly up to it.

## Shorelines: the same architecture, data-driven

Lake and coast tiles use the same edge-anchored idea, with one twist:
what crosses the edge is the *waterline* (the boundary of an areal
feature), and its crossing point is **computed, not reserved** — classic
marching-hexagons contour extraction. Interpolate where the fine relief
crosses the lake/sea level along each edge; both neighbours derive the
same point from the same shared data, so seams are tight by
construction (snapping shores to the discrete ⅓/⅔ slots would visibly
quantise coastlines).

- Corner classification gives three tile states: water / land / **shore
  tile** (mixed). A shore tile carries its edge crossings, connects them
  into the shore curve, and knows its land fraction (= how much of it is
  buildable). Shore tiles stay part-developable: flatten the land side,
  the water side stays water — shores become the scarcest, most
  interesting building ground, which is historically honest.
- The two registers shine here: wild shore = contour following the fine
  relief with reed bands and beaches (the riparian biome already
  exists); developed shore = the waterline between the edge crossings
  goes straight — a quay wall. Civilisation literally straightens the
  coast, same mechanism as roads.
- Composition falls out: river out-port ending at the shore contour =
  mouth; road ending at a shore-tile port = dock; developed shore tile
  with a centre node = harbour.
- Because the contour is *derived* from relief + water level rather than
  stored, variable water levels (dams, droughts) cost nothing extra:
  reclassify, re-interpolate. Ocean coasts are the identical system with
  the level at sea level.
- Water bodies entirely inside one tile (ponds, no edge crossing) are a
  decorative in-tile feature, no ports needed.

## Settlements: two axes, not one ladder

- **Physical size** (emergent, in tiles): Hof = 1 tile (one Hufe);
  Dorf = 1 core tile + surrounding field tiles as visible hinterland;
  Stadt ≈ 5–30 (medieval Cologne ≈ 50); Metropole ≈ 50–500 (Rome inside
  the Aurelian walls ≈ 180); Supermetropole = 500+ (near-region scale,
  late/endgame if at all).
- **Role/status** (conferred, orthogonal): regional hub, capital,
  imperial capital; possibly specialisations (port, mining town, temple
  city). Deriving role from size loses the interesting cases — tiny
  capitals, politically irrelevant giant trade hubs — and moving a
  capital is free dynastic drama.

## Camera / rendering: a three-step LOD ladder

1. **Far (map mode):** the existing 2D compositor texture, optionally on
   a slightly displaced plane for light relief when the camera tilts.
2. **Mid:** coarse heightmap chunks straight from the macro raster, no
   grid.
3. **Near:** wilderness stays the full-resolution terrain mesh (no
   representation switch at all — the hardest transition got easier);
   developed areas show their plates, edges, and grid, generated on
   demand per chunk and cached.

Crucial craft point: steps 2 and 3 must sample the *same* height source
(macro raster + the same deterministic fine detail as the micro-tile
work), or the landscape pops at the transition. The torus is a non-issue
here: near the ground the camera only sees local chunks, wrap is modulo
on chunk coordinates.

## First milestone: a wilderness cutout viewer

*(Built and then some — see "Status 2026-08-07" below. Kept as the
reasoning that shaped it.)*

Follow-up from the same discussion: is the above roughly enough to render
a small cutout of a saved world in 3D? Yes — and the first milestone is
*smaller* than the doc suggests:

- **Own Babylon screen** (the game screen, to be renamed "World") that
  loads a world `.zip` — no live worldgen session required. The
  [queryable save](../decisions/queryable-world-save.md) is already the
  designed interface for exactly this consumer: manifest + baked layers
  (full-res elevation `f32`, biome, lakeDepth, rivers vector), readable
  with a ~50-line sampler and zero generator knowledge. `state.json` is
  additionally available if the fine field is queried live.
- **A fresh world has no developed land** — so the milestone needs *no*
  hexes, no ports, no plates. It is terrain mesh + water surfaces +
  river ribbons + biome colouring, i.e. pure wilderness rendering (LOD
  steps 2–3 without the developed-land layer). The entire hex/port
  machinery only becomes real once the first tile is developed.
- **Pipeline prerequisite:** the world must have run through at least
  hydrology. Compute-on-save already guarantees a processed world bakes
  everything, and the manifest honestly lists what exists — so the
  screen gates on "manifest contains lakeDepth + rivers", not on trust.

The genuine gaps — what the doc above does *not* yet pin down:

1. **One shared fine-height sampler.** Final terrain = eroded macro
   raster (grid-locked) + resolution-free fine detail (the 20 m
   micro-relief lives physically in `computeElevation`). The micro-tile
   refinement already performs exactly this composition; the 3D chunk
   mesher must consume the *same* sampler, not reimplement it — this is
   the load-bearing seam and deserves its own decision when built.
2. **Water surfaces.** Largely settled by *reuse* (2026-08-07): the
   river vector layer already carries a per-point width — the 2D ribbons
   render from it (`ToroidalRibbonOverlay`) — so 3D ribbons consume the
   same data: render truth, no second formula. Lake surface = per-lake
   constant, computed once at load from terrain + lakeDepth (median over
   the lake's cells for robustness); worth baking per-lake surface
   elevations into the save later. Sea level is the anchor constant.
3. **Terrain tessellation.** The third place that needs real numbers,
   distinct from the sampler (#1 answers *what height is here*,
   tessellation answers *where vertices go*): chunked quadtree LOD —
   chunks of ~128×128 quads, per-ring vertex spacing chosen so the
   projected cell stays around 1–2 px screen-space error, skirts hiding
   cracks between rings. The fine sampler (#1) only kicks in once
   spacing drops below a few hundred metres; coarser rings read the
   macro raster alone; the far end of the ladder stays the map texture,
   not geometry.
4. **Cutout selection — decided (2026-08-07): none.** The World screen
   loads the whole map; the "cutout" is simply wherever the camera
   flies. No picker logic.
5. **Vertical scale — decided (2026-08-07): 1:1, metre-true** for the
   World screen's near-ground view. Amended same day after eyeballing:
   the *worldgen relief preview* runs a mild 2× exaggeration
   (`RELIEF_EXAGGERATION`) — at its 500–1500 km view widths metre-true
   relief is a few pixels tall and doesn't register. A map register may
   exaggerate; the game world does not.

### Relief preview inside the worldgen screen?

Liked in the follow-up discussion: the mid-LOD (displaced heightmap
from the macro raster, no fine detail, zoom capped) could ship *inside
the worldgen screen* first, gated post-erosion like the other derived
panels (`erosionRunCount >= 1`). Concretised 2026-08-07 after reading
the actual code:

- **One camera per screen, no camera switch.** `orbitSwoopCamera` is
  the sphere screen's rig; the flat screen's `hexMapCamera`
  (orthographic, top-down) is the one to extend — tilted orthographic
  reads as a clean axonometric strategy view, and it already has an
  unused, focus-preserving `setTilt` (built for a since-removed debug
  3D preview). The later World screen gets its own perspective rig;
  worldgen never mixes projections.
- **Tilt is zoom-coupled via an envelope, not a mode.** Applied tilt =
  `min(desiredTilt, maxTiltForZoom(zoom))`, with the envelope 0 below
  ~half zoom and ramping to ~50° at full zoom, eased per frame. Zooming
  out then *automatically* presses the camera back to top-down — the
  "rotate back on zoom-out" behaviour falls out of the clamp, no
  special-case animation. `desiredTilt` is remembered so zooming back
  in restores the view. Yaw stays out of v1 (would need a look at the
  3×3 tiling margins).
- **Deepen the zoom for 1:1 to read at all.** Scale check: the world is
  16,000 × 8,000 km (20 × 10 scene units — 1 unit = 800 km; 9,000 m of
  relief = 0.011 units). Today's max zoom shows 10 % of the world
  (~1,600 km across, ~1 px/km): metre-true relief would be single-digit
  pixels — invisible. At `maxZoomWorldFraction ≈ 0.03` (~500 km view)
  ranges become 10–30 px silhouettes and 1:1 genuinely reads. Texture
  side effect: ~64 macro texels across the screen at that zoom — either
  accept the blur in v1 or enable the existing render-only
  `erosionDetailTexture` (off by default) at deep zoom.
- **Mesh v1 = CPU displacement of one shared geometry.** Subdivide the
  map ground (start ~1024×512; all 3×3 torus tiles share the vertex
  buffer, so one displacement pass updates all copies), write vertex Y
  from the eroded elevation raster after each erosion/hydrology pass.
  Static between passes; no shader, no chunks, no LOD, no fine sampler
  — deliberately, since worldgen never gets close enough to need them.
- **Known bite: draping.** River ribbons (and anything else at y ≈ 0,
  e.g. volcano cones) float or z-fight once the ground displaces —
  drape ribbon vertices by sampling the same raster + a small offset.
  Lake/overlay tints live in the map texture and are unaffected.
- The hillshade baked into the map texture doubles as fake lighting —
  keep the material unlit; silhouettes + baked shade carry the depth.

Bonus: this piece is worldgen-screen work, i.e. in scope for the
current worldgen branch.

### Water rendering in Babylon (notes)

The ready-made piece is `WaterMaterial` from `@babylonjs/materials`:
reflection + refraction via two render targets, animated bump,
wind/wave parameters — right for ocean and large lakes, but each
material costs extra scene renders, so share one material and disable
reflection for small lakes. Rivers should *not* use it — they are
ribbon meshes; a small custom/node-material shader (flow along the
ribbon, depth tint, foam at banks) is the right scale. From the mostly
top-down camera, reflections are barely visible anyway — cheap
animated-normal-map water is a fine v1. Depth-based shore tinting
(shallow → deep) can read scene depth instead of touching geometry.

## Status 2026-08-07: what exists now

The camera/terrain ladder is built, in the WORLDMAP screen ("Herederos del
Mundo", `screens/worldmap/` — the renamed game screen, reachable from the
title). It loads a saved world through the QUERYABLE side of the save
(manifest + baked layers, no generator worker), and one continuous zoom
axis now runs:

1. **Flat paper map** (ortho, exponential zoom) — identical rendering to
   the generator via shared modules (`reliefShade`, `paperBase`,
   `mapSceneSettings`, chrome CSS under `.map-chrome`).
2. **Lit 3D relief** (two mesh LODs, camera-relative sun on an unshaded
   texture, tilt/yaw envelopes, WASD/Q-E) — shared with the generator's
   preview; 2× vertical exaggeration in this map register (the 1:1
   decision holds for the eventual ground-level game view).
3. **Perspective descent** past the deepest map zoom: same camera flips
   projection with framing matched at the focus, wheel steers altitude
   down to ~2.5 km, pitch curve 60→76° with R/F freedom (40–80°),
   gradient sky (compact deep-blue horizon band), fog = horizon color,
   sun blends to world-fixed, altitude readout in the panel.
4. **300 m hex grid** fading in below ~40 km altitude — a fragment-shader
   material plugin (Voronoi of two interleaved lattices, spacings snapped
   to tile the torus exactly), near-field distance fade against moiré,
   toggle button in the panel. This is the LOGICAL grid made visible;
   tiles still have no identity or contents.
5. **Near-field detail patch** — one camera-following high-res grid fed by
   `fineElevationSurface`: raster bilinear + a fractal cascade of
   worldgen's own periodic detail noise down to ~300 m wavelengths,
   slope-conditioned amplitude (≤240 m), slope-darkening vertex-color
   micro-albedo. First cut of the shared fine-height seam; cosmetic
   synthesis, not hydrology-true refinement (rivers don't carve yet), and
   seeded from the save's seed string rather than the generator's
   warpSeed until the manifest carries it.

Still design-only from the sections above: everything hex-as-*tiles* —
development/flattening, ports, shorelines-as-contract, settlements — plus
river ribbons in the worldmap, biome-based coloring (the planned real
answer to terrain readability), and the eventual ground-level game camera
(a later MODE of the same rig, not a second camera object).

## Open questions

- Exact hex size (250–350 m band; 300 m is the sweet spot candidate).
- Whether rivers might warrant edge-based representation instead of
  through-tile — through-tile fits the D8 pipeline and is realistic at
  300 m, but this is the one hard-to-reverse choice in the port design.
- Thresholds/costs for the developability grades, and rewilding pace.
- Where exactly the "path organic vs. road geometric" upgrade boundary
  sits.
