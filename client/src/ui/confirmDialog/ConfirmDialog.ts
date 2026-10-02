import { t, type TKey } from '../../i18n/i18n'
import '../theme/design.css'
import './confirmDialog.css'

// "Are you sure?" — for the one kind of move this app cannot undo: the ones
// that throw away a world nobody has saved.
//
// A window rather than the arm-in-place button the world list uses for
// deleting. That pattern works where the control is small, sits beside what it
// acts on, and is clicked deliberately; the two moves guarded here are ordinary
// navigation — the masthead and a menu entry — and are clicked on the way to
// something else, often twice. A window is what stops a hand already in motion.
//
// It carries KEYS rather than strings, because the question is asked at a
// moment and answered at a moment: there is no window standing long enough for
// a language switch to reach, so each ask resolves its own text.

export interface ConfirmRequest {
  titleKey: TKey
  bodyKey: TKey
  // What the destructive answer is called. Named for the ACT — "discard",
  // "delete" — never "OK": a dialog whose buttons are Yes and No makes the
  // reader reconstruct the question before answering it.
  confirmKey: TKey
  // What the safe answer is called, when "cancel" would not say it — the
  // replay's question keeps the world either way (default: cancel).
  cancelKey?: TKey
}

export interface ConfirmDialog {
  // Resolves true when the destructive answer is chosen, false for every other
  // way out — the cancel button, Escape, a click on the backdrop. A promise
  // rather than callbacks so the caller reads as one move: ask, then act.
  ask(request: ConfirmRequest): Promise<boolean>
  dispose(): void
}

export function createConfirmDialog(host: HTMLElement): ConfirmDialog {
  const root = document.createElement('div')
  root.className = 'confirm-backdrop design-light'
  root.hidden = true
  root.innerHTML = `
    <div class="confirm-dialog" role="alertdialog" aria-modal="true">
      <h2 class="confirm-title" data-value="title"></h2>
      <p class="confirm-body" data-value="body"></p>
      <div class="confirm-actions">
        <button type="button" class="confirm-cancel" data-action="cancel"></button>
        <button type="button" class="confirm-go" data-action="confirm"></button>
      </div>
    </div>
  `
  host.appendChild(root)

  const dialog = root.querySelector<HTMLElement>('.confirm-dialog')!
  const title = root.querySelector<HTMLElement>('[data-value="title"]')!
  const body = root.querySelector<HTMLElement>('[data-value="body"]')!
  const cancel = root.querySelector<HTMLButtonElement>('[data-action="cancel"]')!
  const go = root.querySelector<HTMLButtonElement>('[data-action="confirm"]')!

  // Set while a question is on screen. Held so that every way out answers the
  // same promise exactly once — a dialog that resolves twice, or not at all,
  // leaves the caller waiting on a move the user already made.
  let settle: ((answer: boolean) => void) | undefined

  function close(answer: boolean): void {
    if (!settle) return
    const resolve = settle
    settle = undefined
    root.hidden = true
    resolve(answer)
  }

  cancel.addEventListener('click', () => close(false))
  go.addEventListener('click', () => close(true))
  root.addEventListener('click', (event) => {
    if (event.target === root) close(false)
  })
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !root.hidden) close(false)
  }
  document.addEventListener('keydown', onKeyDown)

  return {
    ask(request) {
      // A second question while one is up would strand the first. It cannot
      // happen from the screen's own controls — they are behind the backdrop —
      // but a keyboard shortcut or a timer could, so the older question is
      // answered safely rather than dropped.
      close(false)
      title.textContent = t(request.titleKey)
      body.textContent = t(request.bodyKey)
      cancel.textContent = t(request.cancelKey ?? 'common.confirm.action.cancel')
      go.textContent = t(request.confirmKey)
      dialog.setAttribute('aria-label', t(request.titleKey))
      root.hidden = false
      // The SAFE answer takes the focus, so a stray Enter keeps the world.
      queueMicrotask(() => cancel.focus())
      return new Promise<boolean>((resolve) => { settle = resolve })
    },
    dispose(): void {
      close(false)
      document.removeEventListener('keydown', onKeyDown)
      root.remove()
    },
  }
}
