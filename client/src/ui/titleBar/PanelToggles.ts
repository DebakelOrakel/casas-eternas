import { t, type TKey } from '../../i18n/i18n'

// THE PANELS' SWITCHES (2026-10-28), in the title bar beside the save
// state: one for each of a screen's panels (the step's actions, the
// overlays, the chronicle), each shown and hidden by itself. The screen
// says what a switch does; the switches keep whether each panel shows, per
// screen, in the browser (a viewer's convenience: without storage every
// panel shows).

export type PanelId = 'actions' | 'overlays' | 'chronicle'

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
    button.className = 'title-bar__tool panel-toggles__button'
    button.dataset.help = `common.panel.${id}`
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
      button.textContent = t(`common.panel.${id}.label` as TKey)
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
