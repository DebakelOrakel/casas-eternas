// Check of THE GLOBE'S TEMPERATURE SCALE (map/globeTemperatureArc.ts): the
// globe view (map/sphereView.ts) built for real on Babylon's NullEngine, as
// in scripts/globeScale.mjs, its limb found by Babylon's own projection and
// its latitudes by the axis of the globe's lean, not by the view's chart.
//
//   node scripts/globeTemperature.mjs
//
// A sibling of scripts/globeScale.mjs, not one of the four harnesses.
//
// What it says, in the overview and the profile view, at several
// obliquities, zooms and canvases:
//  1. limbChartAt(ψ) is the latitude of the limb point that Babylon
//     projects at the screen angle ψ.
//  2. Each segment of the arc has the band's temperature of that limb
//     latitude at its screen angle (the row the flat strip takes), and the
//     end ticks the temperature at the ends.
//  3. The extent: northPsi is the limb's most northern point (dense
//     search); each end is a pole-side extreme of the limb or a cut of the
//     window (the left half, WINDOW_MARGIN off the free area's top and
//     bottom); the latitude falls monotonically along the arc.
//  4. No arc with the tilt on (no outline), and with the camera on the
//     axis (the limb at one latitude). A slow zoom in and out switches the
//     arc once each way, the way back at a smaller globe (the hysteresis).
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const B = await server.ssrLoadModule('@babylonjs/core')
const V = await server.ssrLoadModule('/src/map/sphereView.ts')
const S = await server.ssrLoadModule('/src/map/globeScaleArc.ts')
const T = await server.ssrLoadModule('/src/map/globeTemperatureArc.ts')
// The band is the engine's (climate/temperature.rs), from its WASM build
// in engine/dist (`make engine`).
const dist = new URL('../../engine/dist/wasm/', import.meta.url)
const WASM = await import(new URL('casas-engine.js', dist).href)
await WASM.default({ module_or_path: await readFile(new URL('casas-engine_bg.wasm', dist)) })
// As the TypeScript band took it until 2026-10-30: no planet the default
// one, the torus's pivot.
const TEMP = { seaLevelTemperatureBand: (offset, contrast, planet) => WASM.seaLevelTemperatureBand(offset, contrast, planet, 'torus') }
const P = await server.ssrLoadModule('/src/generator/planet/planetForcing.ts')
const D = await server.ssrLoadModule('/src/generator/core/domain.ts')
B.Logger.LogLevels = B.Logger.ErrorLogLevel * 0

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok    ${name}${detail ? `  ${detail}` : ''}`)
  else { failures++; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`) }
}

// The sphere's own extent (DEC-0035 fork 6), as the screen hands it to the globe.
const METRES_ROUND = D.sphereDomain(64, 32).metresAround
const views = []
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const label = (text) => 7 * text.length

function makeView(width, height) {
  const engine = new B.NullEngine({ renderWidth: width, renderHeight: height, textureSize: 64, deterministicLockstep: false, lockstepMaxSteps: 1 })
  engine.getDeltaTime = () => 1000 / 60
  let wheel = null
  const canvas = { addEventListener: (type, fn) => { if (type === 'wheel') wheel = fn }, removeEventListener: () => {} }
  const view = V.createGlobeWorldView({ engine, canvas, textureWidth: 64, textureHeight: 32, metresRound: METRES_ROUND })
  views.push(view)
  const camera = view.scene.activeCamera
  const tilt = view.scene.getTransformNodeByName('sphereTilt')
  const frame = () => {
    view.scene.onBeforeRenderObservable.notifyObservers(view.scene)
    camera.computeWorldMatrix(true)
    camera.getViewMatrix(true)
    camera.getProjectionMatrix(true)
  }
  const settle = (frames = 400) => { for (let i = 0; i < frames; i++) frame() }
  const zoomBy = (events, delta = 100) => {
    for (let i = 0; i < Math.abs(events); i++) wheel({ deltaY: events > 0 ? -delta : delta, deltaMode: 0, preventDefault() {} })
  }
  const project = (p) => {
    const transform = camera.getViewMatrix().multiply(camera.getProjectionMatrix())
    const s = B.Vector3.Project(p, B.Matrix.Identity(), transform, camera.viewport.toGlobal(width, height))
    return [s.x, s.y]
  }
  // The limb circle, parametrised by its own angle θ (any two axes across
  // the camera's axis would do; the bisection below finds θ from ψ).
  const limb = () => {
    const eye = camera.position
    const d = eye.length()
    const e = eye.scale(1 / d)
    const right = camera.getDirection(B.Vector3.Right()).normalize()
    const up = camera.getDirection(B.Vector3.Up()).normalize()
    const centre = e.scale(1 / d)
    const r = Math.sqrt(1 - 1 / (d * d))
    return (theta) => centre.add(right.scale(r * Math.cos(theta))).add(up.scale(r * Math.sin(theta)))
  }
  // The latitude of a world point: off the plane of the leaned equator.
  const latitudeOf = (p) => {
    const axis = B.Vector3.TransformNormal(B.Vector3.Up(), tilt.computeWorldMatrix(true)).normalize()
    return Math.asin(Math.max(-1, Math.min(1, B.Vector3.Dot(p.normalize(), axis))))
  }
  return { view, camera, engine, frame, settle, zoomBy, project, limb, latitudeOf, width, height }
}

// The limb's latitude at the screen angle ψ, independently: the limb point
// whose Babylon projection lies at ψ round the outline's centre.
function limbLatitudes(g) {
  const s = g.view.silhouette()
  const L = g.limb()
  const screenAngle = (p) => { const [x, y] = g.project(p); return Math.atan2(-(y - s.y), x - s.x) }
  const offset = screenAngle(L(0))
  return (psi) => {
    let lo = psi - offset - 0.1
    let hi = psi - offset + 0.1
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2
      if (wrap(screenAngle(L(mid)) - psi) < 0) lo = mid
      else hi = mid
    }
    return g.latitudeOf(L((lo + hi) / 2))
  }
}

const vOf = (latitude) => 0.5 - latitude / Math.PI
const rowEdge = (v, n) => Math.abs(v * n - Math.round(v * n)) < 1e-6

// The screen's bars: the column (300 px), the title bar and the step bar.
const bars = (w, h) => ({ left: 300 / w, top: 56 / h, right: 1, bottom: (h - 64) / h })
const SETUPS = [
  ['overview', 1600, 800, { left: 0, top: 0, right: 1, bottom: 1 }],
  ['overview', 1920, 1080, bars(1920, 1080)],
  ['profile', 1600, 800, { left: 0, top: 0, right: 1, bottom: 1 }],
  ['profile', 1920, 1080, bars(1920, 1080)],
  ['profile', 1280, 800, bars(1280, 800)],
]
const OBLIQUITIES = [0, 23.4, 45, 80]
const ZOOMS = [0, 6]

console.log('1.-3. the limb, the colours and the extent')
let limbWorst = 0
let colourChecked = 0
let colourWrong = 0
let endWrong = 0
let northWorst = 0
let extentWrong = []
let monotoneWrong = 0
const lines = []
for (const [home, w, h, area] of SETUPS) {
  for (const obliquity of OBLIQUITIES) {
    for (const notches of ZOOMS) {
      const g = makeView(w, h)
      g.view.setObliquity(obliquity)
      g.view.setFreeArea(area)
      g.view.setHome(home, true)
      g.settle(5)
      g.zoomBy(notches)
      g.settle()
      const s = g.view.silhouette()
      if (!s) { extentWrong.push(`${home} ${obliquity}°: no outline`); continue }
      const free = { left: area.left * w, top: area.top * h, right: area.right * w, bottom: area.bottom * h }
      const latAt = limbLatitudes(g)
      const limbV = (psi) => g.view.limbChartAt(psi)?.v ?? null
      // 1.
      for (let i = 0; i < 24; i++) {
        const psi = (i / 24) * 2 * Math.PI
        limbWorst = Math.max(limbWorst, Math.abs(limbV(psi) - vOf(latAt(psi))))
      }
      const band = TEMP.seaLevelTemperatureBand(0, 1, { ...P.DEFAULT_PLANET_FORCING, obliquityDeg: obliquity })
      const layout = T.globeTemperatureArcLayout(s, free, limbV, band, label, true)
      const tag = `${home} ${w}×${h} ${obliquity}° +${notches}`
      if (!layout) { lines.push(`${tag}: none`); continue }
      // 2.
      for (const seg of layout.segments) {
        const v = vOf(latAt(seg.psi))
        if (rowEdge(v, band.length)) continue
        colourChecked++
        if (seg.celsius !== T.bandAt(band, v)) colourWrong++
      }
      for (const tick of layout.ticks.filter((t) => t.end)) {
        if (tick.celsius !== T.bandAt(band, vOf(latAt(tick.psi)))) endWrong++
      }
      // 3. The most northern limb point, by a dense search refined.
      let best = 0
      let bestLat = -Infinity
      for (let i = 0; i < 720; i++) {
        const psi = (i / 720) * 2 * Math.PI
        const lat = latAt(psi)
        if (lat > bestLat) { bestLat = lat; best = psi }
      }
      for (let step = (2 * Math.PI) / 720; step > 1e-6; step /= 2) {
        for (const c of [best - step, best + step]) { const lat = latAt(c); if (lat > bestLat) { bestLat = lat; best = c } }
      }
      northWorst = Math.max(northWorst, Math.abs(wrap(best - layout.northPsi)))
      const radius = s.radius + S.ARC_GAP
      const windowFrom = Math.PI - Math.asin(Math.min(1, (s.y - free.top - T.WINDOW_MARGIN) / radius))
      const windowTo = Math.PI + Math.asin(Math.min(1, (free.bottom - T.WINDOW_MARGIN - s.y) / radius))
      const what = (psi) => {
        // A pole side's end stands POLE_MARGIN off the pole's screen angle.
        if (Math.abs(Math.abs(wrap(psi - best)) - T.POLE_MARGIN) < 1e-4) return 'N'
        if (Math.abs(Math.abs(wrap(psi - best - Math.PI)) - T.POLE_MARGIN) < 1e-4) return 'S'
        if (Math.abs(psi - windowFrom) < 1e-9 || Math.abs(psi - windowTo) < 1e-9) return 'cut'
        return '?'
      }
      const ends = [what(layout.from), what(layout.to)]
      if (ends.includes('?') || layout.from < Math.PI / 2 - 1e-9 || layout.to > 1.5 * Math.PI + 1e-9) extentWrong.push(`${tag}: ${ends.join('/')}`)
      // The latitude falls one way along the arc: within one half circle.
      const lats = layout.segments.map((seg) => latAt(seg.psi))
      const sign = Math.sign(lats[lats.length - 1] - lats[0])
      for (let i = 1; i < lats.length; i++) if (Math.sign(lats[i] - lats[i - 1]) === -sign && Math.abs(lats[i] - lats[i - 1]) > 1e-9) monotoneWrong++
      const deg = (r) => ((r * 180) / Math.PI).toFixed(1)
      const endTick = layout.ticks.filter((t) => t.end)
      lines.push(`${tag}: ψ ${deg(layout.from)}°..${deg(layout.to)}° (${ends.join('→')}), north at ${deg(wrap(layout.northPsi))}°, lat ${deg(lats[0])}°..${deg(lats[lats.length - 1])}°, ${endTick.map((t) => t.celsius.toFixed(1)).join('..')} °C, ${layout.ticks.filter((t) => t.labelled).length} labels`)
    }
  }
}
check('limbChartAt = the latitude Babylon projects at ψ', limbWorst < 1e-6, `max |Δv| ${limbWorst.toExponential(2)}`)
check('each segment: the band temperature of the limb latitude at its angle', colourWrong === 0 && colourChecked > 1000, `${colourChecked} segments, ${colourWrong} wrong`)
check('the end ticks: the band temperature at the ends', endWrong === 0)
check('northPsi = the limb\'s most northern point', northWorst < 1e-4, `max ${northWorst.toExponential(2)} rad`)
check('each end: a pole-side extreme of the limb or a cut of the window', extentWrong.length === 0, extentWrong.join('; '))
check('the latitude falls one way along the arc', monotoneWrong === 0)
for (const line of lines) console.log(`        ${line}`)

console.log('4. where the arc does not show')
{
  const g = makeView(1280, 800)
  g.zoomBy(16)
  g.settle()
  g.view.setTilted(true)
  g.settle()
  check('tilt on: no outline, so no arc', g.view.silhouette() === null)
}
{
  // The camera on the axis: the limb at one latitude. A limb whose v is
  // the same all round, as the view gives it from straight over a pole.
  const g = makeView(1280, 800)
  g.settle()
  const band = TEMP.seaLevelTemperatureBand(0, 1)
  check('the limb at one latitude: no arc', T.globeTemperatureArcLayout(g.view.silhouette(), { left: 0, top: 0, right: 1280, bottom: 800 }, () => 0.3, band, label, true) === null)
}
{
  // The column leaves no room on the left of the overview's far shot on a
  // 1280 × 800 canvas: the globe's rim is 38 px from it.
  const g = makeView(1280, 800)
  const area = bars(1280, 800)
  g.view.setFreeArea(area)
  g.settle()
  const free = { left: area.left * 1280, top: area.top * 800, right: 1280, bottom: area.bottom * 800 }
  const s = g.view.silhouette()
  const none = T.globeTemperatureArcLayout(s, free, (psi) => g.view.limbChartAt(psi)?.v ?? null, TEMP.seaLevelTemperatureBand(0, 1), label, true) === null
  check('overview 1280×800 with the column: no room on the left, no arc', none, `rim at ${(s.x - s.radius - free.left).toFixed(0)} px from the column`)
}
for (const [name, w, h, area] of [SETUPS[0], SETUPS[1]]) {
  const g = makeView(w, h)
  g.view.setFreeArea(area)
  g.settle()
  const free = { left: area.left * w, top: area.top * h, right: area.right * w, bottom: area.bottom * h }
  const band = TEMP.seaLevelTemperatureBand(0, 1)
  const limbV = (psi) => g.view.limbChartAt(psi)?.v ?? null
  let shown = T.globeTemperatureArcLayout(g.view.silhouette(), free, limbV, band, label, false) !== null
  check(`${name} ${w}×${h}: shown at the far zoom`, shown)
  const switches = []
  for (const [dir, frames] of [[1, 900], [-1, 900]]) {
    for (let i = 0; i < frames; i++) {
      g.zoomBy(dir, 5)
      g.frame()
      const s = g.view.silhouette()
      const now = s ? T.globeTemperatureArcLayout(s, free, limbV, band, label, shown) !== null : false
      if (now !== shown) switches.push({ dir, now, radius: s ? s.radius : NaN })
      shown = now
    }
  }
  const ins = switches.filter((x) => x.dir === 1)
  const outs = switches.filter((x) => x.dir === -1)
  check(`${name} ${w}×${h}: hidden when the globe fills the area`, ins.length === 1 && !ins[0].now, `${ins.length} switch(es) zooming in, hidden at radius ${ins[0]?.radius.toFixed(1)} px`)
  check(`${name} ${w}×${h}: back once zooming out, at a smaller globe`, outs.length === 1 && outs[0].now && outs[0].radius < ins[0].radius - 10, `${outs.length} switch(es) zooming out, shown at radius ${outs[0]?.radius.toFixed(1)} px`)
}

for (const view of views) view.dispose()
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
