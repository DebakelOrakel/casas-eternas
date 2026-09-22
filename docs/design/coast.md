---
summary: A coastal process for the coupled terrain history — sea level per epoch from the climate history, wave erosion at the shore iso-line with cliffs and platforms, one-dimensional sediment transport along the coast graph for spits, barriers and beaches, a shore generator below the resolution. Rias, drowned valleys, fjords and terraces come free from decisions already taken; the process adds what the sea itself shapes. A classification forerunner (coast type per reach, no physics) comes first.
date: 2026-09-22
area: generator
stage: idea
status: sketched 2026-09-22 after the adaptive-mesh decision; wanted, not decided, after the glacial process. Tides deferred — they need a moon, a Planet-stage parameter to look at later. Nothing built. Today a coast is the sea-level iso-line and nothing else.
---

# The coast as a process

Today a coast is where the terrain crosses sea level. No cliffs, no wave
erosion, no spits or barrier islands, no sea-level change — so no rias,
drowned valleys or terraces (rias were deferred on purpose). This doc
sketches the coastal process in the frame of
[decisions/adaptive-mesh.md](../decisions/adaptive-mesh.md), after the
ice of [glacial.md](./glacial.md), which it follows in the build order.

## What comes free

Half of the gap is already paid for. Sea level per epoch comes from the
climate history of decision 13 (ice volume); relative uplift per node
from decision 5 (flexure, rebound, tectonics). The sea is then a water
level like a lake (decision 9), global and with a history. Rias and
drowned valleys stop being coastal forms: a river valley cut during a
low stand and flooded at the high stand, erosion on the mesh plus the
iso-line. Fjords come from the ice. What is missing is everything the
sea itself shapes.

## The process, in two layers like the river

**Field: wave erosion per epoch at the shore iso-line.** Retreat rate =
wave energy over rock hardness. Wave energy from the fetch — the open
water in the wind direction — and the wind field exists. The sea cuts a
platform down to the wave base (order ten metres); the rest becomes a
cliff, which is a steep gradient at the shore, not a geometry of its
own. Terraces appear where uplift and stands overlap, with no rule.

**Graph: the coast is an iso-line from decision 10 and gets reaches with
attributes like a river** — exposure, sediment budget, type (cliff,
beach, marsh, delta). On it a one-dimensional sediment transport along
the line: direction from the angle between wave and shore normal,
capacity from the energy, supply from cliff retreat and river mouths.
Where capacity drops it deposits: spits, barrier islands, tombolos,
beaches in bays. This is the one-line model (Pelnard-Considère), cheap
and well understood, and it runs on the graph, not on the mesh.

**Below the resolution: a shore generator** like the river-course
generator, shaping beach profile, dune belt, lagoon and sea stacks from
the reach attributes. Mangroves and marshes are biomes from attributes
(low energy, fine sediment, warm).

## Detail

Coastal forms are small, tens to hundreds of metres. The tile makes them
as synthesis from the graph, with the cliff profile from the
erodibility. No transient is needed here.

## Forerunner, any time

Classification without process: exposure from wind and fetch, hardness,
sediment supply from the river graph, from those the coast type per
reach and its drawing (cliff or beach). As with the ice: the picture
first, the physics after.

## Forks for the decision session

- Transport one-dimensional on the graph, or two-dimensional on the
  mesh.
- Sea level as a global scalar plus relative uplift, or as a field.
- The wave base.
- Tides. They need a moon — a Planet-stage parameter (mass, distance):
  tidal range, flats, tidal creeks only with one. Deferred 2026-09-22;
  to be looked at later, not part of this process's first decision.

## Order

Glacial before coast: ice changes the mountains one looks at all the
time, and the coast takes its eustasy from the same climate history.

## Related

- [decisions/adaptive-mesh.md](../decisions/adaptive-mesh.md) — the
  water levels (9), the graph (10), the coupling (5), the climate
  history (13).
- [glacial.md](./glacial.md) — fjords, and the ice volume behind the
  sea level.
