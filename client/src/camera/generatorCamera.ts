import { Camera, Engine, FreeCamera, Observer, PointerEventTypes, PointerInfo, Scalar, Scene, Vector3 } from '@babylonjs/core'

// The flat map screens' camera rig (worldgen + worldmap; the sphere screen
// has its own, orbitSwoopCamera). Two regimes on ONE continuous zoom axis:
//
// MAP (z in 0..1): orthographic — a strategy map should read at a consistent
// scale regardless of camera height, with no perspective distortion toward
// the edges, and a *tilted* orthographic view is a clean axonometric relief
// shot. Zoom adjusts the frustum's world-space extent EXPONENTIALLY in z
// (equal steps = equal percentage change). Tilt is an envelope coupled to
// zoom — min(desiredTilt, maxTiltForZoom(z)) — so zooming out presses the
// view back to top-down with no separate return animation. Yaw (Q/E) only
// accumulates while the envelope is open and folds back to north outside it.
//
// NEAR (z in 1..2, opt-in via nearModeEnabled — the worldmap screen): the
// same camera flips to PERSPECTIVE at z = 1, with its distance chosen so the
// framing at the focus point matches the orthographic view exactly — the
// projection change itself is the only visible difference, so the handover
// reads as "the world gains depth", not as a cut. From there the wheel
// steers ALTITUDE (again exponentially, down to nearMinAltitude) while the
// pitch eases from maxTiltDeg toward horizonPitchDeg — near the ground the
// horizon sits high in the frame and the sky (the screen's business — see
// getNearBlend) occupies the top. An orthographic camera can never show a
// horizon (parallel rays: the ground plane fills the viewport at any tilt),
// which is why this regime exists at all.
//
// WASD pans in SCREEN space (yaw-aware), scaled to the visible extent at the
// focus, so a key press crosses the same fraction of the view at every zoom
// in both regimes. See docs/design/hex-world-view.md.
//
// upVector stays HORIZONTAL at all times ((sin yaw, 0, cos yaw) — world +Z
// un-yawed): never parallel to any view direction this rig can produce
// (straight-down included), so look-at re-derivation is always stable; and
// for a given view direction it lies in the same vertical plane as the
// world-up choice, so it yields the identical (level-horizon) roll.

export interface GeneratorCameraOptions {
  scene: Scene
  canvas: HTMLCanvasElement
  engine: Engine
  // Size, in world units, of one full toroidal period of the map along
  // each axis — panning worldWidth in X (or worldHeight in Z) returns you
  // to where you started. The caller (not this module) is responsible
  // for actually tiling/recentering wrapped geometry around wherever
  // camera.position ends up.
  worldWidth: number
  worldHeight: number
  // Fraction of the world's width/height visible at minimum zoom (most
  // zoomed out). Deliberately a little under 1 (spec: 80-90%) so the
  // wrapped repeat visibly peeks in at both edges, proving the
  // wraparound works rather than just trusting it.
  minZoomWorldFraction?: number
  // Fraction of the world's width/height visible at maximum MAP zoom while
  // the deep-zoom unlock is off. Kept shallow on purpose: before erosion
  // the map has no relief mesh and the texture has nothing to show closer.
  maxZoomWorldFraction?: number
  // Fraction visible at maximum MAP zoom once deep zoom is unlocked
  // (setDeepZoomEnabled). ~0.03 shows ~500 km across — the range where the
  // relief displacement becomes readable; see docs/design/hex-world-view.md.
  deepMaxZoomWorldFraction?: number
  // Envelope ceiling: how far off vertical the MAP view may tilt at full
  // map zoom. 60° by default — an orthographic tilt has no horizon or
  // perspective cue, so it needs to lean harder than a perspective camera
  // would for the relief to register. Also the pitch the NEAR regime starts
  // from.
  maxTiltDeg?: number
  // Normalized zoom where the tilt/yaw envelope starts opening / is fully
  // open. Zoom is EXPONENTIAL in z; the defaults correspond to ~12 and ~4
  // world units of visible width.
  tiltStartZoom?: number
  tiltFullZoom?: number
  // Cap on how much one wheel event may move the normalized zoom. Actual
  // per-event movement scales with the event's delta, so trackpads (many
  // tiny deltas) glide while a clicky mouse wheel steps at most this much.
  zoomStep?: number
  zoomEaseRate?: number
  cameraHeight?: number
  // WASD pan speed as a fraction of the visible extent crossed per second.
  keyPanViewFractionPerSecond?: number
  // Q/E yaw speed in radians per second.
  yawRatePerSecond?: number
  // --- NEAR regime (all ignored unless nearModeEnabled) ---
  nearModeEnabled?: boolean
  // Vertical field of view of the perspective camera, radians.
  fovRad?: number
  // Camera altitude above the ground plane at the deepest zoom (z = 2), in
  // world units. The screen owns the metres-to-units conversion.
  nearMinAltitude?: number
  // The DRAWN ground's world Y under the focus — exaggeration included, since
  // that is the surface the camera can actually collide with. Supplied by the
  // screen, which owns both the height sampler and the current exaggeration;
  // without it the near regime measures its altitude from sea level and flies
  // into every mountain. Omitted (the generator's preview) means a flat
  // datum, i.e. exactly the old behaviour.
  getGroundHeight?: () => number
  // Pitch from vertical at the deepest zoom. 76° puts the horizon around
  // the top fifth of the frame at the default fov.
  horizonPitchDeg?: number
  // The near regime's pitch FREEDOM band (R/F keys): the zoom curve only
  // provides the default; the user may tilt between these limits. The
  // offset resets when leaving the near regime — zooming out always
  // returns to the standard orientation, same philosophy as tilt/yaw.
  nearPitchMinDeg?: number
  nearPitchMaxDeg?: number
  // R/F pitch adjust speed in radians per second.
  pitchRatePerSecond?: number
}

export interface GeneratorCamera {
  camera: FreeCamera
  dispose: () => void
  // The ground point pan currently keeps centered. Callers that need
  // "where is the map logically centered" (e.g. toroidal-tile recentering)
  // should use this instead of camera.position.x/z — the camera's own
  // position is offset backward from this point once tilted.
  getFocus: () => { x: number; z: number }
  // Enable/disable pan-by-drag. Used to hand the pointer to another drag
  // consumer without the map panning underneath it. Disabling also cancels
  // any pan in progress. Keyboard pan is unaffected.
  setPanEnabled: (enabled: boolean) => void
  // Unlock (or re-lock) the deeper zoom ceiling (and, when nearModeEnabled,
  // the near regime beyond it). The current zoom state is remapped so the
  // visible extent doesn't jump when the ceiling changes mid-zoom. Locking
  // also forces the tilt/yaw envelope shut.
  setDeepZoomEnabled: (enabled: boolean) => void
  // The tilt the user WANTS, in radians off vertical. Applied tilt is
  // min(desired, envelope(zoom)), eased — safe to set at any zoom. Values
  // above maxTiltDeg clamp to it, so Infinity means "as far as allowed".
  setDesiredTilt: (angleRadians: number) => void
  // Current EASED zoom: 0..1 map regime, 1..2 near regime. What the view is
  // actually showing this frame, not the wheel's target.
  getZoom: () => number
  // Current EASED yaw in radians (0 = north-up). For consumers that keep
  // something aligned with the screen — e.g. the relief light.
  getYaw: () => number
  // How far into the NEAR regime the view is (0 = map, 1 = deepest) — the
  // screen keys sky/fog/light blending off this.
  getNearBlend: () => number
  // Camera altitude above the ground plane in world units (the fixed rig
  // height while in the map regime).
  getAltitude: () => number
  // The visible world width at the focus row this frame (world units) —
  // divided by the render width it is the same world-units-per-pixel the
  // drag pan converts with. Exact at the focus; a tilted view's ratio
  // genuinely varies with on-screen depth.
  getViewWidth: () => number
}

// Wrap an angle into (-π, π] so the automatic return-to-north always takes
// the short way round, however far Q/E have been held.
const wrapAngle = (a: number): number => {
  const twoPi = Math.PI * 2
  const w = ((a + Math.PI) % twoPi + twoPi) % twoPi - Math.PI
  return w === -Math.PI ? Math.PI : w
}

export function createGeneratorCamera(options: GeneratorCameraOptions): GeneratorCamera {
  const {
    scene,
    canvas,
    engine,
    worldWidth,
    worldHeight,
    minZoomWorldFraction = 0.85,
    maxZoomWorldFraction = 0.1,
    deepMaxZoomWorldFraction = 0.03,
    maxTiltDeg = 60,
    tiltStartZoom = 0.18,
    tiltFullZoom = 0.48,
    zoomStep = 0.04,
    zoomEaseRate = 6,
    cameraHeight = 50,
    keyPanViewFractionPerSecond = 0.6,
    yawRatePerSecond = Math.PI * 0.6,
    nearModeEnabled = false,
    fovRad = 0.8,
    nearMinAltitude = 0.003,
    getGroundHeight,
    horizonPitchDeg = 76,
    nearPitchMinDeg = 40,
    nearPitchMaxDeg = 80,
    pitchRatePerSecond = (35 * Math.PI) / 180,
  } = options

  const maxTilt = (maxTiltDeg * Math.PI) / 180
  const horizonPitch = (horizonPitchDeg * Math.PI) / 180
  const nearPitchMin = (nearPitchMinDeg * Math.PI) / 180
  const nearPitchMax = (nearPitchMaxDeg * Math.PI) / 180

  const camera = new FreeCamera('generatorCamera', new Vector3(0, cameraHeight, 0), scene)
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA
  camera.minZ = 1
  camera.maxZ = cameraHeight * 4
  camera.fov = fovRad
  camera.upVector = new Vector3(0, 0, 1)
  camera.setTarget(new Vector3(0, 0, 0))

  let deepZoomEnabled = false
  const activeMaxFraction = (): number => (deepZoomEnabled ? deepMaxZoomWorldFraction : maxZoomWorldFraction)
  const maxZoomBound = (): number => (deepZoomEnabled && nearModeEnabled ? 2 : 1)

  // Zoom is EXPONENTIAL in t: visible extent = far · (near/far)^t, so every
  // equal step in t changes the view by the same PERCENTAGE. A linear lerp
  // makes deep-end steps feel enormous (the same absolute width change is a
  // third of the view down there) — the standard map-zoom fix.
  const zoomedExtent = (far: number, near: number, zoomT: number): number => far * Math.pow(near / far, zoomT)

  // The width/height the "cover" fit (see updateOrthoExtents) shows at map
  // zoom t — also the handover framing the near regime must match at t = 1.
  const coverExtents = (zoomT: number): { halfWidth: number; halfHeight: number } => {
    const maxFraction = activeMaxFraction()
    const visibleWorldWidth = zoomedExtent(worldWidth / minZoomWorldFraction, worldWidth * maxFraction, zoomT)
    const visibleWorldHeight = zoomedExtent(worldHeight / minZoomWorldFraction, worldHeight * maxFraction, zoomT)
    const aspect = engine.getRenderWidth() / engine.getRenderHeight()
    let halfWidth = visibleWorldWidth / 2
    let halfHeight = halfWidth / aspect
    if (halfHeight > visibleWorldHeight / 2) {
      halfHeight = visibleWorldHeight / 2
      halfWidth = halfHeight * aspect
    }
    return { halfWidth, halfHeight }
  }

  // Fills the whole canvas with the map WITHOUT distorting it ("cover", the
  // way background-size: cover fits an image): aspect preserved, the
  // overflowing axis cropped — a narrow screen shows a slice of the world at
  // full size, not the whole world tiled into the margin.
  const updateOrthoExtents = (zoomT: number): void => {
    const { halfWidth, halfHeight } = coverExtents(zoomT)
    camera.orthoLeft = -halfWidth
    camera.orthoRight = halfWidth
    camera.orthoTop = halfHeight
    camera.orthoBottom = -halfHeight
  }
  // Computed once immediately (not just in the render loop) so
  // orthoLeft/orthoRight are never null when the pan handler below reads
  // them, however early a pointer event fires.
  updateOrthoExtents(0)

  // The ground point pan keeps centered; the camera's position derives from
  // it plus tilt/yaw/height.
  let focusX = 0
  let focusZ = 0
  // The tilt/yaw actually applied this frame vs. what the user asked for —
  // see the envelope logic in the render observer.
  let tiltAngle = 0
  let desiredTilt = 0
  let yawAngle = 0
  let desiredYaw = 0
  // User pitch adjustment (R/F) relative to the near regime's zoom-default
  // pitch curve; cleared whenever the view is back in the map regime.
  let nearPitchOffset = 0
  // Camera height above the GROUND: the fixed rig height in the map regime
  // (orthographic — height doesn't affect apparent size), the LIVE altitude
  // in the near regime.
  let viewHeight = cameraHeight
  // The drawn ground's own height under the focus, which everything above is
  // measured FROM in the near regime. Zero on the map, where "altitude" is a
  // rig constant and terrain-relative would mean nothing.
  //
  // Without this the descent's floor is a height above SEA LEVEL, and over a
  // 4,000 m range the camera is simply inside the mountain — reported
  // 2026-08-15, and it is also why every near-field screenshot from the
  // mountains was taken at a grazing angle from within the surface. Note it
  // has to be the DRAWN ground, exaggeration included: during the descent the
  // terrain is still drawn up to six times its true relief, so the mountain
  // that swallows the camera is the drawn one, not the metre-true one.
  let groundHeight = 0
  // Ground-plane width visible at the focus this frame — the pan/drag scale
  // for both regimes (ortho extents are stale while in the near regime).
  let viewWidthAtFocus = coverExtents(0).halfWidth * 2

  // Screen-space basis on the ground plane for the current yaw: which world
  // XZ direction is "up" / "right" on screen. Un-yawed: up = +Z, right = +X.
  const screenUp = (): { x: number; z: number } => ({ x: Math.sin(yawAngle), z: Math.cos(yawAngle) })
  const screenRight = (): { x: number; z: number } => ({ x: Math.cos(yawAngle), z: -Math.sin(yawAngle) })

  // Re-derive camera.position (and, when off the plain top-down north-up
  // view, orientation) from focus + tilt + yaw + height. At tilt = yaw = 0
  // this is the original untilted behavior exactly — position set directly,
  // rotation never touched — which keeps a steady-state top-down view free
  // of per-frame look-at re-derivation.
  const applyView = (): void => {
    if (tiltAngle === 0 && yawAngle === 0) {
      camera.position.x = focusX
      camera.position.z = focusZ
      camera.position.y = groundHeight + viewHeight
      return
    }
    // The camera stays viewHeight above the ground but pulls back along the
    // screen-down direction as tilt increases, so the focus point — not the
    // camera — is the pivot.
    const backOffset = viewHeight * Math.tan(tiltAngle)
    const up = screenUp()
    camera.upVector.set(up.x, 0, up.z)
    // Both ends rise with the ground: lifting only the camera would tilt the
    // view down into the hillside by exactly the height it was lifted.
    camera.position.set(focusX - up.x * backOffset, groundHeight + viewHeight, focusZ - up.z * backOffset)
    camera.setTarget(new Vector3(focusX, groundHeight, focusZ))
  }

  let isDragging = false
  let panEnabled = true
  let lastPointerX = 0
  let lastPointerY = 0
  const pointerObserver: Observer<PointerInfo> | null = scene.onPointerObservable.add((pointerInfo) => {
    if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
      isDragging = true
      lastPointerX = pointerInfo.event.clientX
      lastPointerY = pointerInfo.event.clientY
    } else if (pointerInfo.type === PointerEventTypes.POINTERUP) {
      isDragging = false
    } else if (pointerInfo.type === PointerEventTypes.POINTERMOVE && isDragging && panEnabled) {
      const deltaX = pointerInfo.event.clientX - lastPointerX
      const deltaY = pointerInfo.event.clientY - lastPointerY
      lastPointerX = pointerInfo.event.clientX
      lastPointerY = pointerInfo.event.clientY
      // Converts a pixel drag into world units at the CURRENT zoom, so a
      // drag always moves the point under the cursor by the same amount the
      // cursor itself moved — "grab and slide the map" — in SCREEN
      // directions, so it keeps meaning that under yaw too. Based on the
      // extent at the focus; a tilted view's pixel-to-world ratio genuinely
      // varies with on-screen depth, so this is exact only at the focus row
      // — an acceptable inexactness for a view whose main interaction is
      // looking.
      const worldUnitsPerPixel = viewWidthAtFocus / engine.getRenderWidth()
      const up = screenUp()
      const right = screenRight()
      focusX += (-deltaX * right.x + deltaY * up.x) * worldUnitsPerPixel
      focusZ += (-deltaX * right.z + deltaY * up.z) * worldUnitsPerPixel
      applyView()
    }
  })

  let targetZoom = 0
  let currentZoom = 0
  // Per-pixel wheel sensitivity: a clicky mouse notch (~100px of deltaY)
  // lands near the zoomStep cap; a trackpad's stream of small deltas moves
  // in far finer increments instead of one full step per event.
  const ZOOM_WHEEL_SENSITIVITY = 0.0003
  const handleWheel = (event: WheelEvent): void => {
    event.preventDefault()
    // Natural scroll convention: scrolling up/forward (negative deltaY)
    // zooms in. deltaMode 1 = lines (some mice/browsers) → ~33px per line.
    const deltaPx = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY
    const step = Scalar.Clamp(deltaPx * ZOOM_WHEEL_SENSITIVITY, -zoomStep, zoomStep)
    targetZoom = Scalar.Clamp(targetZoom - step, 0, maxZoomBound())
  }
  canvas.addEventListener('wheel', handleWheel, { passive: false })

  // WASD pan + Q/E yaw. Window-level so the canvas doesn't need focus, with
  // the usual guards: never while typing in a form control, never with a
  // modifier held (cmd+W must stay "close tab", not "pan and close").
  const pressedKeys = new Set<string>()
  const HANDLED_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'r', 'f'])
  const isTypingTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable
  }
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return
    const key = event.key.toLowerCase()
    if (HANDLED_KEYS.has(key)) pressedKeys.add(key)
  }
  const handleKeyUp = (event: KeyboardEvent): void => {
    pressedKeys.delete(event.key.toLowerCase())
  }
  const handleWindowBlur = (): void => {
    pressedKeys.clear() // keyup never arrives once focus is gone
  }
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  window.addEventListener('blur', handleWindowBlur)

  // How far the envelope allows tilting at the given map zoom: shut until
  // tiltStartZoom, fully open at tiltFullZoom — and always shut while the
  // deep-zoom unlock is off (a tilted flat map is just a skewed picture).
  // Yaw shares the same gate as a boolean: open or folding back to north.
  const envelopeTilt = (zoomT: number): number => {
    if (!deepZoomEnabled) return 0
    return maxTilt * Scalar.Clamp((zoomT - tiltStartZoom) / (tiltFullZoom - tiltStartZoom), 0, 1)
  }
  const envelopeOpen = (zoomT: number): boolean => deepZoomEnabled && zoomT > tiltStartZoom

  const renderObserver = scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000
    const easeFactor = 1 - Math.exp(-zoomEaseRate * dt)
    currentZoom = Scalar.Lerp(currentZoom, targetZoom, easeFactor)

    const near = nearModeEnabled && currentZoom > 1
    const nearU = near ? currentZoom - 1 : 0
    let tiltTarget: number
    if (!near) {
      // MAP regime: orthographic, exponential extent, tilt by envelope.
      if (camera.mode !== Camera.ORTHOGRAPHIC_CAMERA) {
        camera.mode = Camera.ORTHOGRAPHIC_CAMERA
        camera.minZ = 1
        camera.maxZ = cameraHeight * 4
      }
      viewHeight = cameraHeight
      groundHeight = 0
      updateOrthoExtents(Math.min(1, currentZoom))
      viewWidthAtFocus = camera.orthoRight! - camera.orthoLeft!
      tiltTarget = Math.min(desiredTilt, envelopeTilt(currentZoom))
      nearPitchOffset = 0 // back on the map: the next descent starts on the curve
    } else {
      // NEAR regime: perspective, altitude-driven. The handover altitude is
      // re-derived from the map's z = 1 framing every frame (it depends on
      // the live aspect), so the crossing always matches exactly: at the
      // focus, distance d0 shows the same width the ortho view showed.
      if (camera.mode !== Camera.PERSPECTIVE_CAMERA) {
        camera.mode = Camera.PERSPECTIVE_CAMERA
      }
      const { halfWidth } = coverExtents(1)
      const aspect = engine.getRenderWidth() / engine.getRenderHeight()
      const tanHalfHorizontalFov = Math.tan(fovRad / 2) * aspect
      const handoverDistance = halfWidth / tanHalfHorizontalFov
      const handoverAltitude = handoverDistance * Math.cos(maxTilt)
      const altitude = handoverAltitude * Math.pow(nearMinAltitude / handoverAltitude, nearU)
      viewHeight = altitude
      // Ramped in over the descent. At the handover the ground is drawn at
      // its most exaggerated, so adopting it whole there would pop the camera
      // up by tens of kilometres in one frame; by the bottom, where the
      // altitude is small and the ground is the thing you can hit, it counts
      // fully.
      groundHeight = Math.max(0, getGroundHeight?.() ?? 0) * nearU
      // The zoom curve provides the DEFAULT pitch; the user's R/F offset
      // moves within [nearPitchMin, nearPitchMax]. Re-deriving the offset
      // from the clamped result keeps it from accumulating past the band.
      const defaultPitch = Scalar.Lerp(maxTilt, horizonPitch, nearU)
      if (pressedKeys.has('r')) nearPitchOffset += pitchRatePerSecond * dt
      if (pressedKeys.has('f')) nearPitchOffset -= pitchRatePerSecond * dt
      tiltTarget = Scalar.Clamp(defaultPitch + nearPitchOffset, nearPitchMin, nearPitchMax)
      nearPitchOffset = tiltTarget - defaultPitch
      // Clip planes follow the altitude; the far plane doubles as the
      // visibility budget the screen's fog should sit just inside (it also
      // hard-culls the wrap copies beyond the haze).
      camera.minZ = Math.max(altitude * 0.02, 1e-5)
      camera.maxZ = Math.min(altitude * 60, worldWidth * 1.2)
      viewWidthAtFocus = 2 * (altitude / Math.max(0.05, Math.cos(tiltAngle))) * tanHalfHorizontalFov
    }

    // Keyboard pan: screen-space directions, speed tied to the visible
    // extent so a key press always crosses the same fraction of the view
    // regardless of zoom or regime.
    let panned = false
    if (pressedKeys.size > 0) {
      const step = viewWidthAtFocus * keyPanViewFractionPerSecond * dt
      const up = screenUp()
      const right = screenRight()
      let moveX = 0
      let moveZ = 0
      if (pressedKeys.has('w')) { moveX += up.x; moveZ += up.z }
      if (pressedKeys.has('s')) { moveX -= up.x; moveZ -= up.z }
      if (pressedKeys.has('d')) { moveX += right.x; moveZ += right.z }
      if (pressedKeys.has('a')) { moveX -= right.x; moveZ -= right.z }
      if (moveX !== 0 || moveZ !== 0) {
        const norm = Math.hypot(moveX, moveZ)
        focusX += (moveX / norm) * step
        focusZ += (moveZ / norm) * step
        panned = true
      }
      // Q/E only accumulate while the envelope is open (the near regime is
      // always past it) — at far zoom the orientation belongs to the map.
      if (envelopeOpen(currentZoom)) {
        if (pressedKeys.has('q')) desiredYaw = wrapAngle(desiredYaw - yawRatePerSecond * dt)
        if (pressedKeys.has('e')) desiredYaw = wrapAngle(desiredYaw + yawRatePerSecond * dt)
      }
    }

    // Tilt eases toward its regime target; yaw toward desired while the
    // envelope is open, back to north when it shuts (which also clears the
    // remembered yaw). Both SNAP onto their target when close. In the map
    // regime the settled state stops touching the camera entirely (the
    // anti-roll-drift property of the original top-down design); the near
    // regime re-derives every frame — its view direction is never vertical,
    // so the re-derivation is stable, and altitude changes with the zoom
    // ease anyway.
    const yawTarget = envelopeOpen(currentZoom) ? desiredYaw : 0
    if (yawTarget === 0 && !envelopeOpen(currentZoom)) desiredYaw = 0
    const animating = tiltAngle !== tiltTarget || yawAngle !== yawTarget
    if (animating) {
      const nextTilt = Scalar.Lerp(tiltAngle, tiltTarget, easeFactor)
      tiltAngle = Math.abs(nextTilt - tiltTarget) < 0.001 ? tiltTarget : nextTilt
      // Ease along the short way round, so a 350° accumulated yaw returns
      // via -10°, not by unwinding a full turn.
      const yawDelta = wrapAngle(yawTarget - yawAngle)
      const nextYaw = yawAngle + yawDelta * easeFactor
      yawAngle = Math.abs(wrapAngle(yawTarget - nextYaw)) < 0.001 ? yawTarget : wrapAngle(nextYaw)
      applyView()
    } else if (panned || near) {
      applyView()
    }
  })

  return {
    camera,
    getFocus() {
      return { x: focusX, z: focusZ }
    },
    setPanEnabled(enabled: boolean) {
      panEnabled = enabled
      if (!enabled) isDragging = false // cancel any pan in progress
    },
    setDeepZoomEnabled(enabled: boolean) {
      if (enabled === deepZoomEnabled) return
      // Remap both zoom values so the currently visible extent is preserved
      // across the ceiling change: the same world width W corresponds to a
      // different normalized t once the lerp's near end moves. (Only the
      // map range needs remapping — the near regime only exists while deep
      // zoom is on, and its altitudes are t-independent.)
      const far = worldWidth / minZoomWorldFraction
      const oldNear = worldWidth * activeMaxFraction()
      deepZoomEnabled = enabled
      const newNear = worldWidth * activeMaxFraction()
      const remap = (t: number): number => {
        const visible = zoomedExtent(far, oldNear, Math.min(1, t))
        if (far === newNear) return 0
        return Scalar.Clamp(Math.log(far / visible) / Math.log(far / newNear), 0, 1)
      }
      currentZoom = remap(currentZoom)
      targetZoom = remap(targetZoom)
      updateOrthoExtents(currentZoom)
    },
    setDesiredTilt(angleRadians: number) {
      desiredTilt = Math.max(0, Math.min(maxTilt, angleRadians))
    },
    getZoom() {
      return currentZoom
    },
    getYaw() {
      return yawAngle
    },
    getNearBlend() {
      return nearModeEnabled ? Scalar.Clamp(currentZoom - 1, 0, 1) : 0
    },
    getAltitude() {
      return viewHeight
    },
    getViewWidth() {
      return viewWidthAtFocus
    },
    dispose() {
      scene.onPointerObservable.remove(pointerObserver)
      scene.onBeforeRenderObservable.remove(renderObserver)
      canvas.removeEventListener('wheel', handleWheel)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleWindowBlur)
      camera.dispose()
    },
  }
}
