import { Camera, Engine, FreeCamera, Observer, PointerEventTypes, PointerInfo, Scalar, Scene, Vector3 } from '@babylonjs/core'

// Top-down only for now (no tilt/rotation) — orthographic rather than
// perspective, since a strategy-map view should read at a consistent
// scale regardless of camera height, with no perspective distortion
// toward the edges. Pan translates the camera's X/Z position directly;
// zoom adjusts the orthographic frustum's world-space extent, not the
// camera's height (height never changes, since it wouldn't do anything
// to apparent size under an orthographic projection anyway).
//
// A camera looking straight down (-Y) is a degenerate case for the
// default up-vector (0,1,0) — it's anti-parallel to the view direction,
// which is unstable for building a view matrix. upVector is set to world
// +Z before the first setTarget to avoid that.

export interface HexMapCameraOptions {
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
  // Fraction of the world's width/height visible at maximum zoom (most
  // zoomed in). Left open/tunable — there's no "correct" value yet; it's
  // whatever the eventual hex-tile LOD swap needs it to be.
  maxZoomWorldFraction?: number
  zoomStep?: number
  zoomEaseRate?: number
  cameraHeight?: number
}

export interface HexMapCamera {
  camera: FreeCamera
  dispose: () => void
  // Pitches the camera from straight-down (angleRadians = 0, the default
  // and this module's original-only behavior) toward looking at an
  // oblique angle off vertical, while keeping whatever ground point pan
  // currently has centered still centered. A real, permanent camera
  // capability — added for the debug 3D relief preview (see
  // WorldGenScreen.ts's toggleDebug3DView), but not itself tied to that
  // preview's lifetime.
  setTilt: (angleRadians: number) => void
  // The ground point pan currently keeps centered. Callers that need
  // "where is the map logically centered" (e.g. WorldGenScreen.ts's
  // toroidal-tile recentering) should use this instead of
  // camera.position.x/z — once tilted, the camera's own position is
  // deliberately offset backward from this point (see setTilt), so
  // reading raw camera.position there would recenter around the wrong
  // spot by a large, tilt-dependent margin.
  getFocus: () => { x: number; z: number }
}

export function createHexMapCamera(options: HexMapCameraOptions): HexMapCamera {
  const {
    scene,
    canvas,
    engine,
    worldWidth,
    worldHeight,
    minZoomWorldFraction = 0.85,
    maxZoomWorldFraction = 0.1,
    zoomStep = 0.05,
    zoomEaseRate = 6,
    cameraHeight = 50,
  } = options

  const camera = new FreeCamera('hexMapCamera', new Vector3(0, cameraHeight, 0), scene)
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA
  camera.minZ = 1
  camera.maxZ = cameraHeight * 4
  camera.upVector = new Vector3(0, 0, 1)
  camera.setTarget(new Vector3(0, 0, 0))

  // Fits both the target visible width AND height within the current
  // canvas aspect ratio without distorting the map — whichever axis needs
  // more screen space relative to its own target extent wins, the same
  // "contain" logic an image would use to fit a frame.
  const updateOrthoExtents = (zoomT: number): void => {
    const visibleWorldWidth = Scalar.Lerp(worldWidth / minZoomWorldFraction, worldWidth * maxZoomWorldFraction, zoomT)
    const visibleWorldHeight = Scalar.Lerp(worldHeight / minZoomWorldFraction, worldHeight * maxZoomWorldFraction, zoomT)
    const aspect = engine.getRenderWidth() / engine.getRenderHeight()
    let halfWidth = visibleWorldWidth / 2
    let halfHeight = halfWidth / aspect
    if (halfHeight < visibleWorldHeight / 2) {
      halfHeight = visibleWorldHeight / 2
      halfWidth = halfHeight * aspect
    }
    camera.orthoLeft = -halfWidth
    camera.orthoRight = halfWidth
    camera.orthoTop = halfHeight
    camera.orthoBottom = -halfHeight
  }
  // Computed once immediately (not just in the render loop) so
  // orthoLeft/orthoRight are never null when the pan handler below reads
  // them, however early a pointer event fires.
  updateOrthoExtents(0)

  // The ground point pan keeps centered — camera.position.x/z directly
  // mirrored this before tilt existed; kept as separate state now since
  // a tilted camera's position is offset from its focus, not equal to it.
  let focusX = 0
  let focusZ = 0
  let tiltAngle = 0

  // Called from pan (every pointermove) to re-derive camera.position
  // from the current focus point and tilt. At tiltAngle === 0 this
  // reproduces the original untilted behavior exactly — position set
  // directly, rotation never touched — specifically so a pan drag
  // doesn't reintroduce the roll-drift risk the original setup avoided
  // by setting a straight-down look-at once and never re-deriving it.
  // That risk is real only for a repeatedly-re-derived *vertical*
  // forward vector (gimbal-degenerate against the default up), so it
  // doesn't apply once tiltAngle is nonzero — setTarget there is safe to
  // call as often as pan needs. NOT used for tilt changes themselves —
  // see setTilt below for why that path always re-derives rotation
  // regardless of direction.
  const applyFocusAndTilt = (): void => {
    if (tiltAngle === 0) {
      camera.position.x = focusX
      camera.position.z = focusZ
      return
    }
    // Camera stays cameraHeight above the ground vertically, but pulls
    // back along -Z as tilt increases so the focus point — not the
    // camera itself — stays the pivot, the same way an orbit camera
    // would read even though this still isn't one.
    const backOffset = cameraHeight * Math.tan(tiltAngle)
    camera.position.set(focusX, cameraHeight, focusZ - backOffset)
    camera.setTarget(new Vector3(focusX, 0, focusZ))
  }

  let isDragging = false
  let lastPointerX = 0
  let lastPointerY = 0
  const pointerObserver: Observer<PointerInfo> | null = scene.onPointerObservable.add((pointerInfo) => {
    if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
      isDragging = true
      lastPointerX = pointerInfo.event.clientX
      lastPointerY = pointerInfo.event.clientY
    } else if (pointerInfo.type === PointerEventTypes.POINTERUP) {
      isDragging = false
    } else if (pointerInfo.type === PointerEventTypes.POINTERMOVE && isDragging) {
      const deltaX = pointerInfo.event.clientX - lastPointerX
      const deltaY = pointerInfo.event.clientY - lastPointerY
      lastPointerX = pointerInfo.event.clientX
      lastPointerY = pointerInfo.event.clientY
      // Converts a pixel drag into world units at the CURRENT zoom level,
      // so a drag always moves the point under the cursor by the same
      // amount the cursor itself moved — "grab and slide the map" — no
      // matter how zoomed in/out the view currently is. Still based on
      // the untilted ortho width even when tilted — a tilted view's
      // pixel-to-world ratio genuinely varies with on-screen depth (near
      // vs far part of the tilted ground plane), so this is only exactly
      // right at tilt = 0; an acceptable inexactness for the debug 3D
      // preview this exists for, not worth solving properly for a
      // throwaway view.
      const visibleWorldWidth = camera.orthoRight! - camera.orthoLeft!
      const worldUnitsPerPixel = visibleWorldWidth / engine.getRenderWidth()
      focusX -= deltaX * worldUnitsPerPixel
      focusZ += deltaY * worldUnitsPerPixel
      applyFocusAndTilt()
    }
  })

  let targetZoom = 0
  let currentZoom = 0
  const handleWheel = (event: WheelEvent): void => {
    event.preventDefault()
    // Natural scroll convention: scrolling up/forward (negative deltaY)
    // zooms in.
    targetZoom = Scalar.Clamp(targetZoom - Math.sign(event.deltaY) * zoomStep, 0, 1)
  }
  canvas.addEventListener('wheel', handleWheel, { passive: false })

  const renderObserver = scene.onBeforeRenderObservable.add(() => {
    const easeFactor = 1 - Math.exp(-zoomEaseRate * (engine.getDeltaTime() / 1000))
    currentZoom = Scalar.Lerp(currentZoom, targetZoom, easeFactor)
    updateOrthoExtents(currentZoom)
    // Orientation itself is never touched here, tilted or not — pan and
    // tilt both go through applyFocusAndTilt from their own discrete
    // events (pointermove, setTilt) instead. See that function's own
    // comment for why re-deriving a look-at every frame specifically
    // matters at tilt = 0 (a gimbal-degenerate straight-down direction,
    // prone to accumulating a slow roll drift if re-derived on a tight
    // loop like this render callback).
  })

  return {
    camera,
    // Always re-derives orientation via setTarget, even back down to
    // angleRadians = 0 — unlike applyFocusAndTilt's own pan-driven fast
    // path, this is a rare, discrete call (a UI toggle), not a tight
    // per-pointermove loop, so the anti-drift shortcut doesn't apply and
    // would actively be wrong here: without re-deriving rotation on the
    // way back to 0, the camera would move back overhead while staying
    // aimed at whatever angle it was last tilted to.
    setTilt(angleRadians: number) {
      tiltAngle = angleRadians
      const backOffset = cameraHeight * Math.tan(tiltAngle)
      camera.position.set(focusX, cameraHeight, focusZ - backOffset)
      camera.setTarget(new Vector3(focusX, 0, focusZ))
    },
    getFocus() {
      return { x: focusX, z: focusZ }
    },
    dispose() {
      scene.onPointerObservable.remove(pointerObserver)
      scene.onBeforeRenderObservable.remove(renderObserver)
      canvas.removeEventListener('wheel', handleWheel)
      camera.dispose()
    },
  }
}
