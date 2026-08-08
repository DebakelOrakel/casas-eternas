import { getLocale, t } from '../../i18n/i18n'
import { apiBase, fetchWorld, listWorlds } from '../../server/worldClient'
import type { WorldSummary } from '../../server/worldClient'
import { createPanel } from '../panel/Panel'
import './worldPanels.css'

// Choosing a world to open.
//
// This is the window the app has never had: until now "open a world" meant a
// file picker and guessing from a filename. With a server there is a list with
// thumbnails, and the preview is one the SAVE already contained — the server
// extracts it on upload precisely so a listing never has to unzip anything.
//
// Opened only when a server is actually there; without one the load button
// goes straight to the file picker, because a window offering a single choice
// is friction rather than choice.

export interface LoadPanelOptions {
  // Hands an archive to the screen, which owns the loading itself — this panel
  // knows how to CHOOSE a world, not how to restore one.
  onOpenArchive(archive: Blob): void
  // Opens the plain file picker the load button used to open directly.
  onPickFile(): void
}

export interface LoadPanel {
  open(): void
  dispose(): void
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' })
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function createLoadPanel(host: HTMLElement, options: LoadPanelOptions): LoadPanel {
  const panel = createPanel(host, { variant: 'worlds', title: t('common.panel.load.title') })

  const pickFile = document.createElement('button')
  pickFile.type = 'button'
  pickFile.className = 'app-panel-button'
  pickFile.textContent = t('common.panel.load.fromFile')
  pickFile.addEventListener('click', () => {
    panel.close()
    options.onPickFile()
  })
  panel.footer.appendChild(pickFile)

  function renderRow(world: WorldSummary, base: string): HTMLElement {
    const row = document.createElement('div')
    row.className = 'world-row'

    const thumb = document.createElement('div')
    thumb.className = 'world-thumb'
    if (world.hasPreview) {
      const image = document.createElement('img')
      image.src = `${base}/worlds/${encodeURIComponent(world.uid)}/preview.png`
      image.alt = ''
      // A world whose preview will not load must still show its row: the
      // thumbnail is a convenience, the world is the point.
      image.addEventListener('error', () => image.remove())
      thumb.appendChild(image)
    }

    const main = document.createElement('div')
    main.className = 'world-main'
    const name = document.createElement('span')
    name.className = 'world-name'
    name.textContent = world.name || world.uid
    name.title = world.uid
    const meta = document.createElement('span')
    meta.className = 'world-meta'
    // Erosion count says how far the world was actually taken, which is the
    // one thing a thumbnail cannot show.
    meta.textContent = [formatWhen(world.updatedAt), `rev ${world.revision}`, `${world.erosionRun}×`, formatSize(world.size)]
      .filter(Boolean)
      .join(' · ')
    main.append(name, meta)

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'app-panel-button'
    open.textContent = t('common.panel.load.action.open')
    open.addEventListener('click', () => {
      void (async () => {
        open.disabled = true
        const archive = await fetchWorld(world.uid)
        open.disabled = false
        if (!archive) return
        panel.close()
        options.onOpenArchive(archive)
      })()
    })

    const download = document.createElement('button')
    download.type = 'button'
    download.className = 'app-panel-button'
    download.textContent = t('common.panel.load.action.download')
    download.addEventListener('click', () => {
      void (async () => {
        const archive = await fetchWorld(world.uid)
        if (!archive) return
        const url = URL.createObjectURL(archive)
        const link = document.createElement('a')
        link.href = url
        link.download = `${(world.name || world.uid).replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`
        link.click()
        URL.revokeObjectURL(url)
      })()
    })

    row.append(thumb, main, open, download)
    return row
  }

  async function refresh(): Promise<void> {
    panel.body.textContent = '…'
    const [worlds, base] = await Promise.all([listWorlds(), apiBase()])
    panel.body.replaceChildren()
    if (!worlds || !base || worlds.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'app-panel-empty'
      empty.textContent = t('common.panel.load.empty')
      panel.body.appendChild(empty)
      return
    }
    for (const world of worlds) panel.body.appendChild(renderRow(world, base))
  }

  panel.onOpen(() => { void refresh() })

  return {
    open: () => panel.open(),
    dispose: () => panel.dispose(),
  }
}
