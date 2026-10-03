// THE WATER LEVELS FOR DRAWING, from the save's own layers: where the
// `lakeDepth` raster is wet, the level is the terrain plus the depth —
// the one number the hydrology wrote there — and the cells join into
// bodies by adjacency, in one pass over the raster. The hydrology's own
// `waterLevelField` recovers every body's extent by flooding from its
// seed and allocates a mask per body: at 6 600 bodies on 2048 × 1024
// that hung the page for minutes (2026-10-03). This is what the incubator
// draws by; the hydrology's field stays the truth for the generator.
//
// A body's one-cell rim takes its level too (the dry side of every shore
// must agree with the wet side, or the shore is found on the wrong cell),
// where the rim cell is above the level; elsewhere the sea's level, 0.

import { wrapValue } from '../../generator/core/field'

// How far (cells) a body's level reaches past its wet cells.
const RIM_CELLS = 2

export interface WaterLevels {
  // Per cell: the level (elevation units), the body (−1 the sea) and the
  // surface kind as hydrology.waterLevelField gives it (0 sea, 1 lake).
  level: Float32Array
  body: Int32Array
  surface: Uint8Array
  // Per body: its cells' extent and its level.
  lakes: { x0: number; y0: number; x1: number; y1: number; level: number }[]
}

export function waterLevelsFromDepth(elevation: Float32Array, lakeDepth: Float32Array, width: number, height: number): WaterLevels {
  const n = width * height
  const level = new Float32Array(n)
  const body = new Int32Array(n).fill(-1)
  const surface = new Uint8Array(n)
  const lakes: WaterLevels['lakes'] = []
  const queue: number[] = []
  for (let seed = 0; seed < n; seed++) {
    if (body[seed] !== -1 || !(lakeDepth[seed] > 0)) continue
    const id = lakes.length
    // The body's level: the mean of what its cells say (they agree to the
    // layer's quantisation), so one number stands for the plane.
    let sum = 0
    let count = 0
    const box = { x0: width, y0: height, x1: -1, y1: -1, level: 0 }
    queue.length = 0
    queue.push(seed)
    body[seed] = id
    for (let head = 0; head < queue.length; head++) {
      const c = queue[head]
      const cx = c % width
      const cy = (c - cx) / width
      sum += elevation[c] + lakeDepth[c]
      count++
      if (cx < box.x0) box.x0 = cx
      if (cx > box.x1) box.x1 = cx
      if (cy < box.y0) box.y0 = cy
      if (cy > box.y1) box.y1 = cy
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nb = wrapValue(cy + dy, height) * width + wrapValue(cx + dx, width)
        if (body[nb] !== -1 || !(lakeDepth[nb] > 0)) continue
        body[nb] = id
        queue.push(nb)
      }
    }
    box.level = sum / count
    lakes.push(box)
    for (const c of queue) {
      level[c] = box.level
      surface[c] = 1
    }
  }
  // The rims, after every body: RIM_CELLS cells out from the wet cells,
  // each taking the level of the wet cell it grew from, where the rim
  // cell is land or stands above the level — a cell of the open sea
  // keeps the sea's. Two cells, because the wet cells are the
  // generator's raster and a refined terrain lies below the level well
  // past them (a basin's floor painted as patches of sea, 2026-10-03).
  let front: number[] = []
  for (let c = 0; c < n; c++) if (body[c] !== -1) front.push(c)
  for (let step = 0; step < RIM_CELLS; step++) {
    const next: number[] = []
    for (const c of front) {
      const id = body[c]
      const cx = c % width
      const cy = (c - cx) / width
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nb = wrapValue(cy + dy, height) * width + wrapValue(cx + dx, width)
        if (body[nb] !== -1) continue
        if (!(elevation[nb] > 0 || elevation[nb] >= lakes[id].level)) continue
        body[nb] = id
        level[nb] = lakes[id].level
        surface[nb] = 1
        next.push(nb)
      }
    }
    front = next
  }
  return { level, body, surface, lakes }
}
