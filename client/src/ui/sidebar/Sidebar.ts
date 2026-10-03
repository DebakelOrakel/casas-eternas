import { t, type TKey } from '../../i18n/i18n'
import { BOOK_ICON } from '../handbook/HandbookPanel'
import '../../ui/theme/design.css'
import './sidebar.css'

// A screen's left column — from the design canvas (Main.dc.html, the
// `<aside>` between the title bar and the step bar), light theme. The
// generator and the incubator use it; each names its steps from its own
// catalog branch.
//
// It names the step you are on and says what that step does. Until the
// column came, the generator said neither: the panel title was one word, and what a step
// actually IS lived only in the tooltip on its chip.
//
// It takes real width rather than floating over the map. That is cheap here
// and worth it: `main.ts` keeps a ResizeObserver on the canvas that calls
// `engine.resize()`, and the camera derives its aspect from the render size
// every frame — so publishing a width is the whole of it, and nothing in the
// camera needs to learn about a sidebar.

export interface Sidebar {
  element: HTMLElement
  // Where a step puts its own controls. Empty for the steps that still keep
  // theirs in the panel row along the foot.
  body: HTMLElement
  // Where a step puts its figures and its buttons: below the part that
  // scrolls, directly above the step bar, so they stay in view however long
  // the step's controls are.
  foot: HTMLElement
  // Which step the column is describing. The id keys `<stepKeys>.<id>`,
  // the same base the step bar reads, so a step's name exists once.
  setStep(id: string): void
  // Say the step's name and description again, in the language that is active
  // now. The generator cannot be rebuilt on a language switch — see i18n/relabel.
  relabel(): void
  setVisible(visible: boolean): void
  dispose(): void
}

// The way from a step into its handbook page: a book beside the step's name,
// shown only for a step that has a page.
export interface SidebarHandbook {
  has(id: string): boolean
  open(id: string): void
}

// Published on the document element, not on the screen root: the canvas that
// has to give up the width is a SIBLING of the overlay the screen lives in, so
// a variable scoped to the screen would never reach it.
const WIDTH_VAR = '--sidebar-width'
const WIDTH = '300px'

// `stepKeys` is the catalog branch that holds the steps' names and
// descriptions, `generator.step` for the generator: step `<id>` reads
// `<stepKeys>.<id>.label` and `<stepKeys>.<id>.help`.
export function createSidebar(host: HTMLElement, stepKeys: string, handbook?: SidebarHandbook): Sidebar {
  const aside = document.createElement('aside')
  aside.className = 'gen-sidebar design-light'

  const heading = document.createElement('h1')
  heading.className = 'gen-sidebar__title'
  const book = document.createElement('button')
  book.type = 'button'
  book.className = 'gen-sidebar__book'
  book.dataset.help = 'titlebar.handbook'
  book.hidden = true
  book.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${BOOK_ICON}" /></svg>`
  book.addEventListener('click', () => handbook?.open(current))
  const titleRow = document.createElement('div')
  titleRow.className = 'gen-sidebar__title-row'
  titleRow.append(heading, book)
  const description = document.createElement('p')
  description.className = 'gen-sidebar__desc'
  const body = document.createElement('div')
  body.className = 'gen-sidebar__body'

  // Title, description and controls scroll; the foot does not. Two boxes
  // rather than a sticky foot inside one: a sticky element stops at the
  // scroll box's padding, not at its border, and leaves a strip under it.
  const scroll = document.createElement('div')
  scroll.className = 'gen-sidebar__scroll'
  scroll.append(titleRow, description, body)
  const foot = document.createElement('div')
  foot.className = 'gen-sidebar__foot'

  aside.append(scroll, foot)
  host.appendChild(aside)

  function publishWidth(width: string): void {
    document.documentElement.style.setProperty(WIDTH_VAR, width)
  }

  publishWidth(WIDTH)

  // Which step is being described, so the column can be said again in another
  // language without the screen having to remember on its behalf.
  let current = ''

  function paint(): void {
    if (!current) return
    heading.textContent = t(`${stepKeys}.${current}.label` as TKey)
    // The same string the step bar shows in its hover card. Shown here for
    // the step you are ON, where it is the answer to "what am I looking at";
    // the card stays for the steps you are not on, where it is the answer to
    // "what would this one be".
    description.textContent = t(`${stepKeys}.${current}.help` as TKey)
    book.hidden = !handbook?.has(current)
    book.setAttribute('aria-label', t('titlebar.handbook.label'))
  }

  return {
    element: aside,
    body,
    foot,
    setStep(id) {
      current = id
      paint()
    },
    relabel: paint,
    setVisible(visible) {
      aside.hidden = !visible
      // The map takes the width back while the column is away, rather than
      // leaving a strip of nothing beside the load screen.
      publishWidth(visible ? WIDTH : '0px')
    },
    dispose() {
      aside.remove()
      document.documentElement.style.removeProperty(WIDTH_VAR)
    },
  }
}
