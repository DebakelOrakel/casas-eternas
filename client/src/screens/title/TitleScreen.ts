import { ArcRotateCamera, Color4, Scene, Vector3 } from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { getLocale, setLocale, type Locale } from '../../i18n/i18n'
import { createServerIndicator } from '../../ui/serverIndicator/ServerIndicator'
import { createHelpTooltip } from '../../ui/help/HelpTooltip'
import './title.css'

// The changelog no longer renders here — the artwork owns the screen. The
// viewer (ui/changelog/) stays intact: it returns as its own page, see
// docs/design/frontend-surfaces.md.

export const createTitleScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)
  new ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 2.5, 6, Vector3.Zero(), scene)

  const root = document.createElement('div')
  root.className = 'title-screen'
  root.innerHTML = `
    <span data-slot="server-indicator"></span>
    <div class="lang-actions">
      <button type="button" class="lang-button" data-lang="en" aria-label="English">
        <img src="/icons/lang_en.png" alt="" />
      </button>
      <button type="button" class="lang-button" data-lang="de" aria-label="Deutsch">
        <img src="/icons/lang_de.png" alt="" />
      </button>
    </div>
    <!-- <div class="title-block">
      <h1>Casas Eternas</h1>
      <p class="subtitle">Herederos del Mundo</p>
    </div> -->
    <nav class="title-nav">
      <button class="text-link" data-action="worldgen">Generator</button>
      <button class="text-link" data-action="worldmap">Map View</button>
      &nbsp;
      <button class="text-link" data-action="changelog">Changelog</button>
      &nbsp;
      <div class="title-nav-row">
        <button class="text-link" style="color:white;" data-action="worldgen-sphere">Sphere</button>
        <button class="text-link" style="color:white;" data-action="mars">Mars</button>
      </div>
    </nav>
  `
  root.querySelector('[data-action="worldgen"]')!.addEventListener('click', () => {
    ctx.goTo('worldgen')
  })
  root.querySelector('[data-action="worldmap"]')!.addEventListener('click', () => {
    ctx.goTo('worldmap')
  })
  root.querySelector('[data-action="worldgen-sphere"]')!.addEventListener('click', () => {
    ctx.goTo('worldgen-sphere')
  })
  root.querySelector('[data-action="mars"]')!.addEventListener('click', () => {
    ctx.goTo('mars')
  })

  // Language switch (title screen only): mark the active locale, and on a change
  // set it and rebuild the screen so every screen entered afterwards is localized.
  const activeLocale = getLocale()
  root.querySelectorAll<HTMLButtonElement>('.lang-button').forEach((btn) => {
    const lang = btn.dataset.lang as Locale
    if (lang === activeLocale) btn.classList.add('is-active')
    btn.addEventListener('click', () => {
      if (getLocale() === lang) return
      setLocale(lang)
      ctx.goTo('title')
    })
  })

  // Where a world would go, on every screen — including this one, so the state
  // is visible before any work is started, not only when saving.
  const serverIndicator = createServerIndicator(root)
  root.querySelector('[data-slot="server-indicator"]')!.replaceWith(serverIndicator.element)

  ctx.overlay.appendChild(root)

  // The title screen had no help tooltip, so any `data-help` on it was inert —
  // which is why the server indicator showed nothing here while working on the
  // other two screens.
  const helpTooltip = createHelpTooltip(root)

  return {
    scene,
    dispose() {
      helpTooltip.dispose()
      serverIndicator.dispose()
      scene.dispose()
    },
  }
}
