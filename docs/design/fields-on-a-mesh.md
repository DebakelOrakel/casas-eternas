---
id: DES-0025
title.en: Fields on a uniform mesh instead of a raster
title.de: Felder auf einem gleichmässigen Netz statt im Raster
summary.en: Idea sketch: compute the mantle and the climate — today rasters in the 2:1
  chart — on a coarse, uniform point mesh over the world (an icosahedral
  one on the sphere), with diffusion along its edges and transport from
  node to node. No pole as a special case, one code for torus and sphere.
  Larger than the pole handling chosen for now; kept for a later pass.
summary.de: Ideenskizze: den Mantel und das Klima — heute Raster in der 2:1-Karte — auf
  einem groben, gleichmässigen Punktnetz über die Welt rechnen (auf der
  Kugel ein Ikosaeder-Netz), mit Diffusion entlang der Kanten und Transport
  von Knoten zu Knoten. Kein Pol als Sonderfall, ein Code für Torus und
  Kugel. Grösser als die vorerst gewählte Polbehandlung; für einen späteren
  Wurf aufbewahrt.
area: generator
stage: superseded
createdAt: 2026-10-10
updatedAt: 2026-10-29
supersededBy: DEC-0036
related: [DEC-0036, DEC-0035, DES-0017, DEC-0029]
---

Records a discussion (2026-10-10), while planning the sphere's generator
(step 4 of [two-shapes.md](../decisions/two-shapes.md), DEC-0035).

## The problem it answers

The mantle (diffusion and a Poisson solve), the climate (wind, ocean
currents, rain, their advection) and the ocean age are rasters in the 2:1
chart. On the torus that chart is exact. On the sphere it is longitude
and latitude, and toward a pole a cell narrows (width ∝ cos φ) until the
pole row is in truth a single point:

- **stability**: diffusion and transport need a time step that suits the
  smallest cell, and the polar cells are the smallest by far;
- **neighbours**: across the pole is longitude + 180°, which every raster
  stage must get right;
- **averaging**: the whole pole row must be one value, or the pole shows
  a star.

Land at the poles must be possible, so the poles cannot be left hidden
under ice and sea.

## The answer chosen for now: pole handling in the raster

The usual remedy of climate models: the metric (cell area and scale ∝
cos φ) from the sphere's `DomainGrid`, the pole rows averaged or filtered,
sub-steps where a stage needs them. Smaller, and probably enough for the
mantle and the climate. Decided 2026-10-10 for step 4 (DEC-0035, fork 5).

## The idea kept for later: the fields on a mesh

The values sit on points spread evenly over the world — on the sphere an
icosahedral mesh, like a fine football; on the torus a uniform triangular
lattice — and each point knows its neighbours by edges.

- **Diffusion** (mantle, heat) is exchange along the edges, a graph
  Laplacian weighted by edge length and the cells' areas.
- **Transport** (wind, currents) moves values from node to node along the
  flow (an upwind scheme on the graph).
- **For display** the field is sampled into the 2:1 chart, as the terrain
  already is.

The precedent is in the project: since the adaptive mesh the history and
the erosion run on mesh nodes (`FlowSubstrate`), not on the raster. For
the mantle and the climate a separate mesh would serve, UNIFORM and
coarse (about 40 000 points): the adaptive mesh is dense on land and thin
at sea, and the climate wants the same resolution everywhere.

**For it**
- No pole as a special case: every point is as large and as far from its
  neighbours as every other.
- One code for torus and sphere; only the mesh's making and the distances
  come from the `Domain`.
- Closer to the generator's direction since the adaptive mesh: geometry
  where the physics is, the chart only for storage and display.

**Against it**
- The climate (~1 400 lines) and the mantle rewritten in large parts.
- Loops over neighbour lists are slower than over rows and columns.
- The torus's results change too if both shapes take the new path — a
  deliberate break of the golden values — or the torus keeps its raster
  and there are two paths.

## Open questions

- Which stages would move: the mantle and the climate, or the ocean age
  and the remaining rasters too?
- One shared coarse mesh for every field, or one per stage at its own
  resolution?
- Does the torus move with the sphere (one path, a golden break), or stay
  on its raster for a while?

## Status

2026-10-29: superseded by [fields-on-meshes.md](../decisions/fields-on-meshes.md)
(DEC-0036), which is built (2026-10-12).

2026-10-11: DECIDED as [fields-on-meshes.md](../decisions/fields-on-meshes.md)
(DEC-0036), wider than sketched here: every simulated field leaves the
chart — the coarse global ones onto a uniform field mesh (the Goldberg dual
of a subdivided icosahedron on the sphere, a hexagonal lattice on the
torus), the fine land fields onto the adaptive terrain mesh; the torus takes
the same path; the save format stays. The open questions below are
answered there.

2026-10-10: IDEA — kept for a later pass. The user leans toward it as the
more correct approach in principle; for now the sphere's rasters get pole
handling (DEC-0035, fork 5).
