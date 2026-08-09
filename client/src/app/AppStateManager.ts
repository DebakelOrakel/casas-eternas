import type { Engine } from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory, ScreenId } from './Screen'
import { NotificationManager } from '../ui/notifications/NotificationManager'
import { onSessionLost } from '../server/session'
import { t } from '../i18n/i18n'

export class AppStateManager {
  private current: Screen | null = null
  private readonly engine: Engine
  private readonly canvas: HTMLCanvasElement
  private readonly overlay: HTMLElement
  private readonly factories: Record<ScreenId, ScreenFactory>
  private readonly notifications: NotificationManager

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
    this.notifications = new NotificationManager(overlay)
    // Said once, here, rather than by whichever request happened to discover it.
    //
    // A session dies quietly: the token expires, or the server comes back with a
    // fresh signing key, and the next call fails by returning nothing. Every
    // caller then reports its own symptom — a save that failed, a list that came
    // back empty — and none of them names the cause. The indicator's badge
    // appears at the same moment; this is what makes someone look at it.
    onSessionLost(() => {
      this.notifications.show({ message: t('common.notify.signedOut'), icon: '/icons/no.png', durationMs: 10000 })
    })
  }

  goTo(id: ScreenId): void {
    this.current?.dispose()
    this.notifications.clearAll()
    this.overlay.replaceChildren()
    this.notifications.ensureContainer(this.overlay)

    const ctx: ScreenContext = {
      engine: this.engine,
      canvas: this.canvas,
      overlay: this.overlay,
      notifications: this.notifications,
      goTo: (next) => this.goTo(next),
    }
    this.current = this.factories[id](ctx)
  }

  render(): void {
    this.current?.scene.render()
  }
}
