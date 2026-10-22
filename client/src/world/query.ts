import JSZip from 'jszip'
import type { SavedMesh } from '../generator/mesh/meshSerial'
import { sampleAt } from './save/worldLayers'
import { fieldSpec } from './save/fieldSpec'
import type { FieldSpec } from './save/fieldSpec'
import { readRecipeNumber, readRecipeValue } from './save/recipeYaml'
import { historyFromYaml, type WorldHistory } from './save/worldHistory'
import { deriveWorldId } from './identity'
import { worldKindOf, type WorldKind } from './worldRecord'
import { recordedPipeline } from './worldPipeline'
import { coastalWarpSeed } from '../generator/archean/archeanState'
import { FINE_DETAIL_SEED_SALT } from '../generator/elevation/ridgedNoise'
import type { ErosionControls, WorldManifest } from './save/loadWorldInputs'
import { readClimate, readLandFields, refuseFormerHydrology, type SavedClimate, type SavedLandFields } from './save/climateFields'
import { readField, refuseFormerRasters } from './save/savedFields'
import { domainOfKind, type Domain } from '../generator/core/domain'
import { decodeMesh } from '../generator/mesh/meshSerial'
import type { PeriodicTriangulation } from '../generator/mesh/periodicDelaunay'
import { rasteriseNodeField, rasteriseNodePart } from '../generator/mesh/meshRaster'
import { waterFieldsFromMesh } from '../generator/mesh/meshHydrology'
import type { Engine } from '../generator/pipeline/engine'
import type { PlateSimulationSnapshot } from '../generator/tectonics/plateSimulationTypes'
import type { WaterBody } from '../generator/surface/hydrology'
import { climateCellsFromSaved } from '../generator/climate/climatePoints'
import { cellsChart } from '../generator/climate/climateChart'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../generator/climate/climateField'
import { Biome } from '../generator/climate/biomes'
import { SEA_LEVEL } from '../generator/elevation/elevationScale'

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
  erosionControls: ErosionControls
  // The world's identity in the server's store (`metadata.uid`) — the half that
  // does NOT move when the terrain does. Empty for a save written before the
  // field existed; deliberately not derived as a fallback, because a uid guessed
  // from different bytes than the one uploaded points at another world.
  worldUid: string
  // How the world came about, run by run (save/worldHistory.ts) — what a
  // replay of level 1 makes it again from (world/replay.ts).
  history: WorldHistory
  // The pipeline that made it (worldPipeline.ts); '' for none.
  pipeline: string
}

// What the world layer asks of the engine (DEC-0044, fork 7b): what sets
// the bytes of something stored is the engine's — the forcing a save's
// snapshot gives, the artifacts' files written and read. The browser gives its WASM build
// (generator/pipeline/engineWasm), the job worker its native one.
export type WorldEngine = Pick<Engine, 'forcingOfSnapshot' | 'levelFiles' | 'tileFiles' | 'levelOfFiles' | 'tileOfFiles'>

export interface World {
  // The world's shape (world.yaml's kind): the torus or the sphere.
  readonly kind: WorldKind
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
  // at different tectonic epochs apart; see identity.ts). Async because it
  // reads the mesh, the field meshes and the snapshot, and derived HERE so
  // every reader of a save agrees on it instead of each hashing its own idea
  // of the inputs.
  worldId(): Promise<string>
  // The adaptive mesh the save carries (formatVersion 3, `mesh/…`, see
  // mesh/meshSerial.ts) — the terrain proper since phase 4.3, in every
  // world openWorld opens since DEC-0036's save step.
  mesh(): Promise<SavedMesh | null>
  // The tectonic state the save holds (`state.json`), as it is: what the
  // engine derives the erosion's forcing from (DEC-0044, fork 7b). Null
  // without one.
  snapshot(): Promise<PlateSimulationSnapshot | null>
  // The climate per cell of its field mesh and the land fields per node of
  // the mesh (save/climateFields.ts, DEC-0036 phase 7); null for a save
  // without them. A save holding them as the former raster layers is
  // refused by openWorld.
  climate(): Promise<SavedClimate | null>
  land(): Promise<SavedLandFields | null>
}

// The type lives with the codec (generator/mesh/meshSerial), which the
// generator's bake reads it with; world/ is the layer above.
export type { SavedMesh }

// The water-body table as a reader checks it: a list of bodies with a
// level and a spill, else null.
export function waterBodiesOf(raw: unknown): WaterBody[] | null {
  return Array.isArray(raw) && raw.every((b) => typeof b === 'object' && b !== null && typeof (b as WaterBody).level === 'number' && typeof (b as WaterBody).spill === 'number')
    ? (raw as WaterBody[])
    : null
}

// Null when the archive is not a readable world — same contract as
// readWorldInputs, and for the same reason: the caller reports it in its own
// idiom (a notification in the browser, an exit code in the baker).
//
// Every view is MADE here (DEC-0036, the save step): the save holds the
// meshes' values and no raster. The elevation is the terrain mesh's
// rasterisation (meshRaster.rasteriseNodeField, the session's own after
// every epoch), the lakes' depth the session's drawing of the mesh's lakes
// (meshHydrology.waterFieldsFromMesh, from the water body per node), the
// erosion's coarse forcing the engine's of the snapshot (`engine`,
// forcingOfSnapshot; DEC-0044 fork 7b: what sets an artifact's bytes is
// the engine's), the climate its chart, the land fields their nodes on the
// world raster.
export async function openWorld(archive: ArrayBuffer | Uint8Array, engine: WorldEngine): Promise<World | null> {
  let zip: JSZip
  let manifest: WorldManifest
  try {
    zip = await JSZip.loadAsync(archive)
    const text = await zip.file('manifest.json')?.async('string')
    if (!text) return null
    manifest = JSON.parse(text) as WorldManifest
    // A save that still holds a chart raster, or a tectonic one without its
    // mesh, is from before the save step: refused, not converted.
    refuseFormerRasters(zip)
  } catch {
    return null
  }

  // The world raster the views are drawn on: the chart's size, which the
  // manifest states (the mesh lives on the Domain of that size).
  const width = manifest.world?.width
  const height = manifest.world?.height
  if (typeof width !== 'number' || typeof height !== 'number') return null

  // Recipe values through the shared path-aware reader. Bare-key regexes were
  // wrong here in both directions: `seed` sits INDENTED under `spec:`, so a
  // line-anchored pattern never matched it, and a leaf name matched anywhere
  // would collide the moment two groups share a key.
  const yamlText = (await zip.file('world.yaml')?.async('string')) ?? ''
  // Not a world this client opens: no world (worldRecord.ts, worldKindOf).
  const kind = worldKindOf(yamlText)
  if (!kind) return null
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
    erosionControls: {
      landscapeAge: readRecipeNumber(yamlText, 'spec.erosion.landscapeAge'),
      // Since phase 5.1 under the tectonics; the erosion paths are the
      // saves written before.
      alluvium: readRecipeNumber(yamlText, 'spec.tectonics.alluvium') ?? readRecipeNumber(yamlText, 'spec.erosion.alluvium'),
      rockContrast: readRecipeNumber(yamlText, 'spec.tectonics.rockContrast') ?? readRecipeNumber(yamlText, 'spec.erosion.rockContrast'),
    },
    worldUid: readRecipeValue(yamlText, 'metadata.uid') ?? '',
    history: historyFromYaml(yamlText),
    pipeline: recordedPipeline(yamlText),
  }
  // The climate and the land fields on their meshes (DEC-0036 phase 7, the
  // hydrology's 7b); the former raster layers refuse the archive.
  let climate: SavedClimate | null
  try {
    climate = await readClimate(zip)
    await refuseFormerHydrology(zip)
  } catch {
    return null
  }
  const domain: Domain = domainOfKind(kind === 'SphereWorld' ? 'sphere' : 'torus', width, height)
  const tables = new Map<string, string>()
  for (const layer of manifest.layers) if (layer.kind === 'table') tables.set(layer.name, layer.file)

  // Made views are kept, not made again: a raster is megabytes and a caller
  // that acquires elevation for a tooltip and again for an overlay should
  // pay once.
  const cache = new Map<string, FieldView>()

  const view = (spec: FieldSpec, source: FieldSource, data: Float32Array, resX: number, resY: number): FieldView => ({
    spec, source, resX, resY, data,
    sample: (x, y) => sampleAt(data, resX, resY, width, height, x, y),
  })
  const keep = (name: string, data: Float32Array, resX: number, resY: number): FieldView => {
    const built = view(fieldSpec(name), 'save', data, resX, resY)
    cache.set(name, built)
    return built
  }

  // The terrain mesh, read and rebuilt once (the canonical rebuild, the
  // session's own mesh).
  let saved: SavedMesh | null | undefined
  const savedMesh = async (): Promise<SavedMesh | null> => {
    if (saved !== undefined) return saved
    const files = (manifest as { mesh?: { nodes: number; files: { nodes: string; connectivity: string; z: string; column?: string } } }).mesh
    saved = null
    if (!files) return saved
    const nodes = await zip.file(files.files.nodes)?.async('arraybuffer')
    const connectivity = await zip.file(files.files.connectivity)?.async('arraybuffer')
    const z = await zip.file(files.files.z)?.async('arraybuffer')
    if (!nodes || !connectivity || !z || nodes.byteLength !== files.nodes * 8 || z.byteLength !== files.nodes * 4) return saved
    const column = files.files.column ? await zip.file(files.files.column)?.async('arraybuffer') : undefined
    saved = { count: files.nodes, nodes: new Float32Array(nodes), connectivity: new Uint8Array(connectivity), z: new Float32Array(z), column: column ? new Uint8Array(column) : undefined }
    return saved
  }
  let decoded: PeriodicTriangulation | null = null
  const meshOf = (m: SavedMesh): PeriodicTriangulation =>
    (decoded ??= decodeMesh(domain, { count: m.count, nodes: m.nodes, connectivity: m.connectivity }))

  // The snapshot, parsed once: the forcing's source.
  let snapshot: PlateSimulationSnapshot | null | undefined
  const snapshotOf = async (): Promise<PlateSimulationSnapshot | null> => {
    if (snapshot !== undefined) return snapshot
    const text = await zip.file('state.json')?.async('string')
    snapshot = text ? (JSON.parse(text) as PlateSimulationSnapshot) : null
    return snapshot
  }
  // The erosion's coarse forcing, as the engine derives it from the same
  // state (the session's serialize wrote exactly these until the save
  // step).
  let forcing: { uplift: Float32Array; hardness: Float32Array } | null | undefined
  const forcingOf = async (): Promise<{ uplift: Float32Array; hardness: Float32Array } | null> => {
    if (forcing !== undefined) return forcing
    const snap = await snapshotOf()
    forcing = snap ? engine.forcingOfSnapshot(kind === 'SphereWorld' ? 'sphere' : 'torus', snap) : null
    return forcing
  }

  const CLIMATE_VIEWS = ['landMask', 'temperature', 'precipitation', 'seasonalAmplitude', 'monsoonIndex'] as const
  const LAND_VIEWS = ['biome', 'koppen', 'waterTable', 'discharge'] as const
  let land: SavedLandFields | null | undefined
  const landFields = async (): Promise<SavedLandFields | null> => {
    if (land !== undefined) return land
    const mesh = await savedMesh()
    land = mesh ? await readLandFields(zip, mesh.count).catch(() => null) : null
    return land
  }
  const bodiesOf = async (): Promise<WaterBody[] | null> => waterBodiesOf(await world.table('waterBodies'))

  async function made(name: string): Promise<FieldView | null> {
    const cached = cache.get(name)
    if (cached) return cached
    // The elevation: the terrain mesh's rasterisation.
    if (name === 'elevation') {
      const m = await savedMesh()
      if (!m) return null
      return keep(name, rasteriseNodeField(meshOf(m), m.z, width, height), width, height)
    }
    // The lakes' depth: the mesh's lakes drawn on the elevation raster, each
    // pixel its triangle's nearest node's body.
    if (name === 'lakeDepth') {
      const fields = await landFields()
      const bodies = await bodiesOf()
      const m = await savedMesh()
      const elevation = await made('elevation')
      if (!fields?.lakeBody || !bodies || !m || !elevation) return null
      return keep(name, waterFieldsFromMesh(meshOf(m), fields.lakeBody, bodies, elevation.data, width, height).depth, width, height)
    }
    if (name === 'uplift' || name === 'erodibility') {
      const f = await forcingOf()
      if (!f) return null
      keep('uplift', f.uplift, CLIMATE_RES_X, CLIMATE_RES_Y)
      keep('erodibility', f.hardness, CLIMATE_RES_X, CLIMATE_RES_Y)
      return cache.get(name) ?? null
    }
    // The views of the fields the save holds as mesh values: the climate's
    // on its chart (climateChart.cellsChart, the temperature at each pixel's
    // texel height), the land fields per node on the world raster from the
    // nodes of the triangle under each pixel (the land's pixels from the
    // land's nodes — a biome or a class the heaviest, the water table
    // linearly, the discharge the nearest — a river is a line of nodes, and
    // a blend would smear it over the valley; the sea's Ocean, 0, −1, 0).
    if ((CLIMATE_VIEWS as readonly string[]).includes(name)) {
      if (!climate) return null
      const elevation = await made('elevation')
      if (!elevation) return null
      const charts = cellsChart(climateCellsFromSaved(domain, climate), { domain, elevation: elevation.data, resX: width, resY: height, dryLand: null })
      for (const n of CLIMATE_VIEWS) keep(n, charts[n], CLIMATE_RES_X, CLIMATE_RES_Y)
      return cache.get(name) ?? null
    }
    if ((LAND_VIEWS as readonly string[]).includes(name)) {
      const fields = await landFields()
      const m = await savedMesh()
      const elevation = await made('elevation')
      if (!fields || !m || !elevation) return null
      const mesh = meshOf(m)
      const pixelLand = new Uint8Array(width * height)
      for (let i = 0; i < pixelLand.length; i++) pixelLand[i] = elevation.data[i] > SEA_LEVEL ? 1 : 0
      const nodeLand = new Uint8Array(mesh.vertexSlots)
      for (let v = 0; v < m.count; v++) nodeLand[v] = fields.biome[v] !== Biome.Ocean ? 1 : 0
      let data: Float32Array
      if (name === 'waterTable') {
        if (!fields.waterTable) return null
        const wet = new Uint8Array(mesh.vertexSlots)
        for (let v = 0; v < m.count; v++) wet[v] = nodeLand[v] && fields.waterTable[v] >= 0 ? 1 : 0
        data = rasteriseNodePart(mesh, fields.waterTable, wet, pixelLand, -1, width, height, false)
      } else if (name === 'discharge') {
        if (!fields.discharge) return null
        data = rasteriseNodePart(mesh, fields.discharge, nodeLand, pixelLand, 0, width, height, true)
      } else {
        data = rasteriseNodePart(mesh, name === 'biome' ? fields.biome : fields.koppen, nodeLand, pixelLand, name === 'biome' ? Biome.Ocean : 0, width, height, true)
      }
      return keep(name, data, width, height)
    }
    return null
  }

  const hasMesh = zip.file('mesh/nodes.f32') !== null
  const world: World = {
    kind,
    width,
    height,
    recipe,
    has: (name) => tables.has(name)
      || (hasMesh && name === 'elevation')
      || (name === 'lakeDepth' && hasMesh && tables.has('waterBodies') && zip.file('mesh/lakeBody.i32') !== null)
      || ((name === 'uplift' || name === 'erodibility') && zip.file('state.json') !== null)
      || (climate !== null && hasMesh && (CLIMATE_VIEWS as readonly string[]).includes(name))
      || ((LAND_VIEWS as readonly string[]).includes(name) && zip.file(name === 'waterTable' || name === 'discharge' ? `mesh/${name}.f32` : `mesh/${name}.u8`) !== null),

    async table(name) {
      const file = tables.get(name)
      if (!file) return null
      const text = await zip.file(file)?.async('string')
      if (!text) return null
      try {
        return JSON.parse(text) as unknown
      } catch {
        return null
      }
    },

    async worldId() {
      const mesh = await savedMesh()
      if (!mesh) throw new Error('a world without its mesh has no identity')
      const f = await forcingOf()
      if (!f) throw new Error('a world without its snapshot has no identity')
      const mantle = await readField(zip, 'mantle')
      const oceanAge = await readField(zip, 'oceanAge')
      return deriveWorldId({
        kind,
        landscapeAge: recipe.erosionControls.landscapeAge,
        alluvium: recipe.erosionControls.alluvium,
        rockContrast: recipe.erosionControls.rockContrast,
        mesh: { nodes: mesh.nodes, z: mesh.z, column: mesh.column },
        climate,
        forcing: { uplift: f.uplift, erodibility: f.hardness },
        mantle: new Float64Array(mantle.values),
        oceanAge: new Float64Array(oceanAge.values),
      })
    },

    acquire: made,
    climate: async () => climate,
    land: landFields,
    mesh: savedMesh,
    snapshot: snapshotOf,
  }
  // Refuse an archive with no terrain: a world without it is not a world,
  // and half-reading one is worse than saying so.
  return (await savedMesh()) ? world : null
}
