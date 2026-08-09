import { createPanel } from '../panel/Panel'
import type { Panel } from '../panel/Panel'
import { t } from '../../i18n/i18n'
import { signIn, signOut, signedInUser, hasSession } from '../../server/session'
import './signInPanel.css'

// The sign-in window.
//
// Opened from the server indicator, which is the one place that says a sign-in
// is missing — and nowhere else. Deliberately NOT shown on startup and never
// over the map: everything local works without a server at all, so someone who
// wants to generate a world, bake 4K in this browser and save it to a file
// should never meet a password prompt. See docs/decisions/server-auth.md.

export interface SignInPanel {
  open(): void
  isOpen(): boolean
  dispose(): void
}

export function createSignInPanel(host: HTMLElement, onChange: () => void): SignInPanel {
  const panel: Panel = createPanel(host, { variant: 'signin', title: t('common.panel.signIn.title') })

  const form = document.createElement('form')
  form.className = 'signin-form'
  form.innerHTML = `
    <label class="signin-field">
      <span>${t('common.panel.signIn.user')}</span>
      <input type="text" name="user" autocomplete="username" required />
    </label>
    <label class="signin-field">
      <span>${t('common.panel.signIn.password')}</span>
      <input type="password" name="password" autocomplete="current-password" required />
    </label>
    <p class="signin-error" role="alert" hidden></p>
    <button type="submit" class="text-button">${t('common.panel.signIn.action.submit')}</button>
  `
  const userInput = form.querySelector<HTMLInputElement>('input[name="user"]')!
  const passwordInput = form.querySelector<HTMLInputElement>('input[name="password"]')!
  const error = form.querySelector<HTMLElement>('.signin-error')!
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!

  // Shown instead of the form once there IS a session, so the window answers
  // "who am I" as well as "let me in" — the two questions arrive from the same
  // click on the indicator.
  const signedIn = document.createElement('div')
  signedIn.className = 'signin-current'
  const who = document.createElement('p')
  const out = document.createElement('button')
  out.type = 'button'
  out.className = 'text-button'
  out.textContent = t('common.panel.signIn.action.signOut')
  signedIn.append(who, out)

  panel.body.append(form, signedIn)

  const render = (): void => {
    const session = hasSession()
    form.hidden = session
    signedIn.hidden = !session
    who.textContent = t('common.panel.signIn.signedInAs', { user: signedInUser() })
    error.hidden = true
    // Never left behind in the DOM: a password sitting in a detached form is a
    // password a later screenshot or a memory dump still has.
    passwordInput.value = ''
  }

  panel.onOpen(() => {
    render()
    // Focus what is actually missing — the user field for a fresh sign-in, so
    // the window can be used without touching the mouse.
    if (!hasSession()) queueMicrotask(() => userInput.focus())
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    submit.disabled = true
    error.hidden = true
    void signIn(userInput.value, passwordInput.value).then((outcome) => {
      submit.disabled = false
      passwordInput.value = ''
      if (outcome === 'ok') {
        render()
        onChange()
        panel.close()
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

  out.addEventListener('click', () => {
    signOut()
    render()
    onChange()
    panel.close()
  })

  return {
    open: () => panel.open(),
    isOpen: () => panel.isOpen(),
    dispose: () => panel.dispose(),
  }
}
