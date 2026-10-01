---
summary: The world save holds three things with three different lifetimes — the recipe, a snapshot to continue from, and the queryable layers of level 0. The recipe is the authority; the snapshot is a cache tied to the code that wrote it; the queryable layers become one artifact per level of the detail ladder, in one format, and the save keeps level 0's. Identity of a replayed level is the recipe and the code, not the level-0 rasters.
date: 2026-10-01
area: platform
stage: decided
status: decided 2026-10-01 — the four changes, in the order listed; the monthly and weather layers stay in the save. 1 and 3 built 2026-10-01 with level 1's replay; 2 and 4 open. Extends decisions/world-save-format.md and decisions/queryable-world-save.md; follows from decisions/detail-ladder.md (fork 2).
---

# The roles in the world save

## Where this starts

The save (decisions/world-save-format.md, formatVersion 7) is one `.zip`.
It holds three things, written together, read by different consumers:

| Role | In the zip | Who reads it |
|---|---|---|
| Recipe — make the world again | `world.yaml`: `spec` and the `history:` block | a replay (detail-ladder.md, fork 2) |
| Snapshot — continue the world | `state.json`, `mesh/` (`column.bin` alone is ~23 MB of ~53 MB), `mantle.f32`, `lattice.*`, `oceanAge.f32` | the generator, after a load |
| Queryable layers — look a value up | `elevation.f32`, `layers/*` (~70 files), `manifest.json` | the map, the incubator, a game server (queryable-world-save.md) |

The detail ladder changes what each of these is worth. Level 1 replays the
whole history at budget 1, and levels 1 to 3 are the world; level 0 is the
preview. So:

- The recipe is the only part every level comes from. Today it reads as an
  appendix to the snapshot.
- The snapshot continues the world only with the code that wrote it. Today
  a load tries anyway.
- The queryable layers are level 0's. A consumer that looks a value up gets
  the preview, while the world it is meant to see is in the artifact store.
- The artifact key's `worldId` hashes the quantised level-0 rasters and the
  mesh (world/identity.ts). A replayed level does not come from those bytes.

## The decision

Not a new format: four changes to the existing one, in this order. Old
worlds are made again rather than migrated — the engine is still changing
fast (the user, 2026-10-01).

1. **The recipe is the authority.** `world.yaml` with `spec`, `history:`
   and the code hash of each run (world/save/worldHistory.ts,
   `virtual:generator-code`). Everything else in the save is derived and may
   go stale; nothing derived may override it.
2. **The snapshot is a cache, keyed by the code.** The save records the
   code hash it was written with. A load with other code does not continue
   from the snapshot: it shows the world (the layers are still true), and a
   further run starts from the recipe. Today a load continues regardless.
3. **A replayed level is keyed by recipe and code.** The artifact key of a
   level made by replay must name the recipe and the code, not only the
   level-0 bytes. *Resolved with step 4 (2026-10-01) without a new key:*
   the replay refuses a world whose recorded code is not its own, so the
   save's `worldId` — whose bytes that code wrote — already names one
   recipe and one code. The rule "never bake from the live rasters, always
   through the save" (the quantisation trap) does not apply to such a
   level: it reads the recipe, not the rasters.
4. **Queryable layers per level, as artifacts.** Level 0's layers, level
   1's, and the tiles of levels 2 and 3 carry one manifest format and one
   sampling contract. A reader asks for a value at a point on the finest
   level present. The save keeps level 0's layers and the preview, so a
   world opens at once and offline; the finer levels live in the artifact
   store.

Order: 1 and 3 came with build step 4 of the ladder (level 1 by replay,
2026-10-01); 2 next — it changes what a load does, so the generator
screen's side is asked first; 4 when levels 2 and 3 carry layers.

## What stays

- **The monthly and weather layers stay in the save** (decided 2026-10-01).
  Without them a load runs the climate refinement again — 4.4 s on
  Astrakan (design/climate-refinement.md) instead of reading ~5 MB — and a
  game server could not look up a seasonal value without the climate code,
  which is the point of queryable-world-save.md.
- The zip, `manifest.json` describing each raster (dtype, encoding, unit),
  and the readable `world.yaml` in its `spec`/`status` shape.

## Not now

- `state.json`'s `features` is ~690 KB of JSON; a binary form would be
  smaller. Not needed yet.
- What a level's layers hold beyond elevation (discharge, biomes, water
  bodies) is for the levels to decide when they are built.
