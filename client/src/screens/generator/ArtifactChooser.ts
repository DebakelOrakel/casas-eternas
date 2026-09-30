import { t, type TKey } from '../../i18n/i18n'
import { formatBytes } from '../../ui/format'
import { getLocalArtifactStore } from '../../storage/artifactStoreProvider'
import { artifactRows, clearArtifacts, type ArtifactEntry, type ArtifactRow } from '../../storage/artifactAdmin'
import { listServerArtifacts, removeServerArtifact } from '../../server/artifactsClient'
import { listWorlds } from '../../server/worldClient'
import { listBrowserWorlds } from '../../world/browserWorlds'
import { meshPipelineVersion } from '../../world/meshArtifacts'
import { meshTilePipelineVersion } from '../../world/meshTileArtifacts'
import { commissionBake } from '../../world/jobClient'
import { AMPLIFY_EROSION_ROUNDS } from '../../world/bakeSettings'
import { BROWSER_ICON, SERVER_ICON, icon } from './chooserIcons'
import '../../ui/theme/design.css'
import './worldChooser.css'
import './artifactChooser.css'

// The artifact window: what the world's derived data takes, where, and
// whether it is still current (the "Artefaktstore" of the design canvas,
// Main.dc.html). Full screen over the generator like the world list, whose
// frame and filter bar it shares. Artifacts are derivable from the save at
// any time, so deleting one loses nothing — it confirms in place all the
// same, as a world does.
//
// One row per world and kind of artifact, its levels side by side (L1, L2,
// L3 — the mesh levels of docs/decisions/adaptive-mesh.md). "This world" is
// the world the generator holds; "all worlds" whatever this browser and the
// server let the viewer see (the server lists by the worlds' access, and says
// per entry what the viewer may do).

export interface ArtifactChooserOptions {
  // The world the generator holds, or null before there is one; `worldId` its
  // last save's terrain id, null before it was saved.
  currentWorld(): { uid: string; name: string; seed: string; worldId: string | null } | null
  onClose(): void
}

export interface ArtifactChooser {
  element: HTMLElement
  relabel(): void
  open(): void
  close(): void
  isOpen(): boolean
  dispose(): void
}

type Scope = 'world' | 'all'
type Where = 'all' | 'server' | 'local'

// The levels a row shows, filled or dashed: the three the ladder plans.
const LEVELS = [1, 2, 3]
// An artifact is outdated when it was baked by another pipeline version than
// this client's (other code; this client does not look for it), or — for the
// world held here — from another terrain than its last save's (the world
// moved on since the bake).
function currentFor(world: { uid: string; worldId: string | null } | null) {
  return (entry: ArtifactEntry, level: number): boolean =>
    entry.pipelineVersion === (level === 2 ? meshTilePipelineVersion() : meshPipelineVersion(level))
    && !(world?.worldId && entry.worldUid === world.uid && entry.worldId !== world.worldId)
}

export function createArtifactChooser(host: HTMLElement, options: ArtifactChooserOptions): ArtifactChooser {
  const root = document.createElement('div')
  root.className = 'world-chooser artifact-chooser design-light'
  root.hidden = true
  root.innerHTML = `
    <div class="wc-sheet ac-sheet">
      <div class="ac-head">
        <div class="wc-head">
          <h1 class="wc-title"></h1>
          <p class="wc-subtitle"></p>
        </div>
        <button type="button" class="ac-close" data-act="close"></button>
      </div>
      <div class="ac-tiles">
        <div class="ac-tile"><span class="ac-tile__label" data-tile="server"></span><span class="ac-tile__value mono" data-value="server"></span></div>
        <div class="ac-tile"><span class="ac-tile__label" data-tile="browser"></span><span class="ac-tile__value mono" data-value="browser"></span></div>
        <div class="ac-tile"><span class="ac-tile__label" data-tile="count"></span><span class="ac-tile__value mono" data-value="count"></span><span class="ac-tile__hint" data-hint="count"></span></div>
        <div class="ac-tile"><span class="ac-tile__label" data-tile="stale"></span><span class="ac-tile__value mono" data-value="stale"></span><span class="ac-tile__hint" data-hint="stale"></span></div>
      </div>
      <div class="wc-listhead ac-filters">
        <div class="wc-filter">
          <button type="button" data-scope="world"></button>
          <button type="button" data-scope="all"></button>
        </div>
        <div class="wc-filter">
          <button type="button" data-where="all"></button>
          <button type="button" data-where="server"></button>
          <button type="button" data-where="local"></button>
        </div>
        <div class="wc-filter">
          <button type="button" data-stale="only" aria-pressed="false"></button>
        </div>
        <span class="wc-grow"></span>
        <span class="ac-hint" data-slot="levels-hint"></span>
      </div>
      <div class="ac-table" data-slot="table"></div>
      <div class="ac-foot">
        <p class="wc-foot" data-slot="foot"></p>
        <button type="button" class="wc-remove ac-clear" data-act="clear"></button>
      </div>
    </div>
  `
  const table = root.querySelector<HTMLElement>('[data-slot="table"]')!
  const closeButton = root.querySelector<HTMLButtonElement>('[data-act="close"]')!
  closeButton.appendChild(icon('<path d="M6 6l12 12M18 6L6 18"/>'))
  closeButton.addEventListener('click', () => options.onClose())
  root.addEventListener('keydown', (event) => { if (event.key === 'Escape') options.onClose() })

  // --- filters ----------------------------------------------------------------

  let scope: Scope = 'world'
  let where: Where = 'all'
  let onlyStale = false
  const scopeButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-scope]')]
  const whereButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-where]')]
  const staleButton = root.querySelector<HTMLButtonElement>('[data-stale]')!
  for (const button of scopeButtons) button.addEventListener('click', () => { scope = button.dataset.scope as Scope; paint() })
  for (const button of whereButtons) button.addEventListener('click', () => { where = button.dataset.where as Where; paint() })
  staleButton.addEventListener('click', () => { onlyStale = !onlyStale; paint() })

  // --- data -------------------------------------------------------------------

  let rows: ArtifactRow[] = []
  let worldNames = new Map<string, string>()
  let serverBytes: number | null = null
  let browserUsage: { usedBytes: number; quotaBytes: number } | null = null
  let serverReachable: boolean | null = null

  async function reload(): Promise<void> {
    const store = await getLocalArtifactStore()
    const [local, usage, server, browserWorlds, serverWorlds] = await Promise.all([
      store.list(), store.usage(), listServerArtifacts(), listBrowserWorlds(), listWorlds(),
    ])
    serverReachable = server !== null
    serverBytes = server ? server.bytes : null
    browserUsage = usage
    worldNames = new Map([...browserWorlds.map((w) => [w.uid, w.name] as const), ...(serverWorlds ?? []).map((w) => [w.uid, w.name] as const)])
    const entries: ArtifactEntry[] = [
      ...local.map((a): ArtifactEntry => ({ ...a, where: 'local', deletable: true })),
      ...(server?.artifacts ?? []).map((a): ArtifactEntry => ({
        artifactUid: a.artifactUid, bytes: a.bytes, worldUid: a.worldUid, worldId: a.worldId,
        pipelineVersion: a.pipelineVersion, stage: a.stage, label: a.label, where: 'server',
        deletable: a.callerLevel === 'editor' || a.callerLevel === 'owner' || a.callerLevel === 'admin',
      })),
    ]
    rows = artifactRows(entries, currentFor(options.currentWorld()))
    paint()
  }

  // --- rendering --------------------------------------------------------------

  function paintStatic(): void {
    root.querySelector('.wc-title')!.textContent = t('generator.artifacts.title')
    closeButton.setAttribute('aria-label', t('common.action.close.label'))
    for (const tile of ['server', 'browser', 'count', 'stale'] as const) {
      root.querySelector(`[data-tile="${tile}"]`)!.textContent = t(`generator.artifacts.${tile}` as TKey)
    }
    root.querySelector('[data-hint="count"]')!.textContent = t('generator.artifacts.countHint')
    root.querySelector('[data-hint="stale"]')!.textContent = t('generator.artifacts.staleHint')
    for (const button of scopeButtons) button.textContent = t(`generator.artifacts.scope.${button.dataset.scope}` as TKey)
    for (const button of whereButtons) button.textContent = t(`generator.artifacts.where.${button.dataset.where}` as TKey)
    staleButton.textContent = t('generator.artifacts.onlyStale')
    root.querySelector('[data-slot="levels-hint"]')!.textContent = t('generator.artifacts.levelsHint')
    root.querySelector('[data-slot="foot"]')!.textContent = t('generator.artifacts.foot')
    clearButton.textContent = t('generator.artifacts.clearBrowser')
  }

  function paint(): void {
    const world = options.currentWorld()
    const subtitle = root.querySelector('.wc-subtitle')!
    subtitle.textContent = world ? t('generator.artifacts.subtitle', { world: world.name || world.uid, seed: world.seed }) : ''
    // "This world" needs a world; before there is one, all of them.
    const effectiveScope: Scope = world ? scope : 'all'
    scopeButtons[0].disabled = !world
    for (const button of scopeButtons) button.setAttribute('aria-pressed', String(button.dataset.scope === effectiveScope))
    for (const button of whereButtons) button.setAttribute('aria-pressed', String(button.dataset.where === where))
    staleButton.setAttribute('aria-pressed', String(onlyStale))

    const inScope = rows.filter((row) => effectiveScope === 'all' || row.worldUid === world?.uid)
    const shown = inScope.filter((row) =>
      (where === 'all' || (where === 'server' ? row.server : row.local)) && (!onlyStale || row.stale))

    setValue('server', serverBytes === null ? '–' : formatBytes(serverBytes))
    setValue('browser', browserUsage ? (browserUsage.quotaBytes > 0 ? `${formatBytes(browserUsage.usedBytes)} / ${formatBytes(browserUsage.quotaBytes)}` : formatBytes(browserUsage.usedBytes)) : '–')
    setValue('count', String(inScope.reduce((n, row) => n + row.entries.length, 0)))
    setValue('stale', String(inScope.filter((row) => row.stale).length))

    const header = document.createElement('div')
    header.className = 'ac-row ac-row--head mono'
    const columns = ['artifact', ...(effectiveScope === 'all' ? ['world'] : []), 'levels', 'where', 'size', 'state']
    for (const column of columns) {
      const cell = document.createElement('span')
      cell.textContent = t(`generator.artifacts.col.${column}` as TKey)
      header.appendChild(cell)
    }
    header.appendChild(document.createElement('span'))
    table.classList.toggle('ac-table--world', effectiveScope === 'all')

    if (shown.length === 0) {
      const note = document.createElement('p')
      note.className = 'wc-note'
      const missingServer = serverReachable === false && where !== 'local'
      note.textContent = missingServer ? t('generator.artifacts.unavailable') : t('generator.artifacts.empty')
      table.replaceChildren(header, note)
      return
    }
    table.replaceChildren(header, ...shown.map((row) => renderRow(row, effectiveScope === 'all')))
  }

  function setValue(name: string, text: string): void {
    root.querySelector(`[data-value="${name}"]`)!.textContent = text
  }

  function renderRow(row: ArtifactRow, withWorld: boolean): HTMLElement {
    const line = document.createElement('div')
    line.className = 'ac-row'
    const name = t(row.kind === 'level' ? 'generator.artifacts.kind.level' : 'generator.artifacts.kind.unknown')

    const title = document.createElement('span')
    title.className = 'ac-name'
    const nameText = document.createElement('span')
    nameText.textContent = name
    const id = document.createElement('span')
    id.className = 'ac-id mono'
    id.textContent = row.entries[0].artifactUid.slice(0, 8)
    title.append(nameText, id)
    line.appendChild(title)

    if (withWorld) {
      const worldCell = document.createElement('span')
      worldCell.className = 'ac-world'
      worldCell.textContent = worldNames.get(row.worldUid) || row.label || row.worldUid || '–'
      line.appendChild(worldCell)
    }

    const levels = document.createElement('span')
    levels.className = 'ac-levels'
    for (const level of LEVELS) {
      const chip = document.createElement('span')
      chip.className = 'ac-level mono'
      chip.dataset.present = String(row.levels.includes(level))
      // The top level comes in tiles: how many this world holds.
      chip.textContent = level === 2 && row.tiles > 0 ? `L${level} ×${row.tiles}` : `L${level}`
      levels.appendChild(chip)
    }
    line.appendChild(levels)

    const place = document.createElement('span')
    place.className = 'ac-where'
    if (row.server) place.appendChild(icon(SERVER_ICON))
    if (row.local) place.appendChild(icon(BROWSER_ICON))
    place.setAttribute('aria-label', [row.server ? t('generator.artifacts.where.server') : '', row.local ? t('generator.artifacts.where.local') : ''].filter(Boolean).join(' + '))
    line.appendChild(place)

    const size = document.createElement('span')
    size.className = 'ac-size mono'
    size.textContent = formatBytes(row.bytes)
    line.appendChild(size)

    const state = document.createElement('span')
    state.className = 'ac-state'
    state.dataset.stale = String(row.stale)
    state.textContent = t(row.stale ? 'generator.artifacts.state.stale' : 'generator.artifacts.state.fresh')
    line.appendChild(state)

    // Deleting confirms in place, as a world does: the first click arms the
    // button, the second within a few seconds deletes. Greyed out where the
    // server says the viewer may not.
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'wc-remove'
    remove.disabled = !row.deletable
    remove.textContent = t('generator.artifacts.remove.label', { artifact: name })
    let armed: ReturnType<typeof setTimeout> | undefined
    remove.addEventListener('click', () => {
      if (armed === undefined) {
        remove.textContent = t('generator.artifacts.remove.confirm')
        remove.classList.add('wc-remove--armed')
        armed = setTimeout(() => {
          armed = undefined
          remove.textContent = t('generator.artifacts.remove.label', { artifact: name })
          remove.classList.remove('wc-remove--armed')
        }, 4000)
        return
      }
      clearTimeout(armed)
      armed = undefined
      void (async () => {
        remove.disabled = true
        const store = await getLocalArtifactStore()
        for (const entry of row.entries) {
          if (entry.where === 'local') await store.removeArtifact(entry.artifactUid)
          else await removeServerArtifact(entry.artifactUid)
        }
        await reload()
      })()
    })
    // An outdated level of a world on the server is ordered again from here
    // (a job, see the jobs window), where the viewer may: an editor.
    const actions = document.createElement('span')
    actions.className = 'ac-actions'
    if (row.kind === 'level' && row.stale && row.server && row.deletable && row.worldUid) {
      const rebuild = document.createElement('button')
      rebuild.type = 'button'
      rebuild.className = 'wc-remove'
      rebuild.textContent = t('generator.artifacts.rebuild.label', { artifact: name })
      rebuild.addEventListener('click', () => {
        rebuild.disabled = true
        void commissionBake(row.worldUid, 1, AMPLIFY_EROSION_ROUNDS)
      })
      actions.appendChild(rebuild)
    }
    actions.appendChild(remove)
    line.appendChild(actions)
    return line
  }

  // The browser's cache as a whole, armed like a row's delete.
  const clearButton = root.querySelector<HTMLButtonElement>('[data-act="clear"]')!
  let clearArmed: ReturnType<typeof setTimeout> | undefined
  clearButton.addEventListener('click', () => {
    if (clearArmed === undefined) {
      clearButton.textContent = t('generator.artifacts.remove.confirm')
      clearButton.classList.add('wc-remove--armed')
      clearArmed = setTimeout(() => {
        clearArmed = undefined
        clearButton.textContent = t('generator.artifacts.clearBrowser')
        clearButton.classList.remove('wc-remove--armed')
      }, 4000)
      return
    }
    clearTimeout(clearArmed)
    clearArmed = undefined
    clearButton.textContent = t('generator.artifacts.clearBrowser')
    clearButton.classList.remove('wc-remove--armed')
    void getLocalArtifactStore().then(clearArtifacts).then(reload)
  })

  paintStatic()
  paint()
  host.appendChild(root)

  return {
    element: root,
    relabel() {
      paintStatic()
      paint()
    },
    open() {
      root.hidden = false
      closeButton.focus()
      void reload()
    },
    close() {
      root.hidden = true
    },
    isOpen: () => !root.hidden,
    dispose() {
      root.remove()
    },
  }
}
