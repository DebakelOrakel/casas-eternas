import { authFetch } from './session'
import { apiBase } from './worldClient'

// The admin API on the network (internal/modules/auth/adminnet.go,
// docs/decisions/client-accounts.md, fork 1): users, invite codes and
// service accounts, for a session that carries the admin claim. Every call
// answers its value or an AdminFailure saying why it was refused.

export interface AdminUser {
  id: string
  name: string
  displayName?: string
  role?: string
  createdAt: string
  lastLoginAt?: string
  avatar?: string
  invitedBy?: string
}

export interface Invite {
  id: string
  uses: number
  left: number
  expiresAt: string
  createdBy: string
  createdAt: string
  // The code's last group; the code itself is shown once, at creation.
  hint?: string
}

export interface ServiceAccount {
  id: string
  name: string
  createdAt: string
}

export interface AdminFailure {
  failed: string
}

export const isFailure = (value: unknown): value is AdminFailure => typeof value === 'object' && value !== null && 'failed' in value

async function call<T>(method: string, path: string, body?: unknown): Promise<T | AdminFailure> {
  const base = await apiBase()
  if (!base) return { failed: 'no server' }
  const response = await authFetch(`${base}/auth/admin${path}`, {
    method,
    cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null)
  if (!response) return { failed: 'unreachable' }
  if (!response.ok) return { failed: (await response.text().catch(() => '')).trim() || String(response.status) }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

const name = (value: string): string => encodeURIComponent(value)

export async function listUsers(): Promise<AdminUser[] | AdminFailure> {
  const out = await call<{ users: AdminUser[] }>('GET', '/users')
  return isFailure(out) ? out : out.users
}
export const setRole = (user: string, role: 'user' | 'admin') => call<void>('PUT', `/users/${name(user)}/role`, { role })
export const deleteUser = (user: string) => call<void>('DELETE', `/users/${name(user)}`)
export const createReset = (user: string) => call<{ code: string; expiresAt: string }>('POST', `/users/${name(user)}/reset`)

export async function listInvites(): Promise<Invite[] | AdminFailure> {
  const out = await call<{ invites: Invite[] }>('GET', '/invites')
  return isFailure(out) ? out : out.invites
}
export const createInvite = (uses: number, validHours: number) => call<Invite & { code: string }>('POST', '/invites', { uses, validHours })
export const revokeInvite = (id: string) => call<void>('DELETE', `/invites/${name(id)}`)

export async function listServices(): Promise<ServiceAccount[] | AdminFailure> {
  const out = await call<{ services: ServiceAccount[] }>('GET', '/services')
  return isFailure(out) ? out : out.services
}
// A credential is `<name>:<secret>`, as the CLI prints it and a worker's
// RELAY_CREDENTIALS file holds it.
export async function createService(account: string): Promise<string | AdminFailure> {
  const out = await call<{ name: string; secret: string }>('POST', '/services', { name: account })
  return isFailure(out) ? out : `${out.name}:${out.secret}`
}
export async function rotateService(account: string): Promise<string | AdminFailure> {
  const out = await call<{ name: string; secret: string }>('POST', `/services/${name(account)}/rotate`)
  return isFailure(out) ? out : `${out.name}:${out.secret}`
}
export const deleteService = (account: string) => call<void>('DELETE', `/services/${name(account)}`)

// A user's picture as an object URL, fetched once per version (the route
// wants a session, which an <img src> cannot send).
const pictures = new Map<string, string>()
export async function avatarOf(user: AdminUser): Promise<string | null> {
  if (!user.avatar) return null
  const key = `${user.id}@${user.avatar}`
  const held = pictures.get(key)
  if (held) return held
  const base = await apiBase()
  const response = base ? await authFetch(`${base}/auth/users/${name(user.id)}/avatar`).catch(() => null) : null
  if (!response?.ok) return null
  const url = URL.createObjectURL(await response.blob())
  pictures.set(key, url)
  return url
}
