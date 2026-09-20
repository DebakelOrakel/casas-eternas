---
summary: Design for the 3D world view — a zoomable camera over the map, hex tiles only where land is developed, and edge "ports" as the contract between hexes and everything linear (rivers, roads, shorelines). The camera ladder down to the hex-scale descent view is BUILT (see the status section); tiles/ports/settlements remain design.
date: 2026-08-06
updated: 2026-08-15
area: ui
stage: building
status: partially built (worldmap screen through the descent view, 2026-08-07) — hex/port/settlement layers still design-only; unifying the two screens' map decided 2026-08-09, not built; the three foundational forks (river-through-tile, 300 m final, continuous zoom with thresholds) decided 2026-08-13 → decisions/hex-tiling.md, staged build plan below
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
   World screen's near-ground view; a *map* register may exaggerate.
   Revised twice the same day as it was actually looked at. First a flat
   2× everywhere, then — once mountains still read as bulges — the
   realisation that the constant was the wrong shape: at the map's
   ~480 km view width a 6.4 km peak covers 2.7 % of the frame (~43 px)
   whatever the terrain does, because that is how a mountain looks from
   480 km up. So exaggeration became a property of the VIEW rather than
   of the heights: surfaces are metre-true and the meshes carry a
   vertical scale that follows the register — `MAP_EXAGGERATION` 6 on the
   map, interpolating to `NEAR_EXAGGERATION` 1 through the descent, so
   the exaggeration fades out exactly where the map becomes a world. The
   generator's own preview sits at 3 (a working view, not a
   presentation).

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

The near-field patch's noise synthesis is explicitly an interim answer:
the DECIDED path to real fine terrain is the one-time 8k amplification
bake at load (upsample + seed roughness + real erosion + re-run
hydrology) — see
[worldmap-amplification.md](../decisions/worldmap-amplification.md) for
the decision, the authority rules and the staged ladder around it.

## The build plan (2026-08-13)

Agreed once the three foundational forks were decided (hex size, river
representation, zoom model — see
[decisions/hex-tiling.md](../decisions/hex-tiling.md)). Phases, in order:

1. **The logical grid** (data, no visuals). A pure math module: world
   position ↔ axial hex coordinate (torus modulo), corners/edges/
   neighbours, shared edge identities, the ⅓/⅔ port slots — derived from
   `mapSceneSettings`' torus-snapped constants, never restated. Layering:
   the lattice math is world-agnostic (peer level); tile *contents* are
   world-layer when they exist. First visible payoff: hover-highlight of
   the hex under the cursor in the descent view (a uniform in the
   existing grid plugin), proving the logical and painted grids coincide.
   *(BUILT 2026-08-13: `map/hexGrid.ts` on honeycomb-grid, verified
   against the shader lattice over 200k points; highlight wired. Known
   residual: the CPU pick is close but not pixel-perfect against the
   rendered fragment — if it ever matters, the escalation is GPU picking,
   tile identity rendered to an offscreen target and read under the
   cursor.)*
2. **Tile classification** (derived, cached, chunk-wise near the
   camera). Per hex: median height, slope, biome, water state
   (land/water/shore via corner classification), river presence — from
   which the graded developability falls out. Must sample THE shared
   fine-height source (`fineElevationSurface`), or later plates will
   float above the terrain. Debug overlay for eyeballing, deliberately
   changelog-free.
   *(BUILT 2026-08-13 except rivers, eyeballed OK the same day:
   `map/hexTiles.ts` classifies over the truth fine surface (bias 0) +
   lake layer + painted biome, with PROVISIONAL grade constants — the
   thresholds stay an open question. Visible as a hover readout line and
   a tile-tint overlay ("classes" toggle) in the debug panel, filled
   ~600 tiles/frame around the camera. River presence deliberately waits
   for phase 3, where the polyline→port mapping identifies river tiles
   exactly instead of a second distance test here. Two traps cost a
   round each and are worth remembering: world→mesh-UV is v = z/H + 0.5
   — CreateGround's own vertex data, NOT watercolorPass' flipped
   knowledge-texture frame — and material-plugin SAMPLERS must be
   declared in CUSTOM_FRAGMENT_DEFINITIONS, because the
   getUniforms().fragment block is not injected on UBO engines and the
   effect then silently never compiles.)*
3. **Ports v1 as metadata.** Snap the amplified river polylines onto
   edge ports (wide rivers claim both slots of an edge); compute shore
   crossings marching-hex style from relief + water level. All derived
   and deterministic, never serialized — the same authority rule as the
   amplification bake.
   *(BUILT 2026-08-13: `map/hexPorts.ts`. Rivers RESERVE — the polyline
   is walked across the grid (points sit ~2 km apart, tiles are 300 m,
   so every transition is found by bisection rather than by testing
   endpoints), each crossing claims the nearer slot, and downstream
   order gives in/out for free. Shorelines COMPUTE — marching hexagons
   over the six corner heights. The "at most one out-port" property is
   counted, not asserted: a river meandering back through a 300 m tile
   legitimately leaves twice. Windowed around the camera, so the world's
   ~100,000 km of channel never has to be resident. Visible in the debug
   readout (`river 1in/1out 1 slot`, `waterline 1`) and as a river tint
   in the class overlay. Two contract requirements found by measurement
   and now documented at the function: the shore sampler must be
   UNCLAMPED — the render surfaces flatten the sea to zero, which
   collapses every crossing onto a corner (`createElevationSurface`
   grew a `clampAtSeaLevel` flag for it) — and it must be PERIODIC,
   because corners are sampled in the tile's principal frame.)*
4. **First real plates.** A debug "develop this hex" click: the tile
   freezes its canonical height (median of its fine relief), becomes a
   flat plate with edge seams (embankment against wilderness), the
   contiguity rule active. The "grid = civilisation" visual language
   stands in the picture for the first time.
   *(BUILT 2026-08-14: `map/hexPlates.ts` holds the rules and the state
   — free of Babylon so the rules are checked headless — and
   `map/hexPlateLayer.ts` turns them into geometry: a flat hexagon per
   plate plus a skirt on every edge, down to the neighbouring plate's
   height or to the lowest ground along that edge. Only the higher of
   two plates draws their shared wall, or the pair z-fights along every
   seam. Development is GAME state: session-only, never saved, never
   hashed. The canonical height is NOT the median this document asks
   for, and the reason is worth keeping: nothing cuts the terrain, so a
   plate at the median leaves the uphill half of its own tile poking
   through it (seen immediately, 2026-08-14). The plate therefore sits
   at the tile's HIGHEST sampled point, which covers its ground and
   makes the skirt read as a terrace's retaining wall. Measured cost on
   ground that may actually be developed — steep tiles are refused
   anyway — median 0.2 m, p90 0.5 m, worst case 19.8 m of extra step on
   a 300 m frontage. Cutting the terrain properly stays the honest fix
   and wants its own step: the near-field patch cannot express a hex
   boundary at ~200 m vertex spacing, so it would need a real
   plate-aware mesher.)*
   **REMOVED 2026-08-15.** That own step was taken (the hex lattice under
   the near-field plan's step 2), the cutting worked, and it made no
   difference anyone could see — for the reason the 0.2 m above already
   stated. `hexPlates`, `hexPlateLayer`, the develop click and the
   panel's develop/clear buttons are gone; the tile CLASSIFICATION stays,
   because it answers a real question ("what is this ground") that does
   not depend on how development is drawn. The phase itself is not
   cancelled, it is reopened: what a developed tile LOOKS like is now an
   open question rather than a settled plate, see below.
5. **Game systems** (settlement axes, rewilding, costs) — NOT SCHEDULED
   (2026-08-14). It is game mechanics, and the world around it has to
   read right first; the game design material lives outside the
   repository anyway. Everything above it is world-building and stands
   on its own.

The natural work after phase 4 is therefore not phase 5 but the open
questions below — the coastal basins first, since that one is a
correctness question rather than a tuning one.

## The near-field plan (agreed 2026-08-14)

Phase 4 exposed that the near view underwhelms for measurable reasons:
below ~2 km there is no real data (the cascade is unorganised noise),
developable land is flat by selection (nothing to level), and the grid
is a shader over terrain rather than geometry anything could follow.
Three steps, in order, decided together with their forks:

1. **Hydrology-aware synthesis** (`fineElevationSurface` v2 — the
   skipped step 1 of the amplification ladder). A per-tier
   distance-to-channel field rasterised from the river polylines
   (4096×2048 u8, chamfer, derived-never-serialized) feeds three
   ingredients: an ANALYTIC valley profile (depth/half-width from
   discharge, noise suppressed on valley floors, a measured depth
   budget so the raster's own carved valley is not carved twice, never
   below the water surface), an anisotropic warp along contours
   (strength ∝ slope; on plains the distance-field gradient lends a
   faint flow direction), and a ridged blend at convex crests. All
   render-side: no ALGO bump, no artifact turnover. Verification by
   transect scripts (valley depth monotonic in discharge, amplitude ≈ 0
   at channels, anisotropy via directional slope reversals, crest
   sharpness before/after). DECIDED: the warpSeed manifest gap closes
   in the same step — one format touch, one pattern change, in the step
   that changes the pattern anyway.
   *(BUILT 2026-08-14, verified against a real 4K bake rather than a
   synthetic world: `map/channelField.ts` is the distance/height/size
   field — 4096×2048, seeded from the polylines with each pixel's EXACT
   sub-pixel distance and then chamfered twice around the torus, 2.0 s
   for a 4K network, median error 436 m against brute force, i.e. an
   ninth of a field pixel, and the same at the seam as in the bulk.
   `fineElevationSurface` v2 takes it and opens the valley. Measured:
   the carve reaches 20 m at 800 m from the water and 26–32 m at 1.7 km,
   is monotonic in discharge (at 3.3 km only the largest quartile still
   carves, 10 m against nothing), is 0.25 m at the channel itself, and
   NOT ONE sample of a hundred thousand ends below its channel's water
   surface. Three constants earned their shape by measurement: the
   half-width keys on √(discharge) because a real world's channel widths
   are so skewed that a linear map gave nine tenths of them the floor;
   the depth is a BUDGET (a fraction of the height still standing above
   the water) rather than an absolute, which is what stops the raster's
   own valley being carved twice — measured, that raster stands 72–84 m
   above its water at 1.7 km and 143–172 m at 3.3 km; and the ridge fold
   is worth its constant, 0.68 → 1.12 m of crest curvature measured in
   isolation.
   THE ANISOTROPIC WARP IS NOT BUILT, and that is the interesting
   result. Three constructions were measured by detrended slope
   reversals along the contour against down the fall line: a
   noise-displacement warp does NOTHING (0.964 against 0.961 without);
   a three-tap directional low-pass works (→ 1.12) but only in the
   sub-kilometre band, which is the band the ridge fold lives in, so it
   spends the fold's whole gain; a height-proportional shear moves the
   number a little (1.036) while adding a fifth more roughness in both
   directions, because on real terrain the axis field rotates faster
   than the shear can stretch. Elongation and crests compete for one
   octave — the trade is a look decision and is left open. Cost of what
   shipped: 15 ms per 192² patch, against 13 ms for v1.
   The warpSeed gap IS closed, though it turned out to be a different
   question than it looked. No manifest field was needed: `warpSeed` is
   `hashSeedString(seed + ":coastalWarp")`, a pure function of the seed
   text every save already carries, so the reader derives it. What made
   it a real fork is that the same `detailSeed` also seeds the
   amplification bake's roughness, which the artifact key does NOT
   cover — changing it silently gives one key two terrains. Settled by
   bumping `AMPLIFICATION_ALGO_VERSION` to 8 (2026-08-14): every cached
   4k/8k artifact is orphaned and re-baked, and afterwards the bake's
   roughness, the near-field cascade and the generator's own fine relief
   sample one field family per world instead of three unrelated ones.)*
2. **Hex-lattice near mesh.** Below ~full grid visibility the ground IS
   a triangulated hex lattice (vertices at centers + corners, ~27k
   verts per 96²-tile window ≈ today's patch density, anchored per the
   wrap-frame lesson); the square patch continues above/beyond.
   DECIDED: replace-below-threshold, not nested. Developed tiles
   flatten their own seven vertices with real creases — hexPlateLayer
   and both of its compromises (max-not-median, drawn-not-truth) fall
   away, because the mesh IS the drawn ground and levelling actually
   cuts. Grid lines stay in the shader; pickGround gains the mesh.
   Wilderness stays smooth-continuous (a per-hex facet look remains a
   cheap later experiment).

   **BUILT 2026-08-15, MEASURED, AND REMOVED THE SAME DAY.** Both halves
   worked and neither earned its place. Kept in full here, because what it
   cost to find out is the only thing that survives it.

   *The lattice.* `map/hexNearMesh.ts` built the ground as the tile grid,
   Babylon-free so it could be checked headless. Checked and passing:
   corners really were SHARED (3.02 vertices per tile, not 7), every
   triangle faced up, every vertex normal pointed up, the rim landed
   exactly on the plain surface, the window was built in ONE wrap copy,
   and the lattice sat on hexGrid to float32. The window had to be 192
   tiles wide, which was not free to choose — the square patch covers
   16 × altitude, so anything smaller would cover LESS ground than what it
   replaced — putting the swap at 3.6 km against the camera's 2.5 km
   floor. It cost 129,949 vertices and 258,234 triangles against the
   patch's ~37k, and a rebuild was 85 ms against the hydrology-aware
   sampler. What it bought in detail was nothing: 173 m between vertices
   against the patch's 208 m at the same altitude. **Its entire
   justification was that a tile could cut**, and when that turned out
   not to be worth having, five times the geometry for a 17 % spacing
   gain was not a trade anyone would make.

   *The levelling.* A developed tile shared no corners: it owned its seven
   vertices at one height, and every edge carried a wall to the exact
   heights its neighbour gave that edge. The crease was watertight —
   worst height gap 0.4 mm, which is the float error between two tiles
   computing one corner from their own centres, the same tolerance the
   corner sharing already ran on. Two things the construction had to be
   told, both found by measurement rather than by looking, and both worth
   keeping for whatever cuts terrain next:

   - **A wall faces AWAY FROM ITS MATERIAL, not outward.** A fill — the
     plate standing on its own embankment — faces out of the tile; a cut
     — the back wall of a terrace dug into the hillside — faces IN,
     because the material there is the hill. The first version forced
     every wall outward and lit 18 of 60 terrace walls from behind.
   - **A wall whose two ends fall on opposite sides of the ground is two
     walls**, split where the surfaces cross. One quad cannot face away
     from material lying on both sides of it. The split point is exact:
     the neighbour spans that edge with a straight chord, so
     interpolating along it lands on the neighbour's own geometry.

   *Why it went.* Because it worked, and you could not see it. On ground
   gentle enough to develop — and steep tiles are refused — a 300 m tile
   spans about 0.2 m, so a levelled tile differs from its own ground by
   nothing, and what remains on screen is the thin dark outline of its
   walls. That number was MEASURED ON 2026-08-14 and written down one
   section below, and it was still built. The rule it should have been
   read as: **height cannot signal "developed" on this world, so no
   amount of correctness in the cutting will make a settlement visible.**
   Whatever answers that question, it is surface or structures, not
   geometry — and that question is open (see below).

   The ring stack of
   [decisions/near-ground-clipmap.md](../decisions/near-ground-clipmap.md)
   stands unchanged; it just no longer has a ring 0 built in advance. The
   near ground is the square patch again.
3. **16K bake as a MEASUREMENT** (no display work): factor 8 locally
   via baker.mjs (--max-old-space-size; ~10–12 GB expected against 8K's
   ~3 GB), after checking the seed cascade's steps and the constant
   rescaling at r=8. Deliverable: the threshold-reversal table extended
   one row (min basin ~625 km² expected), valley cross-sections, mouth
   checks, RSS/time, plus a headless PNG crop. Whether 16K ever enters
   the fetch ladder is a separate decision — the 537 MB tab question
   stands.

   **MEASURED 2026-08-15, and there was nothing to build.** The factor is
   already carried everywhere and the three resolution-dependent places
   derive themselves: `seedCascadeScales(16384)` returns `[1, 2, 4]` (one
   more noise call than 8K, cut off by Nyquist rather than by a table),
   the erosion constants are rescaled by `1/factor`, and the channel
   threshold stays in cells by design. `Request.Validate()` has allowed
   stage 8 all along. So the run was the work.

   One world (`708863569`), one pipeline (`v8-4380b6f5a7576301`), three
   tiers of it, all read back off the finished ARTIFACTS:

   | tier | cell | min basin | polylines | confluences | channel | density | bake |
   |---|---|---|---|---|---|---|---|
   | 4K | 3900 m | 9,996 km² | 3,146 | 2,348 | 260,881 km | 7.50 | 94 s |
   | 8K | 1950 m | 2,499 km² | 11,792 | 9,812 | 527,563 km | 15.09 | 465 s |
   | 16K | 975 m | 625 km² | 37,649 | 33,650 | 988,210 km | 28.13 | 2,515 s |

   16K peaked at **8.5 GiB resident** (13.2 GB peak footprint) in 41.9
   minutes and wrote a 395 MB artifact — under the 10–12 GB this plan
   expected. The predicted 625 km² minimum basin is exactly what a
   non-rescaled threshold gives.

   The bake was then repeated under the server's own heap ceiling
   (`nodeHeapMB = 6144`, sized for 8K) to find out whether a 16K bake
   could run there at all. It can, and the result inverted the question:
   the 6 GB run finished in the same time using MORE memory (9.4 GiB
   resident). `--max-old-space-size` governs the V8 old space, and this
   pipeline's working set is typed arrays, which live outside it — the
   ceiling only shifts GC timing, and system RAM is what binds. The
   constant stays as it is; the reasoning now sits next to it.

   Both runs produced BYTE-IDENTICAL artifacts, which is the determinism
   check at this size and the reason a cached 16K artifact could be
   trusted at all.

   THE ROW THAT MATTERS is not in that table. Valley cross-sections at
   trunk rivers, stepped at a fixed 250 m over a fixed 6 km (in METRES —
   the first cut stepped in cells and therefore searched twice as far at
   4K, which made valleys look like they got NARROWER with resolution):

   | tier | median valley |
   |---|---|
   | 4K | 117 m deep / 11.5 km wide |
   | 8K | 199 m deep / 12.0 km wide |
   | 16K | 306 m deep / 11.5 km wide |

   **Resolution reaches the geometry, and has not started to saturate.**
   8K → 16K adds as much depth (+107 m) as 4K → 8K did (+82 m), at
   constant width — the terrain is genuinely being carved deeper, not
   averaged differently. That is the finding this step existed for, and
   it is the argument for finer bakes being worth their cost at all.

   Two things fall out on the side. The open "rivers do not quite reach
   the water" question shrinks with every tier: 1.1 % → 0.6 % → 0.4 % of
   polylines end neither at a confluence nor within two cells of water.
   And in the PNG crops the small tributaries at 16K run conspicuously
   axis-parallel — that is D8, known and unchanged, only more visible
   because there are three times as many small channels to see it in.

   Not comparable with the threshold table in `surface/amplify.ts`
   (2026-08-08): different world, and the script that produced those
   numbers no longer exists. Every row here was recomputed with one
   definition rather than appended to numbers that cannot be reproduced.

   NOT DONE, deliberately (decided 2026-08-15): the generator's 16K
   button stays disabled and `AMPLIFY_FETCH_STAGES` stays `[2, 4]`.
   Enabling the button would commission a 42-minute server job whose
   result nothing in the app reads, and the display ceiling is the same
   537 MB argument as before — it wants the tiled ground of
   [decisions/near-ground-clipmap.md](../decisions/near-ground-clipmap.md)
   first. Baking 16K stays a local, deliberate act.

Deliberately NOT in this plan: fighting flatland boredom with terrain
tricks. Metre-true flatland is boring from 2.5 km, and that is the
realism the 1:1 decision bought; interest there is CONTENT's job
(biome albedo, vegetation, later settlements) — plains must stay
legible as the valuable building ground the design prices them as.

This paragraph used to name two prerequisites for the FIVE-PHASE plan's
phase 2. Both have moved on and it is kept only so the trail is
readable: the amplification bake did become the classification's terrain
source (4k is enough, 8k still waits on the memory work), and the fine
relief's seed provenance turned out not to be a manifest gap at all —
it is a fork about the amplification key, and it now stands under Open
questions in its own right.

## Open questions

- **WHAT DOES A DEVELOPED TILE LOOK LIKE?** Reopened 2026-08-15 after the
  geometric answer was built twice and failed twice. This document's
  premise is that "grid = civilisation" and that developed land becomes a
  flat plate with edges. The first half of that is fine — the grid is a
  shader and it reads. The second half has now been measured out of
  existence: developable ground is gentle BY SELECTION (the classifier
  refuses steep tiles), a 300 m tile of it spans about 0.2 m, and so
  levelling it — however correctly, cut and all — changes nothing a
  viewer can see. Height is not a channel this world has spare.

  The candidates, none chosen, and the reason this is a fork rather than
  a task:

  - **Surface.** Worked earth against wild green: albedo, texture,
    field-and-hedge pattern inside the tile. Cheap, and it is the only
    answer that works on the ground people will actually settle. Risk:
    it makes development a paint job, and the doc's whole point was that
    the tile is a real thing.
  - **Structures.** Buildings, walls, terrace steps — objects ON the
    tile rather than a shape OF it. Reads at every distance a settlement
    matters at, and it is what a player would look for anyway. Costs a
    content pipeline this project does not have yet.
  - **Geometry after all, but where it earns it.** Terracing only on the
    tiles steep enough to need it, as a special case rather than the
    rule. The measurement says that is a small minority (worst case
    19.8 m of step, p90 0.5 m), so it is a garnish, not a mechanism.

  Settling this is a prerequisite for phase 4 restarting, not part of it.

- **The descent's altitude was measured from SEA LEVEL** (found and fixed
  2026-08-15, reported as "in the mountains I cannot get closer, or I end
  up inside the map"). `worldgenCamera`'s near regime derived its altitude
  purely from the zoom — `handoverAltitude · (2500 m / handoverAltitude)^u`
  — with the terrain nowhere in the expression, so `NEAR_MIN_ALTITUDE`
  was a floor above the SEA. Over a 4,000 m range the floor is inside the
  mountain. The exaggeration compounded it rather than relieving it: the
  blend runs on the same `u` (6 → 1), so halfway down the range is still
  drawn two to three times its true relief and grows toward the camera
  while the camera sinks.
  This also reframes every near-field screenshot taken in mountains: they
  were all shot at a grazing angle from a camera nearly inside the surface,
  which is exactly where two surfaces interpenetrate most visibly — so it
  is a plausible contributor to the "two grounds" reports rather than a
  separate complaint.
  FIXED by giving the camera a `getGroundHeight` — the DRAWN ground under
  the focus, exaggeration included, since that is the surface it can
  collide with — and measuring altitude from it. Both the camera and its
  look-at target rise, or the view would tilt into the hillside by exactly
  the height it was lifted. The offset is RAMPED IN over the descent: at
  the handover the ground is drawn at its most exaggerated, and adopting it
  whole there would pop the camera up by tens of kilometres in one frame.
  Left deliberately untouched: the exaggeration curve itself. With altitude
  measured over ground it no longer pushes the camera into anything, so how
  dramatic the mid-descent should look went back to being a taste question
  rather than a defect. The lever is one constant if it ever reads wrong.

- **TWO GROUNDS IN THE NEAR VIEW** — the detail patch sinks into the
  relief mesh beneath it, and the mesh's triangles show through as a
  second, stippled sheet lying over the terrain (seen 2026-08-14 in the
  mountains, measured the same day against a v8 4K bake). NOT caused by
  the hydrology-aware synthesis, which is why it is recorded here rather
  than fixed there: the valley carve adds one percentage point and two
  metres to a defect that was already full-size.

  | mesh level | ground | with channel field | without (v1) |
  |---|---|---|---|
  | fine 2048×1024 | all land | 17.1 % of points, median 33 m | 16.1 %, 31 m |
  | fine 2048×1024 | above 2000 m | 14.1 %, 45 m | 13.7 %, 43 m |
  | coarse 1024×512 | above 2000 m | 24.4 %, 98 m | 24.2 %, 96 m |

  p99 of the penetration is 350 m at the fine level and 880 m at the
  coarse one. The cause is a RESOLUTION MISMATCH, not a height error:
  `map/toroidalMapView.ts` fixes the relief levels at 1024×512 and
  2048×1024 over the world whatever tier is loaded, so above a 4K raster
  the fine mesh sees every second cell and above an 8K one every fourth,
  its vertices stand 7.8 km apart, and it spans that distance with
  STRAIGHT triangles. The patch samples the same surface at ~208 m.
  Wherever the chord passes above the surface it approximates, the patch
  is inside the mesh — which is why it shows in mountains and not on
  plains, where chord and surface coincide. The patch's anti-z-fight
  lift is `altitude × 0.0015`, i.e. 3.75 m at the lowest altitude the
  camera reaches: two orders of magnitude short.

  SUPERSEDED 2026-08-15 by
  [decisions/near-ground-clipmap.md](../decisions/near-ground-clipmap.md):
  the seam is not a defect to treat but a property of having two grounds at
  all, and the structure that removes it is one ground per register — rings
  around the camera below the descent, tiles built on demand on the map. What
  follows is what was tried on the way, kept because each attempt narrowed
  the question.

  FIXED 2026-08-15 with candidate 1 below, once building step 2 showed the
  deferral's reasoning to be wrong. The near ground (patch and hex lattice),
  the developed plates and the river ribbons render in their own group;
  Babylon clears the depth buffer between groups, so the near ground draws
  over the relief unconditionally and the interpenetration cannot show. The
  assumption it rests on is the camera's — the near ground surrounds the
  focus, so nothing in the terrain group is ever between the camera and it.
  The cost is stated at the constant and is real: the same clear removes the
  near group's occlusion AGAINST the terrain group, so a distant river behind
  a ridge now shows through it, muted by fog. If that trade proves the wrong
  way round, candidate 2 is not the answer either — the third way is to
  displace the relief levels' vertices from a MINIMUM over the raster cells
  each one stands for, so the chord sits at or below the surface it
  approximates and no render order is assumed; it lowers ridges at the coarse
  level, which is a change to the map's own look.

  The original deferral, kept because the mistake is the useful part:
  DECIDED 2026-08-14 to do nothing for now, on the reasoning that step 2
  of the near-field plan would dissolve it — the hex-lattice near mesh
  replaces the patch, so two grounds stop existing. **That reasoning is
  wrong, and building step 2 is what showed it** (2026-08-15): the two
  grounds in question were never the patch and the lattice, they were the
  NEAR ground and the relief mesh beneath it. Swapping which near ground
  is drawn changes nothing about that — the lattice samples the same
  surface the patch did and sinks into the same triangles. The deferral
  itself still stands (nothing about the defect got worse, and the fix is
  cheap whenever it is wanted), but the expectation attached to it does
  not: this should be expected to SURVIVE step 2, and option 1 below is
  the likely answer rather than a fallback.
  **Re-measure after step 2.** The probe was a throwaway script and is
  not kept; it is twenty lines, and the method is the whole of it. Over
  random land points, banded by elevation: take the patch's DRAWN height
  (the fine sampler at bias 0.6, plus the 3.75 m lift) and the mesh
  height at the same point, where the mesh height is the LINEAR
  interpolation across the triangle of a quad whose corners are the
  plain elevation surface sampled at the level's own subdivision grid
  (CreateGround splits each quad on the (i,j)–(i+1,j+1) diagonal).
  Count how often the first is below the second, and by how much. If it
  survives step 2, the two candidates, in order:

  1. **Rendering groups.** Patch, river ribbons and plates into group 1
     with a depth-buffer reset, relief levels into group 0; the patch
     then wins inside its own square and the mesh underneath is simply
     hidden. Cheap and exact. It buys that with an assumption the
     ordering has to carry — that nothing stands between the camera and
     the patch — which holds for this camera because the patch is
     centred on the focus. Note the codebase uses no rendering groups at
     all today, so this introduces the concept.
  2. **Tie the mesh resolution to the tier.** The honest fix, and the
     expensive one: 4096×2048 is 16.8 M triangles per wrap copy, against
     a memory budget that is already the binding constraint on 8K.

- **Anisotropy in the fine synthesis** (measured and deferred
  2026-08-14 — see step 1's note above). Elongating the roughness along
  the terrain and sharpening its crests both want the sub-kilometre
  octave, and measurably cannot both have it. Taking the trade is a
  question of which the near view should read as: lineated hillsides
  with softer crests, or crisp crests with isotropic texture.

- **Coastal basins are flooded as lakes instead of being sea**
  (measured 2026-08-14, deferred to its own step after phase 4). Of the
  lakes an amplified bake produces, the ones with no river touching them
  — 40 of 205 in the measurement — sit at the coast (98 % within five
  cells, median distance 0) with their floor BELOW sea level (median
  −56 m). They are fjord-like arms the bake's erosion carved and then
  pinched off from the world ocean: no longer part of the ocean
  component, so `computeLakes` floods them as lakes by construction
  ("an enclosed sea is a depression like any other"). On the map they
  read as a chain of unconnected ponds along the coast. This predates
  the lake layer — the bake always carved them; shipping lakes only made
  them visible. The fork to settle: is such a basin **sea** (a fjord —
  the physical reading, and a one-condition change), a **lagoon** (a
  lake, but labelled and drawn as one), or something the erosion should
  not produce at all (the deepest fix, and the continuation of v5's
  estuary clamp)? Note the implementation choice is free of a second
  artifact turnover if the filter runs client-side on read: only the
  lake layer is affected, never the terrain or the rivers.
- ~~Rivers stopping short of the water they drain into~~ — fixed
  2026-08-14: the gap was exactly one cell at every resolution and the
  polyline now reaches the receiving water cell
  (`AMPLIFICATION_ALGO_VERSION` 7).
- Thresholds/costs for the developability grades, and rewilding pace.
- Where exactly the "path organic vs. road geometric" upgrade boundary
  sits.
- ~~Exact hex size~~, ~~rivers through-tile vs. on-edge~~, and the zoom
  model: decided 2026-08-13 —
  [decisions/hex-tiling.md](../decisions/hex-tiling.md).

## One map, two screens (decided 2026-08-09, not built)

The generator's preview and the world map are to become the SAME view with
different limits, not two views that resemble each other.

They are already closer than they look: both build a `ToroidalMapView`, both use
`createWorldgenCamera`, both share the hover tooltip, the ribbon overlays, the
relief surface, the paper base and the `RELIEF_MIN_ZOOM` / `RELIEF_FINE_ZOOM`
thresholds. The two camera calls differ in exactly two fields —
`nearModeEnabled` and `nearMinAltitude` — which is already the shape wanted:
same behaviour, different reach.

What actually diverges is three things, and only one of them is defensible.

**Vertical exaggeration is the problem.** `WORLDGEN_EXAGGERATION = 3` against
`MAP_EXAGGERATION = 6`, fading to `NEAR_EXAGGERATION = 1` in the descent: one
world at three vertical scales. The reason on record — the generator is "a
working view over a world being tuned, not a presentation of a finished one" —
is an aesthetic claim, and it costs the thing the workbench is FOR: a range that
reads right at 3× reads differently at 6×, so you tune against a scale you never
see. To unify, with the same fade toward 1:1 on descent. *(Unified 2026-08-11:
`WORLDGEN_EXAGGERATION` is gone and the generator uses `MAP_EXAGGERATION`; it
never descends, so it needs no fade.)*

**The fine elevation surface** should be in both. It is deterministic and cheap;
there is no reason the workbench goes without it.

**The amplification bake stays map-only**, and that is NOT a concession. It costs
~100 s at 4k while the workbench re-renders as sliders move — but more
importantly the 2048 macro raster is the sole authority and the amplified tier is
derived presentation (worldmap-amplification.md, rule 4). A workbench showing the
macro tier is showing what the save actually contains; the surprise belongs to
the map view, not to the workbench.

That distinction now has vocabulary rather than being accidental: the workbench
is the `authoritative` view and the map the `presentation` one, in the sense
`world/query.ts` gives those words. Both should be able to say which they are
showing.

**Deliberately unresolved:** the generator's data overlays (temperature,
precipitation, plates, arrows) read worse over strongly shaded relief, so raising
its exaggeration trades against them. Coupling exaggeration to overlay visibility
was considered and rejected as a hidden dependency. The overlays are being
rethought separately, so this waits for that rather than being designed around.

