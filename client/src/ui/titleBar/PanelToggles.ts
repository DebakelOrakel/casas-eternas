import { t, type TKey } from '../../i18n/i18n'

// THE PANELS' SWITCHES (2026-10-28), in the title bar beside the save
// state: one for each of a screen's panels (the step's actions, the
// overlays, the chronicle, the languages), each shown and hidden by itself.
// The screen says what a switch does; the switches keep whether each panel
// shows, per screen, in the browser (a viewer's convenience: without
// storage every panel shows but the languages, which start hidden: a
// column more beside the chronicle).

export type PanelId = 'actions' | 'overlays' | 'chronicle' | 'languages'

// Each switch's mark, a stroke on a 24 grid as the bar's other marks
// (TitleBar MENU_ICON): a window with its left column, layers stacked, a
// window with its right column; the languages panel's own mark (the design
// canvas's, Sprachen.dc.html).
const ICONS: Record<PanelId, string> = {
  actions: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  overlays: '<path d="M12 3 3 7.5l9 4.5 9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
  chronicle: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  languages: '<path d="M5 7h9M9 7v10M7 17h5"/><path d="M14 20l4-10 4 10M15.4 17h5.2"/>',
}
// Each switch's name, and the catalog base of its hover card (`.label`,
// `.help`).
const NAMES: Record<PanelId, TKey> = {
  actions: 'common.panel.actions.label',
  overlays: 'common.panel.overlays.label',
  chronicle: 'common.panel.chronicle.label',
  languages: 'common.panel.languages.label',
}
const HELP: Record<PanelId, string> = {
  actions: 'common.panel.actions',
  overlays: 'common.panel.overlays',
  chronicle: 'common.panel.chronicle',
  languages: 'common.panel.languages',
}
const SHOWN_FIRST: Record<PanelId, boolean> = { actions: true, overlays: true, chronicle: true, languages: false }

export interface PanelToggles {
  shown(id: PanelId): boolean
  relabel(): void
}

export function createPanelToggles(slot: HTMLElement, screen: string, panels: readonly PanelId[], onToggle: (id: PanelId, shown: boolean) => void): PanelToggles {
  const keyOf = (id: PanelId): string => `${screen}.panel.${id}.shown`
  const shown = new Map<PanelId, boolean>()
  for (const id of panels) {
    let on = SHOWN_FIRST[id]
    try {
      const kept = localStorage.getItem(keyOf(id))
      if (kept !== null) on = kept !== '0'
    } catch {
      // No storage: as it starts.
    }
    shown.set(id, on)
  }
  const group = document.createElement('div')
  group.className = 'panel-toggles'
  const buttons = panels.map((id) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'panel-toggles__button'
    button.dataset.help = HELP[id]
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
      button.setAttribute('aria-label', t(NAMES[id]))
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
