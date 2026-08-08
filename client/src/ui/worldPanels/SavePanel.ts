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
  // load or a regenerate replaces it while the panel exists.
  currentUid(): string
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
    const uid = options.currentUid()
    state.textContent = '…'
    // Disabled while unknown: a button whose label has not settled yet is a
    // button someone clicks before it means what it will mean.
    toServer.disabled = true

    const worlds = await listWorlds()
    const held = worlds?.find((world) => world.uid === uid)
    toServer.disabled = false

    if (held) {
      const when = new Date(held.updatedAt).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' })
      state.textContent = t('common.panel.save.onServer', { revision: held.revision, when })
      toServer.textContent = t('common.panel.save.action.update')
    } else {
      state.textContent = t('common.panel.save.notOnServer')
      toServer.textContent = t('common.panel.save.action.create')
    }
  }

  panel.onOpen(() => { void refresh() })

  return {
    open: () => panel.open(),
    dispose: () => panel.dispose(),
  }
}
