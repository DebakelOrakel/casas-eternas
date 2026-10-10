import { catmullRom, INK_BINS, relativeWidth, riverCartoPx, riverWidthMetres, SUBDIV } from './riverWidth'
import { globeFrameOfChart, type Vec3 } from './symbolPlacement'

// THE GLOBE'S RIVER RIBBONS (sphereView.ts, WorldRivers): the hydrology's
// polylines in chart texels, as ribbon geometry on the sphere. Pure
// arithmetic, no scene, so a script can check it (scripts/globeWater.mjs).
//
// The same ribbon as the flat map's (ToroidalRibbonOverlay.ts): a
// Catmull-Rom curve through the control points, two centreline vertices per
// curve point with opposite offset directions, the width rule's two
// half-widths and the relative discharge per vertex (riverWidth.ts), the arc
// length and the regime for the dashes; the vertex shader widens it
// (RibbonWidthMaterialPlugin, globe form). Two things differ:
//
// - THE CURVE RUNS IN 3D. The control points go to unit vectors first, and
//   the spline runs on those, each curve point normalised back onto the
//   sphere. So a span between two points is a great-circle arc (a normalised
//   chord), and there is no seam and no pole in the arithmetic: a step from
//   u = 0.999 to u = 0.001 is the short step it is on the globe, never a
//   line round the world, and a step across a pole goes over the pole.
//   A span is cut into at least SUBDIV pieces, more where it is longer than
//   SEGMENT_ANGLE, so the ribbon follows the curve instead of a chord.
// - A STEP LONGER THAN BREAK_ANGLE breaks the polyline: no river course
//   makes such a step, it is a jump in the data, and drawing it would lay a
//   line across the globe.
//
// Units: the globe's (radius 1). The physical half-width is metres over the
// globe's radius in metres, so a river is as wide on the globe as on the
// flat map at the same discharge. The ink (the presence rule's length per
// discharge bin) is in world-widths, as on the flat map: length on the
// sphere over its equator.

// The longest piece of a span, radians: about 0.6 of a chart texel at the
// equator of a 2048-texel chart. A chord of it lies 5e-7 radii under the
// arc.
export const SEGMENT_ANGLE = 0.002
// The longest step between two control points that is drawn, radians
// (22.5°). Steps between neighbouring cells are three orders smaller.
export const BREAK_ANGLE = Math.PI / 8

export interface GlobeRibbonGeometry {
  // xyz: the centreline, at `lift` radii.
  positions: Float32Array
  // xyz: the radial direction, for the light.
  normals: Float32Array
  // xyz: unit, in the surface, across the river — the shader's offset.
  dirs: Float32Array
  // The physical half-width (globe units), the cartographic half-width
  // (pixels), the relative discharge.
  widths: Float32Array
  // The arc length along the centreline (globe units) and the regime.
  styles: Float32Array
  indices: Uint32Array
  // Drawn length per relative-discharge bin, world-widths.
  ink: Float64Array
}

const angleBetween = (a: Vec3, b: Vec3): number => {
  const cx = a[1] * b[2] - a[2] * b[1]
  const cy = a[2] * b[0] - a[0] * b[2]
  const cz = a[0] * b[1] - a[1] * b[0]
  return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2])
}

// `points` is [x, y, widthPx, …] in chart texels, `lengths` each polyline's
// point count, `regimes` one byte per polyline (hydrology.RIVER_REGIME_CODE).
// Null when nothing is drawn.
export function buildGlobeRibbons(
  points: Float32Array,
  lengths: Uint32Array,
  regimes: Uint8Array | undefined,
  textureWidth: number,
  textureHeight: number,
  radiusMetres: number,
  lift: number,
): GlobeRibbonGeometry | null {
  const positions: number[] = []
  const normals: number[] = []
  const dirs: number[] = []
  const widths: number[] = []
  const styles: number[] = []
  const indices: number[] = []
  const ink = new Float64Array(INK_BINS)

  // One run of control points with no break in it, into the buffers.
  const appendRun = (cs: Vec3[], ws: number[], regime: number): void => {
    const m = cs.length
    if (m < 2) return
    const sp: Vec3[] = []
    const sw: number[] = []
    for (let j = 0; j < m - 1; j++) {
      const c0 = cs[Math.max(0, j - 1)]
      const c1 = cs[j]
      const c2 = cs[j + 1]
      const c3 = cs[Math.min(m - 1, j + 2)]
      const w0 = ws[Math.max(0, j - 1)]
      const w3 = ws[Math.min(m - 1, j + 2)]
      const pieces = Math.max(SUBDIV, Math.ceil(angleBetween(c1, c2) / SEGMENT_ANGLE))
      for (let k = 0; k < pieces; k++) {
        const t = k / pieces
        const x = catmullRom(c0[0], c1[0], c2[0], c3[0], t)
        const y = catmullRom(c0[1], c1[1], c2[1], c3[1], t)
        const z = catmullRom(c0[2], c1[2], c2[2], c3[2], t)
        const n = Math.hypot(x, y, z) || 1
        sp.push([x / n, y / n, z / n])
        sw.push(catmullRom(w0, ws[j], ws[j + 1], w3, t))
      }
    }
    sp.push(cs[m - 1])
    sw.push(ws[m - 1])

    const count = sp.length
    const vertBase = positions.length / 3
    let arc = 0
    for (let i = 0; i < count; i++) {
      const p = sp[i]
      const prev = sp[Math.max(0, i - 1)]
      const next = sp[Math.min(count - 1, i + 1)]
      if (i > 0) arc += angleBetween(sp[i - 1], p) * lift
      // Across the river: the normal × the tangent, in the surface.
      const tx = next[0] - prev[0]
      const ty = next[1] - prev[1]
      const tz = next[2] - prev[2]
      let ax = p[1] * tz - p[2] * ty
      let ay = p[2] * tx - p[0] * tz
      let az = p[0] * ty - p[1] * tx
      let length = Math.hypot(ax, ay, az)
      if (length < 1e-12) {
        // No tangent (a run of equal points): any direction in the surface.
        const ref: Vec3 = Math.abs(p[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
        ax = p[1] * ref[2] - p[2] * ref[1]
        ay = p[2] * ref[0] - p[0] * ref[2]
        az = p[0] * ref[1] - p[1] * ref[0]
        length = Math.hypot(ax, ay, az)
      }
      ax /= length
      ay /= length
      az /= length
      const r = relativeWidth(sw[i])
      const physHalf = riverWidthMetres(sw[i]) / 2 / radiusMetres
      const cartoHalfPx = riverCartoPx(sw[i]) / 2
      for (const side of [1, -1]) {
        positions.push(p[0] * lift, p[1] * lift, p[2] * lift)
        normals.push(p[0], p[1], p[2])
        dirs.push(side * ax, side * ay, side * az)
        widths.push(physHalf, cartoHalfPx, r)
        styles.push(arc, regime)
      }
    }
    for (let i = 0; i < count - 1; i++) {
      const a = vertBase + i * 2
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2)
    }
  }

  let off = 0
  for (let p = 0; p < lengths.length; p++) {
    const m = lengths[p]
    const regime = regimes?.[p] ?? 0
    let cs: Vec3[] = []
    let ws: number[] = []
    for (let i = 0; i < m; i++) {
      const b = (off + i) * 3
      const c = globeFrameOfChart({ u: points[b] / textureWidth, v: points[b + 1] / textureHeight })
      if (cs.length > 0) {
        const step = angleBetween(cs[cs.length - 1], c)
        if (step > BREAK_ANGLE) {
          appendRun(cs, ws, regime)
          cs = []
          ws = []
        } else {
          // The step's length in world-widths, binned by its mean
          // relative discharge (ToroidalRibbonOverlay, the same binning).
          const a = b - 3
          const rel = relativeWidth((points[a + 2] + points[b + 2]) / 2)
          ink[Math.min(INK_BINS - 1, Math.floor(rel * INK_BINS))] += step / (2 * Math.PI)
        }
      }
      cs.push(c)
      ws.push(points[b + 2])
    }
    appendRun(cs, ws, regime)
    off += m
  }
  if (positions.length === 0) return null
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    dirs: Float32Array.from(dirs),
    widths: Float32Array.from(widths),
    styles: Float32Array.from(styles),
    indices: Uint32Array.from(indices),
    ink,
  }
}
