import type { DomainGrid } from '../core/domain'

// The raster's routing vocabulary, as the erosion engine's raster index
// (erosionEngineState.ts) and its bridge (erosionEngineBridge.ts) still use
// it: the D8 slot order, the routing's shape, the MFD edges, the world
// ocean. The raster ROUTING itself — the priority flood, the D8-LTD
// receivers and the MFD edges over a 2:1 raster, which turned a raw
// elevation raster into a river network for the hydrology — went in
// DEC-0036 phase 7b: the hydrology runs on the terrain mesh's flow
// substrate (flowSubstrate.ts, mesh/meshHydrology.ts). Its algorithm
// (Cordonnier et al. 2016, docs/decisions/plate-tectonics-simulation.md)
// lives on in the erosion engine's own routing (erosionEngine.ts), which
// the mesh's routing is.

// Fixed N,NE,E,SE,S,SW,W,NW order — the raster engine walks neighbours in
// this order, so a stored direction index means the same thing everywhere
// it's used.
export const D8_OFFSETS: ReadonlyArray<readonly [dx: number, dy: number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
]

// Mask of the largest 4-connected ≤ seaLevel component — the world ocean.
// Null when there is no water at all. O(n) flood fill; cheap next to the
// priority flood it seeds (the raster engine's).
export function largestWaterComponent(raw: Float32Array, grid: DomainGrid, seaLevel: number): Uint8Array | null {
  const width = grid.resX
  const n = width * grid.resY
  const label = new Int32Array(n).fill(-1)
  const sizes: number[] = []
  const stack: number[] = []
  for (let s = 0; s < n; s++) {
    if (raw[s] > seaLevel || label[s] !== -1) continue
    const id = sizes.length
    let size = 0
    stack.push(s)
    label[s] = id
    while (stack.length) {
      const i = stack.pop()!
      size++
      const y = (i / width) | 0
      const x = i - y * width
      // The four sides through the grid: on the sphere the side across a
      // pole is the far meridian's cell (a row table cannot say that). The
      // order of the four does not change the mask, only the walk.
      for (const nb of [grid.neighbour(x, y, 1, 0), grid.neighbour(x, y, -1, 0), grid.neighbour(x, y, 0, 1), grid.neighbour(x, y, 0, -1)]) {
        if (raw[nb] <= seaLevel && label[nb] === -1) {
          label[nb] = id
          stack.push(nb)
        }
      }
    }
    sizes.push(size)
  }
  if (sizes.length === 0) return null
  let best = 0
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (label[i] === best) mask[i] = 1
  return mask
}
