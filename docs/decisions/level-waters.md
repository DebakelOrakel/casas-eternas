---
id: DEC-0046
title.en: Level 1's waters and land fields
title.de: Wasser und Landfelder von Level 1
summary.en: Level 1 derives its waters from the save's climate, the one its
  tiles use, not from the last epoch's. Its artifact then carries the
  land fields per node that the ecology rule reads (biome, discharge,
  lakes, water table, salt, oases, craton age), packed to 16 bits. The
  incubator evaluates the rule on level 1's mesh through the WASM engine,
  so every overlay that depends on the terrain or the water stands on
  level 1.
summary.de: Level 1 leitet sein Wasser aus dem Klima des Saves ab, dem seiner
  Kacheln, nicht aus dem der letzten Epoche. Sein Artefakt trägt danach
  die Landfelder pro Knoten, die die Ökologie-Regel liest (Biom, Abfluss,
  Seen, Grundwasser, Salz, Oasen, Kratonalter), auf 16 Bit gepackt. Der
  Inkubator wertet die Regel über die WASM-Engine auf dem Netz von
  Level 1 aus, so dass jedes Overlay, das vom Gelände oder vom Wasser
  abhängt, auf Level 1 steht.
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
climate. The job passes the save's climate per cell of its field mesh
(`ClimateCellValues`, as the tiles get it) to `Replay.level`. Without it
the engine takes the last epoch's, as before.

Consequence: level 1's rivers and lakes change for an unchanged world (on
the smoke test's small worlds 77 → 83 rivers on the torus, 52 → 50 on the
sphere), and with them every tile. `AMPLIFICATION_ALGO_VERSION` goes to
13, so the pipeline goes to `v13`. The worlds do not change: v12 and v11
worlds read as v13's (`SAME_WORLDS_AS`), and need a new level-1 job. The
artifact key does not need more: the save's climate is in the world id
(`deriveWorldId`).

## Fork 2 — fields or inputs in the artifact: DECIDED — inputs

- **A. The ecology fields.** The fourteen fields per node, evaluated in
  the job. Simple to read, but the incubator cannot apply the ecology's
  sliders, and it stores results, against DEC-0030.
- **B. The inputs of the rule.** The land fields per node the rule reads
  (`EcologyInputs`): biome, discharge, lake depth, water table, salt flat,
  oases, craton age; the volcanoes and the orogen points as lists. The
  incubator evaluates the rule with the save's climate and sliders.

**B**, as DEC-0030 does for the save. It needs one new WASM function: the
rule on a given mesh with given inputs. The rule does not change.

## Fork 3 — packing: DECIDED — 16 bits, measured first

8.3 M nodes (Morvane): a field as f32 is 33 MB. Packed to 16 bits:

| Field | Encoding |
|---|---|
| Discharge | logarithmic over its range: some 0.04 % relative a step |
| Lake depth | linear, 5 cm a step |
| Water table | linear, 10 cm a step |
| Craton age | linear, 0.1 Ma a step |
| Biome, salt flat | u8 as they are |

The scales are set from the ranges of the first level-1 artifact, not
assumed. The check: the ecology from f32 inputs against the ecology from
the packed ones, as DEC-0030 step 2 did for the save (the share of nodes
that differ by more than 0.05).

## Build order

1. **Level 1 from the save's climate.** `Replay.level(saved)` in the
   engine, the job passes the save's climate, version 13. BUILT
   2026-10-25.
2. **The land fields in the artifact.** The job runs the hydrology's
   features at level 1's scale (the river courses at level 1's cell size,
   as `level_hydrology` does) and writes the inputs of fork 2, packed.
3. **The rule in WASM.** The ecology on level 1's mesh with the
   artifact's inputs, the save's climate and the save's sliders.
4. **The incubator.** The terrain colour from level 1's biomes; the
   carrying capacity and the arable land as overlays.

## Status

decided 2026-10-25; step 1 built the same day (the engine smoke test
replays level 1 from the save's climate: the same terrain, its own
rivers). Steps 2–4 open.
