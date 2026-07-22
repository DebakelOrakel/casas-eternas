import { Mesh, MeshBuilder, Scene, ShaderMaterial } from '@babylonjs/core'

// A huge inward-facing sphere, never parented to anything that spins —
// dragging the planet must not move the sky. Star positions/sizes/phases
// are all derived from a per-cell hash, computed per-pixel in the
// fragment shader rather than placed as individual objects, so there's no
// per-star CPU or draw-call cost regardless of how many stars are on
// screen.
const SKYDOME_DIAMETER = 200

const vertexSource = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vPosition;

void main(void) {
  vPosition = position;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`

// Colors are inverted from a normal night sky (white background, black
// stars) per the requested look — mix() below goes from white toward
// black as star brightness increases, not the other way around.
//
// Every star is the same shape: a cross 4 units high and 1 unit wide
// with the ends connected by a curve rather than straight lines — that's
// an elongated astroid, (|x|/a)^(2/3) + (|y|/b)^(2/3) = 1, the classic
// 4-cusped curve (cusps at the tips, concave sides pulling in between
// them, which is what makes it read as a sparkle rather than a plain
// diamond). All stars share the same orientation too — every star's "up"
// is the tangent-plane projection of the fixed world Y axis at its own
// position, not a per-star random rotation. Brightness is quantized into
// a few discrete bands rather than a smooth gradient, for a flatter,
// hand-inked look instead of a photographic glow.
//
// Stars only exist near a band tilted ~5° from world Y — independent of
// the planet's own tiltPivot rotation, since this mesh isn't parented to
// it at all — rather than being spread across the whole sky at varying
// density: the threshold is pushed above what hash13 can ever produce
// outside the band, so there's a real empty gap, not just a thin one.
//
// Cell size is deliberately small: the camera's alpha/beta are locked
// (see WorldGenScreen.ts), so it only ever sees a narrow, fixed slice of
// this whole procedural sky — a density tuned to "looks right averaged
// over the full sphere" reads as nearly empty within that slice.
const fragmentSource = `
precision highp float;
varying vec3 vPosition;
uniform float time;

const float BAND_TILT = 0.0872664626; // ~5 degrees, in radians

float hash13(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

void main(void) {
  vec3 dir = normalize(vPosition);

  vec3 bandNormal = normalize(vec3(0.0, cos(BAND_TILT), sin(BAND_TILT)));
  float bandCloseness = 1.0 - smoothstep(0.0, 0.2, abs(dot(dir, bandNormal)));
  // hash13's output is always < 1.0, so 1.5 outside the band is an
  // impossible-to-cross threshold — a real gap, not just a sparser one.
  float threshold = mix(1.5, 0.78, bandCloseness);

  float cellSize = 0.035;
  vec3 cell = floor(dir / cellSize);
  float starChance = hash13(cell);
  float brightness = 0.0;

  if (starChance > threshold) {
    vec3 cellCenter = (cell + 0.5) * cellSize;
    vec3 jitter = vec3(
      hash13(cell + vec3(1.0, 0.0, 0.0)),
      hash13(cell + vec3(0.0, 1.0, 0.0)),
      hash13(cell + vec3(0.0, 0.0, 1.0))
    ) - 0.5;
    vec3 starPos = normalize(cellCenter + jitter * cellSize);

    // Fixed orientation for every star: the tangent-plane projection of
    // world "up" at this star's own position, not a per-star rotation.
    // Falls back to a different reference axis right at the pole where
    // that projection would otherwise be degenerate.
    vec3 worldUp = vec3(0.0, 1.0, 0.0);
    vec3 tangentUpRaw = worldUp - starPos * dot(worldUp, starPos);
    if (dot(tangentUpRaw, tangentUpRaw) < 0.0001) {
      vec3 altUp = vec3(1.0, 0.0, 0.0);
      tangentUpRaw = altUp - starPos * dot(altUp, starPos);
    }
    vec3 tangentUp = normalize(tangentUpRaw);
    vec3 tangentRight = normalize(cross(tangentUp, starPos));

    vec3 offset = dir - starPos;
    vec2 local = vec2(dot(offset, tangentRight), dot(offset, tangentUp));

    float starSize = 0.004 + hash13(cell + vec3(2.0, 3.0, 5.0)) * 0.006;
    float halfHeight = starSize * 2.0; // "4 units high"
    float halfWidth = starSize * 0.5; // "1 unit wide"
    float qx = pow(abs(local.x) / halfWidth, 2.0 / 3.0);
    float qy = pow(abs(local.y) / halfHeight, 2.0 / 3.0);
    float astroidValue = qx + qy; // < 1 inside, 1 on the boundary, > 1 outside
    float shape = 1.0 - smoothstep(0.85, 1.045, astroidValue);
    shape = clamp(shape, 0.0, 1.0);
    shape = floor(shape * 3.0 + 0.5) / 3.0; // quantize into a few bands — inked, not smooth-gradient

    float phase = hash13(cell + vec3(7.0, 11.0, 13.0)) * 6.28318;
    float speed = 0.15 + hash13(cell + vec3(17.0, 19.0, 23.0)) * 0.35;
    float twinkle = 0.6 + 0.4 * sin(time * speed + phase);

    brightness = shape * twinkle;
  }

  vec3 color = mix(vec3(1.0), vec3(0.0), brightness);
  gl_FragColor = vec4(color, 1.0);
}
`

export function createStarfield(scene: Scene): Mesh {
  // Higher segment count than a plain backdrop would need, since star
  // cells are now small enough that a low-poly sphere's flat facets would
  // visibly distort vPosition's interpolation across each triangle.
  const skydome = MeshBuilder.CreateSphere('starfield', { diameter: SKYDOME_DIAMETER, segments: 64 }, scene)
  // Camera sits inside this sphere, so the normally-culled back faces are
  // the ones actually visible — front-face culling would show nothing.
  skydome.material = createStarfieldMaterial(scene)
  return skydome
}

function createStarfieldMaterial(scene: Scene): ShaderMaterial {
  const material = new ShaderMaterial(
    'starfieldMaterial',
    scene,
    { vertexSource, fragmentSource },
    { attributes: ['position'], uniforms: ['worldViewProjection', 'time'] },
  )
  material.backFaceCulling = false
  material.setFloat('time', 0)
  scene.onBeforeRenderObservable.add(() => {
    material.setFloat('time', performance.now() / 1000)
  })
  return material
}
