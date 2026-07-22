import type { Engine, Scene } from '@babylonjs/core'

export type ScreenId = 'title' | 'worldgen' | 'worldgen-sphere' | 'game' | 'mars'

export interface ScreenContext {
  engine: Engine
  canvas: HTMLCanvasElement
  overlay: HTMLElement
  goTo: (id: ScreenId) => void
}

export interface Screen {
  scene: Scene
  dispose: () => void
}

export type ScreenFactory = (ctx: ScreenContext) => Screen
