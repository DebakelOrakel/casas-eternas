import { wrapValue } from '../core/field'
import { SEA_LEVEL } from '../elevation/elevationScale'
import type { MeshRouting } from '../mesh/meshErosion'
import { parentTilesOf, tileGrid, tileSpec, type TileId } from '../mesh/meshTile'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'

// THE TILE LEVELS' GRAPH (docs/decisions/detail-ladder.md, step 5): which
// tiles a refine plan computes below level 1, and what each waits for —
// its parents (the tiles of the level above it overlaps) and the tiles of
// its own level whose water enters it. Planned once, when level 1 is
// there, from level 1's drainage alone, for every tile level (decided
// 2026-10-01: level 3's flow edges from level 1, not level 2, so the whole
// graph is known before the first tile runs). The coordinator only wires
// what this says (internal/modules/jobs/coordinator.go).
//
// Two neighbours drain into each other at different places along their
// edge, so the flow edges form cycles as a rule. They are cut from level 1
// alone (decided 2026-10-01): of a pair, only the direction that carries
// more water is an edge; a longer cycle left over is cut at its weakest
// edge. A crossing against a cut edge takes its inflow from the parent
// (meshTileBake.ts).

export interface PlannedTile {
  tile: TileId
  // The tiles of the level above it overlaps (none for the first tile
  // level, whose parent is level 1).
  parents: TileId[]
  // The tiles of its own level whose outflow it reads.
  upstream: TileId[]
}

export interface TilePlanInput {
  // Level 1: its mesh, heights and routing (meshHydrology.meshRouting).
  mesh: PeriodicTriangulation
  z: Float32Array
  routing: MeshRouting
  width: number
  height: number
  // The tile levels, coarse to fine (2, 3).
  levels: readonly number[]
  // A level's tiles with land or shelf (the save's raster decides).
  landTiles: (level: number) => TileId[]
}

const keyOf = (t: TileId): string => `${t.level}:${t.x},${t.y}`

// The tile of `level` that holds a world point.
export function tileAt(level: number, x: number, y: number, width: number, height: number): TileId {
  const spec = tileSpec(level)
  const { cols, rows } = tileGrid(width, height, spec)
  const tx = Math.floor(wrapValue(x - spec.offset, width) / spec.cells) % cols
  const ty = Math.floor(wrapValue(y - spec.offset, height) / spec.cells) % rows
  return { level, x: tx, y: ty }
}

export function planTiles(input: TilePlanInput): PlannedTile[] {
  const { mesh, z, routing, width, height, levels } = input
  // The tiles per level: a level's land, and every tile a finer level's
  // tile needs as a parent.
  const sets = new Map<number, Map<string, TileId>>()
  for (let i = levels.length - 1; i >= 0; i--) {
    const level = levels[i]
    const set = new Map<string, TileId>()
    for (const t of input.landTiles(level)) set.set(keyOf(t), t)
    const finer = sets.get(levels[i + 1])
    if (finer) for (const t of finer.values()) for (const p of parentTilesOf(t, tileSpec(level), width, height)) set.set(keyOf(p), p)
    sets.set(level, set)
  }
  const out: PlannedTile[] = []
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]
    const set = sets.get(level)!
    const upstream = flowEdges(mesh, z, routing, width, height, level, set)
    const above = i > 0 ? tileSpec(levels[i - 1]) : null
    const tiles = [...set.values()].sort((a, b) => a.y - b.y || a.x - b.x)
    for (const tile of tiles) {
      out.push({
        tile,
        parents: above ? parentTilesOf(tile, above, width, height) : [],
        upstream: (upstream.get(keyOf(tile)) ?? []).map((k) => set.get(k)!),
      })
    }
  }
  return out
}

// A level's flow edges, acyclic: for each tile the tiles whose water
// enters it, by the water level 1 moves across their shared edges.
function flowEdges(mesh: PeriodicTriangulation, z: Float32Array, routing: MeshRouting, width: number, height: number, level: number, set: Map<string, TileId>): Map<string, string[]> {
  // The water crossing from tile a into tile b: the drainage of every
  // land node whose receiver lies in another tile of the set.
  const crossing = new Map<string, number>()
  const tileKey = new Map<number, string>()
  const keyAt = (v: number): string => {
    let k = tileKey.get(v)
    if (k === undefined) {
      k = keyOf(tileAt(level, mesh.vx[v], mesh.vy[v], width, height))
      tileKey.set(v, k)
    }
    return k
  }
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v] || z[v] <= SEA_LEVEL) continue
    const t = routing.flowTarget[v]
    if (t < 0) continue
    const a = keyAt(v)
    const b = keyAt(t)
    if (a === b || !set.has(a) || !set.has(b)) continue
    const edge = `${a}>${b}`
    crossing.set(edge, (crossing.get(edge) ?? 0) + routing.accumulation[v])
  }
  // Of a pair, the direction with more water (ties: the smaller key first).
  const edges = new Map<string, { from: string; to: string; water: number }>()
  for (const [edge, water] of crossing) {
    const [from, to] = edge.split('>')
    const back = crossing.get(`${to}>${from}`) ?? 0
    if (water > back || (water === back && from < to)) edges.set(edge, { from, to, water })
  }
  // Longer cycles: cut at the weakest edge of each strongly connected
  // component, until none is left.
  for (;;) {
    const cycles = stronglyConnected(edges)
    if (cycles.length === 0) break
    for (const members of cycles) {
      let weakest: { key: string; water: number } | null = null
      for (const [key, e] of edges) {
        if (!members.has(e.from) || !members.has(e.to)) continue
        if (!weakest || e.water < weakest.water || (e.water === weakest.water && key < weakest.key)) weakest = { key, water: e.water }
      }
      if (weakest) edges.delete(weakest.key)
    }
  }
  const upstream = new Map<string, string[]>()
  for (const e of edges.values()) {
    const list = upstream.get(e.to) ?? []
    list.push(e.from)
    upstream.set(e.to, list)
  }
  for (const list of upstream.values()) list.sort()
  return upstream
}

// Tarjan's strongly connected components with more than one member.
function stronglyConnected(edges: Map<string, { from: string; to: string }>): Set<string>[] {
  const next = new Map<string, string[]>()
  for (const e of edges.values()) {
    const list = next.get(e.from) ?? []
    list.push(e.to)
    next.set(e.from, list)
  }
  for (const list of next.values()) list.sort()
  const nodes = [...new Set([...edges.values()].flatMap((e) => [e.from, e.to]))].sort()
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: Set<string>[] = []
  let counter = 0
  // Iterative, so a long chain of tiles cannot overflow the call stack.
  for (const root of nodes) {
    if (index.has(root)) continue
    const work: { node: string; child: number }[] = [{ node: root, child: 0 }]
    index.set(root, counter)
    low.set(root, counter++)
    stack.push(root)
    onStack.add(root)
    while (work.length > 0) {
      const frame = work[work.length - 1]
      const children = next.get(frame.node) ?? []
      if (frame.child < children.length) {
        const w = children[frame.child++]
        if (!index.has(w)) {
          index.set(w, counter)
          low.set(w, counter++)
          stack.push(w)
          onStack.add(w)
          work.push({ node: w, child: 0 })
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!))
        }
        continue
      }
      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1].node
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!))
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const members = new Set<string>()
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          members.add(w)
        } while (w !== frame.node)
        if (members.size > 1) out.push(members)
      }
    }
  }
  return out
}
