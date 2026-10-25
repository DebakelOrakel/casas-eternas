import { RawTexture, MaterialPluginBase } from '@babylonjs/core'
import type { BaseTexture, Material, MaterialDefines, Scene, UniformBuffer } from '@babylonjs/core'

// A screen's own layer over the map (2026-10-25, for the incubator): an RGBA
// texture laid over the map's composite by its alpha, in the materials'
// own fragments — so a layer that changes often (an animation) uploads
// only itself, not the composite. The texture spans the chart as the
// composite does (top row first), at any size. On the globe it is laid on
// the surface's colour before the light, as the water is; on the flat map
// over the finished fragment, after the water (this plugin runs after it,
// priority 300 against the water's 190). Off (compiled out) until a
// texture is given. The generator does not use it.
export class OverlayMaterialPlugin extends MaterialPluginBase {
  private texture: BaseTexture | null = null
  private readonly style: 'globe' | 'paper'

  constructor(material: Material, style: 'globe' | 'paper') {
    super(material, 'MapOverlay', 300, { MAPOVERLAY: false })
    this.style = style
    this._enable(true)
  }

  setTexture(texture: BaseTexture | null): void {
    const wasOn = this.texture !== null
    this.texture = texture
    if (wasOn !== (texture !== null)) this.markAllDefinesAsDirty()
  }

  override getClassName(): string {
    return 'OverlayMaterialPlugin'
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines['MAPOVERLAY'] = this.texture !== null
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('mapOverlaySampler')
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    if (this.texture) uniformBuffer.setTexture('mapOverlaySampler', this.texture)
  }

  override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType === 'vertex') {
      return {
        CUSTOM_VERTEX_DEFINITIONS: 'varying vec2 vOverlayUV;',
        CUSTOM_VERTEX_MAIN_END: 'vOverlayUV = uv;',
      }
    }
    if (shaderType === 'fragment') {
      return {
        // The sampler declared here, not in getUniforms (see
        // hexGridMaterialPlugin.ts for why).
        CUSTOM_FRAGMENT_DEFINITIONS: `varying vec2 vOverlayUV;
          #ifdef MAPOVERLAY
          uniform sampler2D mapOverlaySampler;
          #endif`,
        // Both points on every style, one of them empty: Babylon collects the
        // point names once, before this.style is set (waterMaterialPlugin.ts).
        CUSTOM_FRAGMENT_UPDATE_DIFFUSE: this.style === 'globe' ? `#ifdef MAPOVERLAY
          {
            vec4 overlayTexel = texture2D(mapOverlaySampler, vOverlayUV);
            baseColor.rgb = mix(baseColor.rgb, overlayTexel.rgb, overlayTexel.a);
          }
          #endif` : '',
        CUSTOM_FRAGMENT_MAIN_END: this.style === 'globe' ? '' : `#ifdef MAPOVERLAY
          {
            vec4 overlayTexel = texture2D(mapOverlaySampler, vOverlayUV);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, overlayTexel.rgb, overlayTexel.a);
          }
          #endif`,
      }
    }
    return null
  }
}

// The overlay's texture, shared by the plugins of one view: made on the
// first pixels, made again when the size changes; null takes it off.
export interface MapOverlay {
  set(pixels: Uint8Array | null, width: number, height: number): void
  dispose(): void
}

export function createMapOverlay(scene: Scene, plugins: readonly OverlayMaterialPlugin[]): MapOverlay {
  let texture: RawTexture | null = null
  return {
    set(pixels, width, height) {
      if (!pixels) {
        for (const plugin of plugins) plugin.setTexture(null)
        return
      }
      if (!texture || texture.getSize().width !== width || texture.getSize().height !== height) {
        texture?.dispose()
        texture = RawTexture.CreateRGBATexture(pixels, width, height, scene, false, false)
        texture.wrapU = RawTexture.WRAP_ADDRESSMODE
        texture.wrapV = RawTexture.CLAMP_ADDRESSMODE
      } else {
        texture.update(pixels)
      }
      for (const plugin of plugins) plugin.setTexture(texture)
    },
    dispose() {
      for (const plugin of plugins) plugin.setTexture(null)
      texture?.dispose()
      texture = null
    },
  }
}
