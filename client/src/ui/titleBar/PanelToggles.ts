import { t, type TKey } from '../../i18n/i18n'

// THE PANELS' SWITCHES (2026-10-28), in the title bar beside the save
// state: one for each of a screen's panels (the step's actions, the
// overlays, the chronicle), each shown and hidden by itself. The screen
// says what a switch does; the switches keep whether each panel shows, per
// screen, in the browser (a viewer's convenience: without storage every
// panel shows).

export type PanelId = 'actions' | 'overlays' | 'chronicle'

// Each switch's mark, a stroke on a 24 grid as the bar's other marks
// (TitleBar MENU_ICON): a window with its left column, layers stacked, a
// window with its right column.
const ICONS: Record<PanelId, string> = {
  actions: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  overlays: '<path d="M12 3 3 7.5l9 4.5 9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
  chronicle: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
}

export interface PanelToggles {
  shown(id: PanelId): boolean
  relabel(): void
}

export function createPanelToggles(slot: HTMLElement, screen: string, panels: readonly PanelId[], onToggle: (id: PanelId, shown: boolean) => void): PanelToggles {
  const keyOf = (id: PanelId): string => `${screen}.panel.${id}.shown`
  const shown = new Map<PanelId, boolean>()
  for (const id of panels) {
    let on = true
    try {
      on = localStorage.getItem(keyOf(id)) !== '0'
    } catch {
      // No storage: shown.
    }
    shown.set(id, on)
  }
  const group = document.createElement('div')
  group.className = 'panel-toggles'
  const buttons = panels.map((id) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'panel-toggles__button'
    button.dataset.help = `common.panel.${id}`
    button.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg>`
    button.addEventListener('click', () => {
      const on = !shown.get(id)
      shown.set(id, on)
      try {
        localStorage.setItem(keyOf(id), on ? '1' : '0')
      } catch {
        // Not kept: it stays so until the page closes.
      }
      say()
      onToggle(id, on)
    })
    group.append(button)
    return { id, button }
  })
  function say(): void {
    for (const { id, button } of buttons) {
      // The name for assistive technology; the hover card says it too.
      button.setAttribute('aria-label', t(`common.panel.${id}.label` as TKey))
      button.setAttribute('aria-pressed', String(shown.get(id)))
    }
  }
  say()
  slot.append(group)
  return {
    shown: (id) => shown.get(id) ?? false,
    relabel: say,
  }
}
