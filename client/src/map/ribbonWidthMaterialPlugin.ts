import { MaterialPluginBase } from '@babylonjs/core'
import type { Material, Scene, SubMesh, UniformBuffer } from '@babylonjs/core'

// Vertex-shader half of the river ribbons' width rule (the data half lives in
// ToroidalRibbonOverlay): the mesh carries the ribbon CENTERLINE, and each
// vertex brings its offset direction plus two half-widths — physical (world
// units) and cartographic (screen pixels). The final offset is
//
//   max(physical, cartographic * worldUnitsPerPixel)
//
// evaluated here per frame from a single uniform. That is what makes the
// width continuous in zoom without ever rebuilding geometry: in the map
// regime the line holds a constant screen width, and the descent hands over
// to the physical width exactly where it becomes the larger of the two.
export class RibbonWidthMaterialPlugin extends MaterialPluginBase {
  private getWorldPerPixel: () => number

  constructor(material: Material, getWorldPerPixel: () => number) {
    super(material, 'RibbonWidth', 190)
    this.getWorldPerPixel = getWorldPerPixel
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
      ubo: [{ name: 'ribbonWorldPerPixel', size: 1, type: 'float' }],
      vertex: 'uniform float ribbonWorldPerPixel;',
    }
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: unknown, _subMesh: SubMesh): void {
    uniformBuffer.updateFloat('ribbonWorldPerPixel', this.getWorldPerPixel())
  }

  override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType !== 'vertex') return null
    return {
      CUSTOM_VERTEX_DEFINITIONS: `attribute vec2 ribbonDir;
attribute vec2 ribbonWidths;`,
      // Offsets happen in the mesh's local XZ, before the world matrix — so
      // the 3x3 toroidal wrap instances (pure translations) all widen alike.
      CUSTOM_VERTEX_UPDATE_POSITION: 'positionUpdated.xz += ribbonDir * max(ribbonWidths.x, ribbonWidths.y * ribbonWorldPerPixel);',
    }
  }
}
