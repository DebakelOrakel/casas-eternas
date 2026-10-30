import type { Domain } from '../core/domain'
import { sharedFieldMesh, type FieldMesh, type FieldSampler } from '../fields/fieldMesh'

// THE STATIC CLIMATE'S FIELD MESH (DEC-0036 phase 3, docs/decisions/
// fields-on-meshes.md): temperature, wind, seasonality, the monsoon, the
// moisture transport and the pressure run on one field mesh, both shapes,
// one code — Goldberg cells on the sphere, hexagons on the torus, the
// values at the cells' centres, Float64. No pole rows, no polar filter.
//
// The spacing is the former 256 × 128 raster's equator cell, the domain's
// width / 256: 62.4 km on the torus, 78.1 km on the sphere — the ocean
// age's mesh (tectonics/oceanAge.ts), which the two share
// (fields/fieldMesh.sharedFieldMesh). Lengths are the mesh's metres
// (domain.metresPerUnit), so a harness world narrower than 2048 is a
// smaller world for the climate as for the mesh.
//
// A vector is an east/south pair per cell, in the cell's own frame (the
// Domain's: +y south), in the wind's units (1 = 8 m/s).
export const CLIMATE_MESH_RES_X = 256

export interface ClimateMesh {
  readonly mesh: FieldMesh
  readonly sampler: FieldSampler
  readonly cellM: number
  // Per cell: the chart's row position y / height, 0..1 (the latitude's
  // reading, climateField.shiftedYNorm's input).
  readonly yNorm: Float64Array
  // Zonal bands: a cell's band, and per band the centre's yNorm — for a
  // field's mean along its latitude (zonalMean). As many bands as the
  // torus's lattice has rows, so on the torus a band IS a row of cells.
  readonly bands: number
  readonly band: Int32Array
}

const meshes = new Map<string, ClimateMesh>()
let lastDomain: Domain | null = null
let lastMesh: ClimateMesh | null = null

export function climateMesh(domain: Domain): ClimateMesh {
  if (domain === lastDomain && lastMesh) return lastMesh
  const key = `${domain.kind}:${domain.width}:${domain.height}:${domain.metresPerUnit}`
  let made = meshes.get(key)
  if (!made) {
    const cellUnits = domain.width / CLIMATE_MESH_RES_X
    const cellM = cellUnits * domain.metresPerUnit
    const { mesh, sampler } = sharedFieldMesh(domain, cellM)
    const yNorm = new Float64Array(mesh.count)
    for (let i = 0; i < mesh.count; i++) yNorm[i] = mesh.y[i] / domain.height
    // The torus lattice's row count (mesh/lattice.ts hexLattice).
    let bands = Math.max(8, Math.round(domain.height / (cellUnits * Math.sqrt(3) / 2)))
    if (bands % 2 === 1) bands++
    const band = new Int32Array(mesh.count)
    for (let i = 0; i < mesh.count; i++) band[i] = Math.min(bands - 1, Math.max(0, Math.floor(yNorm[i] * bands)))
    made = { mesh, sampler, cellM, yNorm, bands, band }
    meshes.set(key, made)
  }
  lastDomain = domain
  lastMesh = made
  return made
}

// A field's area-weighted mean along each zonal band, over the cells
// `use` admits (all when absent), read back per cell — linear between the
// bands' centres, so a cell takes the mean of its own latitude, not of
// its band's edge. A band without an admitted cell takes the nearest
// band's mean that has one; none at all, 0. On the torus, where a band
// is a row of the lattice, a cell's value is its row's mean.
export function zonalMean(cm: ClimateMesh, field: ArrayLike<number>, use?: (i: number) => boolean): Float64Array {
  const { mesh, bands, band, yNorm } = cm
  const sum = new Float64Array(bands)
  const area = new Float64Array(bands)
  for (let i = 0; i < mesh.count; i++) {
    if (use && !use(i)) continue
    sum[band[i]] += mesh.area[i] * field[i]
    area[band[i]] += mesh.area[i]
  }
  const mean = new Float64Array(bands)
  const known = new Int32Array(bands).fill(-1)
  let any = false
  for (let b = 0; b < bands; b++) if (area[b] > 0) { mean[b] = sum[b] / area[b]; known[b] = b; any = true }
  if (!any) return new Float64Array(mesh.count)
  // Fill the bands without cells from the nearest that has some (toward
  // the equator first on a tie: the row nearer the middle).
  for (let b = 0; b < bands; b++) {
    if (known[b] >= 0) continue
    for (let d = 1; d < bands; d++) {
      const toward = b < bands / 2 ? b + d : b - d
      const away = b < bands / 2 ? b - d : b + d
      if (toward >= 0 && toward < bands && area[toward] > 0) { mean[b] = mean[toward]; break }
      if (away >= 0 && away < bands && area[away] > 0) { mean[b] = mean[away]; break }
    }
  }
  const out = new Float64Array(mesh.count)
  for (let i = 0; i < mesh.count; i++) {
    const f = yNorm[i] * bands - 0.5
    const b0 = Math.floor(f)
    const t = f - b0
    const lo = Math.max(0, b0)
    const hi = Math.min(bands - 1, b0 + 1)
    out[i] = mean[lo] * (1 - t) + mean[hi] * t
  }
  return out
}
