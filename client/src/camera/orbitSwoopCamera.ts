import { Engine, FreeCamera, Matrix, Observer, PointerInfo, Quaternion, Scalar, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { PointerEventTypes } from '@babylonjs/core'
import {
  createVelocityEstimator,
  globeViewBasis,
  globeFrameRotation,
  LATITUDE_LIMIT,
  type Mat3,
  momentumStep,
  mulVec,
  quaternionOfMatrix,
  solveGrab,
  surfaceUnderRay,
  transpose,
  type Vec3,
  viewRotation,
  wrapAngle,
} from './globeGrab'

// An ArcRotateCamera aimed at the sphere's own center can't produce a
// "tilt toward the horizon" effect no matter how its polar angle is
// driven: the closest point on a sphere to an external point always sits
// dead-ahead, perpendicular to the surface, so the camera ends up staring
// straight down into whatever's nearest at every angle. A camera that
// hovers above the surface with its own explicit, non-center look
// direction is what actually shows a horizon — the same conclusion the flat
// generator's own camera rig reached for the same reason (generatorCamera.ts).
//
// The drag turns the main object itself (viewPivot below) rather than
// moving the camera, so "orbit" and "zoom" stay on entirely separate
// controls — dragging can never affect zoom, and zooming can never affect
// the turn.
//
// THE DRAG HOLDS THE SURFACE (2026-10-11, globeGrab.ts). The point under
// the cursor at pointer down stays under the cursor while the drag goes on,
// at every zoom and with the tilt on: close to the surface the ground no
// longer races away under the cursor. The view is a longitude and a
// latitude with no roll, so the vertical stays up and the globe's axis
// keeps its lean (the obliquity); the latitude stays short of the poles. After the release the globe goes on at the drag's last velocity
// (fitted over the last 0.1 s), slowing as e^(−t / momentumTime): at
// 0.4 s, down to 1 % in 1.8 s, at any frame rate.
//
// ZOOM AND TILT ARE SEPARATE (2026-10-11). The wheel moves the camera
// STRAIGHT toward the surface: its altitude falls EXPONENTIALLY with the
// normalized zoom, so every wheel step changes the view by the same
// percentage, at the flat map's rate (generatorCamera.ts). The look toward
// the horizon is a toggle (setTilted), no longer a part of the zoom: off,
// the camera looks at the centre (straight down) at every zoom; on, it
// leans toward the horizon as it comes closer, to pitchDeg at the close
// shot — the old swoop. The camera eases between the two.

export interface OrbitSwoopCameraOptions {
  scene: Scene
  canvas: HTMLCanvasElement
  engine: Engine
  // Radius of the main object being orbited, in scene units. Every other
  // distance below is expressed relative to this, so the same defaults
  // work regardless of how large the object actually is.
  radius: number
  // How much of the free area the "whole object" overview shot fills: the
  // globe's diameter as a fraction of the largest square, centred in the
  // canvas, inside the free area (setFreeArea).
  farFill?: number
  // How far above the surface the close/horizon shot hovers, as a
  // fraction of radius.
  altitudeFactor?: number
  // How far below the local horizontal the close shot looks when tilted
  // (setTilted), in degrees.
  pitchDeg?: number
  // How far the camera's hover point sits from the pivot's north pole, in
  // degrees — purely which side of the object the whole rig faces.
  hoverBetaDeg?: number
  // The wheel, as the natural log of the view's change: per pixel of wheel
  // delta, and the most one wheel event may move. The view's width at the
  // surface goes with the altitude, so a step of s changes it by a factor
  // of e^s. A trackpad's many small deltas glide; a mouse notch (~100 px)
  // steps.
  zoomLogPerPixel?: number
  zoomLogStep?: number
  // How quickly the camera eases toward its target zoom and tilt each
  // second (higher = snappier).
  zoomEaseRate?: number
  // The globe's own frame under viewPivot: leaned about the pivot's z by
  // `lean` (the obliquity), then turned about its own leaned +y by `turn`
  // (the spin), both in radians. A grabbed point is held in it. Read every
  // frame. Without it, viewPivot's own frame. (What stays up on screen is
  // the pivot's +y, the unleaned vertical: the lean shows.)
  globeFrame?: () => { lean: number; turn: number }
  // The momentum's time constant, seconds: the velocity after the release
  // falls by e every momentumTime.
  momentumTime?: number
  // The span of the drag, seconds, that the release velocity is fitted to.
  velocityWindow?: number
  // The view centre's latitude stays inside ±latitudeLimit, radians.
  latitudeLimit?: number
  // Near clip plane, as a fraction of radius — needs to stay below the
  // close shot's altitudeFactor or the near plane clips the surface.
  minZFactor?: number
}

export interface OrbitSwoopCamera {
  camera: FreeCamera
  // Parent the main object (and anything that should spin/orbit with it)
  // to this — never to the camera itself, which never moves on drag. The
  // rig sets its rotation every frame.
  viewPivot: TransformNode
  // Back to the opening view, eased: zoomed out, the pivot unturned. A drag meanwhile takes over from where the easing has
  // got to; the momentum stops. The tilt toggle stays as it is (at the far
  // shot it has no effect).
  reset: () => void
  // Look toward the horizon (true) or straight down (false, the start).
  // Eased.
  setTilted: (tilted: boolean) => void
  // The part of the canvas that no bar covers, as fractions of its width
  // and height from its top left; null, all of it. The far shot fits the
  // globe into it, centred in the canvas.
  setFreeArea: (area: { left: number; top: number; right: number; bottom: number } | null) => void
  // The view reset() goes back to: the latitude of the view's centre
  // (radians) and how much of the free area the far shot fills; null, the
  // opening view (φ0, farFill). `now`: there at once, not eased (a globe
  // just made).
  setHome: (home: { latitude: number; fill: number } | null, now?: boolean) => void
  dispose: () => void
}

export function createOrbitSwoopCamera(options: OrbitSwoopCameraOptions): OrbitSwoopCamera {
  const {
    scene,
    canvas,
    engine,
    radius,
    farFill = 0.9,
    altitudeFactor = 0.15,
    pitchDeg = 38,
    hoverBetaDeg = 35,
    // The flat map's feel (generatorCamera.ts): 0.0003 of its zoom per
    // pixel and at most 0.04 per event, over a view from 0.85 to 0.1 of the
    // world wide (exponential), so ln(0.85 / 0.1) = 2.14 per unit of zoom:
    // 0.00064 per pixel, at most 0.086. A 100 px notch makes the view 6.2 %
    // narrower or wider, on both maps. (The flat map's deep zoom, 0.85 to
    // 0.03, steps faster: 9.5 %.)
    zoomLogPerPixel = 0.0003 * Math.log(0.85 / 0.1),
    zoomLogStep = 0.04 * Math.log(0.85 / 0.1),
    zoomEaseRate = 6,
    globeFrame = () => ({ lean: 0, turn: 0 }),
    momentumTime = 0.4,
    velocityWindow = 0.1,
    latitudeLimit = LATITUDE_LIMIT,
    minZFactor = 0.05,
  } = options

  const hoverBeta = (hoverBetaDeg * Math.PI) / 180
  const hoverDirection = new Vector3(0, Math.cos(hoverBeta), -Math.sin(hoverBeta))
  const nadir = hoverDirection.scale(-1)
  const tangentForward = Vector3.Up().subtract(hoverDirection.scale(Vector3.Dot(Vector3.Up(), hoverDirection))).normalize()
  // The tilted close shot's angle off the nadir: 90° less its pitch below
  // the horizontal.
  const maxOffNadir = ((90 - pitchDeg) * Math.PI) / 180

  // The altitude above the surface: from the far shot to the close one,
  // exponential in the zoom. The far shot's altitude follows the canvas
  // (farAltitudeFor, made again every frame, so a resize, a new fov or a
  // new free area takes it): the globe, centred in the canvas, fills
  // farFill of the largest centred square that the free area (setFreeArea:
  // the canvas less the bars over it) holds. A globe at distance D shows
  // under the half-angle asin(R / D); on the image plane (unit focal
  // length) its rim is tan of that from the centre, and the canvas's half
  // height is tan(fov / 2) (the fov is vertical), its half width that times
  // the aspect. With fov 1 rad on a wide canvas without bars: D = 2.27 R, an
  // altitude of 1.27 R (until 2026-10-11 it was 3 R, and the globe filled
  // 47 %). The near end stays; the wheel's steps are in the log of the
  // altitude, so each notch keeps its 6.2 % and the range has fewer of them
  // (ln(1.27 / 0.15) = 2.14, the flat map's range).
  const closeAltitude = radius * altitudeFactor
  // The far shot's fill: eased toward the home's, so a new home does not
  // jump the far shot's distance.
  let currentFill = farFill
  let targetFill = farFill
  let freeArea = { left: 0, top: 0, right: 1, bottom: 1 }
  const farAltitudeFor = (fov: number, aspect: number): number => {
    const halfHeight = Math.tan(fov / 2)
    // The free half-extents about the canvas's centre, on the image plane.
    const vertical = halfHeight * 2 * Math.min(0.5 - freeArea.top, freeArea.bottom - 0.5)
    const horizontal = halfHeight * aspect * 2 * Math.min(0.5 - freeArea.left, freeArea.right - 0.5)
    const halfSmaller = Math.max(0.05 * halfHeight, Math.min(vertical, horizontal))
    const rim = Math.atan(currentFill * halfSmaller)
    return Math.max(closeAltitude * 1.01, radius / Math.sin(rim) - radius)
  }
  let farAltitude = radius * 3
  let zoomLogRange = Math.log(farAltitude / closeAltitude)
  const altitudeAt = (zoom: number): number => farAltitude * Math.pow(closeAltitude / farAltitude, zoom)

  const camera = new FreeCamera('orbitSwoopCamera', hoverDirection.scale(radius + farAltitude), scene)
  camera.setTarget(Vector3.Zero())
  camera.minZ = radius * minZFactor

  // The main object turns under the drag — the camera itself never moves
  // in response to dragging, keeping zoom and drag fully independent. The
  // pivot's rotation is not kept but made again every frame from the view's
  // longitude and latitude (globeGrab.ts): no roll.
  const viewPivot = new TransformNode('orbitSwoopViewPivot', scene)
  viewPivot.rotationQuaternion = Quaternion.Identity()

  // THE VIEW: longitude λ and latitude φ of the pivot's frame
  // (globeGrab.ts). (0, φ0) is the opening view: the pivot unturned.
  const basis = globeViewBasis([hoverDirection.x, hoverDirection.y, hoverDirection.z])
  let lambda = 0
  let phi = basis.phi0
  // Where reset() returns to (setHome): the opening view unless set.
  let homePhi = basis.phi0
  const applyView = (): void => {
    const [x, y, z, w] = quaternionOfMatrix(viewRotation(basis, lambda, phi))
    viewPivot.rotationQuaternion!.set(x, y, z, w)
  }
  applyView()
  // The globe's own frame in the pivot's (globeFrame: lean, then turn).
  const readFrame = (): Mat3 => {
    const { lean, turn } = globeFrame()
    return globeFrameRotation(lean, turn)
  }

  // The ray of a pixel against the globe, from the camera as it is now: the
  // point on the unit sphere of directions (surfaceUnderRay).
  const surfaceAt = (x: number, y: number): Vec3 => {
    const ray = scene.createPickingRay(x, y, Matrix.Identity(), camera)
    return surfaceUnderRay([ray.origin.x, ray.origin.y, ray.origin.z], [ray.direction.x, ray.direction.y, ray.direction.z], radius).point
  }

  // Set by reset(): the view eases back to (0, φ0) until it arrives or a
  // drag takes over.
  let returning = false
  let isDragging = false
  // The grabbed point, in the globe's own frame: it turns with the spin,
  // so a spinning globe keeps it.
  let grabbed: Vec3 = [0, 0, 1]
  // The cursor and the globe's frame of the frame before, for the drag's
  // own motion (below).
  let lastX = 0
  let lastY = 0
  let lastFrame = readFrame()
  // The drag's samples for the release velocity, and the momentum after
  // the release (radians per second, of λ and φ). The clock: the sum of
  // the frames' times. The samples are of the drag's OWN path: the sum of
  // the view's changes less the part a cursor that stood still would have
  // needed (the globe spun or the camera zoomed under it). A drag that only
  // holds a spinning globe still has no velocity, and the globe does not
  // glide against its spin after the release.
  const velocity = createVelocityEstimator(velocityWindow)
  let clock = 0
  let dragLambda = 0
  let dragPhi = 0
  let momentumLambda = 0
  let momentumPhi = 0
  const pointerObserver: Observer<PointerInfo> | null = scene.onPointerObservable.add((pointerInfo) => {
    if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
      isDragging = true
      returning = false
      momentumLambda = 0
      momentumPhi = 0
      velocity.clear()
      dragLambda = 0
      dragPhi = 0
      // The point under the cursor, into the pivot's frame (V⁻¹), then
      // into the globe's own frame.
      lastX = scene.pointerX
      lastY = scene.pointerY
      lastFrame = readFrame()
      const inPivot = mulVec(transpose(viewRotation(basis, lambda, phi)), surfaceAt(lastX, lastY))
      grabbed = mulVec(transpose(lastFrame), inPivot)
    } else if (pointerInfo.type === PointerEventTypes.POINTERUP) {
      if (!isDragging) return
      isDragging = false
      const release = velocity.velocity()
      momentumLambda = release.lambda
      momentumPhi = release.phi
      velocity.clear()
    }
  })
  let targetZoom = 0
  let currentZoom = 0
  const handleWheel = (event: WheelEvent): void => {
    event.preventDefault()
    // Natural scroll convention: scrolling up/forward (negative deltaY)
    // zooms in (increases targetZoom, toward the close shot). deltaMode 1
    // = lines (some mice/browsers): ~33 px per line, as on the flat map.
    const deltaPx = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY
    const step = Scalar.Clamp(deltaPx * zoomLogPerPixel, -zoomLogStep, zoomLogStep)
    targetZoom = Scalar.Clamp(targetZoom - step / zoomLogRange, 0, 1)
  }
  canvas.addEventListener('wheel', handleWheel, { passive: false })

  // The tilt: 0 straight down, 1 toward the horizon; eased like the zoom.
  let targetTilt = 0
  let currentTilt = 0
  const lookDirection = new Vector3()
  const lookTarget = new Vector3()

  const renderObserver = scene.onBeforeRenderObservable.add(() => {
    const easeFactor = 1 - Math.exp(-zoomEaseRate * (engine.getDeltaTime() / 1000))
    currentZoom = Scalar.Lerp(currentZoom, targetZoom, easeFactor)
    currentFill = Scalar.Lerp(currentFill, targetFill, easeFactor)
    currentTilt = Scalar.Lerp(currentTilt, targetTilt, easeFactor)
    farAltitude = farAltitudeFor(camera.fov, engine.getAspectRatio(camera))
    zoomLogRange = Math.log(farAltitude / closeAltitude)
    hoverDirection.scaleToRef(radius + altitudeAt(currentZoom), camera.position)
    // Straight down (toward the centre), turned toward the horizon by the
    // tilt: more as the camera comes closer, all of it at the close shot.
    // The far shot always looks at the centre — a tilt out there would
    // turn the globe out of the frame.
    const offNadir = currentTilt * currentZoom * maxOffNadir
    nadir.scaleToRef(Math.cos(offNadir), lookDirection)
    tangentForward.scaleAndAddToRef(Math.sin(offNadir), lookDirection)
    camera.position.addToRef(lookDirection, lookTarget)
    camera.setTarget(lookTarget)
    // The view: held by the drag, carried by the momentum, or eased back
    // by reset; then the pivot made from it. After the camera above, so
    // that the drag's ray is this frame's.
    const dt = engine.getDeltaTime() / 1000
    clock += dt
    const frame = readFrame()
    if (isDragging) {
      const held = mulVec(frame, grabbed)
      const x = scene.pointerX
      const y = scene.pointerY
      // Where a cursor that stood still would have put the view: the same
      // as now, unless the globe's frame moved under it.
      const still = frame.some((value, i) => value !== lastFrame[i]) ? solveGrab(basis, held, surfaceAt(lastX, lastY), lambda, phi, latitudeLimit) : { lambda, phi }
      const solved = solveGrab(basis, held, surfaceAt(x, y), lambda, phi, latitudeLimit)
      dragLambda += solved.lambda - still.lambda
      dragPhi += solved.phi - still.phi
      lambda = solved.lambda
      phi = solved.phi
      lastX = x
      lastY = y
      lastFrame = frame
      velocity.add(clock, dragLambda, dragPhi)
    } else if (momentumLambda !== 0 || momentumPhi !== 0) {
      const stepLambda = momentumStep(momentumLambda, dt, momentumTime)
      const stepPhi = momentumStep(momentumPhi, dt, momentumTime)
      lambda += stepLambda.move
      phi += stepPhi.move
      momentumLambda = stepLambda.velocity
      momentumPhi = stepPhi.velocity
      if (Math.abs(phi) >= latitudeLimit) {
        phi = Math.sign(phi) * latitudeLimit
        momentumPhi = 0
      }
      // Below a thousandth of a degree a second: stopped.
      if (Math.hypot(momentumLambda, momentumPhi) < 2e-5) {
        momentumLambda = 0
        momentumPhi = 0
      }
    } else if (returning) {
      lambda = wrapAngle(lambda) * (1 - easeFactor)
      phi += (homePhi - phi) * easeFactor
      if (Math.abs(lambda) < 1e-6 && Math.abs(phi - homePhi) < 1e-6) {
        lambda = 0
        phi = homePhi
        returning = false
      }
    }
    applyView()
  })

  return {
    camera,
    viewPivot,
    reset() {
      targetZoom = 0
      returning = true
      momentumLambda = 0
      momentumPhi = 0
    },
    setTilted(tilted) {
      targetTilt = tilted ? 1 : 0
    },
    setFreeArea(area) {
      freeArea = area ?? { left: 0, top: 0, right: 1, bottom: 1 }
    },
    setHome(home, now = false) {
      homePhi = home ? Math.max(-latitudeLimit, Math.min(latitudeLimit, home.latitude)) : basis.phi0
      targetFill = home ? home.fill : farFill
      if (now) {
        lambda = 0
        phi = homePhi
        currentFill = targetFill
        targetZoom = 0
        currentZoom = 0
        returning = false
        momentumLambda = 0
        momentumPhi = 0
        applyView()
      }
    },
    dispose() {
      scene.onPointerObservable.remove(pointerObserver)
      scene.onBeforeRenderObservable.remove(renderObserver)
      canvas.removeEventListener('wheel', handleWheel)
      // doNotRecurse: viewPivot's children (the main object, etc.) belong
      // to whoever parented them here, not to this camera rig — only the
      // pivot and camera themselves are this module's to clean up.
      viewPivot.dispose(true)
      camera.dispose()
    },
  }
}
