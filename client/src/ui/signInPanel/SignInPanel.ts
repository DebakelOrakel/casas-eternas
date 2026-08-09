import { createPanel } from '../panel/Panel'
import type { Panel } from '../panel/Panel'
import { t } from '../../i18n/i18n'
import { signIn } from '../../server/session'
import './signInPanel.css'

// The sign-in window.
//
// Opened from the server indicator's badge and nowhere else — the one place that
// says a sign-in is missing. Deliberately NOT shown on startup and never over
// the map: everything local works without a server and without a session, so
// someone who wants to generate a world, bake 4K in this browser and save it to
// a file should never meet a password prompt.
// See docs/decisions/server-auth.md.
//
// A sign-in form and nothing else. It briefly also showed who was signed in,
// with a sign-out button, which could not be reached: the indicator is clickable
// only WHILE the sign-in is missing, so by the time there was a name to show,
// there was no way in here. Signing out deliberately has no home yet.

export interface SignInPanel {
  open(): void
  isOpen(): boolean
  dispose(): void
}

export function createSignInPanel(host: HTMLElement, onChange: () => void): SignInPanel {
  const panel: Panel = createPanel(host, { variant: 'signin', title: t('common.panel.signIn.title') })

  const form = document.createElement('form')
  form.className = 'signin-form'
  // The form's id ties the footer's submit button to it: the action belongs in
  // the panel frame's footer, where every other window puts its actions, and a
  // button outside its form needs to say which one it submits.
  form.id = 'signin-form'
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
  `
  const userInput = form.querySelector<HTMLInputElement>('input[name="user"]')!
  const passwordInput = form.querySelector<HTMLInputElement>('input[name="password"]')!
  const error = form.querySelector<HTMLElement>('.signin-error')!
  panel.body.appendChild(form)

  // app-panel-button, not a class of its own: the frame states that the panels
  // share one button style so three windows cannot drift into three slightly
  // different ones. (The first version used `.text-button`, which is scoped to
  // `.map-chrome` and therefore did not apply at all.)
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.setAttribute('form', form.id)
  submit.className = 'app-panel-button'
  submit.textContent = t('common.panel.signIn.action.submit')
  panel.footer.appendChild(submit)

  panel.onOpen(() => {
    error.hidden = true
    // Never left behind: a password sitting in a detached form is a password a
    // later screenshot or a memory dump still has.
    passwordInput.value = ''
    submit.disabled = false
    // So the window can be used without touching the mouse.
    queueMicrotask(() => userInput.focus())
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

  return {
    open: () => panel.open(),
    isOpen: () => panel.isOpen(),
    dispose: () => panel.dispose(),
  }
}
