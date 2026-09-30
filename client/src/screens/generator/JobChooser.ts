import { t, type TKey } from '../../i18n/i18n'
import { formatWhen } from '../../ui/format'
import { bakeFraction, cancelBake, jobStageName, listBakes, type BakeJob } from '../../world/jobClient'
import { listWorlds } from '../../server/worldClient'
import { listBrowserWorlds } from '../../world/browserWorlds'
import { icon } from './chooserIcons'
import '../../ui/theme/design.css'
import './worldChooser.css'
import './artifactChooser.css'

// The jobs window: the fine simulation of the viewer's worlds on the server —
// what waits, runs, is done (the design canvas's "Jobliste", Main.dc.html),
// full screen like the artifacts, whose frame and table it shares. One row
// per job: a level of a world. It asks the server again every two seconds
// while it is open. No pausing (decided 2026-09-29); a job is cancelled, and
// that confirms in place.

export interface JobChooserOptions {
  onClose(): void
}

export interface JobChooser {
  element: HTMLElement
  relabel(): void
  open(): void
  close(): void
  isOpen(): boolean
  dispose(): void
}

const POLL_MS = 2000

export function createJobChooser(host: HTMLElement, options: JobChooserOptions): JobChooser {
  const root = document.createElement('div')
  root.className = 'world-chooser artifact-chooser job-chooser design-light'
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
      <div class="ac-table jc-table" data-slot="table"></div>
      <div class="ac-foot">
        <p class="wc-foot" data-slot="foot"></p>
      </div>
    </div>
  `
  const table = root.querySelector<HTMLElement>('[data-slot="table"]')!
  const closeButton = root.querySelector<HTMLButtonElement>('[data-act="close"]')!
  closeButton.appendChild(icon('<path d="M6 6l12 12M18 6L6 18"/>'))
  closeButton.addEventListener('click', () => options.onClose())
  root.addEventListener('keydown', (event) => { if (event.key === 'Escape') options.onClose() })

  let jobs: BakeJob[] | null = []
  let worldNames = new Map<string, string>()
  let timer: ReturnType<typeof setInterval> | null = null
  // Rows armed for cancelling survive a repaint: the list is redrawn every
  // two seconds, and a confirmation that vanished with it would never land.
  const armed = new Map<string, ReturnType<typeof setTimeout>>()

  async function loadNames(): Promise<void> {
    const [browserWorlds, serverWorlds] = await Promise.all([listBrowserWorlds(), listWorlds()])
    worldNames = new Map([...browserWorlds.map((w) => [w.uid, w.name] as const), ...(serverWorlds ?? []).map((w) => [w.uid, w.name] as const)])
  }

  async function reload(): Promise<void> {
    jobs = await listBakes()
    paint()
  }

  function paintStatic(): void {
    root.querySelector('.wc-title')!.textContent = t('generator.jobs.title')
    root.querySelector('.wc-subtitle')!.textContent = t('generator.jobs.subtitle')
    root.querySelector('[data-slot="foot"]')!.textContent = t('generator.jobs.foot')
    closeButton.setAttribute('aria-label', t('common.action.close.label'))
  }

  function paint(): void {
    const header = document.createElement('div')
    header.className = 'ac-row ac-row--head mono'
    for (const column of ['world', 'level', 'state', 'progress', 'started']) {
      const cell = document.createElement('span')
      cell.textContent = t(`generator.jobs.col.${column}` as TKey)
      header.appendChild(cell)
    }
    header.appendChild(document.createElement('span'))
    if (!jobs || jobs.length === 0) {
      const note = document.createElement('p')
      note.className = 'wc-note'
      note.textContent = jobs === null ? t('generator.jobs.unavailable') : t('generator.jobs.empty')
      table.replaceChildren(header, note)
      return
    }
    table.replaceChildren(header, ...jobs.map(renderRow))
  }

  function renderRow(job: BakeJob): HTMLElement {
    const line = document.createElement('div')
    line.className = 'ac-row'
    const uid = job.request?.worldUid ?? ''

    const world = document.createElement('span')
    world.className = 'ac-world'
    world.textContent = worldNames.get(uid) || uid || '–'
    line.appendChild(world)

    const level = document.createElement('span')
    level.className = 'ac-level mono'
    level.dataset.present = String(job.state === 'done')
    level.textContent = jobStageName(job)
    const levelCell = document.createElement('span')
    levelCell.className = 'ac-levels'
    levelCell.appendChild(level)
    line.appendChild(levelCell)

    const state = document.createElement('span')
    state.className = 'ac-state jc-state'
    state.dataset.state = job.state
    state.textContent = t(`generator.jobs.state.${job.state}` as TKey)
    if (job.error) state.title = job.error
    line.appendChild(state)

    // The fraction over the whole job, not the phase's own percent.
    const progress = document.createElement('span')
    progress.className = 'jc-progress'
    const fraction = job.state === 'done' ? 1 : job.state === 'running' ? bakeFraction(job) : undefined
    if (fraction !== undefined) {
      const track = document.createElement('span')
      track.className = 'jc-track'
      const fill = document.createElement('span')
      fill.className = 'jc-fill'
      fill.style.width = `${Math.round(fraction * 100)}%`
      track.appendChild(fill)
      const value = document.createElement('span')
      value.className = 'mono'
      value.textContent = `${Math.round(fraction * 100)} %`
      progress.append(track, value)
    }
    line.appendChild(progress)

    const started = document.createElement('span')
    started.className = 'ac-size'
    const when = job.startedAt ?? job.queuedAt
    started.textContent = when ? formatWhen(when) : '–'
    line.appendChild(started)

    // Cancel, armed first as a delete is. Greyed out where the viewer may
    // not (below editor), and gone once the job has ended.
    const cell = document.createElement('span')
    if (job.state === 'queued' || job.state === 'running') {
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
    }
    line.appendChild(cell)
    return line
  }

  function stopPolling(): void {
    if (timer !== null) clearInterval(timer)
    timer = null
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
      timer = setInterval(() => void reload(), POLL_MS)
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
