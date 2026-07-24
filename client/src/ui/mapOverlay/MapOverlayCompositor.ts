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
//     labels, and the like.
// Plus transient MARKERS attached to a layer: short-lived drawings that fade
// out over their own wall-clock lifetime (a re-composite loop runs while any
// are alive, even while the sim is paused, since it's wall-clock). Markers of
// a disabled layer are hidden but still age out.
//
// Toggling a layer just re-runs composite() from the retained base — no
// re-render round-trip — so it's instant.

export interface OverlayLayer {
  id: string
  // Shown on the layer's toggle chip (see OverlayToggleBar).
  label: string
  enabled: boolean
  // Skip this layer in the toggle bar — it's still composited, but a screen
  // controls it elsewhere (e.g. the temperature layer, toggled from the
  // climate panel), so it shouldn't also appear as a chip.
  hidden?: boolean
  // Full-raster overlay: mutate the base image bytes before they're drawn.
  paintPixels?: (data: Uint8ClampedArray) => void
  // Vector overlay: draw on top of the base after it's drawn.
  paint?: (ctx: CanvasRenderingContext2D) => void
}

export interface OverlayMarkerSpec {
  lifetimeMs: number
  // Draws the marker; `alpha` runs 1→0 over its lifetime for a fade.
  paint: (ctx: CanvasRenderingContext2D, alpha: number) => void
}

interface ActiveMarker extends OverlayMarkerSpec {
  layerId: string
  birth: number
}

// ~15fps is plenty for a multi-second fade and keeps the full-canvas readback
// + texture upload each marker frame off the 60fps path.
const MARKER_FRAME_INTERVAL_MS = 66

export class MapOverlayCompositor {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly width: number
  private readonly height: number
  private readonly onComposite: (pixels: Uint8Array) => void
  private base: Uint8ClampedArray | null = null
  private layers: OverlayLayer[] = []
  private markers: ActiveMarker[] = []
  private raf: number | null = null

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

  // The base color raster (RGBA, width*height). Retained so toggles and marker
  // frames can re-composite without a fresh render.
  setBase(rgba: Uint8ClampedArray): void {
    this.base = rgba
  }

  addMarker(layerId: string, spec: OverlayMarkerSpec): void {
    this.markers.push({ layerId, lifetimeMs: spec.lifetimeMs, paint: spec.paint, birth: Date.now() })
    this.ensureAnimation()
  }

  clearMarkers(): void {
    this.markers = []
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf)
      this.raf = null
    }
  }

  composite(): void {
    if (!this.base) return
    const image = new ImageData(new Uint8ClampedArray(this.base), this.width, this.height)
    for (const layer of this.layers) {
      if (layer.enabled && layer.paintPixels) layer.paintPixels(image.data)
    }
    this.ctx.putImageData(image, 0, 0)
    const now = Date.now()
    for (const layer of this.layers) {
      if (!layer.enabled) continue
      layer.paint?.(this.ctx)
      for (const marker of this.markers) {
        if (marker.layerId !== layer.id) continue
        const alpha = 1 - (now - marker.birth) / marker.lifetimeMs
        if (alpha > 0) marker.paint(this.ctx, alpha)
      }
    }
    this.onComposite(new Uint8Array(this.ctx.getImageData(0, 0, this.width, this.height).data.buffer))
  }

  // Re-composites (~15fps) while any marker is alive, pruning expired ones, and
  // stops once none remain. Wall-clock, so markers keep fading even when the
  // rest of the screen is idle/paused.
  private ensureAnimation(): void {
    if (this.raf !== null) return
    let lastFrame = 0
    const tick = (timestamp: number): void => {
      if (timestamp - lastFrame >= MARKER_FRAME_INTERVAL_MS) {
        lastFrame = timestamp
        const now = Date.now()
        this.markers = this.markers.filter((m) => now - m.birth < m.lifetimeMs)
        this.composite()
        if (this.markers.length === 0) {
          this.raf = null
          return
        }
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  dispose(): void {
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf)
      this.raf = null
    }
  }
}
