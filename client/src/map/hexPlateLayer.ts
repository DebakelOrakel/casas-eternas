import { Color3, Mesh, StandardMaterial, VertexData } from '@babylonjs/core'
import type { Scene } from '@babylonjs/core'
import { hexCenter, hexCorners, wrappedHexDelta } from './hexGrid'
import { plateSeams } from './hexPlates'
import type { HexPlates } from './hexPlates'
import type { HexId } from './hexGrid'
import { hexUvFromWorld } from './hexTiles'
import { MAP_WORLD_HEIGHT, MAP_WORLD_WIDTH } from './mapSceneSettings'

// The developed plates as real geometry (phase 4 of
// docs/design/hex-world-view.md): a flat hexagon at each tile's canonical
// height, plus a skirt on every edge down to whatever it meets — the small
// step against a developed neighbour, the embankment against wilderness.
//
// Deliberately its own mesh rather than a modification of the terrain: the
// grid IS the image of civilisation, so developed ground is a different
// surface with different rules, not a shader trick over the organic one.
//
// FRAMES, the thing that made the first version invisible: hexGrid reports a
// tile in its PRINCIPAL copy, x ∈ [0, worldWidth), while the terrain meshes
// come from CreateGround and are CENTRED on the origin, x ∈ [−W/2, +W/2]. A
// plate developed anywhere in the negative half of the map was therefore built
// a whole world period away from the ground it belongs to — measured at
// exactly +20 / +10 world units, i.e. off screen (2026-08-14).
//
// So every plate is placed in the wrap copy NEAREST an anchor (the camera
// focus): toroidal delta from the anchor, added to the anchor. The mesh itself
// stays at the origin. Rebuilding when the anchor moves far enough is the
// caller's job — the choice of copy only changes on that scale.

export interface HexPlateLayer {
  // Rebuild from the current plate set, placing every plate in the wrap copy
  // nearest (anchorX, anchorZ) — pass the camera focus. Cheap enough to call
  // on every change at debug scale (tens of plates); a settlement-sized set
  // would want the dirty-tile treatment instead.
  rebuild(anchorX: number, anchorZ: number): void
  // Whether the anchor has drifted far enough that a plate could now belong
  // to a different wrap copy — the caller's cue to rebuild.
  needsRebuildFor(anchorX: number, anchorZ: number): boolean
  // Where this tile's plate is ACTUALLY drawn, in scene coordinates, or null
  // when it carries no plate. For the geometry diagnostic: it answers "is the
  // plate where the ray hit?" without reading vertex buffers.
  drawnCenterOf(tile: HexId): { x: number; z: number } | null
  readonly mesh: Mesh
  setEnabled(enabled: boolean): void
  dispose(): void
}

export interface HexPlateLayerOptions {
  scene: Scene
  plates: HexPlates
  // The truth terrain surface (world Y), for where the wilderness skirts end.
  terrainAt: (x: number, z: number) => number
  // A hair of lift so a plate laid exactly on the ground does not z-fight the
  // terrain mesh it sits on.
  lift?: number
}

// A developed tile has to be legible as developed, and on the ground that may
// actually be developed HEIGHT cannot carry that: gentle land is what passes
// the grade, and a 300 m tile of it spans about 0.2 m from its lowest sample
// to its highest (measured 2026-08-14). A plate levelling 0.2 m is invisible
// by construction, whatever height it is given — the first cut tinted the top
// near-white and produced exactly nothing to see.
//
// So the signal is SURFACE, not relief: worked earth against wild green, with
// a darker rim where the plate meets what it displaced. Height still does the
// work where there is any — a terraced hillside — but it cannot be the only
// thing that says "someone lives here".
const TOP_TINT = new Color3(0.78, 0.69, 0.47)
const SKIRT_TINT = new Color3(0.45, 0.38, 0.28)

export function createHexPlateLayer(options: HexPlateLayerOptions): HexPlateLayer {
  const { scene, plates, terrainAt } = options
  const lift = options.lift ?? 0

  const material = new StandardMaterial('hexPlateMaterial', scene)
  material.specularColor = new Color3(0, 0, 0)
  material.diffuseColor = new Color3(1, 1, 1)

  const mesh = new Mesh('hexPlates', scene)
  mesh.material = material
  mesh.isPickable = false // the ground under it stays the pick target

  let anchor = { x: 0, z: 0 }

  function rebuild(anchorX: number, anchorZ: number): void {
    anchor = { x: anchorX, z: anchorZ }
    const positions: number[] = []
    const normals: number[] = []
    const uvs: number[] = []
    const colors: number[] = []
    const indices: number[] = []

    const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, tint: Color3): number => {
      const index = positions.length / 3
      positions.push(x, y, z)
      normals.push(nx, ny, nz)
      const { u, v } = hexUvFromWorld(x, z)
      uvs.push(u, v)
      colors.push(tint.r, tint.g, tint.b, 1)
      return index
    }

    for (const plate of plates.all()) {
      const principal = hexCenter(plate.id)
      // The copy of this tile nearest the anchor — see the frame note above.
      const toPlate = wrappedHexDelta(anchor, principal)
      const shiftX = anchor.x + toPlate.x - principal.x
      const shiftZ = anchor.z + toPlate.z - principal.z
      const center = { x: principal.x + shiftX, z: principal.z + shiftZ }
      const corners = hexCorners(plate.id).map((c) => ({ x: c.x + shiftX, z: c.z + shiftZ }))
      const y = plate.height + lift

      // Top: a triangle fan around the centre, flat by construction — this is
      // the whole point of developing a tile.
      const centreIndex = push(center.x, y, center.z, 0, 1, 0, TOP_TINT)
      const rim: number[] = []
      for (const corner of corners) rim.push(push(corner.x, y, corner.z, 0, 1, 0, TOP_TINT))
      for (let k = 0; k < 6; k++) indices.push(centreIndex, rim[k], rim[(k + 1) % 6])

      // Skirts. Wound so the outward face is the visible one. The seams come
      // back in the principal frame like everything else, so they take the
      // same shift as the top face.
      for (const raw of plateSeams(plate, plates, terrainAt)) {
        const seam = {
          ...raw,
          a: { x: raw.a.x + shiftX, z: raw.a.z + shiftZ },
          b: { x: raw.b.x + shiftX, z: raw.b.z + shiftZ },
        }
        const bottom = seam.bottom - lift
        const ex = seam.b.x - seam.a.x
        const ez = seam.b.z - seam.a.z
        // Outward normal of a horizontal edge, in the XZ plane.
        const len = Math.hypot(ex, ez) || 1
        const nx = ez / len
        const nz = -ex / len
        const at = push(seam.a.x, y, seam.a.z, nx, 0, nz, SKIRT_TINT)
        const bt = push(seam.b.x, y, seam.b.z, nx, 0, nz, SKIRT_TINT)
        const ab = push(seam.a.x, bottom, seam.a.z, nx, 0, nz, SKIRT_TINT)
        const bb = push(seam.b.x, bottom, seam.b.z, nx, 0, nz, SKIRT_TINT)
        indices.push(at, ab, bt, bt, ab, bb)
      }
    }

    const data = new VertexData()
    data.positions = Float32Array.from(positions)
    data.normals = Float32Array.from(normals)
    data.uvs = Float32Array.from(uvs)
    data.colors = Float32Array.from(colors)
    data.indices = indices
    data.applyToMesh(mesh, true)
    mesh.setEnabled(positions.length > 0)
  }

  return {
    rebuild,
    needsRebuildFor(anchorX: number, anchorZ: number): boolean {
      const d = wrappedHexDelta(anchor, { x: anchorX, z: anchorZ })
      // A quarter period: far enough that the nearest copy of some plate could
      // have changed, rare enough that flying around does not rebuild per
      // frame.
      return Math.abs(d.x) > MAP_WORLD_WIDTH / 4 || Math.abs(d.z) > MAP_WORLD_HEIGHT / 4
    },
    drawnCenterOf(tile: HexId): { x: number; z: number } | null {
      if (!plates.isDeveloped(tile)) return null
      const principal = hexCenter(tile)
      const toPlate = wrappedHexDelta(anchor, principal)
      return { x: anchor.x + toPlate.x, z: anchor.z + toPlate.z }
    },
    mesh,
    setEnabled(enabled: boolean): void {
      mesh.setEnabled(enabled && mesh.getTotalVertices() > 0)
    },
    dispose(): void {
      mesh.dispose()
      material.dispose()
    },
  }
}
