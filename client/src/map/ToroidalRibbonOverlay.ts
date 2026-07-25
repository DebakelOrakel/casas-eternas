import { Color3, Mesh, StandardMaterial, VertexData } from '@babylonjs/core'
import type { InstancedMesh, Scene } from '@babylonjs/core'

export interface ToroidalRibbonOverlayOptions {
  scene: Scene
  worldWidth: number
  worldHeight: number
  // Full-res texel space the input points are expressed in (same as the map
  // texture), so pixel coords map onto the plane exactly.
  textureWidth: number
  textureHeight: number
  color?: Color3
  // Height above the map plane (world units) so ribbons sit on top, not z-fight.
  yOffset?: number
  // Multiplies the per-point pixel width when converting to world width.
  widthScale?: number
}

export interface ToroidalRibbonOverlay {
  // Rebuild the ribbons from connected polylines: `points` is [x, y, widthPx, …]
  // in texel coords, all polylines concatenated; `lengths` gives each polyline's
  // point count. Each polyline is Catmull-Rom smoothed into a continuous curved
  // ribbon. Empty clears the mesh.
  setPolylines(points: Float32Array, lengths: Uint32Array): void
  // Called every frame with the map's recenter block center (hook into
  // ToroidalMapView's onRecenter) so the ribbons tile + wrap in lockstep.
  recenter(centerX: number, centerZ: number): void
  setEnabled(enabled: boolean): void
  dispose(): void
}

// Catmull-Rom subdivisions per input span — turns the D8 cell-to-cell staircase
// into a smooth curve.
const SUBDIV = 5

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

// Draws connected polylines (rivers, later lake outlines / paths) as real
// scene-space ribbon geometry over the toroidal map — NOT baked into the map
// texture — so they stay crisp at any zoom and carry per-point width for free.
// Each polyline is Catmull-Rom smoothed and turned into one continuous ribbon
// (perpendicular-offset strip with mitered joints), so rivers read as flowing
// curves, not straight segments. Mirrors ToroidalMapView: one real mesh + 8
// instances forming a 3x3 wrap block, repositioned each frame on the tile under
// the camera. Unlit emissive (a flat data overlay). Reusable by any full-surface
// map screen.
export function createToroidalRibbonOverlay(options: ToroidalRibbonOverlayOptions): ToroidalRibbonOverlay {
  const { scene, worldWidth, worldHeight, textureWidth, textureHeight } = options
  const color = options.color ?? new Color3(45 / 255, 95 / 255, 175 / 255)
  const yOffset = options.yOffset ?? 0.03
  const widthScale = options.widthScale ?? 1.5
  // Uniform texel→world scale (the map keeps texture and world aspect equal).
  const s = worldWidth / textureWidth

  const material = new StandardMaterial('ribbonOverlayMat', scene)
  material.emissiveColor = color
  material.disableLighting = true
  material.backFaceCulling = false

  let base: Mesh | null = null
  let instances: InstancedMesh[] = []
  let enabled = true

  function disposeMeshes(): void {
    for (const inst of instances) inst.dispose()
    instances = []
    if (base) {
      base.dispose()
      base = null
    }
  }

  const worldX = (px: number): number => (px - textureWidth / 2) * s
  const worldZ = (py: number): number => (py - textureHeight / 2) * s

  // Smooth one polyline (control points in world x/z + half-width) into a dense
  // point list, then emit a continuous ribbon (two offset vertices per point,
  // two triangles per span) into the growing geometry arrays.
  function appendRibbon(cxArr: number[], czArr: number[], hwArr: number[], positions: number[], indices: number[]): void {
    const m = cxArr.length
    if (m < 2) return
    const sx: number[] = []
    const sz: number[] = []
    const sh: number[] = []
    for (let j = 0; j < m - 1; j++) {
      const j0 = Math.max(0, j - 1)
      const j2 = Math.min(m - 1, j + 1)
      const j3 = Math.min(m - 1, j + 2)
      for (let k = 0; k < SUBDIV; k++) {
        const t = k / SUBDIV
        sx.push(catmullRom(cxArr[j0], cxArr[j], cxArr[j2], cxArr[j3], t))
        sz.push(catmullRom(czArr[j0], czArr[j], czArr[j2], czArr[j3], t))
        sh.push(Math.max(0, catmullRom(hwArr[j0], hwArr[j], hwArr[j2], hwArr[j3], t)))
      }
    }
    sx.push(cxArr[m - 1]); sz.push(czArr[m - 1]); sh.push(hwArr[m - 1])

    const count = sx.length
    const vertBase = positions.length / 3
    for (let i = 0; i < count; i++) {
      const prev = Math.max(0, i - 1)
      const next = Math.min(count - 1, i + 1)
      let tx = sx[next] - sx[prev]
      let tz = sz[next] - sz[prev]
      const len = Math.hypot(tx, tz)
      if (len < 1e-9) {
        tx = 1
        tz = 0
      } else {
        tx /= len
        tz /= len
      }
      // Normal in the XZ plane.
      const nx = -tz * sh[i]
      const nz = tx * sh[i]
      positions.push(sx[i] + nx, yOffset, sz[i] + nz)
      positions.push(sx[i] - nx, yOffset, sz[i] - nz)
    }
    for (let i = 0; i < count - 1; i++) {
      const a = vertBase + i * 2
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2)
    }
  }

  function setPolylines(points: Float32Array, lengths: Uint32Array): void {
    disposeMeshes()
    if (lengths.length === 0) return

    const positions: number[] = []
    const indices: number[] = []
    let off = 0
    for (let p = 0; p < lengths.length; p++) {
      const m = lengths[p]
      const cx: number[] = []
      const cz: number[] = []
      const hw: number[] = []
      for (let i = 0; i < m; i++) {
        const b = (off + i) * 3
        cx.push(worldX(points[b]))
        cz.push(worldZ(points[b + 1]))
        hw.push((points[b + 2] * s * widthScale) / 2)
      }
      off += m
      appendRibbon(cx, cz, hw, positions, indices)
    }
    if (positions.length === 0) return

    base = new Mesh('riverRibbon', scene)
    const data = new VertexData()
    data.positions = Float32Array.from(positions)
    data.indices = Uint32Array.from(indices)
    data.applyToMesh(base)
    base.material = material
    base.isPickable = false
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        const inst = base.createInstance(`riverRibbon_${dx}_${dz}`)
        inst.isPickable = false
        instances.push(inst)
      }
    }
    base.setEnabled(enabled)
    for (const inst of instances) inst.setEnabled(enabled)
  }

  function recenter(centerX: number, centerZ: number): void {
    if (!base) return
    base.position.set(centerX, 0, centerZ)
    let i = 0
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        instances[i]?.position.set(centerX + dx * worldWidth, 0, centerZ + dz * worldHeight)
        i++
      }
    }
  }

  return {
    setPolylines,
    recenter,
    setEnabled(next: boolean): void {
      enabled = next
      base?.setEnabled(next)
      for (const inst of instances) inst.setEnabled(next)
    },
    dispose(): void {
      disposeMeshes()
      material.dispose()
    },
  }
}
