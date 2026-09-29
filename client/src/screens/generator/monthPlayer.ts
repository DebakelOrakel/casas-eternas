import { getLocale, t, type TKey } from '../../i18n/i18n'

// The month a step shows and its play button, as the climate and the ecology
// steps have them (2026-09-29): 0 is the year, 1..12 the months. Playing runs
// January to December and round again; stopping shows the year again. No
// slider: the months are watched, not picked. The markup is the step's; this
// drives it.
export interface MonthPlayer {
  // The month shown, 0..12.
  readonly month: number
  // Shows a month (the label with it) and tells the owner.
  show(month: number): void
  // Stops the months and shows the year.
  stop(): void
  // A disabled player stops and cannot be started.
  setEnabled(enabled: boolean): void
  // The label again, in the current language.
  relabel(): void
}

// How long each month stands while the months play.
const MONTH_STEP_MS = 800

export function createMonthPlayer(parts: { label: HTMLElement; button: HTMLButtonElement; onMonth: (month: number) => void }): MonthPlayer {
  const { label, button, onMonth } = parts
  let month = 0
  let timer: ReturnType<typeof setInterval> | null = null

  const say = (): void => {
    label.textContent = month === 0
      ? t('generator.climate.month.annual')
      : new Intl.DateTimeFormat(getLocale(), { month: 'long' }).format(new Date(2001, month - 1, 1))
  }
  // The button says what a press does; its key rides on data-t-aria so a
  // language switch finds it (i18n/relabel).
  const sayButton = (playing: boolean): void => {
    const key: TKey = playing ? 'generator.climate.play.labelActive' : 'generator.climate.play.label'
    button.dataset.tAria = key
    button.setAttribute('aria-label', t(key))
    button.setAttribute('aria-pressed', String(playing))
    button.querySelector('img')!.src = playing ? '/icons/stop.png' : '/icons/play.png'
  }
  const player: MonthPlayer = {
    get month() { return month },
    show(next) {
      month = next
      say()
      onMonth(next)
    },
    stop() {
      if (timer === null) return
      clearInterval(timer)
      timer = null
      sayButton(false)
      player.show(0)
    },
    setEnabled(enabled) {
      if (!enabled) player.stop()
      button.disabled = !enabled
    },
    relabel: say,
  }
  button.addEventListener('click', () => {
    if (timer !== null) { player.stop(); return }
    const advance = (): void => player.show(month % 12 + 1)
    advance()
    timer = setInterval(advance, MONTH_STEP_MS)
    sayButton(true)
  })
  say()
  return player
}
