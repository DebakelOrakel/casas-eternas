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
      // matter how zoomed in/out the view currently is.
      const visibleWorldWidth = camera.orthoRight! - camera.orthoLeft!
      const worldUnitsPerPixel = visibleWorldWidth / engine.getRenderWidth()
      camera.position.x -= deltaX * worldUnitsPerPixel
      camera.position.z += deltaY * worldUnitsPerPixel
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
    // Orientation is fixed once at setup (see setTarget above) and never
    // touched again here — pan only ever translates camera.position.x/z,
    // it never needs to re-aim. Re-deriving a look-at rotation every
    // frame for a camera pointed straight down (a gimbal-degenerate
    // direction) is exactly the kind of thing that can accumulate a slow
    // roll drift, which read as the whole world slowly spinning.
  })

  return {
    camera,
    dispose() {
      scene.onPointerObservable.remove(pointerObserver)
      scene.onBeforeRenderObservable.remove(renderObserver)
      canvas.removeEventListener('wheel', handleWheel)
      camera.dispose()
    },
  }
}
