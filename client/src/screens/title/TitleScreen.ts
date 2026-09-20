import { ArcRotateCamera, Color4, Scene, Vector3 } from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { t } from '../../i18n/i18n'
import { createServerIndicator } from '../../ui/serverIndicator/ServerIndicator'
import { createHelpTooltip } from '../../ui/help/HelpTooltip'
import { createTitleBar } from '../../ui/titleBar/TitleBar'
import '../../ui/theme/design.css'
import './title.css'

// The changelog no longer renders here — the artwork owns the screen, and the
// documentation (changelog included) lives on the docs site the nav links to
// (/docs/, served by the docs module). The in-client viewer was parked for a
// year and removed 2026-09-20; its parser lives on beside the site that uses
// it (scripts/parseChangelog.ts).

export const createTitleScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)
  new ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 2.5, 6, Vector3.Zero(), scene)

  const root = document.createElement('div')
  // `design-light` is how a screen opts into the redesign's palette (see
  // ui/theme/design.css); here it is the background the artwork stands on.
  root.className = 'title-screen design-light'
  root.innerHTML = `
    <span data-slot="server-indicator"></span>
    <!-- <div class="title-block">
      <h1>Casas Eternas</h1>
      <p class="subtitle">Herederos del Mundo</p>
    </div> -->
    <nav class="title-nav">
      <button class="text-link" data-action="generator">${t('common.title.nav.generator')}</button>
      <a class="text-link" href="/docs/" target="_blank" rel="noopener">${t('common.title.nav.documentation')}</a>
    </nav>
  `
  root.querySelector('[data-action="generator"]')!.addEventListener('click', () => {
    ctx.goTo('generator')
  })

  // Where a world would go, on every screen — including this one, so the state
  // is visible before any work is started, not only when saving.
  const serverIndicator = createServerIndicator(root)
  root.querySelector('[data-slot="server-indicator"]')!.replaceWith(serverIndicator.element)

  // The same strip the generator and the map wear (ui/titleBar). It carries the
  // language switch, which is why the flag buttons that used to sit top-right
  // are gone: two controls for one choice, on one screen, is one too many.
  //
  // Rebuilding on a language change is what this screen already did, and it can
  // still afford to — there is nothing here to lose.
  const titleBar = createTitleBar(root, {
    onSignIn: () => serverIndicator.openSignIn(),
    onLocaleChange: () => ctx.goTo('title'),
  })
  titleBar.setWorld(null)

  ctx.overlay.appendChild(root)

  // The title screen had no help tooltip, so any `data-help` on it was inert —
  // which is why the server indicator showed nothing here while working on the
  // other two screens.
  const helpTooltip = createHelpTooltip(root)

  return {
    scene,
    dispose() {
      titleBar.dispose()
      helpTooltip.dispose()
      serverIndicator.dispose()
      scene.dispose()
    },
  }
}
