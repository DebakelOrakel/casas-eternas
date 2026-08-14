import { Color3, MaterialPluginBase } from '@babylonjs/core'
import type { BaseTexture, Material, MaterialDefines, Scene, SubMesh, UniformBuffer } from '@babylonjs/core'

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
  private periodX = 1
  private periodY = 1
  private color = new Color3(0.15, 0.2, 0.28)
  private fadeStart = 1e9
  private fadeEnd = 1e9
  private highlightX = 0
  private highlightZ = 0
  private highlightOn = 0
  private colCount = 1
  private rowCount = 1
  private classTexture: BaseTexture | null = null
  private classWindow = { col0: 0, row0: 0, cols: 1, rows: 1 }

  constructor(material: Material) {
    super(material, 'HexGrid', 200, { HEXGRID: false, HEXCLASSES: false })
    this._enable(true)
  }

  configure(spacingX: number, spacingY: number, periodX: number, periodY: number, color?: Color3): void {
    this.spacingX = spacingX
    this.spacingY = spacingY
    this.periodX = periodX
    this.periodY = periodY
    // The lattice counts are exact by the torus snap; the shader needs them
    // to canonicalize a fragment's (col, row) the same way hexGrid.ts does.
    this.colCount = Math.round(periodX / spacingX)
    this.rowCount = Math.round(periodY / spacingY)
    if (color) this.color = color
  }

  // A window of per-tile class bytes (phase 2's debug overlay): the texture's
  // red channel carries 0 = no data, 1 = water, 2 = shore, 3+g = land with
  // grade bin g (0..10). The window is a (cols × rows) rectangle of
  // torus-canonical tiles starting at (col0, row0); the shader tints every
  // fragment whose tile falls inside it. null clears the overlay.
  setClassOverlay(texture: BaseTexture | null, window?: { col0: number; row0: number; cols: number; rows: number }): void {
    const wasOn = this.classTexture !== null
    this.classTexture = texture
    if (window) this.classWindow = window
    if (wasOn !== (texture !== null)) this.markAllDefinesAsDirty()
  }

  // The hovered tile, as its canonical center (map/hexGrid.ts) — the shader
  // matches it against each fragment's own nearest lattice center modulo
  // the toroidal period, so the highlight lights up on every wrap copy.
  // null clears it. Only meaningful while the grid is visible; the fades
  // apply to the fill exactly as they do to the lines.
  setHighlight(center: { x: number; z: number } | null): void {
    this.highlightOn = center ? 1 : 0
    if (center) {
      this.highlightX = center.x
      this.highlightZ = center.z
    }
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
    defines['HEXCLASSES'] = this.strengthValue > 0 && this.classTexture !== null
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('hexClassSampler')
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [
        { name: 'hexGridStrength', size: 1, type: 'float' },
        { name: 'hexGridSpacing', size: 2, type: 'vec2' },
        { name: 'hexGridColor', size: 3, type: 'vec3' },
        { name: 'hexGridEye', size: 3, type: 'vec3' },
        { name: 'hexGridFade', size: 2, type: 'vec2' },
        { name: 'hexGridPeriod', size: 2, type: 'vec2' },
        { name: 'hexGridHighlight', size: 3, type: 'vec3' },
        { name: 'hexGridCounts', size: 2, type: 'vec2' },
        { name: 'hexClassWindow', size: 4, type: 'vec4' },
      ],
      fragment: `#ifdef HEXGRID
        uniform float hexGridStrength;
        uniform vec2 hexGridSpacing;
        uniform vec3 hexGridColor;
        uniform vec3 hexGridEye;
        uniform vec2 hexGridFade;
        uniform vec2 hexGridPeriod;
        uniform vec3 hexGridHighlight;
        uniform vec2 hexGridCounts;
        uniform vec4 hexClassWindow;
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
    uniformBuffer.updateFloat2('hexGridPeriod', this.periodX, this.periodY)
    uniformBuffer.updateFloat3('hexGridHighlight', this.highlightX, this.highlightZ, this.highlightOn)
    uniformBuffer.updateFloat2('hexGridCounts', this.colCount, this.rowCount)
    uniformBuffer.updateFloat4('hexClassWindow', this.classWindow.col0, this.classWindow.row0, this.classWindow.cols, this.classWindow.rows)
    if (this.classTexture) uniformBuffer.setTexture('hexClassSampler', this.classTexture)
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
          // The sampler is declared HERE and not in getUniforms().fragment:
          // that block is only injected on engines without uniform buffers,
          // so on WebGL2 the sampler would be undeclared, the effect would
          // fail to compile, and Babylon would silently keep rendering with
          // the previous effect — grid visible, overlay impossible.
          #ifdef HEXCLASSES
          uniform sampler2D hexClassSampler;
          #endif
          #ifdef HEXGRID
          float hexEdgeDistance(vec2 p, vec2 s, out vec2 center) {
            vec2 period = vec2(s.x, 2.0 * s.y);
            vec2 a = floor(p / period + 0.5) * period;
            vec2 halfOff = vec2(0.5 * s.x, s.y);
            vec2 b = floor((p - halfOff) / period + 0.5) * period + halfOff;
            float d1 = 1e9;
            float d2 = 1e9;
            center = a;
            // Nearest + second-nearest over both lattices' local candidates
            // (each plus its horizontal neighbors — hexes also border
            // same-lattice cells sideways). The nearest center doubles as
            // the fragment's tile identity for the hover highlight.
            for (int i = -1; i <= 1; i++) {
              float dx = float(i) * s.x;
              vec2 ca = a + vec2(dx, 0.0);
              float da = distance(p, ca);
              if (da < d1) { d2 = d1; d1 = da; center = ca; } else if (da < d2) { d2 = da; }
              vec2 cb = b + vec2(dx, 0.0);
              float db = distance(p, cb);
              if (db < d1) { d2 = d1; d1 = db; center = cb; } else if (db < d2) { d2 = db; }
            }
            return 0.5 * (d2 - d1);
          }
          #endif`,
        CUSTOM_FRAGMENT_MAIN_END: `#ifdef HEXGRID
          {
            vec2 hexCenter;
            float hexD = hexEdgeDistance(vHexWorldPos.xz, hexGridSpacing, hexCenter);
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
            // Per-tile class tint (phase 2 debug overlay), UNDER the lines:
            // derive the fragment's canonical (col, row) from its nearest
            // center — the same odd-row-offset convention as hexGrid.ts —
            // and look it up in the class window texture.
            #ifdef HEXCLASSES
            {
              float hcRow = floor(hexCenter.y / hexGridSpacing.y + 0.5);
              float hcOdd = mod(hcRow, 2.0);
              float hcCol = floor((hexCenter.x - hcOdd * 0.5 * hexGridSpacing.x) / hexGridSpacing.x + 0.5);
              hcRow = mod(hcRow, hexGridCounts.y);
              hcCol = mod(hcCol, hexGridCounts.x);
              float dcol = mod(hcCol - hexClassWindow.x, hexGridCounts.x);
              float drow = mod(hcRow - hexClassWindow.y, hexGridCounts.y);
              if (dcol < hexClassWindow.z && drow < hexClassWindow.w) {
                vec4 clsTexel = texture2D(hexClassSampler, vec2((dcol + 0.5) / hexClassWindow.z, (drow + 0.5) / hexClassWindow.w));
                float cls = clsTexel.r * 255.0;
                vec3 clsColor = vec3(0.0);
                float clsOn = 0.0;
                if (cls >= 0.5 && cls < 1.5) { clsColor = vec3(0.15, 0.35, 0.75); clsOn = 1.0; }
                else if (cls >= 1.5 && cls < 2.5) { clsColor = vec3(0.92, 0.78, 0.35); clsOn = 1.0; }
                else if (cls >= 2.5) {
                  float g = clamp((cls - 3.0) / 10.0, 0.0, 1.0);
                  clsColor = mix(vec3(0.82, 0.2, 0.15), vec3(0.2, 0.72, 0.25), g);
                  clsOn = 1.0;
                }
                // Green channel: a river reserves ports on this tile. Shown
                // as its own colour over the terrain class, because a river
                // tile still has a class worth reading.
                if (clsTexel.g > 0.5) { clsColor = vec3(0.25, 0.55, 0.95); clsOn = 1.0; }
                gl_FragColor.rgb = mix(gl_FragColor.rgb, clsColor, clsOn * 0.3 * hexCoverage * hexDistFade * hexGridStrength);
              }
            }
            #endif
            // Hover highlight: the hovered tile's canonical center arrives
            // as a uniform; matching it modulo the toroidal period keeps the
            // fill on all wrap copies. Half a column spacing separates
            // distinct centers, so a quarter of it is an unambiguous match
            // radius.
            vec2 hexHlDelta = hexCenter - hexGridHighlight.xy;
            hexHlDelta -= hexGridPeriod * floor(hexHlDelta / hexGridPeriod + 0.5);
            float hexHlMatch = hexGridHighlight.z * (1.0 - step(0.25 * hexGridSpacing.x, length(hexHlDelta)));
            float hexShade = max(hexLine * 0.45, hexHlMatch * 0.22);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, hexGridColor, hexShade * hexCoverage * hexDistFade * hexGridStrength);
          }
          #endif`,
      }
    }
    return null
  }
}
