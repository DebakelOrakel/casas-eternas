import type { KnowledgeRamp } from '../../map/mapPresentation'
import './knowledgeDebug.css'

// Tuning controls for the watercolour map's knowledge registers — stage A of
// docs/design/watercolor-map.md, whose entire purpose is deciding where the
// three bands sit and how strong the pale wash is. Nobody guesses those from a
// constant file; they get dragged.
//
// DEBUG-ONLY AND BUILT TO BE DELETED, which is why its labels are hardcoded
// English rather than catalog keys: a key is a documentation anchor, and
// minting anchors for something temporary is the cost the i18n rule exists to
// avoid. When the values are frozen, this file and its stylesheet go, and
// whatever the PLAYER gets is a different, much smaller thing in different
// words — see the doc's "Player settings are not the tuning knobs".

export interface KnowledgeDebugPanelOptions {
  // Mutated in place by the sliders; the callback fires after every change.
  ramp: KnowledgeRamp
  onRampChange: () => void
  onSeed: () => void
  onClear: () => void
  onReveal: () => void
  // Brush mode takes the pointer away from the camera's pan.
  onBrushToggle: (active: boolean) => void
}

export interface KnowledgeDebugPanel {
  isBrushActive(): boolean
  // Brush radius as a fraction of world width.
  brushRadius(): number
  dispose(): void
}

export function createKnowledgeDebugPanel(host: HTMLElement, options: KnowledgeDebugPanelOptions): KnowledgeDebugPanel {
  const { ramp, onRampChange, onSeed, onClear, onReveal, onBrushToggle } = options
  let brushActive = false

  const root = document.createElement('div')
  root.className = 'knowledge-debug'
  root.innerHTML = `
    <span class="knowledge-debug__title">knowledge (debug)</span>
    <button type="button" data-action="brush">brush: off</button>
    <label>radius <input type="range" data-knob="radius" min="0.01" max="0.25" step="0.005" value="0.06" /></label>
    <label>wash <input type="range" data-knob="exploredPigment" min="0" max="1" step="0.01" /></label>
    <label>wash at k <input type="range" data-knob="exploredAt" min="0.05" max="0.95" step="0.01" /></label>
    <label>active from <input type="range" data-knob="activeFrom" min="0.05" max="0.99" step="0.01" /></label>
    <button type="button" data-action="seed">reseed</button>
    <button type="button" data-action="clear">clear</button>
    <button type="button" data-action="reveal">reveal all</button>
  `
  host.appendChild(root)

  const knob = (name: string): HTMLInputElement => root.querySelector<HTMLInputElement>(`[data-knob="${name}"]`)!
  knob('exploredPigment').value = String(ramp.exploredPigment)
  knob('exploredAt').value = String(ramp.exploredAt)
  knob('activeFrom').value = String(ramp.activeFrom)

  const onInput = (event: Event): void => {
    const input = event.target as HTMLInputElement
    const name = input.dataset.knob
    if (!name || name === 'radius') return
    ramp[name as keyof KnowledgeRamp] = Number(input.value)
    onRampChange()
  }
  root.addEventListener('input', onInput)

  const brushButton = root.querySelector<HTMLButtonElement>('[data-action="brush"]')!
  const onClick = (event: Event): void => {
    const action = (event.target as HTMLElement).closest('button')?.dataset.action
    if (action === 'brush') {
      brushActive = !brushActive
      brushButton.textContent = `brush: ${brushActive ? 'on' : 'off'}`
      brushButton.classList.toggle('is-on', brushActive)
      onBrushToggle(brushActive)
    } else if (action === 'seed') onSeed()
    else if (action === 'clear') onClear()
    else if (action === 'reveal') onReveal()
  }
  root.addEventListener('click', onClick)

  return {
    isBrushActive: () => brushActive,
    brushRadius: () => Number(knob('radius').value),
    dispose(): void {
      root.removeEventListener('input', onInput)
      root.removeEventListener('click', onClick)
      root.remove()
    },
  }
}
