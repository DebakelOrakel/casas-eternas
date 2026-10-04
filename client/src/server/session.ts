import { getServerStatus, refreshServerStatus } from './serverStatus'

// The browser's half of a session: the token, where it is kept, and how the
// client finds out it no longer has one.
//
// Being signed out is a STATE here, not an error. Everything local — generating,
// the OPFS cache, saving a .zip — needs no server at all, so a client without a
// session behaves like a client without a server rather than like a broken one.
// See docs/decisions/server-auth.md, "The logged-out client".

const STORAGE_KEY = 'casas-eternas.session'

// `refreshToken` renews `token` when it runs out (docs/decisions/
// server-auth.md, "Revocation"): the access token lives minutes, the
// refresh token as long as the sign-in. A session kept from before the
// server issued one has none, and ends when its token does.
interface Session {
  token: string
  user: string
  refreshToken?: string
}

// localStorage rather than sessionStorage or memory, and it is a trade rather
// than an oversight: the token is readable by any script on this origin, which
// is true of anything a single-page app can send on its own requests — the
// alternative that is NOT is an HttpOnly cookie, and that was ruled out because
// the CLI and the bake job need the same door as the browser. What localStorage
// buys is the thing the long token lifetime is for: closing the tab is not
// signing out.
function read(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Session>
    if (!parsed.token || !parsed.user) return null
    return { token: parsed.token, user: parsed.user, refreshToken: parsed.refreshToken }
  } catch {
    // A storage that throws (private mode, disabled, or a value someone else
    // wrote) means no session, never a crash on the way to the first frame.
    return null
  }
}

function write(session: Session | null): void {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Not being able to remember it is survivable; not being able to use it
    // would not be, so the in-memory copy below stays authoritative for this tab.
  }
}

let current: Session | null = read()

const listeners = new Set<() => void>()
// Separate from the above, because the two are different events with different
// audiences: everything redraws on any change, but only a session TAKEN AWAY is
// worth interrupting someone about. Signing in and signing out are things they
// just did and can see for themselves.
const lostListeners = new Set<() => void>()

// Subscribe to sign-in and sign-out. The indicator and every screen that shows
// server state redraw from this rather than polling.
export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function announce(): void {
  for (const listener of listeners) listener()
}

/**
 * Fired when the server stops accepting a session we believed we had — an
 * expired token, or a server restarted with a fresh signing key.
 *
 * It exists because that failure is otherwise invisible: the request that
 * discovered it usually belongs to something the user did NOT initiate, or to
 * something that fails by returning nothing. Being signed out without being told
 * looks like the application quietly breaking.
 */
export function onSessionLost(listener: () => void): () => void {
  lostListeners.add(listener)
  return () => lostListeners.delete(listener)
}

/** The signed-in user, or '' when there is no session. */
export function signedInUser(): string {
  return current?.user ?? ''
}

/** Whether this client holds a session token. Says nothing about its validity. */
export function hasSession(): boolean {
  return current !== null
}

/**
 * The Authorization header, or nothing.
 *
 * A FUNCTION rather than a value handed out once: the token changes at sign-in,
 * at sign-out and when the server stops accepting it, and anything that captured
 * a string would go on sending a dead one.
 */
export function authHeaders(): Record<string, string> {
  return current ? { Authorization: `Bearer ${current.token}` } : {}
}

/**
 * Whether authentication is needed but absent.
 *
 * The question every server-backed action actually has — a 4K bake asks it to
 * decide whether to fall back to this browser, and the indicator asks it to
 * decide whether to show its badge.
 */
export async function needsSignIn(): Promise<boolean> {
  const status = await getServerStatus()
  return status.loginPath !== '' && !hasSession()
}

export type SignInOutcome = 'ok' | 'rejected' | 'unreachable'

/**
 * Exchange a user and password for a token.
 *
 * Basic auth, because that is the one door this server opens for credentials and
 * it is the same one `curl -u` uses. The password is never stored — only what
 * comes back is.
 */
export async function signIn(user: string, password: string): Promise<SignInOutcome> {
  const status = await getServerStatus()
  if (!status.loginPath) return 'unreachable'
  try {
    const response = await fetch(status.loginPath, {
      method: 'POST',
      cache: 'no-store',
      headers: { Authorization: `Basic ${btoa(`${user}:${password}`)}` },
    })
    if (response.status === 401) return 'rejected'
    if (!response.ok) return 'unreachable'
    return (await begin(response, user)) ? 'ok' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}

// Takes the session a sign-in or a redeemed code answered with; false where
// the answer holds no token.
async function begin(response: Response, user: string): Promise<boolean> {
  const body = (await response.json()) as { token?: string; user?: string; refreshToken?: string }
  if (!body.token) return false
  current = { token: body.token, user: body.user ?? user, refreshToken: body.refreshToken }
  write(current)
  announce()
  // The status carries authMode and loginPath, neither of which changed — but
  // a client that could not reach /v1/capabilities while signed out may reach
  // it now, so the cached verdict is worth re-taking.
  void refreshServerStatus()
  return true
}

export type RedeemOutcome = 'ok' | 'invalid' | 'taken' | 'badName' | 'limited' | 'unreachable'

/**
 * Spend an invite or reset code (docs/decisions/client-accounts.md, fork 4):
 * an invite makes the account `user`, a reset sets the password of the
 * account it was made for; either way the answer is a session, kept like a
 * sign-in's.
 */
export async function redeemCode(code: string, user: string, password: string): Promise<RedeemOutcome> {
  const status = await getServerStatus()
  if (!status.loginPath || !status.apiBase) return 'unreachable'
  try {
    const response = await fetch(`${status.apiBase}/auth/redeem`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: user, password }),
    })
    if (response.status === 403) return 'invalid'
    if (response.status === 409) return 'taken'
    if (response.status === 400) return 'badName'
    if (response.status === 429) return 'limited'
    if (!response.ok) return 'unreachable'
    return (await begin(response, user)) ? 'ok' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}

/**
 * Forget the session.
 *
 * Purely local, and that is honest rather than lazy: the token is stateless, so
 * there is nothing on the server to delete — see the revocation section of the
 * decision. What ends the token is its own expiry.
 */
export function signOut(): void {
  if (!current) return
  current = null
  write(null)
  announce()
}

/**
 * fetch, with this session attached, that notices when the session has died.
 *
 * The 401 is the point. A token expires mid-session, or the server restarts with
 * a fresh signing key, and the next call is the first anyone learns of it. One
 * wrapper turns that into a state change every listener sees, instead of twelve
 * call sites each inventing a way to report a failure.
 */
//
// A 401 is first taken as an access token that ran out: the session is
// renewed once and the request sent again. Only when that fails is the
// session lost.
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const send = (): Promise<Response> => fetch(input, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...authHeaders() } })
  const sentWith = current
  let response = await send()
  if (response.status !== 401 || !current) return response
  // Renewed meanwhile by another request: send again with that token.
  if (current !== sentWith || (await renewSession())) response = await send()
  if (response.status === 401 && current) {
    signOut()
    for (const listener of lostListeners) listener()
  }
  return response
}

/**
 * Takes the session a password change answered with: the change ended every
 * session of the user, this one's renewal included. The same user, so no
 * one is told of a change.
 */
export async function replaceSession(response: Response): Promise<void> {
  const body = (await response.json().catch(() => ({}))) as { token?: string; refreshToken?: string }
  if (!current || !body.token) return
  current = { ...current, token: body.token, refreshToken: body.refreshToken ?? current.refreshToken }
  write(current)
}

// The renewal in flight, shared: requests that all hit a run-out token at
// once renew it once.
let renewing: Promise<boolean> | null = null

// Renews the access token with the refresh token; false where there is
// none, the server refuses it (the session was ended, or has run its
// course) or cannot be reached.
function renewSession(): Promise<boolean> {
  renewing ??= (async () => {
    const held = current
    if (!held?.refreshToken) return false
    try {
      const status = await getServerStatus()
      if (!status.apiBase) return false
      const response = await fetch(`${status.apiBase}/auth/refresh`, {
        method: 'POST',
        cache: 'no-store',
        headers: { Authorization: `Bearer ${held.refreshToken}` },
      })
      if (!response.ok) return false
      const body = (await response.json()) as { token?: string }
      // Signed out, or signed in as someone else, meanwhile: not ours to set.
      if (!body.token || current !== held) return false
      current = { ...held, token: body.token }
      write(current)
      return true
    } catch {
      return false
    }
  })().finally(() => { renewing = null })
  return renewing
}
