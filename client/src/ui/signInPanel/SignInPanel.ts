import { t } from '../../i18n/i18n'
import { relabel } from '../../i18n/relabel'
import { redeemCode, signIn } from '../../server/session'
import '../theme/design.css'
import './signInPanel.css'

// The sign-in window — the design canvas's dialog (Main.dc.html, artboard
// "Anmelden"), light theme: a 400 px card on a dimmed page, its own heading,
// two fields and one accent button.
//
// It no longer wears the shared panel frame (ui/panel). That frame is the older
// chrome, sized for lists of worlds, and this window is the one piece of it the
// design draws differently at every level — paper, heading face, field height,
// button. Borrowing the frame and overriding all of it would have left a
// `.app-panel--signin` that shares nothing with `.app-panel`. The behaviour the
// frame owns is small and is repeated here deliberately: Escape, a click on the
// backdrop, and nothing else closes it.
//
// Opened from the server indicator's badge and from the save menu's server
// row — the two places that say a sign-in is missing. Deliberately NOT shown on
// startup and never over the map unasked: everything local works without a
// server and without a session, so someone who wants to generate a world, bake
// 4K in this browser and save it to a file should never meet a password prompt.
// See docs/decisions/server-auth.md.
//
// A sign-in form, and behind "I have a code" a second one that redeems a code
// (docs/decisions/client-accounts.md, fork 4): an invite code makes the
// account, a reset code sets a new password, and either signs in. There is
// no registration without a code, so the design's "no account yet?
// register" line stays out.

export interface SignInPanel {
  open(): void
  isOpen(): boolean
  dispose(): void
}

export function createSignInPanel(host: HTMLElement, onChange: () => void): SignInPanel {
  const root = document.createElement('div')
  root.className = 'signin-backdrop design-light'
  root.hidden = true
  root.innerHTML = `
    <form class="signin-dialog" role="dialog" aria-modal="true" aria-label="${t('common.panel.signIn.title')}">
      <div class="signin-head">
        <div class="signin-head__text">
          <h2 class="signin-title" data-t="common.panel.signIn.title"></h2>
          <p class="signin-intro" data-t="common.panel.signIn.intro"></p>
        </div>
        <button type="button" class="signin-close" data-action="close" data-t-aria="common.action.close.label">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <label class="signin-field">
        <span data-t="common.panel.signIn.user"></span>
        <input type="text" name="user" autocomplete="username" required />
      </label>
      <label class="signin-field">
        <span data-t="common.panel.signIn.password"></span>
        <input type="password" name="password" autocomplete="current-password" required />
      </label>
      <p class="signin-error" role="alert" hidden></p>
      <button type="submit" class="signin-submit" data-t="common.panel.signIn.action.submit"></button>
      <button type="button" class="signin-switch" data-action="toRedeem" data-t="common.panel.signIn.redeem"></button>
    </form>
    <form class="signin-dialog" data-form="redeem" role="dialog" aria-modal="true" hidden>
      <div class="signin-head">
        <div class="signin-head__text">
          <h2 class="signin-title" data-t="common.panel.signIn.redeem.title"></h2>
          <p class="signin-intro" data-t="common.panel.signIn.redeem.intro"></p>
        </div>
        <button type="button" class="signin-close" data-action="close" data-t-aria="common.action.close.label">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <label class="signin-field">
        <span data-t="common.panel.signIn.code"></span>
        <input type="text" name="code" autocomplete="one-time-code" spellcheck="false" required />
      </label>
      <label class="signin-field">
        <span data-t="common.panel.signIn.user"></span>
        <input type="text" name="user" autocomplete="username" pattern="[A-Za-z0-9][A-Za-z0-9._\-]{1,31}" />
      </label>
      <label class="signin-field">
        <span data-t="common.panel.signIn.password"></span>
        <input type="password" name="password" autocomplete="new-password" required />
      </label>
      <p class="signin-error" role="alert" hidden></p>
      <button type="submit" class="signin-submit" data-t="common.panel.signIn.redeem.submit"></button>
      <button type="button" class="signin-switch" data-action="toSignIn" data-t="common.panel.signIn.back"></button>
    </form>
  `
  relabel(root)
  host.appendChild(root)

  const form = root.querySelector<HTMLFormElement>('.signin-dialog:not([data-form])')!
  const redeemForm = root.querySelector<HTMLFormElement>('[data-form="redeem"]')!
  redeemForm.setAttribute('aria-label', t('common.panel.signIn.redeem.title'))
  const userInput = form.querySelector<HTMLInputElement>('input[name="user"]')!
  const passwordInput = form.querySelector<HTMLInputElement>('input[name="password"]')!
  const error = form.querySelector<HTMLElement>('.signin-error')!
  const submit = form.querySelector<HTMLButtonElement>('.signin-submit')!

  function close(): void {
    root.hidden = true
  }

  // --- redeeming a code -------------------------------------------------------

  const codeInput = redeemForm.querySelector<HTMLInputElement>('input[name="code"]')!
  const redeemUser = redeemForm.querySelector<HTMLInputElement>('input[name="user"]')!
  const redeemPassword = redeemForm.querySelector<HTMLInputElement>('input[name="password"]')!
  const redeemError = redeemForm.querySelector<HTMLElement>('.signin-error')!
  const redeemSubmit = redeemForm.querySelector<HTMLButtonElement>('.signin-submit')!
  function showForm(redeem: boolean): void {
    form.hidden = redeem
    redeemForm.hidden = !redeem
    error.hidden = true
    redeemError.hidden = true
    queueMicrotask(() => (redeem ? codeInput : userInput).focus())
  }
  form.querySelector('[data-action="toRedeem"]')!.addEventListener('click', () => showForm(true))
  redeemForm.querySelector('[data-action="toSignIn"]')!.addEventListener('click', () => showForm(false))
  redeemForm.querySelector('[data-action="close"]')!.addEventListener('click', close)
  redeemForm.addEventListener('submit', (event) => {
    event.preventDefault()
    redeemSubmit.disabled = true
    redeemError.hidden = true
    void redeemCode(codeInput.value.trim(), redeemUser.value.trim(), redeemPassword.value).then((outcome) => {
      redeemSubmit.disabled = false
      redeemPassword.value = ''
      if (outcome === 'ok') {
        codeInput.value = ''
        onChange()
        close()
        return
      }
      // A name the server will not take is caught by the field's own pattern
      // first; the rare one that gets past it reads as a code that failed.
      const key = outcome === 'taken' ? 'common.panel.signIn.redeem.taken'
        : outcome === 'limited' ? 'common.panel.signIn.redeem.limited'
        : outcome === 'unreachable' ? 'common.panel.signIn.unreachable'
        : 'common.panel.signIn.redeem.failed'
      redeemError.textContent = t(key)
      redeemError.hidden = false
      ;(outcome === 'taken' ? redeemUser : codeInput).focus()
    })
  })

  // Escape closes, but only while this window is the one on screen — otherwise
  // a key press would silently close a hidden dialog and every dialog ever
  // created would answer every key press.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !root.hidden) close()
  }
  document.addEventListener('keydown', onKeyDown)

  root.querySelector('[data-action="close"]')!.addEventListener('click', close)
  // Clicking the backdrop closes; clicking the card must not, which is why this
  // tests the target rather than merely listening on the backdrop — a click on
  // a field inside bubbles to here as well.
  root.addEventListener('click', (event) => {
    if (event.target === root) close()
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    submit.disabled = true
    error.hidden = true
    void signIn(userInput.value, passwordInput.value).then((outcome) => {
      submit.disabled = false
      passwordInput.value = ''
      if (outcome === 'ok') {
        onChange()
        close()
        return
      }
      // The two failures are told apart on purpose: "wrong password" sends
      // someone to check their password, and doing that against a server that
      // is simply not answering is a wasted quarter of an hour.
      error.textContent = t(outcome === 'rejected' ? 'common.panel.signIn.failed' : 'common.panel.signIn.unreachable')
      error.hidden = false
      passwordInput.focus()
    })
  })

  return {
    open(): void {
      // Said again in the language that is active now: the generator cannot
      // rebuild itself on a language switch, so a window built once would
      // otherwise keep the language it was born in.
      relabel(root)
      redeemForm.setAttribute('aria-label', t('common.panel.signIn.redeem.title'))
      form.hidden = false
      redeemForm.hidden = true
      redeemError.hidden = true
      redeemPassword.value = ''
      error.hidden = true
      // Never left behind: a password sitting in a hidden form is a password a
      // later screenshot or a memory dump still has.
      passwordInput.value = ''
      submit.disabled = false
      root.hidden = false
      // So the window can be used without touching the mouse.
      queueMicrotask(() => userInput.focus())
    },
    isOpen: () => !root.hidden,
    dispose(): void {
      document.removeEventListener('keydown', onKeyDown)
      root.remove()
    },
  }
}
