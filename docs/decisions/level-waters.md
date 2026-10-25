---
id: DEC-0046
title.en: Level 1's waters and land fields
title.de: Wasser und Landfelder von Level 1
summary.en: Level 1 runs the generator's stages on the world at its replay's
  end, so its waters come from the save's climate, the one its tiles use,
  not from the last epoch's. Its artifact carries the land fields per
  node that the ecology rule reads (biome, discharge, lakes, water table,
  salt, oases, craton age), packed to 16 bits, and the ecology's fourteen
  fields under the save's sliders, a byte a node. The incubator reads
  them, so every overlay that depends on the terrain or the water stands
  on level 1.
summary.de: Level 1 rechnet am Ende seines Replays die Stufen des Generators,
  so dass sein Wasser aus dem Klima des Saves kommt, dem seiner Kacheln,
  nicht aus dem der letzten Epoche. Sein Artefakt trägt die Landfelder pro
  Knoten, die die Ökologie-Regel liest (Biom, Abfluss, Seen, Grundwasser,
  Salz, Oasen, Kratonalter), auf 16 Bit gepackt, und die vierzehn
  Ökologiefelder unter den Reglern des Saves, ein Byte pro Knoten. Der
  Inkubator liest sie, so dass jedes Overlay, das vom Gelände oder vom
  Wasser abhängt, auf Level 1 steht.
area: generator
stage: building
createdAt: 2026-10-25
updatedAt: 2026-10-25
related: [DEC-0030, DEC-0032, DEC-0045]
---

## Where this starts

The incubator shows level 1 (the history replayed at level 1's density,
[detail-ladder.md](./detail-ladder.md) fork 2) on the generator's globe.
Its overlays came from the save, at level 0: the biomes spread over level
1's coast, and the catchments and the species read the save's discharge
on the world raster. On Morvane (2026-10-25) only 17 % of level 1's river
points lie on a world cell that the save's discharge calls a river. The
overlays do not agree with the terrain and the rivers on the screen.

[DEC-0030](./ecology-as-function.md) says the ecology is a local rule,
evaluated at the resolution one looks at. The engine evaluates it per
node of a mesh (`prepare_ecology`), so the rule can run on level 1's mesh
as it is. What is missing are its inputs at level 1's nodes.

How level 1 gets its waters today (`casas-engine-api/src/replay.rs`,
`ReplayRuns::level`): after the last epoch, once, `level_hydrology` on the
final terrain, its routing and sediment flux, and **the last epoch's
climate**. The artifact keeps the lakes, the river graph and the river
lines. The discharge per node is computed and dropped. The water table,
the salt flats, the oases and the biomes per node are not computed: in
the generator they come from the hydrology stage (`hydrology_features`),
which level 1 does not run.

The tiles of levels 2 and 3 derive their waters from **the save's
climate** (`mesh_tile_bake`, `climate_cells_from_saved`). Level 1 and its
tiles used two climates.

## Fork 1 — level 1's climate: DECIDED — the save's

- **A. The last epoch's** (as built). The climate of the epoch loop, not
  the save's refined one. The tiles continue rivers that come from
  another climate.
- **B. The save's.** The climate the save's own waters, the generator's
  overlays and the tiles are derived from.

**B.** Level 1's waters, its land fields and its tiles then stand on one
climate.

How (step 2, 2026-10-25): the job takes the world at the replay's end
(`Replay.world`) and runs on it the stages a load runs in the generator —
the render, the climate under the last run's weather, the **save's
refinement** restored, the hydrology with its features — then
`World.levelArtifact`. Level 1's waters are then the generator's
hydrology on level 1's mesh: the same discharge and lakes, the river graph
with the biomes and the months' regime, the hydrogeology (water table,
springs, oases). The river courses take the same cell size as
`level_hydrology` did: `level_budget(1)` is 1. A first form (step 1, the
same day) passed the save's annual climate to `level_hydrology`; the
stages replaced it, because the land fields need the refinement's months
and the hydrology's features. `Replay.level` stays, with the last
epoch's climate, to compare the artifacts made before.

Consequence: level 1's rivers and lakes change for an unchanged world (on
the smoke test's small worlds 264 → 212 reaches on the torus, 185 → 108 on
the sphere), and with them every tile. `AMPLIFICATION_ALGO_VERSION` goes to
13, so the pipeline goes to `v13`. The worlds do not change: v12 and v11
worlds read as v13's (`SAME_WORLDS_AS`), and need a new level-1 job. A
world without a refinement is refused before the replay. The artifact key
does not need more: the save's climate is in the world id
(`deriveWorldId`).

## Fork 2 — fields or inputs in the artifact: DECIDED — both

- **A. The ecology fields.** The fourteen fields per node, evaluated in
  the job under the save's sliders. Simple to read; the incubator cannot
  move the sliders.
- **B. The inputs of the rule.** The land fields per node the rule reads
  (`EcologyInputs`): biome, discharge, lake depth, water table, salt flat,
  oases, craton age; the volcanoes and the orogen points as lists. The
  incubator evaluates the rule with the save's climate and sliders.

First answered **B** (the morning of 2026-10-25), as DEC-0030 does for the
save. Answered again the same day: **A and B**. The rule's state at level
1's 8.3 M nodes does not fit a browser: the mesh some 0.5–0.8 GB, the
climate per node with its months 0.3–0.8 GB, the raw fields 0.47 GB, the
seasonal ones 0.3–0.7 GB — 1.5–3 GB of WASM memory beside the incubator's
textures, where Safari already reloaded the page for its memory. The job
runs the ecology natively (`World.ecology` under the save's sliders,
`world/runParams.ecologyParamsFrom`), and the artifact carries its
fourteen fields a byte a node, as the generator's fine fields are coded
(`encode_fine_field`): 116 MB at level 1. The sliders are set in the
generator, not in the incubator. The inputs stay in the artifact too: a
tile level can evaluate the rule at its own resolution, as DEC-0030 means
it. Not against DEC-0030: the save stays the authority and carries the
inputs; the level is derived, and made again from it at any time.

## Fork 3 — packing: DECIDED — 16 bits, measured first

8.3 M nodes (Morvane): a field as f32 is 33 MB. Packed to 16 bits
(`formats::land_codes` in the engine), the scales set from the ranges of
Morvane's land fields (2026-10-25, the stages on its save at level 0,
365 k nodes, as a stand-in for level 1):

| Field | Range measured | Encoding | Worst error back |
|---|---|---|---|
| Discharge (engine units) | 2.7 … 2.2 · 10⁷ | 0 none, else logarithmic over 10⁻³ … 10¹⁰ | 0.023 % |
| Lake depth (elevation units) | to 0.46 | linear over 0 … 1 (14 cm a step) | 7.6 · 10⁻⁶ (7 cm) |
| Water table (m) | 0 … 6 146, −1 under water | 25 cm a step to 16 383.5 m, the top code −1 | 0.125 m |
| Craton age (share) | −1 … 0.76 | linear over −1 … 1 | 1.5 · 10⁻⁵ |
| Land, biome, Köppen, salt flat | bytes | as they are | none |
| Oases, volcanoes, orogen points | lists | doubles | none |

The log and the exp are the engine's own (`det_math`), so the native
build and WASM write the same codes (the smoke test compares the files).
On Morvane the land fields are 4.4 MB at level 0; at level 1's 8.3 M
nodes some 100 MB. The ecology in the artifact is evaluated in the job on
the f32 inputs (fork 2), so the packing does not reach it; it reaches a
tile level that evaluates the rule on the packed inputs, and is checked
there when one does.

## Seen on the way: the water table — not changed

58 % of Morvane's land nodes have the water table at 0 m: 78 % of its
desert, 82 % of its steppe, 89 % of its tropical rainforest (on the world
raster too). A matter of the hydrogeology, not of the packing.

The cause (`surface/hydrogeology.rs`): the table starts at the nearest
water downstream and rises with the flow distance by
`aquifer_rise_base` = 0.05 m a metre (50 m a km) on tight ground at
1 000 mm of rain, scaled by the recharge — still some 3.4 m a km in a
desert of 100 mm on bedrock. Most plains and hills rise slower than that,
so the table comes out above the ground and is cut to 0. Only 10 % of the
nodes at 0 m lie in a filled depression. The tuning says of these numbers
"all unmeasured". On the Earth a table shallower than some 5 m holds on
about a quarter of the land, and a desert's lies tens to hundreds of
metres down (Fan, Li and Miguez-Macho 2013, Science 339, 940–943).

What it does to the ecology (`ecology/ecology_field.rs`): a table within
`well_depth_m` (30 m) is a well, water for the herds, so the dry lands'
pasture is hardly cut, and the carrying capacity of the deserts is too
high. A table at 0 m is waterlogged ground, so bog iron is far too
common in the humid lowlands. The arable land, the fish, the game, the
timber, the springs and the oases do not read the table.

The way out, when the engine's freeze allows a change to its tuning:
calibrate `aquifer_rise_base` against Fan et al. (the share of the land
with a shallow table, the depths by climate). It changes no world, only
the hydrology's products, and so the level-1 artifacts: a pipeline
version.

## Build order

1. **Level 1 from the save's climate**, version 13. BUILT 2026-10-25
   (first through `Replay.level`, then through the stages of step 2).
2. **The land fields in the artifact.** The job runs the generator's
   stages on the world at the replay's end and writes
   `World.levelArtifact`: the waters and the inputs of fork 2, packed.
   BUILT 2026-10-25.
3. **The ecology in the artifact** (fork 2, answered again): the job runs
   the ecology under the save's sliders, the artifact carries its
   fourteen fields. BUILT 2026-10-25. (The rule in WASM, the step this
   replaced, went with fork 2's first answer.)
4. **The incubator.** The terrain colour from level 1's biomes (the
   map's, with the ice model's glaciers, as the save's `mesh/biome.u8`;
   the artifact carries the ecology's own beside them); the carrying
   capacity and the arable land as overlays, read per node through a map
   of the node each texel shows. BUILT 2026-10-25; on Morvane's save at
   level 0 the biomes per node are the save's on every node, on 99.2 % of
   the land texels.

## Status

decided 2026-10-25; steps 1–3 built the same day. The engine smoke test
makes level 1 as the job does — the stages on the replay's world, the
ecology, the artifact with its land and ecology fields — resumes it from a
checkpoint to the same artifact, bakes tiles on it, and writes and reads
its files alike in both builds. On Morvane's save at level 0 the ecology
takes 1.0 s for 365 k nodes. Step 4 built the same day. No level 1 of a
real world made yet.
