import { t, type TKey } from '../../i18n/i18n'
import { relabel } from '../../i18n/relabel'
import { formatWhen, initialsOf } from '../format'
import { icon } from '../chooserIcons'
import { currentProfile } from '../../server/profileClient'
import {
  avatarOf, createInvite, createReset, createService, deleteService, deleteUser, isFailure, listInvites, listServices, listUsers,
  revokeInvite, rotateService, setBlocked, setRole, type AdminFailure, type AdminUser, type Invite, type ServiceAccount,
} from '../../server/adminClient'
import type { NotificationManager } from '../notifications/NotificationManager'
import '../theme/design.css'
import '../worldChooser/worldChooser.css'
import './adminPanel.css'

// THE ADMIN WINDOW — the design canvas's "Admin-Einstellungen"
// (Main.dc.html), in the frame the jobs and artifacts windows wear
// (worldChooser.css): a side navigation and one section at a time
// (docs/decisions/client-accounts.md, fork 8).
//
//   - Users: role, last sign-in, the invite a user came with; a reset code,
//     deletion.
//   - Invite codes: made for a number of registrations and a validity,
//     listed until spent or expired, revoked.
//   - Compute nodes: the service accounts workers prove themselves with.
//
// A code or a credential is shown once, in the box above its list, with a
// copy button: the server keeps only its hash. Where the design differs
// from the model — global editor/viewer roles, e-mail, quotas, a log — the
// model stands.

export interface AdminPanel {
  open(): void
  close(): void
  isOpen(): boolean
  dispose(): void
}

type Section = 'users' | 'invites' | 'nodes'

const VALIDITY: { key: TKey; hours: number }[] = [
  { key: 'admin.invites.valid.day', hours: 24 },
  { key: 'admin.invites.valid.week', hours: 7 * 24 },
  { key: 'admin.invites.valid.twoWeeks', hours: 14 * 24 },
  { key: 'admin.invites.valid.month', hours: 30 * 24 },
]

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

export function createAdminPanel(host: HTMLElement, notifications: NotificationManager | undefined): AdminPanel {
  const root = document.createElement('div')
  root.className = 'world-chooser admin-window design-light'
  root.hidden = true
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.innerHTML = `
    <div class="wc-sheet adm-sheet">
      <div class="adm-head">
        <div class="wc-head">
          <span class="adm-kicker mono" data-t="admin.kicker"></span>
          <h1 class="wc-title" data-t="admin.title"></h1>
          <p class="wc-subtitle" data-slot="sub"></p>
        </div>
        <button type="button" class="adm-close" data-act="close" data-t-aria="common.action.close.label"></button>
      </div>
      <div class="adm-body">
        <nav class="adm-nav" data-t-aria="admin.title">
          <button type="button" data-section="users"><span data-t="admin.nav.users"></span><span class="adm-count mono" data-count="users"></span></button>
          <button type="button" data-section="invites"><span data-t="admin.nav.invites"></span><span class="adm-count mono" data-count="invites"></span></button>
          <button type="button" data-section="nodes"><span data-t="admin.nav.nodes"></span><span class="adm-count mono" data-count="nodes"></span></button>
        </nav>
        <section class="adm-main">
          <div class="adm-secret" data-slot="secret" hidden>
            <span class="adm-secret__title" data-t="admin.secret.title"></span>
            <code class="adm-secret__value mono" data-slot="secret-value"></code>
            <button type="button" class="adm-button" data-act="copy" data-t="admin.secret.copy"></button>
            <span class="adm-secret__hint" data-t="admin.secret.hint"></span>
          </div>
          <div data-panel="users">
            <label class="adm-search">
              <span class="adm-hidden" data-t="admin.users.search"></span>
              <input type="search" data-slot="search" data-t-placeholder="admin.users.search" />
            </label>
            <div class="adm-table" data-slot="users"></div>
          </div>
          <div data-panel="invites">
            <form class="adm-form" data-slot="invite-form">
              <label><span data-t="admin.invites.uses"></span><input type="number" name="uses" min="1" max="1000" value="5" required /></label>
              <label><span data-t="admin.invites.valid"></span><select name="valid"></select></label>
              <button type="submit" class="adm-button adm-button--accent" data-t="admin.invites.create"></button>
            </form>
            <div class="adm-table adm-table--invites" data-slot="invites"></div>
          </div>
          <div data-panel="nodes">
            <p class="adm-hint" data-t="admin.nodes.hint"></p>
            <form class="adm-form" data-slot="node-form">
              <label><span data-t="admin.nodes.name"></span><input type="text" name="name" pattern="[a-z0-9][a-z0-9-]{0,62}" required /></label>
              <button type="submit" class="adm-button adm-button--accent" data-t="admin.nodes.create"></button>
            </form>
            <div class="adm-table adm-table--nodes" data-slot="nodes"></div>
          </div>
        </section>
      </div>
    </div>
  `
  host.appendChild(root)
  const q = <T extends Element>(selector: string): T => root.querySelector<T>(selector)!
  const sub = q<HTMLElement>('[data-slot="sub"]')
  const usersTable = q<HTMLElement>('[data-slot="users"]')
  const invitesTable = q<HTMLElement>('[data-slot="invites"]')
  const nodesTable = q<HTMLElement>('[data-slot="nodes"]')
  const search = q<HTMLInputElement>('[data-slot="search"]')
  const secret = q<HTMLElement>('[data-slot="secret"]')
  const secretValue = q<HTMLElement>('[data-slot="secret-value"]')
  const copyButton = q<HTMLButtonElement>('[data-act="copy"]')
  const validSelect = q<HTMLSelectElement>('select[name="valid"]')
  const closeButton = q<HTMLButtonElement>('[data-act="close"]')
  closeButton.appendChild(icon('<path d="M6 6l12 12M18 6L6 18"/>'))
  validSelect.append(...VALIDITY.map((v, i) => {
    const option = el('option')
    option.value = String(v.hours)
    option.selected = i === 2
    return option
  }))

  let section: Section = 'users'
  let users: AdminUser[] = []
  let invites: Invite[] = []
  let nodes: ServiceAccount[] = []
  // The user whose deletion asks to be confirmed.
  let confirming: string | null = null

  const refused = (failure: AdminFailure): void => {
    notifications?.show({ message: t('notify.admin.failed', { reason: failure.failed ?? t('common.server.unreachable.label') }), icon: '/icons/warning.png', durationMs: 8000 })
  }

  // --- the one-time secret ----------------------------------------------------

  function showSecret(value: string): void {
    secretValue.textContent = value
    copyButton.textContent = t('admin.secret.copy')
    secret.hidden = false
  }
  // Without a clipboard (a page not served over HTTPS has none) or where
  // it refuses, the value is selected for the keyboard's copy: shown once,
  // it must not be lost to a button that did nothing.
  const selectSecret = (): void => {
    const range = document.createRange()
    range.selectNodeContents(secretValue)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  copyButton.addEventListener('click', () => {
    if (!navigator.clipboard) return selectSecret()
    navigator.clipboard.writeText(secretValue.textContent ?? '').then(
      () => { copyButton.textContent = t('admin.secret.copied') },
      selectSecret,
    )
  })

  // --- painting ---------------------------------------------------------------

  function paintFrame(): void {
    relabel(root)
    const admins = users.filter((u) => u.role === 'admin').length
    sub.textContent = t('admin.sub', { users: users.length, admins })
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-section]')) {
      button.setAttribute('aria-current', button.dataset.section === section ? 'page' : 'false')
    }
    q<HTMLElement>('[data-count="users"]').textContent = String(users.length)
    q<HTMLElement>('[data-count="invites"]').textContent = String(invites.length)
    q<HTMLElement>('[data-count="nodes"]').textContent = String(nodes.length)
    for (const panel of root.querySelectorAll<HTMLElement>('[data-panel]')) panel.hidden = panel.dataset.panel !== section
    // Relabelled, not rebuilt: a rebuild put the choice back to two weeks at
    // every paint, and a code was made with a validity nobody chose.
    VALIDITY.forEach((v, i) => { validSelect.options[i].textContent = t(v.key) })
  }

  const head = (keys: TKey[]): HTMLElement => {
    const row = el('div', 'adm-row adm-row--head')
    for (const key of keys) row.appendChild(el('span', '', t(key)))
    row.appendChild(el('span'))
    return row
  }

  function paintUsers(): void {
    const me = currentProfile()?.id
    const needle = search.value.trim().toLowerCase()
    const shown = users.filter((u) => !needle || u.name.toLowerCase().includes(needle) || (u.displayName ?? '').toLowerCase().includes(needle))
    usersTable.replaceChildren(head(['admin.users.col.user', 'admin.users.col.role', 'admin.users.col.lastLogin', 'admin.users.col.invitedBy']))
    for (const u of shown) {
      const self = u.id === me
      const row = el('div', 'adm-row')
      const who = el('div', 'adm-user')
      const picture = el('span', 'adm-avatar', initialsOf(u.displayName || u.name))
      picture.setAttribute('aria-hidden', 'true')
      void avatarOf(u).then((url) => {
        if (!url) return
        picture.textContent = ''
        picture.style.backgroundImage = `url("${url}")`
      })
      const names = el('div', 'adm-names')
      const login = [u.name, ...(self ? [t('admin.users.you')] : []), ...(u.blocked ? [t('admin.users.blocked')] : [])].join(' · ')
      names.append(el('span', 'adm-name', u.displayName || u.name), el('span', 'adm-login mono', login))
      if (u.blocked) row.classList.add('adm-row--blocked')
      who.append(picture, names)
      const role = el('select', 'adm-select')
      role.setAttribute('aria-label', t('admin.users.col.role'))
      for (const value of ['user', 'admin'] as const) {
        const option = el('option', '', t(value === 'admin' ? 'profile.role.admin' : 'profile.role.user'))
        option.value = value
        option.selected = (u.role === 'admin') === (value === 'admin')
        role.appendChild(option)
      }
      // Not on yourself here: the network refuses it, so the control says so.
      role.disabled = self
      role.addEventListener('change', () => {
        const next = role.value as 'user' | 'admin'
        void setRole(u.name, next).then((out) => {
          if (isFailure(out)) {
            refused(out)
            return void reload()
          }
          notifications?.show({ message: t('notify.admin.roleChanged', { user: u.displayName || u.name, role: t(next === 'admin' ? 'profile.role.admin' : 'profile.role.user') }), icon: '/icons/ok.png', durationMs: 6000 })
          void reload()
        })
      })
      const last = el('span', 'adm-muted', u.lastLoginAt ? formatWhen(u.lastLoginAt) : t('admin.users.never'))
      // Who invited, not the code's id: the code's record is gone once spent.
      const invited = el('span', 'adm-muted', u.inviter || '–')
      const actions = el('div', 'adm-actions')
      if (confirming === u.name) {
        actions.append(el('span', 'adm-confirm', t('admin.users.deleteConfirm', { user: u.displayName || u.name })))
        const yes = el('button', 'adm-button adm-button--danger', t('admin.action.delete'))
        yes.type = 'button'
        yes.addEventListener('click', () => {
          confirming = null
          void deleteUser(u.name).then((out) => {
            if (isFailure(out)) refused(out)
            void reload()
          })
        })
        const no = el('button', 'adm-button', t('profile.cancel'))
        no.type = 'button'
        no.addEventListener('click', () => { confirming = null; paintUsers() })
        actions.append(yes, no)
      } else {
        const reset = el('button', 'adm-button', t('admin.users.reset'))
        reset.type = 'button'
        reset.addEventListener('click', () => {
          void createReset(u.name).then((out) => (isFailure(out) ? refused(out) : showSecret(out.code)))
        })
        // Not on yourself, like the role: the network refuses it.
        const block = el('button', 'adm-button', t(u.blocked ? 'admin.users.unblock' : 'admin.users.block'))
        block.type = 'button'
        block.disabled = self
        block.addEventListener('click', () => {
          void setBlocked(u.name, !u.blocked).then((out) => {
            if (isFailure(out)) refused(out)
            void reload()
          })
        })
        const remove = el('button', 'adm-button adm-button--quiet', t('admin.action.delete'))
        remove.type = 'button'
        remove.disabled = self
        remove.addEventListener('click', () => { confirming = u.name; paintUsers() })
        actions.append(reset, block, remove)
      }
      row.append(who, role, last, invited, actions)
      usersTable.appendChild(row)
    }
  }

  function paintInvites(): void {
    invitesTable.replaceChildren()
    if (invites.length === 0) {
      invitesTable.appendChild(el('p', 'adm-empty', t('admin.invites.empty')))
      return
    }
    invitesTable.appendChild(head(['admin.invites.col.code', 'admin.invites.col.left', 'admin.invites.col.expires', 'admin.invites.col.by']))
    for (const invite of invites) {
      const row = el('div', 'adm-row')
      const revoke = el('button', 'adm-button adm-button--quiet', t('admin.invites.revoke'))
      revoke.type = 'button'
      revoke.addEventListener('click', () => {
        void revokeInvite(invite.id).then((out) => {
          if (isFailure(out)) refused(out)
          void reload()
        })
      })
      const actions = el('div', 'adm-actions')
      actions.appendChild(revoke)
      row.append(
        // The code's last group, never the record's id: the code is shown once,
        // in the box above, and an id in this column was taken for it.
        el('span', 'mono', invite.hint ? `••••-••••-••••-${invite.hint}` : '••••'),
        el('span', '', t('admin.invites.left', { left: invite.left, uses: invite.uses })),
        el('span', 'adm-muted', formatWhen(invite.expiresAt)),
        el('span', 'adm-muted', invite.createdBy),
        actions,
      )
      invitesTable.appendChild(row)
    }
  }

  function paintNodes(): void {
    nodesTable.replaceChildren()
    if (nodes.length === 0) {
      nodesTable.appendChild(el('p', 'adm-empty', t('admin.nodes.empty')))
      return
    }
    const header = el('div', 'adm-row adm-row--head adm-row--nodes')
    header.append(el('span', '', t('admin.nodes.col.name')), el('span', '', t('admin.nodes.col.created')), el('span'))
    nodesTable.appendChild(header)
    for (const node of nodes) {
      const row = el('div', 'adm-row adm-row--nodes')
      const rotate = el('button', 'adm-button', t('admin.nodes.rotate'))
      rotate.type = 'button'
      rotate.addEventListener('click', () => {
        void rotateService(node.name).then((out) => (isFailure(out) ? refused(out) : showSecret(out)))
      })
      const remove = el('button', 'adm-button adm-button--quiet', t('admin.action.delete'))
      remove.type = 'button'
      remove.addEventListener('click', () => {
        void deleteService(node.name).then((out) => {
          if (isFailure(out)) refused(out)
          void reload()
        })
      })
      const actions = el('div', 'adm-actions')
      actions.append(rotate, remove)
      row.append(el('span', 'mono', node.name), el('span', 'adm-muted', formatWhen(node.createdAt)), actions)
      nodesTable.appendChild(row)
    }
  }

  function paint(): void {
    paintFrame()
    paintUsers()
    paintInvites()
    paintNodes()
  }

  async function reload(): Promise<void> {
    const [u, i, n] = await Promise.all([listUsers(), listInvites(), listServices()])
    for (const out of [u, i, n]) if (isFailure(out)) refused(out)
    users = isFailure(u) ? users : u
    invites = isFailure(i) ? invites : i
    nodes = isFailure(n) ? nodes : n
    if (!root.hidden) paint()
  }

  // --- controls ---------------------------------------------------------------

  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-section]')) {
    button.addEventListener('click', () => {
      section = button.dataset.section as Section
      secret.hidden = true
      paint()
    })
  }
  search.addEventListener('input', paintUsers)
  q<HTMLFormElement>('[data-slot="invite-form"]').addEventListener('submit', (event) => {
    event.preventDefault()
    const form = event.target as HTMLFormElement
    const uses = Number((form.elements.namedItem('uses') as HTMLInputElement).value)
    void createInvite(uses, Number(validSelect.value)).then((out) => {
      if (isFailure(out)) return refused(out)
      showSecret(out.code)
      void reload()
    })
  })
  q<HTMLFormElement>('[data-slot="node-form"]').addEventListener('submit', (event) => {
    event.preventDefault()
    const input = (event.target as HTMLFormElement).elements.namedItem('name') as HTMLInputElement
    void createService(input.value).then((out) => {
      if (isFailure(out)) return refused(out)
      input.value = ''
      showSecret(out)
      void reload()
    })
  })

  function close(): void {
    root.hidden = true
    secret.hidden = true
    secretValue.textContent = ''
    confirming = null
  }
  closeButton.addEventListener('click', close)
  // On the document, as the profile window does: opened from a menu, the
  // focus is not inside yet.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !root.hidden) close()
  }
  document.addEventListener('keydown', onKeyDown)

  return {
    open(): void {
      secret.hidden = true
      confirming = null
      root.hidden = false
      paint()
      root.setAttribute('aria-label', t('admin.title'))
      closeButton.focus()
      void reload()
    },
    close,
    isOpen: () => !root.hidden,
    dispose(): void {
      document.removeEventListener('keydown', onKeyDown)
      root.remove()
    },
  }
}
