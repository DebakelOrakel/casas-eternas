// The save's own checks that read no generator type (a reader in Node, the
// job worker's, takes them without the worker's message contract):
// a field mesh's values back, and the refusal of a save from before the
// save held no raster (DEC-0036, the save step). The writer is
// worldArchive.ts, which re-exports these.

import type JSZip from 'jszip'

// A field mesh's values as the save holds them (pipeline/messages
// FieldPayload's shape): Float64 per cell, and the mesh's cell count and
// spacing in metres.
export interface SavedFieldBytes {
  values: ArrayBuffer
  cells: number
  spacingM: number
}

// The chart rasters the save step took out of the archive. A save that
// holds one is from before it and is refused, not converted (fork 5: "mit
// der Brechstange"); so is a tectonic save without the mesh they were the
// rasterisations of (`state.json` and no `mesh/nodes.f32`).
export const FORMER_RASTERS = ['elevation.f32', 'layers/lakeDepth.u8', 'layers/uplift.f32', 'layers/erodibility.f32'] as const

export function refuseFormerRasters(zip: JSZip): void {
  const former = FORMER_RASTERS.find((file) => zip.file(file) !== null)
  if (former) throw new Error(`${former}: a save from before the save held no raster`)
  if (zip.file('state.json') && !zip.file('mesh/nodes.f32')) throw new Error('a tectonic save without its mesh')
}

// A field-mesh field's reader (worldArchive.writeField writes it: the mantle,
// the ocean age): the two entries back, or an error when either
// is missing or malformed (a save from before the field moved onto its
// mesh — before formatVersion 8, or for the ocean age a version-8 save from
// before DEC-0036 phase 2).
export async function readField(zip: JSZip, name: string): Promise<SavedFieldBytes> {
  const values = zip.file(`${name}.f64`)
  const meta = zip.file(`${name}.json`)
  if (!values || !meta) throw new Error(`no ${name}.f64 / ${name}.json: a save from before the field moved onto its mesh`)
  const { cells, spacingM } = JSON.parse(await meta.async('string')) as { cells: unknown; spacingM: unknown }
  const bytes = await values.async('arraybuffer')
  if (typeof cells !== 'number' || typeof spacingM !== 'number' || bytes.byteLength !== cells * 8) throw new Error(`${name}: ${bytes.byteLength} bytes for ${String(cells)} cells`)
  return { values: bytes, cells, spacingM }
}
