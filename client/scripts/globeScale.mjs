// Check of THE GLOBE'S SCALES (map/globeScaleArc.ts, the globe's corner bar
// in map/ScaleBar.ts): the globe view (map/sphereView.ts) built for real on
// Babylon's NullEngine, its camera driven by wheel events and frames, its
// outline and its distances compared with Babylon's own projection.
//
//   node scripts/globeScale.mjs
//
// A sibling of scripts/globeGrab.mjs, not one of the four harnesses: a
// view's camera, a few seconds.
//
// What it says:
//  1. The outline's radius (globeSilhouette, from the camera's distance,
//     fov and canvas) is where Babylon projects the limb's points, at
//     several zooms and canvas sizes; with the tilt on there is no outline.
//  2. A step of S km on the arc is S km along the limb circle: the limb
//     point under each major tick (found by its projection) is S km from
//     the next, measured on the small circle in 3D. The great circle
//     between them is shown, a little shorter.
//  3. The switch: the arc shows at the far zoom on a wide canvas, not when
//     the globe fills the free area, and a slow zoom in and out switches
//     it once each way, the way back at a smaller globe (the hysteresis).
//  4. The corner bar's measure at the screen's centre is the metres a
//     pixel spans there horizontally, tilt off and on.
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const B = await server.ssrLoadModule('@babylonjs/core')
const V = await server.ssrLoadModule('/src/map/sphereView.ts')
const A = await server.ssrLoadModule('/src/map/globeScaleArc.ts')
const C = await server.ssrLoadModule('/src/generator/core/mapConfig.ts')
B.Logger.LogLevels = B.Logger.ErrorLogLevel * 0

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok    ${name}${detail ? `  ${detail}` : ''}`)
  else { failures++; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`) }
}

const METRES_ROUND = C.METERS_PER_CELL * C.MAP_WIDTH
const RADIUS_METRES = METRES_ROUND / (2 * Math.PI)
const PROBE_PX = 10 // ScaleBar's probe at a given place (PROBE_AT_PX)
const views = []

// The globe view as the screen makes it, on a canvas of width × height.
function makeView(width, height) {
  const engine = new B.NullEngine({ renderWidth: width, renderHeight: height, textureSize: 64, deterministicLockstep: false, lockstepMaxSteps: 1 })
  engine.getDeltaTime = () => 1000 / 60
  let wheel = null
  const canvas = { addEventListener: (type, fn) => { if (type === 'wheel') wheel = fn }, removeEventListener: () => {} }
  const view = V.createGlobeWorldView({ engine, canvas, textureWidth: 64, textureHeight: 32, metresRound: METRES_ROUND })
  views.push(view)
  const camera = view.scene.activeCamera
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
  // The limb circle in the scene: centre, radius and two axes across the
  // camera's axis (the camera's right and up).
  const limb = () => {
    const eye = camera.position
    const d = eye.length()
    const e = eye.scale(1 / d)
    const right = camera.getDirection(B.Vector3.Right()).normalize()
    const up = camera.getDirection(B.Vector3.Up()).normalize()
    const centre = e.scale(1 / d)
    const r = Math.sqrt(1 - 1 / (d * d))
    return { centre, r, right, up, at: (theta) => centre.add(right.scale(r * Math.cos(theta))).add(up.scale(r * Math.sin(theta))) }
  }
  return { view, camera, engine, frame, settle, zoomBy, project, limb, width, height }
}

// The screen angle of a pixel round the outline's centre, upward from the
// horizontal to the right (globeScaleArc.ts's ψ).
const screenAngle = (s, [x, y]) => Math.atan2(-(y - s.y), x - s.x)
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))

// --- 1. the outline -----------------------------------------------------------
console.log('1. the outline is where the limb projects')
const CANVASES = [[1280, 800], [1600, 800], [800, 1000], [1920, 1080]]
const ZOOMS = [0, 8, 16, 24] // wheel notches from the far shot
for (const [w, h] of CANVASES) {
  const g = makeView(w, h)
  g.settle(5)
  let worst = 0
  let angleWorst = 0
  const radii = []
  for (const notches of ZOOMS) {
    g.zoomBy(notches - (ZOOMS[ZOOMS.indexOf(notches) - 1] ?? 0))
    g.settle()
    const s = g.view.silhouette()
    if (!s) { worst = Infinity; continue }
    radii.push(s.radius.toFixed(0))
    const L = g.limb()
    let first = null
    for (let i = 0; i < 72; i++) {
      const theta = (i / 72) * 2 * Math.PI
      const p = g.project(L.at(theta))
      worst = Math.max(worst, Math.abs(Math.hypot(p[0] - s.x, p[1] - s.y) - s.radius))
      // The screen angle follows the angle round the limb circle one to one.
      const psi = screenAngle(s, p)
      first ??= psi - theta
      angleWorst = Math.max(angleWorst, Math.abs(wrap(psi - theta - first)))
    }
  }
  check(`${w}×${h}: radius = projected limb`, worst < 0.01, `max ${worst.toExponential(2)} px over radii ${radii.join(', ')} px`)
  check(`${w}×${h}: screen angle = angle round the limb`, angleWorst < 1e-5, `max ${angleWorst.toExponential(2)} rad`)
}
{
  const g = makeView(1280, 800)
  g.zoomBy(16)
  g.settle()
  g.view.setTilted(true)
  g.settle()
  check('tilt on: no outline', g.view.silhouette() === null)
  g.view.setTilted(false)
  g.settle(30)
  const easing = g.view.silhouette() === null
  g.settle(600)
  check('tilt off again: the outline back once the camera looks at the centre', easing && g.view.silhouette() !== null)
}

// --- 2. a step on the arc is a step along the limb ------------------------------
console.log('2. a step of S km on the arc is S km along the limb')
for (const [w, h] of CANVASES) {
  const g = makeView(w, h)
  g.settle(5)
  const lines = []
  let worst = 0
  for (const notches of ZOOMS) {
    g.zoomBy(notches - (ZOOMS[ZOOMS.indexOf(notches) - 1] ?? 0))
    g.settle()
    const s = g.view.silhouette()
    // The geometry alone: room enough on the right, the whole height free.
    const layout = A.globeArcLayout(s, { left: 0, top: 0, right: 1e6, bottom: h }, () => 60, true)
    if (!layout) { lines.push(`${notches}: none`); continue }
    const L = g.limb()
    // The limb's angle θ whose projection lies at the screen angle ψ:
    // bisection on the projected angle, near the offset found in 1.
    const offset = screenAngle(s, g.project(L.at(0)))
    const thetaAt = (psi) => {
      let lo = psi - offset - 0.1
      let hi = psi - offset + 0.1
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2
        if (wrap(screenAngle(s, g.project(L.at(mid))) - psi) < 0) lo = mid
        else hi = mid
      }
      return (lo + hi) / 2
    }
    const majors = layout.ticks.filter((t) => t.major).map((t) => L.at(thetaAt(t.psi)))
    let small = 0
    let great = 0
    for (let i = 1; i < majors.length; i++) {
      const a = majors[i - 1].subtract(L.centre).normalize()
      const b = majors[i].subtract(L.centre).normalize()
      const along = Math.acos(Math.min(1, B.Vector3.Dot(a, b))) * L.r * RADIUS_METRES
      worst = Math.max(worst, Math.abs(along / (layout.stepKm * 1000) - 1))
      small = along
      great = Math.acos(Math.min(1, B.Vector3.Dot(majors[i - 1].normalize(), majors[i].normalize()))) * RADIUS_METRES
    }
    lines.push(`${notches}: ${majors.length - 1} × ${layout.stepKm} km (small circle ${(small / 1000).toFixed(3)}, great circle ${(great / 1000).toFixed(1)})`)
  }
  check(`${w}×${h}: each step along the limb`, worst < 1e-6, `max ${worst.toExponential(2)} rel.; ${lines.join('; ')}`)
}

// --- 3. the switch ------------------------------------------------------------------
console.log('3. the arc shows while it fits, with a hysteresis')
const label = (km) => 7 * `${km.toLocaleString('en')} km`.length
for (const [name, w, h, area] of [
  ['1600×800, all free', 1600, 800, { left: 0, top: 0, right: 1, bottom: 1 }],
  ['1280×800, the screen\'s bars', 1280, 800, { left: 300 / 1280, top: 56 / 800, right: 1, bottom: (800 - 64) / 800 }],
]) {
  const g = makeView(w, h)
  g.view.setFreeArea(area)
  g.settle()
  const free = { left: area.left * w, top: area.top * h, right: area.right * w, bottom: area.bottom * h }
  let shown = A.globeArcLayout(g.view.silhouette(), free, label, false) !== null
  check(`${name}: shown at the far zoom`, shown)
  // A slow sweep: a 5 px wheel delta per frame (a trackpad's glide), in
  // to the close shot and out again; the arc's state per frame.
  const switches = []
  for (const [dir, frames] of [[1, 900], [-1, 900]]) {
    for (let i = 0; i < frames; i++) {
      g.zoomBy(dir, 5)
      g.frame()
      const s = g.view.silhouette()
      const now = s ? A.globeArcLayout(s, free, label, shown) !== null : false
      if (now !== shown) switches.push({ dir, now, radius: s ? s.radius : NaN })
      shown = now
    }
  }
  const ins = switches.filter((x) => x.dir === 1)
  const outs = switches.filter((x) => x.dir === -1)
  check(`${name}: hidden when the globe fills the area`, ins.length === 1 && !ins[0].now, `${ins.length} switch(es) zooming in, hidden at radius ${ins[0]?.radius.toFixed(1)} px`)
  check(`${name}: back once zooming out, at a smaller globe`, outs.length === 1 && outs[0].now && outs[0].radius < ins[0].radius - 10, `${outs.length} switch(es) zooming out, shown at radius ${outs[0]?.radius.toFixed(1)} px`)
}
{
  const g = makeView(1600, 800)
  g.zoomBy(30)
  g.settle()
  check('the close shot: no arc', A.globeArcLayout(g.view.silhouette(), { left: 0, top: 0, right: 1600, bottom: 800 }, label, true) === null)
}

// --- 4. the corner bar ----------------------------------------------------------------
console.log('4. the corner bar measures at the screen\'s centre')
for (const tilted of [false, true]) {
  for (const notches of [0, 12, 30]) {
    const g = makeView(1280, 800)
    g.view.setTilted(tilted)
    g.zoomBy(notches)
    g.settle(800)
    const cx = 640
    const cy = 400
    // As the screen asks it (GeneratorScreen.ts: ScaleBar's `at`, the
    // view's chartAt and metresBetween).
    const a = g.view.chartAt(cx - PROBE_PX / 2, cy)
    const b = g.view.chartAt(cx + PROBE_PX / 2, cy)
    const perPx = g.view.metresBetween(a, b) / PROBE_PX
    // Independently: the centre's ray meets the globe at the distance t;
    // the camera's right is across the plane of the eye, the centre and
    // that point, so a pixel to the side moves the point by t times the
    // pixel's angle, not foreshortened.
    const eye = g.camera.position
    const dir = g.camera.getTarget().subtract(eye).normalize()
    const bq = B.Vector3.Dot(eye, dir)
    const t = -bq - Math.sqrt(bq * bq - (eye.lengthSquared() - 1))
    const expected = (t * RADIUS_METRES * 2 * Math.tan(g.camera.fov / 2)) / 800
    const err = Math.abs(perPx / expected - 1)
    check(`tilt ${tilted ? 'on ' : 'off'}, ${String(notches).padStart(2)} notches: metres per pixel at the centre`, err < 2e-4, `${perPx.toFixed(0)} m/px, expected ${expected.toFixed(0)} (${(err * 100).toFixed(3)} %)`)
  }
}

for (const view of views) view.dispose()
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
