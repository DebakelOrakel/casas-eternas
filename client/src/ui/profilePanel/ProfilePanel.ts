import { t } from '../../i18n/i18n'
import { formatMonth, initialsOf } from '../format'
import { relabel } from '../../i18n/relabel'
import { signOut } from '../../server/session'
import { avatarFromFile, changePassword, currentAvatarUrl, currentProfile, loadProfile, removeAvatar, saveDisplayName, uploadAvatar, type ProfileOutcome } from '../../server/profileClient'
import type { NotificationManager } from '../notifications/NotificationManager'
import '../theme/design.css'
import '../signInPanel/signInPanel.css'
import './profilePanel.css'

// THE PROFILE WINDOW — the design canvas's "Benutzerprofil" (Main.dc.html),
// in the sign-in window's frame (signInPanel.css): what a signed-in user
// changes about themselves (docs/decisions/client-accounts.md, fork 5). A
// picture, a display name, the login name to read, a new password; Save
// applies what changed, in one go, and closes.
//
// The design's e-mail field is the login name here: the server keeps no
// address (fork 3). Its admin button waits for the admin panel.

export interface ProfilePanel {
  open(): void
  close(): void
  isOpen(): boolean
  dispose(): void
}

// The menu row's icon: a person.
export const USER_ICON = 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10'

// A password's strength as the design draws it: four steps, from its length
// and whether it holds anything but lower-case letters. A nudge, not a rule —
// the server takes any password that is not empty.
function strengthOf(password: string): 0 | 1 | 2 | 3 {
  if (!password) return 0
  return Math.max(1, Math.min(3, Math.floor(password.length / 4) + (/[^a-z]/.test(password) ? 1 : 0))) as 1 | 2 | 3
}
const STRENGTH_KEY = ['profile.password.strength.empty', 'profile.password.strength.weak', 'profile.password.strength.ok', 'profile.password.strength.strong'] as const

// `onOpenAdmin`: where the window's admin button leads, for an admin.
export function createProfilePanel(host: HTMLElement, notifications: NotificationManager | undefined, onOpenAdmin?: () => void): ProfilePanel {
  const root = document.createElement('div')
  root.className = 'signin-backdrop design-light'
  root.hidden = true
  root.innerHTML = `
    <form class="signin-dialog profile-dialog" role="dialog" aria-modal="true">
      <div class="signin-head">
        <div class="signin-head__text">
          <h2 class="signin-title" data-t="profile.title"></h2>
          <p class="signin-intro" data-slot="sub"></p>
        </div>
        <button type="button" class="signin-close" data-action="close" data-t-aria="common.action.close.label">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <div class="profile-avatar">
        <span class="profile-avatar__picture" data-slot="picture" aria-hidden="true"></span>
        <div class="profile-avatar__side">
          <div class="profile-avatar__buttons">
            <button type="button" class="profile-button" data-action="pick" data-t="profile.avatar.pick"></button>
            <button type="button" class="profile-button profile-button--quiet" data-action="clear" data-t="profile.avatar.clear"></button>
          </div>
          <span class="profile-hint" data-t="profile.avatar.hint"></span>
        </div>
        <input type="file" accept="image/png,image/jpeg" data-slot="file" hidden />
      </div>
      <label class="signin-field">
        <span data-t="profile.displayName"></span>
        <input type="text" name="displayName" maxlength="64" autocomplete="nickname" data-t-placeholder="profile.displayName.help" />
      </label>
      <label class="signin-field">
        <span data-t="profile.loginName"></span>
        <input type="text" name="loginName" autocomplete="username" readonly />
      </label>
      <fieldset class="profile-password">
        <legend class="profile-kicker" data-t="profile.password.title"></legend>
        <label class="signin-field">
          <span data-t="profile.password.current"></span>
          <input type="password" name="current" autocomplete="current-password" />
        </label>
        <label class="signin-field">
          <span data-t="profile.password.new"></span>
          <input type="password" name="new" autocomplete="new-password" />
        </label>
        <div class="profile-strength" data-strength="0">
          <span class="profile-strength__bar"><span></span></span>
          <span class="profile-strength__label" data-slot="strength"></span>
        </div>
      </fieldset>
      <div class="profile-foot">
        <button type="button" class="profile-button profile-button--quiet" data-action="signOut" data-t="titlebar.signOut.label"></button>
        <button type="button" class="profile-button profile-button--quiet" data-action="admin" hidden><span data-t="titlebar.admin.label"></span> →</button>
        <span class="profile-foot__gap"></span>
        <button type="button" class="profile-button profile-button--quiet" data-action="close" data-t="profile.cancel"></button>
        <button type="submit" class="signin-submit profile-save" data-t="profile.save"></button>
      </div>
    </form>
  `
  host.appendChild(root)

  const form = root.querySelector<HTMLFormElement>('form')!
  const sub = form.querySelector<HTMLElement>('[data-slot="sub"]')!
  const picture = form.querySelector<HTMLElement>('[data-slot="picture"]')!
  const file = form.querySelector<HTMLInputElement>('[data-slot="file"]')!
  const displayName = form.querySelector<HTMLInputElement>('input[name="displayName"]')!
  const loginName = form.querySelector<HTMLInputElement>('input[name="loginName"]')!
  const currentPassword = form.querySelector<HTMLInputElement>('input[name="current"]')!
  const newPassword = form.querySelector<HTMLInputElement>('input[name="new"]')!
  const strength = form.querySelector<HTMLElement>('.profile-strength')!
  const strengthLabel = form.querySelector<HTMLElement>('[data-slot="strength"]')!
  const save = form.querySelector<HTMLButtonElement>('.profile-save')!
  const adminButton = form.querySelector<HTMLButtonElement>('[data-action="admin"]')!
  adminButton.addEventListener('click', () => {
    close()
    onOpenAdmin?.()
  })

  // The picture as chosen in this window: a new one, its removal, or nothing
  // yet — applied with Save, like the fields.
  let pending: { kind: 'set'; image: Blob; url: string } | { kind: 'clear' } | null = null
  const dropPending = (): void => {
    if (pending?.kind === 'set') URL.revokeObjectURL(pending.url)
    pending = null
  }

  function paintPicture(): void {
    const url = pending?.kind === 'set' ? pending.url : pending?.kind === 'clear' ? null : currentAvatarUrl()
    picture.replaceChildren()
    picture.style.backgroundImage = url ? `url("${url}")` : ''
    if (!url) picture.textContent = initialsOf(displayName.value.trim() || loginName.value)
  }

  function paintStrength(): void {
    const score = strengthOf(newPassword.value)
    strength.dataset.strength = String(score)
    strengthLabel.textContent = t(STRENGTH_KEY[score])
  }

  // The display name as last painted: a field that still holds it is the
  // user's to overwrite, one that does not they have typed into.
  let paintedName = ''

  function paint(): void {
    relabel(root)
    form.setAttribute('aria-label', t('profile.title'))
    const profile = currentProfile()
    if (!profile) return
    const date = formatMonth(profile.createdAt)
    sub.textContent = t('profile.sub', { role: t(profile.admin ? 'profile.role.admin' : 'profile.role.user'), date })
    if (displayName.value === paintedName) displayName.value = profile.displayName
    paintedName = profile.displayName
    loginName.value = profile.name
    adminButton.hidden = !profile.admin || !onOpenAdmin
    paintPicture()
    paintStrength()
  }

  function close(): void {
    root.hidden = true
    dropPending()
    currentPassword.value = ''
    newPassword.value = ''
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !root.hidden) close()
  }
  document.addEventListener('keydown', onKeyDown)
  for (const button of form.querySelectorAll('[data-action="close"]')) button.addEventListener('click', close)
  root.addEventListener('click', (event) => {
    if (event.target === root) close()
  })
  displayName.addEventListener('input', paintPicture)
  newPassword.addEventListener('input', paintStrength)
  form.querySelector('[data-action="pick"]')!.addEventListener('click', () => file.click())
  form.querySelector('[data-action="clear"]')!.addEventListener('click', () => {
    dropPending()
    pending = { kind: 'clear' }
    paintPicture()
  })
  file.addEventListener('change', () => {
    const chosen = file.files?.[0]
    file.value = ''
    if (!chosen) return
    void avatarFromFile(chosen).then((image) => {
      if (!image) {
        notifications?.show({ message: t('notify.profile.avatarUnreadable'), icon: '/icons/warning.png', durationMs: 6000 })
        return
      }
      dropPending()
      pending = { kind: 'set', image, url: URL.createObjectURL(image) }
      paintPicture()
    })
  })
  form.querySelector('[data-action="signOut"]')!.addEventListener('click', () => {
    close()
    signOut()
  })

  // Save: what changed, one after the other; the first failure stops and
  // says why, and the window stays open with what was typed.
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const profile = currentProfile()
    if (!profile) return
    save.disabled = true
    void (async () => {
      const steps: (() => Promise<ProfileOutcome>)[] = []
      if (displayName.value.trim() !== profile.displayName) steps.push(() => saveDisplayName(displayName.value))
      if (newPassword.value) steps.push(() => changePassword(currentPassword.value, newPassword.value))
      const chosen = pending
      if (chosen?.kind === 'set') steps.push(() => uploadAvatar(chosen.image))
      if (chosen?.kind === 'clear' && profile.avatar) steps.push(() => removeAvatar())
      for (const step of steps) {
        const outcome = await step()
        if (outcome.ok) continue
        save.disabled = false
        const message = outcome.reason === 'wrongPassword' ? t('notify.profile.passwordWrong') : t('notify.profile.failed', { reason: outcome.message ?? t('common.server.unreachable.label') })
        notifications?.show({ message, icon: '/icons/warning.png', durationMs: 8000 })
        if (outcome.reason === 'wrongPassword') currentPassword.focus()
        return
      }
      save.disabled = false
      if (steps.length) notifications?.show({ message: t('notify.profile.saved'), icon: '/icons/ok.png', durationMs: 4000 })
      close()
    })()
  })

  return {
    open(): void {
      dropPending()
      displayName.value = paintedName = ''
      currentPassword.value = ''
      newPassword.value = ''
      save.disabled = false
      paint()
      root.hidden = false
      // Fresh from the server, in case another tab changed it.
      void loadProfile().then(() => {
        if (!root.hidden) paint()
      })
      queueMicrotask(() => displayName.focus())
    },
    close,
    isOpen: () => !root.hidden,
    dispose(): void {
      document.removeEventListener('keydown', onKeyDown)
      dropPending()
      root.remove()
    },
  }
}

