import { Biome } from '../../generator/climate/biomes'
import { domainOfKind } from '../../generator/core/domain'
import { decodeFineValue, ECOLOGY_FINE_OCEAN, type EcologyFieldId } from '../../generator/ecology/ecologyField'
import { ELEVATION_METERS } from '../../generator/elevation/elevationScale'
import { createFieldMesh, createFieldSampler, rasterOwners } from '../../generator/fields/fieldMesh'
import { RIVER_MAX_WIDTH, RIVER_MIN_WIDTH, RIVER_REGIME_CODE, type RiverPolylines } from '../../generator/surface/hydrology'
import { LEVEL_ECOLOGY, type Habitat } from './habitat'
import { detHypot } from '../../generator/core/detMath'

// THE INCUBATOR'S CELLS (2026-10-26): the habitat (habitat.ts) on the
// generator's field mesh at CELL_SPACING_KM, unrelaxed (fields/fieldMesh.ts,
// mesh/lattice.ts geodesicLattice), made from level 1. A cell takes the
// level's nodes under it through the chart's node map (chartWorker.ts,
// a node per texel at half the chart's size): it is land where most of its
// texels are, its biome and Köppen class are its centre's (or one of its
// land's), its height and ecology the mean over its land, its sea's depth
// its shallowest sea texel's: the mean over a cell of 10 km left 1.5 % of
// Morvane's sea on the shelf and no land bridge (2026-10-26). Its texels are found once (`owners`), and serve
// the drawing too: a texel shows the cell that owns it.

export const CELL_SPACING_KM = 10

export interface CellInput {
  kind: 'sphere' | 'torus'
  // The cells' spacing, km: CELL_SPACING_KM unless given (coarser for a
  // test world: on the sphere the cells are as many whatever its raster).
  spacingKm?: number
  // The world raster's size, the domain's.
  width: number
  height: number
  // The level's node under each texel, `nodeW` × `nodeH` over the chart.
  nodes: Int32Array
  nodeW: number
  nodeH: number
  // Per node: the level's land, biome, Köppen class, height (elevation
  // units), lakes' depth, and the ecology's fields as their fine codes.
  land: Uint8Array
  biome: Uint8Array
  koppen: Uint8Array
  z: Float32Array
  lakeDepth: Float32Array
  ecology: Partial<Record<EcologyFieldId, Uint8Array>>
  // The level's rivers, in the world raster's texels.
  rivers: Pick<RiverPolylines, 'points' | 'lengths' | 'regimes'> | null
}

// The ecology's fields a cell takes: the game, the carrying capacity and
// LEVEL_ECOLOGY.
const CELL_ECOLOGY: readonly EcologyFieldId[] = ['game', 'carryingCapacity', ...LEVEL_ECOLOGY]

export function buildCells(input: CellInput): { habitat: Habitat; owners: Int32Array } {
  const domain = domainOfKind(input.kind, input.width, input.height)
  const fm = createFieldMesh(domain, (input.spacingKm ?? CELL_SPACING_KM) * 1000, false)
  const sampler = createFieldSampler(fm)
  const n = fm.count
  const owners = rasterOwners(sampler, input.nodeW, input.nodeH)

  // The texels of each cell, their land and their sums.
  const texels = new Int32Array(n)
  const landTexels = new Int32Array(n)
  const zLand = new Float64Array(n)
  const zSea = new Float64Array(n).fill(-Infinity)
  const lake = new Uint8Array(n)
  const anyLandNode = new Int32Array(n).fill(-1)
  const sums = CELL_ECOLOGY.map(() => new Float64Array(n))
  const codes = CELL_ECOLOGY.map((id) => input.ecology[id] ?? null)
  for (let t = 0; t < owners.length; t++) {
    const c = owners[t]
    const v = input.nodes[t]
    texels[c]++
    if (input.land[v]) {
      landTexels[c]++
      zLand[c] += input.z[v]
      anyLandNode[c] = v
      for (let k = 0; k < codes.length; k++) {
        const code = codes[k]?.[v]
        if (code !== undefined && code !== ECOLOGY_FINE_OCEAN) sums[k][c] += decodeFineValue(code)
      }
    } else zSea[c] = Math.max(zSea[c], input.z[v])
    if (input.lakeDepth[v] > 0) lake[c] = 1
  }

  // The node at a cell's centre, through the node map.
  const centreNode = (c: number): number => {
    const px = Math.min(input.nodeW - 1, Math.floor((fm.x[c] / domain.width) * input.nodeW))
    const py = Math.min(input.nodeH - 1, Math.max(0, Math.floor((fm.y[c] / domain.height) * input.nodeH)))
    return input.nodes[py * input.nodeW + ((px + input.nodeW) % input.nodeW)]
  }

  const land = new Uint8Array(n)
  const heightM = new Float32Array(n)
  const seaDepthM = new Float32Array(n)
  const biome = new Uint8Array(n)
  const koppen = new Uint8Array(n)
  const areaKm2 = new Float32Array(n)
  const ecology: Partial<Record<EcologyFieldId, Float32Array>> = {}
  const means = CELL_ECOLOGY.map((id, k) => (codes[k] ? (ecology[id] = new Float32Array(n)) : null))
  let landCount = 0
  for (let c = 0; c < n; c++) {
    areaKm2[c] = fm.area[c] / 1e6
    const centre = centreNode(c)
    const seen = texels[c] > 0
    const isLand = seen ? 2 * landTexels[c] >= texels[c] : input.land[centre] === 1
    if (isLand) {
      land[c] = 1
      landCount++
      const node = input.land[centre] ? centre : anyLandNode[c] >= 0 ? anyLandNode[c] : centre
      biome[c] = input.biome[node]
      koppen[c] = input.koppen[node]
      heightM[c] = (landTexels[c] > 0 ? zLand[c] / landTexels[c] : input.z[centre]) * ELEVATION_METERS
      for (let k = 0; k < means.length; k++) {
        const m = means[k]
        if (m) m[c] = landTexels[c] > 0 ? sums[k][c] / landTexels[c] : 0
      }
    } else {
      biome[c] = Biome.Ocean
      seaDepthM[c] = -(texels[c] > landTexels[c] ? zSea[c] : input.z[centre]) * ELEVATION_METERS
    }
  }

  // The neighbours, distances in km.
  const nbrStart = fm.nbrStart
  const nbr = fm.nbr
  const distKm = Float32Array.from(fm.dist, (d) => d / 1000)

  // The slope: the mean over the neighbours of the height's fall a metre.
  const slope = new Float32Array(n)
  for (let c = 0; c < n; c++) {
    if (!land[c]) continue
    let sum = 0
    let count = 0
    for (let e = nbrStart[c]; e < nbrStart[c + 1]; e++) {
      const u = nbr[e]
      if (!land[u]) continue
      sum += Math.abs(heightM[u] - heightM[c]) / (fm.dist[e] || 1)
      count++
    }
    slope[c] = count > 0 ? sum / count : 0
  }

  // The rivers: the cells their segments cross, walked a quarter of a
  // world texel at a time; the ephemeral ones left out.
  const nearRiver = new Uint8Array(n)
  const riverSize = new Float32Array(n)
  if (input.rivers) {
    const { points, lengths, regimes } = input.rivers
    let start = 0
    for (let r = 0; r < lengths.length; r++) {
      const count = lengths[r]
      if (regimes[r] !== RIVER_REGIME_CODE.ephemeral) {
        for (let k = start; k < start + count - 1; k++) {
          const ax = points[3 * k]
          const ay = points[3 * k + 1]
          const bx = points[3 * k + 3]
          const by = points[3 * k + 4]
          const size = (points[3 * k + 2] - RIVER_MIN_WIDTH) / (RIVER_MAX_WIDTH - RIVER_MIN_WIDTH)
          const steps = Math.max(1, Math.ceil(detHypot(bx - ax, by - ay) / 0.25))
          for (let s = 0; s <= steps; s++) {
            const c = sampler.nearestCell(domain.wrapX(ax + ((bx - ax) * s) / steps), Math.min(domain.height - 1e-6, Math.max(0, ay + ((by - ay) * s) / steps)))
            if (!land[c]) continue
            nearRiver[c] = 1
            riverSize[c] = Math.max(riverSize[c], size)
          }
        }
      }
      start += count
    }
  }

  // The lakes near, the sea within two rings.
  const nearLake = new Uint8Array(n)
  const nearSea = new Uint8Array(n)
  const seaRing = new Uint8Array(n)
  for (let c = 0; c < n; c++) {
    if (!land[c]) continue
    let lakeNear = lake[c]
    for (let e = nbrStart[c]; e < nbrStart[c + 1]; e++) {
      if (lake[nbr[e]]) lakeNear = 1
      if (!land[nbr[e]]) seaRing[c] = 1
    }
    nearLake[c] = lakeNear
  }
  for (let c = 0; c < n; c++) {
    if (!land[c]) continue
    let near = seaRing[c]
    for (let e = nbrStart[c]; e < nbrStart[c + 1] && !near; e++) near = seaRing[nbr[e]]
    nearSea[c] = near
  }

  // The landmasses.
  const landmass = new Int32Array(n).fill(-1)
  let landmasses = 0
  const areas: number[] = []
  const stack: number[] = []
  for (let s = 0; s < n; s++) {
    if (!land[s] || landmass[s] >= 0) continue
    landmass[s] = landmasses
    let area = 0
    stack.push(s)
    while (stack.length > 0) {
      const c = stack.pop()!
      area += areaKm2[c]
      for (let e = nbrStart[c]; e < nbrStart[c + 1]; e++) {
        const u = nbr[e]
        if (!land[u] || landmass[u] >= 0) continue
        landmass[u] = landmasses
        stack.push(u)
      }
    }
    areas.push(area)
    landmasses++
  }

  const habitat: Habitat = {
    count: n,
    torus: input.kind === 'torus',
    land,
    landCount,
    areaKm2,
    heightM,
    slope,
    seaDepthM,
    biome,
    koppen,
    nearRiver,
    riverSize,
    nearLake,
    nearSea,
    landmass,
    landmasses,
    landmassKm2: Float64Array.from(areas),
    game: ecology.game ?? null,
    carrying: ecology.carryingCapacity ?? null,
    ecology,
    nbrStart,
    nbr,
    distKm,
    u: Float32Array.from(fm.x, (x) => x / domain.width),
    v: Float32Array.from(fm.y, (y) => y / domain.height),
    radiusKm: fm.radiusM / 1000,
    widthKm: (domain.width * fm.unitM) / 1000,
    heightKm: (domain.height * fm.unitM) / 1000,
  }
  return { habitat, owners }
}
