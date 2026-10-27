---
id: DEC-0051
title.en: The volcanoes build islands
title.de: Die Vulkane bauen Inseln
summary.en: The history made no island in the open ocean. Its uplift is
  crustal thickening and lifts land only, a hotspot has no uplift, and the
  mesh lost what was built in the deep sea. Now an active island arc and
  a hotspot build up from the sea floor, a new node in the open ocean
  keeps its parents' relief, and built relief in the deep sea keeps a
  40 km mesh. Islands of 1 000–100 000 km² are about twice as many, and
  3.7–5.3 % of the sphere's land is on islands instead of 1.1–4.0 %.
summary.de: Die Geschichte machte keine Insel im offenen Ozean. Ihre
  Hebung ist Krustenverdickung und hebt nur Land, ein Hotspot hat keine
  Hebung, und das Netz verlor, was in der Tiefsee aufgebaut wurde. Jetzt
  bauen aktive Inselbögen und Hotspots vom Meeresboden auf, ein neuer
  Knoten im offenen Ozean behält das Relief seiner Eltern, und
  aufgebautes Relief in der Tiefsee behält ein 40-km-Netz. Inseln von
  1 000–100 000 km² sind etwa doppelt so viele, und 3,7–5,3 % des Landes
  der Kugel liegen auf Inseln statt 1,1–4,0 %.
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
rate, needs no shortening (a hotspot has none), and its footprint is
narrower than a range's. `tectonics/volcanic_build.rs` raises the surface
under an active island arc (a volcanic feature that subsides, both plates
oceanic, a deposit this epoch) and a hotspot's feature while the plume
feeds it, by `volcano_build_m_per_myr` (1500) at the axis in the capsule
falloff of `volcano_radius_m` (80 km; the hotspot's a disc), up to
`volcano_top_m` (1500 m). The build loads the plate. The plate carries it
off; the ocean floor's age takes it down again, and the waves plane it.
A subduction arc on a continent keeps its uplift alone.

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

| 3 seeds per shape, epoch 40 | before | after |
|---|---|---|
| islands 1 000–10 000 km², torus / sphere | 20–28 / 4–18 | 22–38 / 24–46 |
| islands 10 000–100 000 km², torus / sphere | 3–7 / 2–5 | 5–12 / 10–19 |
| islands 100 000–1 000 000 km², torus / sphere | 0–3 / 1–6 | 2–5 / 2–4 |
| land on masses < 1 000 000 km², torus / sphere | 0.9–2.7 / 1.1–4.0 % | 2.2–4.7 / 3.7–5.3 % |
| land share, torus / sphere | 30.6–40.7 / 25.3–29.4 % | 32.0–43.9 / 26.5–31.1 % |
| land at −120 m, torus / sphere | +7.3–10.5 / +7.7–14.3 % | +6.2–9.9 / +7.6–13.8 % |

The land share grows by 1–3 points over the Land share control: arcs
beside a continent join it. The smallest class stays below Earth's: an
island under some 1 000 km² is a node or two at 8–31 km.

## Consequences

- The pipeline stays at `AMPLIFICATION_ALGO_VERSION` 14: v14 was never
  published. The tectonics' and the mesh's tuning move the pipeline's
  hash.
- The engine's fixtures of the coupled epoch, the replay and the world
  stages are recorded from the engine (rust-engine.md, fork 7c).

## Status

Built 2026-10-27.
