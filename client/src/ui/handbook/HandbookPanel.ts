import handbook from 'virtual:handbook'
import { getLocale, t, type TKey } from '../../i18n/i18n'
import type { HandbookKind, HandbookPage } from './handbookTypes'
import '../theme/design.css'
import './handbook.css'

// THE HANDBOOK PANEL — the "Weltgenerator" design canvas's Wiki (artboards
// Wiki and Hell-Wiki): a column on the right, between the title bar and the
// step bar, over the map. A search field, the pages, and the page itself.
//
// Three kinds of page, one bookmark each on the column's left edge: the
// steps, the concepts the steps share, the map's layers. The pages are
// docs/handbook/, bundled at build time (`virtual:handbook`,
// client/scripts/handbook.ts). A step page holds its concepts as included
// cards, each leading to the concept's own page.
//
// What the Markdown does not hold, the screen adds: the layers. Their names
// and their one sentence are the overlay catalog's (`overlay.<id>.label` and
// `.help`, the same words as the layer's hover card), so a layer's page is
// built here from them, with whatever docs/handbook/<locale>/overlays/ adds
// below; and which layers a step offers is the step table's. A second copy
// of either in the handbook would drift.
//
// A widget: it knows no world and no step table. The screen says which page
// is the current one and what the layers are.

export interface HandbookOverlay {
  // The layer's catalog base, `overlay.<id>`: its page's anchor.
  anchor: string
  icon: string
  label: string
  help: string
}

export interface HandbookPanelOptions {
  // The anchor of the page for what is on screen now — the panel opens on it
  // and marks it "here". Null where nothing on screen has a page.
  current(): string | null
  // Every layer, already in the active language.
  overlays?(): HandbookOverlay[]
  // The anchors of the layers a step page lists, in the step's order.
  stepOverlays?(anchor: string): string[]
  // Called after the panel opened or closed.
  onToggle?(open: boolean): void
  // Whether the doc site is there to link into (/docs/, the server's docs
  // module): a concept's background documents are listed only then.
  docsAvailable?(): boolean
}

export interface HandbookPanel {
  element: HTMLElement
  // Opens on `anchor` — a page's, or a section's inside one — or on the
  // current page.
  open(anchor?: string): void
  close(): void
  isOpen(): boolean
  // Whether the handbook has a page or a section for this anchor.
  has(anchor: string): boolean
  // Every string again, in the language that is active now.
  relabel(): void
  dispose(): void
}

// A page as the panel shows it: a layer's page also carries its icon.
type Page = HandbookPage & { icon?: string }

const KINDS: readonly HandbookKind[] = ['step', 'concept', 'overlay']
const GROUP_KEY: Record<HandbookKind, string> = { step: 'handbook.group.steps', concept: 'handbook.group.concepts', overlay: 'handbook.group.overlays' }

// The canvas's book.
export const BOOK_ICON = 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5zM8 7.5h7M8 11h5'

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function createHandbookPanel(host: HTMLElement, options: HandbookPanelOptions): HandbookPanel {
  // --- the pages -------------------------------------------------------------

  // The pages of the active language. A page missing there is read from
  // English, as a missing catalog key is. The layers' pages are made from
  // the catalog, each with the Markdown page of the same anchor below it
  // where there is one.
  function pagesNow(): Page[] {
    const own = handbook[getLocale()] ?? []
    const written = [...own, ...(handbook.en ?? []).filter((page) => !own.some((mine) => mine.anchor === page.anchor))]
    const layers: Page[] = (options.overlays?.() ?? []).map((layer) => {
      const more = written.find((page) => page.anchor === layer.anchor)
      return {
        kind: 'overlay',
        anchor: layer.anchor,
        title: layer.label,
        order: 99,
        html: `<p>${escapeHtml(layer.help)}</p>${more?.html ?? ''}`,
        sections: more?.sections ?? [],
        icon: layer.icon,
      }
    })
    return [...written.filter((page) => page.kind !== 'overlay'), ...layers]
  }

  // Steps in their order; concepts and layers by name, which is how one
  // looks for them.
  function pagesOf(kind: HandbookKind, pages: Page[]): Page[] {
    const own = pages.filter((page) => page.kind === kind)
    return kind === 'step' ? own.sort((a, b) => a.order - b.order) : own.sort((a, b) => a.title.localeCompare(b.title, getLocale()))
  }

  function pageOf(anchor: string): Page | null {
    return pagesNow().find((page) => page.anchor === anchor || page.sections.some((section) => section.anchor === anchor)) ?? null
  }

  // --- the frame -------------------------------------------------------------

  const aside = document.createElement('aside')
  aside.className = 'handbook design-light'
  aside.hidden = true
  aside.innerHTML = `
    <div class="handbook__tabs" role="tablist" data-slot="tabs"></div>
    <div class="handbook__head">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${BOOK_ICON}" /></svg>
      <span class="handbook__name" data-slot="name"></span>
      <button type="button" class="handbook__close" data-slot="close">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
    <div class="handbook__search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" /></svg>
      <input type="search" data-slot="search" />
    </div>
    <nav class="handbook__nav" data-slot="nav"></nav>
    <article class="handbook__page" data-slot="page"></article>
  `
  host.appendChild(aside)

  const tabs = aside.querySelector<HTMLElement>('[data-slot="tabs"]')!
  const name = aside.querySelector<HTMLElement>('[data-slot="name"]')!
  const closeButton = aside.querySelector<HTMLButtonElement>('[data-slot="close"]')!
  const search = aside.querySelector<HTMLInputElement>('[data-slot="search"]')!
  const nav = aside.querySelector<HTMLElement>('[data-slot="nav"]')!
  const pageBox = aside.querySelector<HTMLElement>('[data-slot="page"]')!

  // The page shown; null until the panel first opens. The bookmark chosen,
  // which follows the page shown.
  let shown: string | null = null
  let tab: HandbookKind = 'step'

  // --- the bookmarks ---------------------------------------------------------

  const tabButtons = new Map<HandbookKind, HTMLButtonElement>()
  for (const kind of KINDS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'handbook__tab'
    button.setAttribute('role', 'tab')
    button.addEventListener('click', () => {
      tab = kind
      search.value = ''
      paintNav()
    })
    tabButtons.set(kind, button)
    tabs.appendChild(button)
  }

  function paintTabs(): void {
    for (const [kind, button] of tabButtons) {
      button.textContent = t(`${GROUP_KEY[kind]}.short` as TKey)
      button.setAttribute('aria-label', t(GROUP_KEY[kind] as TKey))
      button.title = t(GROUP_KEY[kind] as TKey)
      button.setAttribute('aria-selected', String(kind === tab))
    }
  }

  // --- the list of pages -----------------------------------------------------

  // A page matches the query by its title, a heading in it, or its text.
  // Plain substring, no ranking: the handbook is a few dozen pages.
  function matches(page: Page, query: string): boolean {
    const text = (page.title + ' ' + page.sections.map((section) => section.title).join(' ') + ' ' + page.html.replace(/<[^>]+>/g, ' ')).toLowerCase()
    return text.includes(query)
  }

  function entry(page: Page, current: string | null): HTMLButtonElement {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'handbook__entry'
    if (page.anchor === shown) row.setAttribute('aria-current', 'page')
    if (page.icon) {
      const icon = document.createElement('img')
      icon.src = page.icon
      icon.alt = ''
      row.appendChild(icon)
    }
    const label = document.createElement('span')
    label.className = 'handbook__entry-label'
    label.textContent = page.title
    row.appendChild(label)
    if (page.anchor === current) {
      const here = document.createElement('span')
      here.className = 'handbook__here'
      here.textContent = t('handbook.here')
      row.appendChild(here)
    }
    row.addEventListener('click', () => show(page.anchor))
    return row
  }

  // Without a query, the chosen bookmark's pages. With one, the hits of
  // every kind, under their kind's name: a search is for a word, not for a
  // bookmark.
  function paintNav(): void {
    paintTabs()
    nav.replaceChildren()
    const query = search.value.trim().toLowerCase()
    const pages = pagesNow()
    const current = options.current()
    const kinds = query ? KINDS : [tab]
    let hits = 0
    for (const kind of kinds) {
      const list = pagesOf(kind, pages).filter((page) => !query || matches(page, query))
      if (list.length === 0) continue
      hits += list.length
      const group = document.createElement('span')
      group.className = 'handbook__group'
      group.textContent = t(GROUP_KEY[kind] as TKey)
      nav.appendChild(group)
      for (const page of list) nav.appendChild(entry(page, current))
    }
    if (hits === 0) {
      const none = document.createElement('p')
      none.className = 'handbook__none'
      none.textContent = t('handbook.search.empty')
      nav.appendChild(none)
    }
  }

  // --- the page --------------------------------------------------------------

  // The rendered Markdown, with each h3 of the page's own and what follows
  // it up to the next heading gathered into a card — the canvas draws a
  // concept as a box with its term over its definition, and the Markdown
  // should not have to say so. Included concepts come as cards already.
  function paintPage(page: Page): void {
    pageBox.replaceChildren()
    const title = document.createElement('h2')
    title.className = 'handbook__title'
    if (page.icon) {
      const icon = document.createElement('img')
      icon.src = page.icon
      icon.alt = ''
      title.appendChild(icon)
    }
    title.append(page.title)
    const body = document.createElement('div')
    body.className = 'handbook__body'
    body.innerHTML = page.html
    for (const heading of [...body.querySelectorAll('h3')]) {
      if (heading.parentElement !== body) continue
      const card = document.createElement('section')
      card.className = 'handbook__card'
      if (heading.id) {
        card.id = heading.id
        heading.removeAttribute('id')
      }
      heading.before(card)
      let next = heading.nextElementSibling
      card.appendChild(heading)
      while (next && !/^H[1-3]$/.test(next.tagName) && !next.classList.contains('handbook__card')) {
        const after = next.nextElementSibling
        card.appendChild(next)
        next = after
      }
    }
    pageBox.append(title, body)

    // A step's layers, each the way to its own page.
    const anchors = page.kind === 'step' ? options.stepOverlays?.(page.anchor) ?? [] : []
    const layers = anchors.map((anchor) => (options.overlays?.() ?? []).find((layer) => layer.anchor === anchor)).filter((layer): layer is HandbookOverlay => !!layer)
    listSection('handbook.overlays', layers.map((layer) => ({ label: layer.label, help: layer.help, icon: layer.icon, page: layer.anchor })))
    if (page.kind !== 'concept') return
    // On a concept's own page, below what the steps include: the steps that
    // include it, and the documents behind it on the doc site.
    const steps = pagesOf('step', pagesNow()).filter((step) => step.uses?.includes(page.anchor))
    cardSection('handbook.usedIn', steps.map((step) => ({ title: step.title, page: step.anchor })))
    if (options.docsAvailable?.()) {
      cardSection('handbook.background', (page.background ?? []).map((doc) => ({ title: `${doc.id} · ${doc.title}`, text: doc.summary, href: `/docs/${doc.route}` })))
    }
  }

  // Cards under a heading, in the shape of an included concept (the build's
  // conceptIncludes): the title is the link, the text below it. A card leads
  // to a page of the handbook (`page`) or out to the doc site (`href`, in a
  // tab of its own). Nothing for no cards.
  function cardSection(headingKey: TKey, cards: { title: string; text?: string; page?: string; href?: string }[]): void {
    if (cards.length === 0) return
    const section = document.createElement('section')
    section.className = 'handbook__overlays'
    const heading = document.createElement('h2')
    heading.textContent = t(headingKey)
    section.appendChild(heading)
    for (const entry of cards) {
      const card = document.createElement('section')
      card.className = 'handbook__card handbook__card--concept'
      const title = document.createElement('h3')
      let link: HTMLElement
      if (entry.href) {
        const anchor = document.createElement('a')
        anchor.href = entry.href
        anchor.target = '_blank'
        anchor.rel = 'noopener'
        link = anchor
      } else {
        const button = document.createElement('button')
        button.type = 'button'
        if (entry.page) button.dataset.page = entry.page
        link = button
      }
      link.className = 'handbook__link'
      link.textContent = entry.title
      title.appendChild(link)
      card.appendChild(title)
      if (entry.text) {
        const text = document.createElement('p')
        text.textContent = entry.text
        card.appendChild(text)
      }
      section.appendChild(card)
    }
    pageBox.appendChild(section)
  }

  // A list under a heading, each row the way to a page of the handbook.
  // Nothing for no rows.
  function listSection(headingKey: TKey, rows: { label: string; help?: string; icon?: string; page: string }[]): void {
    if (rows.length === 0) return
    const section = document.createElement('section')
    section.className = 'handbook__overlays'
    const heading = document.createElement('h2')
    heading.textContent = t(headingKey)
    section.appendChild(heading)
    for (const entry of rows) {
      const row = document.createElement('button')
      row.type = 'button'
      row.dataset.page = entry.page
      row.className = 'handbook__overlay'
      if (entry.icon) {
        const icon = document.createElement('img')
        icon.src = entry.icon
        icon.alt = ''
        row.appendChild(icon)
      }
      const text = document.createElement('span')
      text.className = 'handbook__overlay-text'
      const label = document.createElement('span')
      label.className = 'handbook__overlay-label'
      label.textContent = entry.label
      text.appendChild(label)
      if (entry.help) {
        const help = document.createElement('span')
        help.className = 'handbook__overlay-help'
        help.textContent = entry.help
        text.appendChild(help)
      }
      row.appendChild(text)
      section.appendChild(row)
    }
    pageBox.appendChild(section)
  }

  // Shows the page holding `anchor` and, for a section, scrolls to it and
  // marks it for a moment. The bookmark follows the page.
  function show(anchor: string): void {
    const page = pageOf(anchor)
    if (!page) return
    shown = page.anchor
    tab = page.kind
    paintPage(page)
    paintNav()
    // The list scrolls in its own box; keep the page shown in view there.
    nav.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' })
    pageBox.scrollTop = 0
    if (anchor === page.anchor) return
    const target = [...pageBox.querySelectorAll<HTMLElement>('[id]')].find((element) => element.id === anchor)
    if (!target) return
    target.scrollIntoView({ block: 'start' })
    target.classList.add('handbook__card--marked')
    setTimeout(() => target.classList.remove('handbook__card--marked'), 1600)
  }

  // A concept's heading and a layer's row lead to their pages.
  pageBox.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement).closest<HTMLElement>('button[data-page]')
    if (link?.dataset.page) show(link.dataset.page)
  })

  function paintChrome(): void {
    name.textContent = t('titlebar.handbook.label')
    closeButton.setAttribute('aria-label', t('common.action.close.label'))
    aside.setAttribute('aria-label', t('titlebar.handbook.label'))
    search.placeholder = t('handbook.search.label')
    search.setAttribute('aria-label', t('handbook.search.label'))
    paintTabs()
  }

  // --- opening and closing ---------------------------------------------------

  function close(): void {
    if (aside.hidden) return
    aside.hidden = true
    document.removeEventListener('keydown', onKeyDown, true)
    options.onToggle?.(false)
  }

  function open(anchor?: string): void {
    // The current page where it has one; else the page last read; else the
    // first — never an empty page beside the list.
    const current = options.current()
    const target = anchor ?? (current && pageOf(current) ? current : null) ?? shown ?? pagesOf('step', pagesNow())[0]?.anchor
    if (aside.hidden) {
      aside.hidden = false
      document.addEventListener('keydown', onKeyDown, true)
      options.onToggle?.(true)
    }
    if (target) show(target)
    else paintNav()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    // A menu or a dialog over the panel closes first.
    if (document.querySelector('[role="menu"]:not([hidden]), dialog[open]')) return
    event.stopPropagation()
    close()
  }

  closeButton.addEventListener('click', () => close())
  search.addEventListener('input', () => paintNav())
  paintChrome()

  return {
    element: aside,
    open,
    close,
    isOpen: () => !aside.hidden,
    has: (anchor) => pageOf(anchor) !== null,
    relabel() {
      paintChrome()
      if (aside.hidden || !shown) return
      show(shown)
    },
    dispose() {
      close()
      aside.remove()
    },
  }
}
