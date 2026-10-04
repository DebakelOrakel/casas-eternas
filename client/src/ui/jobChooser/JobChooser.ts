import { t, type TKey } from '../../i18n/i18n'
import { JOB_PHASE_KEYS } from './jobPhases'
import { formatClock, formatDuration, formatWhen } from '../../ui/format'
import { bakeFraction, cancelBake, jobStageName, listBakes, watchJobs, type BakeJob, type JobLevel } from '../../world/jobClient'
import { getServerStatus } from '../../server/serverStatus'
import { listWorlds } from '../../server/worldClient'
import { listBrowserWorlds } from '../../world/browserWorlds'
import { icon } from '../../ui/chooserIcons'
import '../../ui/theme/design.css'
import '../../ui/worldChooser/worldChooser.css'
import '../artifactChooser/artifactChooser.css'

// The jobs window: the fine simulation of the viewer's worlds on the server —
// what waits, runs, is done (the design canvas's "Jobliste", Main.dc.html),
// full screen like the artifacts, whose frame and table it shares.
//
// On top the whole: how far the running jobs are, when they will be done,
// how many workers are busy. Below, one GROUP per job — its world, what was
// ordered, cancel — and in it one ROW per level (2026-10-02): a refine plan
// is level 1 and then thousands of tiles of levels 2 and 3, and one bar for
// all of it said nothing. A level's row says what it waits for (the level
// before it, a free worker), its tiles done of all, and when it will end at
// the rate it is going.
//
// While open it follows the server's job events (watchJobs), and asks every
// two seconds where the stream is not to be had; the projected ends move on
// their own, so it repaints every few seconds besides. No pausing (decided
// 2026-09-29); a job is cancelled, and that confirms in place.

// The menu entry's icon, the same on every screen that offers the window.
export const JOBS_ICON = 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01'

export interface JobChooserOptions {
  // The world the screen holds, or null where there is none — what
  // "this world" filters by.
  currentWorld(): { uid: string } | null
  onClose(): void
}

type Scope = 'world' | 'all'
// Which jobs: those still queued or running, the last few ordered, or all.
type Show = 'running' | '3' | '10' | 'all'

export interface JobChooser {
  element: HTMLElement
  relabel(): void
  open(): void
  close(): void
  isOpen(): boolean
  dispose(): void
}

const POLL_MS = 2000
// How often the projected ends are worked out again without an event.
const REPAINT_MS = 5000


// What a level row says: its state, its share done, the line under its
// bar, and when it ends (projected while it runs).
interface LevelView {
  stage: number
  state: BakeJob['state']
  stateText: string
  fraction: number | null
  detail: string
  startedAt: string | null
  end: { at: number; projected: boolean } | null
  // Why it failed, as the worker says it: a tooltip on the state only —
  // the window says that it failed, the server log says why in full.
  error?: string
}

export function createJobChooser(host: HTMLElement, options: JobChooserOptions): JobChooser {
  const root = document.createElement('div')
  root.className = 'world-chooser artifact-chooser job-chooser design-light'
  root.hidden = true
  root.innerHTML = `
    <div class="wc-sheet ac-sheet">
      <div class="ac-head">
        <div class="wc-head">
          <h1 class="wc-title"></h1>
        </div>
        <button type="button" class="ac-close" data-act="close"></button>
      </div>
      <div class="ac-tiles">
        <div class="ac-tile"><span class="ac-tile__label" data-tile="progress"></span><span class="ac-tile__value mono" data-value="progress"></span><span class="ac-tile__hint"></span></div>
        <div class="ac-tile"><span class="ac-tile__label" data-tile="end"></span><span class="ac-tile__value mono" data-value="end"></span><span class="ac-tile__hint" data-hint="end"></span></div>
        <div class="ac-tile"><span class="ac-tile__label" data-tile="workers"></span><span class="ac-tile__value mono" data-value="workers"></span><span class="ac-tile__hint"></span></div>
      </div>
      <div class="wc-listhead ac-filters">
        <div class="wc-filter">
          <button type="button" data-scope="world"></button>
          <button type="button" data-scope="all"></button>
        </div>
        <div class="wc-filter">
          <button type="button" data-show="running"></button>
          <button type="button" data-show="3">3</button>
          <button type="button" data-show="10">10</button>
          <button type="button" data-show="all"></button>
        </div>
      </div>
      <div class="ac-table jc-table" data-slot="table"></div>
      <div class="ac-foot">
        <p class="wc-foot" data-slot="foot"></p>
      </div>
    </div>
  `
  const table = root.querySelector<HTMLElement>('[data-slot="table"]')!
  const closeButton = root.querySelector<HTMLButtonElement>('[data-act="close"]')!
  const tileValue = (name: string): HTMLElement => root.querySelector<HTMLElement>(`[data-value="${name}"]`)!
  closeButton.appendChild(icon('<path d="M6 6l12 12M18 6L6 18"/>'))
  closeButton.addEventListener('click', () => options.onClose())
  root.addEventListener('keydown', (event) => { if (event.key === 'Escape') options.onClose() })

  // --- filters ----------------------------------------------------------------

  let scope: Scope = 'world'
  let show: Show = '10'
  const scopeButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-scope]')]
  const showButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-show]')]
  for (const button of scopeButtons) button.addEventListener('click', () => { scope = button.dataset.scope as Scope; paint() })
  for (const button of showButtons) button.addEventListener('click', () => { show = button.dataset.show as Show; paint() })

  let jobs: BakeJob[] | null = []
  let worldNames = new Map<string, string>()
  let workers = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let repaintTimer: ReturnType<typeof setInterval> | null = null
  let unwatch: (() => void) | null = null
  // Rows armed for cancelling survive a repaint: the list is redrawn as
  // events arrive, and a confirmation that vanished with it would never land.
  const armed = new Map<string, ReturnType<typeof setTimeout>>()

  async function loadNames(): Promise<void> {
    const [browserWorlds, serverWorlds, status] = await Promise.all([listBrowserWorlds(), listWorlds(), getServerStatus()])
    worldNames = new Map([...browserWorlds.map((w) => [w.uid, w.name] as const), ...(serverWorlds ?? []).map((w) => [w.uid, w.name] as const)])
    workers = status.jobWorkers
  }

  // Each reload is numbered; an answer lands only if no later reload was
  // asked meanwhile. With a slow server the polls overlap, and an older
  // answer painted over a newer one showed jobs going back a state.
  let reloadSeq = 0
  async function reload(): Promise<void> {
    const seq = ++reloadSeq
    const listed = await listBakes()
    if (seq !== reloadSeq) return
    jobs = listed
    paint()
  }

  // One job changed, as the event stream sends it: in place, or on top when
  // it is new (the list is newest first).
  function apply(job: BakeJob): void {
    if (!jobs) return
    const index = jobs.findIndex((j) => j.id === job.id)
    if (index >= 0) jobs[index] = job
    else jobs.unshift(job)
    paint()
  }

  function paintStatic(): void {
    root.querySelector('.wc-title')!.textContent = t('generator.jobs.title')
    for (const button of scopeButtons) button.textContent = t(`generator.jobs.scope.${button.dataset.scope}` as TKey)
    for (const button of showButtons) {
      const which = button.dataset.show
      if (which === 'running' || which === 'all') button.textContent = t(`generator.jobs.show.${which}` as TKey)
      else {
        const label = t('generator.jobs.show.last', { count: Number(which) })
        button.title = label
        button.setAttribute('aria-label', label)
      }
    }
    root.querySelector('[data-tile="progress"]')!.textContent = t('generator.jobs.summary.progress')
    root.querySelector('[data-tile="end"]')!.textContent = t('generator.jobs.summary.end')
    root.querySelector('[data-tile="workers"]')!.textContent = t('generator.jobs.summary.workers')
    root.querySelector('[data-slot="foot"]')!.textContent = t('generator.jobs.foot')
    closeButton.setAttribute('aria-label', t('common.action.close.label'))
  }

  // --- what a job's levels say ----------------------------------------------

  // A job's levels as rows: the levels the server counted, and for a plan
  // the levels it will reach that have no tasks yet (they are planned when
  // level 1 is done).
  function levelsOf(job: BakeJob, now: number): LevelView[] {
    // A job from a server that does not count levels (older than
    // 2026-10-02) has no rows: its group row says all there is.
    if (!job.levels) return []
    const counted = job.levels
    const first = counted.length > 0 ? Math.min(...counted.map((l) => l.stage)) : (job.request?.plan === 'refine' ? 1 : (job.request?.stage ?? 1))
    const top = job.request?.plan === 'refine' ? job.request.stage : Math.max(first, ...counted.map((l) => l.stage))
    const views: LevelView[] = []
    for (let stage = first; stage <= top; stage++) {
      const level = counted.find((l) => l.stage === stage)
      const before = views[views.length - 1]
      views.push(level ? levelView(job, level, before, now) : plannedView(job, stage, before))
    }
    return views
  }

  // A level not planned yet: it waits for the one before it.
  function plannedView(job: BakeJob, stage: number, before: LevelView | undefined): LevelView {
    const ended = job.state === 'cancelled' || job.state === 'failed'
    return {
      stage,
      state: ended ? job.state : 'queued',
      stateText: ended ? t(`generator.jobs.state.${job.state}` as TKey) : before ? t('generator.jobs.level.waitingFor', { level: before.stage }) : t('generator.jobs.state.queued'),
      fraction: null,
      detail: '',
      startedAt: null,
      end: null,
    }
  }

  function levelView(job: BakeJob, level: JobLevel, before: LevelView | undefined, now: number): LevelView {
    const tiles = level.stage >= 2
    const left = level.waiting + level.queued + level.running
    // Its share done: tiles by count, a whole level by its phase.
    const fraction = left === 0 && level.done === level.total ? 1
      : tiles ? level.done / Math.max(1, level.total)
      : level.running > 0 ? (bakeFraction({ ...job, phase: level.phase, percent: level.percent, request: job.request ? { ...job.request, scope: { kind: 'world' } } : undefined }) ?? 0)
      : 0
    let state: BakeJob['state']
    let stateText: string
    if (level.failed > 0 && left === 0) {
      state = 'failed'
      stateText = t('generator.jobs.state.failed')
    } else if (left === 0 && level.done === level.total) {
      state = 'done'
      stateText = t('generator.jobs.state.done')
    } else if (job.state === 'cancelled' || job.state === 'failed') {
      state = job.state
      stateText = t(`generator.jobs.state.${job.state}` as TKey)
    } else if (level.running > 0 || level.startedAt) {
      // Once a level has started it runs until it ends, also in the moment
      // between one tile's end and the next tile's first report — that
      // moment showed "waiting for a worker" and dropped the projected end
      // (2026-10-02).
      state = 'running'
      stateText = t('generator.jobs.state.running')
    } else if (level.queued > 0) {
      state = 'queued'
      stateText = t('generator.jobs.level.waitingWorker')
    } else {
      state = 'queued'
      stateText = before && before.state !== 'done' ? t('generator.jobs.level.waitingFor', { level: before.stage }) : t('generator.jobs.state.queued')
    }
    const parts: string[] = []
    if (tiles) parts.push(t('generator.jobs.level.tiles', { done: level.done, total: level.total, running: level.running }))
    else if (level.running > 0 && level.phase && JOB_PHASE_KEYS[level.phase]) parts.push(t(JOB_PHASE_KEYS[level.phase]))
    if (level.failed > 0 && tiles) parts.push(t('generator.jobs.level.failed', { failed: level.failed }))
    // The end: when it ended, or — while it runs — where the rate so far
    // puts it. No projection before the first share is done.
    let end: LevelView['end'] = null
    if (level.endedAt) end = { at: Date.parse(level.endedAt), projected: false }
    else if (state === 'running' && level.startedAt && fraction > 0.005) {
      const started = Date.parse(level.startedAt)
      end = { at: started + (now - started) / fraction, projected: true }
    }
    return { stage: level.stage, state, stateText, fraction, detail: parts.join(' · '), startedAt: level.startedAt ?? null, end, error: level.failed > 0 ? level.error : undefined }
  }

  // A job's end, and how far it reaches: every level's own end where it has
  // one, else the time that level took in the world's last finished job
  // (each level from the end of the one before it, so tile levels that
  // overlap count once). Where neither is known the reckoning stops, and
  // `until` says the level it reached; null `until` is the whole job.
  function jobEnd(job: BakeJob, views: LevelView[], now: number): { at: number; until: number | null } | null {
    if (views.length === 0) return null
    const reference = referenceOf(job)
    let at = now
    let reached: LevelView | null = null
    for (const v of views) {
      if (v.end) at = Math.max(at, v.end.at)
      else {
        const took = reference?.get(v.stage)
        // Partial only up to a level still running: up to one already done
        // the reckoning would end now, and the share read 100 %.
        if (took === undefined) return reached === null || reached.state === 'done' ? null : { at, until: reached.stage }
        at += took
      }
      reached = v
    }
    return { at, until: null }
  }

  // The last finished job of the same world and plan with level times: how
  // long each level took after the one before it ended.
  function referenceOf(job: BakeJob): Map<number, number> | null {
    const uid = job.request?.worldUid
    const done = (jobs ?? []).find((j) => j !== job && j.state === 'done' && j.request?.worldUid === uid && j.request?.plan === job.request?.plan
      && (j.levels ?? []).length > 0 && j.levels!.every((l) => l.startedAt && l.endedAt))
    if (!done) return null
    const out = new Map<number, number>()
    let before: number | null = null
    for (const l of [...done.levels!].sort((a, b) => a.stage - b.stage)) {
      const end = Date.parse(l.endedAt!)
      out.set(l.stage, end - (before ?? Date.parse(l.startedAt!)))
      before = end
    }
    return out
  }

  // --- painting --------------------------------------------------------------

  function paint(): void {
    const now = Date.now()
    const header = document.createElement('div')
    header.className = 'ac-row ac-row--head mono'
    for (const column of ['world', 'level', 'state', 'progress', 'started']) {
      const cell = document.createElement('span')
      cell.textContent = t(`generator.jobs.col.${column}` as TKey)
      header.appendChild(cell)
    }
    header.appendChild(document.createElement('span'))
    paintSummary(now)
    // "This world" needs a world; before there is one, all of them.
    const world = options.currentWorld()
    const effectiveScope: Scope = world ? scope : 'all'
    scopeButtons[0].disabled = !world
    for (const button of scopeButtons) button.setAttribute('aria-pressed', String(button.dataset.scope === effectiveScope))
    for (const button of showButtons) button.setAttribute('aria-pressed', String(button.dataset.show === show))
    // The list is newest first, so "the last n" is its head.
    const inScope = (jobs ?? []).filter((job) => effectiveScope === 'all' || job.request?.worldUid === world?.uid)
    const shown = show === 'running' ? inScope.filter((job) => job.state === 'queued' || job.state === 'running')
      : show === 'all' ? inScope
      : inScope.slice(0, Number(show))
    if (!jobs || shown.length === 0) {
      const note = document.createElement('p')
      note.className = 'wc-note'
      note.textContent = jobs === null ? t('generator.jobs.unavailable') : t('generator.jobs.empty')
      table.replaceChildren(header, note)
      return
    }
    table.replaceChildren(header, ...shown.flatMap((job) => renderJob(job, now)))
  }

  // The tiles on top: the running jobs' time spent of their projected
  // whole, when the last of them ends, how many workers work.
  function paintSummary(now: number): void {
    const active = (jobs ?? []).filter((j) => j.state === 'queued' || j.state === 'running')
    let spent = 0
    let span = 0
    let last = 0
    let unknown = false
    let until: number | null = null
    let busy = 0
    for (const job of active) {
      busy += (job.levels ?? []).reduce((n, l) => n + l.running, 0)
      const end = jobEnd(job, levelsOf(job, now), now)
      const started = job.startedAt ? Date.parse(job.startedAt) : NaN
      if (end === null || Number.isNaN(started)) {
        unknown = true
        continue
      }
      spent += now - started
      span += end.at - started
      last = Math.max(last, end.at)
      if (end.until !== null) until = until === null ? end.until : Math.min(until, end.until)
    }
    const known = active.length > 0 && !unknown && last > 0
    // Down, and short of 100 while anything runs: rounded, the last half
    // per cent read as done before it was.
    tileValue('progress').textContent = known && span > 0 ? `${Math.min(99, Math.floor((100 * spent) / span))} %` : '–'
    tileValue('end').textContent = known ? formatClock(new Date(last)) : '–'
    root.querySelector('[data-hint="end"]')!.textContent = !known ? ''
      : until !== null ? t('generator.jobs.summary.partial', { level: until })
      : t('generator.jobs.summary.endIn', { duration: formatDuration(last - now) })
    tileValue('workers').textContent = workers > 0 ? t('generator.jobs.summary.workersBusy', { busy, all: workers }) : String(busy)
  }

  // A job: a row per level (2026-10-02 — a head row of its own stood mostly
  // empty). The first row names the world and what was ordered and holds
  // cancel; the rows below it belong to the same job. A job without level
  // rows (an older server) is one row with its own bar.
  function renderJob(job: BakeJob, now: number): HTMLElement[] {
    const views = levelsOf(job, now)
    const uid = job.request?.worldUid ?? ''
    const worldCell = (): HTMLElement => {
      const world = document.createElement('span')
      world.className = 'ac-name'
      const name = document.createElement('span')
      name.className = 'ac-world'
      name.textContent = worldNames.get(uid) || uid || '–'
      const ordered = document.createElement('span')
      ordered.className = 'ac-id'
      ordered.textContent = job.request?.plan === 'refine'
        ? t('generator.jobs.plan', { stage: job.request.stage, time: job.queuedAt ? formatClock(job.queuedAt) : '' })
        : jobStageName(job)
      world.append(name, ordered)
      return world
    }
    const stateCell = (state: BakeJob['state'], text: string, title?: string): HTMLElement => {
      const cell = document.createElement('span')
      cell.className = 'ac-state jc-state'
      cell.dataset.state = state
      cell.textContent = text
      if (title) cell.title = title
      return cell
    }

    if (views.length === 0) {
      const line = document.createElement('div')
      line.className = 'ac-row jc-level'
      const ended = job.endedAt && job.state !== 'queued' && job.state !== 'running' ? { at: Date.parse(job.endedAt), projected: false } : null
      line.append(
        worldCell(),
        document.createElement('span'),
        stateCell(job.state, t(`generator.jobs.state.${job.state}` as TKey), job.error),
        progressCell(job.state === 'done' ? 1 : (bakeFraction(job) ?? null), '', job.state === 'done'),
        timeCell(job.startedAt ?? job.queuedAt ?? null, ended),
        cancelCell(job),
      )
      return [line]
    }

    return views.map((view, i) => {
      const line = document.createElement('div')
      line.className = 'ac-row jc-level'
      // The rows of one job read as one: no line between them.
      if (i < views.length - 1) line.classList.add('jc-level--inner')
      line.appendChild(i === 0 ? worldCell() : document.createElement('span'))
      const level = document.createElement('span')
      level.className = 'ac-levels'
      const chip = document.createElement('span')
      chip.className = 'ac-level mono'
      chip.dataset.present = String(view.state === 'done')
      chip.textContent = `L${view.stage}`
      level.appendChild(chip)
      line.appendChild(level)
      line.appendChild(stateCell(view.state, view.stateText, view.error))
      line.appendChild(progressCell(view.fraction, view.detail, view.state === 'done'))
      line.appendChild(timeCell(view.startedAt, view.end))
      line.appendChild(i === 0 ? cancelCell(job) : document.createElement('span'))
      return line
    })
  }

  // A bar with its percent, and a line under it.
  // The percent rounded DOWN and held at 99 until `complete`: rounded to
  // nearest, the last half per cent of a level read as 100 before it ended.
  function progressCell(fraction: number | null, detail: string, complete: boolean): HTMLElement {
    const cell = document.createElement('span')
    cell.className = 'jc-cell'
    if (fraction !== null) {
      const bar = document.createElement('span')
      bar.className = 'jc-progress'
      const track = document.createElement('span')
      track.className = 'jc-track'
      const fill = document.createElement('span')
      fill.className = 'jc-fill'
      const shown = complete ? 100 : Math.min(99, Math.floor(fraction * 100))
      fill.style.width = `${shown}%`
      track.appendChild(fill)
      const percent = document.createElement('span')
      percent.className = 'mono'
      percent.textContent = `${shown} %`
      bar.append(track, percent)
      cell.appendChild(bar)
    }
    if (detail) {
      const under = document.createElement('span')
      under.className = 'jc-detail'
      under.textContent = detail
      under.title = detail
      cell.appendChild(under)
    }
    return cell
  }

  // When it started, and under it its end: projected while it runs, its
  // duration once ended.
  function timeCell(started: string | null, end: LevelView['end']): HTMLElement {
    const cell = document.createElement('span')
    cell.className = 'jc-cell'
    const begin = document.createElement('span')
    begin.className = 'ac-size'
    begin.textContent = started ? formatClock(started) : '–'
    if (started) begin.title = formatWhen(started)
    cell.appendChild(begin)
    if (end) {
      const under = document.createElement('span')
      under.className = 'jc-detail'
      under.textContent = end.projected
        ? t('generator.jobs.end.estimate', { time: formatClock(new Date(end.at)) })
        : started ? t('generator.jobs.end.took', { duration: formatDuration(end.at - Date.parse(started)) }) : ''
      cell.appendChild(under)
    }
    return cell
  }

  // Cancel, armed first as a delete is. Greyed out where the viewer may
  // not (below editor), and gone once the job has ended.
  function cancelCell(job: BakeJob): HTMLElement {
    const cell = document.createElement('span')
    if (job.state !== 'queued' && job.state !== 'running') return cell
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'wc-remove'
    const allowed = job.callerLevel === 'editor' || job.callerLevel === 'owner' || job.callerLevel === 'admin'
    cancel.disabled = !allowed
    const isArmed = armed.has(job.id)
    cancel.textContent = t(isArmed ? 'generator.jobs.cancel.confirm' : 'generator.jobs.cancel.label')
    cancel.classList.toggle('wc-remove--armed', isArmed)
    cancel.addEventListener('click', () => {
      const pending = armed.get(job.id)
      if (pending === undefined) {
        armed.set(job.id, setTimeout(() => { armed.delete(job.id); paint() }, 4000))
        paint()
        return
      }
      clearTimeout(pending)
      armed.delete(job.id)
      cancel.disabled = true
      void cancelBake(job.id).then(reload)
    })
    cell.appendChild(cancel)
    return cell
  }

  function stopPolling(): void {
    if (timer !== null) clearInterval(timer)
    timer = null
    if (repaintTimer !== null) clearInterval(repaintTimer)
    repaintTimer = null
    unwatch?.()
    unwatch = null
  }

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
      void loadNames().then(reload)
      stopPolling()
      repaintTimer = setInterval(() => paint(), REPAINT_MS)
      unwatch = watchJobs(apply, () => {
        unwatch = null
        if (!root.hidden) timer = setInterval(() => void reload(), POLL_MS)
      })
    },
    close() {
      root.hidden = true
      stopPolling()
    },
    isOpen: () => !root.hidden,
    dispose() {
      stopPolling()
      for (const pending of armed.values()) clearTimeout(pending)
      root.remove()
    },
  }
}
