import { COVER_BY_BIOME } from './cover'
import { mulberry32 } from '../core/rng'
import { dischargeToM3s } from './hydrology'
import type { RiverGraph, RiverReach } from './riverGraph'

// THE RIVER COURSE — what a river does below the channel head, on the graph
// (ADAPTIVE_MESH_PLAN.md phase 3, decision 14 of adaptive-mesh.md). Three
// tiers, per reach and deterministic from (reach, seed):
//
//   1. PATTERN FROM PHYSICS, free. Straight, meandering, braided or
//      anastomosing follows from slope, discharge, sediment load and bank
//      strength (the biome as vegetation): the Leopold–Wolman discriminant
//      S = 0.0125·Q^-0.44 separates braided from single-thread, weak banks
//      braid earlier; low slope and strong banks with a load anastomose;
//      a gentle single thread long enough to bend meanders; the rest is
//      straight. The generator decides nothing — it draws what the reach
//      says.
//   2. MEANDERS AS A SIMULATION, not a template. The reach's centreline as
//      a curve, migrated by the bend model of Ikeda, Parker and Sawai
//      (1981): the near-bank velocity excess is the curvature convolved
//      upstream over the bend-response length λ, and the bank migrates
//      outward in proportion; a cutoff when two loops touch, the cut loop
//      an oxbow. One-dimensional, thousands of points per reach, a fixed
//      step count. What emerges: meander belts whose width scales with
//      discharge, oxbows, the migration envelope as the floodplain.
//   3. BRAIDS AND DELTA CHANNELS STAY DRAWN, with a physical core: the
//      channel count and width come from load and slope; the pattern is a
//      rule (weaving sub-channels; distributaries fanning from an apex,
//      with a lobe age so one is active and the others abandoned).
//
// Every length is in metres inside; the output lines are texel coordinates
// of the graph's raster, built in an UNWRAPPED frame across the torus seam
// and wrapped at the end (the ribbon builder splits where a point jumps).
// Reaches too narrow for the raster to show (width under cellM / 50) and
// lake reaches get no course; the ribbon then draws the cell path.

export type RiverPattern = 'straight' | 'meandering' | 'braided' | 'anastomosing'

export interface RiverCourse {
  reach: number
  pattern: RiverPattern
  dischargeM3s: number
  // Bankfull hydraulic geometry: width and depth from discharge.
  widthM: number
  depthM: number
  slope: number
  // 0..1, from the bank biome: vegetation holds banks.
  bankStrength: number
  // Channel centrelines in texel coordinates [x, y, …]: one for a single
  // thread, several for braids and anastomosing threads; a delta's
  // distributaries are the LAST lobeAges.length lines.
  lines: Float32Array[]
  // Per line, the channel width relative to widthM (sub-channels narrower).
  lineWidth: number[]
  // Course length over the reach's straight-line (cell path) length.
  sinuosity: number
  // The migration envelope's width, metres (meandering only).
  beltWidthM: number
  // Abandoned loops, texel coordinates, meandering only.
  oxbows: Float32Array[]
  // Lobe age per distributary (0 = active), empty without a delta.
  lobeAges: number[]
}

export interface RiverCourseOptions {
  cellM: number
  seed: number
  // Reaches narrower than this get no course (default cellM / 50: a belt of
  // ten widths is then a fifth of a cell, the least the ribbon can show).
  minWidthM?: number
  // Point budget per reach (default 4000) and migration steps (default 120).
  maxPointsPerReach?: number
  steps?: number
}

// Bank strength by biome: what vegetation does to a bank's erodibility. A
// first table, by eye; the cover factor of phase 5 replaces it.
// The bank strength IS the cover (surface/cover.ts, phase 5.5): one table
// for the banks, the fluvial erodibility and the critical slope.
const BANK_STRENGTH = COVER_BY_BIOME

// Hydraulic geometry (Leopold & Maddock): width and depth as powers of the
// bankfull discharge, metres for m³/s.
export function channelWidthM(dischargeM3s: number): number {
  return 3.5 * Math.sqrt(Math.max(0, dischargeM3s))
}
function channelDepthM(dischargeM3s: number): number {
  return 0.3 * Math.pow(Math.max(0, dischargeM3s), 0.4)
}

// The Leopold–Wolman braiding threshold slope for a discharge.
function braidingSlope(dischargeM3s: number): number {
  return 0.0125 * Math.pow(Math.max(1e-3, dischargeM3s), -0.44)
}

export function classifyPattern(dischargeM3s: number, slope: number, lengthM: number, widthM: number, bankStrength: number, sedimentM3: number): RiverPattern {
  const sc = braidingSlope(dischargeM3s)
  if (slope > sc * (0.6 + 0.8 * bankStrength)) return 'braided'
  if (slope < 2e-4 && bankStrength >= 0.7 && sedimentM3 > 0) return 'anastomosing'
  if (slope < 0.005 && lengthM >= 12 * widthM) return 'meandering'
  return 'straight'
}

// The reach's cell path as a polyline in metres, unwrapped across the seams.
function unwrappedPath(graph: RiverGraph, reach: RiverReach, cellM: number): Float64Array {
  const { width, height } = graph
  const out = new Float64Array(reach.cellCount * 2)
  let px = 0
  let py = 0
  for (let k = 0; k < reach.cellCount; k++) {
    let x = graph.cellX[reach.cellStart + k]
    let y = graph.cellY[reach.cellStart + k]
    if (k > 0) {
      // Follow the previous point across the seam instead of jumping back.
      const dx = x - px
      const dy = y - py
      if (dx > width / 2) x -= width
      else if (dx < -width / 2) x += width
      if (dy > height / 2) y -= height
      else if (dy < -height / 2) y += height
    }
    px = x
    py = y
    out[k * 2] = x * cellM
    out[k * 2 + 1] = y * cellM
  }
  return out
}

function pathLength(p: Float64Array, count: number): number {
  let length = 0
  for (let i = 1; i < count; i++) length += Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1])
  return length
}

// Resample a polyline at a uniform spacing, keeping both endpoints.
function resample(p: Float64Array, count: number, spacing: number): Float64Array {
  const total = pathLength(p, count)
  const n = Math.max(2, Math.round(total / spacing) + 1)
  const out = new Float64Array(n * 2)
  const step = total / (n - 1)
  let seg = 0
  let segStart = 0
  let segLen = Math.hypot(p[2] - p[0], p[3] - p[1])
  for (let i = 0; i < n; i++) {
    const s = Math.min(total, i * step)
    while (seg < count - 2 && s > segStart + segLen) {
      segStart += segLen
      seg++
      segLen = Math.hypot(p[seg * 2 + 2] - p[seg * 2], p[seg * 2 + 3] - p[seg * 2 + 1])
    }
    const t = segLen > 0 ? Math.min(1, Math.max(0, (s - segStart) / segLen)) : 0
    out[i * 2] = p[seg * 2] + (p[seg * 2 + 2] - p[seg * 2]) * t
    out[i * 2 + 1] = p[seg * 2 + 1] + (p[seg * 2 + 3] - p[seg * 2 + 1]) * t
  }
  out[0] = p[0]
  out[1] = p[1]
  out[n * 2 - 2] = p[count * 2 - 2]
  out[n * 2 - 1] = p[count * 2 - 1]
  return out
}

// Distance from a point to a polyline (metres), nearest segment.
function distanceToPath(x: number, y: number, p: Float64Array, count: number): number {
  let best = Infinity
  for (let i = 0; i < count - 1; i++) {
    const ax = p[i * 2]
    const ay = p[i * 2 + 1]
    const bx = p[i * 2 + 2]
    const by = p[i * 2 + 3]
    const vx = bx - ax
    const vy = by - ay
    const len2 = vx * vx + vy * vy
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / len2)) : 0
    const d = Math.hypot(x - (ax + vx * t), y - (ay + vy * t))
    if (d < best) best = d
  }
  return best
}

const toTexels = (p: Float64Array, count: number, cellM: number, width: number, height: number): Float32Array => {
  const out = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    const x = p[i * 2] / cellM
    const y = p[i * 2 + 1] / cellM
    out[i * 2] = ((x % width) + width) % width
    out[i * 2 + 1] = ((y % height) + height) % height
  }
  return out
}

// The bend model. Returns the migrated centreline, the envelope width and
// the oxbows, all in metres in the unwrapped frame.
function meander(base: Float64Array, baseCount: number, widthM: number, bankStrength: number, steps: number, spacing: number, rng: () => number): { line: Float64Array; count: number; beltWidthM: number; oxbows: Float64Array[] } {
  const lambda = 5 * widthM
  // Bank erodibility per step, in widths of migration per unit of
  // dimensionless curvature excess: weak banks migrate faster. Sized so a
  // seeded bend grows to a belt of several widths over the step count
  // (measured 2026-09-22: at 0.03 the belt stayed under half a width).
  const rate = 0.5 * (1.2 - bankStrength)
  let p = resample(base, baseCount, spacing)
  let n = p.length / 2
  // A seeded initial perturbation: without one a straight reach never
  // bends (the model amplifies curvature, it does not create it).
  {
    const phase = rng() * Math.PI * 2
    const wavelength = 10 * widthM
    for (let i = 1; i < n - 1; i++) {
      const tx = p[i * 2 + 2] - p[i * 2 - 2]
      const ty = p[i * 2 + 3] - p[i * 2 - 1]
      const tl = Math.hypot(tx, ty) || 1
      const s = i * spacing
      const taper = Math.min(1, s / (3 * widthM), (n - 1 - i) * spacing / (3 * widthM))
      const a = (0.3 * Math.sin((2 * Math.PI * s) / wavelength + phase) + 0.05 * (rng() - 0.5)) * widthM * taper
      p[i * 2] += (-ty / tl) * a
      p[i * 2 + 1] += (tx / tl) * a
    }
  }
  const oxbows: Float64Array[] = []
  const kernelLength = Math.ceil((4 * lambda) / spacing)
  const kernel = new Float64Array(kernelLength)
  for (let k = 0; k < kernelLength; k++) kernel[k] = Math.exp((-k * spacing) / lambda) * (spacing / lambda)
  const minSeparation = Math.ceil((3 * widthM) / spacing) + 2
  // A neck joins two points at most a loop's perimeter apart along the
  // line — a window of forty widths bounds the search, which is otherwise
  // quadratic in the reach.
  const maxSeparation = Math.ceil((40 * widthM) / spacing)
  for (let step = 0; step < steps; step++) {
    n = p.length / 2
    if (n < 4) break
    // Signed curvature from the turn between consecutive tangents.
    const kappa = new Float64Array(n)
    for (let i = 1; i < n - 1; i++) {
      const ax = p[i * 2] - p[i * 2 - 2]
      const ay = p[i * 2 + 1] - p[i * 2 - 1]
      const bx = p[i * 2 + 2] - p[i * 2]
      const by = p[i * 2 + 3] - p[i * 2 + 1]
      const cross = ax * by - ay * bx
      const dot = ax * bx + ay * by
      kappa[i] = Math.atan2(cross, dot) / spacing
    }
    // Near-bank velocity excess: curvature convolved upstream over λ.
    const next = new Float64Array(p.length)
    next.set(p)
    for (let i = 1; i < n - 1; i++) {
      let u = 0
      for (let k = 0; k < kernelLength && i - k >= 0; k++) u += kappa[i - k] * kernel[k]
      const tx = p[i * 2 + 2] - p[i * 2 - 2]
      const ty = p[i * 2 + 3] - p[i * 2 - 1]
      const tl = Math.hypot(tx, ty) || 1
      const taper = Math.min(1, (i * spacing) / (2 * lambda), ((n - 1 - i) * spacing) / (2 * lambda))
      // Outward: a left turn (positive curvature) migrates to the right bank.
      let d = -rate * widthM * u * widthM * taper
      if (d > 0.5 * widthM) d = 0.5 * widthM
      else if (d < -0.5 * widthM) d = -0.5 * widthM
      next[i * 2] += (-ty / tl) * d
      next[i * 2 + 1] += (tx / tl) * d
    }
    p = next
    // Neck cutoff: two non-adjacent points within a channel width and a bit.
    let cut = false
    for (let i = 1; i < n - 1 && !cut; i++) {
      const jEnd = Math.min(n - 1, i + maxSeparation)
      for (let j = i + minSeparation; j < jEnd; j++) {
        if (Math.hypot(p[i * 2] - p[j * 2], p[i * 2 + 1] - p[j * 2 + 1]) < 1.5 * widthM) {
          if (oxbows.length < 32) oxbows.push(p.slice(i * 2, (j + 1) * 2))
          const kept = new Float64Array((n - (j - i - 1)) * 2)
          kept.set(p.subarray(0, (i + 1) * 2), 0)
          kept.set(p.subarray(j * 2), (i + 1) * 2)
          p = kept
          cut = true
          break
        }
      }
    }
    p = resample(p, p.length / 2, spacing)
  }
  // The envelope: how far the final line lies from where it began, twice
  // the mean offset (the belt straddles the original course).
  let offsetSum = 0
  let offsetSamples = 0
  {
    const count = p.length / 2
    for (let i = 1; i < count - 1; i += 2) {
      offsetSum += distanceToPath(p[i * 2], p[i * 2 + 1], base, baseCount)
      offsetSamples++
    }
  }
  const beltWidthM = offsetSamples > 0 ? 2 * (offsetSum / offsetSamples) : 0
  return { line: p, count: p.length / 2, beltWidthM, oxbows }
}

// Several threads weaving about the base line: the braided and the
// anastomosing patterns, drawn from a channel count and a wavelength.
function weave(base: Float64Array, baseCount: number, widthM: number, count: number, amplitude: number, wavelength: number, spacing: number, rng: () => number): Float64Array[] {
  const p = resample(base, baseCount, spacing)
  const n = p.length / 2
  const lines: Float64Array[] = []
  for (let k = 0; k < count; k++) {
    const phase = rng() * Math.PI * 2
    const phase2 = rng() * Math.PI * 2
    const centre = (k - (count - 1) / 2) * amplitude
    const line = new Float64Array(p.length)
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1)
      const i1 = Math.min(n - 1, i + 1)
      const tx = p[i1 * 2] - p[i0 * 2]
      const ty = p[i1 * 2 + 1] - p[i0 * 2 + 1]
      const tl = Math.hypot(tx, ty) || 1
      const s = i * spacing
      const taper = Math.min(1, s / (4 * widthM), ((n - 1 - i) * spacing) / (4 * widthM))
      const offset = (centre * (0.6 + 0.4 * Math.sin((2 * Math.PI * s) / wavelength + phase)) + 0.4 * widthM * Math.sin((2 * Math.PI * s) / (wavelength / 3) + phase2)) * taper
      line[i * 2] = p[i * 2] + (-ty / tl) * offset
      line[i * 2 + 1] = p[i * 2 + 1] + (tx / tl) * offset
    }
    lines.push(line)
  }
  return lines
}

export function computeRiverCourses(graph: RiverGraph, options: RiverCourseOptions): RiverCourse[] {
  const { cellM, seed } = options
  const minWidthM = options.minWidthM ?? cellM / 50
  const maxPoints = options.maxPointsPerReach ?? 4000
  const steps = options.steps ?? 120
  const courses: RiverCourse[] = []
  for (const reach of graph.reaches) {
    if (reach.kind !== 'river' || reach.cellCount < 3) continue
    const dischargeM3s = dischargeToM3s(reach.dischargeOut, cellM)
    const widthM = channelWidthM(dischargeM3s)
    if (widthM < minWidthM) continue
    const base = unwrappedPath(graph, reach, cellM)
    const lengthM = pathLength(base, reach.cellCount)
    if (lengthM <= 0) continue
    const bankStrength = BANK_STRENGTH[reach.bank] ?? 0.5
    const slope = Math.max(0, reach.slope)
    const pattern = classifyPattern(dischargeM3s, slope, lengthM, widthM, bankStrength, reach.sedimentM3)
    const rng = mulberry32((seed ^ Math.imul(reach.id + 1, 0x9e3779b1)) >>> 0)
    const spacing = Math.max(widthM / 2, lengthM / maxPoints)
    const lines: Float32Array[] = []
    const lineWidth: number[] = []
    const oxbows: Float32Array[] = []
    let sinuosity = 1
    let beltWidthM = 0
    if (pattern === 'meandering') {
      const m = meander(base, reach.cellCount, widthM, bankStrength, steps, spacing, rng)
      lines.push(toTexels(m.line, m.count, cellM, graph.width, graph.height))
      lineWidth.push(1)
      sinuosity = pathLength(m.line, m.count) / lengthM
      beltWidthM = m.beltWidthM
      for (const o of m.oxbows) oxbows.push(toTexels(o, o.length / 2, cellM, graph.width, graph.height))
    } else if (pattern === 'braided' || pattern === 'anastomosing') {
      const braided = pattern === 'braided'
      const sc = braidingSlope(dischargeM3s)
      const count = braided ? Math.min(5, Math.max(2, 2 + Math.round(Math.log2(Math.max(1, slope / sc))))) : 2 + (rng() < 0.4 ? 1 : 0)
      const threads = weave(base, reach.cellCount, widthM, count, braided ? 1.6 * widthM : 2 * widthM, braided ? 8 * widthM : 25 * widthM, spacing, rng)
      for (const t of threads) {
        lines.push(toTexels(t, t.length / 2, cellM, graph.width, graph.height))
        lineWidth.push(1 / Math.sqrt(count))
      }
    } else {
      const p = resample(base, reach.cellCount, spacing)
      lines.push(toTexels(p, p.length / 2, cellM, graph.width, graph.height))
      lineWidth.push(1)
    }
    // A delta where a sediment-laden, flat reach meets the open sea: two to
    // four distributaries fan from an apex a few tens of widths upstream;
    // one lobe is active, the others abandoned in order of age.
    const lobeAges: number[] = []
    const mouth = graph.nodes[reach.to]
    if (mouth.kind === 'mouth' && mouth.body === -1 && reach.sedimentM3 > 0 && slope < 1e-3 && lengthM > 40 * widthM && lines.length > 0) {
      const mainIdx = pattern === 'meandering' || pattern === 'straight' ? 0 : -1
      const apexBack = Math.min(0.4 * lengthM, 30 * widthM)
      const p = resample(base, reach.cellCount, spacing)
      const n = p.length / 2
      const apexIndex = Math.max(1, n - 1 - Math.round(apexBack / spacing))
      const ax = p[apexIndex * 2]
      const ay = p[apexIndex * 2 + 1]
      const mx = p[n * 2 - 2]
      const my = p[n * 2 - 1]
      const dx = mx - ax
      const dy = my - ay
      const dl = Math.hypot(dx, dy) || 1
      const count = 2 + (reach.sedimentM3 > 1e9 ? 1 : 0) + (rng() < 0.5 ? 1 : 0)
      const active = Math.floor(rng() * count)
      for (let k = 0; k < count; k++) {
        const side = (k - (count - 1) / 2) * 3 * widthM
        const ex = mx + (-dy / dl) * side + (dx / dl) * 2 * widthM
        const ey = my + (dx / dl) * side + (dy / dl) * 2 * widthM
        const line = new Float64Array(6)
        line[0] = ax
        line[1] = ay
        line[2] = (ax + ex) / 2 + (-dy / dl) * side * 0.35
        line[3] = (ay + ey) / 2 + (dx / dl) * side * 0.35
        line[4] = ex
        line[5] = ey
        const age = (k - active + count) % count
        lines.push(toTexels(line, 3, cellM, graph.width, graph.height))
        lineWidth.push(age === 0 ? 0.8 : 0.35 / age)
        lobeAges.push(age)
      }
      // The main thread ends at the apex; the distributaries carry on.
      if (mainIdx === 0) {
        const main = lines[0]
        const keep = Math.max(2, Math.min(main.length / 2, apexIndex + 1))
        lines[0] = main.slice(0, keep * 2)
      }
    }
    courses.push({ reach: reach.id, pattern, dischargeM3s, widthM, depthM: channelDepthM(dischargeM3s), slope, bankStrength, lines, lineWidth, sinuosity, beltWidthM, oxbows, lobeAges })
  }
  return courses
}
