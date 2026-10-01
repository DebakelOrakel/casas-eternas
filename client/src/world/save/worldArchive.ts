import JSZip from 'jszip'
import type { ArcheanSnapshot } from '../../generator/archean/archeanSnapshot'
import type { RefinedClimate } from '../../generator/climate/refinement'
import { OCEAN_PRECIP } from '../../generator/climate/precipitation'
import type { MeshPayload } from '../../generator/pipeline/messages'
import type { CoastReach } from '../../generator/surface/coastGraph'
import type { WaterBody } from '../../generator/surface/hydrology'
import type { SedimentBasin } from '../../generator/surface/sedimentBasins'
import type { PlateSimulationSnapshot } from '../../generator/tectonics/plateSimulation'
import { DISCHARGE_LAYER, FORCING_LAYERS, REFINED_LAYERS, WORLD_LAYERS, bakeLayer } from './worldLayers'
import { refinedLayerSources } from './refinedLayers'

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
  // The climate grid's size; the climate layers below are on it, except
  // the ones a layer spec puts on the world grid (biome).
  climateResX: number
  climateResY: number
  temperature: Float32Array | null
  precipitation: Float32Array | null
  precipitationEffective: Float32Array | null
  biome: Uint8Array | null
  seasonalAmplitude: Float32Array | null
  monsoonIndex: Float32Array | null
  koppen: Uint8Array | null
  lakeDepth: Float32Array | null
  waterTable: Float32Array | null
  // River discharge per world cell, m³/s.
  dischargeM3s: Float32Array | null
  // The climate step's refinement (formatVersion 6).
  refined: RefinedClimate | null
  waterBodies: WaterBody[] | null
  coast: { reaches: CoastReach[]; cells: Int32Array } | null
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
  archean: { snapshot: ArcheanSnapshot; mantle: ArrayBuffer; streak: ArrayBuffer }
}

export interface TectonicArchiveParts extends ArchiveCommon {
  kind: 'tectonic'
  snapshot: PlateSimulationSnapshot
  mantle: ArrayBuffer
  latticeAccumulated: ArrayBuffer
  latticeLockedEpochs: ArrayBuffer
  latticeLastClassCode: ArrayBuffer
  oceanAge: ArrayBuffer
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
// again.
export const WORLD_ARCHIVE_FORMAT_VERSION = 7

export async function writeWorldArchive(parts: WorldArchiveParts): Promise<Uint8Array<ArrayBuffer>> {
  const zip = new JSZip()
  zip.file('world.yaml', parts.yaml)
  if (parts.kind === 'archean') {
    zip.file('archean.json', JSON.stringify(parts.archean.snapshot))
    zip.file('archean.mantle.f32', parts.archean.mantle)
    zip.file('archean.streak.i16', parts.archean.streak)
    zip.file('elevation.f32', parts.elevation)
  } else {
    zip.file('state.json', JSON.stringify(parts.snapshot))
    zip.file('mantle.f32', parts.mantle)
    zip.file('lattice.acc.f32', parts.latticeAccumulated)
    zip.file('lattice.lock.i16', parts.latticeLockedEpochs)
    zip.file('lattice.class.i8', parts.latticeLastClassCode)
    zip.file('oceanAge.f32', parts.oceanAge)
    zip.file('elevation.f32', parts.elevation)
    writeQueryLayers(zip, parts)
  }
  if (parts.preview) zip.file('preview.png', parts.preview)
  // A fresh buffer of JSZip's own, never shared memory: typed as such so a
  // Blob takes it.
  return (await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })) as Uint8Array<ArrayBuffer>
}

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

  // Climate, hydrology: only once they have been computed.
  const rx = fields.climateResX
  const ry = fields.climateResY
  if (rx > 0 && fields.precipitation) {
    const precipitation = fields.precipitation
    const landMask = new Float32Array(rx * ry)
    for (let i = 0; i < landMask.length; i++) landMask[i] = precipitation[i] !== OCEAN_PRECIP ? 1 : 0
    const sources: Partial<Record<string, Float32Array | Uint8Array>> = {
      landMask,
      temperature: fields.temperature ?? undefined,
      precipitation,
      precipitationEffective: fields.precipitationEffective ?? undefined,
      biome: fields.biome ?? undefined,
      seasonalAmplitude: fields.seasonalAmplitude ?? undefined,
      monsoonIndex: fields.monsoonIndex ?? undefined,
      koppen: fields.koppen ?? undefined,
      lakeDepth: fields.lakeDepth ?? undefined,
      waterTable: fields.waterTable ?? undefined,
    }
    for (const spec of WORLD_LAYERS) {
      const src = sources[spec.name]
      if (!src) continue
      // Dimensions from the spec, not from the climate grid: biome is
      // baked on the world raster (see LayerSpec.fullRes). A wrong pair here
      // would not throw — the buffer's length is whatever the source is, and
      // only the manifest says how to fold it into rows.
      const [lx, ly] = spec.grid === 'world' ? [width, height] : [rx, ry]
      zip.file(`layers/${spec.name}.${spec.dtype}`, bakeLayer(src, spec))
      layers.push({ name: spec.name, file: `layers/${spec.name}.${spec.dtype}`, kind: 'raster', resX: lx, resY: ly, dtype: spec.dtype, encoding: { scale: spec.scale, offset: spec.offset }, unit: spec.unit, landOnly: spec.landOnly })
    }
    // Rivers are a DISCHARGE RASTER, not polylines: a field answers "how
    // big is this river" by sampling, as biome and lakeDepth do, where a
    // polyline's only attribute was a drawing width (109 KB compressed
    // against 303 KB of JSON).
    if (fields.dischargeM3s) {
      zip.file(`layers/${DISCHARGE_LAYER.name}.${DISCHARGE_LAYER.dtype}`, bakeLayer(fields.dischargeM3s, DISCHARGE_LAYER))
      layers.push({
        name: DISCHARGE_LAYER.name, file: `layers/${DISCHARGE_LAYER.name}.${DISCHARGE_LAYER.dtype}`, kind: 'raster',
        resX: width, resY: height, dtype: DISCHARGE_LAYER.dtype,
        encoding: { scale: DISCHARGE_LAYER.scale, offset: DISCHARGE_LAYER.offset },
        unit: DISCHARGE_LAYER.unit, landOnly: DISCHARGE_LAYER.landOnly,
      })
    }
  }
  // The climate step's refinement, one layer per month and component
  // (world/save/refinedLayers.ts). A world saved unrefined loads unrefined.
  if (fields.refined && rx > 0) {
    const sources = refinedLayerSources(fields.refined, rx * ry)
    for (const spec of REFINED_LAYERS) {
      const src = sources.get(spec.name)
      if (!src) continue
      zip.file(`layers/${spec.name}.${spec.dtype}`, bakeLayer(src, spec))
      layers.push({ name: spec.name, file: `layers/${spec.name}.${spec.dtype}`, kind: 'raster', resX: rx, resY: ry, dtype: spec.dtype, encoding: { scale: spec.scale, offset: spec.offset }, unit: spec.unit, landOnly: spec.landOnly })
    }
  }
  // The ENSO see-saw's period and strength, beside its pattern layer: what
  // a reader needs to roll the phase of a year.
  if (fields.refined) {
    const { ensoPeriodYears, ensoStrength } = fields.refined.reliability
    zip.file('layers/enso.json', JSON.stringify({ periodYears: ensoPeriodYears, strength: ensoStrength }))
    layers.push({ name: 'enso', file: 'layers/enso.json', kind: 'table' })
  }
  // The standing-water list: a table beside the rasters, the truth
  // `lakeDepth` derives from (hydrology.lakeDepthFromBodies), in this
  // raster's texel coordinates (formatVersion 2).
  if (fields.waterBodies) {
    zip.file('layers/waterBodies.json', JSON.stringify(fields.waterBodies))
    layers.push({ name: 'waterBodies', file: 'layers/waterBodies.json', kind: 'table' })
  }
  // The coast reaches, the same way: cells as indices into this raster.
  if (fields.coast) {
    zip.file('layers/coast.json', JSON.stringify({ reaches: fields.coast.reaches, cells: Array.from(fields.coast.cells) }))
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
  }
  const manifest = {
    formatVersion: WORLD_ARCHIVE_FORMAT_VERSION,
    // The same provenance string status.generator carries.
    generatorVersion: parts.generatorVersion,
    world: { width, height, topology: 'torus' },
    layers,
    mesh: mesh ? { nodes: mesh.count, files: { nodes: 'mesh/nodes.f32', connectivity: 'mesh/connectivity.bin', z: 'mesh/z.f32', column: mesh.column ? 'mesh/column.bin' : undefined } } : undefined,
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
}
