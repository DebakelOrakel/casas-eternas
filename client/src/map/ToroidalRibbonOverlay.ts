import { Color3, Mesh, StandardMaterial, VertexData } from '@babylonjs/core'
import type { InstancedMesh, Scene } from '@babylonjs/core'
import type { ElevationSurface } from './elevationSurface'

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
  // Height above the TERRAIN when draped onto a relief surface (see
  // setHeightSurface). Much smaller than yOffset on purpose: the flat
  // offset is invisible from straight above, but a tilted relief view
  // renders height literally — the default here is ~150 m of clearance,
  // enough to stay above the mesh-vs-sampler disagreement, small enough
  // not to read as floating.
  drapedYOffset?: number
  // Multiplies the per-point pixel width when converting to world width.
  widthScale?: number
  // Moving-average passes applied to each polyline's control points (and
  // their widths) BEFORE the Catmull-Rom spline. Zero keeps the input
  // exactly.
  //
  // Why this exists: the spline INTERPOLATES — it passes through every
  // control point — so it turns a D8 staircase into a smooth curve without
  // removing the staircase's zigzag, which then reads as a wobble. At the
  // source grid's own resolution that is invisible; on an amplified grid
  // there are several times as many direction changes (and discharge
  // wiggles, hence width wiggles) per unit of world distance, and it
  // becomes a visible snake. Averaging first removes the zigzag; the spline
  // then only has to round what is left.
  smoothingPasses?: number
}

export interface ToroidalRibbonOverlay {
  // Rebuild the ribbons from connected polylines: `points` is [x, y, widthPx, …]
  // in texel coords, all polylines concatenated; `lengths` gives each polyline's
  // point count. Each polyline is Catmull-Rom smoothed into a continuous curved
  // ribbon. Empty clears the mesh.
  setPolylines(points: Float32Array, lengths: Uint32Array): void
  // Drape the ribbons onto a terrain surface (the SAME decimated surface the
  // relief mesh displaces by — see elevationSurface.ts for why it must be the
  // same one), or back onto the flat plane with null. Rebuilds the current
  // geometry in place.
  setHeightSurface(surface: ElevationSurface | null): void
  // Rescale the per-point widths: each width is multiplied by `factor`, then
  // capped at `maxWidthPx` (both in texel units, before widthScale). The
  // input widths are CARTOGRAPHIC — sized to read as lines at map zoom —
  // which translated literally at relief zoom makes a 3-texel line a 23 km
  // flood (and the mitered joints of the D8 staircase degenerate into
  // sawteeth once offsets exceed segment lengths). The caller narrows the
  // profile in step with its zoom/LOD levels. Rebuilds on actual change.
  setWidthProfile(factor: number, maxWidthPx: number): void
  // Vertical exaggeration, matching whatever the terrain the ribbons are
  // draped on uses (see ToroidalMapView.setHeightScale) — without it the
  // rivers would stay at true height while the ground rose around them, and
  // vanish inside it.
  setHeightScale(scale: number): void
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
  const drapedYOffset = options.drapedYOffset ?? 0.0002
  const widthScale = options.widthScale ?? 1.5
  const smoothingPasses = options.smoothingPasses ?? 0
  // Uniform texel→world scale (the map keeps texture and world aspect equal).
  const s = worldWidth / textureWidth

  const material = new StandardMaterial('ribbonOverlayMat', scene)
  material.emissiveColor = color
  material.disableLighting = true
  material.backFaceCulling = false

  let base: Mesh | null = null
  let instances: InstancedMesh[] = []
  let enabled = true
  let heightSurface: ElevationSurface | null = null
  let widthFactor = 1
  let maxWidthPx = Number.POSITIVE_INFINITY
  // Kept so setHeightSurface/setWidthProfile can rebuild the geometry
  // without the caller having to re-supply the polylines.
  let lastPoints: Float32Array | null = null
  let lastLengths: Uint32Array | null = null
  let heightScale = 1

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
  // One 3-point moving-average pass over a control-point series, endpoints
  // held fixed so a river keeps its source and its mouth exactly.
  function smoothSeries(values: number[]): void {
    const n = values.length
    if (n < 3) return
    let prev = values[0]
    for (let i = 1; i < n - 1; i++) {
      const current = values[i]
      values[i] = (prev + current + values[i + 1]) / 3
      prev = current
    }
  }

  function appendRibbon(cxArr: number[], czArr: number[], hwArr: number[], positions: number[], indices: number[]): void {
    const m = cxArr.length
    if (m < 2) return
    for (let pass = 0; pass < smoothingPasses; pass++) {
      smoothSeries(cxArr)
      smoothSeries(czArr)
      smoothSeries(hwArr)
    }
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
      // Draped: terrain height at this point (world x/z back to the map's
      // normalized UV space, the surface's own convention) + clearance.
      // Flat: the constant hover offset, as before.
      const y = heightSurface
        ? heightSurface.heightAtUV((sx[i] / s + textureWidth / 2) / textureWidth, (sz[i] / s + textureHeight / 2) / textureHeight) + drapedYOffset
        : yOffset
      positions.push(sx[i] + nx, y, sz[i] + nz)
      positions.push(sx[i] - nx, y, sz[i] - nz)
    }
    for (let i = 0; i < count - 1; i++) {
      const a = vertBase + i * 2
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2)
    }
  }

  function setPolylines(points: Float32Array, lengths: Uint32Array): void {
    lastPoints = points
    lastLengths = lengths
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
        hw.push((Math.min(points[b + 2] * widthFactor, maxWidthPx) * s * widthScale) / 2)
      }
      off += m
      appendRibbon(cx, cz, hw, positions, indices)
    }
    if (positions.length === 0) return

    base = new Mesh('riverRibbon', scene)
    base.scaling.y = heightScale
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
        inst.scaling.y = heightScale
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
    setHeightSurface(surface: ElevationSurface | null): void {
      if (surface === heightSurface) return
      heightSurface = surface
      if (lastPoints && lastLengths) setPolylines(lastPoints, lastLengths)
    },
    setHeightScale(scale: number): void {
      if (scale === heightScale) return
      heightScale = scale
      if (base) base.scaling.y = scale
      for (const inst of instances) inst.scaling.y = scale
    },
    setWidthProfile(factor: number, nextMaxWidthPx: number): void {
      if (factor === widthFactor && nextMaxWidthPx === maxWidthPx) return
      widthFactor = factor
      maxWidthPx = nextMaxWidthPx
      if (lastPoints && lastLengths) setPolylines(lastPoints, lastLengths)
    },
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
