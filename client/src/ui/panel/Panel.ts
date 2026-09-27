import './panel.css'

// The centred-window frame the storage panels share: backdrop, dialog box,
// title bar with a close button, a body, and an optional footer.
//
// Extracted when the one cache window became three (load / save / storage —
// see docs/decisions/server-storage.md), because the parts that are easy to
// get subtly different across three copies are exactly the ones nobody looks
// at twice: what closes the window, whether Escape works, whether a click
// inside it counts as a click outside. Those live here once.
//
// Screen-agnostic on purpose: a panel owns its overlay and knows nothing about
// the screen it was opened from beyond the element it mounts into.

export interface PanelOptions {
  // Class suffix, so a panel can style its own contents without inventing a
  // second frame: `variant: 'load'` yields `.app-panel--load`.
  variant: string
  title: string
  // Read out by assistive tech for the dialog itself; usually the same as the
  // title, but separate because a title may later carry markup.
  ariaLabel?: string
}

export interface Panel {
  // The dialog's own body — panels fill this and otherwise leave the frame be.
  body: HTMLElement
  // Right-hand side of the title bar, for a status readout.
  status: HTMLElement
  footer: HTMLElement
  root: HTMLElement
  isOpen(): boolean
  open(): void
  close(): void
  // Runs whenever the panel is opened, before it becomes visible. This is
  // where a panel refreshes what it lists — a window that shows what it found
  // when it was BUILT is the classic stale-list bug.
  onOpen(handler: () => void): void
  setTitle(title: string): void
  dispose(): void
}

export function createPanel(host: HTMLElement, options: PanelOptions): Panel {
  const root = document.createElement('div')
  root.className = 'app-panel-backdrop'
  root.hidden = true
  root.innerHTML = `
    <div class="app-panel app-panel--${options.variant}" role="dialog" aria-modal="true">
      <header class="app-panel-head">
        <h2 data-value="title"></h2>
        <span class="app-panel-status" data-value="status"></span>
        <button type="button" class="app-panel-close" data-action="close" aria-label="Close">×</button>
      </header>
      <div class="app-panel-body" data-value="body"></div>
      <footer class="app-panel-foot" data-value="footer"></footer>
    </div>
  `
  host.appendChild(root)

  // The label is set as an attribute, not interpolated into the markup above:
  // a title is caller text, and text goes in as text.
  root.querySelector<HTMLElement>('.app-panel')!.setAttribute('aria-label', options.ariaLabel ?? options.title)
  const titleEl = root.querySelector<HTMLElement>('[data-value="title"]')!
  const body = root.querySelector<HTMLElement>('[data-value="body"]')!
  const status = root.querySelector<HTMLElement>('[data-value="status"]')!
  const footer = root.querySelector<HTMLElement>('[data-value="footer"]')!
  titleEl.textContent = options.title

  let openHandler: (() => void) | undefined

  const close = (): void => {
    root.hidden = true
  }

  // Escape closes, but only while this panel is the one on screen — otherwise
  // a key press would silently close a hidden panel and the listener of every
  // panel ever created would fire on every key press.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !root.hidden) close()
  }
  document.addEventListener('keydown', onKeyDown)

  root.querySelector('[data-action="close"]')!.addEventListener('click', close)
  // Clicking the backdrop closes; clicking the window itself must not, which is
  // why this tests the target rather than merely listening on the backdrop —
  // the click event from a button inside also bubbles to here.
  root.addEventListener('click', (event) => {
    if (event.target === root) close()
  })

  return {
    body,
    status,
    footer,
    root,
    isOpen: () => !root.hidden,
    open(): void {
      openHandler?.()
      root.hidden = false
    },
    close,
    onOpen(handler: () => void): void {
      openHandler = handler
    },
    setTitle(title: string): void {
      titleEl.textContent = title
    },
    dispose(): void {
      document.removeEventListener('keydown', onKeyDown)
      root.remove()
    },
  }
}
