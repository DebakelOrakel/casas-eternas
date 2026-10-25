import { t, type TKey } from '../i18n/i18n'
import '../ui/theme/design.css'
import './cameraTools.css'

// THE GLOBE'S CAMERA BUTTONS, at the map's lower left (sphere worlds only;
// the flat map keeps its own keys): the view back to where it started
// (WorldView.resetCamera), the globe turning about its axis, and the look
// toward the horizon. The two toggles hold for the session and start off;
// the screen hands them to each new globe (spinning, tilted). Out of the
// generator screen since 2026-10-25, when the incubator came to show the
// same globe.

export interface CameraToolsOptions {
  reset(): void
  // A toggle changed: the screen passes it on to the globe it shows.
  spin(on: boolean): void
  tilt(on: boolean): void
}

export interface CameraTools {
  element: HTMLElement
  readonly spinning: boolean
  readonly tilted: boolean
  // Shown for a sphere world only.
  setVisible(visible: boolean): void
  relabel(): void
  dispose(): void
}

const HELP_KEYS = { reset: 'generator.camera.reset', spin: 'generator.camera.spin', tilt: 'generator.camera.tilt' } as const

export function createCameraTools(host: HTMLElement, options: CameraToolsOptions): CameraTools {
  const element = document.createElement('div')
  element.className = 'camera-tools design-light'
  element.hidden = true
  const tool = (key: keyof typeof HELP_KEYS, icon: string, onClick: () => void): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'camera-tool'
    button.setAttribute('aria-label', t(`${HELP_KEYS[key]}.label` as TKey))
    button.dataset.help = HELP_KEYS[key]
    button.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`
    button.addEventListener('click', onClick)
    element.appendChild(button)
    return button
  }
  let spinning = false
  let tilted = false
  const buttons = {
    reset: tool('reset', '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>', () => options.reset()),
    spin: tool('spin', '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 3v5h-5"/>', () => {
      spinning = !spinning
      buttons.spin.setAttribute('aria-pressed', String(spinning))
      options.spin(spinning)
    }),
    tilt: tool('tilt', '<path d="M8 8h8l5 11H3z"/><path d="M5.7 13h12.6"/>', () => {
      tilted = !tilted
      buttons.tilt.setAttribute('aria-pressed', String(tilted))
      options.tilt(tilted)
    }),
  }
  buttons.spin.setAttribute('aria-pressed', 'false')
  buttons.tilt.setAttribute('aria-pressed', 'false')
  host.appendChild(element)

  return {
    element,
    get spinning() {
      return spinning
    },
    get tilted() {
      return tilted
    },
    setVisible(visible) {
      element.hidden = !visible
    },
    relabel() {
      for (const key of Object.keys(HELP_KEYS) as (keyof typeof HELP_KEYS)[]) buttons[key].setAttribute('aria-label', t(`${HELP_KEYS[key]}.label` as TKey))
    },
    dispose() {
      element.remove()
    },
  }
}
