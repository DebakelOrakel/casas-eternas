// Check of THE GLOBE'S RIVERS AND LAKES (map/globeRibbons.ts, the 'globe'
// water in map/waterMaterialPlugin.ts) — the geometry and the texels the
// globe view draws the hydrology with.
//
//   node scripts/globeWater.mjs
//
// A sibling of scripts/symbolPlacement.mjs, not one of the four harnesses:
// a view's geometry, a few seconds. It reads the functions the views run;
// the flat map's ribbons are built for real on Babylon's NullEngine, so the
// width the globe is compared with is the flat map's own.
//
// What it says:
//  1. The rivers lie over the globe's faces and under the symbols: the
//     96-segment sphere's deepest face against RIVER_LIFT and GLOBE_SYMBOL_LIFT.
//  2. A ribbon's ends are its chart points: round trip chart → globe →
//     chart, at the equator, at the seam and next to and on the poles; every
//     vertex at RIVER_LIFT, its offset direction a unit vector in the surface
//     and across the river.
//  3. A river is as wide on the globe as on the flat map at the same
//     discharge: the physical width in metres, and the cartographic width
//     in pixels.
//  4. A step across the seam or a pole is the short step it is on the
//     globe: no piece longer than the step's great-circle length, the
//     ribbon as long as that; a jump across the globe is not drawn.
//  5. The water's texels: the sphere's UV at a vertex is the texel the
//     chart (chartAt's function) gives for its position; the shore cells of
//     a pole row are found across the pole half a turn round, not at the
//     other pole.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const P = await server.ssrLoadModule('/src/map/symbolPlacement.ts')
const G = await server.ssrLoadModule('/src/map/globeRibbons.ts')
const RW = await server.ssrLoadModule('/src/map/riverWidth.ts')
const S = await server.ssrLoadModule('/src/map/mapSceneSettings.ts')
const C = await server.ssrLoadModule('/src/generator/core/mapConfig.ts')
const D = await server.ssrLoadModule('/src/generator/core/domain.ts')
const HY = await server.ssrLoadModule('/src/generator/surface/hydrology.ts')
const TR = await server.ssrLoadModule('/src/map/ToroidalRibbonOverlay.ts')
const WM = await server.ssrLoadModule('/src/map/waterMaterialPlugin.ts')
const B = await server.ssrLoadModule('@babylonjs/core')
const { CreateSphereVertexData } = await import(`${CLIENT}/node_modules/@babylonjs/core/Meshes/Builders/sphereBuilder.pure.js`)

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok    ${name}${detail ? `  ${detail}` : ''}`)
  else { failures++; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`) }
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const norm = (a) => Math.hypot(a[0], a[1], a[2])
const unit = (a) => { const n = norm(a); return [a[0] / n, a[1] / n, a[2] / n] }
const angle = (a, b) => Math.atan2(norm(cross(a, b)), dot(a, b))
const at3 = (arr, i) => [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]]

// The generator's chart and the globe the screen makes (GeneratorScreen:
// metresRound = the sphere Domain's metresAround, DEC-0035 fork 6).
const W = C.MAP_WIDTH
const H = C.MAP_HEIGHT
const RADIUS_METRES = D.sphereDomain(W, H).metresAround / (2 * Math.PI)
const sphereSource = readFileSync(`${CLIENT}/src/map/sphereView.ts`, 'utf8')
const constant = (name) => Number(sphereSource.match(new RegExp(`const ${name} = ([0-9.]+)`))[1])
const RIVER_LIFT = constant('RIVER_LIFT')
const SYMBOL_LIFT = P.GLOBE_SYMBOL_LIFT
const build = (pts, lengths = [pts.length / 3], regimes) =>
  G.buildGlobeRibbons(new Float32Array(pts), new Uint32Array(lengths), regimes && new Uint8Array(regimes), W, H, RADIUS_METRES, RIVER_LIFT)
const chartOf = (x, y) => P.globeFrameOfChart({ u: x / W, v: y / H })

// --- 1. the lift ------------------------------------------------------------
console.log('1. the rivers over the globe, under the symbols')
{
  const data = CreateSphereVertexData({ diameter: 2, segments: 96 })
  let deepest = 0
  for (let t = 0; t < data.indices.length; t += 3) {
    const a = at3(data.positions, data.indices[t])
    const b = at3(data.positions, data.indices[t + 1])
    const c = at3(data.positions, data.indices[t + 2])
    const n = cross(sub(b, a), sub(c, a))
    if (norm(n) < 1e-12) continue
    // The face's plane's distance from the centre: no point of it lies nearer.
    deepest = Math.max(deepest, 1 - Math.abs(dot(unit(n), a)))
  }
  check('rivers over the deepest face', RIVER_LIFT - 1 > deepest, `face down to ${deepest.toExponential(2)} radii, rivers at +${(RIVER_LIFT - 1).toExponential(1)} (${((RIVER_LIFT - 1) * RADIUS_METRES / 1000).toFixed(1)} km)`)
  check('rivers under the symbols', RIVER_LIFT < SYMBOL_LIFT, `symbols at +${(SYMBOL_LIFT - 1).toExponential(1)}`)
}

// --- 2. the round trip ------------------------------------------------------
console.log('2. chart → globe → chart, and the vertices')
{
  // Pairs of chart points in texels: the ends of a two-point river.
  const cases = [
    ['equator', [1024, 512], [1030, 515]],
    ['seam, west to east', [W - 0.3, 400], [0.4, 401]],
    ['seam, east to west', [0.2, 700], [W - 0.6, 699]],
    ['60°N', [300, H / 6], [305, H / 6 + 2]],
    ['next to the north pole', [100, 0.5], [900, 0.6]],
    ['next to the south pole', [1500, H - 0.4], [1600, H - 0.7]],
    ['on the north pole', [77, 0], [77, 3]],
  ]
  let worstEnd = 0
  let worstTexel = 0
  let worstLift = 0
  let worstDir = 0
  for (const [name, a, b] of cases) {
    const g = build([a[0], a[1], 2, b[0], b[1], 4])
    const count = g.positions.length / 3
    const ends = [[a, 0], [b, count - 1]]
    for (const [pt, vi] of ends) {
      const p = at3(g.positions, vi)
      const chart = P.globeChartOfFrame(p)
      const back = P.globeFrameOfChart(chart)
      const want = chartOf(pt[0], pt[1])
      const metres = angle(back, want) * RADIUS_METRES
      worstEnd = Math.max(worstEnd, metres)
      // In texels, where u is defined (off the pole rows' centre).
      const lat = (0.5 - pt[1] / H) * Math.PI
      if (Math.cos(lat) > 1e-3) {
        let du = Math.abs(chart.u * W - pt[0]) % W
        du = Math.min(du, W - du)
        worstTexel = Math.max(worstTexel, Math.hypot(du * Math.cos(lat), chart.v * H - pt[1]))
      }
    }
    for (let i = 0; i < count; i++) {
      const p = at3(g.positions, i)
      const d = at3(g.dirs, i)
      worstLift = Math.max(worstLift, Math.abs(norm(p) - RIVER_LIFT))
      const pn = unit(p)
      const centre = Math.floor(i / 2)
      const prev = unit(at3(g.positions, 2 * Math.max(0, centre - 1)))
      const next = unit(at3(g.positions, 2 * Math.min(count / 2 - 1, centre + 1)))
      const tangent = unit(sub(next, prev))
      worstDir = Math.max(worstDir, Math.abs(norm(d) - 1), Math.abs(dot(d, pn)), Math.abs(dot(d, tangent)))
    }
    void name
  }
  check('the ends lie on their chart points', worstEnd < 1, `worst ${worstEnd.toFixed(3)} m over ${cases.length} rivers (equator, seam both ways, 60°N, both poles)`)
  check('the chart back to the texel', worstTexel < 1e-3, `worst ${worstTexel.toExponential(2)} texels (east-west by cos φ)`)
  check('every vertex at RIVER_LIFT', worstLift < 1e-6, `worst ${worstLift.toExponential(2)} radii`)
  // The tangent is found again here from Float32 positions 6e-4 radii
  // apart, whose last bit (6e-8) is 1e-4 of the step.
  check('offset: unit, in the surface, across the river', worstDir < 1e-4, `worst ${worstDir.toExponential(2)}`)
}

// --- 3. the width -----------------------------------------------------------
console.log('3. as wide on the globe as on the flat map')
{
  const engine = new B.NullEngine()
  const scene = new B.Scene(engine)
  const flat = TR.createToroidalRibbonOverlay({ scene, worldWidth: S.MAP_WORLD_WIDTH, worldHeight: S.MAP_WORLD_HEIGHT, textureWidth: W, textureHeight: H, getViewWidth: () => S.MAP_WORLD_WIDTH })
  // A river whose width runs across the hydrology's whole range.
  const n = 41
  const pts = []
  for (let i = 0; i < n; i++) pts.push(200 + i, 300, HY.RIVER_MIN_WIDTH + ((HY.RIVER_MAX_WIDTH - HY.RIVER_MIN_WIDTH) * i) / (n - 1))
  flat.setPolylines(new Float32Array(pts), new Uint32Array([n]))
  const flatWidths = scene.getMeshByName('riverRibbon').getVerticesData('ribbonWidths')
  const globe = build(pts)
  check('the same vertex count', flatWidths.length === globe.widths.length, `${flatWidths.length / 3} each`)
  let worstMetres = 0
  let worstPx = 0
  let worstRel = 0
  let widest = 0
  let narrowest = Infinity
  for (let i = 0; i < flatWidths.length / 3; i++) {
    const flatMetres = (flatWidths[i * 3] * 2) / S.UNITS_PER_METER
    const globeMetres = globe.widths[i * 3] * 2 * RADIUS_METRES
    widest = Math.max(widest, flatMetres)
    narrowest = Math.min(narrowest, flatMetres)
    worstMetres = Math.max(worstMetres, Math.abs(flatMetres - globeMetres) / flatMetres)
    worstPx = Math.max(worstPx, Math.abs(flatWidths[i * 3 + 1] - globe.widths[i * 3 + 1]))
    worstRel = Math.max(worstRel, Math.abs(flatWidths[i * 3 + 2] - globe.widths[i * 3 + 2]))
  }
  check('physical width, metres', worstMetres < 1e-6, `${narrowest.toFixed(0)}–${widest.toFixed(0)} m, worst difference ${worstMetres.toExponential(2)} of the width`)
  check('cartographic width, pixels', worstPx < 1e-5, `worst ${worstPx.toExponential(2)} px`)
  check('relative discharge', worstRel < 1e-6, `worst ${worstRel.toExponential(2)}`)
  flat.dispose()
  scene.dispose()
  engine.dispose()
}

// --- 4. the seam and the poles ----------------------------------------------
console.log('4. a step across the seam or a pole is the short step')
{
  const cases = [
    ['seam at the equator', [W - 1, 512, 2], [1, 512, 2]],
    ['seam at 60°S', [W - 2, (5 * H) / 6, 2], [2, (5 * H) / 6, 2]],
    ['across the north pole', [W / 4, 1, 2], [(3 * W) / 4, 1, 2]],
    ['across the south pole', [10, H - 1, 2], [10 + W / 2, H - 1, 2]],
  ]
  for (const [name, a, b] of cases) {
    const g = build([...a, ...b])
    const truth = angle(chartOf(a[0], a[1]), chartOf(b[0], b[1])) * RIVER_LIFT
    let longest = 0
    let total = 0
    for (let i = 2; i < g.positions.length / 3; i += 2) {
      const piece = norm(sub(at3(g.positions, i), at3(g.positions, i - 2)))
      longest = Math.max(longest, piece)
      total += piece
    }
    check(name, longest <= truth * (1 + 1e-6) && Math.abs(total - truth) < truth * 1e-4,
      `step ${(truth * RADIUS_METRES / 1000).toFixed(1)} km on the globe (chart ${Math.abs(b[0] - a[0]).toFixed(0)} texels across), ribbon ${(total * RADIUS_METRES / 1000).toFixed(1)} km, longest piece ${(longest * RADIUS_METRES / 1000).toFixed(2)} km`)
  }
  // Inside a longer river, through the seam: the ribbon as long as the
  // great circles between its points (the spline adds a little curve).
  {
    const pts = []
    for (let i = -6; i <= 6; i++) pts.push((W + i) % W, 512 + 0.3 * i * i, 2)
    const g = build(pts)
    let truth = 0
    for (let i = 1; i < pts.length / 3; i++) truth += angle(chartOf(pts[(i - 1) * 3], pts[(i - 1) * 3 + 1]), chartOf(pts[i * 3], pts[i * 3 + 1]))
    truth *= RIVER_LIFT
    let total = 0
    for (let i = 2; i < g.positions.length / 3; i += 2) total += norm(sub(at3(g.positions, i), at3(g.positions, i - 2)))
    check('a river through the seam', Math.abs(total - truth) < truth * 0.02, `${(truth * RADIUS_METRES / 1000).toFixed(1)} km of steps, ribbon ${(total * RADIUS_METRES / 1000).toFixed(1)} km`)
  }
  // A jump half round the globe is not drawn; the rest of the river is.
  {
    const g = build([100, 512, 2, 101, 512, 2, 100 + W / 2, 512, 2, 101 + W / 2, 512, 2])
    let longest = 0
    for (let i = 2; i < g.positions.length / 3; i += 2) {
      // Only pieces of one run: a run's last vertex pair and the next run's first are not joined.
      longest = Math.max(longest, norm(sub(at3(g.positions, i), at3(g.positions, i - 2))))
    }
    const triangles = g.indices.length / 3
    let joined = 0
    for (let t = 0; t < g.indices.length; t += 3) {
      const a = at3(g.positions, g.indices[t])
      for (let k = 1; k < 3; k++) joined = Math.max(joined, norm(sub(a, at3(g.positions, g.indices[t + k]))))
    }
    check('a jump across the globe breaks the river', joined * RADIUS_METRES < 20_000, `${triangles} triangles, longest edge ${(joined * RADIUS_METRES / 1000).toFixed(2)} km`)
  }
  // The ink of a step across the seam: its length on the globe, not the chart's.
  {
    const g = build([W - 1, 512, 2, 1, 512, 2])
    const ink = g.ink.reduce((s, x) => s + x, 0)
    check('the ink of a seam step', Math.abs(ink - 2 / W) < 1e-9, `${(ink * W).toFixed(6)} equator texels (2 on the globe, ${W - 2} in the chart)`)
  }
}

// --- 5. the water's texels --------------------------------------------------
console.log('5. the water: texels where chartAt says, neighbours across the poles')
{
  const data = CreateSphereVertexData({ diameter: 2, segments: 96 })
  let checked = 0
  let off = 0
  for (let i = 0; i < data.positions.length / 3; i++) {
    const p = at3(data.positions, i)
    const u = data.uvs[i * 2]
    const v = data.uvs[i * 2 + 1]
    // The seam's duplicate column (u = 1) and the pole rows' fans carry a
    // u of their own; the texel row is still the chart's.
    if (u > 1 - 1e-6 || Math.abs(p[1]) > 1 - 1e-6) continue
    const chart = P.globeChartOfFrame(p)
    // Texels at the vertex's own place: compare with a slack of a millionth
    // of a texel, so a vertex on a texel edge does not count as off.
    const du = Math.abs(chart.u - u) * W
    const dv = Math.abs(chart.v - v) * H
    if (Math.min(du, W - du) > 1e-3 || dv > 1e-3) off++
    checked++
  }
  check('the UV texel is the chart texel', off === 0, `${checked} sphere vertices, ${off} off by more than 1e-3 texel`)

  // A land cell on the north pole row in a sea, on both shapes: which cells
  // are the sea's shore cells (the A channel's flag).
  const w = 64
  const h = 32
  const x0 = 5
  const elevation = new Float32Array(w * h).fill(-0.1)
  elevation[x0] = 0.2
  const engine = new B.NullEngine()
  const scene = new B.Scene(engine)
  const shores = (shape) => {
    const field = new WM.WaterField(scene, shape)
    field.setElevation(elevation, w, h)
    const packed = field['packed']
    const cells = []
    for (let i = 0; i < w * h; i++) if (packed[i * 4 + 3] > 0.5) cells.push(i)
    field.dispose()
    return cells
  }
  const centre = (i) => P.globeFrameOfChart({ u: ((i % w) + 0.5) / w, v: (Math.floor(i / w) + 0.5) / h })
  const land = centre(x0)
  const sphere = shores('sphere')
  const torus = shores('torus')
  // The farthest shore cell from the land, in cell heights on the globe.
  const cellAngle = Math.PI / h
  const farthest = Math.max(...sphere.map((i) => angle(centre(i), land))) / cellAngle
  const across = sphere.filter((i) => i < w && Math.abs((i % w) - (x0 + w / 2)) <= 1).length
  const southSphere = sphere.filter((i) => i >= (h - 1) * w).length
  const southTorus = torus.filter((i) => i >= (h - 1) * w).length
  check('sphere: the shore round the land, across the pole', farthest < 1.5 && across === 3 && southSphere === 0,
    `${sphere.length} shore cells, farthest ${farthest.toFixed(2)} cell heights, ${across} half a turn round, ${southSphere} on the south pole row`)
  check('torus unchanged: the opposite edge is the neighbour', southTorus === 3 && torus.length === 8, `${torus.length} shore cells, ${southTorus} on the last row`)
  scene.dispose()
  engine.dispose()
}

await server.close()
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
