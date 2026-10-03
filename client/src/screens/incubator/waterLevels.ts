// THE WATER LEVELS FOR DRAWING, from the LEVEL'S own water bodies
// (world/meshArtifacts: the hydrology run on the level-1 mesh) over the
// level's own terrain rasterised (groundWorker.ts). Not from the save's
// lake layer: the level is a replay at a finer budget and its terrain
// differs from the save's raster by 380 m RMS — lakes of the save lay on
// hillsides of the level, in blocks (2026-10-03). The hydrology's own
// `waterLevelField` recovers every body's extent by flooding from its
// seed and allocates a mask per body: at 6 600 bodies on 2048 × 1024
// that hung the page for minutes; this floods with one mask for all.
//
// A body's extent is the flood from its seed over cells under its level,
// lowest first and at most REACH_CAP times its own cell count (the
// raster's rim leaks at places — a saddle a hair under the level — and
// by height the basin fills before the leak does). A rim of RIM_CELLS
// cells follows, taking the level where the cell's raster height stands
// at or above it but under it by RIM_MARGIN: the raster is a mean, and a
// shore cell that averages a little over the level has ground under it.

import { wrapValue } from '../../generator/core/field'
import type { WaterBody } from '../../generator/surface/hydrology'

// The most a body's flood may grow past the hydrology's cell count, as a
// multiple; the rim's width (cells) and how far (elevation units) over
// the level a rim cell's raster height may stand.
const REACH_CAP = 1.5
const RIM_CELLS = 2
const RIM_MARGIN = 150 / 9000
// The body of sunken land (see below): no body's, and not the sea's.
export const SUNKEN = -2
// A terminal sea's rim has no margin: its rim is its basin's upper
// slope, kilometres high, and a raster cell whose mean stands far over
// the spill still has fine terrain under the sea's level, which the sea
// then claimed in blocks (2026-10-03).

export interface WaterLevels {
  // Per cell: the level (elevation units), the body (−1 the sea, SUNKEN
  // dry land under the sea's level) and the surface kind as
  // hydrology.waterLevelField gives it (0 sea, 1 lake).
  level: Float32Array
  body: Int32Array
  surface: Uint8Array
  // Per body: its cells' extent and its level.
  lakes: { x0: number; y0: number; x1: number; y1: number; level: number }[]
}

export function waterLevelsFromBodies(bodies: readonly WaterBody[], elevation: Float32Array, width: number, height: number): WaterLevels {
  const n = width * height
  const level = new Float32Array(n)
  const body = new Int32Array(n).fill(-1)
  const surface = new Uint8Array(n)
  const lakes: WaterLevels['lakes'] = []
  const wetCount: number[] = []
  const subSea: boolean[] = []
  const reachTo: number[] = []
  const seeds: number[] = []
  for (const b of bodies) {
    if (b.kind === 'dry' || b.frozen) continue
    const seed = wrapValue(Math.floor(b.seedY), height) * width + wrapValue(Math.floor(b.seedX), width)
    if (!(elevation[seed] < b.level)) continue
    const id = lakes.length
    lakes.push({ x0: width, y0: height, x1: -1, y1: -1, level: b.level })
    // A terminal sea's floor lies under the sea's level: its flood may
    // take such cells, and takes its whole basin up to the SPILL — the
    // slopes between its level and the sea's are land, and left to the
    // sea they were drawn as the sea, a plane over the basin's rim in
    // the raster's steps (2026-10-03). A lake's flood stops at the sea's
    // level, or a lake on a cliff coast flooded the ocean under it.
    const terminal = b.floor < 0
    subSea.push(terminal)
    reachTo.push(terminal ? b.spill : b.level)
    wetCount.push(terminal ? Infinity : Math.max(4, b.cells))
    seeds.push(seed)
    body[seed] = id
    level[seed] = b.level
    surface[seed] = 1
  }
  // The flood: a binary heap of (elevation, cell, body) on parallel
  // arrays, lowest first.
  const reached = lakes.map(() => 0)
  // A binary heap of (elevation, cell, body) on parallel arrays.
  const heapE: number[] = []
  const heapC: number[] = []
  const heapB: number[] = []
  const push = (e: number, c: number, b: number): void => {
    heapE.push(e)
    heapC.push(c)
    heapB.push(b)
    let i = heapE.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (heapE[parent] <= heapE[i]) break
      ;[heapE[parent], heapE[i]] = [heapE[i], heapE[parent]]
      ;[heapC[parent], heapC[i]] = [heapC[i], heapC[parent]]
      ;[heapB[parent], heapB[i]] = [heapB[i], heapB[parent]]
      i = parent
    }
  }
  const pop = (): void => {
    const last = heapE.length - 1
    heapE[0] = heapE[last]
    heapC[0] = heapC[last]
    heapB[0] = heapB[last]
    heapE.pop()
    heapC.pop()
    heapB.pop()
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < heapE.length && heapE[l] < heapE[m]) m = l
      if (r < heapE.length && heapE[r] < heapE[m]) m = r
      if (m === i) break
      ;[heapE[m], heapE[i]] = [heapE[i], heapE[m]]
      ;[heapC[m], heapC[i]] = [heapC[i], heapC[m]]
      ;[heapB[m], heapB[i]] = [heapB[i], heapB[m]]
      i = m
    }
  }
  const offer = (c: number, id: number): void => {
    const cx = c % width
    const cy = (c - cx) / width
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nb = wrapValue(cy + dy, height) * width + wrapValue(cx + dx, width)
      if (body[nb] !== -1 || !(elevation[nb] < reachTo[id])) continue
      if (elevation[nb] <= 0 && !subSea[id]) continue
      push(elevation[nb], nb, id)
    }
  }
  for (const seed of seeds) offer(seed, body[seed])
  while (heapE.length > 0) {
    const c = heapC[0]
    const id = heapB[0]
    pop()
    if (body[c] !== -1 || reached[id] >= wetCount[id] * REACH_CAP) continue
    body[c] = id
    level[c] = lakes[id].level
    surface[c] = 1
    reached[id]++
    offer(c, id)
  }
  // THE RIM: RIM_CELLS cells out from the flood, each taking the level
  // where its raster height stands at or above the level but under it
  // by RIM_MARGIN — the raster is a mean over 7.8 km, and a shore cell
  // that averages a little above the level has refined ground under it;
  // without the rim the shore was the raster's blocks (2026-10-03). The
  // margin keeps a slope that falls past the lake to the sea out of it
  // (a rim by distance alone put a lake's level on a coastal slope).
  for (let step = 0; step < RIM_CELLS; step++) {
    const rim: number[] = []
    for (let c = 0; c < n; c++) {
      if (body[c] !== -1) continue
      const cx = c % width
      const cy = (c - cx) / width
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nb = wrapValue(cy + dy, height) * width + wrapValue(cx + dx, width)
        const id = body[nb]
        if (id < 0) continue
        // The rim stands at the flood's own edge: a lake's level, a
        // terminal sea's spill (its rim cells are its basin's upper
        // slopes, whose fine terrain dips under the sea's level and was
        // painted as the sea in the raster's steps, 2026-10-03).
        const edge = reachTo[id]
        const margin = subSea[id] ? Infinity : RIM_MARGIN
        if (elevation[c] < edge || elevation[c] > edge + margin) continue
        level[c] = lakes[id].level
        surface[c] = 1
        rim.push(c, id)
        break
      }
    }
    for (let i = 0; i < rim.length; i += 2) body[rim[i]] = rim[i + 1]
  }
  // SUNKEN LAND: a cell under the sea's level that no body holds and the
  // sea cannot reach (a dry basin's floor, a depression behind a ridge
  // in a terminal sea's basin — the hydrology's dryBasin) is land, not
  // the sea: left to the sea it was drawn as the sea, in the raster's
  // blocks, inside a basin (2026-10-03). The sea is the flood over the
  // cells under its level from the world's deepest cell; the rest take
  // body SUNKEN with a level under everything, so the painter draws them
  // dry and the sea's plane keeps off them.
  {
    let deepest = 0
    for (let c = 1; c < n; c++) if (elevation[c] < elevation[deepest]) deepest = c
    const seaSeen = new Uint8Array(n)
    const stack: number[] = [deepest]
    seaSeen[deepest] = 1
    while (stack.length > 0) {
      const c = stack.pop()!
      const cx = c % width
      const cy = (c - cx) / width
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nb = wrapValue(cy + dy, height) * width + wrapValue(cx + dx, width)
        if (seaSeen[nb] || body[nb] !== -1 || !(elevation[nb] <= 0)) continue
        seaSeen[nb] = 1
        stack.push(nb)
      }
    }
    for (let c = 0; c < n; c++) {
      if (body[c] === -1 && elevation[c] <= 0 && !seaSeen[c]) {
        body[c] = SUNKEN
        level[c] = -1
        surface[c] = 1
      }
    }
  }
  // The boxes over the reach.
  for (const box of lakes) {
    box.x0 = width
    box.y0 = height
    box.x1 = -1
    box.y1 = -1
  }
  for (let c = 0; c < n; c++) {
    const id = body[c]
    if (id < 0) continue
    const cx = c % width
    const cy = (c - cx) / width
    const box = lakes[id]
    if (cx < box.x0) box.x0 = cx
    if (cx > box.x1) box.x1 = cx
    if (cy < box.y0) box.y0 = cy
    if (cy > box.y1) box.y1 = cy
  }
  return { level, body, surface, lakes }
}
