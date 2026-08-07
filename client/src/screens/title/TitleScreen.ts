import { ArcRotateCamera, Color4, Scene, Vector3 } from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { getLocale, setLocale, type Locale } from '../../i18n/i18n'
import { CHANGELOG_CATEGORIES } from '../../ui/changelog/categories'
import { renderChangelog } from '../../ui/changelog/renderChangelog'
import './title.css'

export const createTitleScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)
  new ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 2.5, 6, Vector3.Zero(), scene)

  const root = document.createElement('div')
  root.className = 'title-screen'
  root.innerHTML = `
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
    <section class="changelog">
      <h2 class="changelog-title">Changelog</h2>
      <div class="changelog-tabs" data-value="changelog-tabs"></div>
      <div class="changelog-body" data-value="changelog-body"></div>
    </section>
    <nav class="title-nav">
      <button class="text-link" data-action="worldgen">Hacedor del Mundo</button>
      <button class="text-link" data-action="worldmap">Herederos del Mundo</button>
      <div class="title-nav-row">
        <button class="text-link" data-action="worldgen-sphere">Sphere</button>
        <button class="text-link" data-action="mars">Mars</button>
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

  // Changelog: category cards act as tabs; clicking one renders that category's
  // changelog (parsed from its docs/changelog Markdown) into the body below.
  // English only — the title screen is deliberately not localized.
  const tabsHost = root.querySelector<HTMLElement>('[data-value="changelog-tabs"]')!
  const bodyHost = root.querySelector<HTMLElement>('[data-value="changelog-body"]')!
  const tabButtons: HTMLButtonElement[] = []
  const showCategory = (id: string): void => {
    const cat = CHANGELOG_CATEGORIES.find((c) => c.id === id)
    if (!cat) return
    for (const b of tabButtons) b.classList.toggle('is-active', b.dataset.cat === id)
    bodyHost.replaceChildren(renderChangelog(cat.md))
  }
  for (const cat of CHANGELOG_CATEGORIES) {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'changelog-tab'
    tab.dataset.cat = cat.id
    tab.textContent = cat.label
    tab.addEventListener('click', () => showCategory(cat.id))
    tabsHost.appendChild(tab)
    tabButtons.push(tab)
  }
  showCategory(CHANGELOG_CATEGORIES[0].id) // default to the first (Worldgen)

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

  ctx.overlay.appendChild(root)

  return {
    scene,
    dispose() {
      scene.dispose()
    },
  }
}
