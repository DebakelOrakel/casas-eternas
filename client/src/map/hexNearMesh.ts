import { HEX_EDGES, hexAt, hexCenter, hexCorners, wrappedHexDelta } from './hexGrid'
import { HEX_COLUMNS, HEX_COL_SPACING, HEX_ROWS, HEX_ROW_SPACING } from './mapSceneSettings'
import type { HexId, HexPoint } from './hexGrid'

// THE NEAR GROUND AS A HEX LATTICE — step 2 of the near-field plan
// (docs/design/hex-world-view.md, agreed 2026-08-14).
//
// Below the threshold the ground the camera looks at IS the tile grid:
// one vertex at every hex centre, one at every corner, six triangles per
// tile. The square detail patch continues above it. Decided
// replace-below-threshold rather than nested, so the two never draw the
// same ground twice.
//
// The point is not more detail — at the camera's floor the square patch
// samples every ~208 m and this lattice puts a vertex every ~173 m, which
// is a wash. The point is that a tile can now be LEVELLED: its seven
// vertices are its own, so flattening one cuts the ground instead of laying
// a plate over it, and the edge between developed and wild is a real crease
// in the mesh rather than a drawn skirt.
//
// Babylon-free on purpose, exactly like hexPlates: this file answers "what
// is the geometry" and can be checked headless, while ToroidalMapView owns
// the mesh, the material and the lifecycle — the same split the square
// patch already has.
//
// FRAMES. hexGrid reports a tile in its PRINCIPAL copy, x ∈ [0, worldWidth),
// while the ground meshes are centred on the origin. Every position here is
// therefore built in the copy NEAREST the anchor (toroidal delta from it),
// which is the lesson the plate layer paid for on 2026-08-14 — half the
// world drew one world period away from the ground it belonged to.

// The window, in tiles. 192 across is ~57.6 km of world at the 300 m tile
// size, which is what makes the swap from the square patch an even trade:
// the patch covers PATCH_COVERAGE × altitude, so at any altitude below
// `hexNearMeshMaxAltitude` the lattice covers at least as much ground as the
// patch it replaces.
//
// Measured at this size (2026-08-15): 43,039 tiles, 129,949 vertices — 3.02
// per tile, which is the corner sharing working — and 258,234 triangles.
// A rebuild costs 29 ms of geometry plus the height sampling, 85 ms in total
// against the hydrology-aware fine surface. That is a visible hitch, and it
// is paid once every quarter window (14 km of travel) rather than every
// 400 m as the square patch pays its 17 ms. If it is ever felt, the
// escalation is the one the class overlay already uses — fill a budget of
// tiles per frame instead of the whole window at once — not a smaller
// window, which would drag the swap threshold below the camera's floor.
export const HEX_NEAR_WINDOW_TILES = 192

// The altitude below which the lattice covers at least as much as the square
// patch would. DERIVED rather than stated, so the window size and the
// patch's own coverage cannot drift apart into a band where the swap loses
// ground.
export function hexNearMeshMaxAltitude(patchCoverage: number): number {
  return (HEX_NEAR_WINDOW_TILES * HEX_COL_SPACING) / patchCoverage
}

export interface HexNearMeshGeometry {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  colors: Float32Array
  indices: Uint32Array
  // What was actually built — for the caller's diagnostics, and because the
  // vertex count is the honest measure of this thing's cost.
  vertexCount: number
  tileCount: number
  // The lattice position of the tile at the window's centre, so a caller can
  // tell whether a rebuild moved anything.
  anchorTile: HexId
}

export interface HexNearMeshInputs {
  // Where the window sits — the camera focus, in world units.
  anchorX: number
  anchorZ: number
  // The DRAWN ground (world Y): the same biased fine surface the square
  // patch renders, or the two disagree at the swap.
  heightAt: (x: number, z: number) => number
  // The plain raster surface the relief mesh under this one uses. The window
  // blends back into it at its rim, exactly as the patch does — without it
  // the lattice ends on a cliff.
  baseAt: (x: number, z: number) => number
  // World → the ground meshes' own texture coordinates.
  uvAt: (x: number, z: number) => { u: number; v: number }
  // A whisker of lift over the relief mesh, as the patch has.
  lift: number
}

// Where the rim blend starts, as a fraction of the window's half-width. Same
// shape and the same two numbers as the square patch's, because it solves
// the identical problem and a second answer would just be a second thing to
// keep in step.
const RIM_START = 0.75
const RIM_RUN = 0.23

// Corner identity. Three tiles meet at a corner and each computes it from
// its own centre, so the three answers agree to floating point and not
// further — they cannot be keyed on directly. Quantising to a sixty-fourth
// of a tile is far coarser than that error and far finer than the lattice,
// so it collapses exactly the corners that are meant to be one vertex.
// (Positions are all in the anchor frame, so the seam cannot split a corner:
// a window never spans the world.)
const CORNER_QUANT = 64 / HEX_COL_SPACING

export function buildHexNearMesh(inputs: HexNearMeshInputs): HexNearMeshGeometry {
  const { anchorX, anchorZ, heightAt, baseAt, uvAt, lift } = inputs
  const anchor: HexPoint = { x: anchorX, z: anchorZ }
  const anchorTile = hexAt(anchorX, anchorZ)
  const halfCols = HEX_NEAR_WINDOW_TILES >> 1
  // Rows cover the same DISTANCE as the columns, not the same count: a row
  // step is HEX_ROW_SPACING, which is √3/2 of a column, so equal counts
  // would make the window noticeably shorter than it is wide.
  const halfRows = Math.round((halfCols * HEX_COL_SPACING) / HEX_ROW_SPACING)
  const halfWidth = halfCols * HEX_COL_SPACING
  const halfHeight = halfRows * HEX_ROW_SPACING

  const tileCount = (halfCols * 2 + 1) * (halfRows * 2 + 1)
  // 1 centre per tile, and a corner is shared by three tiles — so a little
  // over three vertices per tile, with the window's own boundary adding the
  // rest. Allocated generously and sliced at the end rather than counted
  // twice.
  const maxVertices = tileCount * 4 + 8
  const positions = new Float32Array(maxVertices * 3)
  const uvs = new Float32Array(maxVertices * 2)
  const colors = new Float32Array(maxVertices * 4)
  const normals = new Float32Array(maxVertices * 3)
  const indices = new Uint32Array(tileCount * HEX_EDGES * 3)

  let vertexCount = 0
  let indexCount = 0
  const cornerIndex = new Map<number, number>()

  // One vertex, placed in the anchor frame and lifted onto the drawn ground.
  // `rim` is the blend toward the plain surface at the window's edge.
  const emitVertex = (px: number, pz: number): number => {
    const rim = Math.max(Math.abs(px - anchorX) / halfWidth, Math.abs(pz - anchorZ) / halfHeight)
    const edge = rim <= RIM_START ? 0 : Math.min(1, (rim - RIM_START) / RIM_RUN)
    const detail = heightAt(px, pz)
    const y = edge > 0 ? detail + (baseAt(px, pz) - detail) * edge + lift * (1 - edge) : detail + lift
    const i = vertexCount++
    positions[i * 3] = px
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = pz
    const { u, v } = uvAt(px, pz)
    uvs[i * 2] = u
    uvs[i * 2 + 1] = v
    return i
  }

  const cornerVertex = (p: HexPoint): number => {
    const key = Math.round(p.x * CORNER_QUANT) * 4194304 + Math.round(p.z * CORNER_QUANT)
    const hit = cornerIndex.get(key)
    if (hit !== undefined) return hit
    const i = emitVertex(p.x, p.z)
    cornerIndex.set(key, i)
    return i
  }

  // Winding, decided by measurement rather than by assuming honeycomb's
  // corner order: the fan (centre, corner k, corner k+1) must come out
  // front-facing from above. Checked once — the lattice is uniform, so what
  // holds for one tile holds for all.
  let flip = false
  {
    const c = hexCorners(anchorTile)
    const centre = hexCenter(anchorTile)
    const ax = c[0].x - centre.x
    const az = c[0].z - centre.z
    const bx = c[1].x - centre.x
    const bz = c[1].z - centre.z
    // +Y of (a × b) in a left-handed frame with y up: az*bx − ax*bz.
    flip = az * bx - ax * bz < 0
  }

  const framed = (p: HexPoint): HexPoint => {
    const d = wrappedHexDelta(anchor, p)
    return { x: anchorX + d.x, z: anchorZ + d.z }
  }

  const corners: number[] = new Array(HEX_EDGES)
  for (let dr = -halfRows; dr <= halfRows; dr++) {
    const row = ((anchorTile.row + dr) % HEX_ROWS + HEX_ROWS) % HEX_ROWS
    for (let dc = -halfCols; dc <= halfCols; dc++) {
      const col = ((anchorTile.col + dc) % HEX_COLUMNS + HEX_COLUMNS) % HEX_COLUMNS
      const tile: HexId = { col, row }
      const centre = framed(hexCenter(tile))
      const centreIndex = emitVertex(centre.x, centre.z)
      const raw = hexCorners(tile)
      for (let k = 0; k < HEX_EDGES; k++) corners[k] = cornerVertex(framed(raw[k]))
      for (let k = 0; k < HEX_EDGES; k++) {
        const a = corners[k]
        const b = corners[(k + 1) % HEX_EDGES]
        indices[indexCount++] = centreIndex
        indices[indexCount++] = flip ? b : a
        indices[indexCount++] = flip ? a : b
      }
    }
  }

  // Smooth normals: every face adds to its three vertices, so a corner
  // shared by three tiles ends up with their average and the wilderness
  // reads as one continuous ground. (A per-hex facet look is the cheap
  // experiment on the other side of this line — it needs the corners split,
  // not the normals changed.)
  for (let i = 0; i < indexCount; i += 3) {
    const a = indices[i] * 3
    const b = indices[i + 1] * 3
    const c = indices[i + 2] * 3
    const abx = positions[b] - positions[a]
    const aby = positions[b + 1] - positions[a + 1]
    const abz = positions[b + 2] - positions[a + 2]
    const acx = positions[c] - positions[a]
    const acy = positions[c + 1] - positions[a + 1]
    const acz = positions[c + 2] - positions[a + 2]
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    normals[a] += nx
    normals[a + 1] += ny
    normals[a + 2] += nz
    normals[b] += nx
    normals[b + 1] += ny
    normals[b + 2] += nz
    normals[c] += nx
    normals[c + 1] += ny
    normals[c + 2] += nz
  }
  for (let i = 0; i < vertexCount; i++) {
    const o = i * 3
    const len = Math.hypot(normals[o], normals[o + 1], normals[o + 2]) || 1
    const ny = normals[o + 1] / len
    normals[o] /= len
    normals[o + 1] = ny
    normals[o + 2] /= len
    // The patch's micro-albedo, restated on the normal instead of on a
    // height grid: rock-shadow reading that does not depend on the light
    // angle, so fine structure stays legible on near-white paper. Slope is
    // the normal's tilt, which is the same quantity the patch derives from
    // its finite differences.
    const brightness = 1 - Math.min(0.4, (Math.hypot(normals[o], normals[o + 2]) / Math.max(1e-6, Math.abs(ny))) * 0.8)
    const co = i * 4
    colors[co] = brightness
    colors[co + 1] = brightness
    colors[co + 2] = brightness
    colors[co + 3] = 1
  }

  return {
    positions: positions.subarray(0, vertexCount * 3),
    normals: normals.subarray(0, vertexCount * 3),
    uvs: uvs.subarray(0, vertexCount * 2),
    colors: colors.subarray(0, vertexCount * 4),
    indices: indices.subarray(0, indexCount),
    vertexCount,
    tileCount,
    anchorTile,
  }
}
