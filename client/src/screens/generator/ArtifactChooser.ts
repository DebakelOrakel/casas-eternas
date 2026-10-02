import { t, type TKey } from '../../i18n/i18n'
import { formatBytes } from '../../ui/format'
import { getLocalArtifactStore } from '../../storage/artifactStoreProvider'
import { clearArtifacts } from '../../storage/artifactAdmin'
import { listServerArtifactLevels, removeServerLevel } from '../../server/artifactsClient'
import { listWorlds } from '../../server/worldClient'
import { listBrowserWorlds } from '../../world/browserWorlds'
import { currentPipelineVersion, parseStage } from '../../world/levels'
import { commissionBake, type CommissionOutcome } from '../../world/jobClient'
import { AMPLIFY_EROSION_ROUNDS } from '../../world/bakeSettings'
import { BROWSER_ICON, SERVER_ICON, icon } from '../../ui/chooserIcons'
import '../../ui/theme/design.css'
import '../../ui/worldChooser/worldChooser.css'
import './artifactChooser.css'

// The artifact window: what the world's derived data takes, where, and
// whether it is still current (the "Artefaktstore" of the design canvas,
// Main.dc.html). Full screen over the generator like the world list, whose
// frame and filter bar it shares. Artifacts are derivable from the save at
// any time, so deleting one loses nothing — it confirms in place all the
// same, as a world does.
//
// One GROUP per world, named with its seed, and in it one ROW per level,
// terrain, pipeline version and place (2026-10-02): the server's and this
// browser's copies are deleted apart, a level's tiles are one row with their
// count, and an outdated row says why — another terrain than the world's
// last save, or other code. The server sums its levels itself
// (GET /v1/artifacts/levels); a world refined to level 3 is ten thousand
// entries in the flat listing. Entries that are no level (junk of older
// bakes) are not shown; the store's eviction takes them first. "This world"
// is the world the generator holds; "all worlds" whatever this browser and
// the server let the viewer see (the server lists by the worlds' access, and
// says per row what the viewer may do).

export interface ArtifactChooserOptions {
  // The world the generator holds, or null before there is one; `worldId` its
  // last save's terrain id, null before it was saved.
  currentWorld(): { uid: string; name: string; seed: string; worldId: string | null } | null
  onClose(): void
  // What became of an order placed from here (the screen says why it failed).
  onCommissioned(outcome: CommissionOutcome): void
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

// One row: one level of one terrain under one pipeline version, in one place.
interface LevelRow {
  worldUid: string
  worldId: string
  pipelineVersion: string
  level: number
  // How many tiles, for a level that comes in tiles; 0 for a whole level.
  tiles: number
  where: 'server' | 'local'
  bytes: number
  label: string
  deletable: boolean
  // Why it is outdated, or null: another terrain than the world's last
  // save (known only for the world held here), or other code.
  stale: 'otherTerrain' | 'otherCode' | null
  // The browser's entries, deleted one by one (the server deletes a level
  // in one request).
  localUids: string[]
}

function staleOf(row: Pick<LevelRow, 'worldUid' | 'worldId' | 'pipelineVersion' | 'level' | 'tiles'>, world: { uid: string; worldId: string | null } | null): LevelRow['stale'] {
  const stage = row.tiles > 0 ? `L${row.level}:0,0` : `L${row.level}`
  if (row.pipelineVersion !== currentPipelineVersion(stage)) return 'otherCode'
  if (world?.worldId && row.worldUid === world.uid && row.worldId !== world.worldId) return 'otherTerrain'
  return null
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

  let rows: LevelRow[] = []
  // Each world's name and seed, from this browser's list and the server's.
  let worlds = new Map<string, { name: string; seed: string }>()
  let serverBytes: number | null = null
  let browserUsage: { usedBytes: number; quotaBytes: number } | null = null
  let serverReachable: boolean | null = null

  async function reload(): Promise<void> {
    const store = await getLocalArtifactStore()
    const [local, usage, server, browserWorlds, serverWorlds] = await Promise.all([
      store.list(), store.usage(), listServerArtifactLevels(), listBrowserWorlds(), listWorlds(),
    ])
    serverReachable = server !== null
    serverBytes = server ? server.bytes : null
    browserUsage = usage
    worlds = new Map([...(serverWorlds ?? []).map((w) => [w.uid, w] as const), ...browserWorlds.map((w) => [w.uid, w] as const)]
      .map(([uid, w]) => [uid, { name: w.name, seed: w.seed }] as const))
    const world = options.currentWorld()
    const next: LevelRow[] = (server?.levels ?? []).map((l) => ({
      worldUid: l.worldUid, worldId: l.worldId, pipelineVersion: l.pipelineVersion, level: l.level,
      tiles: l.tiles ? l.count : 0, where: 'server', bytes: l.bytes, label: l.label,
      deletable: l.callerLevel === 'editor' || l.callerLevel === 'owner' || l.callerLevel === 'admin',
      stale: null, localUids: [],
    }))
    // The browser's entries, summed as the server sums its own.
    const localRows = new Map<string, LevelRow>()
    for (const a of local) {
      const parsed = parseStage(a.stage)
      if (!parsed) continue
      const key = `${a.worldUid}|${a.worldId}|${a.pipelineVersion}|${parsed.level}|${parsed.tile ? 't' : 'w'}`
      let row = localRows.get(key)
      if (!row) {
        row = { worldUid: a.worldUid, worldId: a.worldId, pipelineVersion: a.pipelineVersion, level: parsed.level, tiles: 0, where: 'local', bytes: 0, label: a.label, deletable: true, stale: null, localUids: [] }
        localRows.set(key, row)
      }
      if (parsed.tile) row.tiles++
      row.bytes += a.bytes
      row.localUids.push(a.artifactUid)
    }
    next.push(...localRows.values())
    for (const row of next) row.stale = staleOf(row, world)
    // By level, the current terrain first, then the server's copy first.
    rows = next.sort((a, b) => a.level - b.level || Number(a.stale !== null) - Number(b.stale !== null) || a.where.localeCompare(b.where) * -1)
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
    const shown = inScope.filter((row) => (where === 'all' || row.where === where) && (!onlyStale || row.stale !== null))

    setValue('server', serverBytes === null ? '–' : formatBytes(serverBytes))
    setValue('browser', browserUsage ? (browserUsage.quotaBytes > 0 ? `${formatBytes(browserUsage.usedBytes)} / ${formatBytes(browserUsage.quotaBytes)}` : formatBytes(browserUsage.usedBytes)) : '–')
    setValue('count', String(inScope.reduce((n, row) => n + Math.max(1, row.tiles), 0)))
    setValue('stale', String(inScope.filter((row) => row.stale !== null).length))

    const header = document.createElement('div')
    header.className = 'ac-row ac-row--head mono'
    for (const column of ['world', 'levels', 'where', 'size', 'state']) {
      const cell = document.createElement('span')
      cell.textContent = t(`generator.artifacts.col.${column}` as TKey)
      header.appendChild(cell)
    }
    header.appendChild(document.createElement('span'))

    if (shown.length === 0) {
      const note = document.createElement('p')
      note.className = 'wc-note'
      const missingServer = serverReachable === false && where !== 'local'
      note.textContent = missingServer ? t('generator.artifacts.unavailable') : t('generator.artifacts.empty')
      table.replaceChildren(header, note)
      return
    }
    // The world held here first, then the largest.
    const groups = new Map<string, LevelRow[]>()
    for (const row of shown) groups.set(row.worldUid, [...(groups.get(row.worldUid) ?? []), row])
    const bytesOf = (list: LevelRow[]): number => list.reduce((n, row) => n + row.bytes, 0)
    const ordered = [...groups.entries()].sort(([ua, a], [ub, b]) => Number(ub === world?.uid) - Number(ua === world?.uid) || bytesOf(b) - bytesOf(a))
    table.replaceChildren(header, ...ordered.flatMap(([uid, list]) => [renderGroup(uid, list), ...list.map((row) => renderRow(row, world))]))
  }

  function setValue(name: string, text: string): void {
    root.querySelector(`[data-value="${name}"]`)!.textContent = text
  }

  // A world's head: its name and seed, and what its rows take together.
  function renderGroup(uid: string, list: LevelRow[]): HTMLElement {
    const line = document.createElement('div')
    line.className = 'ac-row ac-group'
    const held = options.currentWorld()
    const known = held?.uid === uid ? { name: held.name, seed: held.seed } : worlds.get(uid)
    const name = known?.name || list[0].label || uid || '–'
    const title = document.createElement('span')
    title.className = 'ac-name'
    const nameText = document.createElement('span')
    nameText.className = 'ac-world'
    nameText.textContent = known?.seed ? t('generator.artifacts.group', { world: name, seed: known.seed }) : name
    const id = document.createElement('span')
    id.className = 'ac-id mono'
    id.textContent = uid.slice(0, 8)
    title.append(nameText, id)
    line.append(title, document.createElement('span'), document.createElement('span'))
    const size = document.createElement('span')
    size.className = 'ac-size mono'
    size.textContent = formatBytes(list.reduce((n, row) => n + row.bytes, 0))
    line.append(size, document.createElement('span'), document.createElement('span'))
    return line
  }

  function renderRow(row: LevelRow, world: { uid: string; worldId: string | null } | null): HTMLElement {
    const line = document.createElement('div')
    line.className = 'ac-row ac-level-row'
    const levelName = `L${row.level}`

    // Which terrain: for the world held here, its last save's or an older
    // one; for any other, the terrain's id (which is current is not known
    // without opening it).
    const terrain = document.createElement('span')
    terrain.className = 'ac-id mono'
    terrain.textContent = world?.worldId && row.worldUid === world.uid
      ? t(row.worldId === world.worldId ? 'generator.artifacts.terrain.current' : 'generator.artifacts.terrain.old')
      : row.worldId.slice(0, 8)
    terrain.title = row.worldId
    line.appendChild(terrain)

    const levels = document.createElement('span')
    levels.className = 'ac-levels'
    const chip = document.createElement('span')
    chip.className = 'ac-level mono'
    chip.dataset.present = 'true'
    chip.textContent = levelName
    levels.appendChild(chip)
    if (row.tiles > 0) {
      const count = document.createElement('span')
      count.className = 'ac-tiles-count'
      count.textContent = t('generator.artifacts.level.tiles', { count: row.tiles.toLocaleString() })
      levels.appendChild(count)
    }
    line.appendChild(levels)

    const place = document.createElement('span')
    place.className = 'ac-where'
    place.appendChild(icon(row.where === 'server' ? SERVER_ICON : BROWSER_ICON))
    place.setAttribute('aria-label', t(row.where === 'server' ? 'generator.artifacts.where.server' : 'generator.artifacts.where.local'))
    line.appendChild(place)

    const size = document.createElement('span')
    size.className = 'ac-size mono'
    size.textContent = formatBytes(row.bytes)
    line.appendChild(size)

    const state = document.createElement('span')
    state.className = 'ac-state'
    state.dataset.stale = String(row.stale !== null)
    state.textContent = t(row.stale === 'otherTerrain' ? 'generator.artifacts.state.otherTerrain'
      : row.stale === 'otherCode' ? 'generator.artifacts.state.otherCode'
      : 'generator.artifacts.state.fresh')
    line.appendChild(state)

    // Deleting confirms in place, as a world does: the first click arms the
    // button, the second within a few seconds deletes. Greyed out where the
    // server says the viewer may not.
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'wc-remove'
    remove.disabled = !row.deletable
    remove.textContent = t('generator.artifacts.remove.label', { artifact: levelName })
    let armed: ReturnType<typeof setTimeout> | undefined
    remove.addEventListener('click', () => {
      if (armed === undefined) {
        remove.textContent = t('generator.artifacts.remove.confirm')
        remove.classList.add('wc-remove--armed')
        armed = setTimeout(() => {
          armed = undefined
          remove.textContent = t('generator.artifacts.remove.label', { artifact: levelName })
          remove.classList.remove('wc-remove--armed')
        }, 4000)
        return
      }
      clearTimeout(armed)
      armed = undefined
      void (async () => {
        remove.disabled = true
        if (row.where === 'server') await removeServerLevel(row.worldUid, row.level, row.worldId, row.pipelineVersion)
        else {
          const store = await getLocalArtifactStore()
          for (const uid of row.localUids) await store.removeArtifact(uid)
        }
        await reload()
      })()
    })
    // An outdated level 1 on the server is ordered again from here (a job,
    // see the jobs window), where the viewer may: an editor. Only level 1:
    // the button orders level 1, and stale tiles have no rebuild here yet.
    const actions = document.createElement('span')
    actions.className = 'ac-actions'
    if (row.where === 'server' && row.level === 1 && row.tiles === 0 && row.stale !== null && row.deletable && row.worldUid) {
      const rebuild = document.createElement('button')
      rebuild.type = 'button'
      rebuild.className = 'wc-remove'
      rebuild.textContent = t('generator.artifacts.rebuild.label', { artifact: levelName })
      rebuild.addEventListener('click', () => {
        rebuild.disabled = true
        void commissionBake(row.worldUid, 1, AMPLIFY_EROSION_ROUNDS).then((outcome) => {
          options.onCommissioned(outcome)
          if (!outcome.ok) rebuild.disabled = false
        })
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
