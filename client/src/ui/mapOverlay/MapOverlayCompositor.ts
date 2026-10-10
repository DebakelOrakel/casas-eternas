// Composites a base RGBA map raster with a stack of independently toggleable
// overlay layers onto one offscreen canvas, then hands the combined pixels to
// a sink (typically a map texture's update). Reusable across any screen that
// draws a full-surface map — the worldgen screen and the later game screen —
// like NotificationManager is for toasts, except it's instantiated per screen
// (each owns its own map texture) rather than app-wide.
//
// Two kinds of layer, applied in this order every composite:
//  1. pixel layers (`paintPixels`) mutate the base image bytes directly —
//     for full-raster overlays like a plate-boundary mask;
//  2. vector layers (`paint`) draw on the 2D context on top — for arrows,
//     lines, and the like.
// Symbols and names at points are not painted here: the world view places
// them as objects (map/worldView.ts, WorldSymbols), so they keep their shape
// on the globe. The transient event markers that faded out here went with
// them on 2026-10-10.
//
// Toggling a layer just re-runs composite() from the retained base — no
// re-render round-trip — so it's instant.

export interface OverlayLayer {
  id: string
  enabled: boolean
  // Full-raster overlay: mutate the base image bytes before they're drawn.
  paintPixels?: (data: Uint8ClampedArray) => void
  // Vector overlay: draw on top of the base after it's drawn.
  paint?: (ctx: CanvasRenderingContext2D) => void
}

export class MapOverlayCompositor {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly width: number
  private readonly height: number
  private readonly onComposite: (pixels: Uint8Array) => void
  private base: Uint8ClampedArray | null = null
  private layers: OverlayLayer[] = []

  constructor(width: number, height: number, onComposite: (pixels: Uint8Array) => void) {
    this.width = width
    this.height = height
    this.onComposite = onComposite
    this.canvas = document.createElement('canvas')
    this.canvas.width = width
    this.canvas.height = height
    this.ctx = this.canvas.getContext('2d')!
  }

  setLayers(layers: OverlayLayer[]): void {
    this.layers = layers
  }

  // Draw/toggle order — also the order the toggle bar lists them in.
  getLayers(): readonly OverlayLayer[] {
    return this.layers
  }

  isLayerEnabled(id: string): boolean {
    return this.layers.find((layer) => layer.id === id)?.enabled ?? false
  }

  setLayerEnabled(id: string, enabled: boolean): void {
    const layer = this.layers.find((l) => l.id === id)
    if (layer) layer.enabled = enabled
  }

  // The base color raster (RGBA, width*height). Retained so toggles can
  // re-composite without a fresh render.
  setBase(rgba: Uint8ClampedArray): void {
    this.base = rgba
  }

  composite(): void {
    if (!this.base) return
    const image = new ImageData(new Uint8ClampedArray(this.base), this.width, this.height)
    for (const layer of this.layers) {
      if (layer.enabled && layer.paintPixels) layer.paintPixels(image.data)
    }
    this.ctx.putImageData(image, 0, 0)
    for (const layer of this.layers) {
      if (layer.enabled) layer.paint?.(this.ctx)
    }
    this.onComposite(new Uint8Array(this.ctx.getImageData(0, 0, this.width, this.height).data.buffer))
  }
}
