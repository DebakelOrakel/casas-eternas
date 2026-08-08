import { getServerStatus, peekServerStatus, refreshServerStatus } from '../../server/serverStatus'
import type { ServerState } from '../../server/serverStatus'
import { t } from '../../i18n/i18n'
import type { TKey } from '../../i18n/i18n'
import './serverIndicator.css'

// Where a world would go, shown on every screen.
//
// A status readout rather than a control: it never opens anything, because the
// place to ACT on the server is the save/load affordance next to it. It exists
// because that affordance changes shape depending on this state, and a shape
// change with no visible cause is confusing — the icon is the cause.
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
}

export function createServerIndicator(): ServerIndicator {
  const element = document.createElement('span')
  element.className = 'server-indicator'
  const image = document.createElement('img')
  image.alt = ''
  element.appendChild(image)

  let state: ServerState | undefined
  let transfers = 0

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
    // The hover card explains the consequence, which is the part that is not
    // obvious from an icon: where worlds end up, and what happens on save.
    element.setAttribute('data-help', HELP[state])
  }

  const adopt = (next: ServerState): void => {
    state = next
    paint()
  }

  paint()
  const known = peekServerStatus()
  if (known) adopt(known.state)
  else void getServerStatus().then((status) => adopt(status.state))

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
      adopt(status.state)
    },
  }
}
