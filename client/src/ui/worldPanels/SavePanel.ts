import { getLocale, t } from '../../i18n/i18n'
import { listWorlds } from '../../server/worldClient'
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

export type SaveTarget = 'download' | 'server'

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

  const toServer = document.createElement('button')
  toServer.type = 'button'
  toServer.className = 'app-panel-button'
  toServer.addEventListener('click', () => {
    panel.close()
    options.onChoose('server')
  })

  const download = document.createElement('button')
  download.type = 'button'
  download.className = 'app-panel-button'
  download.textContent = t('common.panel.save.action.download')
  download.addEventListener('click', () => {
    panel.close()
    options.onChoose('download')
  })

  panel.footer.append(download, toServer)

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
      toServer.textContent = t('common.panel.save.action.update')
    } else {
      state.textContent = t('common.panel.save.notOnServer')
      toServer.textContent = t('common.panel.save.action.create')
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
