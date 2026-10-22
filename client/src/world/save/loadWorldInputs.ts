import { openWorld, waterBodiesOf, type SavedMesh, type WorldEngine } from '../query'
import type { PlateSimulationSnapshot } from '../../generator/tectonics/plateSimulationTypes'
import type { WorldKind } from '../worldRecord'
import type { SavedClimate } from './climateFields'
import type { World } from '../query'
import type { WaterBody } from '../../generator/surface/hydrology'
import type { WorldHistory } from './worldHistory'

// Reading a saved world through the QUERYABLE side of its .zip — manifest.json
// plus the meshes' values and the tables (docs/decisions/queryable-world-save.md),
// through world/query.ts, which makes the rasters a bake reads (the elevation
// from the mesh, the forcing from the snapshot; DEC-0036's save step).
//
// Extracted from the world map screen when the SERVER learned to bake (that
// screen was removed 2026-09-20; the reader was always the durable half). That
// is not tidiness: the server-side baker has to read a save byte-for-byte the way the
// browser does, because both write artifacts under a key derived from what
// they read. Two readers that drift by one decoded layer would produce two
// different worldIds for one world, and the cache would serve terrain from a
// world that does not exist. One reader cannot drift from itself.
//
// Free of DOM and of any screen: this is the layer the bake pipeline shares
// between browser and Node, and keeping it that way is what lets the same code
// run in both.

// The manifest's layer entry: since DEC-0036's save step only tables
// (kind 'table') — the save holds no raster layer.
export interface WorldManifestLayer {
  name: string
  file: string
  kind: string
}

export interface WorldManifest {
  world: { width: number; height: number }
  layers: WorldManifestLayer[]
}

export interface GridLayer {
  data: Float32Array
  resX: number
  resY: number
}

// The world's own erosion settings, so a bake erodes the way the world was
// eroded rather than by generic defaults. Undefined means the save predates
// the setting; the pipeline falls back to its own default.
export interface ErosionControls {
  // The v2 engine's controls. The generator and the amplification bake both
  // apply these; undefined (an old save) falls back to the declared defaults.
  // (v1's strength/refresh were read here until the P5 teardown — an old
  // save's lines are ignored the usual partial-spec way now.)
  landscapeAge: number | undefined
  alluvium: number | undefined
  rockContrast: number | undefined
}

// What the job worker reads of a save: the recipe, and the save's own
// payloads as it holds them — the engine derives the seeds, the forcing
// and the raster from them (DEC-0044, fork 7b; until 2026-10-22 they were
// derived here).
export interface WorldInputs {
  // The world's shape (world.yaml's kind).
  kind: WorldKind
  width: number
  height: number
  seedText: string
  // The runs that made the world (worldHistory.ts), for level 1's replay,
  // and the pipeline that made them (worldPipeline.ts; '' for none).
  history: WorldHistory
  pipeline: string
  erosionControls: ErosionControls
  // The climate per cell of its field mesh (climateFields.ts, DEC-0036
  // phase 7): the precipitation drives the discharge in the bake's
  // hydrology re-run AND the engine's water forcing contrast, the
  // temperature re-floods the basins (evaporation decides which stay wet),
  // the monsoon index judges the rivers' regime — each sampled at the
  // bake's own nodes (climate/climatePoints.ts). Absent for a world saved
  // before climate was computed; the bake then stops after erosion.
  climate: SavedClimate | null
  // The save's standing water (ADAPTIVE_MESH_PLAN.md phase 1): the bodies
  // the water body per node indexes (mesh/lakeBody.i32), from which
  // world.acquire('lakeDepth') draws the lakes. Null for a save without
  // one (before its hydrology ran).
  waterBodies: WaterBody[] | null
  // The adaptive mesh (phase 4.3), the terrain the mesh bake refines; null
  // for a save without one.
  mesh: SavedMesh | null
  // The tectonic state (`state.json`), as the save holds it: the job
  // worker hands it to the engine, which derives the forcing from it
  // (DEC-0044, fork 7b). Null without one.
  snapshot: PlateSimulationSnapshot | null
  // What the bake actually consumes, hashed — the artifact key. Derived here
  // rather than by the caller so every reader of a save agrees on it.
  worldId: string
  // The world's own identity in the server's store, `metadata.uid`. The OTHER
  // half of the pair world/identity.ts keeps deliberately side by side: worldId
  // moves whenever the terrain does, worldUid never moves at all. Ordering a
  // bake needs this one, because the server addresses worlds by what you named
  // and own, not by what the terrain currently hashes to.
  //
  // Empty for a save written before the field existed. Deliberately NOT
  // derived as a fallback the way the generator does when RESTORING a legacy
  // world: there the derivation seeds an identity that is then written down,
  // while here it would be used to address a stranger's server. A uid guessed
  // from a different byte source than the one that was uploaded points at
  // another world or at nothing, and both are worse than admitting the save is
  // too old and asking for it to be saved again.
  worldUid: string
}

// Kept as the shape the bake pipeline and both screens already speak. It is now
// a PROJECTION over `world/query.openWorld` rather than a second reader of the
// same archive — one open, one parse, one derivation of the id. Two readers of
// one file is exactly the drift this module's own header warns about.
export async function readWorldInputs(archive: ArrayBuffer | Uint8Array, engine: WorldEngine): Promise<WorldInputs | null> {
  const world = await openWorld(archive, engine)
  return world ? worldInputsFrom(world) : null
}

// The projection itself, for a caller that has already opened the world and
// wants to KEEP it — the world map registers amplified tiers against it and
// acquires fields from it, and opening the same archive twice to get both would
// be the double parse this whole layer exists to remove.
export async function worldInputsFrom(world: World): Promise<WorldInputs | null> {
  const waterBodies = waterBodiesOf(await world.table('waterBodies'))

  return {
    kind: world.kind,
    width: world.width,
    height: world.height,
    seedText: world.recipe.seedText,
    history: world.recipe.history,
    pipeline: world.recipe.pipeline,
    erosionControls: world.recipe.erosionControls,
    climate: await world.climate(),
    waterBodies,
    mesh: await world.mesh(),
    snapshot: await world.snapshot(),
    worldId: await world.worldId(),
    worldUid: world.recipe.worldUid,
  }
}
