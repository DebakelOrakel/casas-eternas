import JSZip from 'jszip'
import type { ArcheanSnapshot } from '../../generator/archean/archeanSnapshotTypes'
import type { RefinedClimate } from '../../generator/climate/refinement'
import type { FieldPayload, MeshPayload } from '../../generator/pipeline/messages'
import type { CoastReach } from '../../generator/surface/coastGraph'
import type { WaterBody } from '../../generator/surface/hydrology'
import type { SedimentBasin } from '../../generator/surface/surfaceTypes'
import type { PlateSimulationSnapshot } from '../../generator/tectonics/plateSimulation'
import { refinedEntries, refinedFromEntries } from './refinedFields'
import { climateEntries, LAND_FILES, type SavedClimate, type SavedLandFields } from './climateFields'
import { CLIMATE_TUNING } from '../../generator/climate/climateTuneParams'

// THE SAVE'S WRITER: a world's parts in, the .zip's bytes out — its files,
// its quantised "query layers" (docs/decisions/queryable-world-save.md) and
// the manifest that describes them. The reader is world/query (openWorld);
// the two now live in one layer. The writer stood in the generator screen
// until 2026-10-01, beside the controls it reads, so harness:roundtrip
// could only describe the archive it wrote, not run the writer
// (architecture-unification part C).
//
// The caller gathers the parts (the recipe as yaml, the worker's snapshot,
// the screen's computed fields) and owns where the bytes go. Nothing here
// reads a control or knows a screen.

// The computed fields of the world, as the save bakes them. Each is left
// out of the archive when null: a world saved before a stage ran simply
// does not carry it.
export interface WorldArchiveFields {
  // The climate per cell of its field mesh and the land fields per node of
  // the mesh (climateFields.ts; DEC-0036 phase 7, the discharge 7b), the
  // worker's.
  climate: SavedClimate | null
  land: SavedLandFields | null
  // The climate step's refinement, its values per cell of the climate's
  // field mesh (refinedFields.ts; DEC-0036 phase 5).
  refined: RefinedClimate | null
  waterBodies: WaterBody[] | null
  // The coast reaches and their nodes: vertex ids of the saved mesh.
  coast: { reaches: CoastReach[]; nodes: Int32Array } | null
  sedimentBasins: SedimentBasin[] | null
}

interface ArchiveCommon {
  width: number
  height: number
  // world.yaml: the recipe, the identity, the history.
  yaml: string
  // The build that wrote the archive (manifest.generatorVersion).
  generatorVersion: string
  // preview.png, when there is one: a thumbnail picture, not a field.
  preview: Blob | Uint8Array | null
}

// A world saved during the Archean: no plate simulation yet, its own
// snapshot instead, and no manifest (nothing computed to describe).
export interface ArcheanArchiveParts extends ArchiveCommon {
  kind: 'archean'
  archean: { snapshot: ArcheanSnapshot; mantle: FieldPayload; streak: ArrayBuffer }
}

export interface TectonicArchiveParts extends ArchiveCommon {
  kind: 'tectonic'
  snapshot: PlateSimulationSnapshot
  mantle: FieldPayload
  latticeAccumulated: ArrayBuffer
  latticeLockedEpochs: ArrayBuffer
  latticeLastClassCode: ArrayBuffer
  oceanAge: FieldPayload
  // The adaptive mesh, the terrain proper — every tectonic world has one
  // (runtime.savedMeshPayload); the world's elevation is its rasterisation.
  mesh: MeshPayload
  fields: WorldArchiveFields
}

export type WorldArchiveParts = ArcheanArchiveParts | TectonicArchiveParts

// The archive's format version, in its manifest. 3: a save may carry a
// mesh; 4: its sediment column; 5: the column's layers carry the climate at
// deposition; 6: the layers may carry the climate step's refinement; 7: no
// ecology layers (docs/decisions/ecology-as-function.md: computed on load),
// and the generator loads the refinement it finds rather than computing it
// again; 8: the mantle as its field mesh's values (mantle.f64 + mantle.json,
// DEC-0036 phase 1) in place of the 128 × 64 raster mantle.f32, and the
// ocean age as its field mesh's values (oceanAge.f64 + oceanAge.json, phase
// 2) in place of the 256 × 128 raster oceanAge.f32 — a save without them is
// refused, not converted. The DEC-0036 phases are one move, so one version:
// a version-8 save from a build before phase 2 lacks oceanAge.f64 and is
// refused by its absence. The climate step's refinement as its field mesh's
// values (refined.json + refined/, phase 5) in place of the quantised
// raster layers (layers/temperature.01 … layers/thunder, layers/enso.json)
// — a save with those layers and without refined.json is refused. The
// annual climate as its field mesh's values (climate.json + climate/,
// phase 7) and the biome, the Köppen class and the water table per node of
// the mesh (mesh/biome.u8, mesh/koppen.u8, mesh/waterTable.f32) in place of
// the raster layers landMask, temperature, precipitation,
// precipitationEffective, biome, seasonalAmplitude, monsoonIndex, koppen and
// waterTable — a save with those layers and without climate.json is
// refused (readClimate). The river discharge per node of the mesh
// (mesh/discharge.f32, m³/s, phase 7b) in place of the raster layer
// layers/discharge.u16, and the coast reaches over the mesh's nodes
// (layers/coast.json `nodes`, its vertex ids) in place of raster cells
// (`cells`) — a save with either former one is refused
// (climateFields.refuseFormerHydrology). What the last epoch left per node
// of the mesh (mesh/sedimentFlux.f32, mesh/preErosionZ.f32 and, once an
// epoch ran, mesh/ice.f32; MESH_EPOCH_FILES) — a save with a mesh and
// without the first two is refused (readMeshEpochFiles). And no chart
// raster at all (DEC-0036, the save step): not the elevation (elevation.f32,
// the restore raster — the mesh's rasterisation, made again on load), not
// the lakes' depth (layers/lakeDepth.u8 — drawn again from the water body
// per node, mesh/lakeBody.i32, and layers/waterBodies.json), not the
// erosion's coarse forcing (layers/uplift.f32, layers/erodibility.f32 — a
// function of state.json, the engine's forcingOfSnapshot). A save
// holding any of them, or a tectonic one without its mesh, is refused
// (refuseFormerRasters).
export const WORLD_ARCHIVE_FORMAT_VERSION = 8

// The mesh's per-node files of the last epoch, Float32 in the saved mesh's
// numbering (generator/pipeline/messages.ts MeshPayload): the erosion's
// sediment flux, m³/yr (zeros before the first epoch); the heights that
// epoch's erosion started from (the heights themselves before it); the ice
// the plate carries, metres (absent before the first epoch: none). The
// hydrology reads the first two (the reaches' loads, the coast's supply,
// the river courses' deltas, the sediment basins), the next epoch's flexure
// the third — none of them can be derived on a load.
export const MESH_EPOCH_FILES = { sedimentFlux: 'mesh/sedimentFlux.f32', preErosionZ: 'mesh/preErosionZ.f32', ice: 'mesh/ice.f32' } as const

// The last epoch's files of a saved mesh of `count` nodes, as MeshPayload
// carries them. Throws for a save with a mesh and without them (a version-8
// save from before they were written) or with files of another size.
export async function readMeshEpochFiles(zip: JSZip, count: number): Promise<{ sedimentFlux: ArrayBuffer; preErosionZ: ArrayBuffer; ice?: ArrayBuffer }> {
  const read = async (name: string): Promise<ArrayBuffer | undefined> => {
    const bytes = await zip.file(name)?.async('arraybuffer')
    if (bytes && bytes.byteLength !== count * 4) throw new Error(`${name}: ${bytes.byteLength} bytes for ${count} nodes`)
    return bytes
  }
  const sedimentFlux = await read(MESH_EPOCH_FILES.sedimentFlux)
  const preErosionZ = await read(MESH_EPOCH_FILES.preErosionZ)
  if (!sedimentFlux || !preErosionZ) throw new Error(`no ${MESH_EPOCH_FILES.sedimentFlux} / ${MESH_EPOCH_FILES.preErosionZ}: a save from before the mesh carried its last epoch`)
  return { sedimentFlux, preErosionZ, ice: await read(MESH_EPOCH_FILES.ice) }
}

export async function writeWorldArchive(parts: WorldArchiveParts): Promise<Uint8Array<ArrayBuffer>> {
  const zip = new JSZip()
  zip.file('world.yaml', parts.yaml)
  if (parts.kind === 'archean') {
    zip.file('archean.json', JSON.stringify(parts.archean.snapshot))
    writeField(zip, 'archean.mantle', parts.archean.mantle)
    zip.file('archean.streak.i16', parts.archean.streak)
  } else {
    zip.file('state.json', JSON.stringify(parts.snapshot))
    writeField(zip, 'mantle', parts.mantle)
    zip.file('lattice.acc.f32', parts.latticeAccumulated)
    zip.file('lattice.lock.i16', parts.latticeLockedEpochs)
    zip.file('lattice.class.i8', parts.latticeLastClassCode)
    writeField(zip, 'oceanAge', parts.oceanAge)
    writeQueryLayers(zip, parts)
    // The climate on its field mesh (climateFields.ts).
    if (parts.fields.climate) {
      const { meta, files } = climateEntries(parts.fields.climate)
      zip.file('climate.json', meta)
      for (const [file, bytes] of files) zip.file(file, bytes)
    }
    // The climate step's refinement: a world saved unrefined loads
    // unrefined.
    if (parts.fields.refined) {
      const { meta, files } = refinedEntries(parts.fields.refined, CLIMATE_TUNING.windSpeedMsPerUnit)
      zip.file('refined.json', meta)
      for (const [file, bytes] of files) zip.file(file, bytes)
    }
  }
  if (parts.preview) zip.file('preview.png', parts.preview)
  // A fresh buffer of JSZip's own, never shared memory: typed as such so a
  // Blob takes it.
  return (await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })) as Uint8Array<ArrayBuffer>
}

// The archive with its world.yaml replaced, every other entry as it was
// (JSZip keeps their compressed bytes): for a yaml that says something of
// the written archive, as its terrain id.
export async function withWorldYaml(archive: Uint8Array<ArrayBuffer>, yaml: string): Promise<Uint8Array<ArrayBuffer>> {
  const zip = await JSZip.loadAsync(archive)
  zip.file('world.yaml', yaml)
  return (await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })) as Uint8Array<ArrayBuffer>
}

// A field-mesh field (formatVersion 8: the mantle, the ocean age): its
// values per cell of its field mesh, Float64 (`<name>.f64`), and the mesh
// they belong to (`<name>.json`: cell count and spacing in metres), which a
// load checks — the mesh is rebuilt from the world's shape and size, not
// saved.
function writeField(zip: JSZip, name: string, field: FieldPayload): void {
  zip.file(`${name}.f64`, field.values)
  zip.file(`${name}.json`, JSON.stringify({ cells: field.cells, spacingM: field.spacingM }))
}

// The climate step's refinement back (refinedFields.ts), for the loader:
// null for a save without one (unrefined); an error for a save whose
// refinement is incomplete, or still the quantised raster layers of a build
// before DEC-0036 phase 5 (refused, not converted). Whether the values
// belong to this world's climate mesh is the loader's check
// (refinement.refinementFits).
export async function readRefined(zip: JSZip): Promise<RefinedClimate | null> {
  const meta = zip.file('refined.json')
  if (!meta) {
    if (zip.file('layers/enso.json') || zip.file('layers/currentU.u16')) throw new Error('a refinement as raster layers: a save from before the refinement moved onto its mesh')
    return null
  }
  return refinedFromEntries(await meta.async('string'), async (file) => (await zip.file(file)?.async('arraybuffer')) ?? null)
}

export { readClimate, readLandFields } from './climateFields'
export { FORMER_RASTERS, readField, refuseFormerRasters } from './savedFields'

type ManifestLayer = { name: string; file: string; kind: 'raster' | 'vector' | 'table'; resX?: number; resY?: number; dtype?: string; encoding?: { scale: number; offset: number }; unit?: string; landOnly?: boolean }

// Every computed field on its mesh, the tables beside them, plus the
// manifest — so a game server can look up any world value with no
// generation code but the meshes' (world/query.ts rasterises them).
function writeQueryLayers(zip: JSZip, parts: TectonicArchiveParts): void {
  const { width, height, mesh, fields } = parts
  // No raster layer is left (DEC-0036, the save step): the list holds the
  // tables.
  const layers: ManifestLayer[] = []
  // The standing-water list: the bodies `mesh/lakeBody.i32` indexes, from
  // which a reader draws the lakes' depth on the world raster
  // (meshHydrology.waterFieldsFromMesh); their seed and outlet in that
  // raster's texel coordinates (formatVersion 2).
  if (fields.waterBodies) {
    zip.file('layers/waterBodies.json', JSON.stringify(fields.waterBodies))
    layers.push({ name: 'waterBodies', file: 'layers/waterBodies.json', kind: 'table' })
  }
  // The coast reaches: their nodes as vertex ids of the saved mesh (the
  // mesh is canonical, so the session's ids are the save's), so only with
  // the mesh they index.
  if (fields.coast) {
    zip.file('layers/coast.json', JSON.stringify({ reaches: fields.coast.reaches, nodes: Array.from(fields.coast.nodes) }))
    layers.push({ name: 'coast', file: 'layers/coast.json', kind: 'table' })
  }
  // The sediment basins: what this session's erosion deposited, with
  // provenance — a loaded save cannot re-derive them.
  if (fields.sedimentBasins && fields.sedimentBasins.length > 0) {
    zip.file('layers/sedimentBasins.json', JSON.stringify(fields.sedimentBasins))
    layers.push({ name: 'sedimentBasins', file: 'layers/sedimentBasins.json', kind: 'table' })
  }
  // The adaptive mesh: the terrain proper, which a reader rasterises for
  // the elevation. Its files under `mesh/`, described by one manifest entry.
  zip.file('mesh/nodes.f32', mesh.nodes)
  zip.file('mesh/connectivity.bin', mesh.connectivity)
  zip.file('mesh/z.f32', mesh.z)
  if (mesh.column) zip.file('mesh/column.bin', mesh.column)
  // What the last epoch left per node (MeshPayload): the hydrology of a
  // loaded world reads them as the session's did.
  if (mesh.sedimentFlux) zip.file(MESH_EPOCH_FILES.sedimentFlux, mesh.sedimentFlux)
  if (mesh.preErosionZ) zip.file(MESH_EPOCH_FILES.preErosionZ, mesh.preErosionZ)
  if (mesh.ice) zip.file(MESH_EPOCH_FILES.ice, mesh.ice)
  // The land fields per node, in the mesh's numbering (climateFields.ts).
  const land = fields.land && fields.land.count === mesh.count ? fields.land : null
  if (land) {
    zip.file(LAND_FILES.biome, land.biome.slice().buffer as ArrayBuffer)
    zip.file(LAND_FILES.koppen, land.koppen.slice().buffer as ArrayBuffer)
    if (land.waterTable) zip.file(LAND_FILES.waterTable, land.waterTable.slice().buffer as ArrayBuffer)
    // Rivers are a DISCHARGE FIELD, not polylines: a field answers "how
    // big is this river" by sampling, where a polyline's only attribute
    // was a drawing width.
    if (land.discharge) zip.file(LAND_FILES.discharge, land.discharge.slice().buffer as ArrayBuffer)
    // The lakes per node: with the bodies they index only.
    if (land.lakeBody && fields.waterBodies) zip.file(LAND_FILES.lakeBody, land.lakeBody.slice().buffer as ArrayBuffer)
  }
  const manifest = {
    formatVersion: WORLD_ARCHIVE_FORMAT_VERSION,
    // The same provenance string status.generator carries.
    generatorVersion: parts.generatorVersion,
    // The shape is the record's kind (world.yaml), said once (DEC-0035).
    world: { width, height },
    layers,
    mesh: {
      nodes: mesh.count,
      files: {
        nodes: 'mesh/nodes.f32', connectivity: 'mesh/connectivity.bin', z: 'mesh/z.f32', column: mesh.column ? 'mesh/column.bin' : undefined,
        sedimentFlux: mesh.sedimentFlux ? MESH_EPOCH_FILES.sedimentFlux : undefined,
        preErosionZ: mesh.preErosionZ ? MESH_EPOCH_FILES.preErosionZ : undefined,
        ice: mesh.ice ? MESH_EPOCH_FILES.ice : undefined,
        ...(fields.land && fields.land.count === mesh.count ? { biome: LAND_FILES.biome, koppen: LAND_FILES.koppen, waterTable: fields.land.waterTable ? LAND_FILES.waterTable : undefined, discharge: fields.land.discharge ? LAND_FILES.discharge : undefined, lakeBody: fields.land.lakeBody && fields.waterBodies ? LAND_FILES.lakeBody : undefined } : {}),
      },
    },
    climate: fields.climate ? { file: 'climate.json', cells: fields.climate.cells, spacingM: fields.climate.spacingM } : undefined,
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
}
