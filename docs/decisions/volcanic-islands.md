---
id: DEC-0051
title.en: The volcanoes build islands
title.de: Die Vulkane bauen Inseln
summary.en: The history made no island in the open ocean. Its uplift is
  crustal thickening and lifts land only, a hotspot has no uplift, and the
  mesh lost what was built in the deep sea. Now an active island arc and
  a hotspot build up from the sea floor, a new node in the open ocean
  keeps its parents' relief, and built relief in the deep sea keeps a
  40 km mesh. A volcano is a cone, an arc a chain of three per feature:
  islands of 1 000–10 000 km² are 1.5 to 3 times as many, in chains.
summary.de: Die Geschichte machte keine Insel im offenen Ozean. Ihre
  Hebung ist Krustenverdickung und hebt nur Land, ein Hotspot hat keine
  Hebung, und das Netz verlor, was in der Tiefsee aufgebaut wurde. Jetzt
  bauen aktive Inselbögen und Hotspots vom Meeresboden auf, ein neuer
  Knoten im offenen Ozean behält das Relief seiner Eltern, und
  aufgebautes Relief in der Tiefsee behält ein 40-km-Netz. Inseln von
  1 000–10 000 km² sind 1,5- bis 3-mal so viele, in Ketten: ein Vulkan
  ist ein Kegel, ein Bogen eine Kette von drei je Merkmal.
area: generator
stage: built
createdAt: 2026-10-27
related: [DEC-0036, DEC-0049, DEC-0050]
---

## Where this starts

The worlds had few islands and no island chains. Measured (3 seeds per
shape, the script of [DEC-0049](./shelf-and-sea.md), epoch 40; a world is
a quarter of Earth's area): per world 4–28 landmasses of 1 000–10 000 km²
and 2–7 of 10 000–100 000 km², 1–4 % of the land on masses under
1 000 000 km². Earth, scaled to a quarter, from memory and to ±50 %:
some 75–100, 18, and 5–7 %.

## What kept the ocean empty

- **The uplift lifts land only.** The erosion's uplift is crustal
  thickening from the boundary's shortening (`kernel_uplift`, the coast
  mask `z > 0`). An island arc's feature took deposits and shortening, but
  the nodes under it stood 4–5 km below the sea (1107 subsiding features
  on the torus at epoch 40, the median's highest node −4300 to −4600 m).
- **A hotspot has no uplift.** Its feature and a flood basalt's are left
  out of the uplift field (`uplift_field.rs`); they only drew markers.
- **The mesh lost the deep sea's relief.** A node the refinement inserts
  takes its parents' relief scaled by the continental margin's parameter,
  0 in the open ocean: every new node there had none. And under −300 m
  the mesh coarsens to 160 km, which spreads a cone across a cell.

Islands came only from continental crust (the rafts' splits) and from the
hand-over, and both wear down.

## Fork 1 — how a volcano rises: DECIDED — a build of its own

(a) Let the erosion's uplift act under the sea for volcanic features.
(b) A build of its own in the epoch, as the shelf's fill is.

**(b).** A volcano is lava piled up, not crust thickened: it has its own
rate, needs no shortening (a hotspot has none), and its footprint is a
cone, not a range's. `tectonics/volcanic_build.rs` builds a cone at each
active volcano: an island arc's feature (a volcanic feature that
subsides, both plates oceanic, a deposit this epoch) holds three, at
`volcano_spacing_m` (120 km) along it, a hotspot's feature one while the
plume feeds it. A cone of `volcano_radius_m` (50 km) rises by
`volcano_build_m_per_myr` (1500) at its summit toward a cone of
`volcano_top_m` (1500 m) in the capsule falloff, so its slopes reach the
sea at its foot. A cone no node is within builds at its nearest node
within `volcano_reach_m` (120 km): the deep sea's nodes are 160 km apart,
and the built relief refines the mesh (fork 2). The build loads the
plate. The plate carries it off; the ocean floor's age takes it down
again, and the waves plane it. A subduction arc on a continent keeps its
uplift alone.

The first build raised the whole arc segment, 2 × 273 km long, to
1500 m: the arcs rose as strips some 160 km wide and flat on top, and the
islands of 10 000–1 000 000 km² were 2.9–4.5 times as long as wide on the
sphere (1.3–1.7 before) — it looked smeared. An arc is a chain of
volcanoes 50–100 km apart; the mesh's 31–40 km takes 120 km.

## Fork 2 — the mesh in the open ocean: DECIDED — keep the relief, refine what is built

(a) Leave the mesh: the build is lost. (b) A new node in the open ocean
(all parents with margin parameter 0) keeps its parents' relief, and a
deep-sea node whose relief on the solid baseline is past
`ocean_built_above_m` (500 m) keeps `ocean_built_spacing_m` (10 km, 40 km
at budget 4; `mesh/mesh_density.rs`).

**(b).** Without it the build gave no island more (first trial: the same
counts). The relief kept in the open ocean is the ocean's own, a volcano
or the sea floor's sediment; the scaling stays where a parent is
continental. The mesh has 5–23 % more nodes; the run time stayed within
the spread of the runs.

## The worlds

| 3 seeds per shape, epoch 40 | before | strips (first build) | cones (built) |
|---|---|---|---|
| islands 1 000–10 000 km², torus / sphere | 20–28 / 4–18 | 22–38 / 24–46 | 28–39 / 18–50 |
| islands 10 000–100 000 km², torus / sphere | 3–7 / 2–5 | 5–12 / 10–19 | 3–5 / 0–5 |
| islands 100 000–1 000 000 km², torus / sphere | 0–3 / 1–6 | 2–5 / 2–4 | 4–5 / 1–5 |
| land on masses < 1 000 000 km², torus / sphere | 0.9–2.7 / 1.1–4.0 % | 2.2–4.7 / 3.7–5.3 % | 2.1–2.9 / 1.5–3.6 % |
| land share, torus / sphere | 30.6–40.7 / 25.3–29.4 % | 32.0–43.9 / 26.5–31.1 % | 31.5–42.3 / 25.8–29.8 % |

A cone stands at most 7 800 km² above the sea: the arcs and hotspots add
islands of 1 000–10 000 km², as chains. The classes above that stay
Earth's minus its large volcanic islands (Iceland, Java, Honshu): those
are arcs grown together over far more than 40 Ma, or a plume on a ridge.
The smallest class stays below Earth's: an island under some 1 000 km² is
a node or two at 8–31 km.

## Consequences

- The pipeline stays at `AMPLIFICATION_ALGO_VERSION` 14: v14 was never
  published. The tectonics' and the mesh's tuning move the pipeline's
  hash.
- The engine's fixtures of the coupled epoch, the replay and the world
  stages are recorded from the engine (rust-engine.md, fork 7c).

## Status

Built 2026-10-27.

2026-10-30 (TEG-54, DES-0027 entry 5): the island arcs rise. An arc
builds while it is active (fed within the 8 epochs `volcanoes.rs` counts,
not only in an epoch with a deposit), its cones stand
`volcano_arc_gap_m` (150 km) into the overriding plate, behind the
trench, and `volcano_build_m_per_myr` is 2250 (about 30 km³ per km of arc
and Myr at most; Earth 30–90). At 1500 and at the boundary the cones
stopped near −3000 m: they stood on the trench, and the flexure takes
some 0.8 of the load on young ocean. The large arc islands (Honshu, Java)
stay open: arc crust as rafts that grow and accrete (TEG-111,
[DEC-0003](./continental-crust-rafts.md)) is decided for pipeline v16.

2026-10-30 (TEG-21): level 1 keeps what an eruption reads, so that the
incubator's eruptions (incubator v6,
[DES-0032](../design/prehistory-in-three-steps.md)) need no new bake of
level 1. Each volcano of `volcanoes.f64` (the ecology's list, DEC-0053)
is `[x, y, thickness, kind, continental, active]`, two numbers more than
before (`VolcanoSetting`, `tectonics/volcanoes.rs`). Continental: an
arc that does not subside (a subduction arc under a continent's edge,
not an island arc), or a hotspot or flood basalt where the rafts' field
is over 0.5. Active: an arc fed within 8 epochs, a hotspot or flood
basalt fed within the plume's interval. These are facts of the
simulation, not an explosivity class: the class is the incubator's rule
and can change without a new bake. The rule proposed, from the earth's
VEI scale: an active continental arc can have the largest explosive
eruptions and calderas (VEI 6–8: Toba, Santorini, Pinatubo); an active
island arc VEI 4–7 (Krakatoa, Tambora); an active continental hotspot
VEI 8 calderas (Yellowstone); an oceanic hotspot is effusive, with lava
floods and gas rather than ash (Hawaii, Laki); an inactive volcano has
no eruption. The thickness is the size; the larger, the larger the
eruption can be.
Measured on Morvane (v15, level 1): 1098 volcanoes, 52 704 bytes (35 136
before). Active: 38 continental arcs, 180 island arcs, 2 continental and
4 oceanic hotspots, 1 flood basalt; inactive: 822 extinct arcs, 47
hotspots, 4 flood basalts. The flood basalts stand at a rift's edge, on
oceanic crust by the rafts' field.
