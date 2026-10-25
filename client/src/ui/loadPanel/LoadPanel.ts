import { formatValue, t, type TKey } from '../../i18n/i18n'
import { formatWhen } from '../format'
import '../theme/design.css'
import './loadPanel.css'

// THE LOAD PANEL: what a screen shows while it opens a world (design canvas
// "Laden.dc.html", 2026-10-25). Opening a world takes seconds — the archive,
// the restore, the steps computed after it — and without it the screen looks
// still. The panel names the world and its source, shows the whole as a ring
// and the steps as a list: done, running, waiting. Only the running step
// carries a bar, so the list stays calm.
//
// The screen owns the steps: it says which there are, and marks each as it
// starts and ends. The panel only shows them. A step the load does not reach
// (a world without erosion has no hydrology) is dropped when the panel
// closes, not marked.
//
// Not in it yet, though the canvas draws them: the time left, the speed,
// "cancel" and "load in the background". No step here has a measure for a
// time left, and the generator's restore cannot be stopped once sent.

export interface LoadStep {
  id: string
  labelKey: TKey
  // The step's share of the ring, relative to the others (default 1).
  weight?: number
}

export interface LoadRequest {
  // The screen's name, on the tag in the head.
  screenKey: TKey
  name: string
  seed: string
  // Where the world comes from; null for a picked file.
  source: { where: 'server' | 'browser'; savedAt: string } | null
  steps: LoadStep[]
  // After a failure: back to the world list. The panel closes itself first.
  onBack?: () => void
}

export interface LoadPanel {
  open(request: LoadRequest): void
  isOpen(): boolean
  // Marks the step running, and every step before it done.
  start(id: string): void
  // `detail`: what the step found, at the row's end (a size).
  done(id: string, detail?: string): void
  // The running step's share done, 0..1; it fills the step's bar.
  progress(id: string, fraction: number): void
  // The step failed: the head says so, `detail` says why.
  fail(id: string, detail?: string): void
  close(): void
  relabel(): void
  dispose(): void
}

type StepState = 'waiting' | 'running' | 'done' | 'failed'

interface Row extends LoadStep {
  state: StepState
  detail: string
  fraction: number | null
}

// The ring's geometry, as the canvas draws it.
const RING_R = 44
const RING_LENGTH = 2 * Math.PI * RING_R

export function createLoadPanel(host: HTMLElement): LoadPanel {
  const root = document.createElement('div')
  root.className = 'load-backdrop design-light'
  root.hidden = true
  root.innerHTML = `
    <div class="load-panel" role="dialog" aria-modal="true">
      <div class="load-head">
        <div class="load-titles">
          <div class="load-tags">
            <span class="load-screen" data-value="screen"></span>
            <span class="load-seed" data-value="seed"></span>
          </div>
          <h2 class="load-title" data-value="title"></h2>
          <span class="load-source" data-value="source"></span>
        </div>
        <div class="load-ring" role="progressbar" aria-valuemin="0" aria-valuemax="100">
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle class="load-ring__track" cx="60" cy="60" r="${RING_R}"></circle>
            <circle class="load-ring__fill" cx="60" cy="60" r="${RING_R}" stroke-dasharray="${RING_LENGTH.toFixed(1)}" transform="rotate(-90 60 60)"></circle>
          </svg>
          <span class="load-percent" data-value="percent"></span>
        </div>
      </div>
      <p class="load-error" data-value="error" hidden></p>
      <ol class="load-steps" data-value="steps"></ol>
      <div class="load-foot" hidden>
        <button type="button" class="load-back" data-action="back"></button>
      </div>
    </div>
  `
  host.appendChild(root)

  const panel = root.querySelector<HTMLElement>('.load-panel')!
  const screen = root.querySelector<HTMLElement>('[data-value="screen"]')!
  const seed = root.querySelector<HTMLElement>('[data-value="seed"]')!
  const title = root.querySelector<HTMLElement>('[data-value="title"]')!
  const source = root.querySelector<HTMLElement>('[data-value="source"]')!
  const ring = root.querySelector<HTMLElement>('.load-ring')!
  const ringFill = root.querySelector<SVGCircleElement>('.load-ring__fill')!
  const percent = root.querySelector<HTMLElement>('[data-value="percent"]')!
  const error = root.querySelector<HTMLElement>('[data-value="error"]')!
  const list = root.querySelector<HTMLElement>('[data-value="steps"]')!
  const foot = root.querySelector<HTMLElement>('.load-foot')!
  const back = root.querySelector<HTMLButtonElement>('[data-action="back"]')!

  let request: LoadRequest | null = null
  let rows: Row[] = []
  let failed = false

  back.addEventListener('click', () => {
    const onBack = request?.onBack
    close()
    onBack?.()
  })

  function close(): void {
    request = null
    rows = []
    root.hidden = true
  }

  function render(): void {
    if (!request) return
    const world = request.name || request.seed
    screen.textContent = t(request.screenKey)
    seed.textContent = request.seed ? `${t('titlebar.seed')} ${request.seed}` : ''
    title.textContent = t(failed ? 'common.loading.failed' : 'common.loading.title', { world })
    panel.setAttribute('aria-label', title.textContent)
    source.textContent = request.source
      ? t(request.source.where === 'server' ? 'common.loading.source.server' : 'common.loading.source.browser', { when: formatWhen(request.source.savedAt) })
      : t('common.loading.source.file')
    back.textContent = t('common.loading.back')
    foot.hidden = !failed
    panel.classList.toggle('load-panel--failed', failed)

    // The ring: the done steps' weight, and the running one's share of its.
    let total = 0
    let reached = 0
    for (const row of rows) {
      const weight = row.weight ?? 1
      total += weight
      if (row.state === 'done') reached += weight
      else if (row.state === 'running' && row.fraction !== null) reached += weight * row.fraction
    }
    const share = total > 0 ? reached / total : 0
    ringFill.setAttribute('stroke-dashoffset', (RING_LENGTH * (1 - share)).toFixed(1))
    const shown = formatValue(Math.round(share * 100), 'common.unit.percent')
    percent.textContent = shown
    ring.setAttribute('aria-valuenow', String(Math.round(share * 100)))
    ring.setAttribute('aria-label', t('common.loading.aria', { percent: shown }))

    list.replaceChildren(...rows.map((row) => {
      const item = document.createElement('li')
      item.className = `load-step load-step--${row.state}`
      const mark = document.createElement('span')
      mark.className = 'load-step__mark'
      mark.setAttribute('aria-hidden', 'true')
      const body = document.createElement('span')
      body.className = 'load-step__body'
      const line = document.createElement('span')
      line.className = 'load-step__line'
      const label = document.createElement('span')
      label.className = 'load-step__label'
      label.textContent = t(row.labelKey)
      const detail = document.createElement('span')
      detail.className = 'load-step__detail'
      detail.textContent = row.detail
      line.append(label, detail)
      body.append(line)
      if (row.state === 'running') {
        // Indeterminate until the step says how far it is.
        const bar = document.createElement('span')
        bar.className = row.fraction === null ? 'load-step__bar load-step__bar--busy' : 'load-step__bar'
        const fill = document.createElement('span')
        if (row.fraction !== null) fill.style.width = `${(row.fraction * 100).toFixed(1)}%`
        bar.append(fill)
        body.append(bar)
      }
      item.append(mark, body)
      return item
    }))
  }

  const rowOf = (id: string): Row | undefined => rows.find((row) => row.id === id)

  return {
    open(next) {
      request = next
      rows = next.steps.map((step) => ({ ...step, state: 'waiting', detail: '', fraction: null }))
      failed = false
      error.hidden = true
      error.textContent = ''
      root.hidden = false
      render()
    },
    isOpen: () => !root.hidden,
    start(id) {
      const index = rows.findIndex((row) => row.id === id)
      if (index < 0 || failed) return
      for (let i = 0; i < index; i++) if (rows[i].state !== 'done') rows[i].state = 'done'
      rows[index].state = 'running'
      rows[index].fraction = null
      render()
    },
    done(id, detail) {
      const row = rowOf(id)
      if (!row || failed) return
      row.state = 'done'
      if (detail !== undefined) row.detail = detail
      render()
    },
    progress(id, fraction) {
      const row = rowOf(id)
      if (!row || row.state !== 'running') return
      row.fraction = Math.min(1, Math.max(0, fraction))
      render()
    },
    fail(id, detail) {
      const row = rowOf(id)
      if (!request) return
      if (row) row.state = 'failed'
      failed = true
      error.textContent = detail ?? ''
      error.hidden = !detail
      render()
      queueMicrotask(() => back.focus())
    },
    close,
    relabel: render,
    dispose() {
      close()
      root.remove()
    },
  }
}
