// Check of WHERE A SYMBOL LIES (map/symbolPlacement.ts) — the arithmetic the
// two world views place their symbols and names with.
//
//   node scripts/symbolPlacement.mjs
//
// Not one of the four harnesses: they guard the generator and the save, and
// this is a view's geometry. It is fast (well under a second) and reads the
// same functions the views run, plus Babylon's own ground and sphere vertex
// data for the two charts' conventions, so a convention that changes under
// the views shows here.
//
// Float64 output buffers: the views write Float32, whose 0.4 m on a unit
// globe would drown the 1 m steps the angles are measured with.
//
// What it says:
//  1. Babylon's ground and sphere carry the chart as the views assume: a
//     vertex's UV is the chart point the view's chart function gives for its
//     position. (A texel (u · W, v · H) of a layer is shown where the UV is
//     (u, v): the layers are uploaded top row first, unflipped.)
//  2. A symbol's centre is the scene point of its chart point: round trip
//     through the view's own inverse, at the seam and next to the poles.
//  3. On the globe a symbol is ROUND: its points at a distance s along right
//     and along up are s from the centre on the sphere, and at 90°, at 0°,
//     60°, 85° and 89.9° — where a circle painted into the chart is 1 / cos φ
//     tall.
//  4. No picture is mirrored: right, up and the normal turn as the screen's
//     right, up and the line to the viewer do (left-handed: (r × u) · n < 0).
//  5. A turned symbol's x axis runs along its direction ON THE SURFACE, the
//     generator's local frame (Domain.delta: east and south in true
//     lengths, not a texel's cos φ shape); a readable one never points left
//     (reads left to right, north up).
//  7. A picture on the globe holds together at any size: every quad's chord
//     stays over the globe's faces, up to a picture a whole globe long. (A
//     name 3 rad long in 32 quads sank under the globe between its vertices
//     and showed as one strip per quad, 2026-10-11.)
//  8. The name layout (generator/render/raftLabelLayout.ts) on the sphere:
//     a continent at 70° spread east–west gets its centre on the globe's
//     centroid, an east–west axis and its true length; on the torus the
//     wrapped sum it always had.
//  9. The wind's and the currents' marks (map/vectorMarks.ts): on the torus
//     the same pieces of the same flow lines as the painted marks (count,
//     ends, chord direction) — compared with a copy of the painting's
//     cutting kept here; on the sphere evenly spread in true lengths (the
//     nearest neighbour about as far at 89° as at the equator, one mark at
//     most near a pole), and each placed mark pointing along the field's
//     true direction there, at the seam and next to the poles too.
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const P = await server.ssrLoadModule('/src/map/symbolPlacement.ts')
const D = await server.ssrLoadModule('/src/generator/core/domain.ts')
const RL = await server.ssrLoadModule('/src/generator/render/raftLabelLayout.ts')
const FL = await server.ssrLoadModule('/src/map/flowLines.ts')
const VM = await server.ssrLoadModule('/src/map/vectorMarks.ts')
const { CreateGroundVertexData } = await import(`${CLIENT}/node_modules/@babylonjs/core/Meshes/Builders/groundBuilder.pure.js`)
const { CreateSphereVertexData } = await import(`${CLIENT}/node_modules/@babylonjs/core/Meshes/Builders/sphereBuilder.pure.js`)

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok    ${name}${detail ? `  ${detail}` : ''}`)
  else { failures++; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`) }
}
const wrapDiff = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d) }
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const norm = (a) => Math.hypot(a[0], a[1], a[2])

// The generator's chart, 2048 × 1024 texels, at a scale of the check's own
// (any metres per texel will do; the sphere's is 9 766 m, DEC-0035 fork 6).
const W = 2048
const H = 1024
const MPT = 40_000_000 / W
const RADIUS_METRES = (MPT * W) / (2 * Math.PI)
const FLAT = { width: 20, height: 10 }
const UNITS_PER_METRE = FLAT.width / (MPT * W)

// --- 1. Babylon's conventions ----------------------------------------------
console.log('1. chart conventions (Babylon vertex data)')
{
  const g = CreateGroundVertexData({ width: FLAT.width, height: FLAT.height, subdivisions: 8 })
  let worst = 0
  for (let i = 0; i < g.uvs.length / 2; i++) {
    const c = P.flatChartOfScene(FLAT, g.positions[i * 3], g.positions[i * 3 + 2])
    worst = Math.max(worst, wrapDiff(c.u, g.uvs[i * 2]), wrapDiff(c.v, g.uvs[i * 2 + 1]))
  }
  check('ground: uv = flatChartOfScene(x, z)', worst < 1e-6, `worst ${worst.toExponential(1)}`)
  const s = CreateSphereVertexData({ diameter: 2, segments: 32 })
  worst = 0
  for (let i = 0; i < s.uvs.length / 2; i++) {
    const p = [s.positions[i * 3], s.positions[i * 3 + 1], s.positions[i * 3 + 2]]
    const c = P.globeChartOfFrame(p)
    const atPole = Math.hypot(p[0], p[2]) < 1e-6
    worst = Math.max(worst, wrapDiff(c.v, s.uvs[i * 2 + 1]), atPole ? 0 : wrapDiff(c.u, s.uvs[i * 2]))
  }
  check('sphere: uv = globeChartOfFrame(position)', worst < 1e-5, `worst ${worst.toExponential(1)}`)
}

// --- 2. round trip ----------------------------------------------------------
console.log('2. symbol centre ↔ chart point')
const points = []
for (const u of [0, 0.25, 0.5, 0.75, 0.99999, 1e-6]) for (const v of [0.0005, 0.02, 0.1, 0.3333, 0.5, 0.75, 0.98, 0.9995]) points.push({ u, v })
{
  let worstGlobe = 0
  let worstFlat = 0
  let worstFlatPlace = 0
  for (const at of points) {
    const g = P.globeSymbolFrame(at, undefined, false)
    const c = P.globeChartOfFrame(g.centre)
    worstGlobe = Math.max(worstGlobe, wrapDiff(c.u, at.u), Math.abs(c.v - at.v))
    const f = P.flatSymbolFrame(FLAT, at, 0, undefined, false)
    const cf = P.flatChartOfScene(FLAT, f.centre[0], f.centre[2])
    worstFlat = Math.max(worstFlat, wrapDiff(cf.u, at.u), wrapDiff(cf.v, at.v))
    // Where the texel (u · W, v · H) is displayed: the plane point whose UV
    // is (u, v), x = (u − ½)·width, z = (v − ½)·height (part 1).
    const tx = (((at.u * W) / W) % 1 - 0.5) * FLAT.width
    const tz = (((at.v * H) / H) % 1 - 0.5) * FLAT.height
    worstFlatPlace = Math.max(worstFlatPlace, Math.abs(f.centre[0] - tx), Math.abs(f.centre[2] - tz))
  }
  check('globe: chartOfFrame(centre) = (u, v), seam and poles', worstGlobe < 1e-9, `worst ${worstGlobe.toExponential(1)} over ${points.length} points`)
  check('flat: chartOfScene(centre) = (u, v)', worstFlat < 1e-9, `worst ${worstFlat.toExponential(1)}`)
  check('flat: centre is where texel (u·W, v·H) shows', worstFlatPlace < 1e-9, `worst ${worstFlatPlace.toExponential(1)} scene units`)
}

// --- 3. roundness on the globe ----------------------------------------------
console.log('3. roundness on the globe (s = 60 km, a hotspot disc is ~94 km across)')
{
  const s = 60_000
  const out = new Float64Array(3)
  const vertex = (frame, x, y) => { P.globeSymbolVertex(frame, x, y, RADIUS_METRES, 1, out, 0); return [out[0], out[1], out[2]] }
  const arc = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (norm(a) * norm(b))))) * RADIUS_METRES
  for (const latitude of [0, 60, 85, 89.9]) {
    const at = { u: 0.3, v: 0.5 - latitude / 180 }
    const frame = P.globeSymbolFrame(at, undefined, false)
    const east = arc(frame.centre, vertex(frame, s, 0))
    const north = arc(frame.centre, vertex(frame, 0, s))
    const diag = arc(frame.centre, vertex(frame, s * Math.SQRT1_2, s * Math.SQRT1_2))
    // The angle between the two axes where they leave the centre (a step
    // of 1 m: chords at s would meet at less than 90° by the curve alone).
    const e = sub(vertex(frame, 1, 0), frame.centre)
    const n = sub(vertex(frame, 0, 1), frame.centre)
    const angle = (Math.acos(dot(e, n) / (norm(e) * norm(n))) * 180) / Math.PI
    const painted = 1 / Math.cos((latitude * Math.PI) / 180)
    const ok = Math.abs(east / s - 1) < 1e-4 && Math.abs(north / s - 1) < 1e-4 && Math.abs(diag / s - 1) < 1e-4 && Math.abs(angle - 90) < 1e-3
    check(`${String(latitude).padStart(4)}°: east ${(east / 1000).toFixed(3)} km, north ${(north / 1000).toFixed(3)} km, diagonal ${(diag / 1000).toFixed(3)} km, ${angle.toFixed(4)}°`, ok, `(painted in the chart: ${painted.toFixed(2)}× as tall as wide)`)
  }
  // The centre sits on its chart point, the lift only raises it.
  const frame = P.globeSymbolFrame({ u: 0.6, v: 0.1 }, undefined, false)
  P.globeSymbolVertex(frame, 0, 0, RADIUS_METRES, 1.001, out, 0)
  check('lift raises along the normal only', Math.abs(norm([...out]) - 1.001) < 1e-6 && wrapDiff(P.globeChartOfFrame([...out]).u, 0.6) < 1e-6)
}

// --- 4. no mirror -------------------------------------------------------------
console.log('4. orientation (no mirror, upright)')
{
  let worstGlobe = -Infinity
  let worstFlat = -Infinity
  for (const at of points) {
    for (const angle of [undefined, 0, 1, 2.5, -2]) {
      for (const readable of [false, true]) {
        const g = P.globeSymbolFrame(at, angle, readable)
        worstGlobe = Math.max(worstGlobe, dot(cross(g.right, g.up), g.normal))
        const f = P.flatSymbolFrame(FLAT, at, 0, angle, readable)
        worstFlat = Math.max(worstFlat, dot(cross(f.right, f.up), f.normal))
      }
    }
  }
  check('globe: (right × up) · normal = −1', Math.abs(worstGlobe + 1) < 1e-6, `largest ${worstGlobe.toFixed(6)}`)
  check('flat:  (right × up) · normal = −1', Math.abs(worstFlat + 1) < 1e-6, `largest ${worstFlat.toFixed(6)}`)
  // Upright: up toward the north pole on the globe (+y of its frame there),
  // +z on the flat map (the grid's bottom, the screen's top).
  const g = P.globeSymbolFrame({ u: 0.1, v: 0.3 }, undefined, false)
  const towardPole = sub([0, 1, 0], g.centre)
  check('globe: upright points to the north pole', dot(g.up, towardPole) > 0 && Math.abs(dot(g.up, g.normal)) < 1e-12)
  const f = P.flatSymbolFrame(FLAT, { u: 0.1, v: 0.3 }, 0, undefined, false)
  check('flat: upright is +z (the view\'s top, north up)', f.up[2] === 1 && f.right[0] === 1)
}

// --- 5. turned symbols ----------------------------------------------------------
console.log('5. turned symbols follow their direction on the surface')
{
  const sphere = D.sphereDomain(W, H)
  const local = { x: 0, y: 0 }
  let worstGlobe = 0
  let worstFlat = 0
  let leftward = 0
  const out = new Float64Array(3)
  const eps = 50 // metres along the x axis
  for (const at of points.filter((p) => p.v > 0.01 && p.v < 0.99)) {
    for (const angle of [0, 0.4, 1.3, Math.PI / 2, 2.6, -1.1, Math.PI]) {
      for (const readable of [false, true]) {
        const g = P.globeSymbolFrame(at, angle, readable)
        P.globeSymbolVertex(g, eps, 0, RADIUS_METRES, 1, out, 0)
        const c = P.globeChartOfFrame([...out])
        // The step in the generator's own frame at the point: east, south.
        sphere.delta(c.u * W, c.v * H, at.u * W, at.v * H, local)
        const dx = local.x
        const dy = local.y
        // Parallel to the direction (or opposite, when turned readable).
        const sin = (dx * Math.sin(angle) - dy * Math.cos(angle)) / Math.hypot(dx, dy)
        const cos = (dx * Math.cos(angle) + dy * Math.sin(angle)) / Math.hypot(dx, dy)
        worstGlobe = Math.max(worstGlobe, Math.abs(sin), readable ? 0 : Math.max(0, -cos))
        // Readable: the x axis never points to the screen's left, north up.
        const screenRight = P.globeSymbolFrame(at, undefined, false).right
        if (readable && dot(g.right, screenRight) < -1e-9) leftward++
        const f = P.flatSymbolFrame(FLAT, at, 0, angle, readable)
        const fsin = f.right[0] * Math.sin(angle) - f.right[2] * Math.cos(angle)
        worstFlat = Math.max(worstFlat, Math.abs(fsin), readable ? 0 : Math.max(0, -(f.right[0] * Math.cos(angle) + f.right[2] * Math.sin(angle))))
        if (readable && f.right[0] < -1e-9) leftward++
      }
    }
  }
  check('globe: x axis along the direction in Domain.delta\'s frame', worstGlobe < 1e-4, `worst sine ${worstGlobe.toExponential(1)}`)
  check('flat:  x axis along the chart direction', worstFlat < 1e-9, `worst sine ${worstFlat.toExponential(1)}`)
  check('readable symbols never point left', leftward === 0, `${leftward} leftward`)
}

// --- the flat map's sizes -------------------------------------------------------
console.log('6. sizes on the flat map')
{
  const out = new Float64Array(3)
  const f = P.flatSymbolFrame(FLAT, { u: 0.4, v: 0.6 }, 0, 0.7, false)
  P.flatSymbolVertex(f, 9 * MPT, 0, UNITS_PER_METRE, out, 0)
  const texels = (Math.hypot(out[0] - f.centre[0], out[2] - f.centre[2]) / FLAT.width) * W
  check('9 texels of metres are 9 texels on the plane', Math.abs(texels - 9) < 1e-4, `${texels.toFixed(5)} texels`)
}

// --- 7. large pictures on the globe ---------------------------------------------
console.log('7. large pictures follow the globe (every chord over the faces)')
{
  const out = new Float64Array(3)
  // A face of the 96-segment globe lies up to 2.6e-4 radii inside the unit
  // sphere (scripts/globeWater.mjs); the chord's middle must stay outside
  // the unit sphere itself, the stricter bound.
  let lowest = Infinity
  let lowestAt = 0
  const frame = P.globeSymbolFrame({ u: 0.37, v: 0.85 }, 0.6, true)
  for (const radians of [0.05, 0.3, 1, 2, 3.2, 4.5, 2 * Math.PI]) {
    const width = radians * RADIUS_METRES
    const height = 0.05 * RADIUS_METRES
    const nx = P.globeSymbolSegments(width, RADIUS_METRES)
    const ny = P.globeSymbolSegments(height, RADIUS_METRES)
    const at = (i, j) => { P.globeSymbolVertex(frame, (i / nx - 0.5) * width, (0.5 - j / ny) * height, RADIUS_METRES, P.GLOBE_SYMBOL_LIFT, out, 0); return [out[0], out[1], out[2]] }
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = at(i, j)
        const b = at(i + 1, j)
        const mid = norm([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2])
        if (mid < lowest) { lowest = mid; lowestAt = radians }
      }
    }
  }
  check('the lowest chord middle of a picture up to 2π long is over the unit sphere', lowest > 1, `${lowest.toFixed(6)} radii (at ${lowestAt.toFixed(2)} rad)`)
}

// --- 8. the name layout on the sphere -----------------------------------------
console.log('8. the name layout measures on the globe')
{
  // Seven blobs along the parallel at 70° N, 8° of longitude apart, the
  // middle one the largest (the anchor) but not the centre: the row runs
  // further east than west. On the globe the centroid lies ON the 70°
  // parallel's middle meridian only for a symmetric row, so the expected
  // centre is the area-weighted mean of the unit vectors.
  const sphere = D.sphereDomain(W, H)
  const latitude = 70
  const y = (0.5 - latitude / 180) * H
  const longitudes = [-16, -8, 0, 8, 16, 24, 32]
  const blobs = longitudes.map((l, i) => ({ x: ((100 + l) / 360) * W, y, radius: i === 2 ? 30 : 24 }))
  const raft = { id: 1, name: 'Testland', blobs, noMergeUntilEpoch: 0 }
  const [label] = RL.computeRaftLabelPlacements([raft], sphere)
  const unit = (b) => { const lon = (b.x / W) * 2 * Math.PI; const th = (b.y / H) * Math.PI; return [Math.sin(th) * Math.cos(lon), Math.sin(th) * Math.sin(lon), Math.cos(th)] }
  const c = [0, 0, 0]
  for (const b of blobs) { const u = unit(b); const w = b.radius * b.radius; c[0] += u[0] * w; c[1] += u[1] * w; c[2] += u[2] * w }
  const miss = Math.sqrt(sphere.distanceSq(label.centerX, label.centerY, (Math.atan2(c[1], c[0]) / (2 * Math.PI)) * W, (Math.atan2(Math.hypot(c[0], c[1]), c[2]) / Math.PI) * H))
  // The log map from the anchor puts the centroid within a fraction of a
  // blob of the true one; adding the offset to the chart (the old code) put
  // it 9 units off here (its east offset not stretched by 1 / cos φ).
  check('centre on the globe\'s centroid of the blobs', miss < 3, `${miss.toFixed(2)} units off`)
  // The axis: the great circle through the end blobs, carried to the centre.
  const end = { x: 0, y: 0 }
  sphere.delta(blobs[6].x, blobs[6].y, label.centerX, label.centerY, end)
  const start = { x: 0, y: 0 }
  sphere.delta(blobs[0].x, blobs[0].y, label.centerX, label.centerY, start)
  const axis = Math.atan2(end.y - start.y, end.x - start.x)
  const turn = Math.abs(Math.sin(label.angle - axis))
  check('axis along the row on the globe', turn < 0.05, `sine of the miss ${turn.toFixed(3)} (angle ${((label.angle * 180) / Math.PI).toFixed(1)}°)`)
  // True length: the row's span on the globe plus the end blobs' radii.
  const span = Math.sqrt(sphere.distanceSq(blobs[0].x, blobs[0].y, blobs[6].x, blobs[6].y)) + 48
  check('along extent is the true length', Math.abs(label.alongExtent / span - 1) < 0.05, `${label.alongExtent.toFixed(1)} against ${span.toFixed(1)} units (a chart texel row: ${(((48 / 360) * W) + 48).toFixed(1)})`)
  // The torus: the wrapped sum, as before the sphere.
  const torus = D.torusDomain(W, H)
  const [flat] = RL.computeRaftLabelPlacements([raft], torus)
  const meanX = blobs.reduce((s, b) => s + b.x * b.radius * b.radius, 0) / blobs.reduce((s, b) => s + b.radius * b.radius, 0)
  check('torus: centre is the chart\'s weighted mean, angle 0', Math.abs(flat.centerX - meanX) < 1e-9 && Math.abs(flat.centerY - y) < 1e-9 && flat.angle === 0, `x ${flat.centerX} against ${meanX}, y ${flat.centerY}, angle ${flat.angle}`)
}

// --- 9. the wind's and the currents' marks --------------------------------------
console.log('9. vector marks (wind strokes, current arrows)')
{
  // The torus: a synthetic field with zonal bands and gyres (a stream
  // function's cells), traced as the screen traces the wind and the
  // currents.
  const TAU = 2 * Math.PI
  const sampler = (x, y) => {
    const a = (TAU * 3 * x) / W
    const b = (TAU * 2 * y) / H
    // ψ = sin a · sin b: u = ∂ψ/∂y, v = −∂ψ/∂x, plus a zonal band.
    return [Math.sin(a) * Math.cos(b) * 2 + 0.6 * Math.cos((TAU * y) / H), -Math.cos(a) * Math.sin(b) * 3]
  }
  const ref = 3
  const windLines = FL.traceFlowLines(sampler, { width: W, height: H, separation: 16, stopRatio: 0.5, step: 2, maxLength: 600, minSpeed: ref * 0.1, refSpeed: ref })
  const currentLines = FL.traceFlowLines(sampler, { width: W, height: H, separation: 52, stopRatio: 0.55, step: 4, maxLength: 1800, minSpeed: 0.1, refSpeed: ref })
  // The painting's cutting (map/flowLines.ts drawComets, drawArrowRibbons,
  // until 2026-10-11), copied: the reference the marks must equal.
  const hash = (i) => { let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296 }
  const chunks = (points, length, gap, phase) => {
    const out = []; let current = []; let along = phase % (length + gap)
    for (let i = 0; i < points.length; i++) {
      if (i > 0) along += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
      if (along % (length + gap) < length) current.push(points[i])
      else if (current.length > 0) { out.push(current); current = [] }
    }
    if (current.length > 0) out.push(current)
    return out
  }
  const oldComets = []
  windLines.forEach((line, li) => { for (const piece of chunks(line.points, 26, 14, hash(li) * 40)) if (piece.length >= 3) oldComets.push(piece) })
  const oldArrows = []
  currentLines.forEach((line, li) => {
    const pts = line.loop ? [...line.points, line.points[0], line.points[1]] : line.points
    const gap = line.loop ? 0 : 26
    for (const piece of chunks(pts, 64, gap, line.loop ? 0 : hash(li) * (64 + gap))) if (piece.length >= 4) oldArrows.push(piece)
  })
  const wrap = (f) => ((f % 1) + 1) % 1
  const compare = (name, marks, old) => {
    let worstPlace = 0
    let worstAngle = 0
    const n = Math.min(marks.length, old.length)
    for (let i = 0; i < n; i++) {
      const a = old[i][0]
      const b = old[i][old[i].length - 1]
      worstPlace = Math.max(worstPlace, wrapDiff(marks[i].at.u, wrap((a.x + b.x) / 2 / W)) * W, wrapDiff(marks[i].at.v, wrap((a.y + b.y) / 2 / H)) * H)
      worstAngle = Math.max(worstAngle, Math.abs(Math.sin(marks[i].angle - Math.atan2(b.y - a.y, b.x - a.x))), Math.abs(marks[i].length - Math.hypot(b.x - a.x, b.y - a.y)))
    }
    check(`${name}: as many marks as painted pieces`, marks.length === old.length, `${marks.length} against ${old.length}`)
    check(`${name}: each mark spans its painted piece (centre, chord direction and length)`, worstPlace < 1e-6 && worstAngle < 1e-9, `worst ${worstPlace.toExponential(1)} texels, ${worstAngle.toExponential(1)}`)
  }
  const windMarks = VM.flowLineMarks(windLines, { width: W, height: H, length: 26, gap: 14, closeLoops: false, minPoints: 3, speedCap: Infinity })
  const currentMarks = VM.flowLineMarks(currentLines, { width: W, height: H, length: 64, gap: 26, closeLoops: true, minPoints: 4, speedCap: 1 })
  compare('torus wind', windMarks, oldComets)
  compare('torus currents', currentMarks, oldArrows)
  // How far a straight mark turns from what the painting drew: the arrow's
  // head (tip less the last 11.7 texels) and the field at the mark's centre.
  const heads = []
  oldArrows.forEach((piece, i) => {
    let along = 0; let cut = piece.length - 1
    while (cut > 1 && along < 4.5 * 2.6) { along += Math.hypot(piece[cut].x - piece[cut - 1].x, piece[cut].y - piece[cut - 1].y); cut-- }
    const tip = piece[piece.length - 1]
    heads.push(Math.abs(Math.sin(currentMarks[i].angle - Math.atan2(tip.y - piece[cut].y, tip.x - piece[cut].x))))
  })
  const fieldSine = (marks) => {
    const s = marks.map((m) => { const [u, v] = sampler(m.at.u * W, m.at.v * H); return Math.abs(Math.sin(m.angle - Math.atan2(v, u))) }).sort((a, b) => a - b)
    return `median ${s[s.length >> 1].toFixed(3)}, p95 ${s[Math.floor(s.length * 0.95)].toFixed(3)}`
  }
  heads.sort((a, b) => a - b)
  console.log(`        (a straight arrow against the painted head: sine median ${heads[heads.length >> 1].toFixed(3)}, p95 ${heads[Math.floor(heads.length * 0.95)].toFixed(3)}, worst ${heads[heads.length - 1].toFixed(3)} (tight gyres); against the field at the centre: wind ${fieldSine(windMarks)}, currents ${fieldSine(currentMarks)})`)

  // The sphere: the sample points' spacing in true lengths.
  const km = (a, b) => {
    const p = P.globeFrameOfChart(a)
    const q = P.globeFrameOfChart(b)
    return (Math.atan2(norm(cross(p, q)), dot(p, q)) * RADIUS_METRES) / 1000
  }
  for (const spacing of [26, 80]) {
    const pts = VM.globeSamplePoints(W, spacing)
    const bands = new Map()
    for (const a of pts) {
      let nearest = Infinity
      for (const b of pts) if (a !== b) nearest = Math.min(nearest, km(a, b))
      const lat = Math.abs(90 - a.v * 180)
      const band = lat >= 89.999 ? 90 : lat >= 85 ? 85 : Math.floor(lat / 15) * 15
      const e = bands.get(band) ?? { sum: 0, n: 0, min: Infinity, max: 0 }
      e.sum += nearest; e.n++; e.min = Math.min(e.min, nearest); e.max = Math.max(e.max, nearest)
      bands.set(band, e)
    }
    const nominal = (spacing * MPT) / 1000
    const means = [...bands.entries()].sort((a, b) => a[0] - b[0]).filter(([band]) => band < 90)
    const lo = Math.min(...means.map(([, e]) => e.sum / e.n))
    const hi = Math.max(...means.map(([, e]) => e.sum / e.n))
    const allMin = Math.min(...means.map(([, e]) => e.min))
    const allMax = Math.max(...means.map(([, e]) => e.max))
    const detail = means.map(([band, e]) => `${band}°: ${(e.sum / e.n).toFixed(0)}`).join(', ')
    check(`globe spacing ${spacing} texels (${nominal.toFixed(0)} km, ${pts.length} points): nearest neighbour by latitude, equator to 89.99°`, hi / lo < 1.15 && allMin > 0.75 * nominal && allMax < 1.35 * nominal, `band means ${detail} km; spread ${(hi / lo).toFixed(3)}×, single ${allMin.toFixed(0)}–${allMax.toFixed(0)} km`)
    const nearPole = (v) => pts.filter((p) => km(p, { u: 0, v }) < (0.5 * spacing * MPT) / 1000).length
    check(`globe spacing ${spacing}: at most one mark within ${((0.5 * spacing * MPT) / 1000).toFixed(0)} km of each pole`, nearPole(0) <= 1 && nearPole(1) <= 1, `north ${nearPole(0)}, south ${nearPole(1)}`)
  }

  // The sphere: a field on the climate grid (256 × 128, east and south in
  // each cell's frame) from rotations about tilted axes — continuous
  // everywhere, not zero at the geographic poles — read into marks and
  // placed. The placed x axis against the field's true direction.
  const RX = 256
  const RY = 128
  // 3D in the domain's frame (x, y, z = cos θ); Babylon's is (x, z, −y).
  const axes = [[Math.sin(0.5), 0, Math.cos(0.5)], [0.3, -0.8, 0.2]]
  const truth = (theta, lambda) => {
    const p = [Math.sin(theta) * Math.cos(lambda), Math.sin(theta) * Math.sin(lambda), Math.cos(theta)]
    const v = [0, 0, 0]
    axes.forEach((a, k) => { const c = cross(a, p); const w = k === 0 ? 1 : 0.6 * Math.cos(3 * lambda) ; v[0] += c[0] * w; v[1] += c[1] * w; v[2] += c[2] * w })
    return v
  }
  const field = new Float32Array(RX * RY * 2)
  for (let j = 0; j < RY; j++) {
    for (let i = 0; i < RX; i++) {
      const th = (Math.PI * (j + 0.5)) / RY
      const la = (TAU * (i + 0.5)) / RX
      const v = truth(th, la)
      field[(j * RX + i) * 2] = -Math.sin(la) * v[0] + Math.cos(la) * v[1]
      field[(j * RX + i) * 2 + 1] = Math.cos(th) * Math.cos(la) * v[0] + Math.cos(th) * Math.sin(la) * v[1] - Math.sin(th) * v[2]
    }
  }
  const marks = VM.globeVectorMarks(field, RX, RY, { width: W, spacing: 26, length: 26, minSpeed: 0.15, refSpeed: 1 })
  const worst = { all: 0, seam: 0, pole: 0 }
  const counts = { all: 0, seam: 0, pole: 0 }
  for (const m of marks) {
    const v = truth(Math.PI * m.at.v, TAU * m.at.u)
    const vb = [v[0], v[2], -v[1]]
    const r = P.globeSymbolFrame(m.at, m.angle, false).right
    const sine = norm(cross(r, vb)) / norm(vb)
    const s = dot(r, vb) < 0 ? 1 : sine
    const lat = Math.abs(90 - m.at.v * 180)
    worst.all = Math.max(worst.all, s); counts.all++
    if (m.at.u < 0.01 || m.at.u > 0.99) { worst.seam = Math.max(worst.seam, s); counts.seam++ }
    if (lat > 85) { worst.pole = Math.max(worst.pole, s); counts.pole++ }
  }
  check('globe: placed marks point along the field\'s true direction', worst.all < 0.02, `worst sine ${worst.all.toFixed(4)} over ${counts.all} marks`)
  check('globe: at the seam', counts.seam > 0 && worst.seam < 0.02, `worst sine ${worst.seam.toFixed(4)} over ${counts.seam} marks`)
  check('globe: beyond 85° (pole marks included)', counts.pole > 0 && worst.pole < 0.02, `worst sine ${worst.pole.toFixed(4)} over ${counts.pole} marks`)
}

await server.close()
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
