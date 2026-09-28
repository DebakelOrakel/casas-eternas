import { t, type TKey } from '../../i18n/i18n'
import { formatWhen } from '../format'
import { needsSignIn } from '../../server/session'
import { getServerStatus } from '../../server/serverStatus'
import { listWorlds } from '../../server/worldClient'
import { canKeepWorldsInBrowser } from '../../world/browserWorlds'
import './saveMenu.css'

// Where this world should come to rest — the design canvas's save menu
// (Main.dc.html, artboard "Speichern-Menü"), hung in the title bar beside the
// language switch.
//
// A MENU, not a window: the three targets and "open a world" are four moves,
// each one line long, and a centred window for them made the screen stop while
// it asked. What the window did have and this keeps is the server's answer —
// read on every open, because the question is what is there NOW.
//
// Deliberately no list of server worlds to save INTO: a world's `uid` already
// decides which entry it updates, so there is no target to choose and offering
// one would suggest a move that is not possible.

// Three places a world can come to rest, and they are not interchangeable: the
// browser keeps it here but may clear it, the server keeps it anywhere you sign
// in, and a download hands it to you and lets go. Each says so in its own help
// card (titlebar.save.*).
export type SaveTarget = 'download' | 'server' | 'browser'

export interface SaveMenuOptions {
  // The world about to be written. Read on open rather than passed in once,
  // since a load or a regenerate replaces it while the menu exists. `uid` is
  // empty before the first save; `revision` is the LOCAL save counter.
  currentWorld(): { uid: string; revision: number }
  onSave(target: SaveTarget): void
  // "Open world …" — the screen decides what that means (the generator opens
  // its load window, or the file picker when no server is there).
  onOpenWorld(): void
  onSignIn(): void
}

export interface SaveMenu {
  element: HTMLElement
  // Shut while the generator computes: a snapshot taken mid-pass would hold a
  // world the simulation has already moved past, which is why the old save
  // button was disabled for the same window.
  setEnabled(on: boolean): void
  // Away entirely while the screen has no world to save — the generator hides
  // it behind its world list, where the question on screen is still WHICH
  // world. Distinct from setEnabled, which means "not just now".
  setVisible(on: boolean): void
  // Every string again, in the language that is active now. The generator
  // cannot rebuild itself on a language switch — see i18n/relabel.
  relabel(): void
  dispose(): void
}

// The four rows, in the design's order. `key` is both the catalog base and what
// the click does; the row's mark is the design's own 24-grid path.
type RowId = SaveTarget | 'open'

const ROWS: readonly { id: RowId; icon: string }[] = [
  { id: 'browser', icon: 'M3 5h18v12H3zM8 21h8M12 17v4' },
  { id: 'download', icon: 'M12 4v11M7 10l5 5 5-5M5 20h14' },
  { id: 'server', icon: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01' },
  { id: 'open', icon: 'M3 7h6l2 2h10v10H3z' },
]

export function createSaveMenu(options: SaveMenuOptions): SaveMenu {
  const host = document.createElement('div')
  host.className = 'save-menu'

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'save-menu__button'
  button.dataset.help = 'titlebar.save'
  button.setAttribute('aria-expanded', 'false')
  button.setAttribute('aria-haspopup', 'menu')
  button.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 3h11l3 3v15H5z" />
      <path d="M8 3v5h7V3M8 21v-7h8v7" />
    </svg>
    <span class="save-menu__button-label"></span>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  `
  const buttonLabel = button.querySelector<HTMLElement>('.save-menu__button-label')!

  const menu = document.createElement('div')
  menu.className = 'save-menu__list'
  menu.setAttribute('role', 'menu')
  menu.hidden = true

  const rows = new Map<RowId, { item: HTMLButtonElement; label: HTMLElement; sub: HTMLElement }>()
  for (const row of ROWS) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'save-menu__item'
    item.setAttribute('role', 'menuitem')
    item.dataset.help = row.id === 'open' ? 'titlebar.save.open' : `titlebar.save.${row.id}`
    item.innerHTML = `
      <span class="save-menu__mark">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="${row.icon}" />
        </svg>
      </span>
      <span class="save-menu__text">
        <span class="save-menu__label"></span>
        <span class="save-menu__sub"></span>
      </span>
    `
    item.addEventListener('click', () => {
      close()
      if (row.id === 'open') return options.onOpenWorld()
      // Signed out, the server row leads to the sign-in rather than being a
      // dead control: the condition that blocks it is one click away, and a
      // greyed-out row would leave you to find that out yourself. Asked of the
      // SERVER, not of the session: under `authMode: none` there is nothing to
      // sign in to and saving works as it stands.
      if (row.id === 'server' && signInMissing) return options.onSignIn()
      options.onSave(row.id)
    })
    rows.set(row.id, {
      item,
      label: item.querySelector<HTMLElement>('.save-menu__label')!,
      sub: item.querySelector<HTMLElement>('.save-menu__sub')!,
    })
    menu.appendChild(item)
  }

  // What is about to be written, so "update on the server" names its object.
  // The design does not draw this; it comes from the window this menu replaces,
  // where it was the only place a world's uid and checksum were ever shown.
  const identity = document.createElement('div')
  identity.className = 'save-menu__identity'
  menu.appendChild(identity)

  host.append(button, menu)

  // --- what the rows say ----------------------------------------------------

  // Whether a sign-in stands between this browser and the server. Held rather
  // than asked at click time, so the row's own words and what it does cannot
  // disagree; refreshed on every open, which is the only moment either is read.
  let signInMissing = false

  // Set before the server answers and again after it: the first pass is what
  // the menu shows while the request is in flight, and it must already be
  // readable.
  function paint(): void {
    buttonLabel.textContent = t('titlebar.save.label')
    for (const [id, row] of rows) {
      if (id === 'open') {
        row.label.textContent = t('titlebar.save.open.label')
        row.sub.textContent = t('titlebar.save.open.sub')
        continue
      }
      row.label.textContent = t(`titlebar.save.${id}.label` as TKey)
      row.sub.textContent = id === 'server'
        ? t(signInMissing ? 'titlebar.save.server.sub.out' : 'titlebar.save.server.sub.in')
        : t(`titlebar.save.${id}.sub` as TKey)
    }
  }

  async function refresh(): Promise<void> {
    signInMissing = await needsSignIn()
    paint()
    identity.replaceChildren()

    // Hidden, not disabled, where the browser cannot keep worlds at all: a
    // greyed-out target invites a hunt for the condition that would enable it,
    // and there is none — the browser either has OPFS or it does not.
    const browser = rows.get('browser')!
    browser.item.hidden = !(await canKeepWorldsInBrowser())

    const current = options.currentWorld()
    // No server at all: the row is not a target, and no sign-in would make it
    // one. Hidden for the same reason the browser row is where the browser
    // keeps nothing — it is a property of the deployment, not of the moment.
    // An unreachable server keeps its row: that IS a moment, and it passes.
    const server = rows.get('server')!
    server.item.hidden = (await getServerStatus()).state === 'none'

    const worlds = signInMissing ? null : await listWorlds()
    const held = worlds?.find((world) => world.uid === current.uid)
    if (held) {
      server.label.textContent = t('titlebar.save.server.update')
      server.sub.textContent = t('common.panel.save.onServer', {
        revision: held.revision,
        when: formatWhen(held.updatedAt),
      })
    } else if (worlds) {
      server.sub.textContent = t('common.panel.save.notOnServer')
    }

    // Hashes shortened for the eye, full value in the title. A world saved
    // before the fields existed simply shows fewer lines. No seed: the title
    // bar already shows it, next to the button that opens this menu.
    const lines: [string, string, string?][] = [
      [t('common.world.uid'), current.uid ? current.uid.slice(0, 8) : '', current.uid],
      [t('common.world.revision'), current.revision > 0 ? String(current.revision) : '', undefined],
      [t('common.world.checksum'), held?.contentHash ? held.contentHash.slice(0, 8) : '', held?.contentHash],
      [t('common.world.build'), held?.generator ?? '', undefined],
    ]
    for (const [label, value, full] of lines) {
      if (!value) continue
      const line = document.createElement('span')
      line.textContent = `${label} ${value}`
      if (full) line.title = full
      identity.appendChild(line)
    }
  }

  // --- opening and closing --------------------------------------------------

  function close(): void {
    if (menu.hidden) return
    menu.hidden = true
    button.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
  }

  function open(): void {
    if (!menu.hidden) return
    menu.hidden = false
    button.setAttribute('aria-expanded', 'true')
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    void refresh()
  }

  // Capture phase, so the menu closes before whatever was clicked underneath it
  // acts — otherwise a click on the map both closes this and turns the camera.
  function onPointerDown(event: PointerEvent): void {
    if (!host.contains(event.target as Node)) close()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    close()
    button.focus()
  }

  button.addEventListener('click', () => (menu.hidden ? open() : close()))

  paint()

  return {
    element: host,
    setEnabled(on) {
      button.disabled = !on
      if (!on) close()
    },
    setVisible(on) {
      host.hidden = !on
      if (!on) close()
    },
    relabel() {
      paint()
      // Whatever the server said is in the old language and holds a date
      // formatted in it; the next open asks again.
      if (!menu.hidden) void refresh()
    },
    dispose() {
      close()
      host.remove()
    },
  }
}
