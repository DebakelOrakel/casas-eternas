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
    attributes.push('ribbonDir', 'ribbonWidths')
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; vertex: string } {
    return {
      ubo: [
        { name: 'ribbonWorldPerPixel', size: 1, type: 'float' },
        { name: 'ribbonMinRel', size: 1, type: 'float' },
      ],
      vertex: `uniform float ribbonWorldPerPixel;
uniform float ribbonMinRel;`,
    }
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: unknown, _subMesh: SubMesh): void {
    uniformBuffer.updateFloat('ribbonWorldPerPixel', this.getWorldPerPixel())
    uniformBuffer.updateFloat('ribbonMinRel', this.getMinRel())
  }

  override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType !== 'vertex') return null
    return {
      CUSTOM_VERTEX_DEFINITIONS: `attribute vec2 ribbonDir;
attribute vec3 ribbonWidths;`,
      // Offsets happen in the mesh's local XZ, before the world matrix — so
      // the 3x3 toroidal wrap instances (pure translations) all widen alike.
      // The band sits BELOW the threshold (smoothstep hits 1 exactly at
      // ribbonMinRel), so a threshold of zero reveals everything in full.
      CUSTOM_VERTEX_UPDATE_POSITION: `positionUpdated.xz += ribbonDir * (max(ribbonWidths.x, ribbonWidths.y * ribbonWorldPerPixel) * smoothstep(ribbonMinRel - ${REVEAL_BAND.toFixed(3)}, ribbonMinRel, ribbonWidths.z));`,
    }
  }
}
