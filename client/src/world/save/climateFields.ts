// The world's climate and its land fields in the save (DEC-0036 phase 7,
// fork 5 as revised: no raster field in the save).
//
// THE CLIMATE: the annual fields per cell of the climate's field mesh,
// one Float32 file per field under `climate/`, described by `climate.json`
// (the mesh's cell count and spacing in metres, which a reader checks —
// the mesh is rebuilt from the world's shape and size — and each field's
// file and unit). The fields are the ones a reader samples at its own
// points (generator/climate/climatePoints.ClimateCells): the air
// temperature REDUCED TO SEA LEVEL (a reader takes its point's own lapse
// back, CLIMATE_TUNING.lapseCPerElevation per elevation unit above the
// sea), the rain, the seasonal range and the signed monsoon index, the sea
// marked by OCEAN_PRECIP / OCEAN_AMPLITUDE. The climate the world's land
// fields were computed from: the refinement's year when the world is
// refined, else the static climate the hydrology settled. Float32, the
// values the session samples (runtime.ClimateResult.cells), so a bake
// samples exactly what the generator did. They replace the raster layers
// landMask, temperature, precipitation, seasonalAmplitude and
// monsoonIndex (u8/u16 at 256 × 128).
//
// THE LAND FIELDS: per node of the saved mesh, in its numbering (the
// mesh's own files under `mesh/`): `mesh/biome.u8` (the biome, climate/
// biomes.ts ids — the map's, with the hydrology's riparian corridors, salt
// flats and glaciers), `mesh/koppen.u8` (the Köppen class, 0 on the sea),
// `mesh/waterTable.f32` (the water table's depth, metres, −1 under water),
// `mesh/discharge.f32` (the river discharge, m³/s, DEC-0036 phase 7b).
// They replace the raster layers biome (2048 × 1024), koppen, waterTable
// and discharge. The generator recomputes all of them on load; they are
// here for the save's readers (world/query.ts, which rasterises them for
// its views).

import type JSZip from 'jszip'
import type { ClimateCellValues } from '../../generator/climate/climatePoints'

export type SavedClimate = ClimateCellValues

export interface SavedLandFields {
  // Nodes, the saved mesh's count.
  count: number
  biome: Uint8Array
  koppen: Uint8Array
  waterTable: Float32Array | null
  // m³/s; null before the hydrology ran.
  discharge: Float32Array | null
}

const CLIMATE_FIELDS = [
  { name: 'seaLevelTemperature', unit: '°C at sea level' },
  { name: 'precipitation', unit: 'mm/yr' },
  { name: 'seasonalAmplitude', unit: '°C' },
  { name: 'monsoonIndex', unit: '' },
] as const

type ClimateFieldName = (typeof CLIMATE_FIELDS)[number]['name']

const climateFile = (name: string): string => `climate/${name}.f32`

export function climateEntries(c: SavedClimate): { meta: string; files: [string, ArrayBuffer][] } {
  const meta = { cells: c.cells, spacingM: c.spacingM, fields: CLIMATE_FIELDS.map((f) => ({ name: f.name, file: climateFile(f.name), unit: f.unit })) }
  const files = CLIMATE_FIELDS.map((f): [string, ArrayBuffer] => [climateFile(f.name), c[f.name].slice().buffer as ArrayBuffer])
  return { meta: JSON.stringify(meta), files }
}

// The climate from climate.json and its files; throws on a field missing or
// of the wrong length.
export async function climateFromEntries(metaText: string, read: (file: string) => Promise<ArrayBuffer | null>): Promise<SavedClimate> {
  const meta = JSON.parse(metaText) as { cells?: unknown; spacingM?: unknown }
  const { cells, spacingM } = meta
  if (typeof cells !== 'number' || typeof spacingM !== 'number') throw new Error('climate.json: no mesh')
  const values = {} as Record<ClimateFieldName, Float32Array>
  for (const f of CLIMATE_FIELDS) {
    const bytes = await read(climateFile(f.name))
    if (!bytes || bytes.byteLength !== cells * 4) throw new Error(`climate: ${f.name} missing or not ${cells} values`)
    values[f.name] = new Float32Array(bytes)
  }
  return { cells, spacingM, ...values }
}

export const LAND_FILES = { biome: 'mesh/biome.u8', koppen: 'mesh/koppen.u8', waterTable: 'mesh/waterTable.f32', discharge: 'mesh/discharge.f32' } as const

// The raster layers this replaces: a save that still holds one, and not
// its replacement, is from before the move and is refused, not converted
// (fork 5: "mit der Brechstange").
export const FORMER_CLIMATE_LAYERS = ['layers/landMask.u8', 'layers/temperature.u8', 'layers/precipitation.u16', 'layers/biome.u8', 'layers/koppen.u8', 'layers/waterTable.u16', 'layers/seasonalAmplitude.u8', 'layers/monsoonIndex.u8', 'layers/precipitationEffective.u16'] as const

// The climate back (climateFields.ts): null for a save without one (saved
// before its climate ran); an error for a save whose climate is incomplete,
// or still the raster layers of a build before DEC-0036 phase 7 (refused,
// not converted). Whether the cells belong to this world's climate mesh is
// the reader's check (climatePoints.climateCellsFromSaved).
export async function readClimate(zip: JSZip): Promise<SavedClimate | null> {
  const meta = zip.file('climate.json')
  if (!meta) {
    if (FORMER_CLIMATE_LAYERS.some((file) => zip.file(file))) throw new Error('a climate as raster layers: a save from before the climate moved onto its mesh')
    return null
  }
  return climateFromEntries(await meta.async('string'), async (file) => (await zip.file(file)?.async('arraybuffer')) ?? null)
}

// The land fields per node of the saved mesh (`count` nodes), null for a
// save without them; an error for one of the wrong length.
export async function readLandFields(zip: JSZip, count: number): Promise<SavedLandFields | null> {
  const biome = zip.file(LAND_FILES.biome)
  const koppen = zip.file(LAND_FILES.koppen)
  if (!biome || !koppen) return null
  const b = new Uint8Array(await biome.async('arraybuffer'))
  const k = new Uint8Array(await koppen.async('arraybuffer'))
  const tableFile = zip.file(LAND_FILES.waterTable)
  const table = tableFile ? new Float32Array(await tableFile.async('arraybuffer')) : null
  const dischargeFile = zip.file(LAND_FILES.discharge)
  const discharge = dischargeFile ? new Float32Array(await dischargeFile.async('arraybuffer')) : null
  if (b.length !== count || k.length !== count || (table && table.length !== count) || (discharge && discharge.length !== count)) throw new Error(`the land fields hold ${b.length} nodes, the mesh ${count}`)
  return { count, biome: b, koppen: k, waterTable: table, discharge }
}

// THE HYDROLOGY'S RASTER PARTS, refused (DEC-0036 phase 7b, fork 5): the
// discharge as a world-raster layer (`layers/discharge.u16`, now
// `mesh/discharge.f32`) and the coast reaches with their cells as raster
// indices (`layers/coast.json` with `cells`, now `nodes`: the saved mesh's
// vertex ids). An error names what a save from before the move holds; a
// save without either is fine (saved before its hydrology ran).
export async function refuseFormerHydrology(zip: JSZip): Promise<void> {
  if (zip.file('layers/discharge.u16')) throw new Error('a discharge raster: a save from before the hydrology moved onto its mesh')
  const coast = zip.file('layers/coast.json')
  if (coast) {
    const parsed = JSON.parse(await coast.async('string')) as { nodes?: unknown }
    if (!Array.isArray(parsed.nodes)) throw new Error('coast reaches over raster cells: a save from before the hydrology moved onto its mesh')
  }
}
