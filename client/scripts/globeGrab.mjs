// Check of THE GLOBE'S DRAG (camera/globeGrab.ts, camera/orbitSwoopCamera.ts):
// the orbit rig run for real on Babylon's NullEngine, with the globe's
// lean and spin nodes as map/sphereView.ts hangs them, driven by pointer
// and wheel events and frames of a chosen length.
//
//   node scripts/globeGrab.mjs
//
// A sibling of scripts/symbolPlacement.mjs, not one of the four harnesses:
// a view's camera, a few seconds.
//
// What it says:
//  1. The far shot: the globe fills 90 % of the canvas's smaller side, on a
//     wide and on a tall canvas, and 90 % of the free height when bars cover
//     the canvas's top and bottom (setFreeArea).
//  2. The drag holds the grabbed point under the cursor (within 1 px), at
//     zoom 0, 0.5 and 1, tilt off and on, the globe spinning or not. Frames
//     where no roll-free view can hold it (a point near a pole dragged to
//     the side, the latitude at its limit) are counted, not judged.
//  3. No roll: after long curved drags the pivot's +y (the unleaned
//     vertical) has no part along the screen's horizontal and points up,
//     and the drawn axis still leans from it by the obliquity.
//  4. The latitude stays inside ±85°.
//  5. Off the globe the grab does not jump: a cursor that crosses the limb
//     turns the view by no more per frame than the cursor's step asks.
//  6. The momentum: the speed after the release falls to < 1 % in the same
//     time at 30, 60 and 144 fps, and the glide is the same length; bursty
//     pointer events give the glide of smooth ones.
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const B = await server.ssrLoadModule('@babylonjs/core')
const R = await server.ssrLoadModule('/src/camera/orbitSwoopCamera.ts')
const G = await server.ssrLoadModule('/src/camera/globeGrab.ts')
B.Logger.LogLevels = B.Logger.WarningLogLevel | B.Logger.ErrorLogLevel

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok    ${name}${detail ? `  ${detail}` : ''}`)
  else { failures++; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`) }
}
const deg = (r) => (r * 180) / Math.PI

// A seeded random, so that a failure comes back.
let seed = 12345
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}

const OBLIQUITY = (23.5 * Math.PI) / 180
const SPIN_RATE = (2 * Math.PI) / 180 // sphereView's SPIN_SECONDS_PER_TURN

// The rig with sphereView's graph: pivot → tilt (lean) → spin (turn).
function makeRig(width = 1280, height = 800) {
  const engine = new B.NullEngine({ renderWidth: width, renderHeight: height, textureSize: 64, deterministicLockstep: false, lockstepMaxSteps: 1 })
  let dtMs = 1000 / 60
  engine.getDeltaTime = () => dtMs
  const scene = new B.Scene(engine)
  let wheel = null
  const canvas = { addEventListener: (type, fn) => { if (type === 'wheel') wheel = fn }, removeEventListener: () => {} }
  const tilt = new B.TransformNode('tilt', scene)
  const spin = new B.TransformNode('spin', scene)
  spin.parent = tilt
  const rig = R.createOrbitSwoopCamera({ scene, canvas, engine, radius: 1, globeFrame: () => ({ lean: tilt.rotation.z, turn: spin.rotation.y }) })
  rig.camera.fov = 1.0
  tilt.parent = rig.viewPivot
  tilt.rotation.z = OBLIQUITY
  let spinning = false
  const pointer = (type, x, y) => {
    scene.pointerX = x
    scene.pointerY = y
    if (type) scene.onPointerObservable.notifyObservers({ type, event: {} }, type)
  }
  const frame = (ms = dtMs) => {
    dtMs = ms
    if (spinning) spin.rotation.y = (spin.rotation.y + SPIN_RATE * (ms / 1000)) % (2 * Math.PI)
    scene.onBeforeRenderObservable.notifyObservers(scene)
    rig.viewPivot.computeWorldMatrix(true)
    tilt.computeWorldMatrix(true)
    spin.computeWorldMatrix(true)
    rig.camera.computeWorldMatrix(true)
    rig.camera.getViewMatrix(true)
    rig.camera.getProjectionMatrix(true)
  }
  // A point of the globe's own frame on the screen, in pixels.
  const project = (local) => {
    const world = B.Vector3.TransformCoordinates(new B.Vector3(...local), spin.getWorldMatrix())
    const transform = rig.camera.getViewMatrix().multiply(rig.camera.getProjectionMatrix())
    const p = B.Vector3.Project(world, B.Matrix.Identity(), transform, rig.camera.viewport.toGlobal(width, height))
    return [p.x, p.y]
  }
  // The pixel's point on the globe, in the globe's own frame, or null.
  const surfaceAt = (x, y) => {
    const ray = scene.createPickingRay(x, y, B.Matrix.Identity(), rig.camera)
    const b = B.Vector3.Dot(ray.origin, ray.direction)
    const c = ray.origin.lengthSquared() - 1
    const disc = b * b - c
    if (disc < 0) return null
    const t = -b - Math.sqrt(disc)
    if (t <= 0) return null
    const world = ray.origin.add(ray.direction.scale(t))
    const inv = spin.getWorldMatrix().clone().invert()
    const p = B.Vector3.TransformCoordinates(world, inv)
    return { local: [p.x, p.y, p.z], world: [world.x, world.y, world.z] }
  }
  // The globe's axis in the world, the camera's right and up, and the
  // view centre's latitude (the hover direction is the camera's position).
  const axisState = () => {
    const a = B.Vector3.TransformNormal(B.Vector3.Up(), rig.viewPivot.getWorldMatrix()).normalize()
    const drawn = B.Vector3.TransformNormal(B.Vector3.Up(), spin.getWorldMatrix()).normalize()
    const right = rig.camera.getDirection(B.Vector3.Right())
    const up = rig.camera.getDirection(B.Vector3.Up())
    const c = rig.camera.position.clone().normalize()
    return {
      a,
      roll: Math.asin(B.Vector3.Dot(a, right)),
      upward: B.Vector3.Dot(a, up),
      phi: Math.asin(B.Vector3.Dot(a, c)),
      lean: Math.acos(Math.min(1, B.Vector3.Dot(a, drawn))),
      // The drawn axis's angle off the screen's vertical, through the view.
      drawnRoll: Math.atan2(B.Vector3.Dot(drawn, right), B.Vector3.Dot(drawn, up)),
    }
  }
  const zoomBy = (events) => {
    for (let i = 0; i < Math.abs(events); i++) wheel({ deltaY: events > 0 ? -100 : 100, deltaMode: 0, preventDefault() {} })
  }
  const settle = (frames = 400) => { for (let i = 0; i < frames; i++) frame(1000 / 60) }
  return {
    engine, scene, rig, tilt, spin, pointer, frame, project, surfaceAt, axisState, zoomBy, settle, width, height,
    setSpinning(on) { spinning = on },
    altitude: () => rig.camera.position.length() - 1,
  }
}
const T = B.PointerEventTypes

// --- 1. the far shot ---------------------------------------------------------
console.log('1. the far shot fills 90 % of the smaller side')
// The third: a 56 px title bar over the top and a 64 px step bar over the
// bottom; the largest centred square in the rest is 2 · min(450 − 56,
// 836 − 450) = 772 px tall.
for (const [w, h, bars] of [[1280, 800, false], [600, 900, false], [1280, 900, true]]) {
  const s = makeRig(w, h)
  if (bars) s.rig.setFreeArea({ left: 0, top: 56 / h, right: 1, bottom: (h - 64) / h })
  s.settle(5)
  // The globe's extent along the screen's centre lines: the first and last
  // pixel whose ray meets it.
  const extent = (horizontal) => {
    let first = null
    let last = null
    const n = horizontal ? w : h
    for (let i = 0; i < n; i++) {
      const hit = horizontal ? s.surfaceAt(i + 0.5, h / 2) : s.surfaceAt(w / 2, i + 0.5)
      if (hit) { if (first === null) first = i; last = i }
    }
    return last - first + 1
  }
  const fill = extent(w < h) / (bars ? 772 : Math.min(w, h))
  check(`${w} × ${h}${bars ? ', bars' : ''}: diameter / ${bars ? 'free square' : 'smaller side'}`, Math.abs(fill - 0.9) < 0.01, `${(fill * 100).toFixed(1)} %, altitude ${s.altitude().toFixed(3)} R`)
}

// --- 2. the grab holds -------------------------------------------------------
console.log('2. the grabbed point stays under the cursor')
// A 100 px notch moves the log of the altitude by 0.064; the range is
// ln(1.27 / 0.15) = 2.14.
const ZOOM_EVENTS = { 0: 0, 0.5: 17, 1: 40 }
for (const zoom of [0, 0.5, 1]) {
  for (const tilted of [false, true]) {
    for (const spinning of [false, true]) {
      const s = makeRig()
      s.settle(5)
      s.zoomBy(ZOOM_EVENTS[zoom])
      s.rig.setTilted(tilted)
      s.settle()
      s.setSpinning(spinning)
      let worst = 0
      let judged = 0
      let offPlane = 0
      let atLimit = 0
      let worstUnheld = 0
      for (let drag = 0; drag < 12; drag++) {
        // A start on the globe.
        let x
        let y
        let start = null
        for (let tries = 0; tries < 200 && !start; tries++) {
          x = s.width * (0.2 + 0.6 * random())
          y = s.height * (0.2 + 0.6 * random())
          start = s.surfaceAt(x, y)
        }
        s.pointer(T.POINTERDOWN, x, y)
        const grabbed = start.local
        let heading = random() * 2 * Math.PI
        for (let step = 0; step < 60; step++) {
          heading += (random() - 0.5) * 0.6
          x = Math.min(s.width - 1, Math.max(0, x + Math.cos(heading) * 9))
          y = Math.min(s.height - 1, Math.max(0, y + Math.sin(heading) * 9))
          s.pointer(T.POINTERMOVE, x, y)
          s.frame(1000 / 60)
          const under = s.surfaceAt(x, y)
          if (!under) continue
          // Can a roll-free view hold it here? (globeGrab.ts: the cursor's
          // point must be as near the screen's vertical plane as g's
          // latitude asks, and the latitude inside its limit.)
          const st = s.axisState()
          const c = s.rig.camera.position.clone().normalize()
          const u = B.Vector3.Up().subtract(c.scale(c.y)).normalize()
          const t = new B.Vector3(...under.world)
          const reach = Math.hypot(B.Vector3.Dot(t, c), B.Vector3.Dot(t, u))
          const [px, py] = s.project(grabbed)
          const miss = Math.hypot(px - x, py - y)
          // Float32 matrices: the limit is met to 1e-4 rad.
          if (Math.abs(st.phi) > G.LATITUDE_LIMIT - 1e-4) { atLimit++; worstUnheld = Math.max(worstUnheld, miss); continue }
          // g's height on the pivot's vertical, now (the spin moves it).
          const gWorld = B.Vector3.TransformNormal(new B.Vector3(...grabbed), s.spin.getWorldMatrix())
          if (Math.abs(B.Vector3.Dot(gWorld, st.a)) > reach - 1e-6) { offPlane++; worstUnheld = Math.max(worstUnheld, miss); continue }
          worst = Math.max(worst, miss)
          judged++
        }
        s.pointer(T.POINTERUP, x, y)
        s.settle(150)
      }
      check(`zoom ${zoom}, tilt ${tilted ? 'on ' : 'off'}, spin ${spinning ? 'on ' : 'off'}`, worst < 1, `worst ${worst.toFixed(3)} px over ${judged} frames; not holdable: ${atLimit} at the latitude limit, ${offPlane} too far aside (miss ≤ ${worstUnheld.toFixed(0)} px); altitude ${s.altitude().toFixed(3)} R`)
    }
  }
}

// --- 3. no roll, 4. the latitude limit ---------------------------------------
console.log('3. no roll after long curved drags, the lean kept; 4. the latitude limit')
for (const tilted of [false, true]) {
  const s = makeRig()
  s.settle(5)
  s.zoomBy(17)
  s.rig.setTilted(tilted)
  s.settle()
  let worstRoll = 0
  let worstUp = 1
  let maxPhi = 0
  let worstLean = 0
  for (let loop = 0; loop < 30; loop++) {
    const cx = s.width / 2
    const cy = s.height / 2
    const r = 60 + 200 * random()
    s.pointer(T.POINTERDOWN, cx + r, cy)
    for (let i = 1; i <= 90; i++) {
      // Circles, spirals and long strokes up and down.
      const a = (i / 90) * 2 * Math.PI * (loop % 2 ? 1 : -1)
      const rr = loop % 3 === 0 ? r * (1 - i / 120) : r
      const y = loop % 5 === 4 ? cy + 400 * Math.sin(a) : cy + rr * Math.sin(a)
      s.pointer(T.POINTERMOVE, cx + rr * Math.cos(a), y)
      s.frame(1000 / 60)
      const st = s.axisState()
      worstRoll = Math.max(worstRoll, Math.abs(st.roll))
      worstUp = Math.min(worstUp, st.upward)
      maxPhi = Math.max(maxPhi, Math.abs(st.phi))
      worstLean = Math.max(worstLean, Math.abs(st.lean - OBLIQUITY))
    }
    s.pointer(T.POINTERUP, cx + r, cy)
    s.settle(60)
  }
  // Straight strokes far past a pole.
  for (const dir of [1, -1]) {
    for (let k = 0; k < 6; k++) {
      s.pointer(T.POINTERDOWN, s.width / 2, s.height / 2 - dir * 200)
      for (let i = 0; i < 40; i++) {
        s.pointer(T.POINTERMOVE, s.width / 2, s.height / 2 - dir * 200 + dir * i * 10)
        s.frame(1000 / 60)
        maxPhi = Math.max(maxPhi, Math.abs(s.axisState().phi))
        worstRoll = Math.max(worstRoll, Math.abs(s.axisState().roll))
      }
      s.pointer(T.POINTERUP, s.width / 2, s.height / 2 + dir * 200)
      s.settle(120)
      maxPhi = Math.max(maxPhi, Math.abs(s.axisState().phi))
    }
  }
  check(`tilt ${tilted ? 'on ' : 'off'}: roll`, worstRoll < 1e-6, `worst ${deg(worstRoll).toExponential(2)}°, axis·screen-up ≥ ${worstUp.toFixed(3)}`)
  check(`tilt ${tilted ? 'on ' : 'off'}: vertical up`, worstUp > 0)
  check(`tilt ${tilted ? 'on ' : 'off'}: the drawn axis leans by the obliquity`, worstLean < 1e-5, `off by ≤ ${deg(worstLean).toExponential(2)}°`)
  check(`tilt ${tilted ? 'on ' : 'off'}: |latitude| ≤ 85°`, maxPhi <= G.LATITUDE_LIMIT + 1e-4, `max ${deg(maxPhi).toFixed(4)}°`)
}

// --- 5. across the limb ------------------------------------------------------
console.log('5. the cursor across the limb')
{
  const s = makeRig()
  s.settle(5)
  const cy = s.height / 2
  s.pointer(T.POINTERDOWN, s.width / 2 + 100, cy)
  let prev = s.rig.viewPivot.rotationQuaternion.clone()
  let worstOn = 0
  let worstOff = 0
  let crossing = 0
  for (let x = s.width / 2 + 100; x < s.width; x += 4) {
    s.pointer(T.POINTERMOVE, x, cy)
    s.frame(1000 / 60)
    const q = s.rig.viewPivot.rotationQuaternion
    const turn = 2 * Math.acos(Math.min(1, Math.abs(B.Quaternion.Dot(prev, q))))
    prev = q.clone()
    const onGlobe = s.surfaceAt(x, cy) !== null
    if (onGlobe) worstOn = Math.max(worstOn, turn)
    else { if (worstOff === 0) crossing = turn; worstOff = Math.max(worstOff, turn) }
  }
  s.pointer(T.POINTERUP, s.width - 1, cy)
  check('no jump at the limb', crossing <= worstOn * 1.01 + 1e-9 && worstOff <= worstOn * 1.01 + 1e-9, `per 4 px step: on the globe ≤ ${deg(worstOn).toFixed(3)}°, first step off ${deg(crossing).toFixed(3)}°, off ≤ ${deg(worstOff).toFixed(3)}°`)
}

// --- 6. the momentum -----------------------------------------------------------
console.log('6. the momentum')
{
  // The pure step: the time to < 1 % and the glide, per frame rate.
  const tau = 0.4
  for (const fps of [30, 60, 144]) {
    let v = 1
    let moved = 0
    let frames = 0
    while (v >= 0.01) {
      const step = G.momentumStep(v, 1 / fps, tau)
      moved += step.move
      v = step.velocity
      frames++
    }
    check(`${fps} fps: < 1 % after ${frames} frames`, Math.abs(frames / fps - tau * Math.log(100)) < 1 / fps + 1e-9, `${(frames / fps).toFixed(3)} s, glide ${moved.toFixed(4)} (τ = ${tau}: 1.842 s, glide ≤ 0.4)`)
  }
  // End to end: the same drag (240 px/s for 0.5 s) at each frame rate, then
  // 3 s of glide. Bursty: the pointer moves only on every other frame, by
  // twice the step, and on every fifth frame not at all.
  const glide = (fps, bursty) => {
    const s = makeRig()
    s.settle(5)
    s.zoomBy(17)
    s.settle()
    const ms = 1000 / fps
    let x = s.width / 2 - 60
    const y = s.height / 2
    s.pointer(T.POINTERDOWN, x, y)
    const frames = Math.round(0.5 * fps)
    let pending = 0
    for (let i = 0; i < frames; i++) {
      pending += 240 / fps
      if (!bursty || (i % 2 === 1 && i % 5 !== 0) || i === frames - 1) {
        x += pending
        pending = 0
      }
      s.pointer(T.POINTERMOVE, x, y)
      s.frame(ms)
    }
    s.pointer(T.POINTERUP, x, y)
    const at = s.rig.viewPivot.rotationQuaternion.clone()
    let speed0 = null
    let speedLate = null
    let prev = at.clone()
    for (let t = 0; t < 3; t += 1 / fps) {
      s.frame(ms)
      const q = s.rig.viewPivot.rotationQuaternion
      const turn = 2 * Math.acos(Math.min(1, Math.abs(B.Quaternion.Dot(prev, q)))) * fps
      prev = q.clone()
      if (speed0 === null) speed0 = turn
      if (speedLate === null && t >= tau * Math.log(100)) speedLate = turn
    }
    const total = 2 * Math.acos(Math.min(1, Math.abs(B.Quaternion.Dot(at, s.rig.viewPivot.rotationQuaternion))))
    return { total, speed0, speedLate }
  }
  const ref = glide(60, false)
  for (const fps of [30, 60, 144]) {
    const g = glide(fps, false)
    check(`${fps} fps: glide`, Math.abs(g.total / ref.total - 1) < 0.05 && g.speedLate / g.speed0 < 0.01, `${deg(g.total).toFixed(3)}° (60 fps ${deg(ref.total).toFixed(3)}°), speed after 1.84 s ${((g.speedLate / g.speed0) * 100).toFixed(2)} % of the first frame's`)
  }
  for (const fps of [60, 144]) {
    const b = glide(fps, true)
    const smooth = glide(fps, false)
    check(`${fps} fps: bursty events glide as smooth ones`, Math.abs(b.total / smooth.total - 1) < 0.15, `${deg(b.total).toFixed(3)}° against ${deg(smooth.total).toFixed(3)}°`)
  }
  // A new pointer down stops it.
  const s = makeRig()
  s.settle(5)
  s.pointer(T.POINTERDOWN, 600, 400)
  for (let i = 0; i < 20; i++) { s.pointer(T.POINTERMOVE, 600 + i * 8, 400); s.frame() }
  s.pointer(T.POINTERUP, 760, 400)
  s.frame()
  s.pointer(T.POINTERDOWN, 760, 400)
  s.frame()
  const held = s.rig.viewPivot.rotationQuaternion.clone()
  s.frame()
  s.frame()
  const still = 2 * Math.acos(Math.min(1, Math.abs(B.Quaternion.Dot(held, s.rig.viewPivot.rotationQuaternion))))
  check('a pointer down stops the glide', still < 1e-6, `${deg(still).toExponential(2)}° in two frames`)
  s.pointer(T.POINTERUP, 760, 400)
  // A drag that only holds a spinning globe: no glide against the spin
  // after the release (the globe goes on spinning, the view stands).
  {
    const h = makeRig()
    h.settle(5)
    h.setSpinning(true)
    h.pointer(T.POINTERDOWN, 640, 380)
    for (let i = 0; i < 60; i++) { h.pointer(T.POINTERMOVE, 640, 380); h.frame() }
    h.pointer(T.POINTERUP, 640, 380)
    const before = h.rig.viewPivot.rotationQuaternion.clone()
    h.settle(120)
    const drift = 2 * Math.acos(Math.min(1, Math.abs(B.Quaternion.Dot(before, h.rig.viewPivot.rotationQuaternion))))
    check('holding a spinning globe: no glide after the release', drift < 1e-4, `${deg(drift).toExponential(2)}° in 2 s`)
  }
  // The reset: back to the opening view (axis up, φ0), eased.
  s.rig.reset()
  s.settle(600)
  const st = s.axisState()
  check('reset: back to the opening view', Math.abs(deg(st.phi) - 55) < 1e-3 && Math.abs(st.roll) < 1e-6, `φ ${deg(st.phi).toFixed(4)}°, the drawn axis ${deg(st.drawnRoll).toFixed(2)}° off the screen's vertical`)
}

await server.close()
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
