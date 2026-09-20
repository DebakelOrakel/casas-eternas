import { t } from '../../i18n/i18n'
import { getLocalArtifactStore } from '../../storage/artifactStoreProvider'
import { clearArtifacts, describeArtifactUsage, groupArtifacts, resolutionLabel } from '../../storage/artifactAdmin'
import { formatBytes } from '../format'
import type { CachedVersion, CachedWorld } from '../../storage/artifactAdmin'
import { listServerArtifacts, removeServerArtifact, removeServerWorldArtifacts } from '../../server/artifactsClient'
import { createPanel } from '../panel/Panel'
import type { Panel } from '../panel/Panel'
import './storagePanel.css'

// What is cached where, and how to drop it. One of three windows sharing
// ui/panel's frame — this is the "clean" one; loading and saving have their
// own, because a panel that answers one question at a time beats one window
// with tabs (docs/decisions/server-storage.md).
//
// GROUPED BY WORLD (uid), one line per terrain × pipeline version below it.
// Both tiers list FLAT entries in the same shape and go through ONE grouping
// (artifactAdmin.groupArtifacts), so the sections differ in their heading and
// their delete's blast radius — never in shape. An entry whose meta is
// unreadable (older layout, half-copied) appears as its own group with its
// bytes, so the listing always accounts for what the usage total counts.
//
// TWO SECTIONS rather than one merged list, because the halves differ in the
// only way that matters here: dropping a local entry costs THIS machine a
// re-bake, while dropping the server's costs every other client the same.
//
// Still debug-grade otherwise: no confirmations, no sorting options, no
// pagination. Everything in both halves is a deterministic function of a
// world and a pipeline version, so the worst any button can cost is time.

export interface StoragePanel {
  open(): void
  dispose(): void
}

// The version's line: the algo+constants chip first, then the resolutions it
// has produced — [v6] [4K] [8K].
function chipRow(line: CachedVersion): string {
  const versionShort = line.pipelineVersion.split('-')[0] || line.pipelineVersion
  const version = `<span class="cache-chip cache-chip--version" title="${line.pipelineVersion}">${versionShort}</span>`
  const stages = line.stages
    .map((s) => `<span class="cache-chip" title="${t('common.panel.storage.chipTitle', { width: s.width, height: s.height, seconds: (s.bakeMs / 1000).toFixed(0) })}">${s.width > 0 ? resolutionLabel(s.width) : '?'}</span>`)
    .join('')
  return version + (stages || '<span class="cache-chip cache-chip--empty">—</span>')
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

  // One world: a header naming it (label from the bake's own metadata, uid as
  // the hover detail) with the group's size and the one delete this panel
  // offers, then a line per terrain × version.
  function worldGroup(world: CachedWorld, onDelete: () => Promise<void>): HTMLElement {
    const group = document.createElement('div')
    group.className = 'cache-world'
    const head = document.createElement('div')
    head.className = 'cache-world-head'
    head.innerHTML = `
      <span class="cache-world-label" title="${t('common.world.uid')}: ${world.worldUid}">${world.label}</span>
      <span class="cache-row-size">${formatBytes(world.bytes)}</span>
      <button type="button" class="app-panel-button cache-row-delete" aria-label="${t('common.panel.storage.delete')}">${t('common.panel.storage.delete')}</button>
    `
    head.querySelector('.cache-row-delete')!.addEventListener('click', () => {
      void (async () => {
        await onDelete()
        await refresh()
      })()
    })
    group.appendChild(head)
    let lines = 0
    for (const terrain of world.terrains) {
      for (const line of terrain.versions) {
        const row = document.createElement('div')
        row.className = 'cache-line'
        row.innerHTML = `
          <span class="cache-line-hash" title="${terrain.worldId}">${terrain.worldId.slice(0, 8)}</span>
          <span class="cache-row-chips">${chipRow(line)}</span>
          <span class="cache-row-size">${formatBytes(line.bytes)}</span>
        `
        group.appendChild(row)
        lines++
      }
    }
    // A group the walk could not resolve into lines (unreadable meta, an
    // older layout): one muted marker, so the bytes above visibly belong to
    // SOMETHING and the delete has an object.
    if (lines === 0) {
      const row = document.createElement('div')
      row.className = 'cache-line'
      row.innerHTML = '<span class="cache-row-chips"><span class="cache-chip cache-chip--empty">—</span></span>'
      group.appendChild(row)
    }
    return group
  }

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
    const [localEntries, usage, server] = await Promise.all([
      store.list().catch(() => []),
      describeArtifactUsage(store).catch(() => null),
      listServerArtifacts().catch(() => null),
    ])

    panel.status.textContent = usage ?? ''
    panel.body.replaceChildren()

    const localWorlds = groupArtifacts(localEntries)
    const localBytes = localWorlds.reduce((sum, world) => sum + world.bytes, 0)
    panel.body.appendChild(section(t('common.panel.storage.local'), localWorlds.length > 0 ? formatBytes(localBytes) : ''))
    if (localWorlds.length === 0) panel.body.appendChild(message(t('common.panel.storage.empty')))
    else for (const world of localWorlds) {
      panel.body.appendChild(worldGroup(world, async () => {
        // Deletion works in artifact uids — the group carries its own, so a
        // world with a real uid and a meta-less orphan delete the same way.
        for (const uid of world.artifactUids) await store.removeArtifact(uid).catch(() => undefined)
      }))
    }

    // Absent entirely when there is no server. An empty "on the server"
    // heading would state that one exists and holds nothing — a different and
    // wrong thing to tell someone working offline.
    if (server === null) return
    panel.body.appendChild(section(t('common.panel.storage.server'), formatBytes(server.bytes)))
    const serverWorlds = groupArtifacts(server.artifacts)
    if (serverWorlds.length === 0) panel.body.appendChild(message(t('common.panel.storage.serverEmpty')))
    else for (const world of serverWorlds) {
      panel.body.appendChild(worldGroup(world, async () => {
        // A group with terrains is a world the metas know — one scoped
        // request; a meta-less orphan is only reachable by its artifact uid.
        if (world.terrains.length > 0) await removeServerWorldArtifacts(world.worldUid)
        else for (const uid of world.artifactUids) await removeServerArtifact(uid)
      }))
    }
  }

  panel.onOpen(() => { void refresh() })

  return {
    open: () => panel.open(),
    dispose: () => panel.dispose(),
  }
}
