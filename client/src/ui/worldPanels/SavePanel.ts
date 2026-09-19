import { getLocale, t } from '../../i18n/i18n'
import { listWorlds } from '../../server/worldClient'
import { canKeepWorldsInBrowser } from '../../world/browserWorlds'
import { createPanel } from '../panel/Panel'
import './worldPanels.css'

// Where this world should go.
//
// Deliberately NOT a list of server worlds to pick from: a world's `uid`
// already decides which entry it updates, so there is no target to choose and
// offering one would suggest a move that is not possible. What the window is
// for is the other half — showing what the server currently holds for THIS
// world before it is replaced.
//
// It reads the state from the server on every open rather than from the
// remembered revision alone, because the remembered value is what this browser
// last saw; the question being answered is what is there NOW.

// Three places a world can come to rest, and they are not interchangeable:
// the browser keeps it here but may clear it, the server keeps it anywhere you
// sign in, and a download hands it to you and lets go. Each says so in its own
// help text (titlebar.save.*).
export type SaveTarget = 'download' | 'server' | 'browser'

export interface SavePanelOptions {
  // The world being saved. Read on open rather than passed in once, since a
  // load or a regenerate replaces it while the panel exists. `uid` is empty
  // before the first save; `revision` is the LOCAL save counter.
  currentWorld(): { uid: string; seed: string; revision: number }
  onChoose(target: SaveTarget): void
}

export interface SavePanel {
  open(): void
  dispose(): void
}

export function createSavePanel(host: HTMLElement, options: SavePanelOptions): SavePanel {
  const panel = createPanel(host, { variant: 'save', title: t('common.panel.save.title') })

  const state = document.createElement('p')
  state.className = 'save-state'
  panel.body.appendChild(state)

  // What is about to be written, so "update on server" names its object: the
  // world's identity beside the server's answer above it.
  const identity = document.createElement('div')
  identity.className = 'save-identity'
  panel.body.appendChild(identity)

  // One shape for all three, so a target cannot quietly end up with a label but
  // no help card, or a help card naming the wrong key.
  const target = (name: SaveTarget, label: string): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'app-panel-button'
    button.textContent = label
    button.dataset.help = `titlebar.save.${name}`
    button.addEventListener('click', () => {
      panel.close()
      options.onChoose(name)
    })
    return button
  }

  const toServer = target('server', t('titlebar.save.server.label'))
  const toBrowser = target('browser', t('titlebar.save.browser.label'))
  const download = target('download', t('titlebar.save.download.label'))

  // Hidden, not disabled, where the browser cannot keep worlds at all: a
  // greyed-out target invites a hunt for the condition that would enable it,
  // and there is none — the browser either has OPFS or it does not.
  toBrowser.hidden = true
  void canKeepWorldsInBrowser().then((can) => { toBrowser.hidden = !can })

  panel.footer.append(download, toBrowser, toServer)

  async function refresh(): Promise<void> {
    const current = options.currentWorld()
    state.textContent = '…'
    // Disabled while unknown: a button whose label has not settled yet is a
    // button someone clicks before it means what it will mean.
    toServer.disabled = true

    const worlds = await listWorlds()
    const held = worlds?.find((world) => world.uid === current.uid)
    toServer.disabled = false

    if (held) {
      const when = new Date(held.updatedAt).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' })
      state.textContent = t('common.panel.save.onServer', { revision: held.revision, when })
      toServer.textContent = t('titlebar.save.server.update')
    } else {
      state.textContent = t('common.panel.save.notOnServer')
      toServer.textContent = t('titlebar.save.server.label')
    }

    // Hashes shortened for the eye, full value in the title. A world saved
    // before the fields existed simply shows fewer lines.
    identity.replaceChildren()
    const lines: [string, string, string?][] = [
      [t('common.world.seed'), current.seed, undefined],
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

  panel.onOpen(() => { void refresh() })

  return {
    open: () => panel.open(),
    dispose: () => panel.dispose(),
  }
}
