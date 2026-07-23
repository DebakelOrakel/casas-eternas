import type { Engine, Scene } from '@babylonjs/core'
import type { NotificationManager } from '../ui/NotificationManager'

export type ScreenId = 'title' | 'worldgen' | 'worldgen-sphere' | 'game' | 'mars'

export interface ScreenContext {
  engine: Engine
  canvas: HTMLCanvasElement
  overlay: HTMLElement
  notifications: NotificationManager
  goTo: (id: ScreenId) => void
}

export interface Screen {
  scene: Scene
  dispose: () => void
}

export type ScreenFactory = (ctx: ScreenContext) => Screen
