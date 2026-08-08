import JSZip from 'jszip'
import { decodeLayer } from './worldLayers'
import type { Dtype } from './worldLayers'
import { readRecipeNumber, readRecipeValue } from './recipeYaml'
import { deriveWorldId } from '../../storage/artifactKey'

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
  strength: number | undefined
  refresh: number | undefined
  riverDensity: number | undefined
}

export interface WorldInputs {
  elevations: Float32Array
  width: number
  height: number
  seedText: string
  // Seed for the deterministic near-field detail, hashed from the recipe's
  // seed so the same world always grows the same bumps. NOT the generator's
  // warpSeed — see fineElevationSurface.
  detailSeed: number
  erosionControls: ErosionControls
  // Precipitation drives the discharge in the bake's hydrology re-run. Absent
  // for a world saved before climate was computed; the bake then stops after
  // erosion.
  climate: GridLayer | null
  biome: GridLayer | null
  // What the bake actually consumes, hashed — the artifact key. Derived here
  // rather than by the caller so every reader of a save agrees on it.
  worldId: string
  // The world's own identity in the server's store, `metadata.uid`. The OTHER
  // half of the pair artifactKey.ts keeps deliberately side by side: worldId
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

function readLayer(zip: JSZip, manifest: WorldManifest, name: string, landOnly: boolean): Promise<GridLayer | null> {
  const entry = manifest.layers.find((layer) => layer.name === name && layer.kind === 'raster')
  if (!entry?.dtype || !entry.encoding || !entry.resX || !entry.resY) return Promise.resolve(null)
  const file = zip.file(entry.file)
  if (!file) return Promise.resolve(null)
  return file.async('arraybuffer').then((buffer) => ({
    data: decodeLayer(buffer, { name, dtype: entry.dtype!, scale: entry.encoding!.scale, offset: entry.encoding!.offset, unit: '', landOnly }),
    resX: entry.resX!,
    resY: entry.resY!,
  }))
}

// Null when the archive is not a readable world — a missing manifest or
// elevation layer. Callers report that in their own idiom (a notification in
// the browser, a non-zero exit in the baker), which is why this does not.
export async function readWorldInputs(archive: ArrayBuffer | Uint8Array): Promise<WorldInputs | null> {
  let zip: JSZip
  let manifest: WorldManifest
  try {
    zip = await JSZip.loadAsync(archive)
    const manifestText = await zip.file('manifest.json')?.async('string')
    if (!manifestText) return null
    manifest = JSON.parse(manifestText) as WorldManifest
  } catch {
    return null
  }

  const elevationEntry = manifest.layers.find((layer) => layer.name === 'elevation' && layer.kind === 'raster')
  const elevationBuffer = elevationEntry ? await zip.file(elevationEntry.file)?.async('arraybuffer') : undefined
  if (!elevationEntry || !elevationBuffer) return null

  const elevations = new Float32Array(elevationBuffer)
  const width = elevationEntry.resX ?? manifest.world.width
  const height = elevationEntry.resY ?? manifest.world.height

  // Recipe values through the shared path-aware reader. Bare-key regexes were
  // wrong here in both directions: `seed` sits INDENTED under `spec:`, so a
  // line-anchored pattern never matched it (every world fell back to one
  // default label AND one detail seed), and a leaf name matched anywhere would
  // collide the moment two groups share a key.
  const yamlText = (await zip.file('world.yaml')?.async('string')) ?? ''
  const seedText = readRecipeValue(yamlText, 'spec.seed') ?? 'casas-eternas'
  let detailSeed = 5381
  for (let i = 0; i < seedText.length; i++) detailSeed = ((detailSeed * 33) ^ seedText.charCodeAt(i)) >>> 0

  const erosionControls: ErosionControls = {
    strength: readRecipeNumber(yamlText, 'spec.erosion.erosionStrength'),
    refresh: readRecipeNumber(yamlText, 'spec.erosion.drainageRefresh'),
    riverDensity: readRecipeNumber(yamlText, 'spec.hydrology.riverDensity'),
  }

  const climate = await readLayer(zip, manifest, 'precipitation', true)
  const biome = await readLayer(zip, manifest, 'biome', false)

  // The artifact identity, from what the bake actually consumes — NOT from the
  // recipe, which cannot distinguish two worlds stopped at different tectonic
  // epochs (see storage/artifactKey.ts). The seed string rides along only as a
  // readable path label.
  const worldId = deriveWorldId(seedText, {
    elevation: elevations,
    precipitation: climate?.data ?? null,
    erosionStrength: erosionControls.strength,
    drainageRefresh: erosionControls.refresh,
    riverDensity: erosionControls.riverDensity,
  })

  const worldUid = readRecipeValue(yamlText, 'metadata.uid') ?? ''

  return { elevations, width, height, seedText, detailSeed, erosionControls, climate, biome, worldId, worldUid }
}
