import { getLocale, setLocale, t, type Locale, type TKey } from '../../i18n/i18n'
import { formatWhen } from '../format'
import { hasSession, onSessionChange, signedInUser, signOut } from '../../server/session'
import { getServerStatus } from '../../server/serverStatus'
import '../theme/design.css'
import './titleBar.css'

// The strip across the top of every map-bearing screen: what this thing is,
// which world is open and where it stands, and a menu. From the "Weltgenerator"
// design canvas (artboard Main.dc.html), light theme.
//
// THE MENU (2026-10-03, not in the canvas). The canvas puts the language
// switch and the sign-in into the bar as their own controls. With no server,
// or one in `authMode: none`, the sign-in is not there, and the screens' own
// doors (jobs, artifacts) stood in a row beside the save menu. Now one button
// at the right end opens a list: the screen's own entries, the language, and
// the account where the deployment has one. The button says "Menu", or the
// user's name once signed in — the same list in both cases, so a sign-in does
// not move anything but the account rows.
//
// A connected panel rather than a plain widget (see the ui/ taxonomy in
// CLAUDE.md): it reads `server/session` directly, the same way ServerIndicator
// does, because the account state is true of the process rather than of the
// screen and threading it through two screens would only make both repeat the
// same subscription.
//
// What it does NOT know is the world. A screen pushes that in, because "which
// world is meant" is world-layer knowledge and the bar is chrome.

export interface TitleBarWorld {
  // The world's own name, when it has one that is not simply the seed. The
  // generator writes `metadata.name = seed` today (GeneratorScreen's
  // buildWorldYaml), so a distinct name only exists for worlds that arrived
  // from elsewhere — hence optional rather than "" for the common case.
  name?: string
  seed: string
}

// Four states, not the design's three: "never saved" is the generator's usual
// opening state and would otherwise have to borrow the `unsaved` wording,
// which says a world changed since a save that never happened.
export type TitleBarSaveState =
  | { kind: 'new' }
  | { kind: 'unsaved' }
  | { kind: 'local'; at: Date }
  | { kind: 'server'; at: Date }

// The product's name, which is a NAME: it is the same word in every language,
// so it is a constant here and not a catalog key. A screen that stands for a
// part of the product rather than the product itself says so with `nameKey`.
const APP_NAME = 'Casas Eternas'

// A catalog base that has a `.label` key under it.
type LabelBase<K> = K extends `${infer B}.label` ? B : never

// One entry the screen puts into the menu. Read when the menu opens, so the
// screen does not have to tell the bar when an entry comes and goes.
export interface TitleBarMenuItem {
  // The catalog base: `.label` is the row's text, and the base itself is the
  // help card's key.
  key: LabelBase<TKey>
  // The path of a 24-grid stroke icon.
  icon: string
  onSelect(): void
  // Left out: always shown.
  visible?(): boolean
}

export interface TitleBarOptions {
  // Opens the screen's sign-in panel. The bar does not own one: both screens
  // already build a SignInPanel for the server indicator, and a second one
  // would put two sign-in windows on the same screen.
  onSignIn(): void
  // What the bar calls this screen, as a catalog key. Left out on a screen that
  // IS the product — the title screen, the world map — which then shows the
  // product's name. The generator names itself, because it is one workshop
  // inside it and the word is translated.
  nameKey?: TKey
  // Leaving this screen for the title screen. It hangs off the WORDMARK, which
  // is the one part of the bar that names where you are rather than what you
  // are working on: a click on it goes up, as it does on any masthead. The
  // world beside it is not a way out — it says which world is open, and a
  // screen that gives no handler here keeps the mark as plain text.
  onHomeClick?(): void
  // Called after the locale changed and the bar re-rendered itself. A screen
  // that can afford to rebuild says so here; one holding unsaved work (the
  // generator) leaves it out and stays in the old language until re-entered,
  // which is what the title screen's switch already does.
  onLocaleChange?(): void
  // The screen's own menu entries, above the language and the account.
  menuItems?: readonly TitleBarMenuItem[]
}

export interface TitleBar {
  element: HTMLElement
  // Where a screen hangs its own tools — the save menu today. The bar does not
  // own them: saving is the generator's business and the bar is chrome, so it
  // offers the place rather than the buttons. Doors used less often go into
  // the menu instead (`menuItems`).
  tools: HTMLElement
  setWorld(world: TitleBarWorld | null): void
  setSaveState(state: TitleBarSaveState): void
  dispose(): void
}

// The menu's icons, 24-grid stroke paths: three bars; a globe; a door with an
// arrow into it, and out of it; an arrow back.
const MENU_ICON = 'M4 6h16M4 12h16M4 18h16'
const LANGUAGE_ICON = 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9M12 3c-2.5 2.5-3.5 5.5-3.5 9s1 6.5 3.5 9'
const SIGN_IN_ICON = 'M14 4h5v16h-5M3 12h11M10 8l4 4-4 4'
const SIGN_OUT_ICON = 'M10 4H5v16h5M9 12h12M17 8l4 4-4 4'
const HOME_ICON = 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3'

// Up to two letters from the user name, for the account chip. Falls back to
// the first character of whatever came back, so a single-word or non-Latin
// name still gets a mark rather than an empty circle.
function initialsOf(user: string): string {
  const parts = user.trim().split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join('').toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function createTitleBar(host: HTMLElement, options: TitleBarOptions): TitleBar {
  host.classList.add('has-title-bar')

  const bar = document.createElement('header')
  bar.className = 'title-bar design-light'

  // The wordmark's globe is inline rather than an <img> so it takes the bar's
  // accent colour from the same token everything else here reads.
  // The mark is a <button> only where it leads somewhere — see onHomeClick. A
  // button that does nothing is worse than text: it takes a tab stop and
  // promises a move.
  const markTag = options.onHomeClick ? 'button' : 'div'
  // The visible word is the screen's name ("Generator"), which does not say
  // that clicking it leaves; the accessible name does.
  const markAttrs = options.onHomeClick
    ? ` type="button" data-help="titlebar.home" aria-label="${t('titlebar.home.label')}"`
    : ''
  bar.innerHTML = `
    <${markTag} class="title-bar__mark"${markAttrs}>
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--dc-accent)" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" />
        <path d="M3 10c4 1 6-2 9-1s4 4 9 2" />
        <path d="M5 17c3-1 5 1 8 0s4-3 7-2" />
      </svg>
      <span class="title-bar__name">${options.nameKey ? t(options.nameKey) : APP_NAME}</span>
    </${markTag}>
    <div class="title-bar__divider" data-slot="world-divider"></div>
    <div class="title-bar__world" data-slot="world" data-help="titlebar.world">
      <span class="title-bar__world-name" data-slot="world-name"></span>
      <span class="title-bar__seed" data-slot="seed"></span>
      <span class="title-bar__status" data-slot="status"></span>
    </div>
    <div class="title-bar__spacer"></div>
    <div class="title-bar__actions">
      <span data-slot="tools"></span>
      <div class="title-menu" data-slot="menu">
        <button type="button" class="title-bar__tool title-menu__button" aria-haspopup="menu" aria-expanded="false" data-slot="menu-button"></button>
        <div class="title-menu__list" role="menu" data-slot="menu-list" hidden>
          <div class="title-menu__group" data-slot="menu-items"></div>
          <div class="title-menu__row">
            <span class="title-menu__mark">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="${LANGUAGE_ICON}" />
              </svg>
            </span>
            <span class="title-menu__label" data-slot="language-label"></span>
            <div class="title-bar__lang">
              <button type="button" data-lang="de" data-help="titlebar.language.de">DE</button>
              <button type="button" data-lang="en" data-help="titlebar.language.en">EN</button>
            </div>
          </div>
          <div class="title-menu__group title-menu__group--apart" data-slot="account"></div>
          <div class="title-menu__group title-menu__group--apart" data-slot="home"></div>
        </div>
      </div>
    </div>
  `

  const worldDivider = bar.querySelector<HTMLElement>('[data-slot="world-divider"]')!
  const worldGroup = bar.querySelector<HTMLElement>('[data-slot="world"]')!
  const worldName = bar.querySelector<HTMLElement>('[data-slot="world-name"]')!
  const seedText = bar.querySelector<HTMLElement>('[data-slot="seed"]')!
  const statusText = bar.querySelector<HTMLElement>('[data-slot="status"]')!
  const toolsSlot = bar.querySelector<HTMLElement>('[data-slot="tools"]')!
  const menuHost = bar.querySelector<HTMLElement>('[data-slot="menu"]')!
  const menuButton = bar.querySelector<HTMLButtonElement>('[data-slot="menu-button"]')!
  const menuList = bar.querySelector<HTMLElement>('[data-slot="menu-list"]')!
  const itemsSlot = bar.querySelector<HTMLElement>('[data-slot="menu-items"]')!
  const languageLabel = bar.querySelector<HTMLElement>('[data-slot="language-label"]')!
  const accountSlot = bar.querySelector<HTMLElement>('[data-slot="account"]')!
  const homeSlot = bar.querySelector<HTMLElement>('[data-slot="home"]')!

  // A row of the list: an icon, a label, and what a click does. The menu
  // closes first, so a row that opens a window does not leave the list over it.
  // `help` is a help card's key base; left out where the label says it all.
  function menuRow(icon: string, label: string, help: string | null, onSelect: () => void): HTMLButtonElement {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'title-menu__row title-menu__item'
    row.setAttribute('role', 'menuitem')
    if (help) row.dataset.help = help
    row.innerHTML = `
      <span class="title-menu__mark">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="${icon}" />
        </svg>
      </span>
      <span class="title-menu__label"></span>
    `
    row.querySelector<HTMLElement>('.title-menu__label')!.textContent = label
    row.addEventListener('click', () => {
      closeMenu()
      onSelect()
    })
    return row
  }

  // --- language -------------------------------------------------------------

  function paintLanguage(): void {
    const active = getLocale()
    languageLabel.textContent = t('titlebar.language.label')
    bar.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((button) => {
      const lang = button.dataset.lang as Locale
      button.setAttribute('aria-pressed', String(lang === active))
      // The visible "DE"/"EN" is an abbreviation, so the button carries the
      // language's own name as its accessible one — and the endonym, which is
      // what someone looking for their language recognises.
      button.setAttribute('aria-label', t(`titlebar.language.${lang}.label` as TKey))
    })
  }

  // The menu stays open across a switch: the list re-says itself in place,
  // which shows that the switch took. A screen that rebuilds itself on the
  // change (onLocaleChange) takes the menu with it anyway.
  bar.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((button) => {
    button.addEventListener('click', () => {
      const lang = button.dataset.lang as Locale
      if (getLocale() === lang) return
      setLocale(lang)
      render()
      options.onLocaleChange?.()
    })
  })

  // --- the menu -------------------------------------------------------------

  // Whether this deployment has anywhere to sign IN to (`session/needsSignIn`
  // minus the session half). Undefined until the first probe answers, which is
  // why the menu is painted twice: once on the answer we already have, once
  // when it lands.
  let canSignIn: boolean | undefined
  void getServerStatus().then((status) => {
    canSignIn = status.loginPath !== ''
    paintMenu()
  })

  // The button: "Menu", or who is signed in. The name is on the button rather
  // than inside the list because it is the one thing in the menu worth seeing
  // without opening it.
  function paintButton(): void {
    menuButton.replaceChildren()
    menuButton.dataset.help = hasSession() ? 'titlebar.account' : 'titlebar.menu'
    menuButton.classList.toggle('title-menu__button--account', hasSession())
    if (hasSession()) {
      const user = signedInUser()
      menuButton.setAttribute('aria-label', t('titlebar.account.label', { user }))
      const initials = document.createElement('span')
      initials.className = 'title-bar__initials'
      initials.setAttribute('aria-hidden', 'true')
      initials.textContent = initialsOf(user)
      const name = document.createElement('span')
      name.className = 'title-bar__tool-label'
      name.textContent = user
      menuButton.append(initials, name)
    } else {
      menuButton.removeAttribute('aria-label')
      menuButton.insertAdjacentHTML('beforeend', `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="${MENU_ICON}" />
        </svg>
      `)
      const label = document.createElement('span')
      label.className = 'title-bar__tool-label'
      label.textContent = t('titlebar.menu.label')
      menuButton.append(label)
    }
    menuButton.insertAdjacentHTML('beforeend', `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    `)
  }

  // The screen's entries, asked whether they show on every open, so an entry
  // that comes and goes with the screen's state needs no call into the bar.
  function paintItems(): void {
    itemsSlot.replaceChildren()
    for (const item of options.menuItems ?? []) {
      if (item.visible && !item.visible()) continue
      itemsSlot.appendChild(menuRow(item.icon, t(`${item.key}.label` as TKey), item.key, () => item.onSelect()))
    }
  }

  // The account rows. None where there is nothing to sign in to — no server
  // at all, or one in `authMode: none`, where a synthetic local identity owns
  // everything. Absent rather than greyed out: a disabled row invites a hunt
  // for the condition that would enable it, and there is none. Undefined (the
  // probe is still out) counts as "not yet", so the row cannot flash up and
  // vanish on a local server.
  function paintAccount(): void {
    accountSlot.replaceChildren()
    if (hasSession()) {
      accountSlot.appendChild(menuRow(SIGN_OUT_ICON, t('titlebar.signOut.label'), null, () => signOut()))
    } else if (canSignIn === true) {
      accountSlot.appendChild(menuRow(SIGN_IN_ICON, t('titlebar.signIn.label'), 'titlebar.signIn', () => options.onSignIn()))
    }
  }

  // The list's rows only while it is open: the screen's entries are asked
  // then, and not while the bar is being built — the screen that passes them
  // is itself still being built at that point, and its state with it.
  // The way up, last and on its own: the same move as the wordmark (see
  // onHomeClick), which is easy to miss as a control. Only where the screen
  // has somewhere to go up to.
  function paintHome(): void {
    homeSlot.replaceChildren()
    if (!options.onHomeClick) return
    const home = options.onHomeClick.bind(options)
    homeSlot.appendChild(menuRow(HOME_ICON, t('titlebar.home.label'), 'titlebar.home', () => home()))
  }

  function paintMenu(): void {
    paintButton()
    if (menuList.hidden) return
    paintItems()
    paintAccount()
    paintHome()
  }

  function closeMenu(): void {
    if (menuList.hidden) return
    menuList.hidden = true
    menuButton.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
  }

  function openMenu(): void {
    if (!menuList.hidden) return
    menuList.hidden = false
    paintMenu()
    menuButton.setAttribute('aria-expanded', 'true')
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
  }

  // Capture phase, so the menu closes before whatever was clicked underneath
  // it acts — the same reason as the save menu's.
  function onPointerDown(event: PointerEvent): void {
    if (!menuHost.contains(event.target as Node)) closeMenu()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    closeMenu()
    menuButton.focus()
  }

  menuButton.addEventListener('click', () => (menuList.hidden ? openMenu() : closeMenu()))

  // `signOut()` and a session lost to the server both land here, so the name
  // on the button never outlives the session it names.
  const stopWatchingSession = onSessionChange(() => paintMenu())

  // --- leaving the screen ---------------------------------------------------

  if (options.onHomeClick) {
    const home = options.onHomeClick.bind(options)
    bar.querySelector<HTMLElement>('.title-bar__mark')!.addEventListener('click', () => home())
  }

  // --- world and save state -------------------------------------------------

  let world: TitleBarWorld | null = null
  let saveState: TitleBarSaveState = { kind: 'new' }

  function paintWorld(): void {
    // No world: the whole group goes, divider included. A screen that never
    // has one (and a generator before its first seed) then shows a bar with
    // the wordmark alone rather than a lone "Seed" with nothing after it.
    const shown = world !== null
    worldGroup.hidden = !shown
    worldDivider.hidden = !shown
    if (!world) return

    // The name is shown only when it says something the seed does not — see
    // TitleBarWorld.name.
    worldName.textContent = world.name && world.name !== world.seed ? world.name : ''
    seedText.textContent = `${t('titlebar.seed')} ${world.seed}`
  }

  function paintStatus(): void {
    const when = saveState.kind === 'local' || saveState.kind === 'server'
      ? formatWhen(saveState.at)
      : ''
    statusText.dataset.state = saveState.kind
    statusText.textContent = t(`titlebar.status.${saveState.kind}.label` as TKey, { when })
    // The help card follows the state, the way the save button's does, so the
    // line is never a claim with no explanation behind it. It sits on the
    // status span rather than on the group, so the group keeps its own
    // `titlebar.world` card for the name and seed beside it — HelpTooltip
    // walks UP from what the pointer is over, so the nearer one wins.
    statusText.dataset.help = `titlebar.status.${saveState.kind}`
  }

  function render(): void {
    bar.querySelector('.title-bar__name')!.textContent = options.nameKey ? t(options.nameKey) : APP_NAME
    if (options.onHomeClick) {
      bar.querySelector('.title-bar__mark')!.setAttribute('aria-label', t('titlebar.home.label'))
    }
    paintLanguage()
    paintMenu()
    paintWorld()
    paintStatus()
  }

  render()
  host.appendChild(bar)

  return {
    element: bar,
    tools: toolsSlot,
    setWorld(next) {
      world = next
      paintWorld()
    },
    setSaveState(next) {
      saveState = next
      paintStatus()
    },
    dispose() {
      closeMenu()
      stopWatchingSession()
      bar.remove()
      host.classList.remove('has-title-bar')
    },
  }
}
