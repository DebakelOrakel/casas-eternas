import {
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  Effect,
  FreeCamera,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PointerEventTypes,
  PostProcess,
  Quaternion,
  RawTexture,
  RenderTargetTexture,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexData,
} from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { TEXTURE_HEIGHT, TEXTURE_WIDTH } from '../../worldgen/textureConfig'
import type { WorkerResponse } from '../../worldgen/worldgen.worker'
import './worldgen.css'

const DEFAULT_TILT_DEG = 23.5
const PLANET_RADIUS = 1
// Fixed low-orbit camera shot — see the camera setup below for how these
// combine. Chosen by simulating camera rays against the sphere in a
// headless script and checking the resulting hit/miss grid (not
// hand-derived): this combination puts the horizon near the top of frame
// with the rest of the frame showing ground, "satellite/low-orbit" style.
const HOVER_BETA_DEG = 35 // how far the camera's hover point is from the north pole
const ALTITUDE_FACTOR = 0.6 // camera altitude above the surface, as a fraction of PLANET_RADIUS
const PITCH_DEG = 75 // how far below the local horizontal the camera looks
const CAMERA_FOV = 1.0
// The erosion panel's "whole planet" shot — how much of the frame's
// vertical extent the planet should fill once the camera's pulled back.
// Drives the shot's distance (see WIDE_CAMERA_POSITION below), not a
// hand-picked distance itself, so it stays meaningful if CAMERA_FOV ever
// changes.
const WIDE_VIEW_SCREEN_FRACTION = 0.6
// How long a panel switch's camera move takes to settle.
const CAMERA_TRANSITION_SECONDS = 0.8
// Erosion panel's tilt slider range.
const TILT_MIN_DEG = 10
const TILT_MAX_DEG = 40
const TILT_STEP_DEG = 0.5
// Stand-in temperature model for the min/max readout beside the tilt
// slider: an Earth-like world (same average max/min as real-world
// equatorial/polar averages) at Earth's own real tilt (DEFAULT_TILT_DEG),
// nudged from there by how far the slider's tilt deviates. Deliberately
// *not* symmetric between the two ends: annual insolation at the equator
// stays high regardless of tilt (the sun's midday elevation there is
// high year-round even at low obliquity), so the tropics' sensitivity to
// tilt is small — but polar-night length scales directly with tilt, so
// the poles are far more sensitive. Not a real insolation simulation
// (actual annual-mean polar insolation vs. obliquity isn't even
// monotonic once continuous polar day is accounted for), just a
// stylized, intentionally-asymmetric approximation, same spirit as the
// uplift-rate constants in crust.ts.
const EARTH_AVG_MAX_TEMP_C = 30
const EARTH_AVG_MIN_TEMP_C = -30
const TROPIC_TEMP_PER_TILT_DEGREE_C = 0.3
const POLAR_TEMP_PER_TILT_DEGREE_C = 2
// Erosion panel's pole-axis indicator: a dashed line along the rotation
// axis, poking out past the surface at each pole rather than stopping
// exactly at it.
const POLE_AXIS_STICK_OUT_FACTOR = 0.35 // fraction of PLANET_RADIUS each end extends beyond the surface
const POLE_AXIS_DASH_COUNT = 24
const POLE_AXIS_DASH_SIZE = 1 // ratio, not world units — see CreateDashedLines' dashSize/gapSize
const POLE_AXIS_GAP_SIZE = 1
// Erosion panel's latitude-zone overlay: equator/tropic/arctic lines plus
// a translucent equator-to-pole temperature gradient, baked into a canvas
// texture on a second sphere sitting just outside the planet's own
// surface — see where overlaySphere is built below for why (texture
// strokes aren't capped at ~1px the way LinesMesh/GL_LINES are). Tropics
// sit at latitude = the current axial tilt, arctic/antarctic circles at
// 90° minus it — the actual astronomical relationship, not a separate
// hand-picked angle, so the whole overlay redraws to match whenever the
// tilt slider moves (see setTilt below).
const LATITUDE_OVERLAY_RADIUS_FACTOR = 1.02 // how far outside the planet's own radius the shell sits
// Width only needs to be wide enough to avoid single-column-texture edge
// oddities — the overlay has no actual longitude variation (a latitude
// band/line looks identical at every longitude), so every column is
// identical. Height is what controls line/edge crispness.
const LATITUDE_OVERLAY_TEXTURE_WIDTH = 64
const LATITUDE_OVERLAY_TEXTURE_HEIGHT = 512
const LATITUDE_OVERLAY_LINE_THICKNESS_PX = 2
// Bumped up from an initial 0.22 — at the wide shot's current camera
// distance, the visible cap only reaches ~73° of latitude (see
// WIDE_VIEW_SCREEN_FRACTION), so the true poles — where the color
// formula reaches its most saturated blue — never actually render; only
// a partial blend toward it does. A higher alpha (and a more saturated
// POLAR_CIRCLE_COLOR below) makes that partial blend read clearly rather
// than washing out against the atmosphere glow effect, which sits in the
// same pale-blue family right at the silhouette edge.
const LATITUDE_OVERLAY_FILL_ALPHA = 0.4
const EQUATOR_COLOR = new Color3(0.9, 0.25, 0.05) // red, leaning toward orange
const TROPIC_COLOR = new Color3(1.0, 0.75, 0.15) // orange-yellow
const POLAR_CIRCLE_COLOR = new Color3(0.12, 0.32, 0.85) // deeper, more saturated blue than before
// Fixed absolute temperature-to-color anchors for the gradient fill (see
// temperatureToColor) — deliberately *not* relative to the current
// render's own min/max, so a colder tilt visibly deepens the blue at the
// poles and a hotter one visibly intensifies the red at the equator,
// rather than the same three colors just sliding to cover different
// latitude spans. Pinned to the Earth-tilt baseline values themselves
// (not some arbitrary wider range) so the pole/equator actually reach
// full color saturation at DEFAULT_TILT_DEG, tapering toward the muted
// TROPIC_COLOR midpoint below it (a milder, less tilted world correctly
// reads as less saturated) and clipping to fully saturated beyond it.
const TEMP_COLOR_COLD_C = EARTH_AVG_MIN_TEMP_C
const TEMP_COLOR_MILD_C = 0
const TEMP_COLOR_HOT_C = EARTH_AVG_MAX_TEMP_C
const DRAG_SENSITIVITY = 0.01 // radians per pixel of horizontal drag
// Wheel deltaY is typically ~100 per notch on a mouse, but can run into
// the thousands for a fast trackpad swipe — much larger and less
// consistent than pointer-drag pixel deltas, hence the much smaller
// coefficient than the drag sensitivity above.
const ROLL_SENSITIVITY = 0.0008
// Very slow — one full turn every 3 minutes — so it reads as "this is a
// living planet" in the background without demanding attention.
const AUTO_ROTATION_SECONDS_PER_TURN = 180
// Pacing between epoch steps once each one's result is back from the
// worker — purely cosmetic now (the worker computing doesn't block
// anything on the main thread), kept so a run still reads as gradual
// progress rather than a flash-cut straight to the final state.
const EPOCH_STEP_DELAY_MS = 500

function randomSeed(): string {
  return Math.floor(Math.random() * 1_000_000_000).toString()
}

// See the constants above for the model this approximates.
function computeAverageTemps(tiltDeg: number): { minC: number; maxC: number } {
  const tiltDeltaFromEarth = tiltDeg - DEFAULT_TILT_DEG
  return {
    maxC: EARTH_AVG_MAX_TEMP_C + tiltDeltaFromEarth * TROPIC_TEMP_PER_TILT_DEGREE_C,
    minC: EARTH_AVG_MIN_TEMP_C - tiltDeltaFromEarth * POLAR_TEMP_PER_TILT_DEGREE_C,
  }
}

// How "warm" a latitude reads (1 = equator, 0 = pole), for shading the
// overlay gradient — NOT a straight linear/cosine falloff. Real
// equator-to-pole surface temperature is fairly flat through the
// tropics, steepest through the mid-latitudes (roughly where the polar
// front/jet stream sit), and flattens out again near the poles, because
// atmospheric/ocean heat transport smooths the ends of the curve more
// than the middle. P2(sin(latitude)) — the second Legendre polynomial —
// is the standard simplified-climate-model (Budyko-Sellers, 1969)
// approximation of exactly that meridional profile, which is why this
// isn't just cos(latitude): P2 has the flatter-tropics/flatter-poles,
// steeper-middle shape that plain cosine doesn't.
function latitudeWarmth(latitudeDeg: number): number {
  const sinLatitude = Math.sin((latitudeDeg * Math.PI) / 180)
  const p2 = (3 * sinLatitude * sinLatitude - 1) / 2 // -0.5 (equator) .. 1 (pole)
  return 1 - (p2 + 0.5) / 1.5 // rescaled to 1 (equator, warmest) .. 0 (pole, coldest)
}

// Maps an actual computed temperature (see computeAverageTemps) onto the
// gradient's fixed TEMP_COLOR_* anchors — this is what makes the
// gradient's *color intensity*, not just its shape, respond to tilt: the
// same latitude can render more or less blue/red depending on how cold
// or hot computeAverageTemps says it actually is at the current tilt.
function temperatureToColor(tempC: number): Color3 {
  if (tempC <= TEMP_COLOR_MILD_C) {
    const t = Math.min(1, Math.max(0, (tempC - TEMP_COLOR_COLD_C) / (TEMP_COLOR_MILD_C - TEMP_COLOR_COLD_C)))
    return Color3.Lerp(POLAR_CIRCLE_COLOR, TROPIC_COLOR, t)
  }
  const t = Math.min(1, Math.max(0, (tempC - TEMP_COLOR_MILD_C) / (TEMP_COLOR_HOT_C - TEMP_COLOR_MILD_C)))
  return Color3.Lerp(TROPIC_COLOR, EQUATOR_COLOR, t)
}

// Shortest-arc rotation carrying unit vector `from` onto unit vector `to`
// — axis is perpendicular to both (their cross product), angle is the arc
// between them (their dot product). Standard construction; used below to
// derive the erosion shot's roll from an explicit target pole direction
// rather than hand-picking a roll angle by trial and error.
function rotationBetween(from: Vector3, to: Vector3): Quaternion {
  const dot = Vector3.Dot(from, to)
  if (dot > 0.999999) return Quaternion.Identity()
  if (dot < -0.999999) {
    let axis = Vector3.Cross(Vector3.Right(), from)
    if (axis.lengthSquared() < 1e-6) axis = Vector3.Cross(Vector3.Up(), from)
    return Quaternion.RotationAxis(axis.normalize(), Math.PI)
  }
  const axis = Vector3.Cross(from, to).normalize()
  return Quaternion.RotationAxis(axis, Math.acos(Math.min(1, Math.max(-1, dot))))
}

// A small spherical-cap patch (not a flat disc) so the north-pole marker
// actually conforms to the planet's curvature instead of floating tangent
// to it — a flat disc's edges visibly lift away from the surface at this
// scale. angularRadius is the cap's half-angle from the pole axis, in
// radians. Winding for the ring-to-ring quads was verified directly
// (not assumed) via a headless script computing per-vertex normals with
// VertexData.ComputeNormals — the fan and the quads must wind the same
// rotational sense or half the patch's normals point inward.
function createPoleCapMesh(name: string, angularRadius: number, radius: number, rings: number, tessellation: number, scene: Scene): Mesh {
  const positions = [0, radius, 0]
  const uvs = [0.5, 0.5]
  const indices: number[] = []
  const maxRingRadius = Math.sin(angularRadius) * radius
  const indexOf = (ring: number, seg: number) => 1 + (ring - 1) * tessellation + (seg % tessellation)

  for (let ring = 1; ring <= rings; ring++) {
    const theta = (angularRadius * ring) / rings
    const y = Math.cos(theta) * radius
    const ringRadius = Math.sin(theta) * radius
    for (let seg = 0; seg < tessellation; seg++) {
      const phi = (seg / tessellation) * Math.PI * 2
      const x = ringRadius * Math.cos(phi)
      const z = ringRadius * Math.sin(phi)
      positions.push(x, y, z)
      uvs.push(0.5 + 0.5 * (x / maxRingRadius), 0.5 + 0.5 * (z / maxRingRadius))
    }
  }

  for (let seg = 0; seg < tessellation; seg++) {
    indices.push(0, indexOf(1, seg), indexOf(1, seg + 1))
  }
  for (let ring = 1; ring < rings; ring++) {
    for (let seg = 0; seg < tessellation; seg++) {
      const a = indexOf(ring, seg)
      const b = indexOf(ring, seg + 1)
      const c = indexOf(ring + 1, seg)
      const d = indexOf(ring + 1, seg + 1)
      indices.push(a, c, d)
      indices.push(a, d, b)
    }
  }

  const normals: number[] = []
  VertexData.ComputeNormals(positions, indices, normals)
  const vertexData = new VertexData()
  vertexData.positions = positions
  vertexData.indices = indices
  vertexData.uvs = uvs
  vertexData.normals = normals
  const mesh = new Mesh(name, scene)
  vertexData.applyToMesh(mesh)
  return mesh
}

export const createWorldGenScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)
  // Procedural starfield (./starfield.ts) is built but deliberately not
  // wired in here — the shape/orientation/band math all checked out
  // numerically, but the actual rendered look wasn't good. Left in place
  // rather than deleted, for a future pass; re-enable with
  // `createStarfield(scene)` (not parented to anything, so it stays fixed
  // while the planet spins).

  // Outermost node: free mouse-drag reorientation (see the pointer
  // handler below), independent of both the planet's own simulated spin
  // and its axial tilt. This is what lets the globe be viewed from any
  // angle now, not just spun around its own pole. Driven by a quaternion
  // (not the default Euler `rotation`) from the start, since both the
  // wheel-roll handler and the panel-switch transition below assign to
  // rotationQuaternion directly.
  const viewPivot = new TransformNode('viewPivot', scene)
  viewPivot.rotationQuaternion = Quaternion.Identity()

  // The pole's own orientation: tilting this leans the pole stick and the
  // planet's spin axis relative to the (fixed) camera.
  const tiltPivot = new TransformNode('tiltPivot', scene)
  tiltPivot.rotation.z = (DEFAULT_TILT_DEG * Math.PI) / 180
  tiltPivot.parent = viewPivot

  // The planet spins around the pole's local axis, independently of tilt
  // — driven only by the continuous auto-rotation below now, not by
  // dragging (which moved to viewPivot).
  const spinPivot = new TransformNode('spinPivot', scene)
  spinPivot.parent = tiltPivot

  // Camera stays fixed — dragging spins the planet, not the view. Not an
  // ArcRotateCamera aimed at the sphere's center this time: that always
  // renders the horizon as a circle centered on screen no matter the
  // angle (confirmed directly — that's what made an earlier close-up
  // attempt look like "just the pole, no sense of a globe"). A FreeCamera
  // hovering just above the surface, pitched down to look forward and
  // down (not straight at the center), is what puts the horizon high in
  // frame with the rest showing ground.
  const hoverBeta = (HOVER_BETA_DEG * Math.PI) / 180
  const hoverDirection = new Vector3(0, Math.cos(hoverBeta), -Math.sin(hoverBeta))
  const nadir = hoverDirection.scale(-1)
  // "Forward" along the surface, toward the pole — the direction the
  // camera looks across, before pitching down toward the ground.
  const tangentForward = Vector3.Up().subtract(hoverDirection.scale(Vector3.Dot(Vector3.Up(), hoverDirection))).normalize()
  const pitch = (PITCH_DEG * Math.PI) / 180
  const lookDirection = tangentForward.scale(Math.cos(pitch)).add(nadir.scale(Math.sin(pitch))).normalize()

  // Plate-tectonics panel's shot: low-orbit, pitched down toward the
  // ground (see the HOVER_BETA_DEG/ALTITUDE_FACTOR/PITCH_DEG comment
  // above this block for how it's derived).
  const CLOSE_CAMERA_POSITION = hoverDirection.scale(PLANET_RADIUS * (1 + ALTITUDE_FACTOR))
  const CLOSE_CAMERA_TARGET = CLOSE_CAMERA_POSITION.add(lookDirection)

  // Erosion panel's shot: straight on at the planet's center — no pitch,
  // no roll — pulled back along the same hoverDirection axis as the close
  // shot (so the same face of the planet stays in view across the
  // transition instead of swinging to a different side) until the sphere
  // fills WIDE_VIEW_SCREEN_FRACTION of the frame's vertical extent at the
  // same FOV as the close shot. Distance, not FOV, is what changes — a
  // dolly out reads as "zoom out" without the perspective distortion an
  // FOV change would add.
  const wideCameraDistance = PLANET_RADIUS / Math.sin((WIDE_VIEW_SCREEN_FRACTION * CAMERA_FOV) / 2)
  const WIDE_CAMERA_POSITION = hoverDirection.scale(wideCameraDistance)
  const WIDE_CAMERA_TARGET = Vector3.Zero()

  const camera = new FreeCamera('camera', CLOSE_CAMERA_POSITION.clone(), scene)
  camera.setTarget(CLOSE_CAMERA_TARGET)
  camera.fov = CAMERA_FOV
  // Default minZ (1) would clip the ground itself — the close shot sits
  // only ALTITUDE_FACTOR (0.4) units above the surface.
  camera.minZ = 0.05

  // The camera's own "right" axis in world space — used below as the
  // rotation axis for vertical drag, so dragging up/down tilts the globe
  // the same way it visually reads on screen. Read directly off the
  // camera's world matrix (forcing an immediate compute, since no frame
  // has actually rendered yet at this point in setup) rather than
  // hand-derived, same reasoning as the sun-direction comment above.
  camera.computeWorldMatrix()
  const cameraRightAxis = Vector3.TransformNormal(new Vector3(1, 0, 0), camera.getWorldMatrix()).normalize()

  // Erosion panel's roll: rotates the planet (about viewPivot, the same
  // node the mouse wheel drives below) so its pole axis reads edge-on to
  // the camera — perpendicular to the view direction, unlike the close
  // shot's near-polar viewing angle, which foreshortens it — while still
  // showing a diagonal "tilted globe" line (north toward the top-left,
  // south toward the bottom-right) rather than a perfectly vertical axis.
  // Built by finding the rotation that carries the untilted-by-viewPivot
  // pole direction onto an explicit target expressed in the *wide*
  // camera's own screen-space right/up basis — perpendicular to that
  // camera's view direction by construction, so there's no separate
  // "make it perpendicular" step to get right.
  camera.position.copyFrom(WIDE_CAMERA_POSITION)
  camera.setTarget(WIDE_CAMERA_TARGET)
  camera.computeWorldMatrix()
  const wideCameraRightAxis = Vector3.TransformNormal(new Vector3(1, 0, 0), camera.getWorldMatrix()).normalize()
  const wideCameraUpAxis = Vector3.TransformNormal(new Vector3(0, 1, 0), camera.getWorldMatrix()).normalize()
  // That was only to read the wide camera's basis vectors off its world
  // matrix — restore the camera to its actual starting shot before
  // anything renders.
  camera.position.copyFrom(CLOSE_CAMERA_POSITION)
  camera.setTarget(CLOSE_CAMERA_TARGET)
  camera.computeWorldMatrix()

  // Derives the erosion shot's roll for whatever the planet's *current*
  // axial tilt happens to be — re-run whenever the tilt slider changes
  // (see setTilt below), not just once at setup, so the diagonal lean
  // always matches the real tilt instead of a separately hand-picked
  // angle. tiltRad doubles as both: the pole direction's own tilt (how
  // poleAxisAtIdentity is built) and the on-screen diagonal angle the
  // wide shot rolls it to — one real tilt value driving both, per "the
  // tilt in both panels should reflect the planet's actual tilt".
  const computeWideViewRoll = (tiltRad: number): Quaternion => {
    const poleAxisAtIdentity = new Vector3(-Math.sin(tiltRad), Math.cos(tiltRad), 0)
    const wideViewTargetPoleDirection = wideCameraUpAxis
      .scale(Math.cos(tiltRad))
      .subtract(wideCameraRightAxis.scale(Math.sin(tiltRad)))
      .normalize()
    return rotationBetween(poleAxisAtIdentity, wideViewTargetPoleDirection)
  }

  // The close shot's roll is identity — "the same roll as when entering
  // the scene from the title menu" (see the wheel-roll reset in setShot
  // below for how manual scrolling never persists past a panel switch).
  const CLOSE_VIEW_ROLL = Quaternion.Identity()
  let currentWideViewRoll = computeWideViewRoll(tiltPivot.rotation.z)

  // Sun sits behind the viewer (not behind the planet), slightly to the
  // viewer's right, confined to the "solar plane" — the plane through
  // the screen's left-right axis and the camera's forward/depth axis,
  // i.e. zero vertical (up-axis) component. Direction is a fixed literal,
  // not derived from the camera at runtime, because the camera's
  // position/orientation are themselves fixed constants above (never
  // change) — computed once via camera.getWorldMatrix()'s actual
  // right/forward/up basis vectors for this exact camera setup, not
  // hand-derived, to avoid a cross-product handedness mistake:
  // -forward + 0.3*right, normalized, negated (DirectionalLight.direction
  // is the light's *travel* direction, i.e. the opposite of where it
  // sits) — verified dot(sourceDir, up) == 0 before negating. Recomputed
  // from scratch when the camera moved from an orbit camera to this
  // hovering one — the old literal was relative to the old camera's
  // basis vectors and no longer applies.
  const sunLight = new DirectionalLight('sun', new Vector3(-0.287, -0.549, 0.785), scene)
  sunLight.intensity = 1.1
  // Not zero — the far side of the sphere (facing away from both viewer
  // and sun) would otherwise fall to pure black, since no terrain bumps
  // exist anymore for a raking light to reveal; this just keeps the
  // faint land/water texture legible on the unlit side.
  new HemisphericLight('fill', new Vector3(0.3, 1, 0.2), scene).intensity = 0.5

  // Plain sphere — no need for the icosphere/welding/adjacency machinery
  // the previous vertex-displacement approach needed, since nothing is
  // computed per-vertex anymore. Its default UVs already match the
  // equirectangular texture's u/v convention.
  const planet = MeshBuilder.CreateSphere('planet', { diameter: PLANET_RADIUS * 2, segments: 48 }, scene)
  planet.parent = spinPivot
  const material = new StandardMaterial('planetMaterial', scene)
  material.diffuseColor = new Color3(1, 1, 1)
  material.specularColor = new Color3(0, 0, 0)
  planet.material = material

  const worldTexture = RawTexture.CreateRGBATexture(
    new Uint8Array(TEXTURE_WIDTH * TEXTURE_HEIGHT * 4),
    TEXTURE_WIDTH,
    TEXTURE_HEIGHT,
    scene,
    false,
    true,
  )
  material.diffuseTexture = worldTexture

  // Atmosphere rim, take 2. A Fresnel/surface-normal glow (tried first)
  // naturally spills across most of the visible ground here, not just a
  // thin edge — because the camera sits very close to the surface
  // (altitude 0.4x radius) and looks across it at an angle, most of the
  // ground filling the frame is already fairly oblique to the camera, so
  // a view-angle-based glow lights up a lot of it, not just the true
  // silhouette. This version detects the actual silhouette in screen
  // space instead, independent of surface angle:
  //  1. A plain-white duplicate of the planet mesh, rendered into a
  //     render target — a mask of "is this pixel part of the planet"
  //     from the camera's exact viewpoint. Hidden from the main view
  //     otherwise. High enough resolution that the sphere's own edge
  //     isn't visibly blocky — a first pass at 48px wide showed a
  //     staircase where the circle should be smooth, since a texture
  //     that coarse can't represent a round edge at all, blur or not.
  //  2. The actual blur — and therefore the glow band's width — comes
  //     from an explicit multi-tap sample of that mask in the shader
  //     below, not from the mask's resolution. Decoupling the two is
  //     what fixes the staircase: the mask can be sharp/detailed, and
  //     blur amount is a dedicated, independently-tunable knob.
  //  3. A post-process blends in glowColor using 4*m*(1-m), where m is
  //     that blurred mask value — a parabola that's 0 deep inside the
  //     planet (m~1) and 0 far outside it (m~0), peaking exactly on the
  //     blurred transition band straddling the true edge, on both the
  //     sky side and the ground side, matching the reference photo.
  const atmosphereMaskMesh = MeshBuilder.CreateSphere('atmosphereMaskMesh', { diameter: PLANET_RADIUS * 2, segments: 48 }, scene)
  atmosphereMaskMesh.parent = spinPivot
  const atmosphereMaskMaterial = new StandardMaterial('atmosphereMaskMaterial', scene)
  atmosphereMaskMaterial.diffuseColor = new Color3(0, 0, 0)
  atmosphereMaskMaterial.specularColor = new Color3(0, 0, 0)
  atmosphereMaskMaterial.emissiveColor = new Color3(1, 1, 1)
  atmosphereMaskMesh.material = atmosphereMaskMaterial
  atmosphereMaskMesh.isVisible = false

  const maskWidth = 512
  const maskHeight = Math.max(1, Math.round(maskWidth / (ctx.engine.getRenderWidth() / ctx.engine.getRenderHeight())))
  const atmosphereMaskRT = new RenderTargetTexture('atmosphereMaskRT', { width: maskWidth, height: maskHeight }, scene, false, true)
  atmosphereMaskRT.clearColor = new Color4(0, 0, 0, 1)
  // Default addressing is wrap/repeat — sampling near one edge (e.g. the
  // blur below reaching just past vUV.y=0) would otherwise wrap around
  // and pick up the opposite edge's mask content, showing up as a stray
  // glow band on the wrong side of the screen. Confirmed directly: this
  // is exactly what produced an extra blue smear at the top of frame,
  // unrelated to the planet's own silhouette, before clamping.
  atmosphereMaskRT.wrapU = Texture.CLAMP_ADDRESSMODE
  atmosphereMaskRT.wrapV = Texture.CLAMP_ADDRESSMODE
  atmosphereMaskRT.renderList = [atmosphereMaskMesh]
  // Only visible during this render target's own pass — never in the
  // main view, and never adding its own (correctly-sharp) silhouette on
  // top of the glow it's used to generate.
  atmosphereMaskRT.onBeforeRenderObservable.add(() => {
    atmosphereMaskMesh.isVisible = true
  })
  atmosphereMaskRT.onAfterRenderObservable.add(() => {
    atmosphereMaskMesh.isVisible = false
  })
  scene.customRenderTargets.push(atmosphereMaskRT)

  Effect.ShadersStore.atmosphereGlowFragmentShader = `
    precision highp float;
    varying vec2 vUV;
    uniform sampler2D textureSampler;
    uniform sampler2D maskSampler;
    uniform vec3 glowColor;
    uniform float glowIntensity;
    uniform float blurRadius;

    // 5x5 box blur, independent of the mask's own resolution — this is
    // what actually controls the glow band's width (blurRadius), not
    // how detailed the underlying silhouette mask is.
    float sampleMaskBlurred(vec2 uv) {
      float total = 0.0;
      for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
          vec2 offset = vec2(float(x), float(y)) * blurRadius;
          total += texture2D(maskSampler, uv + offset).r;
        }
      }
      return total / 25.0;
    }

    void main(void) {
      vec4 sceneColor = texture2D(textureSampler, vUV);
      float m = sampleMaskBlurred(vUV);
      float edge = 4.0 * m * (1.0 - m);
      vec3 result = mix(sceneColor.rgb, glowColor, edge * glowIntensity);
      gl_FragColor = vec4(result, sceneColor.a);
    }
  `
  const atmosphereGlow = new PostProcess(
    'atmosphereGlow',
    'atmosphereGlow',
    ['glowColor', 'glowIntensity', 'blurRadius'],
    ['maskSampler'],
    1.0,
    camera,
  )
  atmosphereGlow.onApply = (effect) => {
    effect.setTexture('maskSampler', atmosphereMaskRT)
    effect.setColor3('glowColor', new Color3(0.55, 0.72, 0.95))
    effect.setFloat('glowIntensity', 0.25)
    // In mask-texture UV units (0-1 spans the whole 512px-wide mask) —
    // this, not maskWidth, is what controls the glow band's width now.
    effect.setFloat('blurRadius', 0.01)
  }

  // North-pole marker: a flat circular badge with an "N", drawn onto a
  // DynamicTexture's 2D canvas rather than a mesh outline — much simpler
  // for a ring + centered glyph than building actual geometry for it.
  // Parented to tiltPivot (not spinPivot), so it stays upright and
  // doesn't spin with the planet's own rotation — the pole point itself
  // doesn't move under spin (it's on the rotation axis), and a marker
  // that visibly spun in place would read as confusing UI, not part of
  // the terrain. Replaces the old red pole-axis stick as the north
  // indicator, which has been removed.
  const northMarkerTexture = new DynamicTexture('northMarkerTexture', 256, scene, false)
  northMarkerTexture.hasAlpha = true
  const northMarkerContext = northMarkerTexture.getContext()
  northMarkerContext.clearRect(0, 0, 256, 256)
  northMarkerContext.strokeStyle = '#1a1a1a'
  northMarkerContext.lineWidth = 10
  northMarkerContext.beginPath()
  northMarkerContext.arc(128, 128, 105, 0, Math.PI * 2)
  northMarkerContext.stroke()
  northMarkerContext.fillStyle = '#1a1a1a'
  northMarkerContext.font = 'bold 140px sans-serif'
  // ICanvasRenderingContext (Babylon's minimal cross-platform canvas
  // abstraction) doesn't type textAlign/textBaseline, so center the
  // glyph manually from its actual bounding-box metrics instead.
  const glyphMetrics = northMarkerContext.measureText('N')
  const glyphOffsetX = (glyphMetrics.actualBoundingBoxLeft - glyphMetrics.actualBoundingBoxRight) / 2
  const glyphOffsetY = (glyphMetrics.actualBoundingBoxAscent - glyphMetrics.actualBoundingBoxDescent) / 2
  northMarkerContext.fillText('N', 128 + glyphOffsetX, 128 + glyphOffsetY)
  northMarkerTexture.update()

  // Angular radius 0.15 rad matches the old flat disc's linear radius
  // 0.15 at PLANET_RADIUS=1 (arc length ~= radius * angle for a small
  // angle) — same apparent size, now actually following the curve.
  const northMarker = createPoleCapMesh('northMarker', 0.15, PLANET_RADIUS + 0.005, 8, 48, scene)
  northMarker.parent = tiltPivot
  const northMarkerMaterial = new StandardMaterial('northMarkerMaterial', scene)
  northMarkerMaterial.diffuseTexture = northMarkerTexture
  northMarkerMaterial.useAlphaFromDiffuseTexture = true
  northMarkerMaterial.specularColor = new Color3(0, 0, 0)
  northMarkerMaterial.emissiveColor = new Color3(0.5, 0.5, 0.5)
  northMarkerMaterial.backFaceCulling = false
  northMarker.material = northMarkerMaterial

  // Erosion panel's pole-axis indicator — a dashed line straight through
  // the planet along its rotation axis (local Y, same axis the north
  // marker above sits on), extended POLE_AXIS_STICK_OUT_FACTOR past the
  // surface at each end so the tips visibly poke out rather than
  // stopping flush with it. Parented to tiltPivot, not spinPivot, same as
  // the north marker — it should track the planet's axial tilt (and
  // viewPivot's roll) but not spin with the planet's own rotation. Left
  // depth-tested (the default) rather than drawn on top, so the segment
  // running through the planet's interior is naturally occluded by the
  // opaque sphere and only the two protruding tips plus a sliver near
  // each pole actually show — same as a rod stuck through a solid globe
  // would look. Hidden by default; shown only on the erosion panel (see
  // showPanel below).
  const poleAxisHalfLength = PLANET_RADIUS * (1 + POLE_AXIS_STICK_OUT_FACTOR)
  const poleAxisLine = MeshBuilder.CreateDashedLines(
    'poleAxisLine',
    {
      points: [new Vector3(0, poleAxisHalfLength, 0), new Vector3(0, -poleAxisHalfLength, 0)],
      dashSize: POLE_AXIS_DASH_SIZE,
      gapSize: POLE_AXIS_GAP_SIZE,
      dashNb: POLE_AXIS_DASH_COUNT,
    },
    scene,
  )
  poleAxisLine.parent = tiltPivot
  poleAxisLine.color = new Color3(0.1, 0.1, 0.1)
  poleAxisLine.isVisible = false

  // Erosion panel's latitude-zone overlay — a second sphere sitting just
  // outside the planet's own surface (LATITUDE_OVERLAY_RADIUS_FACTOR),
  // textured with the equator/tropic/arctic lines and a translucent
  // equator-to-pole temperature gradient, all baked into a canvas-drawn
  // DynamicTexture rather than built as line meshes. LinesMesh renders as
  // native GL_LINES, which browsers clamp to ~1px regardless of any width
  // setting — canvas 2D strokes have no such limit, which is what
  // actually gives these lines real thickness. Latitude bands/lines have
  // no longitude variation (a band looks identical all the way around),
  // so the whole texture only needs a vertical gradient fill and
  // strokes — see drawLatitudeOverlay below — redrawn (a handful of cheap
  // 2D calls, not per-vertex geometry work) whenever the tilt slider
  // moves. Parented to tiltPivot, same as the pole axis — rotationally
  // symmetric about the spin axis, so parenting to spinPivot instead
  // would look identical, but tiltPivot matches the rest of this group.
  const overlaySphere = MeshBuilder.CreateSphere(
    'latitudeOverlay',
    { diameter: PLANET_RADIUS * 2 * LATITUDE_OVERLAY_RADIUS_FACTOR, segments: 48 },
    scene,
  )
  overlaySphere.parent = tiltPivot
  overlaySphere.isVisible = false

  const overlayTexture = new DynamicTexture(
    'latitudeOverlayTexture',
    { width: LATITUDE_OVERLAY_TEXTURE_WIDTH, height: LATITUDE_OVERLAY_TEXTURE_HEIGHT },
    scene,
    false,
  )
  overlayTexture.hasAlpha = true
  const overlayContext = overlayTexture.getContext()

  const overlayMaterial = new StandardMaterial('latitudeOverlayMaterial', scene)
  overlayMaterial.diffuseTexture = overlayTexture
  overlayMaterial.useAlphaFromDiffuseTexture = true
  overlayMaterial.specularColor = new Color3(0, 0, 0)
  // Keeps the overlay legible on the planet's unlit/night side, same
  // approach as the north marker's material above.
  overlayMaterial.emissiveColor = new Color3(0.4, 0.4, 0.4)
  overlayMaterial.backFaceCulling = false
  overlaySphere.material = overlayMaterial

  const colorToCss = (color: Color3, alpha: number): string =>
    `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${alpha})`

  // Row (V, 0=north pole, 1=south pole) for a given latitude — matches
  // Babylon's default sphere UV convention, same one the planet mesh
  // above already relies on for its own equirectangular texture.
  const latitudeToV = (latitudeDeg: number): number => ((90 - latitudeDeg) / 180) * LATITUDE_OVERLAY_TEXTURE_HEIGHT

  const drawLatitudeOverlayLine = (latitudeDeg: number, color: Color3): void => {
    const v = latitudeToV(latitudeDeg)
    overlayContext.strokeStyle = colorToCss(color, 1)
    overlayContext.lineWidth = LATITUDE_OVERLAY_LINE_THICKNESS_PX
    overlayContext.beginPath()
    overlayContext.moveTo(0, v)
    overlayContext.lineTo(LATITUDE_OVERLAY_TEXTURE_WIDTH, v)
    overlayContext.stroke()
  }

  // Temperature gradient — hottest at the equator, coldest at the poles.
  // Drawn per-row (not a canvas linear gradient between fixed stops,
  // which only interpolates linearly in latitude) so its shape can follow
  // latitudeWarmth's realistic equator/pole-flat, mid-latitude-steep
  // curve. Each row's actual temperature comes from the same
  // computeAverageTemps(tiltDeg) endpoints the readout displays, then
  // temperatureToColor maps that onto a fixed absolute color scale — so
  // both the curve's *shape* (latitudeWarmth, tilt-independent) and its
  // *intensity* (temperatureToColor, via the tilt-dependent endpoints)
  // are doing real work, rather than one flat blend sliding around.
  const drawLatitudeOverlayGradient = (tiltDeg: number): void => {
    const { minC, maxC } = computeAverageTemps(tiltDeg)
    for (let row = 0; row < LATITUDE_OVERLAY_TEXTURE_HEIGHT; row++) {
      const latitudeDeg = 90 - (row / LATITUDE_OVERLAY_TEXTURE_HEIGHT) * 180
      const tempC = minC + latitudeWarmth(latitudeDeg) * (maxC - minC)
      overlayContext.fillStyle = colorToCss(temperatureToColor(tempC), LATITUDE_OVERLAY_FILL_ALPHA)
      overlayContext.fillRect(0, row, LATITUDE_OVERLAY_TEXTURE_WIDTH, 1)
    }
  }

  // Toggled by the temperature button next to the tilt slider (wired up
  // below) — the equator/tropic/arctic lines stay visible either way,
  // only the gradient fill is affected.
  let isTemperatureGradientVisible = true

  const drawLatitudeOverlay = (tiltDeg: number): void => {
    overlayContext.clearRect(0, 0, LATITUDE_OVERLAY_TEXTURE_WIDTH, LATITUDE_OVERLAY_TEXTURE_HEIGHT)
    const arcticLatitudeDeg = 90 - tiltDeg

    if (isTemperatureGradientVisible) drawLatitudeOverlayGradient(tiltDeg)

    drawLatitudeOverlayLine(arcticLatitudeDeg, POLAR_CIRCLE_COLOR)
    drawLatitudeOverlayLine(tiltDeg, TROPIC_COLOR)
    drawLatitudeOverlayLine(0, EQUATOR_COLOR)
    drawLatitudeOverlayLine(-tiltDeg, TROPIC_COLOR)
    drawLatitudeOverlayLine(-arcticLatitudeDeg, POLAR_CIRCLE_COLOR)

    overlayTexture.update()
  }

  drawLatitudeOverlay(DEFAULT_TILT_DEG)
  const erosionOverlayMeshes = [poleAxisLine, overlaySphere]

  // Horizontal drag spins the planet around its own north-south axis —
  // spinPivot, the same node the continuous auto-rotation below drives,
  // so a manual drag and the ambient spin just add together naturally
  // rather than fighting over separate state.
  let isDragging = false
  let lastPointerX = 0
  scene.onPointerObservable.add((pointerInfo) => {
    if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
      isDragging = true
      lastPointerX = pointerInfo.event.clientX
    } else if (pointerInfo.type === PointerEventTypes.POINTERUP) {
      isDragging = false
    } else if (pointerInfo.type === PointerEventTypes.POINTERMOVE && isDragging) {
      const deltaX = pointerInfo.event.clientX - lastPointerX
      lastPointerX = pointerInfo.event.clientX
      spinPivot.rotation.y += deltaX * DRAG_SENSITIVITY
    }
  })

  // Whether the zoom toggle (wired up below) currently has the wide
  // "whole planet" shot active, independent of which panel is showing —
  // the zoom button controls this, not showPanel.
  let isZoomedOut = false

  // Roll the planet toward/away from the viewer via the mouse wheel —
  // rotating viewPivot around the *current shot's own* camera-right axis
  // (close: cameraRightAxis, wide: wideCameraRightAxis — each camera has
  // a different orientation, so "up/down on screen" needs its own axis),
  // composed on top of that shot's base roll (identity for close,
  // currentWideViewRoll for wide) rather than replacing it outright, so
  // scrolling in the wide view starts from the pole-aligned framing
  // instead of snapping to an arbitrary one. Enabled in both views.
  let viewRoll = 0
  ctx.canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      viewRoll += event.deltaY * ROLL_SENSITIVITY
      const rollAxis = isZoomedOut ? wideCameraRightAxis : cameraRightAxis
      const baseRoll = isZoomedOut ? currentWideViewRoll : CLOSE_VIEW_ROLL
      viewPivot.rotationQuaternion = baseRoll.multiply(Quaternion.RotationAxis(rollAxis, viewRoll))
    },
    { passive: false },
  )

  // The planet's own simulated rotation — continuous and independent of
  // the free-drag view control above, since they're on separate nodes
  // (spinPivot vs. viewPivot). Toggled by the spin button wired up below.
  let isSpinning = true
  const autoRotationSpeed = (2 * Math.PI) / AUTO_ROTATION_SECONDS_PER_TURN
  scene.onBeforeRenderObservable.add(() => {
    if (!isSpinning) return
    spinPivot.rotation.y += autoRotationSpeed * (ctx.engine.getDeltaTime() / 1000)
  })

  // Smoothly moves the camera *and* the planet's roll between the panel
  // "shots" defined above (CLOSE_CAMERA_*/CLOSE_VIEW_ROLL and
  // WIDE_CAMERA_*/currentWideViewRoll) whenever the zoom toggle changes
  // (see setShot, called from the zoom button below — panel switching no
  // longer touches the camera at all). Tracks its own current
  // position/target/roll rather than reading them back off the camera (a
  // FreeCamera doesn't retain the target passed to setTarget) or off
  // viewPivot (see rollFrom's use of viewPivot.rotationQuaternion
  // directly in setShot instead, since that one *is* kept in sync), so
  // toggling zoom again mid-transition continues smoothly from wherever
  // the camera/roll currently sit instead of snapping.
  let cameraShotFrom = { position: CLOSE_CAMERA_POSITION.clone(), target: CLOSE_CAMERA_TARGET.clone() }
  let cameraShotTo = { position: CLOSE_CAMERA_POSITION.clone(), target: CLOSE_CAMERA_TARGET.clone() }
  const cameraShotCurrent = { position: CLOSE_CAMERA_POSITION.clone(), target: CLOSE_CAMERA_TARGET.clone() }
  let rollFrom = CLOSE_VIEW_ROLL.clone()
  let rollTo = CLOSE_VIEW_ROLL.clone()
  // Starts at CAMERA_TRANSITION_SECONDS (i.e. already settled) so the
  // per-frame lerp below is a no-op until the first zoom toggle.
  let cameraTransitionElapsed = CAMERA_TRANSITION_SECONDS

  const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

  // Every zoom toggle discards any manual wheel roll rather than carrying
  // it across — zooming out always shows currentWideViewRoll (which
  // tracks the actual tilt, see setTilt below), and zooming back in
  // always resets to CLOSE_VIEW_ROLL (identity, "same as entering from
  // the title menu"), regardless of how far the wheel had rolled it
  // before the switch. Resetting viewRoll here (not just relying on the
  // animated rotationQuaternion) is what makes the *next* scroll start
  // fresh from that reset position instead of jumping back to wherever
  // the wheel had left off.
  const setShot = (position: Vector3, target: Vector3, roll: Quaternion): void => {
    cameraShotFrom = { position: cameraShotCurrent.position.clone(), target: cameraShotCurrent.target.clone() }
    cameraShotTo = { position: position.clone(), target: target.clone() }
    rollFrom = viewPivot.rotationQuaternion!.clone()
    rollTo = roll.clone()
    cameraTransitionElapsed = 0
    viewRoll = 0
  }

  // Erosion panel's tilt slider (wired up below) adjusts the planet's
  // actual axial tilt at runtime — updates tiltPivot directly (which both
  // panels already read every frame, so the tectonics panel updates for
  // free) and recomputes the erosion shot's roll to match, since that
  // roll is derived from this same tilt value (see computeWideViewRoll
  // above). Applied immediately rather than through the animated
  // transition when already zoomed out — a live slider drag should track
  // the pole, not animate a fixed distance behind it — but still updates
  // rollTo so an in-flight zoom transition still ends up at the new,
  // correct target instead of a stale one. The slider itself only lives
  // on the erosion panel, but this checks isZoomedOut (not panelIndex)
  // since the roll it's updating is a property of the zoom state, which
  // is now independent of which panel happens to be showing.
  const setTilt = (tiltDeg: number): void => {
    tiltPivot.rotation.z = (tiltDeg * Math.PI) / 180
    currentWideViewRoll = computeWideViewRoll(tiltPivot.rotation.z)
    drawLatitudeOverlay(tiltDeg)
    if (!isZoomedOut) return
    rollTo = currentWideViewRoll.clone()
    if (cameraTransitionElapsed >= CAMERA_TRANSITION_SECONDS) {
      viewPivot.rotationQuaternion!.copyFrom(currentWideViewRoll)
    }
  }

  scene.onBeforeRenderObservable.add(() => {
    if (cameraTransitionElapsed >= CAMERA_TRANSITION_SECONDS) return
    cameraTransitionElapsed = Math.min(CAMERA_TRANSITION_SECONDS, cameraTransitionElapsed + ctx.engine.getDeltaTime() / 1000)
    const t = easeInOutCubic(cameraTransitionElapsed / CAMERA_TRANSITION_SECONDS)
    Vector3.LerpToRef(cameraShotFrom.position, cameraShotTo.position, t, cameraShotCurrent.position)
    Vector3.LerpToRef(cameraShotFrom.target, cameraShotTo.target, t, cameraShotCurrent.target)
    camera.position.copyFrom(cameraShotCurrent.position)
    camera.setTarget(cameraShotCurrent.target)
    Quaternion.SlerpToRef(rollFrom, rollTo, t, viewPivot.rotationQuaternion!)
  })

  const root = document.createElement('div')
  root.className = 'worldgen-screen'
  root.innerHTML = `
    <div class="plate-info" data-value="plate-info"></div>
    <button type="button" class="nav-arrow nav-arrow--back" data-action="back" aria-label="Back">‹</button>
    <button type="button" class="nav-arrow nav-arrow--next" data-action="next" aria-label="Next">›</button>
    <button type="button" class="icon-toggle spin-toggle" data-action="toggle-spin" aria-label="Pause planet spin">
      <img src="/icons/spin_on.png" alt="" />
    </button>
    <button type="button" class="icon-toggle zoom-toggle" data-action="toggle-zoom" aria-label="Zoom out">
      <img src="/icons/zoom_on.png" alt="" />
    </button>
    <div class="panel" data-panel="0">
      <label class="field">
        <span class="field-label">Seed</span>
        <span class="field-row">
          <input type="text" class="seed-input" />
          <button type="button" class="icon-button" data-action="randomize-seed" aria-label="Randomize seed">
            <img src="/icons/dice.png" alt="" />
          </button>
        </span>
      </label>

      <label class="field">
        <span class="field-label">Continents <span data-value="continents">7</span></span>
        <input type="range" class="continents-input" min="3" max="13" step="1" value="7" />
      </label>

      <label class="field">
        <span class="field-label">Land / ocean ratio <span data-value="ratio">35%</span></span>
        <input type="range" class="ratio-input" min="0" max="1" step="0.01" value="0.35" />
      </label>

      <button type="button" class="icon-button" data-action="run" aria-label="Run tectonics">
        <img src="/icons/tectonics_off.png" alt="" />
      </button>
    </div>
    <div class="panel" data-panel="1" hidden>
      <label class="field">
        <span class="field-label">Axial tilt <span data-value="tilt">${DEFAULT_TILT_DEG}°</span></span>
        <input type="range" class="tilt-input" min="${TILT_MIN_DEG}" max="${TILT_MAX_DEG}" step="${TILT_STEP_DEG}" value="${DEFAULT_TILT_DEG}" />
      </label>
      <div class="temp-control">
        <button type="button" class="icon-button" data-action="toggle-temperature" aria-label="Hide temperature gradient">
          <img src="/icons/temp_on.png" alt="" />
        </button>
        <div class="temp-readout">
          <span data-value="temp-min"></span>
          <span data-value="temp-max"></span>
        </div>
      </div>
    </div>
  `

  const plateInfo = root.querySelector<HTMLElement>('[data-value="plate-info"]')!
  const seedInput = root.querySelector<HTMLInputElement>('.seed-input')!
  const continentsInput = root.querySelector<HTMLInputElement>('.continents-input')!
  const continentsValue = root.querySelector<HTMLElement>('[data-value="continents"]')!
  const ratioInput = root.querySelector<HTMLInputElement>('.ratio-input')!
  const ratioValue = root.querySelector<HTMLElement>('[data-value="ratio"]')!
  const tiltInput = root.querySelector<HTMLInputElement>('.tilt-input')!
  const tiltValue = root.querySelector<HTMLElement>('[data-value="tilt"]')!
  const tempMinValue = root.querySelector<HTMLElement>('[data-value="temp-min"]')!
  const tempMaxValue = root.querySelector<HTMLElement>('[data-value="temp-max"]')!
  const randomizeButton = root.querySelector<HTMLButtonElement>('[data-action="randomize-seed"]')!
  const toggleSpinButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-spin"]')!
  const toggleSpinIcon = toggleSpinButton.querySelector<HTMLImageElement>('img')!
  const toggleZoomButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-zoom"]')!
  const toggleZoomIcon = toggleZoomButton.querySelector<HTMLImageElement>('img')!
  const toggleTemperatureButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-temperature"]')!
  const toggleTemperatureIcon = toggleTemperatureButton.querySelector<HTMLImageElement>('img')!
  const runButton = root.querySelector<HTMLButtonElement>('[data-action="run"]')!
  const runIcon = runButton.querySelector<HTMLImageElement>('img')!

  // All simulation state (PlateWorld/CrustState) and the expensive
  // per-epoch texture generation now live entirely in this worker — see
  // worldgen.worker.ts for why. The main thread only ever sends a
  // command and applies whatever pixel buffer comes back; nothing here
  // can block a render frame or a pointer-drag handler on simulation
  // cost anymore.
  const worker = new Worker(new URL('../../worldgen/worldgen.worker.ts', import.meta.url), { type: 'module' })

  let latestState: WorkerResponse | undefined
  let disposed = false
  let isRunning = false
  let pendingTimeoutId: ReturnType<typeof setTimeout> | undefined

  // The run button itself is deliberately excluded — it's the toggle
  // that starts/stops the loop below, so it needs to stay clickable
  // while running.
  const setControlsDisabled = (disabled: boolean) => {
    seedInput.disabled = disabled
    continentsInput.disabled = disabled
    ratioInput.disabled = disabled
    randomizeButton.disabled = disabled
  }

  const stopEpochRun = () => {
    if (pendingTimeoutId !== undefined) {
      clearTimeout(pendingTimeoutId)
      pendingTimeoutId = undefined
    }
    if (isRunning) {
      isRunning = false
      setControlsDisabled(false)
      runIcon.src = '/icons/tectonics_off.png'
      runButton.setAttribute('aria-label', 'Run tectonics')
    }
  }

  const updateInfo = () => {
    if (!latestState) return
    plateInfo.textContent =
      `${latestState.totalCount} plates total — ${latestState.continentalCount} continental, ${latestState.oceanicCount} oceanic` +
      ` · epoch ${latestState.epochCount} · oldest plate ${latestState.oldestPlateAge}`
  }

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    if (disposed) return
    latestState = event.data
    worldTexture.update(latestState.pixels)
    updateInfo()

    if (!isRunning) return
    pendingTimeoutId = setTimeout(() => {
      pendingTimeoutId = undefined
      worker.postMessage({ type: 'stepEpoch' })
    }, EPOCH_STEP_DELAY_MS)
  }

  const regenerateWorld = () => {
    stopEpochRun()
    worker.postMessage({
      type: 'init',
      seedText: seedInput.value,
      continentCount: Number(continentsInput.value),
      ratio: Number(ratioInput.value),
    })
  }

  seedInput.value = randomSeed()
  seedInput.addEventListener('input', regenerateWorld)
  randomizeButton.addEventListener('click', () => {
    seedInput.value = randomSeed()
    regenerateWorld()
  })

  continentsInput.addEventListener('input', () => {
    continentsValue.textContent = continentsInput.value
    regenerateWorld()
  })

  ratioInput.addEventListener('input', () => {
    ratioValue.textContent = `${Math.round(Number(ratioInput.value) * 100)}%`
    regenerateWorld()
  })

  // Min drawn below max — see the AVG_TEMP comment near computeAverageTemps.
  const updateTemperatureReadout = (tiltDeg: number): void => {
    const { minC, maxC } = computeAverageTemps(tiltDeg)
    tempMinValue.textContent = `Min avg ${Math.round(minC)}°C`
    tempMaxValue.textContent = `Max avg ${Math.round(maxC)}°C`
  }

  tiltInput.addEventListener('input', () => {
    const tiltDeg = Number(tiltInput.value)
    tiltValue.textContent = `${tiltDeg.toFixed(1)}°`
    setTilt(tiltDeg)
    updateTemperatureReadout(tiltDeg)
  })
  updateTemperatureReadout(Number(tiltInput.value))

  regenerateWorld()

  toggleSpinButton.addEventListener('click', () => {
    isSpinning = !isSpinning
    toggleSpinIcon.src = isSpinning ? '/icons/spin_on.png' : '/icons/spin_off.png'
    toggleSpinButton.setAttribute('aria-label', isSpinning ? 'Pause planet spin' : 'Resume planet spin')
  })

  toggleZoomButton.addEventListener('click', () => {
    isZoomedOut = !isZoomedOut
    toggleZoomIcon.src = isZoomedOut ? '/icons/zoom_off.png' : '/icons/zoom_on.png'
    toggleZoomButton.setAttribute('aria-label', isZoomedOut ? 'Zoom in' : 'Zoom out')
    if (isZoomedOut) setShot(WIDE_CAMERA_POSITION, WIDE_CAMERA_TARGET, currentWideViewRoll)
    else setShot(CLOSE_CAMERA_POSITION, CLOSE_CAMERA_TARGET, CLOSE_VIEW_ROLL)
  })

  toggleTemperatureButton.addEventListener('click', () => {
    isTemperatureGradientVisible = !isTemperatureGradientVisible
    toggleTemperatureIcon.src = isTemperatureGradientVisible ? '/icons/temp_on.png' : '/icons/temp_off.png'
    toggleTemperatureButton.setAttribute('aria-label', isTemperatureGradientVisible ? 'Hide temperature gradient' : 'Show temperature gradient')
    drawLatitudeOverlay(Number(tiltInput.value))
  })

  runButton.addEventListener('click', () => {
    if (isRunning) {
      stopEpochRun()
      return
    }
    isRunning = true
    setControlsDisabled(true)
    runIcon.src = '/icons/tectonics_on.png'
    runButton.setAttribute('aria-label', 'Stop tectonics')
    worker.postMessage({ type: 'stepEpoch' })
  })

  // Panel switching only toggles which controls/overlays are showing now
  // — the camera zoom is the zoom button's own independent state (see
  // isZoomedOut/setShot above), not tied to which panel is open.
  const panels = Array.from(root.querySelectorAll<HTMLElement>('.panel'))
  let panelIndex = 0
  const showPanel = (index: number) => {
    panelIndex = index
    panels.forEach((panel, i) => {
      panel.hidden = i !== index
    })
    for (const mesh of erosionOverlayMeshes) mesh.isVisible = index === 1
  }

  root.querySelector('[data-action="back"]')!.addEventListener('click', () => {
    if (panelIndex > 0) {
      showPanel(panelIndex - 1)
      return
    }
    ctx.goTo('title')
  })
  root.querySelector('[data-action="next"]')!.addEventListener('click', () => {
    if (panelIndex < panels.length - 1) showPanel(panelIndex + 1)
  })
  ctx.overlay.appendChild(root)

  return {
    scene,
    dispose() {
      disposed = true
      stopEpochRun()
      worker.terminate()
      scene.dispose()
    },
  }
}
