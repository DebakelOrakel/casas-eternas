import { Color3, Mesh, StandardMaterial, VertexBuffer, VertexData } from '@babylonjs/core'
import type { InstancedMesh, Scene } from '@babylonjs/core'
import type { ElevationSurface } from './elevationSurface'
import { UNITS_PER_METER } from './mapSceneSettings'
import { RibbonWidthMaterialPlugin } from './ribbonWidthMaterialPlugin'
import { catmullRom, INK_BINS, presenceThreshold, relativeWidth, RIVER_RGB, riverCartoPx, riverWidthMetres, SUBDIV } from './riverWidth'

export interface ToroidalRibbonOverlayOptions {
  scene: Scene
  worldWidth: number
  worldHeight: number
  // Full-res texel space the input points are expressed in (same as the map
  // texture), so pixel coords map onto the plane exactly.
  textureWidth: number
  textureHeight: number
  // The visible world width at the camera focus (the rig's getViewWidth).
  // Sampled per frame by the width shader; divided by the render width it is
  // the world-units-per-pixel the cartographic floor is expressed against.
  getViewWidth: () => number
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
  // Which rendering group the ribbons belong to. They must share the NEAR
  // GROUND's group: that group's depth buffer is cleared before it draws, so
  // ribbons left behind in the terrain's group would simply be painted over
  // by the ground they are draped on. See ToroidalMapView.NEAR_RENDERING_GROUP
  // for what the split buys and what it costs.
  renderingGroupId?: number
  // Whether the presence rule (the zoom-Q ink budget, riverWidth.ts) applies. Default
  // true — rivers thin with distance. Off for line work whose stored width is
  // not a discharge: lake shorelines carry the thinnest pen at every point,
  // and the budget would cull all of them at far zoom rather than the least
  // of them.
  presenceRule?: boolean
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
  // ribbon. The width component is the hydrology's cartographic width
  // (RIVER_MIN_WIDTH..RIVER_MAX_WIDTH, √ of relative discharge) — how the
  // ribbon actually widens per zoom is the width rule (riverWidth.ts). Empty clears the
  // mesh. `regimes` is one byte per polyline (the engine's RiverRegime::code):
  // an intermittent river draws dashed, an ephemeral one dotted; absent, all
  // are perennial.
  setPolylines(points: Float32Array, lengths: Uint32Array, regimes?: Uint8Array): void
  // Drape the ribbons onto a terrain surface (the SAME decimated surface the
  // relief mesh displaces by — see elevationSurface.ts for why it must be the
  // same one), or back onto the flat plane with null. Rebuilds the current
  // geometry in place.
  setHeightSurface(surface: ElevationSurface | null): void
  // Vertical exaggeration, matching whatever the terrain the ribbons are
  // draped on uses (see ToroidalMapView.setHeightScale) — without it the
  // rivers would stay at true height while the ground rose around them, and
  // vanish inside it.
  setHeightScale(scale: number): void
  // The ribbons' colour. Per-frame safe: writes the shared material's
  // emissive, no rebuild — the worldmap lerps ink → water along the descent.
  setColor(color: Color3): void
  // Called every frame with the map's recenter block center (hook into
  // ToroidalMapView's onRecenter) so the ribbons tile + wrap in lockstep.
  recenter(centerX: number, centerZ: number): void
  setEnabled(enabled: boolean): void
  dispose(): void
}

// Draws connected polylines (rivers, later lake outlines / paths) as real
// scene-space ribbon geometry over the toroidal map — NOT baked into the map
// texture — so they stay crisp at any zoom and carry per-point width for free.
// Each polyline is Catmull-Rom smoothed and turned into one continuous ribbon
// (perpendicular-offset strip, widened in the vertex shader per the width rule
// in riverWidth.ts), so rivers read as flowing curves, not straight segments. Mirrors
// ToroidalMapView: one real mesh + 8 instances forming a 3x3 wrap block,
// repositioned each frame on the tile under the camera. Unlit emissive (a flat
// data overlay). Reusable by any full-surface map screen.
export function createToroidalRibbonOverlay(options: ToroidalRibbonOverlayOptions): ToroidalRibbonOverlay {
  const { scene, worldWidth, worldHeight, textureWidth, textureHeight, getViewWidth } = options
  const color = options.color ?? new Color3(RIVER_RGB[0] / 255, RIVER_RGB[1] / 255, RIVER_RGB[2] / 255)
  const yOffset = options.yOffset ?? 0.03
  const drapedYOffset = options.drapedYOffset ?? 0.0002
  const renderingGroupId = options.renderingGroupId ?? 0
  const smoothingPasses = options.smoothingPasses ?? 0
  // Uniform texel→world scale (the map keeps texture and world aspect equal).
  const s = worldWidth / textureWidth

  // Drawn centerline length per relative-discharge bin, in world-widths —
  // the distribution the presence rule inverts. Measured on the raw control
  // points; the spline conserves length to well under a bin's worth.
  let inkByBin: Float64Array | null = null

  // The presence threshold for this frame (riverWidth.ts, the presence rule).
  function minRelForView(): number {
    return inkByBin ? presenceThreshold(inkByBin, getViewWidth() / worldWidth) : 0
  }

  const material = new StandardMaterial('ribbonOverlayMat', scene)
  material.emissiveColor = color
  material.disableLighting = true
  material.backFaceCulling = false
  new RibbonWidthMaterialPlugin(material, () => getViewWidth() / scene.getEngine().getRenderWidth(), minRelForView)

  let base: Mesh | null = null
  let instances: InstancedMesh[] = []
  let enabled = true
  let heightSurface: ElevationSurface | null = null
  // Kept so setHeightSurface can rebuild the geometry without the caller
  // having to re-supply the polylines.
  let lastPoints: Float32Array | null = null
  let lastLengths: Uint32Array | null = null
  let lastRegimes: Uint8Array | undefined
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

  // Smooth one polyline (control points in world x/z + cartographic width)
  // into a dense point list, then emit a continuous ribbon: two CENTERLINE
  // vertices per point carrying opposite offset directions and the two
  // half-widths, two triangles per span. The actual widening happens in the
  // vertex shader.
  function appendRibbon(cxArr: number[], czArr: number[], wArr: number[], regime: number, positions: number[], dirs: number[], widths: number[], styles: number[], indices: number[]): void {
    const m = cxArr.length
    if (m < 2) return
    for (let pass = 0; pass < smoothingPasses; pass++) {
      smoothSeries(cxArr)
      smoothSeries(czArr)
      smoothSeries(wArr)
    }
    const sx: number[] = []
    const sz: number[] = []
    const sw: number[] = []
    for (let j = 0; j < m - 1; j++) {
      const j0 = Math.max(0, j - 1)
      const j2 = Math.min(m - 1, j + 1)
      const j3 = Math.min(m - 1, j + 2)
      for (let k = 0; k < SUBDIV; k++) {
        const t = k / SUBDIV
        sx.push(catmullRom(cxArr[j0], cxArr[j], cxArr[j2], cxArr[j3], t))
        sz.push(catmullRom(czArr[j0], czArr[j], czArr[j2], czArr[j3], t))
        sw.push(catmullRom(wArr[j0], wArr[j], wArr[j2], wArr[j3], t))
      }
    }
    sx.push(cxArr[m - 1]); sz.push(czArr[m - 1]); sw.push(wArr[m - 1])

    const count = sx.length
    const vertBase = positions.length / 3
    // Arc length along the centreline in world units — the dash pattern's
    // coordinate (ribbonWidthMaterialPlugin), per vertex like the widths.
    let arc = 0
    for (let i = 0; i < count; i++) {
      const prev = Math.max(0, i - 1)
      const next = Math.min(count - 1, i + 1)
      if (i > 0) arc += Math.hypot(sx[i] - sx[i - 1], sz[i] - sz[i - 1])
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
      // Unit normal in the XZ plane — the shader's offset direction.
      const nx = -tz
      const nz = tx
      const r = relativeWidth(sw[i])
      const physHalf = (riverWidthMetres(sw[i]) * UNITS_PER_METER) / 2
      const cartoHalfPx = riverCartoPx(sw[i]) / 2
      // r rides along as the third component — the presence rule's per-vertex
      // side (the shader compares it against the frame's threshold).
      // Draped: terrain height at this point (world x/z back to the map's
      // normalized UV space, the surface's own convention) + clearance.
      // Flat: the constant hover offset, as before.
      const y = heightSurface
        ? heightSurface.heightAtUV((sx[i] / s + textureWidth / 2) / textureWidth, (sz[i] / s + textureHeight / 2) / textureHeight) + drapedYOffset
        : yOffset
      positions.push(sx[i], y, sz[i])
      dirs.push(nx, nz)
      widths.push(physHalf, cartoHalfPx, r)
      styles.push(arc, regime)
      positions.push(sx[i], y, sz[i])
      dirs.push(-nx, -nz)
      widths.push(physHalf, cartoHalfPx, r)
      styles.push(arc, regime)
    }
    for (let i = 0; i < count - 1; i++) {
      const a = vertBase + i * 2
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2)
    }
  }

  function setPolylines(points: Float32Array, lengths: Uint32Array, regimes?: Uint8Array): void {
    lastPoints = points
    lastLengths = lengths
    lastRegimes = regimes
    disposeMeshes()
    inkByBin = null
    if (lengths.length === 0) return

    const positions: number[] = []
    const dirs: number[] = []
    const widths: number[] = []
    const styles: number[] = []
    const indices: number[] = []
    const ink = new Float64Array(INK_BINS)
    let off = 0
    for (let p = 0; p < lengths.length; p++) {
      const m = lengths[p]
      const cx: number[] = []
      const cz: number[] = []
      const w: number[] = []
      for (let i = 0; i < m; i++) {
        const b = (off + i) * 3
        cx.push(worldX(points[b]))
        cz.push(worldZ(points[b + 1]))
        w.push(points[b + 2])
        if (i > 0) {
          // Segment length in world-widths (texel space over the texture's
          // width — the texel→world scale is uniform), binned by the
          // segment's mean relative discharge.
          const a = (off + i - 1) * 3
          const segLen = Math.hypot(points[b] - points[a], points[b + 1] - points[a + 1]) / textureWidth
          const r = relativeWidth((points[a + 2] + points[b + 2]) / 2)
          ink[Math.min(INK_BINS - 1, Math.floor(r * INK_BINS))] += segLen
        }
      }
      off += m
      appendRibbon(cx, cz, w, regimes?.[p] ?? 0, positions, dirs, widths, styles, indices)
    }
    if (positions.length === 0) return
    if (options.presenceRule !== false) inkByBin = ink

    base = new Mesh('riverRibbon', scene)
    base.scaling.y = heightScale
    const data = new VertexData()
    data.positions = Float32Array.from(positions)
    data.indices = Uint32Array.from(indices)
    data.applyToMesh(base)
    const engine = scene.getEngine()
    base.setVerticesBuffer(new VertexBuffer(engine, Float32Array.from(dirs), 'ribbonDir', { size: 2 }))
    base.setVerticesBuffer(new VertexBuffer(engine, Float32Array.from(widths), 'ribbonWidths', { size: 3 }))
    base.setVerticesBuffer(new VertexBuffer(engine, Float32Array.from(styles), 'ribbonStyle', { size: 2 }))
    base.material = material
    base.isPickable = false
    base.renderingGroupId = renderingGroupId
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        const inst = base.createInstance(`riverRibbon_${dx}_${dz}`)
        inst.isPickable = false
        inst.renderingGroupId = renderingGroupId
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
      if (lastPoints && lastLengths) setPolylines(lastPoints, lastLengths, lastRegimes)
    },
    setHeightScale(scale: number): void {
      if (scale === heightScale) return
      heightScale = scale
      if (base) base.scaling.y = scale
      for (const inst of instances) inst.scaling.y = scale
    },
    setColor(next: Color3): void {
      material.emissiveColor.copyFrom(next)
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
