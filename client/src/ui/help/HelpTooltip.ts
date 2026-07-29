import { t, type TKey } from '../../i18n/i18n'
import { createFloatingCard } from '../tooltip/floatingCard'

export interface HelpTooltip {
  dispose(): void
}

// Delegated control-help tooltip. Any element under `root` carrying
// `data-help="<key base>"` shows a white card with `t(base + '.label')` (bold)
// over `t(base + '.help')` when the pointer rests on it (or it gains keyboard
// focus). One listener on the root, so it also covers elements added later —
// no per-element registration. Replaces the native `title` on those elements.
//
// Content comes from the i18n catalog (see docs/decisions/localization.md); the
// card look/positioning is the shared floatingCard.
export function createHelpTooltip(root: HTMLElement): HelpTooltip {
  const card = createFloatingCard(document.body, 'tooltip-card--help')
  const DELAY_MS = 250
  let timer: number | undefined
  let current: HTMLElement | null = null

  // Walk up from the event target to the nearest [data-help] within root.
  function anchorFor(target: EventTarget | null): { el: HTMLElement; base: string } | null {
    let el = target instanceof HTMLElement ? target : null
    while (el && el !== root) {
      const base = el.dataset.help
      if (base) return { el, base }
      el = el.parentElement
    }
    return null
  }

  function fill(base: string): void {
    card.el.textContent = ''
    const label = document.createElement('div')
    label.textContent = t(`${base}.label` as TKey)
    card.el.appendChild(label)
    const helpText = t(`${base}.help` as TKey)
    // t() returns the key itself when a string is missing — then show label only.
    if (helpText && helpText !== `${base}.help`) {
      const help = document.createElement('div')
      help.textContent = helpText
      card.el.appendChild(help)
    }
  }

  function cancelTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  function hide(): void {
    cancelTimer()
    card.hide()
    current = null
  }

  function schedule(el: HTMLElement, base: string): void {
    cancelTimer()
    current = el
    timer = window.setTimeout(() => {
      fill(base)
      card.showAtRect(el.getBoundingClientRect())
    }, DELAY_MS)
  }

  const onOver = (e: PointerEvent): void => {
    const hit = anchorFor(e.target)
    if (!hit) {
      if (current) hide()
      return
    }
    if (hit.el !== current) schedule(hit.el, hit.base)
  }

  const onOut = (e: PointerEvent): void => {
    // Hide only when leaving the current anchor for something outside it.
    if (current && e.target === current && !current.contains(e.relatedTarget as Node | null)) hide()
  }

  const onFocusIn = (e: FocusEvent): void => {
    const hit = anchorFor(e.target)
    if (hit) schedule(hit.el, hit.base)
  }

  // Any click/scroll dismisses — a stale card over a changed layout is worse than none.
  const onDismiss = (): void => hide()

  root.addEventListener('pointerover', onOver)
  root.addEventListener('pointerout', onOut)
  root.addEventListener('focusin', onFocusIn)
  root.addEventListener('focusout', onDismiss)
  root.addEventListener('pointerdown', onDismiss, true)
  window.addEventListener('scroll', onDismiss, true)

  return {
    dispose(): void {
      hide()
      root.removeEventListener('pointerover', onOver)
      root.removeEventListener('pointerout', onOut)
      root.removeEventListener('focusin', onFocusIn)
      root.removeEventListener('focusout', onDismiss)
      root.removeEventListener('pointerdown', onDismiss, true)
      window.removeEventListener('scroll', onDismiss, true)
      card.dispose()
    },
  }
}
