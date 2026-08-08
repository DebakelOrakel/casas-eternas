import { t } from '../../i18n/i18n'
import { getArtifactStore } from '../../storage/artifactStoreProvider'
import { clearArtifacts, describeArtifactUsage, formatBytes, listCachedWorlds, removeCachedWorld, resolutionLabel } from '../../storage/artifactAdmin'
import type { CachedWorld } from '../../storage/artifactAdmin'
import './cachePanel.css'

// A centred window listing what the artifact cache holds, with per-world and
// clear-everything removal. Screen-agnostic on purpose: the worldmap fills
// the cache, but a look at it is equally wanted from the generator — so this
// owns its own overlay and knows nothing about either screen beyond the
// element it mounts into.
//
// Debug-grade, deliberately: no confirmations (the worst any button here can
// cost is one re-bake), no sorting controls, no pagination. It exists to
// answer "what is in there and how much room is it taking", which is exactly
// the question a cache that grows silently needs to be able to answer.

export interface CachePanel {
  open(): void
  dispose(): void
}

export function createCachePanel(host: HTMLElement): CachePanel {
  const root = document.createElement('div')
  root.className = 'cache-panel-backdrop'
  root.hidden = true
  root.innerHTML = `
    <div class="cache-panel" role="dialog" aria-label="${t('common.action.storage.label')}">
      <header class="cache-panel-head">
        <h2>Artifact cache</h2>
        <span class="cache-panel-usage" data-value="usage"></span>
        <button type="button" class="cache-panel-close" data-action="close" aria-label="Close">×</button>
      </header>
      <div class="cache-panel-body" data-value="body"></div>
      <footer class="cache-panel-foot">
        <button type="button" class="cache-panel-button" data-action="clear-all">Delete everything</button>
      </footer>
    </div>
  `
  host.appendChild(root)

  const body = root.querySelector<HTMLElement>('[data-value="body"]')!
  const usageLabel = root.querySelector<HTMLElement>('[data-value="usage"]')!

  const close = (): void => {
    root.hidden = true
  }

  root.querySelector('[data-action="close"]')!.addEventListener('click', close)
  // Clicking the backdrop closes; clicking the window itself must not.
  root.addEventListener('click', (event) => {
    if (event.target === root) close()
  })
  root.querySelector('[data-action="clear-all"]')!.addEventListener('click', () => {
    void (async () => {
      await clearArtifacts(await getArtifactStore()).catch(() => undefined)
      await refresh()
    })()
  })

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
      <button type="button" class="cache-panel-button cache-row-delete" aria-label="Delete this world">Delete</button>
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
    body.textContent = 'reading…'
    const store = await getArtifactStore()
    const [worlds, usage] = await Promise.all([
      listCachedWorlds(store).catch(() => [] as CachedWorld[]),
      describeArtifactUsage(store).catch(() => null),
    ])
    usageLabel.textContent = usage ?? ''
    body.replaceChildren()
    if (worlds.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'cache-empty'
      empty.textContent = 'Nothing cached yet — a world is stored once its bake finishes.'
      body.appendChild(empty)
      return
    }
    for (const world of worlds) body.appendChild(renderWorld(world))
  }

  return {
    open(): void {
      root.hidden = false
      void refresh()
    },
    dispose(): void {
      root.remove()
    },
  }
}
