import JSZip from 'jszip'
import type { SavedMesh } from '../generator/mesh/meshSerial'
import { decodeLayer, sampleAt } from './save/worldLayers'
import { fieldSpec } from './save/fieldSpec'
import type { FieldSpec } from './save/fieldSpec'
import { readRecipeNumber, readRecipeValue } from './save/recipeYaml'
import { historyFromYaml, type WorldHistory } from './save/worldHistory'
import { deriveWorldId } from './identity'
import { coastalWarpSeed } from '../generator/archean/archeanState'
import { FINE_DETAIL_SEED_SALT } from '../generator/elevation/ridgedNoise'
import { erosionLithoSeed } from '../generator/surface/erosionForcingFields'
import type { ErosionControls, WorldManifest, WorldManifestLayer } from './save/loadWorldInputs'

// ASKING A FINISHED WORLD WHAT IS TRUE AT A PLACE.
//
// One way in for every field, so a consumer stops choosing between the save, an
// artifact and whatever raster a screen happens to be holding. Today the world
// map answers "which biome is here" from two different branches over two
// different grids, and its elevation silently changes resolution mid-session
// when a bake lands — same question, same session, two answers.
//
// Deliberately about FINISHED worlds only. The generator's live fields are not
// here: a world's identity moves whenever its terrain does (see identity.ts), so
// one more erosion pass is formally a different world. That makes everything in
// this file immutable and removes cache invalidation from the design entirely.

// Where a field came from. One source since the raster amplification went
// (2026-09-29): the save. A finer level lives in the artifact store and is
// read through it, not through this facade.
export type FieldSource = 'save'

// A field, acquired once and then sampled freely.
//
// Two stages on purpose: the sources are asynchronous (a zip entry, later an
// HTTP fetch) while the callers are overlays and tooltips that sample millions
// of times. An `await get(aspect, x, y)` per point would be unusable, so the
// await happens once per field and everything after it is synchronous.
export interface FieldView {
  spec: FieldSpec
  // Where this answer came from and at what resolution — the provenance the
  // whole exercise exists for. A facade that returns a bare number is the place
  // provenance goes to die, which is worse than today's inconsistency because
  // it would be invisible rather than merely inconvenient.
  source: FieldSource
  resX: number
  resY: number
  data: Float32Array
  // Nearest-cell, torus-wrapped, in WORLD coordinates — so a caller never has to
  // know this field's grid to ask about a place. Nearest rather than bilinear
  // because `biome` is an enum id; smooth fields could get their own sampler
  // later, per spec.
  sample(x: number, y: number): number
}

// The recipe half of a save — what the world was MADE from, as opposed to what
// it turned out to be. Read once with the fields, because they come out of the
// same archive and parsing it twice is how two readers start disagreeing.
export interface WorldRecipe {
  seedText: string
  // Seeds the deterministic near-field detail AND the amplification bake's
  // seed roughness: the generator's own warpSeed, derived from the recipe's
  // seed and salted like every other consumer of that noise (see openWorld).
  detailSeed: number
  // Seeds the erosion engine's lithology lattice — the same warpSeed under
  // the erosion salt (surface/erosionForcingFields.erosionLithoSeed), so a
  // bake carves the exact rock bands the generator carved.
  lithoSeed: number
  erosionControls: ErosionControls
  // The world's identity in the server's store (`metadata.uid`) — the half that
  // does NOT move when the terrain does. Empty for a save written before the
  // field existed; deliberately not derived as a fallback, because a uid guessed
  // from different bytes than the one uploaded points at another world.
  worldUid: string
  // How the world came about, run by run (save/worldHistory.ts) — what a
  // replay of level 1 makes it again from (world/replay.ts).
  history: WorldHistory
}

export interface World {
  readonly width: number
  readonly height: number
  readonly recipe: WorldRecipe
  // Which fields this world actually carries. A save written before a field
  // existed simply does not list it, and the honest answer is "no" rather than
  // a fabricated default.
  has(name: string): boolean
  acquire(name: string): Promise<FieldView | null>
  // A JSON table the manifest lists (kind 'table') — the standing-water
  // list is the first. Null when the save carries none or it does not parse;
  // the caller checks the shape, this reader only knows it is JSON.
  table(name: string): Promise<unknown | null>
  // WHICH TERRAIN this is — the artifact key, hashed from what a bake actually
  // consumes rather than from the recipe (which cannot tell two worlds stopped
  // at different tectonic epochs apart; see identity.ts). Async because it needs
  // the elevation and precipitation layers, and derived HERE so every reader of
  // a save agrees on it instead of each hashing its own idea of the inputs.
  worldId(): Promise<string>
  // The adaptive mesh the save carries (formatVersion 3, `mesh/…`, see
  // mesh/meshSerial.ts) — the terrain proper since phase 4.3; null for a
  // save written before it or a world never eroded on one.
  mesh(): Promise<SavedMesh | null>
}

// The type lives with the codec (generator/mesh/meshSerial), which the
// generator's bake reads it with; world/ is the layer above.
export type { SavedMesh }

// Null when the archive is not a readable world — same contract as
// readWorldInputs, and for the same reason: the caller reports it in its own
// idiom (a notification in the browser, an exit code in the baker).
export async function openWorld(archive: ArrayBuffer | Uint8Array): Promise<World | null> {
  let zip: JSZip
  let manifest: WorldManifest
  try {
    zip = await JSZip.loadAsync(archive)
    const text = await zip.file('manifest.json')?.async('string')
    if (!text) return null
    manifest = JSON.parse(text) as WorldManifest
  } catch {
    return null
  }

  // Elevation defines the world's raster: it is the one layer carried raw, and
  // it doubles as the restore raster.
  const elevationEntry = manifest.layers.find((l) => l.name === 'elevation' && l.kind === 'raster')
  if (!elevationEntry) return null
  const width = elevationEntry.resX ?? manifest.world.width
  const height = elevationEntry.resY ?? manifest.world.height

  // Recipe values through the shared path-aware reader. Bare-key regexes were
  // wrong here in both directions: `seed` sits INDENTED under `spec:`, so a
  // line-anchored pattern never matched it, and a leaf name matched anywhere
  // would collide the moment two groups share a key.
  const yamlText = (await zip.file('world.yaml')?.async('string')) ?? ''
  const seedText = readRecipeValue(yamlText, 'spec.seed') ?? 'casas-eternas'
  // THE GENERATOR'S OWN fine-detail seed, derived rather than read: `warpSeed`
  // is `coastalWarpSeed(seed)` (archean/archeanState.ts) and
  // therefore a pure function of the seed text the save already carries — the
  // "manifest gap" this used to be described as never needed a manifest field
  // at all. The salt is the one every consumer of fineDetailNoise-as-terrain
  // shares, so the amplification bake's seed roughness, the near-field
  // cascade and the generator's own fine relief all sample ONE field family
  // for a world instead of three unrelated ones.
  //
  // Changing it changes baked terrain for an unchanged world, which the
  // artifact key does not cover — that is why AMPLIFICATION_ALGO_VERSION went
  // to 8 in the same commit. Anything baked before it is a different terrain
  // under a different key, not a contradiction under the same one.
  const detailSeed = (coastalWarpSeed(seedText) ^ FINE_DETAIL_SEED_SALT) >>> 0
  const recipe: WorldRecipe = {
    seedText,
    detailSeed,
    lithoSeed: erosionLithoSeed(coastalWarpSeed(seedText)),
    erosionControls: {
      landscapeAge: readRecipeNumber(yamlText, 'spec.erosion.landscapeAge'),
      // Since phase 5.1 under the tectonics; the erosion paths are the
      // saves written before.
      alluvium: readRecipeNumber(yamlText, 'spec.tectonics.alluvium') ?? readRecipeNumber(yamlText, 'spec.erosion.alluvium'),
      rockContrast: readRecipeNumber(yamlText, 'spec.tectonics.rockContrast') ?? readRecipeNumber(yamlText, 'spec.erosion.rockContrast'),
    },
    worldUid: readRecipeValue(yamlText, 'metadata.uid') ?? '',
    history: historyFromYaml(yamlText),
  }
  const byName = new Map<string, WorldManifestLayer>()
  const tables = new Map<string, WorldManifestLayer>()
  for (const layer of manifest.layers) {
    if (layer.kind === 'raster') byName.set(layer.name, layer)
    else if (layer.kind === 'table') tables.set(layer.name, layer)
  }

  // Decoded fields are kept, not re-read: a layer is megabytes and a caller that
  // acquires elevation for a tooltip and again for an overlay should pay once.
  const cache = new Map<string, FieldView>()

  const view = (spec: FieldSpec, source: FieldSource, data: Float32Array, resX: number, resY: number): FieldView => ({
    spec, source, resX, resY, data,
    sample: (x, y) => sampleAt(data, resX, resY, width, height, x, y),
  })

  async function fromSave(name: string): Promise<FieldView | null> {
    const cached = cache.get(name)
    if (cached) return cached
    const entry = byName.get(name)
    if (!entry?.dtype || !entry.encoding || !entry.resX || !entry.resY) return null
    const buffer = await zip.file(entry.file)?.async('arraybuffer')
    if (!buffer) return null
    const decoded = decodeLayer(buffer, { dtype: entry.dtype, scale: entry.encoding.scale, offset: entry.encoding.offset })
    const built = view(fieldSpec(name), 'save', decoded, entry.resX, entry.resY)
    cache.set(name, built)
    return built
  }

  const world: World = {
    width,
    height,
    recipe,
    has: (name) => byName.has(name) || tables.has(name),

    async table(name) {
      const entry = tables.get(name)
      if (!entry) return null
      const text = await zip.file(entry.file)?.async('string')
      if (!text) return null
      try {
        return JSON.parse(text) as unknown
      } catch {
        return null
      }
    },

    async worldId() {
      const elevation = await fromSave('elevation')
      if (!elevation) throw new Error('a world without elevation has no identity')
      const precipitation = await fromSave('precipitation')
      const mesh = await world.mesh()
      return deriveWorldId({
        elevation: elevation.data,
        precipitation: precipitation?.data ?? null,
        landscapeAge: recipe.erosionControls.landscapeAge,
        alluvium: recipe.erosionControls.alluvium,
        rockContrast: recipe.erosionControls.rockContrast,
        mesh: mesh ? { nodes: mesh.nodes, z: mesh.z, column: mesh.column } : null,
      })
    },

    async acquire(name) {
      return fromSave(name)
    },

    async mesh() {
      const files = (manifest as { mesh?: { nodes: number; files: { nodes: string; connectivity: string; z: string; column?: string } } }).mesh
      if (!files) return null
      const nodes = await zip.file(files.files.nodes)?.async('arraybuffer')
      const connectivity = await zip.file(files.files.connectivity)?.async('arraybuffer')
      const z = await zip.file(files.files.z)?.async('arraybuffer')
      if (!nodes || !connectivity || !z || nodes.byteLength !== files.nodes * 8 || z.byteLength !== files.nodes * 4) return null
      const column = files.files.column ? await zip.file(files.files.column)?.async('arraybuffer') : undefined
      return { count: files.nodes, nodes: new Float32Array(nodes), connectivity: new Uint8Array(connectivity), z: new Float32Array(z), column: column ? new Uint8Array(column) : undefined }
    },
  }
  // Refuse an archive with no elevation, the same way readWorldInputs did: a
  // world without it is not a world, and half-reading one is worse than saying so.
  return (await world.acquire('elevation')) ? world : null
}
