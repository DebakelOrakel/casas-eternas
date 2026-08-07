import { Color3, MaterialPluginBase } from '@babylonjs/core'
import type { Material, MaterialDefines, Scene, SubMesh, UniformBuffer } from '@babylonjs/core'

// Fragment-shader hex grid over the relief material — the LOGICAL 300 m
// grid's first visible incarnation (docs/design/hex-world-view.md), drawn as
// pure math on the fragments that are being shaded anyway: no tile
// geometry, no second draw pass, no texture (at 1.6 billion tiles none of
// those could work).
//
// The lines are the Voronoi boundaries of two interleaved rectangular
// lattices — which IS a (slightly anisotropy-tolerant) pointy-top hex
// tiling: lattice A at (i·sx, 2k·sy), lattice B offset by (sx/2, sy). For a
// fragment, the distance to the boundary between the two nearest centers is
// (d2 − d1)/2; thresholding that with fwidth() gives a constant ~1.5 px
// line with clean antialiasing, and the same fwidth doubles as a moiré
// guard — where a whole cell shrinks toward pixel size, the grid fades out
// instead of shimmering.
//
// Everything is keyed off the world XZ position (own varying, taken from
// the vertex stage's worldPos), so the grid is welded to the ground —
// including across the 3x3 toroidal wrap copies, provided the spacings tile
// the world period exactly (see mapSceneSettings' snapped HEX_*_SPACING).
export class HexGridMaterialPlugin extends MaterialPluginBase {
  private strengthValue = 0
  private spacingX = 1
  private spacingY = 1
  private color = new Color3(0.15, 0.2, 0.28)
  private fadeStart = 1e9
  private fadeEnd = 1e9

  constructor(material: Material) {
    super(material, 'HexGrid', 200, { HEXGRID: false })
    this._enable(true)
  }

  configure(spacingX: number, spacingY: number, color?: Color3): void {
    this.spacingX = spacingX
    this.spacingY = spacingY
    if (color) this.color = color
  }

  // 0 = off (the shader branch is compiled out entirely), 0..1 = line
  // opacity. Crossing zero re-toggles the define, i.e. one shader recompile
  // per on/off transition — not per frame.
  setStrength(value: number): void {
    const wasOn = this.strengthValue > 0
    this.strengthValue = value
    if (wasOn !== value > 0) this.markAllDefinesAsDirty()
  }

  // View-distance band over which the grid fades out (world units): fully
  // drawn inside `start`, gone at `end`. The grid is applied AFTER the
  // scene fog in the shader chain, so without this ferne lines would sit
  // full-contrast on hazy terrain and shimmer all the way to the horizon —
  // the fade keeps the grid a NEAR-field instrument and ends it well before
  // the haze.
  setFade(start: number, end: number): void {
    this.fadeStart = start
    this.fadeEnd = end
  }

  override getClassName(): string {
    return 'HexGridMaterialPlugin'
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines['HEXGRID'] = this.strengthValue > 0
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [
        { name: 'hexGridStrength', size: 1, type: 'float' },
        { name: 'hexGridSpacing', size: 2, type: 'vec2' },
        { name: 'hexGridColor', size: 3, type: 'vec3' },
        { name: 'hexGridEye', size: 3, type: 'vec3' },
        { name: 'hexGridFade', size: 2, type: 'vec2' },
      ],
      fragment: `#ifdef HEXGRID
        uniform float hexGridStrength;
        uniform vec2 hexGridSpacing;
        uniform vec3 hexGridColor;
        uniform vec3 hexGridEye;
        uniform vec2 hexGridFade;
      #endif`,
    }
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, _engine: unknown, _subMesh: SubMesh): void {
    if (this.strengthValue <= 0) return
    uniformBuffer.updateFloat('hexGridStrength', this.strengthValue)
    uniformBuffer.updateFloat2('hexGridSpacing', this.spacingX, this.spacingY)
    uniformBuffer.updateColor3('hexGridColor', this.color)
    const eye = scene.activeCamera?.globalPosition
    uniformBuffer.updateFloat3('hexGridEye', eye?.x ?? 0, eye?.y ?? 0, eye?.z ?? 0)
    uniformBuffer.updateFloat2('hexGridFade', this.fadeStart, this.fadeEnd)
  }

  override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType === 'vertex') {
      return {
        CUSTOM_VERTEX_DEFINITIONS: 'varying vec3 vHexWorldPos;',
        // worldPos is the default vertex shader's own world-space position —
        // carried as an own varying so the grid never depends on whether
        // vPositionW happens to be compiled in.
        CUSTOM_VERTEX_MAIN_END: 'vHexWorldPos = worldPos.xyz;',
      }
    }
    if (shaderType === 'fragment') {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: `varying vec3 vHexWorldPos;
          #ifdef HEXGRID
          float hexEdgeDistance(vec2 p, vec2 s) {
            vec2 period = vec2(s.x, 2.0 * s.y);
            vec2 a = floor(p / period + 0.5) * period;
            vec2 halfOff = vec2(0.5 * s.x, s.y);
            vec2 b = floor((p - halfOff) / period + 0.5) * period + halfOff;
            float d1 = 1e9;
            float d2 = 1e9;
            // Nearest + second-nearest over both lattices' local candidates
            // (each plus its horizontal neighbors — hexes also border
            // same-lattice cells sideways).
            for (int i = -1; i <= 1; i++) {
              float dx = float(i) * s.x;
              float da = distance(p, a + vec2(dx, 0.0));
              if (da < d1) { d2 = d1; d1 = da; } else if (da < d2) { d2 = da; }
              float db = distance(p, b + vec2(dx, 0.0));
              if (db < d1) { d2 = d1; d1 = db; } else if (db < d2) { d2 = db; }
            }
            return 0.5 * (d2 - d1);
          }
          #endif`,
        CUSTOM_FRAGMENT_MAIN_END: `#ifdef HEXGRID
          {
            float hexD = hexEdgeDistance(vHexWorldPos.xz, hexGridSpacing);
            float aa = fwidth(hexD);
            float hexLine = 1.0 - smoothstep(0.6 * aa, 1.5 * aa, hexD);
            // Moiré guard: once the antialiasing footprint approaches the
            // cell size, cells are near-subpixel — fade the grid instead of
            // letting it shimmer. Tight on purpose; the distance fade below
            // is the primary limiter, this catches grazing angles.
            float hexCoverage = 1.0 - smoothstep(0.06, 0.18, aa / hexGridSpacing.x);
            // Near-field fade: the grid ends well before the haze — it is
            // applied after the scene fog, so distant lines would otherwise
            // sit full-contrast on fogged terrain.
            float hexDist = distance(vHexWorldPos, hexGridEye);
            float hexDistFade = 1.0 - smoothstep(hexGridFade.x, hexGridFade.y, hexDist);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, hexGridColor, hexLine * hexCoverage * hexDistFade * hexGridStrength * 0.45);
          }
          #endif`,
      }
    }
    return null
  }
}
