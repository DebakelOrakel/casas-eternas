import { t } from '../../i18n/i18n'
import { getArtifactStore } from '../../storage/artifactStoreProvider'
import { clearArtifacts, describeArtifactUsage, formatBytes, listCachedWorlds, removeCachedWorld, resolutionLabel } from '../../storage/artifactAdmin'
import type { CachedWorld } from '../../storage/artifactAdmin'
import { createPanel } from '../panel/Panel'
import type { Panel } from '../panel/Panel'
import './storagePanel.css'

// What the artifact cache holds, with per-world and clear-everything removal.
// One of three windows that share ui/panel's frame — this is the "clean" one;
// loading and saving have their own, because a panel that answers one
// question at a time beats one window with tabs (see
// docs/decisions/server-storage.md).
//
// Debug-grade, deliberately: no confirmations, no sorting, no pagination. The
// worst any button here can cost is one re-bake — which is precisely the
// difference from the world panels, where a delete cannot be undone by
// recomputing anything, and where the affordances are correspondingly heavier.
//
// Server-held artifacts will land here beside the local ones; the artifacts
// module answers 501 for now, so this is still the local cache alone.

export interface StoragePanel {
  open(): void
  dispose(): void
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
      await clearArtifacts(await getArtifactStore()).catch(() => undefined)
      await refresh()
    })()
  })
  panel.footer.appendChild(clearAll)

  function renderWorld(world: CachedWorld): HTMLElement {
    const row = document.createElement('div')
    row.className = 'cache-row'
    // Resolutions present, smallest first — the quickest way to see what a
    // world has already cost and what is still missing.
    const chips = world.stages
      .map((stage) => `<span class="cache-chip" title="${stage.width}×${stage.height}, baked in ${(stage.bakeMs / 1000).toFixed(0)}s">${resolutionLabel(stage.width)}</span>`)
      .join('')
    row.innerHTML = `
      <div class="cache-row-main">
        <span class="cache-row-label" title="${world.worldId}">${world.label}</span>
        <span class="cache-row-chips">${chips || '<span class="cache-chip cache-chip--empty">—</span>'}</span>
      </div>
      <span class="cache-row-size">${formatBytes(world.bytes)}</span>
      <button type="button" class="app-panel-button cache-row-delete" aria-label="${t('common.panel.storage.delete')}">${t('common.panel.storage.delete')}</button>
    `
    row.querySelector('.cache-row-delete')!.addEventListener('click', () => {
      void (async () => {
        await removeCachedWorld(await getArtifactStore(), world.worldId).catch(() => undefined)
        await refresh()
      })()
    })
    return row
  }

  async function refresh(): Promise<void> {
    panel.body.textContent = 'reading…'
    const store = await getArtifactStore()
    const [worlds, usage] = await Promise.all([
      listCachedWorlds(store).catch(() => [] as CachedWorld[]),
      describeArtifactUsage(store).catch(() => null),
    ])
    panel.status.textContent = usage ?? ''
    panel.body.replaceChildren()
    if (worlds.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'app-panel-empty'
      empty.textContent = t('common.panel.storage.empty')
      panel.body.appendChild(empty)
      return
    }
    for (const world of worlds) panel.body.appendChild(renderWorld(world))
  }

  panel.onOpen(() => { void refresh() })

  return {
    open: () => panel.open(),
    dispose: () => panel.dispose(),
  }
}
