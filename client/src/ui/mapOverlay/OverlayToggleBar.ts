import type { MapOverlayCompositor } from './MapOverlayCompositor'
import './mapOverlay.css'

// Builds a row of toggle chips, one per overlay layer, wired to flip that
// layer and re-composite. Appends the bar to `container` and returns it.
// Purely presentational — the compositor owns the actual layer state.
export function createOverlayToggleBar(compositor: MapOverlayCompositor, container: HTMLElement): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'overlay-toggles'
  for (const layer of compositor.getLayers()) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = layer.enabled ? 'overlay-toggle is-active' : 'overlay-toggle'
    button.textContent = layer.label
    button.setAttribute('aria-pressed', String(layer.enabled))
    button.addEventListener('click', () => {
      const enabled = !compositor.isLayerEnabled(layer.id)
      compositor.setLayerEnabled(layer.id, enabled)
      button.classList.toggle('is-active', enabled)
      button.setAttribute('aria-pressed', String(enabled))
      compositor.composite()
    })
    bar.appendChild(button)
  }
  container.appendChild(bar)
  return bar
}
