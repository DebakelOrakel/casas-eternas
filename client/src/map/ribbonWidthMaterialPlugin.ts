import { MaterialPluginBase } from '@babylonjs/core'
import type { Material, Scene, SubMesh, UniformBuffer } from '@babylonjs/core'

// Vertex-shader half of the river ribbons' width rule (the data half lives in
// ToroidalRibbonOverlay): the mesh carries the ribbon CENTERLINE, and each
// vertex brings its offset direction plus two half-widths — physical (world
// units) and cartographic (screen pixels) — and its relative discharge. The
// final offset is
//
//   max(physical, cartographic * worldUnitsPerPixel) * reveal
//
// evaluated here per frame from two uniforms. That is what makes both rules
// continuous in zoom without ever rebuilding geometry: in the map regime the
// line holds a constant screen width, the descent hands over to the physical
// width exactly where it becomes the larger of the two, and `reveal` is the
// zoom-Q filter — rivers whose discharge falls below the frame's threshold
// (ToroidalRibbonOverlay's presence rule) collapse to zero width, i.e. to
// degenerate triangles that rasterise nothing. The smoothstep band means a
// tributary near the threshold draws thinner rather than popping: its tip
// tapers out of the trunk as the threshold sweeps past, both along the line
// (discharge grows downstream) and over time while zooming.
const REVEAL_BAND = 0.03

// The flow regime's line style (F6): a second per-vertex attribute carries
// the arc length along the centreline (world units) and the regime code
// (hydrology.RIVER_REGIME_CODE). Intermittent rivers draw dashed, ephemeral
// ones dotted — the cartographic convention — with the pattern in SCREEN
// pixels from the same world-per-pixel uniform the width rule reads, so it
// holds its rhythm at every zoom without a rebuild. Period and duty cycle
// per regime, pixels and a fraction.
const DASH_PERIOD_PX = [1, 22, 10]
const DASH_ON = [1, 0.64, 0.4]

export class RibbonWidthMaterialPlugin extends MaterialPluginBase {
  private getWorldPerPixel: () => number
  private getMinRel: () => number

  constructor(material: Material, getWorldPerPixel: () => number, getMinRel: () => number = () => 0) {
    super(material, 'RibbonWidth', 190)
    this.getWorldPerPixel = getWorldPerPixel
    this.getMinRel = getMinRel
    this._enable(true)
  }

  override getClassName(): string {
    return 'RibbonWidthMaterialPlugin'
  }

  override getAttributes(attributes: string[]): void {
    attributes.push('ribbonDir', 'ribbonWidths', 'ribbonStyle')
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; vertex: string; fragment: string } {
    return {
      ubo: [
        { name: 'ribbonWorldPerPixel', size: 1, type: 'float' },
        { name: 'ribbonMinRel', size: 1, type: 'float' },
      ],
      vertex: `uniform float ribbonWorldPerPixel;
uniform float ribbonMinRel;`,
      fragment: `uniform float ribbonWorldPerPixel;`,
    }
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: unknown, _subMesh: SubMesh): void {
    uniformBuffer.updateFloat('ribbonWorldPerPixel', this.getWorldPerPixel())
    uniformBuffer.updateFloat('ribbonMinRel', this.getMinRel())
  }

  override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType === 'fragment') {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: `varying vec2 vRibbonStyle;`,
        // Regime 0 is solid; the others cut the ribbon along its arc.
        CUSTOM_FRAGMENT_MAIN_BEGIN: `if (vRibbonStyle.y > 0.5) {
  float period = ribbonWorldPerPixel * (vRibbonStyle.y > 1.5 ? ${DASH_PERIOD_PX[2].toFixed(1)} : ${DASH_PERIOD_PX[1].toFixed(1)});
  float on = vRibbonStyle.y > 1.5 ? ${DASH_ON[2].toFixed(2)} : ${DASH_ON[1].toFixed(2)};
  if (fract(vRibbonStyle.x / period) > on) discard;
}`,
      }
    }
    if (shaderType !== 'vertex') return null
    return {
      CUSTOM_VERTEX_DEFINITIONS: `attribute vec2 ribbonDir;
attribute vec3 ribbonWidths;
attribute vec2 ribbonStyle;
varying vec2 vRibbonStyle;`,
      CUSTOM_VERTEX_MAIN_END: `vRibbonStyle = ribbonStyle;`,
      // Offsets happen in the mesh's local XZ, before the world matrix — so
      // the 3x3 toroidal wrap instances (pure translations) all widen alike.
      // The band sits BELOW the threshold (smoothstep hits 1 exactly at
      // ribbonMinRel), so a threshold of zero reveals everything in full.
      CUSTOM_VERTEX_UPDATE_POSITION: `positionUpdated.xz += ribbonDir * (max(ribbonWidths.x, ribbonWidths.y * ribbonWorldPerPixel) * smoothstep(ribbonMinRel - ${REVEAL_BAND.toFixed(3)}, ribbonMinRel, ribbonWidths.z));`,
    }
  }
}
