import { MinHeap } from '../../generator/core/minHeap'
import type { Domain } from '../../generator/core/domain'
import { meshLevelMesh, type MeshLevelArtifact } from '../../world/meshArtifacts'

// THE INCUBATOR'S REGION WORKER (2026-10-23, a trial): level 1's land cut
// into catchments, as a coloured layer over the chart. Not a decision, a
// look: do the catchments make spaces that could hold a band's range?
//
// The drainage: a priority flood on the level's mesh from the sea (every
// node at or below sea level) fills the depressions; each land node drains
// to its lowest neighbour on the filled surface, or, on a flat of it, to
// the node the flood reached it from. (The flood's parent alone draws the
// flood's fronts, not the slopes: parallel streaks on the first look.)
// Depressions drain over their spill point, lakes and closed basins
// included (no endorheic basin of its own yet).
//
// The regions: the drainage tree cut at its confluences. A node is an
// OUTLET when its catchment holds at least `minAreaKm2` and it reaches the
// sea, or it joins a node that a second such catchment joins too. Every
// node takes the region of the first outlet downstream. A coast's small
// catchments that reach no outlet stay out (no colour).

export interface RegionWorkerInbound {
  kind: Domain['kind']
  width: number
  height: number
  chartWidth: number
  chartHeight: number
  level: Pick<MeshLevelArtifact, 'count' | 'nodes' | 'connectivity' | 'z'>
  // The world's area, square metres: the nodes' Voronoi areas are scaled
  // to it, so the threshold is true on either shape.
  worldAreaM2: number
  minAreaKm2: number
}

// `overlay`: RGBA over the chart, alpha the blend. `areas`: each region's
// area, km².
export type RegionWorkerOutbound =
  | { type: 'regions'; overlay: Uint8ClampedArray; areas: Float32Array; ms: Record<string, number> }
  | { type: 'failed'; message: string }

const worker = self as unknown as Worker

worker.onmessage = (event: MessageEvent<RegionWorkerInbound>): void => {
  try {
    cut(event.data)
  } catch (e) {
    worker.postMessage({ type: 'failed', message: String(e) } satisfies RegionWorkerOutbound)
  }
}

// The blend of a region's colour and of its border.
const FILL_ALPHA = 110
const BORDER_ALPHA = 200

function cut(message: RegionWorkerInbound): void {
  const { kind, width, height, chartWidth: W, chartHeight: H, level } = message
  const ms: Record<string, number> = {}
  let started = performance.now()
  const step = (name: string): void => {
    const now = performance.now()
    ms[name] = Math.round(now - started)
    started = now
  }
  const mesh = meshLevelMesh({ ...level, level: 1, waterBodies: [], graph: null, rivers: null }, width, height, kind)
  const n = level.count
  const z = level.z
  step('mesh')

  // The nodes' areas, km², scaled to the world's.
  const area = new Float64Array(n)
  let sum = 0
  for (let v = 0; v < n; v++) {
    area[v] = Math.max(0, mesh.voronoiArea(v))
    sum += area[v]
  }
  const toKm2 = message.worldAreaM2 / sum / 1e6
  for (let v = 0; v < n; v++) area[v] *= toKm2
  step('areas')

  // The flood. `order` holds the land nodes downstream first.
  const receiver = new Int32Array(n).fill(-1)
  const filledZ = Float32Array.from(z)
  const done = new Uint8Array(n)
  const order = new Int32Array(n)
  let ordered = 0
  const heap = new MinHeap(1 << 16)
  const star = new Int32Array(256)
  for (let v = 0; v < n; v++) if (z[v] <= 0) done[v] = 1
  for (let v = 0; v < n; v++) {
    if (z[v] <= 0) continue
    const k = mesh.neighbours(v, star)
    for (let s = 0; s < k; s++) {
      if (z[star[s]] > 0) continue
      receiver[v] = star[s]
      done[v] = 1
      heap.push(z[v], v)
      break
    }
  }
  while (heap.length > 0) {
    heap.pop()
    const v = heap.poppedIndex
    const filled = heap.poppedKey
    order[ordered++] = v
    const k = mesh.neighbours(v, star)
    for (let s = 0; s < k; s++) {
      const u = star[s]
      if (done[u]) continue
      done[u] = 1
      receiver[u] = v
      filledZ[u] = Math.max(z[u], filled)
      heap.push(filledZ[u], u)
    }
  }
  // Downhill where there is a hill. A lower neighbour pops earlier, so
  // `order` stays downstream first.
  for (let i = 0; i < ordered; i++) {
    const v = order[i]
    const k = mesh.neighbours(v, star)
    let low = filledZ[v]
    for (let s = 0; s < k; s++) {
      const u = star[s]
      if (filledZ[u] < low) {
        low = filledZ[u]
        receiver[v] = u
      }
    }
  }
  step('flood')

  // The catchments, upstream first.
  const acc = Float64Array.from(area)
  for (let i = ordered - 1; i >= 0; i--) {
    const v = order[i]
    const r = receiver[v]
    if (r >= 0 && z[r] > 0) acc[r] += acc[v]
  }
  const big = new Uint8Array(n)
  for (let i = 0; i < ordered; i++) {
    const v = order[i]
    const r = receiver[v]
    if (acc[v] >= message.minAreaKm2 && r >= 0 && z[r] > 0 && big[r] < 2) big[r]++
  }
  const region = new Int32Array(n).fill(-1)
  let regions = 0
  for (let i = 0; i < ordered; i++) {
    const v = order[i]
    const r = receiver[v]
    const toSea = r < 0 || z[r] <= 0
    if (acc[v] >= message.minAreaKm2 && (toSea || big[r] >= 2)) region[v] = regions++
    else if (!toSea) region[v] = region[r]
  }
  const areas = new Float32Array(regions)
  for (let v = 0; v < n; v++) if (region[v] >= 0) areas[region[v]] += area[v]
  step('regions')

  // The layer: each texel takes its triangle's nearest corner's region; a
  // texel whose region differs from the one left of it or above it is a
  // border. Two rows of labels, not a chart of them.
  const overlay = new Uint8ClampedArray(W * H * 4)
  const sx = mesh.domain.width / W
  const sy = mesh.domain.height / H
  const bary = new Float64Array(3)
  let above = new Int32Array(W).fill(-1)
  let row = new Int32Array(W)
  let hint = mesh.lastTri
  let rowStart = hint
  for (let py = 0; py < H; py++) {
    const y = py * sy
    hint = rowStart
    for (let px = 0; px < W; px++) {
      const t = mesh.locate(px * sx, y, hint)
      hint = t
      if (px === 0) rowStart = t
      mesh.barycentric(t, px * sx, y, bary)
      const c = bary[0] >= bary[1] && bary[0] >= bary[2] ? 0 : bary[1] >= bary[2] ? 1 : 2
      row[px] = region[mesh.tris[3 * t + c]]
    }
    for (let px = 0; px < W; px++) {
      const id = row[px]
      if (id < 0) continue
      const o = 4 * (py * W + px)
      const left = row[px === 0 ? W - 1 : px - 1]
      if (left !== id || (py > 0 && above[px] !== id)) {
        overlay[o] = 40
        overlay[o + 1] = 30
        overlay[o + 2] = 20
        overlay[o + 3] = BORDER_ALPHA
        continue
      }
      colourOf(id, overlay, o)
      overlay[o + 3] = FILL_ALPHA
    }
    const swap = above
    above = row
    row = swap
  }
  step('paint')
  worker.postMessage({ type: 'regions', overlay, areas, ms } satisfies RegionWorkerOutbound, [overlay.buffer, areas.buffer])
}

// A region's colour: a hue from its id (golden-ratio steps, so neighbours
// rarely match), saturated enough to read over the wash.
function colourOf(id: number, out: Uint8ClampedArray, o: number): void {
  const h = ((id * 0.618033988749895) % 1) * 6
  const f = h - Math.floor(h)
  const lo = 70
  const hi = 230
  const up = lo + (hi - lo) * f
  const down = hi - (hi - lo) * f
  const rgb = [[hi, up, lo], [down, hi, lo], [lo, hi, up], [lo, down, hi], [up, lo, hi], [hi, lo, down]][Math.floor(h) % 6]
  out[o] = rgb[0]
  out[o + 1] = rgb[1]
  out[o + 2] = rgb[2]
}
