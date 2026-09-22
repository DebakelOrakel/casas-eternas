---
summary: An ice model for the coupled terrain history — mass balance from the per-epoch climate, shallow-ice flow on the macro mesh, erosion with sliding speed, till as a sediment layer, moraine-dammed lakes from the water-level model. Same history/detail split as the fluvial erosion; ice flux counts as discharge in the density rule. A forerunner without erosion (ice thickness on the bake's final terrain) replaces today's fake glaciers first.
date: 2026-09-22
area: generator
stage: idea
status: sketched 2026-09-22 after the adaptive-mesh decision; wanted, not decided. Its forks are listed at the end for a session of its own after step 5 of decisions/adaptive-mesh.md. The forerunner is BUILT 2026-09-22 (surface/iceFlow.ts — ice thickness on the final terrain by balance-flux inversion, in the bake and at 2048; ADAPTIVE_MESH_PLAN.md F4); the process is not. Ice as a climate class (Ice below −10 °C) and Glacier as a frozen lake stay until the process replaces them.
---

# Ice as a process

Today's glaciers are fake: `Biome.Ice` is a temperature threshold and
`Biome.Glacier` a frozen basin. Real mountains are shaped by ice as much
as by rivers, and every high range in the generator looks fluvial. This
doc sketches the ice model as an epoch process on the macro mesh of
[decisions/adaptive-mesh.md](../decisions/adaptive-mesh.md), in the
same loop as the erosion and with the same split of history and detail.

## Forcing

Per epoch the coarse climate (decision 13) gives temperature and
precipitation. From them the equilibrium line altitude (ELA) per node:
the height above which accumulation exceeds melt. The mass balance per
node is linear in the height above the ELA, clamped, with precipitation
as the accumulation factor. Ice ages are nothing separate: when the
planetary schedule cools the world the ELA drops by hundreds to a
thousand metres and ice appears where there was none.

## Flow

Shallow-ice approximation. Ice thickness `H` is a node state; the flux
along an edge goes with `H^5` and the surface slope (surface = rock plus
ice, Glen's n = 3). That is a nonlinear diffusion on the same edge and
Voronoi structure the hillslope kernel already uses. Ice equilibrates
in millennia and an epoch is millions of years, so each epoch iterates
the ice to steady state under that epoch's climate rather than
resolving time.

## Erosion

Glacial erosion goes with the basal sliding speed, which follows from
thickness times slope. The forms fall out of that rule:

- **Troughs** where thick ice flows through a river valley — the cross
  section becomes a U because the erosion is largest on the floor.
- **Overdeepenings** where ice converges.
- **Cirques** at the ice margin near the ELA, with an extra erosion
  peak there (the glacial buzzsaw: summits are planed towards the ELA).
- **Fjords** need no rule: a trough that reaches the coast and goes
  below sea level is one as soon as the eustasy of decision 13 brings
  the sea back.

## Sediment

Eroded rock becomes till, travels with the ice and is deposited at the
terminus as a moraine — a layer with glacial provenance in the
stratigraphy of step 5. Meltwater carries the rest into the river
network as outwash. A terminal moraine dams the trough after the ice
retreats; the water-level model of decision 9 fills it, and the
piedmont lakes come out the way the real ones did.

## Interaction

Under ice the fluvial erosion rests; rivers are routed around the ice
margin; meltwater raises the discharge at the terminus. The ice mass is
a load in the flexure of decision 5, so glacial rebound and raised
shorelines come for free.

## History and detail

The macro mesh decides what is where: ice extent, troughs, moraines,
lakes. The tile forms what lies between: cirque walls, the trough
profile, roches moutonnées and striations as synthesis. The tile does
it as the river does: parent thickness fixed at the border, a short ice
run on the inserted nodes.

**No finer mesh, but the rule must see the ice.** Ice flux counts as
discharge in the density rule's second term, so a glaciated valley
densifies between epochs the way a trunk river does, and the curvature
term densifies the trough walls. When the ice retreats the hysteresis
thins the mesh again; only the moraine stays fine, through the column
term. One condition on the constants, measured when built: a trough is
two to five kilometres wide and needs three or four nodes across for
its floor to become a U, so the minimum spacing in glaciated orogens is
about a kilometre, not the four assumed for orogens in general. The
cost is bounded: alpine glaciation is a small share of the land, and
ice sheets are flat and need no density.

A cirque is not resolved by the macro mesh and does not need to be: its
place is a node at the ice margin near the ELA, an attribute, not a
form.

## The present

At the end of the history the ice of the last climate stands as a
thickness per node. Glaciers and ice sheets are drawn from `H`, not
from a temperature threshold; `Biome.Ice` as a climate class goes, and
the snowline is the ELA.

## Forerunner, any time, in the bake

The ice flow without erosion, once on the final terrain with the final
climate: real glacier thickness instead of the fake ones, lying in the
valleys, with tongues. No mesh, no epoch loop, one flow-rate amplitude.
The first visible step and the test of the flow model. It belongs in
the bake, not in the generator view: at 2048 (7.8 km per cell) the flow
sees only ice sheets and the largest valley glaciers; alpine glaciers
appear from the 4K/8K bake at one to two kilometres.

## Forks for the decision session

- Steady state per epoch, or sub-steps within the epoch.
- Cirques through an ELA band in the erosion rule, or as a feature at
  the glacier head in the graph.
- Whether ice may rebuild the river network's topology (overdeepenings
  reverse the gradient).
- Ice in the tile as a transient, or as synthesis only.
- No sliders: the forcing comes from the Planet stage. To confirm.

## Related

- [decisions/adaptive-mesh.md](../decisions/adaptive-mesh.md) — the
  mesh, the coupling (5), the climate history (13), the water levels (9).
- [adaptive-mesh.md](./adaptive-mesh.md) — the processes noted for later;
  the coast process shares the eustasy with this one.
