import { MinHeap } from '../../generator/core/minHeap'
import { Biome } from '../../generator/climate/biomes'
import { ELEVATION_METERS } from '../../generator/elevation/elevationScale'
import { EDIBLE_SHARE, SPECIES, type SpeciesSpec, type Trapezoid } from './species'

// THE INCUBATOR'S SPECIES WORKER (2026-10-23, a trial): where each species
// of species.ts lives, on the world raster.
//
// 1. THE NICHE: the species' responses to the cell's climate, height,
//    slope, biome and water (species.ts), multiplied.
// 2. THE RANGE: not every suitable place is reached. Each group starts at a
//    few origins, drawn by its niche, and spreads by the cheapest way: a
//    kilometre through its niche costs one, through land it does not suit
//    up to BARRIER times more, the sea it does not cross. What the budget
//    reaches is its range; a suitable place outside it is an empty niche.
//    The salmon instead swims up the rivers from every suitable mouth.
// 3. THE DENSITY: the herbivores share the forage (the Miami model's net
//    primary production, the biome's edible share), each by its niche
//    squared among those in range there; a predator follows the
//    herbivores in its range; a plant is its niche.
//
// The climate is the save's, on its own chart (256 × 128), read bilinearly
// over its land cells.

export interface SpeciesWorkerInbound {
  kind: 'sphere' | 'torus'
  width: number
  height: number
  // Metres a world cell spans: the torus's, or the sphere's at the equator.
  cellMetres: number
  elevation: Float32Array
  biome: Float32Array
  discharge: Float32Array
  climate: { resX: number; resY: number; temperature: Float32Array; precipitation: Float32Array; seasonalAmplitude: Float32Array }
  seed: number
}

// One code a cell: 0 nothing, 1 suitable but not reached, 2 … 255 in the
// range, the density on a scale of the species' own (its 99th percentile
// at 255).
export interface SpeciesLayer {
  id: string
  name: string
  role: SpeciesSpec['role']
  codes: Uint8Array
  // Shares of the land: suitable, reached, suitable and not reached.
  suitable: number
  reached: number
  empty: number
  origins: { x: number; y: number }[]
}

export type SpeciesWorkerOutbound =
  | { type: 'species'; layers: SpeciesLayer[]; ms: number }
  | { type: 'failed'; message: string }

const worker = self as unknown as Worker

worker.onmessage = (event: MessageEvent<SpeciesWorkerInbound>): void => {
  try {
    const started = performance.now()
    const layers = distribute(event.data)
    worker.postMessage({ type: 'species', layers, ms: Math.round(performance.now() - started) } satisfies SpeciesWorkerOutbound, layers.map((l) => l.codes.buffer))
  } catch (e) {
    worker.postMessage({ type: 'failed', message: String(e) } satisfies SpeciesWorkerOutbound)
  }
}

// A cell is suitable from this niche on.
const SUITABLE = 0.3
// The cost of a kilometre through land the species does not suit, over
// one through its niche.
const BARRIER = 30
// How far a range spreads, in kilometres through the niche.
const SPREAD_KM = 8000
// The origins of a group.
const ORIGINS = 2
// A river, for the water a species needs and for the salmon: the save's
// discharge (its units; the land's median is ~2, its 90th percentile ~30).
const RIVER_DISCHARGE = 20
const SALMON_DISCHARGE = 50

function trapezoid(v: number, t: Trapezoid): number {
  if (v <= t[0] || v >= t[3]) return 0
  if (v < t[1]) return (v - t[0]) / (t[1] - t[0])
  if (v > t[2]) return (t[3] - v) / (t[3] - t[2])
  return 1
}

// The climate at a world cell: bilinear over the chart's land cells (the
// sea's sentinel left out), the longitude wrapping; NaN with no land cell
// near.
function climateSampler(c: SpeciesWorkerInbound['climate'], width: number, height: number, torus: boolean) {
  return (field: Float32Array, x: number, y: number): number => {
    const fx = ((x + 0.5) / width) * c.resX - 0.5
    const fy = ((y + 0.5) / height) * c.resY - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    let sum = 0
    let weight = 0
    for (let j = 0; j < 2; j++) {
      let yy = y0 + j
      if (torus) yy = ((yy % c.resY) + c.resY) % c.resY
      else yy = Math.min(c.resY - 1, Math.max(0, yy))
      const wy = j === 0 ? 1 - (fy - y0) : fy - y0
      for (let i = 0; i < 2; i++) {
        const xx = (((x0 + i) % c.resX) + c.resX) % c.resX
        const wx = i === 0 ? 1 - (fx - x0) : fx - x0
        const k = yy * c.resX + xx
        if (c.precipitation[k] < 0) continue
        sum += wx * wy * field[k]
        weight += wx * wy
      }
    }
    return weight > 1e-6 ? sum / weight : Number.NaN
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashText(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

function distribute(message: SpeciesWorkerInbound): SpeciesLayer[] {
  const { width: W, height: H, elevation, biome, discharge } = message
  const torus = message.kind === 'torus'
  const n = W * H
  const climateAt = climateSampler(message.climate, W, H, torus)

  // A cell's east-west and north-south extent, km.
  const dyKm = message.cellMetres / 1000
  const dxKm = new Float64Array(H)
  for (let y = 0; y < H; y++) dxKm[y] = torus ? dyKm : dyKm * Math.cos(((y + 0.5) / H - 0.5) * Math.PI)

  const land = new Uint8Array(n)
  const coldest = new Float32Array(n)
  const warmest = new Float32Array(n)
  const rain = new Float32Array(n)
  const heightM = new Float32Array(n)
  const slope = new Float32Array(n)
  const river = new Uint8Array(n)
  const nearRiver = new Uint8Array(n)
  const wrapX = (x: number): number => (x + W) % W
  const clampY = (y: number): number => torus ? (y + H) % H : Math.min(H - 1, Math.max(0, y))
  let landCount = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (elevation[i] <= 0 || biome[i] === Biome.Ocean) continue
      const t = climateAt(message.climate.temperature, x, y)
      const p = climateAt(message.climate.precipitation, x, y)
      const a = climateAt(message.climate.seasonalAmplitude, x, y)
      if (Number.isNaN(t) || Number.isNaN(p)) continue
      land[i] = 1
      landCount++
      coldest[i] = t - a / 2
      warmest[i] = t + a / 2
      rain[i] = p
      heightM[i] = elevation[i] * ELEVATION_METERS
      const ex = (elevation[y * W + wrapX(x + 1)] - elevation[y * W + wrapX(x - 1)]) * ELEVATION_METERS / (2 * dxKm[y] * 1000)
      const ey = (elevation[clampY(y + 1) * W + x] - elevation[clampY(y - 1) * W + x]) * ELEVATION_METERS / (2 * dyKm * 1000)
      slope[i] = Math.hypot(ex, ey)
      if (discharge[i] >= RIVER_DISCHARGE) river[i] = 1
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let near = 0
      for (let j = -1; j <= 1 && !near; j++) for (let i = -1; i <= 1 && !near; i++) near = river[clampY(y + j) * W + wrapX(x + i)]
      nearRiver[y * W + x] = near
    }
  }

  // The forage: the Miami model's net primary production, g/m²/yr, times
  // the biome's edible share.
  const forage = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    const t = (coldest[i] + warmest[i]) / 2
    const npp = Math.min(3000 / (1 + Math.exp(1.315 - 0.119 * t)), 3000 * (1 - Math.exp(-0.000664 * rain[i])))
    forage[i] = npp * (EDIBLE_SHARE[biome[i]] ?? 0)
  }

  // 1. The niches.
  const niches = SPECIES.map((s) => {
    const niche = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      if (!land[i]) continue
      let v = trapezoid(coldest[i], s.coldest) * trapezoid(warmest[i], s.warmest) * trapezoid(rain[i], s.rain) * (s.biomes[biome[i]] ?? 0)
      if (v === 0) continue
      if (s.height) v *= trapezoid(heightM[i], s.height)
      if (s.slope) v *= trapezoid(slope[i], s.slope)
      if (s.water) v *= 1 - s.water + s.water * nearRiver[i]
      if (s.role === 'fish') v *= discharge[i] >= SALMON_DISCHARGE ? 1 : 0
      niche[i] = v
    }
    return niche
  })

  // 2. The ranges, a group at a time.
  const groups = new Map<string, number[]>()
  SPECIES.forEach((s, k) => groups.set(s.group ?? s.id, [...(groups.get(s.group ?? s.id) ?? []), k]))
  const ranges = new Array<Uint8Array>(SPECIES.length)
  const originsOf = new Array<{ x: number; y: number }[]>(SPECIES.length)
  const heap = new MinHeap(1 << 16)
  const cost = new Float32Array(n)
  for (const [group, members] of groups) {
    const best = new Float32Array(n)
    for (const k of members) for (let i = 0; i < n; i++) best[i] = Math.max(best[i], niches[k][i])
    const range = new Uint8Array(n)
    const origins: { x: number; y: number }[] = []
    cost.fill(Infinity)
    const fish = SPECIES[members[0]].role === 'fish'
    if (fish) {
      // Every suitable river cell by the sea.
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x
          if (best[i] < SUITABLE) continue
          let sea = false
          for (let j = -1; j <= 1 && !sea; j++) for (let ii = -1; ii <= 1 && !sea; ii++) sea = !land[clampY(y + j) * W + wrapX(x + ii)] && elevation[clampY(y + j) * W + wrapX(x + ii)] <= 0
          if (!sea) continue
          cost[i] = 0
          heap.push(0, i)
        }
      }
    } else {
      // Origins drawn by the niche to the fourth, from the cells it suits.
      const random = mulberry32(hashText(group) ^ message.seed)
      let total = 0
      for (let i = 0; i < n; i++) if (best[i] >= SUITABLE) total += best[i] ** 4
      for (let o = 0; o < ORIGINS && total > 0; o++) {
        let pick = random() * total
        for (let i = 0; i < n; i++) {
          if (best[i] < SUITABLE) continue
          pick -= best[i] ** 4
          if (pick > 0) continue
          cost[i] = 0
          heap.push(0, i)
          origins.push({ x: i % W, y: Math.floor(i / W) })
          break
        }
      }
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
        for (let ii = -1; ii <= 1; ii++) {
          if (ii === 0 && j === 0) continue
          const u = clampY(yy) * W + wrapX(x + ii)
          if (!land[u]) continue
          if (fish && best[u] < SUITABLE) continue
          const km = Math.hypot(ii * dxKm[y], j * dyKm)
          const fit = Math.min(1, best[u] / SUITABLE)
          const next = c + km * (1 + (BARRIER - 1) * (1 - fit))
          if (next >= cost[u] || (!fish && next > SPREAD_KM)) continue
          cost[u] = next
          heap.push(next, u)
        }
      }
    }
    for (const k of members) {
      ranges[k] = range
      originsOf[k] = origins
    }
  }

  // 3. The densities.
  const density = SPECIES.map(() => new Float32Array(n))
  const herbivores = SPECIES.map((s, k) => (s.role === 'herbivore' ? k : -1)).filter((k) => k >= 0)
  const prey = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    let sum = 0
    for (const k of herbivores) if (ranges[k][i]) sum += niches[k][i] ** 2
    if (sum === 0) continue
    for (const k of herbivores) {
      if (!ranges[k][i]) continue
      density[k][i] = (forage[i] * niches[k][i] ** 2) / sum
      prey[i] += density[k][i]
    }
  }
  SPECIES.forEach((s, k) => {
    if (s.role === 'herbivore') return
    for (let i = 0; i < n; i++) if (ranges[k][i]) density[k][i] = s.role === 'predator' ? prey[i] * niches[k][i] : niches[k][i]
  })

  return SPECIES.map((s, k) => {
    const d = density[k]
    const inRange: number[] = []
    for (let i = 0; i < n; i++) if (d[i] > 0) inRange.push(d[i])
    inRange.sort((a, b) => a - b)
    const top = inRange.length > 0 ? inRange[Math.floor(0.99 * (inRange.length - 1))] : 1
    const codes = new Uint8Array(n)
    let suitable = 0
    let reached = 0
    let empty = 0
    for (let i = 0; i < n; i++) {
      const fits = niches[k][i] >= SUITABLE
      if (fits) suitable++
      if (fits && ranges[k][i]) reached++
      if (d[i] > 0) codes[i] = 2 + Math.round(253 * Math.min(1, d[i] / top))
      else if (fits && !ranges[k][i]) {
        codes[i] = 1
        empty++
      }
    }
    return { id: s.id, name: s.name, role: s.role, codes, suitable: suitable / landCount, reached: reached / landCount, empty: empty / landCount, origins: originsOf[k] }
  })
}
