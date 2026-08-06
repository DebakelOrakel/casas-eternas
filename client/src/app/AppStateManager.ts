import type { Engine } from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory, ScreenId } from './Screen'

export class AppStateManager {
  private current: Screen | null = null
  private readonly engine: Engine
  private readonly canvas: HTMLCanvasElement
  private readonly overlay: HTMLElement
  private readonly factories: Record<ScreenId, ScreenFactory>

  constructor(
    engine: Engine,
    canvas: HTMLCanvasElement,
    overlay: HTMLElement,
    factories: Record<ScreenId, ScreenFactory>,
  ) {
    this.engine = engine
    this.canvas = canvas
    this.overlay = overlay
    this.factories = factories
  }

  goTo(id: ScreenId): void {
    this.current?.dispose()
    this.overlay.replaceChildren()

    const ctx: ScreenContext = {
      engine: this.engine,
      canvas: this.canvas,
      overlay: this.overlay,
      goTo: (next) => this.goTo(next),
    }
    this.current = this.factories[id](ctx)
  }

  render(): void {
    this.current?.scene.render()
  }
}
