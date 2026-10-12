import JSZip from 'jszip'
import type { ArcheanSnapshot } from '../../generator/archean/archeanSnapshot'
import type { RefinedClimate } from '../../generator/climate/refinement'
import type { FieldPayload, MeshPayload } from '../../generator/pipeline/messages'
import type { CoastReach } from '../../generator/surface/coastGraph'
import type { WaterBody } from '../../generator/surface/hydrology'
import type { SedimentBasin } from '../../generator/surface/sedimentBasins'
import type { PlateSimulationSnapshot } from '../../generator/tectonics/plateSimulation'
import { FORCING_LAYERS, WORLD_LAYERS, bakeLayer } from './worldLayers'
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
  // Water depth per world cell (elevation units) — the mesh lakes' raster
  // recovery (meshHydrology.waterFieldsFromMesh).
  lakeDepth: Float32Array | null
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
  // preview.png, when there is one.
  preview: Blob | Uint8Array | null
  // The world raster (elevation.f32): the restore raster, and the
  // elevation layer of the manifest.
  elevation: ArrayBuffer
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
  // The erosion engine's coarse forcing; null before the sim has one.
  forcing: { uplift: Float32Array; erodibility: Float32Array; resX: number; resY: number } | null
  // The adaptive mesh, the terrain proper; absent before the history ran.
  mesh: MeshPayload | undefined
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
// (climateFields.refuseFormerHydrology).
export const WORLD_ARCHIVE_FORMAT_VERSION = 8

export async function writeWorldArchive(parts: WorldArchiveParts): Promise<Uint8Array<ArrayBuffer>> {
  const zip = new JSZip()
  zip.file('world.yaml', parts.yaml)
  if (parts.kind === 'archean') {
    zip.file('archean.json', JSON.stringify(parts.archean.snapshot))
    writeField(zip, 'archean.mantle', parts.archean.mantle)
    zip.file('archean.streak.i16', parts.archean.streak)
    zip.file('elevation.f32', parts.elevation)
  } else {
    zip.file('state.json', JSON.stringify(parts.snapshot))
    writeField(zip, 'mantle', parts.mantle)
    zip.file('lattice.acc.f32', parts.latticeAccumulated)
    zip.file('lattice.lock.i16', parts.latticeLockedEpochs)
    zip.file('lattice.class.i8', parts.latticeLastClassCode)
    writeField(zip, 'oceanAge', parts.oceanAge)
    zip.file('elevation.f32', parts.elevation)
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

// A field-mesh field (formatVersion 8: the mantle, the ocean age): its
// values per cell of its field mesh, Float64 (`<name>.f64`), and the mesh
// they belong to (`<name>.json`: cell count and spacing in metres), which a
// load checks — the mesh is rebuilt from the world's shape and size, not
// saved.
function writeField(zip: JSZip, name: string, field: FieldPayload): void {
  zip.file(`${name}.f64`, field.values)
  zip.file(`${name}.json`, JSON.stringify({ cells: field.cells, spacingM: field.spacingM }))
}

// Its reader, for the loader: the two entries back, or an error when either
// is missing or malformed (a save from before the field moved onto its
// mesh — before formatVersion 8, or for the ocean age a version-8 save from
// before DEC-0036 phase 2).
export async function readField(zip: JSZip, name: string): Promise<FieldPayload> {
  const values = zip.file(`${name}.f64`)
  const meta = zip.file(`${name}.json`)
  if (!values || !meta) throw new Error(`no ${name}.f64 / ${name}.json: a save from before the field moved onto its mesh`)
  const { cells, spacingM } = JSON.parse(await meta.async('string')) as { cells: unknown; spacingM: unknown }
  const bytes = await values.async('arraybuffer')
  if (typeof cells !== 'number' || typeof spacingM !== 'number' || bytes.byteLength !== cells * 8) throw new Error(`${name}: ${bytes.byteLength} bytes for ${String(cells)} cells`)
  return { values: bytes, cells, spacingM }
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

type ManifestLayer = { name: string; file: string; kind: 'raster' | 'vector' | 'table'; resX?: number; resY?: number; dtype?: string; encoding?: { scale: number; offset: number }; unit?: string; landOnly?: boolean }

// Every computed field, quantised per its layer spec, plus the manifest —
// so a game server can look up any world value by sampling, with no
// generation code.
function writeQueryLayers(zip: JSZip, parts: TectonicArchiveParts): void {
  const { width, height, forcing, mesh, fields } = parts
  const layers: ManifestLayer[] = []
  // Elevation is always present (post-generation); carried raw as elevation.f32
  // (it doubles as the restore raster).
  layers.push({ name: 'elevation', file: 'elevation.f32', kind: 'raster', resX: width, resY: height, dtype: 'f32', encoding: { scale: 1, offset: 0 }, unit: 'relative', landOnly: false })

  // The erosion engine's coarse forcing: it exists whenever the sim does,
  // independent of the climate gate below — a bake erodes before it needs
  // climate.
  if (forcing) {
    for (const spec of FORCING_LAYERS) {
      const src = spec.name === 'uplift' ? forcing.uplift : forcing.erodibility
      zip.file(`layers/${spec.name}.${spec.dtype}`, bakeLayer(src, spec))
      layers.push({ name: spec.name, file: `layers/${spec.name}.${spec.dtype}`, kind: 'raster', resX: forcing.resX, resY: forcing.resY, dtype: spec.dtype, encoding: { scale: spec.scale, offset: spec.offset }, unit: spec.unit, landOnly: spec.landOnly })
    }
  }

  // The lakes' raster, once computed: the mesh's bodies drawn on the world
  // raster (the save's own step moves the remaining rasters).
  for (const spec of WORLD_LAYERS) {
    const src = spec.name === 'lakeDepth' ? fields.lakeDepth : null
    if (!src) continue
    zip.file(`layers/${spec.name}.${spec.dtype}`, bakeLayer(src, spec))
    layers.push({ name: spec.name, file: `layers/${spec.name}.${spec.dtype}`, kind: 'raster', resX: width, resY: height, dtype: spec.dtype, encoding: { scale: spec.scale, offset: spec.offset }, unit: spec.unit, landOnly: spec.landOnly })
  }
  // The standing-water list: a table beside the rasters, the truth
  // `lakeDepth` derives from (hydrology.lakeDepthFromBodies), in this
  // raster's texel coordinates (formatVersion 2).
  if (fields.waterBodies) {
    zip.file('layers/waterBodies.json', JSON.stringify(fields.waterBodies))
    layers.push({ name: 'waterBodies', file: 'layers/waterBodies.json', kind: 'table' })
  }
  // The coast reaches: their nodes as vertex ids of the saved mesh (the
  // mesh is canonical, so the session's ids are the save's), so only with
  // the mesh they index.
  if (fields.coast && mesh) {
    zip.file('layers/coast.json', JSON.stringify({ reaches: fields.coast.reaches, nodes: Array.from(fields.coast.nodes) }))
    layers.push({ name: 'coast', file: 'layers/coast.json', kind: 'table' })
  }
  // The sediment basins: what this session's erosion deposited, with
  // provenance — a loaded save cannot re-derive them.
  if (fields.sedimentBasins && fields.sedimentBasins.length > 0) {
    zip.file('layers/sedimentBasins.json', JSON.stringify(fields.sedimentBasins))
    layers.push({ name: 'sedimentBasins', file: 'layers/sedimentBasins.json', kind: 'table' })
  }
  // The adaptive mesh: the terrain proper, from which `elevation.f32` is
  // rasterised. Its files under `mesh/`, described by one manifest entry.
  if (mesh) {
    zip.file('mesh/nodes.f32', mesh.nodes)
    zip.file('mesh/connectivity.bin', mesh.connectivity)
    zip.file('mesh/z.f32', mesh.z)
    if (mesh.column) zip.file('mesh/column.bin', mesh.column)
    // The land fields per node, in the mesh's numbering (climateFields.ts).
    const land = fields.land && fields.land.count === mesh.count ? fields.land : null
    if (land) {
      zip.file(LAND_FILES.biome, land.biome.slice().buffer as ArrayBuffer)
      zip.file(LAND_FILES.koppen, land.koppen.slice().buffer as ArrayBuffer)
      if (land.waterTable) zip.file(LAND_FILES.waterTable, land.waterTable.slice().buffer as ArrayBuffer)
      // Rivers are a DISCHARGE FIELD, not polylines: a field answers "how
      // big is this river" by sampling, as lakeDepth does, where a
      // polyline's only attribute was a drawing width.
      if (land.discharge) zip.file(LAND_FILES.discharge, land.discharge.slice().buffer as ArrayBuffer)
    }
  }
  const manifest = {
    formatVersion: WORLD_ARCHIVE_FORMAT_VERSION,
    // The same provenance string status.generator carries.
    generatorVersion: parts.generatorVersion,
    // The shape is the record's kind (world.yaml), said once (DEC-0035).
    world: { width, height },
    layers,
    mesh: mesh ? {
      nodes: mesh.count,
      files: {
        nodes: 'mesh/nodes.f32', connectivity: 'mesh/connectivity.bin', z: 'mesh/z.f32', column: mesh.column ? 'mesh/column.bin' : undefined,
        ...(fields.land && fields.land.count === mesh.count ? { biome: LAND_FILES.biome, koppen: LAND_FILES.koppen, waterTable: fields.land.waterTable ? LAND_FILES.waterTable : undefined, discharge: fields.land.discharge ? LAND_FILES.discharge : undefined } : {}),
      },
    } : undefined,
    climate: fields.climate ? { file: 'climate.json', cells: fields.climate.cells, spacingM: fields.climate.spacingM } : undefined,
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
}
