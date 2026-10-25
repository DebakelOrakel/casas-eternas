import { MinHeap } from '../../generator/core/minHeap'
import { Biome } from '../../generator/climate/biomes'
import { ELEVATION_METERS } from '../../generator/elevation/elevationScale'
import type { LevelLand } from '../../world/meshArtifacts'
import { decodeFineValue, ECOLOGY_FINE_OCEAN } from '../../generator/ecology/ecologyField'
import { RIVER_MAX_WIDTH, RIVER_MIN_WIDTH, RIVER_REGIME_CODE, type RiverPolylines } from '../../generator/surface/hydrology'

// THE INCUBATOR'S HABITAT (2026-10-25, a trial): the world raster as a
// living thing sees it, for the animals (animalWorker.ts) and the plants
// (plantWorker.ts) alike: per land cell the height, the slope, a river
// near and its size, a lake near, the sea near, and the game the land
// feeds. The
// rivers are level 1's, the ones the chart draws, when they are given: the
// save's discharge on the world raster follows other courses (2026-10-25,
// Morvane: 17 % of level 1's river points lie on a raster cell the save's
// discharge calls a river), and the green along them missed the rivers
// drawn. And the two
// steps both take: a niche's response (a trapezoid) and the spread of a
// range from its origins.
//
// The ground and the water are level 1's when it carries its land fields
// (levelRasters, 2026-10-25): the height, the biomes, the Köppen classes,
// the discharge and the lakes of the level's node under each cell, so the
// plants and the animals stand on the terrain the chart draws; and the
// ecology's game (its field `game`). Without them, the save's rasters and
// no game. The climate counts through the Köppen classes alone: the
// months the save's chart holds (256 × 128) left a level-1 coast without
// any, and the world's climates are not the earth's (plants.ts).


export interface HabitatInput {
  kind: 'sphere' | 'torus'
  width: number
  height: number
  // Metres a world cell spans: the torus's, or the sphere's at the equator.
  cellMetres: number
  elevation: Float32Array
  biome: Float32Array
  discharge: Float32Array
  // The lakes' depth, elevation units (0 off a lake); null without lakes.
  lakeDepth: Float32Array | null
  // The Köppen–Geiger class ids (generator/climate/koppen.ts).
  koppen: Float32Array
  // Level 1's rivers, in the world raster's texels; null for the save's
  // discharge instead.
  rivers: Pick<RiverPolylines, 'points' | 'lengths' | 'regimes'> | null
  // The ecology's game, 0 … 3 (its fine field, decoded); null without one.
  game: Float32Array | null
  seed: number
}

export interface Habitat {
  W: number
  H: number
  torus: boolean
  land: Uint8Array
  landCount: number
  heightM: Float32Array
  slope: Float32Array
  // A river in the cell (level 1's), or near it (the save's discharge,
  // a cell around).
  nearRiver: Uint8Array
  // The size of the biggest river in the cell, 0 … 1: the square root of
  // its discharge over the world's largest, as the ribbon's width is
  // (surface/riverGraph.ts). 0 without a river.
  riverSize: Float32Array
  // A lake in the cell or a cell around.
  nearLake: Uint8Array
  nearSea: Uint8Array
  // The land's connected pieces (8-neighbours): an id a land cell, -1 at
  // sea; and how many there are.
  landmass: Int32Array
  landmasses: number
  // Each landmass's area, km².
  landmassKm2: Float64Array
  // A cell's east-west extent by row, and its north-south one, km.
  dxKm: Float64Array
  dyKm: number
  wrapX(x: number): number
  clampY(y: number): number
}

// A river from the save's discharge, without level 1's rivers (its units;
// the land's median is ~2, its 90th percentile ~30).
export const RIVER_DISCHARGE = 20
// The steps a river's segment is walked in, cells: fine enough to mark
// every cell it crosses.
const RIVER_STEP = 0.25
// The coast: land this many cells from the sea or nearer (~20 km).
const COAST_CELLS = 2

// A trapezoid [a, b, c, d]: 0 below a, up to 1 at b, 1 to c, down to 0 at d.
export type Trapezoid = readonly [number, number, number, number]

export function trapezoid(v: number, t: Trapezoid): number {
  if (v <= t[0] || v >= t[3]) return 0
  if (v < t[1]) return (v - t[0]) / (t[1] - t[0])
  if (v > t[2]) return (t[3] - v) / (t[3] - t[2])
  return 1
}


// The habitat's ground and water from level 1: per world cell the fields
// of the node under its middle, through the chart's node map (chartWorker,
// `nodeW` × `nodeH` over the world). A node of the land at or under the
// sea's level (a dry basin's floor) is put just above it, as the habitat
// tells the land by its height.
export function levelRasters(
  land: Pick<LevelLand, 'land' | 'biome' | 'koppen' | 'discharge' | 'lakeDepth' | 'ecology'>,
  z: Float32Array,
  nodes: Int32Array,
  nodeW: number,
  nodeH: number,
  W: number,
  H: number,
): Pick<HabitatInput, 'elevation' | 'biome' | 'koppen' | 'discharge' | 'lakeDepth' | 'game'> {
  const n = W * H
  const elevation = new Float32Array(n)
  const biome = new Float32Array(n)
  const koppen = new Float32Array(n)
  const discharge = new Float32Array(n)
  const lakeDepth = new Float32Array(n)
  const gameCodes = land.ecology.game
  const game = gameCodes ? new Float32Array(n) : null
  for (let y = 0; y < H; y++) {
    const ny = Math.min(nodeH - 1, Math.floor(((y + 0.5) / H) * nodeH))
    for (let x = 0; x < W; x++) {
      const v = nodes[ny * nodeW + Math.min(nodeW - 1, Math.floor(((x + 0.5) / W) * nodeW))]
      const i = y * W + x
      elevation[i] = land.land[v] ? Math.max(z[v], 1e-6) : z[v]
      biome[i] = land.biome[v]
      koppen[i] = land.koppen[v]
      discharge[i] = land.discharge[v]
      lakeDepth[i] = land.lakeDepth[v]
      if (game && gameCodes && gameCodes[v] !== ECOLOGY_FINE_OCEAN) game[i] = decodeFineValue(gameCodes[v])
    }
  }
  return { elevation, biome, koppen, discharge, lakeDepth, game }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashText(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

export function readHabitat(input: HabitatInput): Habitat {
  const { width: W, height: H, elevation, biome, discharge } = input
  const torus = input.kind === 'torus'
  const n = W * H
  const dyKm = input.cellMetres / 1000
  const dxKm = new Float64Array(H)
  for (let y = 0; y < H; y++) dxKm[y] = torus ? dyKm : dyKm * Math.cos(((y + 0.5) / H - 0.5) * Math.PI)
  const wrapX = (x: number): number => (x + W) % W
  const clampY = (y: number): number => torus ? (y + H) % H : Math.min(H - 1, Math.max(0, y))

  const land = new Uint8Array(n)
  const heightM = new Float32Array(n)
  const slope = new Float32Array(n)
  const river = new Uint8Array(n)
  const riverSize = new Float32Array(n)
  // Without level 1's rivers, the size from the save's discharge.
  let maxDischarge = 0
  if (!input.rivers) for (let i = 0; i < n; i++) maxDischarge = Math.max(maxDischarge, discharge[i])
  let landCount = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (elevation[i] <= 0 || biome[i] === Biome.Ocean) continue
      land[i] = 1
      landCount++
      heightM[i] = elevation[i] * ELEVATION_METERS
      const ex = (elevation[y * W + wrapX(x + 1)] - elevation[y * W + wrapX(x - 1)]) * ELEVATION_METERS / (2 * dxKm[y] * 1000)
      const ey = (elevation[clampY(y + 1) * W + x] - elevation[clampY(y - 1) * W + x]) * ELEVATION_METERS / (2 * dyKm * 1000)
      slope[i] = Math.hypot(ex, ey)
      if (!input.rivers && discharge[i] >= RIVER_DISCHARGE) {
        river[i] = 1
        riverSize[i] = Math.sqrt(discharge[i] / maxDischarge)
      }
    }
  }
  // Level 1's rivers that hold water for part of the year at least: the
  // cells their segments cross.
  if (input.rivers) {
    const { points, lengths, regimes } = input.rivers
    let start = 0
    for (let r = 0; r < lengths.length; r++) {
      const count = lengths[r]
      if (regimes[r] !== RIVER_REGIME_CODE.ephemeral) {
        for (let k = start; k < start + count - 1; k++) {
          const ax = points[3 * k]
          const ay = points[3 * k + 1]
          const size = (points[3 * k + 2] - RIVER_MIN_WIDTH) / (RIVER_MAX_WIDTH - RIVER_MIN_WIDTH)
          const bx = points[3 * k + 3]
          const by = points[3 * k + 4]
          const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / RIVER_STEP))
          for (let t = 0; t <= steps; t++) {
            const x = ((Math.floor(ax + ((bx - ax) * t) / steps) % W) + W) % W
            const y = clampY(Math.floor(ay + ((by - ay) * t) / steps))
            river[y * W + x] = 1
            riverSize[y * W + x] = Math.max(riverSize[y * W + x], size)
          }
        }
      }
      start += count
    }
  }
  const nearRiver = new Uint8Array(n)
  const nearSea = new Uint8Array(n)
  const nearLake = new Uint8Array(n)
  const lake = input.lakeDepth
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      let near = river[i]
      if (!input.rivers) for (let j = -1; j <= 1 && !near; j++) for (let k = -1; k <= 1 && !near; k++) near = river[clampY(y + j) * W + wrapX(x + k)]
      nearRiver[i] = near
      if (lake) {
        let shore = 0
        for (let j = -1; j <= 1 && !shore; j++) for (let k = -1; k <= 1 && !shore; k++) shore = lake[clampY(y + j) * W + wrapX(x + k)] > 0 ? 1 : 0
        nearLake[i] = shore
      }
      if (!land[i]) continue
      let sea = 0
      for (let j = -COAST_CELLS; j <= COAST_CELLS && !sea; j++) {
        for (let k = -COAST_CELLS; k <= COAST_CELLS && !sea; k++) sea = elevation[clampY(y + j) * W + wrapX(x + k)] <= 0 ? 1 : 0
      }
      nearSea[i] = sea
    }
  }
  const landmass = new Int32Array(n).fill(-1)
  let landmasses = 0
  const stack: number[] = []
  for (let start = 0; start < n; start++) {
    if (!land[start] || landmass[start] >= 0) continue
    landmass[start] = landmasses
    stack.push(start)
    while (stack.length > 0) {
      const i = stack.pop()!
      const x = i % W
      const y = Math.floor(i / W)
      for (let j = -1; j <= 1; j++) {
        if (!torus && (y + j < 0 || y + j >= H)) continue
        for (let k = -1; k <= 1; k++) {
          const u = clampY(y + j) * W + wrapX(x + k)
          if (!land[u] || landmass[u] >= 0) continue
          landmass[u] = landmasses
          stack.push(u)
        }
      }
    }
    landmasses++
  }
  const landmassKm2 = new Float64Array(landmasses)
  for (let i = 0; i < n; i++) if (landmass[i] >= 0) landmassKm2[landmass[i]] += dxKm[Math.floor(i / W)] * dyKm
  return { W, H, torus, land, landCount, heightM, slope, nearRiver, riverSize, nearLake, nearSea, landmass, landmasses, landmassKm2, dxKm, dyKm, wrapX, clampY }
}

// Origins drawn by the niche to the fourth, from the cells it suits.
export function drawOrigins(best: Float32Array, count: number, suitable: number, random: () => number): number[] {
  const origins: number[] = []
  let total = 0
  for (let i = 0; i < best.length; i++) if (best[i] >= suitable) total += best[i] ** 4
  for (let o = 0; o < count && total > 0; o++) {
    let pick = random() * total
    for (let i = 0; i < best.length; i++) {
      if (best[i] < suitable) continue
      pick -= best[i] ** 4
      if (pick > 0) continue
      origins.push(i)
      break
    }
  }
  return origins
}

// One origin on a landmass, with its `chance`, for each landmass the
// niche suits somewhere: drawn there by the niche to the fourth.
export function drawOriginsByLandmass(h: Habitat, best: Float32Array, chance: (landmass: number) => number, suitable: number, random: () => number): number[] {
  const total = new Float64Array(h.landmasses)
  for (let i = 0; i < best.length; i++) if (best[i] >= suitable) total[h.landmass[i]] += best[i] ** 4
  const pick = new Float64Array(h.landmasses).fill(-1)
  for (let m = 0; m < h.landmasses; m++) {
    // Both draws for every landmass, so one landmass's draw does not
    // depend on which others the niche suits.
    const take = random() < chance(m)
    const at = random()
    if (take && total[m] > 0) pick[m] = at * total[m]
  }
  const origins: number[] = []
  for (let i = 0; i < best.length; i++) {
    if (best[i] < suitable) continue
    const m = h.landmass[i]
    if (pick[m] < 0) continue
    pick[m] -= best[i] ** 4
    if (pick[m] > 0) continue
    origins.push(i)
    pick[m] = -1
  }
  return origins
}

export interface SpreadOptions {
  // A cell is suitable from this niche on.
  suitable: number
  // The cost of a kilometre through land the niche does not suit, over one
  // through it.
  barrier: number
  // How far a range spreads, kilometres through the niche.
  maxKm: number
  // Only through suitable cells (the salmon up its rivers).
  onlySuitable?: boolean
}

// A range: what the cheapest ways from the starts reach within the budget,
// over land only — the sea is not crossed.
export function spreadRange(h: Habitat, best: Float32Array, starts: number[], options: SpreadOptions): Uint8Array {
  const { W, H, torus, land, dxKm, dyKm } = h
  const n = W * H
  const range = new Uint8Array(n)
  const cost = new Float64Array(n).fill(Infinity)
  const heap = new MinHeap(1 << 16)
  for (const i of starts) {
    cost[i] = 0
    heap.push(0, i)
  }
  while (heap.length > 0) {
    heap.pop()
    const i = heap.poppedIndex
    const c = heap.poppedKey
    if (c > cost[i]) continue
    range[i] = 1
    const x = i % W
    const y = Math.floor(i / W)
    for (let j = -1; j <= 1; j++) {
      const yy = y + j
      if (!torus && (yy < 0 || yy >= H)) continue
      for (let k = -1; k <= 1; k++) {
        if (k === 0 && j === 0) continue
        const u = h.clampY(yy) * W + h.wrapX(x + k)
        if (!land[u]) continue
        if (options.onlySuitable && best[u] < options.suitable) continue
        const km = Math.hypot(k * dxKm[y], j * dyKm)
        const fit = Math.min(1, best[u] / options.suitable)
        const next = c + km * (1 + (options.barrier - 1) * (1 - fit))
        if (next >= cost[u] || next > options.maxKm) continue
        cost[u] = next
        heap.push(next, u)
      }
    }
  }
  return range
}
