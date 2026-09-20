import type { Dtype } from './worldLayers'
import { restoreLandOnlySentinel } from './worldLayers'
import { OCEAN_PRECIP } from '../../generator/climate/precipitation'
import { OCEAN_AMPLITUDE } from '../../generator/climate/seasonality'
import { openWorld } from '../query'
import type { World } from '../query'

// Reading a saved world through the QUERYABLE side of its .zip — manifest.json
// plus the baked layers (docs/decisions/queryable-world-save.md), deliberately
// not through the generator's snapshot.
//
// Extracted from WorldMapScreen when the SERVER learned to bake. That is not
// tidiness: the server-side baker has to read a save byte-for-byte the way the
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
  world: { width: number; height: number; topology: string }
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
  // Precipitation drives the discharge in the bake's hydrology re-run AND
  // the engine's water forcing contrast. Absent for a world saved before
  // climate was computed; the bake then stops after erosion.
  climate: GridLayer | null
  // Temperature on the same climate grid. The bake's hydrology re-run needs it
  // to re-flood the basins (evaporation decides which stay wet); rivers do
  // not. Its own field rather than a reach into `biomeInputs`, which describes
  // what the WHITTAKER classification consumes — the two happen to overlap and
  // are not the same requirement.
  temperature: GridLayer | null
  biome: GridLayer | null
  // Water depth per world cell (elevation units), 0 where there is no lake —
  // a hydrology state the worldmap paints and cannot re-derive. Absent for a
  // save that predates the layer. Not part of the worldId: the id hashes its
  // own fixed set of fields, so reading one more layer moves nothing.
  lakeDepth: GridLayer | null
  // Everything the Whittaker classification consumes, so a consumer can redo it
  // on ITS OWN terrain instead of upsampling the saved biome ids — which is how
  // the worldmap gets biomes that follow the amplification bake's ridges (see
  // climate/biomes.computeBiomesFine). All four or none: a partial set cannot
  // classify, and older saves predate `precipitationEffective` entirely.
  //
  // `precipitationEffective` rather than `climate` is the one that belongs here:
  // it carries the riparian bonus, so river corridors survive the reclassification
  // without the consumer owning a drainage network.
  biomeInputs: {
    temperature: GridLayer
    precipitationEffective: GridLayer
    seasonalAmplitude: GridLayer
    monsoonIndex: GridLayer
  } | null
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

  const climate = await world.acquire('precipitation')
  const uplift = await world.acquire('uplift')
  const erodibility = await world.acquire('erodibility')
  const biome = await world.acquire('biome')
  const lakeDepth = await world.acquire('lakeDepth')
  const temperature = await world.acquire('temperature')
  const precipitationEffective = await world.acquire('precipitationEffective')
  const seasonalAmplitude = await world.acquire('seasonalAmplitude')
  const monsoonIndex = await world.acquire('monsoonIndex')
  // The three land-only fields get their ocean sentinel back before anyone
  // classifies with them — see restoreLandOnlySentinel. `temperature` is not one
  // of them: it is meaningful over water (SST) and has no sentinel to restore.
  // A save too old to carry landMask is left as it was rather than guessed at.
  const landMask = await world.acquire('landMask')
  const restore = (layer: GridLayer, sentinel: number): GridLayer =>
    landMask ? { ...layer, data: restoreLandOnlySentinel(layer.data, landMask.data, sentinel) } : layer
  const biomeInputs = temperature && precipitationEffective && seasonalAmplitude && monsoonIndex
    ? {
      temperature,
      precipitationEffective: restore(precipitationEffective, OCEAN_PRECIP),
      seasonalAmplitude: restore(seasonalAmplitude, OCEAN_AMPLITUDE),
      monsoonIndex: restore(monsoonIndex, OCEAN_PRECIP),
    }
    : null

  return {
    elevations: elevation.data,
    width: world.width,
    height: world.height,
    seedText: world.recipe.seedText,
    detailSeed: world.recipe.detailSeed,
    lithoSeed: world.recipe.lithoSeed,
    erosionControls: world.recipe.erosionControls,
    uplift,
    erodibility,
    climate,
    temperature,
    biome,
    lakeDepth,
    biomeInputs,
    worldId: await world.worldId(),
    worldUid: world.recipe.worldUid,
  }
}
