// THE WINDOWS OF A SCREEN (2026-10-31, TEG-140): the full-screen windows
// over a screen's work area (the artifacts, the jobs, the languages' full
// view), one at a time. Each screen had its own copy of this rule; now it is
// one. A pure widget: it imports nothing and knows only that a window opens,
// closes and says whether it is open.
//
// The rule: opening a window closes the one open, then the screen's
// `beforeOpen` runs (the handbook closes, the furniture steps aside), then
// the window opens. Closing the last open window runs the screen's
// `afterClose` (the furniture comes back, unless something else holds it
// away, as the world list does).

export interface AppWindow {
  open(): void
  close(): void
  isOpen(): boolean
}

export interface WindowSet {
  // No effect while `window` is open.
  open(window: AppWindow): void
  // No effect while `window` is closed.
  close(window: AppWindow): void
  anyOpen(): boolean
}

export function createWindowSet(windows: readonly AppWindow[], options: { beforeOpen?(): void; afterClose?(): void } = {}): WindowSet {
  const anyOpen = (): boolean => windows.some((w) => w.isOpen())
  function close(window: AppWindow): void {
    if (!window.isOpen()) return
    window.close()
    if (!anyOpen()) options.afterClose?.()
  }
  return {
    open(window) {
      if (window.isOpen()) return
      for (const other of windows) if (other !== window) close(other)
      options.beforeOpen?.()
      window.open()
    },
    close,
    anyOpen,
  }
}
