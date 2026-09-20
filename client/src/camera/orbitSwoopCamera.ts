import { Engine, FreeCamera, Observer, PointerInfo, Quaternion, Scalar, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { PointerEventTypes } from '@babylonjs/core'

// An ArcRotateCamera aimed at the sphere's own center can't produce a
// "tilt toward the horizon" effect no matter how its polar angle is
// driven: the closest point on a sphere to an external point always sits
// dead-ahead, perpendicular to the surface, so the camera ends up staring
// straight down into whatever's nearest at every angle. A camera that
// hovers above the surface with its own explicit, non-center look
// direction is what actually shows a horizon — the same conclusion the flat
// generator's own camera rig reached for the same reason (generatorCamera.ts).
//
// Horizontal mouse drag spins the main object itself (viewPivot below)
// rather than moving the camera, so "orbit" and "zoom" stay on entirely
// separate controls — dragging can never affect zoom, and zooming can
// never affect spin.

export interface OrbitSwoopCameraOptions {
  scene: Scene
  canvas: HTMLCanvasElement
  engine: Engine
  // Radius of the main object being orbited, in scene units. Every other
  // distance below is expressed relative to this, so the same defaults
  // work regardless of how large the object actually is.
  radius: number
  // How far out the "whole object" overview shot sits, as a multiple of
  // radius.
  farDistanceFactor?: number
  // How far above the surface the close/horizon shot hovers, as a
  // fraction of radius.
  altitudeFactor?: number
  // How far below the local horizontal the close shot looks, in degrees.
  pitchDeg?: number
  // How far the camera's hover point sits from the pivot's north pole, in
  // degrees — purely which side of the object the whole rig faces.
  hoverBetaDeg?: number
  // How much each wheel notch moves the normalized zoom amount (0 = far,
  // 1 = close).
  zoomStep?: number
  // How quickly the camera eases toward its target zoom position/look
  // each second (higher = snappier).
  zoomEaseRate?: number
  // Radians per pixel of horizontal/vertical drag when spinning the
  // object.
  dragSensitivity?: number
  // Near clip plane, as a fraction of radius — needs to stay below the
  // close shot's altitudeFactor or the near plane clips the surface.
  minZFactor?: number
}

export interface OrbitSwoopCamera {
  camera: FreeCamera
  // Parent the main object (and anything that should spin/orbit with it)
  // to this — never to the camera itself, which never moves on drag.
  viewPivot: TransformNode
  dispose: () => void
}

export function createOrbitSwoopCamera(options: OrbitSwoopCameraOptions): OrbitSwoopCamera {
  const {
    scene,
    canvas,
    engine,
    radius,
    farDistanceFactor = 4,
    altitudeFactor = 0.15,
    pitchDeg = 38,
    hoverBetaDeg = 35,
    zoomStep = 0.05,
    zoomEaseRate = 6,
    dragSensitivity = 0.01,
    minZFactor = 0.05,
  } = options

  const hoverBeta = (hoverBetaDeg * Math.PI) / 180
  const hoverDirection = new Vector3(0, Math.cos(hoverBeta), -Math.sin(hoverBeta))
  const nadir = hoverDirection.scale(-1)
  const tangentForward = Vector3.Up().subtract(hoverDirection.scale(Vector3.Dot(Vector3.Up(), hoverDirection))).normalize()
  const pitch = (pitchDeg * Math.PI) / 180
  const lookDirection = tangentForward.scale(Math.cos(pitch)).add(nadir.scale(Math.sin(pitch))).normalize()

  const farPosition = hoverDirection.scale(radius * farDistanceFactor)
  const farTarget = Vector3.Zero()
  const closePosition = hoverDirection.scale(radius * (1 + altitudeFactor))
  const closeTarget = closePosition.add(lookDirection)

  const camera = new FreeCamera('orbitSwoopCamera', farPosition.clone(), scene)
  camera.setTarget(farTarget)
  camera.minZ = radius * minZFactor

  // The main object spins under mouse drag — the camera itself never
  // moves in response to dragging, keeping zoom and drag fully
  // independent. rotationQuaternion (not Euler .rotation) from the
  // start: the drag handler below composes each incremental rotation in
  // world space via quaternion multiplication, which is what keeps "drag
  // right" and "drag up/down" each meaning the same thing on screen no
  // matter how much rotation has already accumulated — accumulating
  // separate .rotation.x / .rotation.y values instead gimbal-locks once
  // you've dragged a fair amount in both directions.
  const viewPivot = new TransformNode('orbitSwoopViewPivot', scene)
  viewPivot.rotationQuaternion = Quaternion.Identity()

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
      // Both increments rotate around fixed WORLD axes (Up/Right), not
      // the pivot's own — pre-multiplying applies them in world space on
      // top of whatever orientation the pivot already has, so "drag
      // right" and "drag up/down" keep their same on-screen meaning
      // regardless of how much spin has already accumulated. This rig's
      // camera setup has no roll (hoverDirection/lookDirection above are
      // both confined to the Y-Z plane), so world Right really is the
      // camera's screen-horizontal axis here.
      const yaw = Quaternion.RotationAxis(Vector3.Up(), deltaX * dragSensitivity)
      const rollTilt = Quaternion.RotationAxis(Vector3.Right(), deltaY * dragSensitivity)
      viewPivot.rotationQuaternion = yaw.multiply(rollTilt).multiply(viewPivot.rotationQuaternion!)
    }
  })

  let targetZoom = 0
  let currentZoom = 0
  const handleWheel = (event: WheelEvent): void => {
    event.preventDefault()
    // Natural scroll convention: scrolling up/forward (negative deltaY)
    // zooms in (increases targetZoom, toward the close/horizon shot).
    targetZoom = Scalar.Clamp(targetZoom - Math.sign(event.deltaY) * zoomStep, 0, 1)
  }
  canvas.addEventListener('wheel', handleWheel, { passive: false })

  const renderObserver = scene.onBeforeRenderObservable.add(() => {
    const easeFactor = 1 - Math.exp(-zoomEaseRate * (engine.getDeltaTime() / 1000))
    currentZoom = Scalar.Lerp(currentZoom, targetZoom, easeFactor)
    camera.position.copyFrom(Vector3.Lerp(farPosition, closePosition, currentZoom))
    camera.setTarget(Vector3.Lerp(farTarget, closeTarget, currentZoom))
  })

  return {
    camera,
    viewPivot,
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
