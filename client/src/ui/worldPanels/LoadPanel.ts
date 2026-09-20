import { t } from '../../i18n/i18n'
import { formatBytes, formatWhen } from '../format'
import { apiBase, deleteWorld, fetchWorld, fetchWorldPreview, listWorlds } from '../../server/worldClient'
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

  function renderRow(world: WorldSummary): HTMLElement {
    const row = document.createElement('div')
    row.className = 'world-row'

    const thumb = document.createElement('div')
    thumb.className = 'world-thumb'
    if (world.hasPreview) {
      // Fetched, not linked: an `<img src>` the browser resolves itself carries
      // no Authorization header, so against an authenticating server every
      // thumbnail came back 401 and the rows showed empty squares — silently,
      // because an image error event says nothing. See fetchWorldPreview.
      void fetchWorldPreview(world.uid).then((url) => {
        if (!url) return
        const image = document.createElement('img')
        image.src = url
        image.alt = ''
        // Revoked once the browser has decoded it, so a list opened repeatedly
        // does not accumulate blobs for the lifetime of the page.
        image.addEventListener('load', () => URL.revokeObjectURL(url), { once: true })
        image.addEventListener('error', () => {
          URL.revokeObjectURL(url)
          image.remove()
        }, { once: true })
        thumb.appendChild(image)
      })
    }

    const main = document.createElement('div')
    main.className = 'world-main'
    const name = document.createElement('span')
    name.className = 'world-name'
    // metadata.name as the save wrote it — today that is the seed text; the
    // editable display name is the still-open task server-storage.md split off.
    name.textContent = world.name || world.uid
    name.title = world.uid
    const meta = document.createElement('span')
    meta.className = 'world-meta'
    // Erosion count says how far the world was actually taken, which is the
    // one thing a thumbnail cannot show.
    meta.textContent = [formatWhen(world.updatedAt), `${t('common.world.revision')} ${world.revision}`, `${world.erosionRun}×`, formatBytes(world.size)]
      .filter(Boolean)
      .join(' · ')
    // The identity line: what exactly this entry is, for anyone comparing
    // saves across machines. Hashes shortened for the eye, full in the title;
    // fields a pre-2026-08-12 upload does not carry simply stay away.
    const identity = document.createElement('span')
    identity.className = 'world-meta world-meta--identity'
    identity.textContent = [
      world.seed ? `${t('common.world.seed')} ${world.seed}` : '',
      `${t('common.world.uid')} ${world.uid.slice(0, 8)}`,
      world.contentHash ? `${t('common.world.checksum')} ${world.contentHash.slice(0, 8)}` : '',
      world.generator ? `${t('common.world.build')} ${world.generator}` : '',
    ].filter(Boolean).join(' · ')
    identity.title = [world.uid, world.contentHash].filter(Boolean).join('\n')
    main.append(name, meta, identity)

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'app-panel-button'
    open.textContent = t('common.panel.load.action.open')
    open.addEventListener('click', () => {
      void (async () => {
        open.disabled = true
        const archive = await fetchWorld(world.uid)
        open.disabled = false
        if (!archive) {
          // Was a bare `return`: the button re-enabled itself and nothing else
          // happened, which reads as a click that did not register. The title
          // bar's status line is where this frame puts such things.
          panel.status.textContent = t('common.panel.load.unavailable')
          return
        }
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

    // Deleting is irreversible here — a world is the one thing nobody can
    // recompute — so the button confirms IN PLACE: the first click arms it,
    // the second (within a few seconds) deletes. No dialog machinery, and an
    // accidental click disarms itself.
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'app-panel-button world-delete'
    remove.textContent = t('common.panel.load.action.delete')
    let armed: ReturnType<typeof setTimeout> | undefined
    remove.addEventListener('click', () => {
      if (armed === undefined) {
        remove.textContent = t('common.panel.load.action.deleteConfirm')
        remove.classList.add('world-delete--armed')
        armed = setTimeout(() => {
          armed = undefined
          remove.textContent = t('common.panel.load.action.delete')
          remove.classList.remove('world-delete--armed')
        }, 4000)
        return
      }
      clearTimeout(armed)
      void (async () => {
        remove.disabled = true
        const gone = await deleteWorld(world.uid)
        if (!gone) {
          remove.disabled = false
          panel.status.textContent = t('common.panel.load.unavailable')
          return
        }
        await refresh()
      })()
    })

    row.append(thumb, main, open, download, remove)
    return row
  }

  async function refresh(): Promise<void> {
    panel.body.textContent = '…'
    const [worlds, base] = await Promise.all([listWorlds(), apiBase()])
    panel.body.replaceChildren()
    panel.status.textContent = ''
    // "Could not be read" and "there are none" collapsed into one message until
    // authentication existed, because before it the first case could only mean
    // no server — and then this window does not open at all. A signed-out client
    // reaches here and was told the server was empty, which is a lie that sends
    // someone looking in the wrong place.
    if (!worlds || !base) {
      const failed = document.createElement('p')
      failed.className = 'app-panel-empty'
      failed.textContent = t('common.panel.load.unavailable')
      panel.body.appendChild(failed)
      return
    }
    if (worlds.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'app-panel-empty'
      empty.textContent = t('common.panel.load.empty')
      panel.body.appendChild(empty)
      return
    }
    for (const world of worlds) panel.body.appendChild(renderRow(world))
  }

  panel.onOpen(() => { void refresh() })

  return {
    open: () => panel.open(),
    dispose: () => panel.dispose(),
  }
}
