import handbook from 'virtual:handbook'
import { getLocale, t } from '../../i18n/i18n'
import type { HandbookPage } from './handbookTypes'
import '../theme/design.css'
import './handbook.css'

// THE HANDBOOK PANEL — the "Weltgenerator" design canvas's Wiki (artboards
// Wiki and Hell-Wiki): a column on the right, between the title bar and the
// step bar, over the map. A search field, the pages, and the page itself.
//
// The pages are docs/handbook/, bundled at build time (`virtual:handbook`,
// client/scripts/handbook.ts). What the Markdown does not hold, the screen
// adds: the layers a step offers (`overlays`), which the step table already
// knows and a second copy in the handbook would let drift.
//
// A widget: it knows no world and no step table. The screen says which page
// is the current one and what a page's layers are.

export interface HandbookOverlay {
  icon: string
  label: string
  help: string
}

export interface HandbookPanelOptions {
  // The anchor of the page for what is on screen now — the panel opens on it
  // and marks it "here". Null where nothing on screen has a page.
  current(): string | null
  // The layers to list under a page, already in the active language. Empty
  // for a page that is not a step's.
  overlays?(anchor: string): HandbookOverlay[]
  // Called after the panel opened or closed, so the screen can make room or
  // press a button.
  onToggle?(open: boolean): void
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

// The pages of the active language. A page missing there is read from
// English, as a missing catalog key is.
function pagesNow(): HandbookPage[] {
  const own = handbook[getLocale()] ?? []
  const fallback = (handbook.en ?? []).filter((page) => !own.some((mine) => mine.anchor === page.anchor))
  return [...own, ...fallback].sort((a, b) => a.order - b.order)
}

function pageOf(anchor: string): HandbookPage | null {
  return pagesNow().find((page) => page.anchor === anchor || page.sections.some((section) => section.anchor === anchor)) ?? null
}

// The canvas's book.
export const BOOK_ICON = 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5zM8 7.5h7M8 11h5'

export function createHandbookPanel(host: HTMLElement, options: HandbookPanelOptions): HandbookPanel {
  const aside = document.createElement('aside')
  aside.className = 'handbook design-light'
  aside.hidden = true
  aside.innerHTML = `
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

  const name = aside.querySelector<HTMLElement>('[data-slot="name"]')!
  const closeButton = aside.querySelector<HTMLButtonElement>('[data-slot="close"]')!
  const search = aside.querySelector<HTMLInputElement>('[data-slot="search"]')!
  const nav = aside.querySelector<HTMLElement>('[data-slot="nav"]')!
  const pageBox = aside.querySelector<HTMLElement>('[data-slot="page"]')!

  // The page shown; null until the panel first opens.
  let shown: string | null = null

  // --- the list of pages -----------------------------------------------------

  // A page matches the query by its title, a heading in it, or its text.
  // Plain substring, no ranking: the handbook is a few pages a step.
  function matches(page: HandbookPage, query: string): boolean {
    if (!query) return true
    const text = (page.title + ' ' + page.sections.map((section) => section.title).join(' ') + ' ' + page.html.replace(/<[^>]+>/g, ' ')).toLowerCase()
    return text.includes(query)
  }

  function paintNav(): void {
    nav.replaceChildren()
    const query = search.value.trim().toLowerCase()
    const hits = pagesNow().filter((page) => matches(page, query))
    if (hits.length === 0) {
      const none = document.createElement('p')
      none.className = 'handbook__none'
      none.textContent = t('handbook.search.empty')
      nav.appendChild(none)
      return
    }
    const group = document.createElement('span')
    group.className = 'handbook__group'
    group.textContent = t('handbook.group.steps')
    nav.appendChild(group)
    const current = options.current()
    for (const page of hits) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'handbook__entry'
      if (page.anchor === shown) row.setAttribute('aria-current', 'page')
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
      nav.appendChild(row)
    }
  }

  // --- the page --------------------------------------------------------------

  // The rendered Markdown, with each h3 and what follows it up to the next
  // heading gathered into a card — the canvas draws a concept as a box with
  // its term over its definition, and the Markdown should not have to say so.
  function paintPage(page: HandbookPage): void {
    pageBox.replaceChildren()
    const title = document.createElement('h2')
    title.className = 'handbook__title'
    title.textContent = page.title
    const body = document.createElement('div')
    body.className = 'handbook__body'
    body.innerHTML = page.html
    for (const heading of [...body.querySelectorAll('h3')]) {
      const card = document.createElement('section')
      card.className = 'handbook__card'
      if (heading.id) {
        card.id = heading.id
        heading.removeAttribute('id')
      }
      heading.before(card)
      let next = heading.nextElementSibling
      card.appendChild(heading)
      while (next && !/^H[1-3]$/.test(next.tagName)) {
        const after = next.nextElementSibling
        card.appendChild(next)
        next = after
      }
    }
    pageBox.append(title, body)

    const layers = options.overlays?.(page.anchor) ?? []
    if (layers.length > 0) {
      const section = document.createElement('section')
      section.className = 'handbook__overlays'
      const heading = document.createElement('h2')
      heading.textContent = t('handbook.overlays')
      section.appendChild(heading)
      for (const layer of layers) {
        const row = document.createElement('div')
        row.className = 'handbook__overlay'
        const icon = document.createElement('img')
        icon.src = layer.icon
        icon.alt = ''
        const text = document.createElement('span')
        text.className = 'handbook__overlay-text'
        const label = document.createElement('span')
        label.className = 'handbook__overlay-label'
        label.textContent = layer.label
        const help = document.createElement('span')
        help.className = 'handbook__overlay-help'
        help.textContent = layer.help
        text.append(label, help)
        row.append(icon, text)
        section.appendChild(row)
      }
      pageBox.appendChild(section)
    }
  }

  // Shows the page holding `anchor` and, for a section, scrolls to it and
  // marks it for a moment.
  function show(anchor: string): void {
    const page = pageOf(anchor)
    if (!page) return
    shown = page.anchor
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

  function paintChrome(): void {
    name.textContent = t('titlebar.handbook.label')
    closeButton.setAttribute('aria-label', t('common.action.close.label'))
    aside.setAttribute('aria-label', t('titlebar.handbook.label'))
    search.placeholder = t('handbook.search.label')
    search.setAttribute('aria-label', t('handbook.search.label'))
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
    const target = anchor ?? (current && pageOf(current) ? current : null) ?? shown ?? pagesNow()[0]?.anchor
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
