import type { Domain } from '../core/domain'
import { fieldFromRasterAreaWeighted, rasteriseField, rasteriseVectorField, sharedFieldMesh, type FieldMesh, type FieldSampler } from '../fields/fieldMesh'
import { isLandAt } from '../elevation/elevationScale'

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

// THE TERRAIN THE CLIMATE READS (DEC-0036 phase 3): an elevation raster
// over the domain (the world's 2048 × 1024 in the climate step, the
// epoch's 256 × 128 rasterisation of the mesh in the history) and its
// terminal-basin dry-floor mask, read onto the climate's mesh.
//
// Per cell, the POINT value at its centre — the texel under it, as the
// former raster read the texel under its cell's centre
// (climateField.sampleElevationAtCell): the lapse, the land test, the
// plateau before its smoothing and the continentality's coast are point
// questions, and the land test must agree with the texel test the raster
// readers and the save's land mask still make. The AREA-WEIGHTED mean
// (fields/fieldMesh.fieldFromRasterAreaWeighted) where an integral is
// meant: the relief the wind meets (pressure.ts), formerly the raster's
// box mean — computed on first use, it costs a locate per texel.
// The orography reads the raster at points along the wind (elevationAt).
export interface ClimateTerrain {
  readonly cm: ClimateMesh
  // The world's domain the mesh is built on.
  readonly domain: Domain
  // The raster as it came, resX × resY over the domain, and its dry-floor
  // mask (null: none) — what the transition readers below take.
  readonly elevation: Float32Array
  readonly resX: number
  readonly resY: number
  readonly dryLand: Uint8Array | null
  // The raster's own domain, one texel per unit (the former raster
  // stages' `domain` argument).
  readonly rasterDomain: Domain
  // Per cell: the elevation (model units) at the centre, land 1 / sea 0,
  // dry floor 1.
  readonly z: Float64Array
  readonly land: Uint8Array
  readonly dry: Uint8Array
  // The texel under a point of the domain.
  elevationAt(x: number, y: number): number
  // The mean elevation over each cell, model units (cached).
  meanElevation(): Float64Array
}

export function climateTerrain(domain: Domain, elevation: Float32Array, resX: number, resY: number, dryLand?: Uint8Array | null): ClimateTerrain {
  const cm = climateMesh(domain)
  const { mesh } = cm
  const kx = resX / domain.width
  const ky = resY / domain.height
  const texel = (x: number, y: number): number => {
    const tx = Math.min(resX - 1, Math.max(0, Math.floor(x * kx)))
    const ty = Math.min(resY - 1, Math.max(0, Math.floor(y * ky)))
    return ty * resX + tx
  }
  const z = new Float64Array(mesh.count)
  const land = new Uint8Array(mesh.count)
  const dry = new Uint8Array(mesh.count)
  for (let i = 0; i < mesh.count; i++) {
    const t = texel(mesh.x[i], mesh.y[i])
    z[i] = elevation[t]
    dry[i] = dryLand && dryLand[t] === 1 ? 1 : 0
    land[i] = isLandAt(z[i], dry[i] === 1) ? 1 : 0
  }
  let mean: Float64Array | null = null
  return {
    cm,
    domain,
    elevation,
    resX,
    resY,
    dryLand: dryLand ?? null,
    rasterDomain: resX === domain.width && resY === domain.height ? domain : domain.scaledTo(resX, resY),
    z,
    land,
    dry,
    elevationAt: (x, y) => elevation[texel(x, y)],
    meanElevation: () => (mean ??= fieldFromRasterAreaWeighted(mesh, cm.sampler, elevation, resX, resY)),
  }
}

// ------------------------------------------------ DEC-0036 transition

// The climate grid's rasters of the mesh's fields, for the readers that
// keep the 256 × 128 raster until their own phase: the ocean currents and
// the energy balance (phase 4), the refinement and the phenomena (phase 5),
// biomes, ecology, hydrology and hydrogeology, the ice, the coast, the
// column's ledger, the save's layers and the screen's overlays (phase 7 and
// the save's own step). Each is made once per climate run.

// DEC-0036 transition: removed in phase 7. A scalar field without a
// sentinel (temperature), cell centres.
export function climateRaster(cm: ClimateMesh, field: ArrayLike<number>, resX: number, resY: number): Float32Array {
  return rasteriseField(cm.mesh, field, resX, resY)
}

// DEC-0036 transition: removed in phase 7. A vector field, each pixel's
// vector in its own frame (fields/fieldMesh.rasteriseVectorField).
export function climateVectorRaster(cm: ClimateMesh, fe: ArrayLike<number>, fs: ArrayLike<number>, resX: number, resY: number): Float32Array {
  return rasteriseVectorField(cm.sampler, fe, fs, resX, resY)
}

// The land test of a resX × resY climate raster over the terrain: its
// cell (gx, gy) is land when the texel under its centre is — the former
// climate grid's own test (climateField.isLandAtCell), so the transition
// rasters keep the land mask the save and the raster readers had.
export function rasterLand(terrain: ClimateTerrain, resX: number, resY: number): Uint8Array {
  const out = new Uint8Array(resX * resY)
  const { domain } = terrain
  const kx = terrain.resX / domain.width
  const ky = terrain.resY / domain.height
  for (let gy = 0; gy < resY; gy++) {
    const y = ((gy + 0.5) / resY) * domain.height
    const ty = Math.min(terrain.resY - 1, Math.floor(y * ky))
    for (let gx = 0; gx < resX; gx++) {
      const x = ((gx + 0.5) / resX) * domain.width
      const t = ty * terrain.resX + Math.min(terrain.resX - 1, Math.floor(x * kx))
      out[gy * resX + gx] = isLandAt(terrain.elevation[t], terrain.dryLand !== null && terrain.dryLand[t] === 1) ? 1 : 0
    }
  }
  return out
}

// DEC-0036 transition: removed in phase 7. A LAND field (a sentinel on the
// sea: OCEAN_PRECIP, OCEAN_AMPLITUDE) on the climate raster: a sea pixel
// (rasterLand) takes the sentinel; a land pixel the barycentric mix of its
// triangle's LAND corners, renormalised — never a blend with the sentinel;
// a land pixel with no land corner (an island smaller than a cell) its
// latitude's land mean, the island rule of climateField.zonalLandMean.
export function climateLandRaster(terrain: ClimateTerrain, field: ArrayLike<number>, sentinel: number, resX: number, resY: number, landPixels: Uint8Array): Float32Array {
  const { cm, domain } = terrain
  const { sampler } = cm
  const out = new Float32Array(resX * resY)
  const isLand = (i: number): boolean => terrain.land[i] === 1 && field[i] !== sentinel
  const islands = zonalMean(cm, field, isLand)
  const corners = new Int32Array(3)
  const weights = new Float64Array(3)
  const sx = domain.width / resX
  const sy = domain.height / resY
  for (let gy = 0; gy < resY; gy++) {
    const y = (gy + 0.5) * sy
    for (let gx = 0; gx < resX; gx++) {
      const p = gy * resX + gx
      if (!landPixels[p]) {
        out[p] = sentinel
        continue
      }
      const x = (gx + 0.5) * sx
      sampler.taps(x, y, corners, weights)
      let s = 0
      let w = 0
      for (let k = 0; k < 3; k++) {
        if (!isLand(corners[k])) continue
        s += weights[k] * field[corners[k]]
        w += weights[k]
      }
      out[p] = w > 0 ? s / w : islands[sampler.nearestCell(x, y)]
    }
  }
  return out
}
