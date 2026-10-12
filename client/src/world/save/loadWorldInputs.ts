import type { Dtype } from './worldLayers'
import { openWorld, type SavedMesh } from '../query'
import type { SavedClimate } from './climateFields'
import type { World } from '../query'
import type { WaterBody } from '../../generator/surface/hydrology'
import type { WorldHistory } from './worldHistory'

// Reading a saved world through the QUERYABLE side of its .zip — manifest.json
// plus the baked layers (docs/decisions/queryable-world-save.md), deliberately
// not through the generator's snapshot.
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

// The manifest's self-describing layer entry. `dtype`/`encoding` carry the
// quantisation, so a reader never has to know what a layer "usually" is.
export interface WorldManifestLayer {
  name: string
  file: string
  kind: string
  resX?: number
  resY?: number
  dtype?: Dtype
  encoding?: { scale: number; offset: number }
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

export interface WorldInputs {
  elevations: Float32Array
  width: number
  height: number
  seedText: string
  // The runs that made the world (worldHistory.ts), for level 1's replay.
  history: WorldHistory
  // Seed for the deterministic near-field detail and for the bake's seed
  // roughness. It IS the generator's warpSeed (salted), derived from the
  // recipe's seed rather than stored — see world/query.openWorld.
  detailSeed: number
  // Seed of the erosion engine's lithology lattice (see world/query.ts) —
  // derived from the recipe like detailSeed, present for every save.
  lithoSeed: number
  erosionControls: ErosionControls
  // The erosion engine's coarse forcing, from the save's forcing layers
  // (docs/design/erosion-v2.md, P3). Null for a save written before the
  // layers existed — the bake then erodes with neutral forcing (no uplift,
  // lithology-only rock contrast), a deliberate hard break.
  uplift: GridLayer | null
  erodibility: GridLayer | null
  // The climate per cell of its field mesh (climateFields.ts, DEC-0036
  // phase 7): the precipitation drives the discharge in the bake's
  // hydrology re-run AND the engine's water forcing contrast, the
  // temperature re-floods the basins (evaporation decides which stay wet),
  // the monsoon index judges the rivers' regime — each sampled at the
  // bake's own nodes (climate/climatePoints.ts). Absent for a world saved
  // before climate was computed; the bake then stops after erosion.
  climate: SavedClimate | null
  // Water depth per world cell (elevation units), 0 where there is no lake —
  // a hydrology state the worldmap paints and cannot re-derive. Absent for a
  // save that predates the layer. Not part of the worldId: the id hashes its
  // own fixed set of fields, so reading one more layer moves nothing.
  lakeDepth: GridLayer | null
  // The basins behind that layer (ADAPTIVE_MESH_PLAN.md phase 1): the save's
  // standing-water truth, from which lakeDepth and every shore derive
  // (hydrology.lakeDepthFromBodies, waterLevelField). Null for a save written
  // before the list existed (manifest formatVersion 1).
  waterBodies: WaterBody[] | null
  // The adaptive mesh (phase 4.3), the terrain the mesh bake refines; null
  // for a save without one.
  mesh: SavedMesh | null
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
export async function readWorldInputs(archive: ArrayBuffer | Uint8Array): Promise<WorldInputs | null> {
  const world = await openWorld(archive)
  return world ? worldInputsFrom(world) : null
}

// The projection itself, for a caller that has already opened the world and
// wants to KEEP it — the world map registers amplified tiers against it and
// acquires fields from it, and opening the same archive twice to get both would
// be the double parse this whole layer exists to remove.
export async function worldInputsFrom(world: World): Promise<WorldInputs | null> {
  const elevation = await world.acquire('elevation')
  if (!elevation) return null

  const uplift = await world.acquire('uplift')
  const erodibility = await world.acquire('erodibility')
  const lakeDepth = await world.acquire('lakeDepth')
  const bodiesRaw = await world.table('waterBodies')
  const waterBodies = Array.isArray(bodiesRaw) && bodiesRaw.every((b) => typeof b === 'object' && b !== null && typeof (b as WaterBody).level === 'number' && typeof (b as WaterBody).spill === 'number')
    ? (bodiesRaw as WaterBody[])
    : null

  return {
    elevations: elevation.data,
    width: world.width,
    height: world.height,
    seedText: world.recipe.seedText,
    history: world.recipe.history,
    detailSeed: world.recipe.detailSeed,
    lithoSeed: world.recipe.lithoSeed,
    erosionControls: world.recipe.erosionControls,
    uplift,
    erodibility,
    climate: await world.climate(),
    lakeDepth,
    waterBodies,
    mesh: await world.mesh(),
    worldId: await world.worldId(),
    worldUid: world.recipe.worldUid,
  }
}
