---
summary: PROTO — the first Anthropology output. Seeds the world's peoples via USER-PLACED origins (one per race, ~3 races, toggleable) and a least-cost dispersal over the Ecology suitability, producing a "migration arrow-tree" (Dijkstra predecessor tree, arrow width = accumulated population flow, colour = race) over a coarse population-density background. Steerable-deterministic: the user places origins, the spread is deterministic.
date: 2026-07-26
area: generator
stage: built
status: proto BUILT — all 5 themes decided, Phases 1–3 built (worker core, panel + drag origins, ribbon arrow-tree)
---

# Anthropology — initial migration (proto)

The **first concrete Anthropology step** (see `anthropology.md` for the whole
human layer). Goal: a *very rough* first look at how peoples spread and where they
end up, driven by the Ecology carrying-capacity field plus a movement model.
Deliberately coarse (climate-grid), and it is the **coarse core of the full
dispersal model** — not throwaway; settlements / contact graph / densification
build on it later.

## Why not just "capacity → density"

Colouring population by carrying capacity is the **snapshot placement we
rejected** — path-independent, "optimised", no history. A *migration* pattern
needs two things capacity alone lacks: an **origin** (where does it start) and a
**movement/cost model** (how you get from A to B). Those two turn "where you *can*
live" into "how it actually *filled up*".

## The elegant backbone: the migration tree is a river tree

Least-cost spread from an origin (Dijkstra over a cost field) yields, for free, a
**predecessor tree**: each cell "came from" a neighbour toward the origin →
arrows parent→child = migration direction. Accumulate "how many people flow
through this edge" leaf→root (**exactly discharge accumulation**) → trunk wide,
branches thin: a *river of people*. Draw only edges above a threshold (**exactly
river extraction**) → a clean branching arrow-tree.

So the whole thing recycles what we already have:
- Dijkstra routing ≈ erosion flow routing,
- flow accumulation ≈ hydrology discharge,
- threshold-and-draw ≈ river extraction (a density slider),
- arrow rendering ≈ plate arrows / the ribbon overlay,
- map click ≈ the hover-tooltip coordinate infra.

## Decisions so far

- **~3 races, toggleable** ("I want these, not those" → only seed enabled races;
  a disabled race's land falls to the others on recompute). Count could be
  configurable later.
- **User-placed origins** — one per race, by map click, snapped to land (ocean
  clicks rejected/snapped). This is the **steerable-determinism** resolution: the
  user supplies the variation (origins), the spread stays deterministic /
  reproducible.
- **Cost model — identical for all races FIRST**, then **per-race terrain
  preferences** later (the user's tuning; the lever that makes "3 races" more than
  3 colours — forest-folk through forests, mountain-folk through highs, coast/
  plains-folk along rivers/coasts).
- **Cost ≠ capacity, kept separate.** Cost = *movement* (mountains/deep ocean
  expensive); carrying capacity = *density / where they settle*. Two fields.
- **Land bridges + short shallow seas are crossable** (decided now; later a race
  trait). Mechanism: derive water cost from **depth** — shallow shelf = high-but-
  finite cost, deep/wide ocean = effectively impassable. Dijkstra then crosses
  short shallow gaps and land bridges emergently (accumulated cost over a short
  shallow crossing stays finite) but not wide/deep ocean — **no explicit
  gap-width detection needed**.
- **Spread = multi-source Dijkstra** (all enabled origins seeded at once):
  per-cell cost-distance + a race assignment (nearest-in-cost origin) → contact
  zones fall out as the **cost watersheds** between origins.
- **Output first:** the **arrow-tree** (width = accumulated population flow,
  colour = race hue; density can modulate width/brightness) over a coarse
  **population-density background** (from carrying capacity). Discrete settlements
  / the contact graph come afterwards.
- **Colour = race (hue), density = width/brightness.** Colouring purely by
  density would make the races unreadable — race sets the hue.
- **Pruning is mandatory** (threshold slider, like river density) — else
  thousands of arrows.

## Design-round agenda (theme by theme, like Ecology)

1. **Races & cost model** — ✅ DECIDED: the identical v1 movement cost is
   **physical only** — slope (steep = costly) + depth-based water (shallow shelf
   crossable at rising cost, past a depth threshold impassable → land bridges +
   short shallow seas emerge, no gap-width detection) + coast/river **corridors**
   (cheap highways). **Biome friction is deferred to the per-race preference**
   (the lever that differentiates races). Cost stays **separate from carrying
   capacity** (movement vs. density). Exact weights + the impassable-depth
   threshold are tuning sliders, not design forks.
2. **Origins / races UI** — ✅ DECIDED. **Three race icon-toggles** in the panel
   (styled like Ecology's category icons — just on/off, **no fold-out** yet since
   per-race preferences are deferred). Origins are **auto-generated (seeded,
   biased toward good well-spaced cradles)** so a migration shows immediately, and
   each is a **drag-and-drop marker** on the map (snapped to land) — drag to
   reposition. Toggling a race / dragging an origin recomputes. *(The concrete
   race identities — e.g. human/dwarf/beaver + their icons — are UI flavour and
   deliberately NOT pinned in this doc.)*
3. **Spread dynamic** — ✅ DECIDED. **Multi-source Dijkstra**: all enabled origins
   at cost 0; per cell → cost-distance, owning race (nearest origin in cost),
   predecessor (parent toward origin) = the migration tree; contact zones = the
   cost watersheds. **Extent = cost-budget N with a slider** (cells past N stay
   unsettled → empty frontiers, path dependence, a "how far the migration got"
   knob). **Frontier density = a gradient:** `density = carryingCapacity ×
   fillFraction`, `fillFraction = clamp((N − costDistance)/N, 0, 1)` — full at the
   origin, thin at the front. **Flow** (arrow width) = that density accumulated
   leaf→root over the predecessor tree (like discharge).
4. **Arrow-tree rendering** — ✅ DECIDED. The pruned predecessor tree (edges with
   flow above a threshold slider) drawn as **tapering ribbons, width ∝ flow**
   (reuse the ribbon overlay), with **arrowheads only at the outer frontier tips**
   (direction without clutter). **Colour: race = hue, density = brightness +
   width** (both readable). Under it, a **race-tinted density fill** (each race's
   territory in its hue, value by density) as the background.
5. **Sliders & controls** — ✅ DECIDED. Three race enable/disable icon-toggles
   (§2). Three global sliders: **Spread extent (N)** (cost-budget — how far the
   migration got), **Arrow threshold** (flow prune, like river density), **Sea
   crossing** (the water/impassable-depth threshold — how far shallow seas + land
   bridges are crossable; exposed, not hidden). Deferred: per-race terrain
   preference, discrete settlements, contact graph, seafaring race.

**DESIGN ROUND COMPLETE (2026-07-26)** — all 5 themes decided. Building phased
like Ecology.

## Implementation status

- **Phase 1 — worker core ✅ BUILT + verified 2026-07-26.**
  `client/src/worldgen/migration/migrationField.ts`: `computeMigration()` — builds
  the physical cost field (slope + depth-based water with seaCrossing threshold +
  coast/river corridors), runs a multi-source Dijkstra (binary-heap) over the
  torus grid → per-cell `cost` / `race` / `predecessor`, then the frontier-gradient
  `density` (capacity × fillFraction) and `flow` (population accumulated up the
  predecessor tree). Headless-verified: predecessor tree + monotonic cost,
  budget-cutoff frontier, flow = subtree population, deep water blocks / shallow +
  land bridges cross, multi-source race watersheds.
- **Phase 2a — panel + compute plumbing + density overlay ✅ BUILT 2026-07-26.**
  Migration panel (index 6, gated on erosion) with **3 race icon-toggles**
  (caveman/dwarf/beaver) + **3 sliders** (spread N, arrow threshold, sea
  crossing); `computeMigration` worker message (worker caches ecology's carrying
  capacity + downsamples discharge); a **compute-on-open chain** (climate →
  hydrology → ecology → migration, reusing the awaitCompute helpers); **auto-placed
  origins** (greedy top-capacity, torus-spaced) shown as markers; **race-tinted
  density-fill overlay** (alpha ∝ density) + origin discs. The arrow-threshold
  slider is wired but render-only (arrows are Phase 3). Icon = placeholder
  caveman.png.
- **Phase 2b — drag origins ✅ BUILT 2026-07-26.** Pointerdown on a marker (hit
  radius, toroidal) starts a drag: the camera pan is suspended (new
  `hexMapCamera.setPanEnabled`), a colour ghost dot follows the cursor (live, no
  canvas repaint); pointerup snaps to the nearest land cell and recomputes.
  Pointer→texel via Babylon picking (`getTextureCoordinates`, torus-aware).
- **Phase 3 — ribbon arrow-tree render ✅ BUILT 2026-07-26.** `drawMigrationArrows`
  draws the pruned predecessor tree as tapering ribbons: each edge parent→child at
  `lineWidth ∝ √(flow[child]/maxFlow)` (round caps/joins), so a corridor narrows as
  it fans out. Race sets the hue, local density modulates brightness, and
  arrowheads mark only the outer *drawn* tips (cells above threshold with no drawn
  child = frontiers). Torus-safe (wrapped child→parent delta + `paintWrapped`),
  drawn under the origin discs. **Threshold slider maps EXPONENTIALLY** onto the
  flow cut (`max·[0.12 → 0.0004]`, higher = more arrows) since flow spans orders of
  magnitude (trunk ≈ whole population, leaf ≈ one cell); default 50. This completes
  the initial-migration proto — all phases built.

## Open questions

- Is there a "stopping time" N (bounded spread → path dependence) or does Dijkstra
  run to completion (whole reachable map filled)? If the latter, path dependence
  comes only from cost + contact watersheds, not from a time cutoff.
- Density = carrying capacity directly, or capacity × reachability (so far-but-
  good land reads as under-settled)?
- Origins: exactly one per race, or allow several later?
- What does the game receive — the density field + arrow-tree, or already
  settlement points? (Later step.)
