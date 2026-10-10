import { Color3, DynamicTexture, Mesh, type AbstractMesh, type Scene, StandardMaterial, Texture, VertexData } from '@babylonjs/core'
import type { SymbolFrame } from './symbolPlacement'
import type { SymbolPicture, WorldSymbol, WorldSymbols } from './worldView'

// THE SYMBOL LAYERS of a world view (worldView.ts, WorldSymbols), the part
// both shapes share: the pictures packed into one texture per layer, the
// symbols built into one mesh per layer — a few quads each, all in a single
// draw — and the view's placement (symbolPlacement.ts) deciding where each
// vertex lies. A fade rebuilds the mesh's few vertices, not the texture.

export interface SymbolPlacement {
  // The frame a symbol is laid in.
  frame(symbol: WorldSymbol): SymbolFrame
  // A point of the picture, (x, y) metres from its centre along the frame's
  // right and up, into out[offset..offset + 2].
  vertex(frame: SymbolFrame, x: number, y: number, out: Float32Array, offset: number): void
  // How many quads a picture is cut into along each side: one on a plane,
  // more on a sphere, so a large picture follows the surface.
  segments(picture: SymbolPicture): number
}

export interface SymbolLayerSet {
  symbols(id: string): WorldSymbols
  // The placement changed (the flat map's relief under the symbols): build
  // every layer again from what it holds.
  relayout(): void
  dispose(): void
}

// Space around each picture in the texture, pixels, so the filtering of the
// smaller mip levels does not reach a neighbour.
const ATLAS_PADDING = 4
const ATLAS_MAX_SIDE = 4096

interface AtlasRect {
  x: number
  y: number
  w: number
  h: number
}

// Shelf packing, tallest first. Scaled down as a whole when the pictures do
// not fit ATLAS_MAX_SIDE square.
function packAtlas(pictures: SymbolPicture[]): { canvas: HTMLCanvasElement; rects: AtlasRect[] } {
  const order = pictures.map((_, i) => i).sort((a, b) => pictures[b].image.height - pictures[a].image.height)
  let scale = 1
  for (;;) {
    const sizes = pictures.map((p) => ({ w: Math.max(1, Math.ceil(p.image.width * scale)), h: Math.max(1, Math.ceil(p.image.height * scale)) }))
    const area = sizes.reduce((sum, s) => sum + (s.w + 2 * ATLAS_PADDING) * (s.h + 2 * ATLAS_PADDING), 0)
    const widest = sizes.reduce((max, s) => Math.max(max, s.w + 2 * ATLAS_PADDING), 1)
    const width = Math.min(ATLAS_MAX_SIDE, Math.max(widest, 2 ** Math.ceil(Math.log2(Math.sqrt(area) * 1.15 + 1))))
    const rects: AtlasRect[] = new Array(pictures.length)
    let x = 0
    let y = 0
    let shelf = 0
    for (const i of order) {
      const { w, h } = sizes[i]
      if (x + w + 2 * ATLAS_PADDING > width) {
        x = 0
        y += shelf
        shelf = 0
      }
      rects[i] = { x: x + ATLAS_PADDING, y: y + ATLAS_PADDING, w, h }
      x += w + 2 * ATLAS_PADDING
      shelf = Math.max(shelf, h + 2 * ATLAS_PADDING)
    }
    const height = Math.max(1, y + shelf)
    if ((widest > ATLAS_MAX_SIDE || height > ATLAS_MAX_SIDE) && scale > 1 / 64) {
      scale *= Math.min(ATLAS_MAX_SIDE / widest, Math.sqrt(ATLAS_MAX_SIDE / height)) * 0.95
      continue
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const c = canvas.getContext('2d')!
    pictures.forEach((p, i) => c.drawImage(p.image, rects[i].x, rects[i].y, rects[i].w, rects[i].h))
    return { canvas, rects }
  }
}

interface Layer {
  pictures: SymbolPicture[]
  rects: AtlasRect[]
  atlasWidth: number
  atlasHeight: number
  atlas: DynamicTexture | null
  symbols: WorldSymbol[]
  // What the mesh holds: none, and it is hidden whatever it was given.
  vertexCount: number
  enabled: boolean
  mesh: Mesh
  material: StandardMaterial
  // The view's copies of the mesh (the flat map's wrap instances).
  copies: AbstractMesh[]
  handle: WorldSymbols
}

// `onMesh`: the view takes each layer's mesh as it is made — parents it,
// puts it in its rendering group, makes its copies — and answers the copies,
// which are shown and hidden with it.
export function createSymbolLayerSet(scene: Scene, name: string, placement: SymbolPlacement, onMesh: (mesh: Mesh) => AbstractMesh[]): SymbolLayerSet {
  const layers = new Map<string, Layer>()

  function applyEnabled(layer: Layer): void {
    const on = layer.enabled && layer.vertexCount > 0
    layer.mesh.setEnabled(on)
    for (const copy of layer.copies) copy.setEnabled(on)
  }

  function build(layer: Layer): void {
    const vertexCount = layer.symbols.reduce((sum, s) => {
      const picture = layer.pictures[s.picture]
      if (!picture) return sum
      const n = placement.segments(picture)
      return sum + (n + 1) * (n + 1)
    }, 0)
    layer.vertexCount = layer.atlas ? vertexCount : 0
    if (layer.vertexCount === 0) {
      applyEnabled(layer)
      return
    }
    const positions = new Float32Array(vertexCount * 3)
    const uvs = new Float32Array(vertexCount * 2)
    const colors = new Float32Array(vertexCount * 4)
    const indices: number[] = []
    let vertex = 0
    for (const symbol of layer.symbols) {
      const picture = layer.pictures[symbol.picture]
      if (!picture) continue
      const rect = layer.rects[symbol.picture]
      const frame = placement.frame(symbol)
      const n = placement.segments(picture)
      const alpha = symbol.alpha ?? 1
      const first = vertex
      for (let j = 0; j <= n; j++) {
        // j runs down the picture (its canvas rows), i across it.
        const fy = j / n
        for (let i = 0; i <= n; i++) {
          const fx = i / n
          placement.vertex(frame, (fx - 0.5) * picture.width, (0.5 - fy) * picture.height, positions, vertex * 3)
          // The texture is uploaded flipped (DynamicTexture.update(true)): the
          // canvas's top row lies at v = 1.
          uvs[vertex * 2] = (rect.x + fx * rect.w) / layer.atlasWidth
          uvs[vertex * 2 + 1] = 1 - (rect.y + fy * rect.h) / layer.atlasHeight
          colors[vertex * 4] = 1
          colors[vertex * 4 + 1] = 1
          colors[vertex * 4 + 2] = 1
          colors[vertex * 4 + 3] = alpha
          vertex++
        }
      }
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const a = first + j * (n + 1) + i
          const b = a + n + 1
          indices.push(a, b, a + 1, a + 1, b, b + 1)
        }
      }
    }
    const data = new VertexData()
    data.positions = positions
    data.uvs = uvs
    data.colors = colors
    data.indices = indices
    data.applyToMesh(layer.mesh, true)
    layer.mesh.refreshBoundingInfo()
    applyEnabled(layer)
  }

  function makeLayer(id: string): Layer {
    const mesh = new Mesh(`${name}_${id}`, scene)
    mesh.isPickable = false
    mesh.hasVertexAlpha = true
    // In the order the layers were asked for, among the scene's other
    // blended meshes: a later layer over an earlier one.
    mesh.alphaIndex = 1000 + layers.size
    const material = new StandardMaterial(`${name}_${id}_material`, scene)
    material.specularColor = new Color3(0, 0, 0)
    material.emissiveColor = new Color3(1, 1, 1)
    material.disableLighting = true
    material.useAlphaFromDiffuseTexture = true
    material.backFaceCulling = false
    // The symbols of a layer overlap in their order; none hides another
    // through the depth buffer.
    material.disableDepthWrite = true
    mesh.material = material
    const layer: Layer = {
      pictures: [],
      rects: [],
      atlasWidth: 1,
      atlasHeight: 1,
      atlas: null,
      symbols: [],
      vertexCount: 0,
      enabled: false,
      mesh,
      material,
      copies: onMesh(mesh),
      handle: {
        setPictures(pictures) {
          layer.atlas?.dispose()
          layer.atlas = null
          layer.pictures = pictures
          if (pictures.length > 0) {
            const { canvas, rects } = packAtlas(pictures)
            const atlas = new DynamicTexture(`${name}_${id}_atlas`, canvas, scene, true, Texture.TRILINEAR_SAMPLINGMODE)
            atlas.hasAlpha = true
            atlas.wrapU = Texture.CLAMP_ADDRESSMODE
            atlas.wrapV = Texture.CLAMP_ADDRESSMODE
            atlas.update(true)
            layer.atlas = atlas
            layer.rects = rects
            layer.atlasWidth = canvas.width
            layer.atlasHeight = canvas.height
          }
          material.diffuseTexture = layer.atlas
          build(layer)
        },
        setSymbols(symbols) {
          layer.symbols = symbols
          build(layer)
        },
        setEnabled(enabled) {
          layer.enabled = enabled
          applyEnabled(layer)
        },
      },
    }
    applyEnabled(layer)
    return layer
  }

  return {
    symbols(id) {
      let layer = layers.get(id)
      if (!layer) {
        layer = makeLayer(id)
        layers.set(id, layer)
      }
      return layer.handle
    },
    relayout() {
      for (const layer of layers.values()) build(layer)
    },
    dispose() {
      for (const layer of layers.values()) {
        for (const copy of layer.copies) copy.dispose()
        layer.mesh.dispose()
        layer.material.dispose()
        layer.atlas?.dispose()
      }
      layers.clear()
    },
  }
}
