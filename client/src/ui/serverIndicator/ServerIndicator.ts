import { getServerStatus, peekServerStatus, refreshServerStatus } from '../../server/serverStatus'
import type { ServerState } from '../../server/serverStatus'
import { t } from '../../i18n/i18n'
import { needsSignIn, onSessionChange } from '../../server/session'
import { createSignInPanel } from '../signInPanel/SignInPanel'
import type { TKey } from '../../i18n/i18n'
import './serverIndicator.css'

// Where a world would go, shown on every screen.
//
// It reports two things that look like one and are not. The ICON says where a
// world would end up — nowhere, an unreachable server, this machine, a shared
// one. The BADGE says that a sign-in is missing. Those are orthogonal: one can
// be signed out of a local server or a shared one, so folding "signed out" in
// as a fifth icon would multiplex two independent facts and lose the first.
// Same reasoning, and the same visual grammar, as the save button's badge.
//
// It USED to be a status readout that never opened anything, on the grounds
// that the place to act on the server is the save/load affordance next to it.
// That stopped being true on 2026-08-09: when the indicator is the way back IN,
// it is a control, and clicking it opens the sign-in. It still explains rather
// than demands — nothing is shown at startup and nothing covers the map, because
// everything local works with no server and no session at all.
//
// Deliberately not on the title screen only: the state matters at the moment
// of saving, an hour into a session, not at launch.

const ICONS: Record<ServerState, string> = {
  // "No server" honestly means the browser is the only home a world has, and
  // the browser may evict its own storage — so a negative mark is not alarmism
  // here, it is the least durable state there is.
  none: '/icons/no.png',
  unreachable: '/icons/warning.png',
  local: '/icons/computer.png',
  remote: '/icons/network.png',
}

// Shown while a transfer is in flight, in the SAME slot rather than as a second
// spinner elsewhere: a 30 MB upload is exactly the moment this corner of the
// screen is what the eye is on.
const BUSY_ICON = '/icons/server_load.png'

// The badge for "a sign-in is missing".
//
// The same glyph the `none` state uses as its main icon, and that is deliberate
// rather than a shortage: it means "not available" in both places, and the SLOT
// says what it is about — as an icon, no server at all; as a badge, there is one
// but not for you. The one nonsensical pairing cannot occur, since no server
// means nothing to sign in to and therefore no badge.
const SIGN_IN_BADGE = '/icons/no.png'

// The hover card's key PREFIX — HelpTooltip appends .label/.help itself, so the
// state's visible name comes from the same catalog entry as its explanation.
//
// Typed as "any prefix the catalog actually has a .label for", derived from
// TKey rather than written as `string`. That keeps tsc as the gate: a mistyped
// prefix is a compile error instead of an empty card at runtime, and the same
// check is what a templated key (which would need a cast) throws away.
// The indirection is load-bearing: a conditional type distributes over a union
// only through a naked type PARAMETER, so `TKey extends ...` written inline
// tests the whole union at once and collapses to never.
type PrefixOf<Key> = Key extends `${infer Prefix}.label` ? Prefix : never
type HelpPrefix = PrefixOf<TKey>

const HELP: Record<ServerState, HelpPrefix> = {
  none: 'common.server.none',
  unreachable: 'common.server.unreachable',
  local: 'common.server.local',
  remote: 'common.server.remote',
}

export interface ServerIndicator {
  element: HTMLElement
  // Marks a transfer as running. Returns the function that ends it, so a
  // caller cannot forget which state to restore.
  beginTransfer(): () => void
  // Re-probes and repaints — for after a request failed against a server that
  // was believed to be up.
  refresh(): Promise<void>
  // Releases the session subscription and the sign-in window.
  dispose(): void
}

export function createServerIndicator(host: HTMLElement): ServerIndicator {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = 'server-indicator'
  const image = document.createElement('img')
  image.alt = ''
  const badge = document.createElement('img')
  badge.alt = ''
  badge.className = 'server-indicator__badge'
  badge.src = SIGN_IN_BADGE
  badge.hidden = true
  element.append(image, badge)

  // Built here rather than in each screen: three screens show this indicator,
  // and a window they would each have to construct is a window three of them
  // could construct differently.
  const panel = createSignInPanel(host, () => void refresh())

  let state: ServerState | undefined
  let transfers = 0
  let signInMissing = false

  const paint = (): void => {
    // Exactly ONE of the two, never both: HelpTooltip is documented as
    // replacing the native title, but nothing strips it — set together they
    // would show two tooltips over one icon. The transient transfer state gets
    // the native one (it needs no explanatory card and would out-live the
    // transfer if it did).
    if (transfers > 0) {
      image.src = BUSY_ICON
      element.title = t('common.server.busy.label')
      element.removeAttribute('data-help')
      return
    }
    if (state === undefined) {
      // Hidden until the first probe resolves — showing "no server" for a
      // moment and then flipping to "local" would read as a connection drop
      // that never happened.
      element.hidden = true
      return
    }
    element.hidden = false
    image.src = ICONS[state]
    element.removeAttribute('title')
    badge.hidden = !signInMissing
    // Only a missing sign-in makes this clickable. Under `none`, or with no
    // server at all, there is nothing to open — and a window explaining that
    // you cannot sign in here would be worse than an indicator that stays
    // quiet.
    element.disabled = !signInMissing
    // The hover card explains the consequence, which is the part that is not
    // obvious from an icon: where worlds end up, and what happens on save. When
    // a sign-in is missing that IS the consequence, so the card says so instead.
    element.setAttribute('data-help', signInMissing ? 'common.server.loggedOut' : HELP[state])
  }

  // Asked rather than derived from `state`, because the answer needs the config
  // (is there anywhere to sign in) and the session (do we hold one), and only
  // one of those changes when the server state does.
  const refresh = async (): Promise<void> => {
    signInMissing = await needsSignIn()
    paint()
  }

  const adopt = (next: ServerState): void => {
    state = next
    paint()
  }

  element.addEventListener('click', () => {
    if (signInMissing) panel.open()
  })
  // A session can end without anyone clicking anything: a token expires, or a
  // request comes back 401. The badge follows that rather than waiting for the
  // next probe.
  const stopListening = onSessionChange(() => void refresh())

  paint()
  const known = peekServerStatus()
  if (known) adopt(known.state)
  else void getServerStatus().then((status) => adopt(status.state))
  void refresh()

  return {
    element,
    beginTransfer(): () => void {
      transfers += 1
      paint()
      let ended = false
      return () => {
        // Guarded because a caller that ends the same transfer twice would
        // otherwise leave the counter negative and the icon stuck.
        if (ended) return
        ended = true
        transfers -= 1
        paint()
      }
    },
    async refresh(): Promise<void> {
      const status = await refreshServerStatus()
      signInMissing = await needsSignIn()
      adopt(status.state)
    },
    dispose(): void {
      stopListening()
      panel.dispose()
    },
  }
}
