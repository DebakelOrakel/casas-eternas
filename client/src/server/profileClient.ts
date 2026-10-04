import { authFetch, hasSession, onSessionChange } from './session'
import { apiBase } from './worldClient'

// The signed-in user's profile (docs/decisions/client-accounts.md, forks 5
// and 6; internal/modules/auth/profile.go): read once a session exists, kept
// here for whoever shows it — the title bar's account button, the profile
// window — and dropped at sign-out.
//
// The picture is fetched rather than linked: an <img src> sends no
// Authorization header, and the route is for signed-in users only. It is
// held as an object URL and fetched again only when its version changes.

export interface Profile {
  id: string
  name: string
  displayName: string
  admin: boolean
  createdAt: string
  lastLoginAt?: string
  // The picture's version; empty for none.
  avatar: string
}

let current: Profile | null = null
let picture: { version: string; url: string } | null = null
const listeners = new Set<() => void>()

export function currentProfile(): Profile | null {
  return current
}

// The picture as an object URL, or null for none (or not yet loaded).
export function currentAvatarUrl(): string | null {
  return current && picture && picture.version === current.avatar ? picture.url : null
}

export function onProfileChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function announce(): void {
  for (const listener of listeners) listener()
}

async function meUrl(suffix = ''): Promise<string | null> {
  const base = await apiBase()
  return base ? `${base}/auth/me${suffix}` : null
}

function dropPicture(): void {
  if (picture) URL.revokeObjectURL(picture.url)
  picture = null
}

// Takes a profile as the server answered it, and its picture when that is
// new.
async function adopt(next: Profile | null): Promise<void> {
  current = next
  if (!next || !next.avatar) dropPicture()
  else if (!picture || picture.version !== next.avatar) {
    const base = await apiBase()
    const response = base ? await authFetch(`${base}/auth/users/${encodeURIComponent(next.id)}/avatar`).catch(() => null) : null
    if (response?.ok) {
      dropPicture()
      picture = { version: next.avatar, url: URL.createObjectURL(await response.blob()) }
    }
  }
  announce()
}

// Reads the profile; null where there is no session, no server or no
// profile route (a server in mode none has no users).
export async function loadProfile(): Promise<Profile | null> {
  const url = hasSession() ? await meUrl() : null
  if (!url) {
    await adopt(null)
    return null
  }
  const response = await authFetch(url, { cache: 'no-store' }).catch(() => null)
  await adopt(response?.ok ? ((await response.json()) as Profile) : null)
  return current
}

export type ProfileOutcome = { ok: true } | { ok: false; reason: 'wrongPassword' | 'failed'; message?: string }

const failed = async (response: Response | null): Promise<ProfileOutcome> => ({
  ok: false,
  reason: 'failed',
  message: response ? (await response.text().catch(() => '')).trim() || String(response.status) : 'unreachable',
})

export async function saveDisplayName(displayName: string): Promise<ProfileOutcome> {
  const url = await meUrl()
  const response = url ? await authFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName }) }).catch(() => null) : null
  if (!response?.ok) return failed(response)
  await adopt((await response.json()) as Profile)
  return { ok: true }
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<ProfileOutcome> {
  const url = await meUrl('/password')
  const response = url ? await authFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: currentPassword, new: newPassword }) }).catch(() => null) : null
  if (response?.status === 403) return { ok: false, reason: 'wrongPassword' }
  return response?.ok ? { ok: true } : failed(response)
}

export async function uploadAvatar(image: Blob): Promise<ProfileOutcome> {
  const url = await meUrl('/avatar')
  const response = url ? await authFetch(url, { method: 'PUT', headers: { 'Content-Type': image.type }, body: image }).catch(() => null) : null
  if (!response?.ok) return failed(response)
  await loadProfile()
  return { ok: true }
}

export async function removeAvatar(): Promise<ProfileOutcome> {
  const url = await meUrl('/avatar')
  const response = url ? await authFetch(url, { method: 'DELETE' }).catch(() => null) : null
  if (!response?.ok) return failed(response)
  await loadProfile()
  return { ok: true }
}

// A picture the user chose, as the server takes it: the largest centred
// square, scaled to 256 × 256, as JPEG. Null where the browser cannot read
// the file as an image.
export async function avatarFromFile(file: File): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const side = Math.min(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 256
    canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256)
    bitmap.close()
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
  } catch {
    return null
  }
}

// Read when a session begins, dropped when it ends.
onSessionChange(() => {
  void loadProfile()
})
if (hasSession()) void loadProfile()
