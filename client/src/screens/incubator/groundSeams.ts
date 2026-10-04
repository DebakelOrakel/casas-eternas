import { tileGrid, tileSpec, TILE_ROLE_EDGE, type TileId } from '../../generator/mesh/meshTile'

// THE SEAMS BETWEEN TILES OF ONE LEVEL. A tile's edge node has only the
// tile's inside triangles, so the normal the tile sampler gives it is half
// a star, and the neighbour holds the other half: the two disagree on the
// node they share by about the terrain's own tilt (median 0.5°, p90 2°,
// measured on a baked world 2026-10-03), and the hillshade draws every tile
// border. The heights already agree to the bit; only the shading did not.
//
// The normal sums are additive (tileSampler.tileNormalSums): an edge node's
// full star is the sum of what each tile that holds it has. A tile's RIM is
// its edge nodes with their sums; a tile rastered with its neighbours' rims
// adds them, and one rastered before a neighbour arrived is patched along
// that side when it does (groundWorker 'reseam'). The contributions are
// added in one fixed order — by tile, not by who asks — so the tiles that
// share a node get the same bits.

export interface TileRim {
  tile: TileId
  // x, y per edge node, cells from the tile's own corner.
  positions: Float32Array
  // The node's normal sum, three per node.
  sums: Float64Array
}

// The edge nodes of a tile with their sums, before any neighbour's.
export function tileRim(tile: TileId, nodes: Float32Array, role: Uint8Array, sums: Float64Array): TileRim {
  const edge: number[] = []
  for (let v = 0; v < role.length; v++) if (role[v] === TILE_ROLE_EDGE) edge.push(v)
  const positions = new Float32Array(edge.length * 2)
  const out = new Float64Array(edge.length * 3)
  edge.forEach((v, i) => {
    positions[2 * i] = nodes[2 * v]
    positions[2 * i + 1] = nodes[2 * v + 1]
    out[3 * i] = sums[3 * v]
    out[3 * i + 1] = sums[3 * v + 1]
    out[3 * i + 2] = sums[3 * v + 2]
  })
  return { tile, positions, sums: out }
}

// The eight tiles around one, on the level's grid (which wraps). Fewer
// where the grid is narrower than three tiles, so none is listed twice.
export function neighbourTiles(tile: TileId, width: number, height: number): TileId[] {
  const { cols, rows } = tileGrid(width, height, tileSpec(tile.level))
  const seen = new Set<string>([`${tile.x},${tile.y}`])
  const out: TileId[] = []
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = (((tile.x + dx) % cols) + cols) % cols
      const y = (((tile.y + dy) % rows) + rows) % rows
      if (seen.has(`${x},${y}`)) continue
      seen.add(`${x},${y}`)
      out.push({ level: tile.level, x, y })
    }
  }
  return out
}

// A neighbour's offset from a tile in tiles (-1, 0, 1 each), across the wrap.
export function tileOffset(from: TileId, to: TileId, width: number, height: number): { dx: number; dy: number } {
  const { cols, rows } = tileGrid(width, height, tileSpec(from.level))
  const near = (d: number, n: number): number => {
    const m = ((d % n) + n) % n
    return m > n / 2 ? m - n : m
  }
  return { dx: near(to.x - from.x, cols), dy: near(to.y - from.y, rows) }
}

// Adds the neighbours' halves to a tile's edge nodes, in `sums` (the
// tile's own, from tileNormalSums). Every node's contributions are added
// in the order of the tiles' ids, the tile's own among them, so each tile
// that holds the node sums the same numbers in the same order.
export function addRims(tile: TileId, nodes: Float32Array, role: Uint8Array, sums: Float64Array, rims: Iterable<TileRim>, width: number, height: number): void {
  const cells = tileSpec(tile.level).cells
  // Per edge node of this tile: its contributions by tile order.
  const index = new Map<string, number>()
  for (let v = 0; v < role.length; v++) if (role[v] === TILE_ROLE_EDGE) index.set(`${nodes[2 * v]},${nodes[2 * v + 1]}`, v)
  const parts = new Map<number, { order: number; s: [number, number, number] }[]>()
  const order = (t: TileId): number => t.y * 1e6 + t.x
  for (const [, v] of index) parts.set(v, [{ order: order(tile), s: [sums[3 * v], sums[3 * v + 1], sums[3 * v + 2]] }])
  for (const rim of rims) {
    const { dx, dy } = tileOffset(tile, rim.tile, width, height)
    if (dx === 0 && dy === 0) continue
    for (let i = 0; i < rim.positions.length / 2; i++) {
      // The neighbour's position in this tile's frame: exact, both being
      // on the level's quantum and the shift a whole tile.
      const v = index.get(`${rim.positions[2 * i] + dx * cells},${rim.positions[2 * i + 1] + dy * cells}`)
      if (v === undefined) continue
      parts.get(v)!.push({ order: order(rim.tile), s: [rim.sums[3 * i], rim.sums[3 * i + 1], rim.sums[3 * i + 2]] })
    }
  }
  for (const [v, list] of parts) {
    if (list.length === 1) continue
    list.sort((a, b) => a.order - b.order)
    let x = 0, y = 0, z = 0
    for (const p of list) {
      x += p.s[0]
      y += p.s[1]
      z += p.s[2]
    }
    sums[3 * v] = x
    sums[3 * v + 1] = y
    sums[3 * v + 2] = z
  }
}

// How far into the tile, per side (left, right, bottom, top in cells), a
// change of the side's edge normals reaches: the farthest corner of any
// triangle that touches an edge node on that side.
export function seamReach(nodes: Float32Array, triangles: Uint32Array, role: Uint8Array, cells: number): [number, number, number, number] {
  const reach: [number, number, number, number] = [0, 0, 0, 0]
  for (let t = 0; t < triangles.length; t += 3) {
    const corners = [triangles[t], triangles[t + 1], triangles[t + 2]]
    let left = false, right = false, bottom = false, top = false
    for (const v of corners) {
      if (role[v] !== TILE_ROLE_EDGE) continue
      const x = nodes[2 * v], y = nodes[2 * v + 1]
      left ||= x === 0
      right ||= x === cells
      bottom ||= y === 0
      top ||= y === cells
    }
    if (!(left || right || bottom || top)) continue
    for (const v of corners) {
      const x = nodes[2 * v], y = nodes[2 * v + 1]
      if (left) reach[0] = Math.max(reach[0], x)
      if (right) reach[1] = Math.max(reach[1], cells - x)
      if (bottom) reach[2] = Math.max(reach[2], y)
      if (top) reach[3] = Math.max(reach[3], cells - y)
    }
  }
  return reach
}
