import { Orientation, defineHex, hexToPoint, pointToCube } from 'honeycomb-grid'
import {
  HEX_COLUMNS,
  HEX_COL_SPACING,
  HEX_ROWS,
  HEX_ROW_SPACING,
  MAP_WORLD_HEIGHT,
  MAP_WORLD_WIDTH,
} from './mapSceneSettings'

// The LOGICAL 300 m hex grid (docs/decisions/hex-tiling.md). By decision the
// grid IS the shader lattice from mapSceneSettings — this module derives
// every number from those constants and adds what the shader cannot carry:
// identity (torus-canonical coordinates), adjacency, shared edge identities
// and the ⅓/⅔ port slots that the port design builds on. Coordinate math is
// honeycomb-grid's; the torus and the seam vocabulary are ours.
//
// Frames and units: everything is in Babylon world units on the map plane —
// the same (x, z) the relief meshes and the grid shader use. honeycomb works
// on an (x, y) plane; y here IS the world z, nothing is flipped. Hex (0,0)
// is centered at world (0,0), matching the shader's lattice anchor.

// Pointy-top with flat-to-flat = one column spacing. honeycomb takes ellipse
// radii, so the ~0.003% torus snap distortion of mapSceneSettings carries
// straight through: xRadius from the column spacing (width = √3·xRadius),
// yRadius from the row spacing (row step = 1.5·yRadius).
const HEX_SETTINGS = {
  orientation: Orientation.POINTY,
  dimensions: { xRadius: HEX_COL_SPACING / Math.sqrt(3), yRadius: HEX_ROW_SPACING / 1.5 },
  origin: { x: 0, y: 0 },
} as const

const HexProto = defineHex({ ...HEX_SETTINGS })

// Canonical tile identity on the torus: offset coordinates (odd rows shift
// +half a column, exactly the shader's lattice B), both wrapped into
// [0, HEX_COLUMNS) × [0, HEX_ROWS). Axial (q, r) is the working
// representation for math and never leaves this module unwrapped.
export interface HexId {
  col: number
  row: number
}

export interface HexPoint {
  x: number
  z: number
}

// An edge with its torus-canonical owner: both adjacent tiles resolve the
// same (owner, edge) pair, which is what makes edge-keyed data (ports!)
// shared instead of duplicated. `edge` is the owner's local edge index.
export interface HexEdgeId {
  owner: HexId
  edge: number
  key: string
}

// Axial neighbor deltas, ordered to match the corner order honeycomb
// produces for pointy-top hexes: edge k runs corner[k] → corner[k+1], and
// AXIAL_NEIGHBOR_DELTAS[k] is the neighbor across exactly that edge (E,
// SE, SW, W, NW, NE in +z-down map terms). The pairing is asserted by the
// data-level verification, not trusted.
const AXIAL_NEIGHBOR_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
]

export const HEX_EDGES = 6

// Port slots on an edge, as fractions of the owner's corner[k] → corner[k+1]
// run — ⅓ and ⅔, never corners (docs/design/hex-world-view.md: three tiles
// meet at a corner and the connection logic gets ambiguous there).
export const EDGE_PORT_FRACTIONS: readonly number[] = [1 / 3, 2 / 3]

function mod(value: number, period: number): number {
  const m = value % period
  return m < 0 ? m + period : m
}

// Axial → canonical torus id. Wrapping r by a full row count shifts the
// principal x by (rows/2)·colSpacing (each row steps half a column), so q
// compensates by half the wrapped rows — an integer, because HEX_ROWS is
// even by construction (the snap in mapSceneSettings).
function canonicalize(q: number, r: number): HexId {
  const row = mod(r, HEX_ROWS)
  const qShifted = q + (r - row) / 2
  const col = mod(qShifted + (row - (row & 1)) / 2, HEX_COLUMNS)
  return { col, row }
}

function axialOf(id: HexId): { q: number; r: number } {
  return { q: id.col - (id.row - (id.row & 1)) / 2, r: id.row }
}

export function hexIdKey(id: HexId): string {
  return `${id.col},${id.row}`
}

export function hexIdEquals(a: HexId, b: HexId): boolean {
  return a.col === b.col && a.row === b.row
}

// World position → the tile under it (any wrap copy of the plane; the
// result is always canonical).
export function hexAt(x: number, z: number): HexId {
  const cube = pointToCube(HEX_SETTINGS, { x, y: z })
  return canonicalize(cube.q, cube.r)
}

// Center of the tile's PRINCIPAL copy: x ∈ [0, width + half a column),
// z ∈ [0, height). Consumers near a seam wrap into their local frame the
// usual toroidal way — this module never guesses which copy is meant.
export function hexCenter(id: HexId): HexPoint {
  const point = hexToPoint(new HexProto(axialOf(id)))
  return { x: point.x, z: point.y }
}

// The six corners of the principal copy, in honeycomb's fixed corner order
// (edge k = corner[k] → corner[k+1]).
export function hexCorners(id: HexId): HexPoint[] {
  return new HexProto(axialOf(id)).corners.map((corner) => ({ x: corner.x, z: corner.y }))
}

// The six neighbors, indexed like the edges: neighborsOf(id)[k] lies across
// edge k.
export function hexNeighbors(id: HexId): HexId[] {
  const { q, r } = axialOf(id)
  return AXIAL_NEIGHBOR_DELTAS.map(([dq, dr]) => canonicalize(q + dq, r + dr))
}

// Shared identity of edge k of `id`. Owner = the lexicographically smaller
// (row, col) of the two adjacent tiles — arbitrary but deterministic, so
// both sides agree; the opposite edge index is (k + 3) % 6.
export function hexEdge(id: HexId, k: number): HexEdgeId {
  const other = hexNeighbors(id)[k]
  const idOwns = id.row < other.row || (id.row === other.row && id.col <= other.col)
  const owner = idOwns ? id : other
  const edge = idOwns ? k : (k + 3) % HEX_EDGES
  return { owner, edge, key: `${hexIdKey(owner)}:${edge}` }
}

// The edge's two port slot positions, in the OWNER's principal frame — both
// adjacent tiles compute byte-identical numbers because both resolve the
// same owner first. Slot order follows the owner's corner direction.
export function edgePortPositions(id: HexId, k: number): HexPoint[] {
  const { owner, edge } = hexEdge(id, k)
  const corners = hexCorners(owner)
  const a = corners[edge]
  const b = corners[(edge + 1) % HEX_EDGES]
  return EDGE_PORT_FRACTIONS.map((t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }))
}

// Shortest toroidal delta between two map-plane points — the standard wrap
// helper, here for callers comparing hex centers across the seam.
export function wrappedHexDelta(from: HexPoint, to: HexPoint): HexPoint {
  let dx = to.x - from.x
  let dz = to.z - from.z
  dx -= MAP_WORLD_WIDTH * Math.round(dx / MAP_WORLD_WIDTH)
  dz -= MAP_WORLD_HEIGHT * Math.round(dz / MAP_WORLD_HEIGHT)
  return { x: dx, z: dz }
}
