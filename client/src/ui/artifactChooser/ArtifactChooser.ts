import { t, type TKey } from '../../i18n/i18n'
import { formatBytes } from '../../ui/format'
import { getLocalArtifactStore } from '../../storage/artifactStoreProvider'
import { clearArtifacts } from '../../storage/artifactAdmin'
import { listServerArtifactLevels, removeServerLevel, removeServerPipelineBuilds, type ServerPipelineBuilds } from '../../server/artifactsClient'
import { listWorlds } from '../../server/worldClient'
import { listBrowserWorlds } from '../../world/browserWorlds'
import { currentPipelineVersion, parseStage, type PipelineVersions } from '../../world/levels'
import { WORLD_PIPELINE, sameWorldsPipeline } from '../../world/worldPipeline'
import { commissionBake, pipelineVersionsOf, type CommissionOutcome } from '../../world/jobClient'
import { AMPLIFY_EROSION_ROUNDS } from '../../world/bakeSettings'
import { BROWSER_ICON, SERVER_ICON, icon } from '../../ui/chooserIcons'
import type { NotificationManager } from '../notifications/NotificationManager'
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
// One GROUP per terrain, named with a world that holds it and its seed, and
// in it one ROW per level, pipeline version and place (2026-10-02): the
// server's and this browser's copies are deleted apart, a level's tiles are
// one row with their count, and an outdated row says why — another terrain
// than the world's last save, or other code. The server sums its levels
// itself (GET /v1/artifacts/levels); a world refined to level 3 is ten
// thousand entries in the flat listing. Entries that are no level (junk of
// older bakes) are not shown; the store's eviction takes them first.
//
// BY TERRAIN since DEC-0039: an artifact is keyed by its content, so it
// belongs to every world with that terrain — a template and its copies
// share one. Which worlds hold a terrain the server's world list says
// (WorldSummary.terrains). "This world" is the terrains of the world the
// generator holds; "all worlds" whatever this browser and the server let
// the viewer see (the server lists by the worlds' access, and says per row
// what the viewer may do: a terrain other worlds hold too is deleted by an
// admin only).
//
// ENGINES (docs/decisions/engine-releases.md): the server keeps the files of
// the pipelines' releases for the workers of each pipeline. They belong to
// no world, so they are a group of their own, last, in either scope: one
// row per pipeline version, removed by the operator only.

// The menu entry's icon, the same on every screen that offers the window.
export const ARTIFACTS_ICON = 'M4 6a8 3 0 1 0 16 0a8 3 0 1 0-16 0M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'

// Says why an order failed, as every screen that places one says it.
export function reportCommission(notifications: NotificationManager, outcome: CommissionOutcome): void {
  if (outcome.ok) return
  if (outcome.reason === 'unknownWorld') {
    notifications.show({ message: t('notify.bake.needsUpload'), icon: '/icons/warning.png', durationMs: 8000 })
    return
  }
  notifications.show({ message: t('notify.bake.failed', { reason: outcome.message ?? outcome.reason }), icon: '/icons/warning.png', durationMs: 8000 })
}

export interface ArtifactChooserOptions {
  // The world the screen holds, or null where there is none; `worldId` its
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
  // Made under the version of the pipeline that made a world holding the
  // terrain, another one than this client's: that world's refinement
  // (docs/decisions/engine-releases.md), so not outdated.
  older: boolean
  // The browser's entries, deleted one by one (the server deletes a level
  // in one request).
  localUids: string[]
}

// `held` is the terrains of the world held here (heldTerrains).
// A pipeline version as a row shows it: its first eight characters (the
// algorithm's number and the start of the hash); the whole in the tooltip.
function shortPipeline(version: string): string {
  return version.length > 12 ? `${version.slice(0, 8)}…` : version
}

// `versions`: those of the other pipelines that made the worlds holding the
// row's terrain (their releases').
function staleOf(row: Pick<LevelRow, 'worldId' | 'pipelineVersion' | 'level' | 'tiles'>, world: { worldId: string | null } | null, held: Set<string>, versions: PipelineVersions[]): Pick<LevelRow, 'stale' | 'older'> {
  const stage = row.tiles > 0 ? `L${row.level}:0,0` : `L${row.level}`
  const older = row.pipelineVersion !== currentPipelineVersion(stage)
  if (older && !versions.some((v) => row.pipelineVersion === currentPipelineVersion(stage, v))) return { stale: 'otherCode', older: false }
  if (world?.worldId && held.has(row.worldId) && row.worldId !== world.worldId) return { stale: 'otherTerrain', older }
  return { stale: null, older }
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
  let pipelines: ServerPipelineBuilds[] = []
  // Each world's name and seed, from this browser's list and the server's.
  let worlds = new Map<string, { name: string; seed: string }>()
  // Each terrain's worlds, from the server's list (WorldSummary.terrains).
  let holders = new Map<string, string[]>()
  let serverBytes: number | null = null
  let browserUsage: { usedBytes: number; quotaBytes: number } | null = null
  let serverReachable: boolean | null = null

  async function reload(): Promise<void> {
    const store = await getLocalArtifactStore()
    const [local, usage, server, browserWorlds, serverWorlds] = await Promise.all([
      store.list(), store.usage(), listServerArtifactLevels(), listBrowserWorlds(), listWorlds(),
    ])
    serverReachable = server !== null
    pipelines = server?.pipelines ?? []
    serverBytes = server ? server.bytes : null
    browserUsage = usage
    worlds = new Map([...(serverWorlds ?? []).map((w) => [w.uid, w] as const), ...browserWorlds.map((w) => [w.uid, w] as const)]
      .map(([uid, w]) => [uid, { name: w.name, seed: w.seed }] as const))
    holders = new Map()
    for (const w of serverWorlds ?? []) {
      for (const terrain of w.terrains ?? []) holders.set(terrain, [...(holders.get(terrain) ?? []), w.uid])
    }
    const world = options.currentWorld()
    const next: LevelRow[] = (server?.levels ?? []).map((l) => ({
      worldId: l.worldId, pipelineVersion: l.pipelineVersion, level: l.level,
      tiles: l.tiles ? l.count : 0, where: 'server', bytes: l.bytes, label: l.label,
      deletable: l.actions?.includes('artifact.remove') ?? false,
      stale: null, older: false, localUids: [],
    }))
    // The browser's entries, summed as the server sums its own.
    const localRows = new Map<string, LevelRow>()
    for (const a of local) {
      const parsed = parseStage(a.stage)
      if (!parsed) continue
      const key = `${a.worldId}|${a.pipelineVersion}|${parsed.level}|${parsed.tile ? 't' : 'w'}`
      let row = localRows.get(key)
      if (!row) {
        row = { worldId: a.worldId, pipelineVersion: a.pipelineVersion, level: parsed.level, tiles: 0, where: 'local', bytes: 0, label: a.label, deletable: true, stale: null, older: false, localUids: [] }
        localRows.set(key, row)
      }
      if (parsed.tile) row.tiles++
      row.bytes += a.bytes
      row.localUids.push(a.artifactUid)
    }
    next.push(...localRows.values())
    const held = heldTerrains()
    // The other pipelines the server's worlds were made by, and the
    // versions their releases name, per terrain.
    const pipelineOf = new Map((serverWorlds ?? []).map((w) => [w.uid, sameWorldsPipeline(w.pipeline ?? '')] as const))
    const others = [...new Set(pipelineOf.values())].filter((pipeline) => pipeline !== '' && pipeline !== WORLD_PIPELINE)
    const named = new Map(await Promise.all(others.map(async (pipeline) => [pipeline, await pipelineVersionsOf(pipeline)] as const)))
    const versionsOf = (terrain: string): PipelineVersions[] =>
      (holders.get(terrain) ?? []).map((uid) => named.get(pipelineOf.get(uid) ?? '')).filter((v): v is PipelineVersions => !!v)
    for (const row of next) Object.assign(row, staleOf(row, world, held, versionsOf(row.worldId)))
    // By level, the current terrain first, then the server's copy first.
    rows = next.sort((a, b) => a.level - b.level || Number(a.stale !== null) - Number(b.stale !== null) || a.where.localeCompare(b.where) * -1)
    paint()
  }

  // The terrains of the world held here: those the server names for it,
  // and its last save's.
  function heldTerrains(): Set<string> {
    const world = options.currentWorld()
    const held = new Set<string>()
    if (!world) return held
    if (world.worldId) held.add(world.worldId)
    for (const [terrain, uids] of holders) if (uids.includes(world.uid)) held.add(terrain)
    return held
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

    const held = heldTerrains()
    const inScope = rows.filter((row) => effectiveScope === 'all' || held.has(row.worldId))
    const shown = inScope.filter((row) => (where === 'all' || row.where === where) && (!onlyStale || row.stale !== null))

    setValue('server', serverBytes === null ? '–' : formatBytes(serverBytes))
    setValue('browser', browserUsage ? (browserUsage.quotaBytes > 0 ? `${formatBytes(browserUsage.usedBytes)} / ${formatBytes(browserUsage.quotaBytes)}` : formatBytes(browserUsage.usedBytes)) : '–')
    setValue('count', String(inScope.reduce((n, row) => n + Math.max(1, row.tiles), 0)))
    setValue('stale', String(inScope.filter((row) => row.stale !== null).length))

    const header = document.createElement('div')
    header.className = 'ac-row ac-row--head mono'
    for (const column of ['world', 'pipeline', 'levels', 'where', 'size', 'state']) {
      const cell = document.createElement('span')
      cell.textContent = t(`generator.artifacts.col.${column}` as TKey)
      header.appendChild(cell)
    }
    header.appendChild(document.createElement('span'))

    const engines = where === 'local' ? [] : pipelines.filter((p) => !onlyStale || p.pipelineVersion !== WORLD_PIPELINE)
    if (shown.length === 0 && engines.length === 0) {
      const note = document.createElement('p')
      note.className = 'wc-note'
      const missingServer = serverReachable === false && where !== 'local'
      note.textContent = missingServer ? t('generator.artifacts.unavailable') : t('generator.artifacts.empty')
      table.replaceChildren(header, note)
      return
    }
    // The terrains of the world held here first, then the largest.
    const groups = new Map<string, LevelRow[]>()
    for (const row of shown) groups.set(row.worldId, [...(groups.get(row.worldId) ?? []), row])
    const bytesOf = (list: LevelRow[]): number => list.reduce((n, row) => n + row.bytes, 0)
    const ordered = [...groups.entries()].sort(([ta, a], [tb, b]) => Number(held.has(tb)) - Number(held.has(ta)) || bytesOf(b) - bytesOf(a))
    table.replaceChildren(
      header,
      ...ordered.flatMap(([terrain, list]) => [renderGroup(terrain, list, held), ...list.map((row) => renderRow(row, world, held))]),
      ...(engines.length > 0 ? [renderEnginesGroup(engines), ...engines.map(renderEngineRow)] : []),
    )
  }

  // The group of the pipeline builds: its name and what they take.
  function renderEnginesGroup(list: ServerPipelineBuilds[]): HTMLElement {
    const line = document.createElement('div')
    line.className = 'ac-row ac-group'
    const title = document.createElement('span')
    title.className = 'ac-name'
    const name = document.createElement('span')
    name.className = 'ac-world'
    name.textContent = t('generator.artifacts.engines.group')
    title.appendChild(name)
    const size = document.createElement('span')
    size.className = 'ac-size mono'
    size.textContent = formatBytes(list.reduce((n, p) => n + p.bytes, 0))
    line.append(title, document.createElement('span'), document.createElement('span'), document.createElement('span'), size, document.createElement('span'), document.createElement('span'))
    return line
  }

  // One pipeline version's builds: its files, where, size, whether it is
  // this client's, and the operator's delete.
  function renderEngineRow(builds: ServerPipelineBuilds): HTMLElement {
    const line = document.createElement('div')
    line.className = 'ac-row ac-level-row'
    line.appendChild(document.createElement('span'))
    line.appendChild(pipelineCell(builds.pipelineVersion))
    const files = document.createElement('span')
    files.className = 'ac-tiles-count'
    files.textContent = t('generator.artifacts.engines.files', { count: builds.files.length.toLocaleString() })
    files.title = builds.files.join('\n')
    line.appendChild(files)
    const place = document.createElement('span')
    place.className = 'ac-where'
    place.appendChild(icon(SERVER_ICON))
    place.setAttribute('aria-label', t('generator.artifacts.where.server'))
    line.appendChild(place)
    const size = document.createElement('span')
    size.className = 'ac-size mono'
    size.textContent = formatBytes(builds.bytes)
    line.appendChild(size)
    const current = builds.pipelineVersion === WORLD_PIPELINE
    const state = document.createElement('span')
    state.className = 'ac-state'
    state.dataset.stale = String(!current)
    state.textContent = t(current ? 'generator.artifacts.state.fresh' : 'generator.artifacts.state.otherCode')
    line.appendChild(state)
    const actions = document.createElement('span')
    actions.className = 'ac-actions'
    actions.appendChild(removeButton(shortPipeline(builds.pipelineVersion), builds.actions?.includes('artifact.remove') ?? false, async () => {
      await removeServerPipelineBuilds(builds.pipelineVersion)
    }))
    line.appendChild(actions)
    return line
  }

  // A pipeline version, short, the whole in the tooltip.
  function pipelineCell(version: string): HTMLElement {
    const cell = document.createElement('span')
    cell.className = 'ac-id mono'
    cell.textContent = shortPipeline(version)
    cell.title = version
    return cell
  }

  // Deleting confirms in place, as a world does: the first click arms the
  // button, the second within a few seconds deletes, then the window loads
  // again. Greyed out where the server says the viewer may not.
  function removeButton(artifact: string, enabled: boolean, remove: () => Promise<void>): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'wc-remove'
    button.disabled = !enabled
    button.textContent = t('generator.artifacts.remove.label', { artifact })
    let armed: ReturnType<typeof setTimeout> | undefined
    button.addEventListener('click', () => {
      if (armed === undefined) {
        button.textContent = t('generator.artifacts.remove.confirm')
        button.classList.add('wc-remove--armed')
        armed = setTimeout(() => {
          armed = undefined
          button.textContent = t('generator.artifacts.remove.label', { artifact })
          button.classList.remove('wc-remove--armed')
        }, 4000)
        return
      }
      clearTimeout(armed)
      armed = undefined
      void (async () => {
        button.disabled = true
        await remove()
        await reload()
      })()
    })
    return button
  }

  function setValue(name: string, text: string): void {
    root.querySelector(`[data-value="${name}"]`)!.textContent = text
  }

  // A terrain's head: the name and seed of a world that holds it (the world
  // held here first; every one in the tooltip), and what its rows take
  // together.
  function renderGroup(terrain: string, list: LevelRow[], held: Set<string>): HTMLElement {
    const line = document.createElement('div')
    line.className = 'ac-row ac-group'
    const current = options.currentWorld()
    const uids = holders.get(terrain) ?? []
    const known = current && held.has(terrain) ? { name: current.name, seed: current.seed } : uids.map((uid) => worlds.get(uid)).find((w) => w !== undefined)
    const name = known?.name || list[0].label || '–'
    const title = document.createElement('span')
    title.className = 'ac-name'
    title.title = uids.map((uid) => worlds.get(uid)?.name || uid.slice(0, 8)).join(', ')
    const nameText = document.createElement('span')
    nameText.className = 'ac-world'
    nameText.textContent = known?.seed ? t('generator.artifacts.group', { world: name, seed: known.seed }) : name
    const id = document.createElement('span')
    id.className = 'ac-id mono'
    id.textContent = terrain.slice(0, 8)
    title.append(nameText, id)
    line.append(title, document.createElement('span'), document.createElement('span'), document.createElement('span'))
    const size = document.createElement('span')
    size.className = 'ac-size mono'
    size.textContent = formatBytes(list.reduce((n, row) => n + row.bytes, 0))
    line.append(size, document.createElement('span'), document.createElement('span'))
    return line
  }

  function renderRow(row: LevelRow, world: { uid: string; worldId: string | null } | null, held: Set<string>): HTMLElement {
    const line = document.createElement('div')
    line.className = 'ac-row ac-level-row'
    const levelName = `L${row.level}`

    // Which terrain: for the world held here, its last save's or an older
    // one; for any other, the terrain's id (which is current is not known
    // without opening it).
    const terrain = document.createElement('span')
    terrain.className = 'ac-id mono'
    terrain.textContent = world?.worldId && held.has(row.worldId)
      ? t(row.worldId === world.worldId ? 'generator.artifacts.terrain.current' : 'generator.artifacts.terrain.old')
      : row.worldId.slice(0, 8)
    terrain.title = row.worldId
    line.appendChild(terrain)
    line.appendChild(pipelineCell(row.pipelineVersion))

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
    state.dataset.older = String(row.stale === null && row.older)
    state.textContent = t(row.stale === 'otherTerrain' ? 'generator.artifacts.state.otherTerrain'
      : row.stale === 'otherCode' ? 'generator.artifacts.state.otherCode'
      : row.older ? 'generator.artifacts.state.worldPipeline'
      : 'generator.artifacts.state.fresh')
    line.appendChild(state)

    const remove = removeButton(levelName, row.deletable, async () => {
      if (row.where === 'server') await removeServerLevel(row.level, row.worldId, row.pipelineVersion)
      else {
        const store = await getLocalArtifactStore()
        for (const uid of row.localUids) await store.removeArtifact(uid)
      }
    })
    // An outdated level 1 on the server is ordered again from here (a job,
    // see the jobs window), for a world that holds the terrain: the world
    // held here, else the first the server names. Every reader of the world
    // may order (DEC-0039, fork 5); the server refuses the anonymous one. Only level 1: the button
    // orders level 1, and stale tiles have no rebuild here yet.
    const actions = document.createElement('span')
    actions.className = 'ac-actions'
    const orderFor = world && held.has(row.worldId) ? world.uid : holders.get(row.worldId)?.[0]
    if (row.where === 'server' && row.level === 1 && row.tiles === 0 && row.stale !== null && orderFor) {
      const rebuild = document.createElement('button')
      rebuild.type = 'button'
      rebuild.className = 'wc-remove'
      rebuild.textContent = t('generator.artifacts.rebuild.label', { artifact: levelName })
      rebuild.addEventListener('click', () => {
        rebuild.disabled = true
        void commissionBake(orderFor, 1, AMPLIFY_EROSION_ROUNDS).then((outcome) => {
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
      // Last in its host, so it covers the world list, which shares its layer
      // and may stay open below it.
      host.appendChild(root)
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
