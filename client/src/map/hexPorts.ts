import { EDGE_PORT_FRACTIONS, HEX_EDGES, edgePortPositions, hexAt, hexCorners, hexEdge, hexIdEquals, hexIdKey, hexNeighbors, wrappedHexDelta } from './hexGrid'
import type { HexId, HexPoint } from './hexGrid'
import { HEX_COL_SPACING, MAP_WORLD_HEIGHT, MAP_WORLD_WIDTH } from './mapSceneSettings'
// Worldgen's own width vocabulary — reading its units and pure values is what
// the map→worldgen boundary allows (see the root CLAUDE.md).
import { RIVER_MAX_WIDTH, RIVER_MIN_WIDTH } from '../generator/surface/hydrology'

// Phase 3 of the hex build plan (docs/design/hex-world-view.md): the SEAM
// vocabulary — how linear and areal features meet the grid.
//
// Two mechanisms, deliberately different, straight from the design:
//
//   Rivers RESERVE ports. A river crossing a tile edge claims one of the
//   edge's two slots (both when it is wide). Reservation is what lets a tile
//   generate its interior as an independent spline later without consulting
//   its neighbours — the port is the contract.
//
//   Shorelines COMPUTE their crossing. The waterline is the boundary of an
//   areal feature, so snapping it to the discrete slots would visibly
//   quantise coastlines; instead both neighbours interpolate the same
//   crossing from the same shared corner heights (marching hexagons) and the
//   seam is tight by construction.
//
// Everything here is DERIVED and never serialized — same authority rule as
// the amplification bake. It is also deliberately WINDOWED: the design's
// "chunk-wise near the camera", and the reason the whole world's rivers
// (~100,000 km of channel at 8K) never have to be resident.

// Where a polyline's stored width (the hydrology scale, √ of relative
// discharge) counts as wide enough to claim BOTH slots of an edge.
// PROVISIONAL, like phase 2's grade constants: the honest answer needs a
// physical width in metres, which the river layer does not carry — it stores
// a cartographic scale relative to the world's biggest river. Until then this
// is a knob, not a measurement.
export const WIDE_RIVER_RELATIVE = 0.6

// Sampling step along a river segment as a fraction of the column spacing.
// River points sit one raster cell apart (~2 km at 8K) while hexes are 300 m,
// so a segment spans several tiles and must be walked, not tested endpoint to
// endpoint. Transitions are then refined by bisection, so this only has to be
// fine enough not to miss a tile entirely.
const WALK_STEP_FRACTION = 0.35
// Bisection depth for locating a crossing (and for splitting a step that
// jumped past a corner into a non-neighbour). 16 halvings put the crossing
// far below the port spacing; the loop also stops as soon as the two ends are
// neighbours AND the interval is tight.
const BISECT_DEPTH = 16

export type HexPortDirection = 'in' | 'out'

export interface HexRiverPort {
  // Edge index in the TILE's own frame (0..5), and the shared identity both
  // neighbours resolve to.
  edge: number
  edgeKey: string
  // Claimed slots in the edge OWNER's order — one, or both for a wide river.
  slots: number[]
  // The claimed slots' positions, in the owner's principal frame.
  positions: HexPoint[]
  // The polyline's stored width at the crossing (hydrology scale).
  width: number
  direction: HexPortDirection
}

export interface HexTileRivers {
  ports: HexRiverPort[]
}

export interface HexRiverPortMap {
  get(tile: HexId): HexTileRivers | undefined
  has(tile: HexId): boolean
  readonly tileCount: number
  readonly crossingCount: number
  // Tiles that ended up with more than one out-port. D8 gives each cell a
  // single downstream target, so a well-behaved network has none — but a
  // river that meanders back through a tile at 300 m can legitimately leave
  // twice. Counted rather than asserted, so the number stays visible instead
  // of becoming a silent assumption.
  readonly multiOutTiles: number
}

export interface RiverPolylines {
  // [cellX, cellY, width] triples, in raster cell coordinates, polylines
  // concatenated and delimited by `lengths` — the hydrology layer's own
  // format (see ToroidalRibbonOverlay, which reads the same buffers).
  points: Float32Array
  lengths: Uint32Array
  // The raster the cell coordinates belong to.
  width: number
  height: number
}

// The window to build for: a rectangle around a center, in world units, with
// toroidal wrapping handled by the caller-agnostic distance test below.
export interface HexPortWindow {
  centerX: number
  centerZ: number
  halfWidth: number
  halfHeight: number
}

function insideWindow(x: number, z: number, w: HexPortWindow, margin: number): boolean {
  const d = wrappedHexDelta({ x: w.centerX, z: w.centerZ }, { x, z })
  return Math.abs(d.x) <= w.halfWidth + margin && Math.abs(d.z) <= w.halfHeight + margin
}

// Which local edge of `from` faces `to`, or -1 when they are not neighbours.
function edgeToward(from: HexId, to: HexId): number {
  const neighbors = hexNeighbors(from)
  for (let k = 0; k < HEX_EDGES; k++) if (hexIdEquals(neighbors[k], to)) return k
  return -1
}

// The slot(s) a crossing at `point` claims on `tile`'s edge `k`.
function claimSlots(tile: HexId, k: number, point: HexPoint, wide: boolean): { slots: number[]; positions: HexPoint[] } {
  const positions = edgePortPositions(tile, k)
  if (wide) return { slots: EDGE_PORT_FRACTIONS.map((_, i) => i), positions }
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < positions.length; i++) {
    const d = wrappedHexDelta(positions[i], point)
    const dist = Math.hypot(d.x, d.z)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return { slots: [best], positions: [positions[best]] }
}

export function buildRiverPorts(rivers: RiverPolylines, window: HexPortWindow): HexRiverPortMap {
  const tiles = new Map<string, { tile: HexId; ports: HexRiverPort[]; outCount: number }>()
  let crossingCount = 0
  let multiOutTiles = 0

  const toWorldX = (cellX: number): number => (cellX / rivers.width - 0.5) * MAP_WORLD_WIDTH
  const toWorldZ = (cellY: number): number => (cellY / rivers.height - 0.5) * MAP_WORLD_HEIGHT

  function record(tile: HexId, k: number, point: HexPoint, width: number, direction: HexPortDirection): void {
    const key = hexIdKey(tile)
    let entry = tiles.get(key)
    if (!entry) {
      entry = { tile, ports: [], outCount: 0 }
      tiles.set(key, entry)
    }
    const shared = hexEdge(tile, k)
    const wide = relativeRiverWidth(width) >= WIDE_RIVER_RELATIVE
    const { slots, positions } = claimSlots(tile, k, point, wide)
    // Reservation, not stacking: the same edge claimed twice by the same
    // river (a meander returning through the tile) keeps the first claim.
    if (entry.ports.some((p) => p.edgeKey === shared.key && p.direction === direction)) return
    entry.ports.push({ edge: k, edgeKey: shared.key, slots, positions, width, direction })
    if (direction === 'out') {
      entry.outCount++
      if (entry.outCount === 2) multiOutTiles++
    }
  }

  // A transition between two samples: refine until the two ends are
  // neighbours and the interval is tight, then hand over the crossing.
  function resolve(
    x0: number, z0: number, x1: number, z1: number,
    t0: number, t1: number, hexA: HexId, hexB: HexId,
    width: number, depth: number,
  ): void {
    const at = (t: number): HexPoint => ({ x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t })
    let a = t0
    let b = t1
    let ha = hexA
    let hb = hexB
    for (let i = 0; i < depth; i++) {
      const k = edgeToward(ha, hb)
      const spanX = (x1 - x0) * (b - a)
      const spanZ = (z1 - z0) * (b - a)
      const tight = Math.hypot(spanX, spanZ) < 0.02 * HEX_COL_SPACING
      if (k >= 0 && tight) break
      const m = (a + b) / 2
      const hm = hexAt(at(m).x, at(m).z)
      if (hexIdEquals(hm, ha)) a = m
      else if (hexIdEquals(hm, hb)) b = m
      else {
        // The step jumped a corner: two transitions, not one. Handle the near
        // half here and recurse on the far one.
        resolve(x0, z0, x1, z1, m, b, hm, hb, width, Math.max(1, depth - i - 1))
        b = m
        hb = hm
      }
    }
    const k = edgeToward(ha, hb)
    if (k < 0) return // unresolvable within the depth budget — drop it rather than guess
    const point = at((a + b) / 2)
    if (!insideWindow(point.x, point.z, window, HEX_COL_SPACING)) return
    crossingCount++
    // Downstream order: leaving `ha`, entering `hb`.
    record(ha, k, point, width, 'out')
    record(hb, (k + 3) % HEX_EDGES, point, width, 'in')
  }

  const step = WALK_STEP_FRACTION * HEX_COL_SPACING
  let read = 0
  for (const length of rivers.lengths) {
    for (let n = 0; n < length - 1; n++) {
      const b0 = (read + n) * 3
      const b1 = (read + n + 1) * 3
      const x0 = toWorldX(rivers.points[b0])
      const z0 = toWorldZ(rivers.points[b0 + 1])
      const x1 = toWorldX(rivers.points[b1])
      const z1 = toWorldZ(rivers.points[b1 + 1])
      // Cheap rejection before the fine walk — most of a world's rivers are
      // nowhere near the window.
      if (!insideWindow(x0, z0, window, HEX_COL_SPACING * 4) && !insideWindow(x1, z1, window, HEX_COL_SPACING * 4)) continue
      const width = rivers.points[b0 + 2]
      const dx = x1 - x0
      const dz = z1 - z0
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / step))
      let prev = hexAt(x0, z0)
      let prevT = 0
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const here = hexAt(x0 + dx * t, z0 + dz * t)
        if (!hexIdEquals(here, prev)) {
          resolve(x0, z0, x1, z1, prevT, t, prev, here, width, BISECT_DEPTH)
          prev = here
        }
        prevT = t
      }
    }
    read += length
  }

  return {
    get: (tile) => tiles.get(hexIdKey(tile)),
    has: (tile) => tiles.has(hexIdKey(tile)),
    tileCount: tiles.size,
    crossingCount,
    multiOutTiles,
  }
}

// Where a stored width sits between the hydrology scale's ends.
function relativeRiverWidth(width: number): number {
  return Math.min(1, Math.max(0, (width - RIVER_MIN_WIDTH) / (RIVER_MAX_WIDTH - RIVER_MIN_WIDTH)))
}

// --- Shorelines: computed, not reserved -------------------------------------

export interface HexShore {
  // Which of the six corners are land (height above the water level), in
  // hexCorners order.
  landCorners: boolean[]
  // The waterline through this tile, as segments between interpolated edge
  // crossings. Empty for an all-land or all-water tile.
  //
  // In the TILE's own principal frame, like every position here — two tiles
  // adjacent across the seam report the same physical crossing at coordinates
  // a world period apart, so anything comparing crossings between tiles must
  // wrap (wrappedHexDelta), never subtract raw coordinates.
  segments: { a: HexPoint; b: HexPoint }[]
}

// Marching hexagons: classify the corners, interpolate where the waterline
// crosses each mixed edge. Both neighbours run this over the SAME shared
// corner positions and the same height sampler, so their crossings agree by
// construction — which is the whole point of computing rather than snapping.
//
// TWO REQUIREMENTS on `heightAtWorld`, both learned by measurement rather
// than reasoning, and both silent when violated:
//
//   UNCLAMPED. It must return the terrain's real elevation, going BELOW
//   `waterLevel` offshore — not the render surfaces, which clamp the sea to
//   zero (elevationSurface/fineElevationSurface do, deliberately, so the
//   ocean stays a flat plane). Fed a clamped field every water corner reads
//   exactly the water level, the interpolation parameter collapses to 0 or 1,
//   and every crossing snaps onto a corner: a coastline made of the very
//   corner points the port design avoids. The world layer's elevation view
//   (`world.acquire('elevation', …)`, what the hover readout samples) is the
//   right shape of source.
//
//   PERIODIC over the torus. Corners come from the tile's PRINCIPAL copy, so
//   a tile hovering near world x = −1 is sampled near x = +19. Every real
//   sampler here is periodic (they all index by wrapped UV), but a test
//   double that is not will report open ocean as dry land.
//
// `waterLevel` is 0 for the sea and a lake's own surface elevation for a lake
// (per-lake surfaces are a later piece — see the design doc's water note).
export function hexShoreCrossings(
  tile: HexId,
  heightAtWorld: (x: number, z: number) => number,
  waterLevel = 0,
): HexShore {
  const corners = hexCorners(tile)
  const heights = corners.map((c) => heightAtWorld(c.x, c.z))
  const landCorners = heights.map((h) => h > waterLevel)
  const crossings: HexPoint[] = []
  for (let k = 0; k < HEX_EDGES; k++) {
    const j = (k + 1) % HEX_EDGES
    if (landCorners[k] === landCorners[j]) continue
    const hk = heights[k]
    const hj = heights[j]
    // Guard the degenerate case (both exactly at the level): midpoint.
    const denom = hj - hk
    const t = Math.abs(denom) < 1e-20 ? 0.5 : (waterLevel - hk) / denom
    const clamped = Math.min(1, Math.max(0, t))
    crossings.push({
      x: corners[k].x + (corners[j].x - corners[k].x) * clamped,
      z: corners[k].z + (corners[j].z - corners[k].z) * clamped,
    })
  }
  const segments: { a: HexPoint; b: HexPoint }[] = []
  for (let i = 0; i + 1 < crossings.length; i += 2) segments.push({ a: crossings[i], b: crossings[i + 1] })
  return { landCorners, segments }
}
