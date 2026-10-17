import { TILE_ROLE_EDGE, type TileId } from '../../generator/mesh/meshTile'
import type { GroundTiles } from './groundTiles'

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
  // x, y per edge node, as the tile's artifact holds them: cells from the
  // tile's own corner on the torus, the world point on the sphere.
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

// Adds the neighbours' halves to a tile's edge nodes, in `sums` (the
// tile's own, from tileNormalSums). Every node's contributions are added
// in the order of the tiles' ids, the tile's own among them, so each tile
// that holds the node sums the same numbers in the same order. A node is
// found by its key in the tile frame's terms (groundTiles.ts rimKey).
export function addRims(tile: TileId, nodes: Float32Array, role: Uint8Array, sums: Float64Array, rims: Iterable<TileRim>, tiles: GroundTiles): void {
  // Per edge node of this tile: its contributions by tile order.
  const own = tiles.rimKey(tile, tile)!
  const index = new Map<string, number>()
  for (let v = 0; v < role.length; v++) if (role[v] === TILE_ROLE_EDGE) index.set(own(nodes[2 * v], nodes[2 * v + 1]), v)
  const parts = new Map<number, { order: number; s: [number, number, number] }[]>()
  const order = (t: TileId): number => t.y * 1e6 + t.x
  for (const [, v] of index) parts.set(v, [{ order: order(tile), s: [sums[3 * v], sums[3 * v + 1], sums[3 * v + 2]] }])
  for (const rim of rims) {
    const key = tiles.rimKey(tile, rim.tile)
    if (!key) continue
    for (let i = 0; i < rim.positions.length / 2; i++) {
      const v = index.get(key(rim.positions[2 * i], rim.positions[2 * i + 1]))
      if (v === undefined) continue
      const s: [number, number, number] = [0, 0, 0]
      tiles.rimSum(tile, rim, i, s)
      parts.get(v)!.push({ order: order(rim.tile), s })
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
