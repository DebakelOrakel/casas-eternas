import { t } from '../../i18n/i18n'
import { getLocalArtifactStore } from '../../storage/artifactStoreProvider'
import { clearArtifacts, describeArtifactUsage, formatBytes, listCachedWorlds, removeCachedWorld, resolutionLabel } from '../../storage/artifactAdmin'
import type { CachedWorld } from '../../storage/artifactAdmin'
import { listServerArtifacts, removeServerArtifacts } from '../../server/artifactsClient'
import type { ServerArtifactWorld } from '../../server/artifactsClient'
import { createPanel } from '../panel/Panel'
import type { Panel } from '../panel/Panel'
import './storagePanel.css'

// What is cached where, and how to drop it. One of three windows sharing
// ui/panel's frame — this is the "clean" one; loading and saving have their
// own, because a panel that answers one question at a time beats one window
// with tabs (docs/decisions/server-storage.md).
//
// TWO SECTIONS rather than one merged list, because the halves differ in the
// only way that matters here: dropping a local entry costs THIS machine a
// re-bake, while dropping the server's costs every other client the same. A
// single list with two delete buttons per row would put those a few pixels
// apart and invite exactly the confusion the separation avoids — which is also
// why the footer button says "here".
//
// Still debug-grade otherwise: no confirmations, no sorting, no pagination.
// Everything in both halves is a deterministic function of a world and a
// pipeline version, so the worst any button can cost is time.

export interface StoragePanel {
  open(): void
  dispose(): void
}

function chipRow(stages: { width: number; height: number; bakeMs: number }[]): string {
  // Resolutions present, smallest first — the quickest way to see what a world
  // has already cost and what is still missing.
  const chips = stages
    .map((s) => `<span class="cache-chip" title="${s.width}×${s.height}, baked in ${(s.bakeMs / 1000).toFixed(0)}s">${s.width > 0 ? resolutionLabel(s.width) : '?'}</span>`)
    .join('')
  return chips || '<span class="cache-chip cache-chip--empty">—</span>'
}

export function createStoragePanel(host: HTMLElement): StoragePanel {
  const panel: Panel = createPanel(host, {
    variant: 'storage',
    title: t('common.action.storage.label'),
  })

  const clearAll = document.createElement('button')
  clearAll.type = 'button'
  clearAll.className = 'app-panel-button'
  clearAll.textContent = t('common.panel.storage.clearAll')
  clearAll.addEventListener('click', () => {
    void (async () => {
      await clearArtifacts(await getLocalArtifactStore()).catch(() => undefined)
      await refresh()
    })()
  })
  panel.footer.appendChild(clearAll)

  function section(title: string, usage: string): HTMLElement {
    const head = document.createElement('div')
    head.className = 'cache-section'
    head.innerHTML = `<span class="cache-section-title">${title}</span><span class="cache-section-usage">${usage}</span>`
    return head
  }

  function row(label: string, hint: string, chips: string, size: string, onDelete: () => Promise<void>): HTMLElement {
    const element = document.createElement('div')
    element.className = 'cache-row'
    element.innerHTML = `
      <div class="cache-row-main">
        <span class="cache-row-label" title="${hint}">${label}</span>
        <span class="cache-row-chips">${chips}</span>
      </div>
      <span class="cache-row-size">${size}</span>
      <button type="button" class="app-panel-button cache-row-delete" aria-label="${t('common.panel.storage.delete')}">${t('common.panel.storage.delete')}</button>
    `
    element.querySelector('.cache-row-delete')!.addEventListener('click', () => {
      void (async () => {
        await onDelete()
        await refresh()
      })()
    })
    return element
  }

  const localRow = (world: CachedWorld): HTMLElement =>
    row(world.label, world.worldId, chipRow(world.stages), formatBytes(world.bytes), async () => {
      await removeCachedWorld(await getLocalArtifactStore(), world.worldId).catch(() => undefined)
    })

  // The server has no readable label to show: its directory name IS the world
  // id, hash and all. The client's own label is derived at bake time and never
  // travels, so inventing one here would mean guessing.
  const serverRow = (world: ServerArtifactWorld): HTMLElement =>
    row(world.worldId, world.worldId, chipRow(world.stages), formatBytes(world.bytes), async () => {
      await removeServerArtifacts(world.worldId)
    })

  const message = (text: string): HTMLElement => {
    const paragraph = document.createElement('p')
    paragraph.className = 'app-panel-empty'
    paragraph.textContent = text
    return paragraph
  }

  async function refresh(): Promise<void> {
    panel.body.textContent = '…'
    const store = await getLocalArtifactStore()
    // Both sides fetched together: the server call is one request, and doing it
    // after the local walk would show the window jumping as it lands.
    const [worlds, usage, server] = await Promise.all([
      listCachedWorlds(store).catch(() => [] as CachedWorld[]),
      describeArtifactUsage(store).catch(() => null),
      listServerArtifacts().catch(() => null),
    ])

    panel.status.textContent = usage ?? ''
    panel.body.replaceChildren()

    const localBytes = worlds.reduce((sum, world) => sum + world.bytes, 0)
    panel.body.appendChild(section(t('common.panel.storage.local'), worlds.length > 0 ? formatBytes(localBytes) : ''))
    if (worlds.length === 0) panel.body.appendChild(message(t('common.panel.storage.empty')))
    else for (const world of worlds) panel.body.appendChild(localRow(world))

    // Absent entirely when there is no server. An empty "on the server"
    // heading would state that one exists and holds nothing — a different and
    // wrong thing to tell someone working offline.
    if (server === null) return
    panel.body.appendChild(section(t('common.panel.storage.server'), formatBytes(server.bytes)))
    if (server.worlds.length === 0) panel.body.appendChild(message(t('common.panel.storage.serverEmpty')))
    else for (const world of server.worlds) panel.body.appendChild(serverRow(world))
  }

  panel.onOpen(() => { void refresh() })

  return {
    open: () => panel.open(),
    dispose: () => panel.dispose(),
  }
}
