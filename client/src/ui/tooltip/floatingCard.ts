import './tooltip.css'

// A small floating card primitive shared by the tooltip drivers. It owns a
// position: fixed element (viewport-clamped) and its visibility; the caller
// fills `el` with content, then calls one of the show* methods. `host` only
// scopes lifetime/cleanup (fixed positioning is relative to the viewport).
export interface FloatingCard {
  readonly el: HTMLElement
  // Show offset from a cursor point (map readout follows the pointer), flipping
  // to the other side of the cursor near the right/bottom edge.
  showAtPoint(clientX: number, clientY: number): void
  // Show anchored above an element's rect (control help), centred and flipped
  // below when there is no room above.
  showAtRect(anchor: DOMRect): void
  hide(): void
  dispose(): void
}

export function createFloatingCard(host: HTMLElement, extraClass?: string): FloatingCard {
  const el = document.createElement('div')
  el.className = extraClass ? `tooltip-card ${extraClass}` : 'tooltip-card'
  el.hidden = true
  host.appendChild(el)

  // Keep the card fully on screen (a 4px margin from every edge).
  function clampAndPlace(x: number, y: number): void {
    const w = el.offsetWidth
    const h = el.offsetHeight
    el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`
    el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 4))}px`
  }

  return {
    el,
    showAtPoint(clientX, clientY): void {
      el.hidden = false // unhide first so offsetWidth/Height measure the laid-out box
      const pad = 14
      let x = clientX + pad
      let y = clientY + pad
      if (x + el.offsetWidth > window.innerWidth) x = clientX - pad - el.offsetWidth
      if (y + el.offsetHeight > window.innerHeight) y = clientY - pad - el.offsetHeight
      clampAndPlace(x, y)
    },
    showAtRect(anchor): void {
      el.hidden = false
      const gap = 8
      const x = anchor.left + anchor.width / 2 - el.offsetWidth / 2
      let y = anchor.top - gap - el.offsetHeight
      if (y < 4) y = anchor.bottom + gap // no room above → drop below the element
      clampAndPlace(x, y)
    },
    hide(): void {
      el.hidden = true
    },
    dispose(): void {
      el.remove()
    },
  }
}
