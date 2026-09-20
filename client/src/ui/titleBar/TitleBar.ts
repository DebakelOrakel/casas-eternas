import { getLocale, setLocale, t, type Locale, type TKey } from '../../i18n/i18n'
import { formatWhen } from '../format'
import { hasSession, onSessionChange, signedInUser, signOut } from '../../server/session'
import { getServerStatus } from '../../server/serverStatus'
import '../theme/design.css'
import './titleBar.css'

// The strip across the top of every map-bearing screen: what this thing is,
// which world is open and where it stands, the language, and who is signed in.
// From the "Weltgenerator" design canvas (artboard Main.dc.html), light theme.
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
}

export interface TitleBar {
  element: HTMLElement
  // Where a screen hangs its own tools — the save menu today, the job list and
  // the theme switch the design draws beside it later. The bar does not own
  // them: saving is the generator's business and the bar is chrome, so it
  // offers the place rather than the buttons.
  tools: HTMLElement
  setWorld(world: TitleBarWorld | null): void
  setSaveState(state: TitleBarSaveState): void
  dispose(): void
}

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
      <div class="title-bar__lang">
        <button type="button" data-lang="de" data-help="titlebar.language.de">DE</button>
        <button type="button" data-lang="en" data-help="titlebar.language.en">EN</button>
      </div>
      <div class="title-bar__divider" data-slot="account-divider"></div>
      <span data-slot="account"></span>
    </div>
  `

  const worldDivider = bar.querySelector<HTMLElement>('[data-slot="world-divider"]')!
  const worldGroup = bar.querySelector<HTMLElement>('[data-slot="world"]')!
  const worldName = bar.querySelector<HTMLElement>('[data-slot="world-name"]')!
  const seedText = bar.querySelector<HTMLElement>('[data-slot="seed"]')!
  const statusText = bar.querySelector<HTMLElement>('[data-slot="status"]')!
  const accountSlot = bar.querySelector<HTMLElement>('[data-slot="account"]')!
  const toolsSlot = bar.querySelector<HTMLElement>('[data-slot="tools"]')!
  const accountDivider = bar.querySelector<HTMLElement>('[data-slot="account-divider"]')!

  // --- language -------------------------------------------------------------

  function paintLanguage(): void {
    const active = getLocale()
    bar.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((button) => {
      const lang = button.dataset.lang as Locale
      button.setAttribute('aria-pressed', String(lang === active))
      // The visible "DE"/"EN" is an abbreviation, so the button carries the
      // language's own name as its accessible one — and the endonym, which is
      // what someone looking for their language recognises.
      button.setAttribute('aria-label', t(`titlebar.language.${lang}.label` as TKey))
    })
  }

  bar.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((button) => {
    button.addEventListener('click', () => {
      const lang = button.dataset.lang as Locale
      if (getLocale() === lang) return
      setLocale(lang)
      render()
      options.onLocaleChange?.()
    })
  })

  // --- account --------------------------------------------------------------

  // Whether this deployment has anywhere to sign IN to (`session/needsSignIn`
  // minus the session half). Undefined until the first probe answers, which is
  // why the button is painted twice: once on the answer we already have, once
  // when it lands.
  let canSignIn: boolean | undefined
  void getServerStatus().then((status) => {
    canSignIn = status.loginPath !== ''
    paintAccount()
  })

  function paintAccount(): void {
    accountSlot.textContent = ''
    // Nothing to sign in to — no server at all, or one in `authMode: none`,
    // where a synthetic local identity owns everything. Hidden rather than
    // greyed out, for the reason the server indicator states beside it: a
    // disabled control invites a hunt for the condition that would enable it,
    // and there is none. It is a property of the deployment, not a moment.
    // Undefined (the probe is still out) counts as "not yet", so the button
    // cannot flash up and vanish on a local server.
    accountDivider.hidden = !hasSession() && canSignIn !== true
    // A divider with nothing after it is a line at the end of the bar.
    if (accountDivider.hidden) return
    if (hasSession()) {
      const user = signedInUser()
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'title-bar__account'
      chip.dataset.help = 'titlebar.account'
      chip.setAttribute('aria-label', t('titlebar.account.label', { user }))
      const initials = document.createElement('span')
      initials.className = 'title-bar__initials'
      initials.setAttribute('aria-hidden', 'true')
      initials.textContent = initialsOf(user)
      chip.append(initials, document.createTextNode(user))
      chip.addEventListener('click', () => signOut())
      accountSlot.appendChild(chip)
      return
    }
    const signIn = document.createElement('button')
    signIn.type = 'button'
    signIn.className = 'title-bar__sign-in'
    signIn.dataset.help = 'titlebar.signIn'
    signIn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
      </svg>
    `
    signIn.append(t('titlebar.signIn.label'))
    signIn.addEventListener('click', () => options.onSignIn())
    accountSlot.appendChild(signIn)
  }

  // `signOut()` and a session lost to the server both land here, so the chip
  // never outlives the session it names.
  const stopWatchingSession = onSessionChange(() => paintAccount())

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
    paintAccount()
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
      stopWatchingSession()
      bar.remove()
      host.classList.remove('has-title-bar')
    },
  }
}
