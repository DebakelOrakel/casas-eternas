import { HEX_EDGES, hexAt, hexCenter, hexCorners, hexNeighbors, wrappedHexDelta } from './hexGrid'
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
// is a wash. The point is that a tile can be LEVELLED: its seven vertices
// are its own, so flattening one CUTS the ground instead of laying a plate
// over it, and the edge between developed and wild is a real crease in the
// mesh rather than a drawn skirt. That half is built too (2026-08-15) — see
// HexNearMeshPlates and `emitWall` below.
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

// The developed tiles, when the caller has any. A developed tile does NOT
// share its corners with the wilderness: it gets its own seven vertices at
// the plate's height, and a wall on every edge running to the exact heights
// its neighbours gave that edge. That is the whole difference between this
// and the plate layer it replaces — the levelling CUTS the ground instead of
// laying a lid over it, so a plate below its surroundings is a terrace dug
// into the hillside and one above them stands on its own embankment, both
// from the same construction.
export interface HexNearMeshPlates {
  // The plate's height in world Y (before the lift, exactly as `heightAt`
  // reports the ground), or null for wilderness.
  heightAt: (tile: HexId) => number | null
  // An upper bound on the developed tiles inside the window — the buffers are
  // sized before the window is walked, and the caller's total plate count is
  // the honest bound.
  count: number
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
  // Developed tiles, or omitted for a wholly wild window.
  plates?: HexNearMeshPlates
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

// Worked earth against wild green, with a darker rim where the plate meets
// what it displaced. The same two colours the plate layer used, so the swap
// between the two near grounds does not also change what a settlement looks
// like — and for the same reason it gave them: on ground gentle enough to
// develop, HEIGHT cannot carry "someone lives here" (a 300 m tile of it
// spans about 0.2 m), so the signal has to be surface.
// Below this a wall has no area worth emitting. 1e-8 world units is 8 mm on
// this world, which is under the float32 resolution of a vertex buffer at
// these coordinates — so it is the "exactly level" test, not a tolerance
// anyone tuned.
const WALL_EPS = 1e-8

const WILD_TINT = [1, 1, 1] as const
const PLATE_TOP_TINT = [0.78, 0.69, 0.47] as const
const PLATE_WALL_TINT = [0.45, 0.38, 0.28] as const

export function buildHexNearMesh(inputs: HexNearMeshInputs): HexNearMeshGeometry {
  const { anchorX, anchorZ, heightAt, baseAt, uvAt, lift, plates } = inputs
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
  // twice. A developed tile shares nothing and adds walls: 7 of its own, plus
  // 6 edges × 4 — doubled, because an edge that crosses the ground splits
  // into two walls — so 7 + 48 per plate, and 56 for the arithmetic to be
  // visibly slack rather than exactly met.
  const plateBound = plates?.count ?? 0
  const maxVertices = tileCount * 4 + 8 + plateBound * 56
  const positions = new Float32Array(maxVertices * 3)
  const uvs = new Float32Array(maxVertices * 2)
  const colors = new Float32Array(maxVertices * 4)
  const normals = new Float32Array(maxVertices * 3)
  const indices = new Uint32Array(tileCount * HEX_EDGES * 3 + plateBound * HEX_EDGES * 12)

  let vertexCount = 0
  let indexCount = 0
  const cornerIndex = new Map<number, number>()

  // The wild ground at a point: the drawn surface, lifted, blending toward
  // the plain surface at the window's rim. Kept apart from the emission
  // because a plate's WALL has to end exactly where its wild neighbour's
  // vertex stands, and the only way to guarantee that is to ask the same
  // function with the same argument.
  const groundY = (px: number, pz: number): number => {
    const rim = Math.max(Math.abs(px - anchorX) / halfWidth, Math.abs(pz - anchorZ) / halfHeight)
    const edge = rim <= RIM_START ? 0 : Math.min(1, (rim - RIM_START) / RIM_RUN)
    const detail = heightAt(px, pz)
    return edge > 0 ? detail + (baseAt(px, pz) - detail) * edge + lift * (1 - edge) : detail + lift
  }

  // One vertex, placed in the anchor frame at a height the caller has already
  // decided. The tint is stored in `colors` and multiplied by the micro-albedo
  // in the normal pass below, so worked earth still takes the rock-shadow
  // reading the wilderness gets.
  const emitVertex = (px: number, pz: number, y: number, tint: readonly number[]): number => {
    const i = vertexCount++
    positions[i * 3] = px
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = pz
    const { u, v } = uvAt(px, pz)
    uvs[i * 2] = u
    uvs[i * 2 + 1] = v
    const co = i * 4
    colors[co] = tint[0]
    colors[co + 1] = tint[1]
    colors[co + 2] = tint[2]
    colors[co + 3] = 1
    return i
  }

  const cornerVertex = (p: HexPoint): number => {
    const key = Math.round(p.x * CORNER_QUANT) * 4194304 + Math.round(p.z * CORNER_QUANT)
    const hit = cornerIndex.get(key)
    if (hit !== undefined) return hit
    const i = emitVertex(p.x, p.z, groundY(p.x, p.z), WILD_TINT)
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

  // The six-triangle fan of one tile, from whatever seven vertices it was
  // given — the wilderness shares its corners, a plate owns them, and the top
  // face is the same either way.
  const emitFan = (centreIndex: number): void => {
    for (let k = 0; k < HEX_EDGES; k++) {
      const a = corners[k]
      const b = corners[(k + 1) % HEX_EDGES]
      indices[indexCount++] = centreIndex
      indices[indexCount++] = flip ? b : a
      indices[indexCount++] = flip ? a : b
    }
  }

  // One edge of a plate, standing between the plate's top and whatever the
  // neighbour put along that edge. It is a FILL when the plate is the higher
  // (an embankment) and a CUT when it is the lower (the back wall of a
  // terrace), and the only difference between those in this code is which way
  // round the two triangles are wound.
  const emitWall = (centre: HexPoint, pa: HexPoint, pb: HexPoint, top: number, ya: number, yb: number): void => {
    // Nothing to bridge only when BOTH corners are level with the top —
    // averaging first would skip a wall that rises at one end and falls at
    // the other, and leave the crack it was there to close.
    const da = top - ya
    const db = top - yb
    if (Math.abs(da) < WALL_EPS && Math.abs(db) < WALL_EPS) return
    // A wall whose two ends are on OPPOSITE sides of the ground — the plate
    // standing proud at one corner and cut into the hill at the other — is
    // two walls, split where the surfaces cross. One quad cannot face away
    // from material that lies on different sides of its two ends, and the
    // crossing point is exact: the neighbour spans that edge with a straight
    // chord, so interpolating along it lands on the neighbour's own geometry.
    if (da * db < 0) {
      const t = da / (da - db)
      const mid = { x: pa.x + (pb.x - pa.x) * t, z: pa.z + (pb.z - pa.z) * t }
      emitWall(centre, pa, mid, top, ya, top)
      emitWall(centre, mid, pb, top, top, yb)
      return
    }
    const at = emitVertex(pa.x, pa.z, top, PLATE_WALL_TINT)
    const bt = emitVertex(pb.x, pb.z, top, PLATE_WALL_TINT)
    const ab = emitVertex(pa.x, pa.z, ya, PLATE_WALL_TINT)
    const bb = emitVertex(pb.x, pb.z, yb, PLATE_WALL_TINT)
    // Winding from the EDGE alone, and deliberately not from the drop.
    //
    // The normal pass computes (p1−p0)×(p2−p0), which for the top faces comes
    // out +Y — so it is the front normal. For (at, ab, bt) it reduces to
    // (ya−top)·(ez, −ex), and the order is chosen so that a FILL — the plate
    // standing on its own embankment — faces away from the tile centre.
    //
    // A CUT then faces inward under the same winding, and that is the point
    // rather than an oversight: the material of a cut is OUTSIDE the plate
    // (the hillside the terrace was dug into), so the exposed face is the one
    // you see from the plate. Deciding the winding from the drop instead
    // would force every wall outward and light every terrace back-wall from
    // behind.
    const ex = pb.x - pa.x
    const ez = pb.z - pa.z
    const direct = ez * ((pa.x + pb.x) / 2 - centre.x) - ex * ((pa.z + pb.z) / 2 - centre.z) < 0
    // Half of a split wall meets the ground at one end, where the quad
    // collapses to a triangle — so each half is emitted only if it has area.
    if (Math.abs(da) >= WALL_EPS) {
      indices[indexCount++] = at
      indices[indexCount++] = direct ? ab : bt
      indices[indexCount++] = direct ? bt : ab
    }
    if (Math.abs(db) >= WALL_EPS) {
      indices[indexCount++] = bt
      indices[indexCount++] = direct ? ab : bb
      indices[indexCount++] = direct ? bb : ab
    }
  }

  for (let dr = -halfRows; dr <= halfRows; dr++) {
    const row = ((anchorTile.row + dr) % HEX_ROWS + HEX_ROWS) % HEX_ROWS
    for (let dc = -halfCols; dc <= halfCols; dc++) {
      const col = ((anchorTile.col + dc) % HEX_COLUMNS + HEX_COLUMNS) % HEX_COLUMNS
      const tile: HexId = { col, row }
      const centre = framed(hexCenter(tile))
      const raw = hexCorners(tile)
      const plate = plates?.heightAt(tile) ?? null
      if (plate === null) {
        const centreIndex = emitVertex(centre.x, centre.z, groundY(centre.x, centre.z), WILD_TINT)
        for (let k = 0; k < HEX_EDGES; k++) corners[k] = cornerVertex(framed(raw[k]))
        emitFan(centreIndex)
        continue
      }
      // A developed tile: its own seven vertices at one height, so the fan is
      // flat by construction and its normals come out +Y without a special
      // case. They are deliberately NOT registered as shared corners — the
      // wilderness next door keeps its own, and the gap between them is the
      // crease the walls below close.
      const top = plate + lift
      const framedCorners: HexPoint[] = new Array(HEX_EDGES)
      const centreIndex = emitVertex(centre.x, centre.z, top, PLATE_TOP_TINT)
      for (let k = 0; k < HEX_EDGES; k++) {
        const p = framed(raw[k])
        framedCorners[k] = p
        corners[k] = emitVertex(p.x, p.z, top, PLATE_TOP_TINT)
      }
      emitFan(centreIndex)
      const neighbours = hexNeighbors(tile)
      for (let k = 0; k < HEX_EDGES; k++) {
        const pa = framedCorners[k]
        const pb = framedCorners[(k + 1) % HEX_EDGES]
        const neighbour = plates?.heightAt(neighbours[k]) ?? null
        if (neighbour !== null) {
          // Two plates meet: only the HIGHER one draws the step, or both draw
          // the same wall and the pair z-fights along every shared edge.
          const other = neighbour + lift
          if (other >= top) continue
          emitWall(centre, pa, pb, top, other, other)
          continue
        }
        // Against wilderness the wall ends on the neighbour's OWN corner
        // heights, read from the function that placed them — so the two
        // surfaces meet along the whole edge instead of somewhere near it.
        // (The neighbour computes its corner from its own centre, so the two
        // positions agree to floating point and not further; that is the same
        // tolerance the corner sharing already runs on.)
        emitWall(centre, pa, pb, top, groundY(pa.x, pa.z), groundY(pb.x, pb.z))
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
    // Multiplied into whatever tint the vertex was emitted with, so a plate's
    // worked earth and its walls take the same rock-shadow reading the
    // wilderness does — a flat plate's normal is +Y, so its top keeps its
    // colour exactly, and a wall reads as the near-vertical face it is.
    const co = i * 4
    colors[co] *= brightness
    colors[co + 1] *= brightness
    colors[co + 2] *= brightness
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
