// Does a server exist, and what kind?
//
// The whole client asks this question — every screen shows the answer, and the
// save/load flows branch on it — so it is resolved ONCE here and shared, rather
// than probed per screen. See docs/decisions/server-storage.md.
//
// The two-step shape mirrors the decision: the page's own origin serves a
// `/config.json` saying WHERE the storage is and how to authenticate; the
// storage itself says whether it is answering. Deliberately not a probe of
// localhost:8080 — an absent config.json is an unambiguous statement, a failed
// connection only an indication.

export type ServerState =
  // No server at all: no config.json, or one that names no API. The normal
  // state when developing and offline, not an error — though it IS the least
  // durable place for a world, since the browser may clear its own storage.
  | 'none'
  // Configured but not answering. The only state that warrants a warning.
  | 'unreachable'
  // Reachable with authMode `none`: nobody else authenticates, so this is a
  // single-user server — see below for why that is the local/shared signal.
  | 'local'
  // Reachable with a real auth mode: others can be here too.
  | 'remote'

export interface ServerStatus {
  state: ServerState
  // Base path for the API, e.g. "/v1". Empty when there is no server.
  apiBase: string
  authMode: string
  // Where to log in, from /config.json. Empty when there is nothing to log in
  // to — `none` mode, or no server at all.
  //
  // Read rather than derived from apiBase on purpose: the client has no
  // business knowing the server's route layout, and `oidc` will name a FOREIGN
  // url here that cannot be derived. See docs/decisions/server-auth.md.
  loginPath: string
  // Which modules the server runs, from /v1/capabilities. A frontend-only
  // deployment whose ingress does not route /v1 will simply be 'unreachable'.
  modules: string[]
  // How the server runs bakes: 'kubernetes' when each is a Job on another node,
  // 'subprocess' when it happens beside the server, '' when it does not bake.
  //
  // The client cannot infer this — the same API answers either way — and it
  // needs it BEFORE a bake starts, because the notification that announces one
  // picks its icon at creation and a notification's icon may not change.
  bakeRunner: string
}

interface RuntimeConfig {
  apiBase?: string
  authMode?: string
  login?: { path?: string }
}

interface Capabilities {
  modules?: string[]
  bakeRunner?: string
}

const OFFLINE: ServerStatus = { state: 'none', apiBase: '', authMode: 'none', loginPath: '', modules: [], bakeRunner: '' }

// How long a probe may take before the server counts as unreachable. Short on
// purpose: this gates the indicator on every screen, and a user staring at a
// blank corner because a dead host is still timing out is worse than a slightly
// eager "unreachable" they can retry.
const PROBE_TIMEOUT_MS = 3000

async function fetchJSON<T>(url: string, timeoutMs: number): Promise<T | null> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    // no-store rather than no-cache: this is how a deployment moves its
    // storage, and a stale copy would point the client at an address that no
    // longer answers.
    const response = await fetch(url, { cache: 'no-store', signal: abort.signal })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function probe(): Promise<ServerStatus> {
  const config = await fetchJSON<RuntimeConfig>('/config.json', PROBE_TIMEOUT_MS)
  if (!config || !config.apiBase) return OFFLINE

  const apiBase = config.apiBase
  const authMode = config.authMode ?? 'none'
  const loginPath = config.login?.path ?? ''
  const capabilities = await fetchJSON<Capabilities>(`${apiBase}/capabilities`, PROBE_TIMEOUT_MS)
  if (!capabilities) return { state: 'unreachable', apiBase, authMode, loginPath, modules: [], bakeRunner: '' }

  // Answering is not enough — the WORLD module has to be there.
  //
  // /v1/capabilities is mounted by the server process rather than by a module,
  // so `start -t client` (frontend only, storage elsewhere) answers it while
  // holding no worlds at all. Measured, not assumed: that configuration
  // returns {"modules":["client"]} and would otherwise have shown "local
  // server" right up until the first save failed.
  //
  // Checking the module list also happens to be correct in the split
  // deployment, where the ingress routes /v1 to the storage service and the
  // answer comes from there, listing `world`.
  const modules = capabilities.modules ?? []
  const bakeRunner = capabilities.bakeRunner ?? ''
  if (!modules.includes('world')) return { state: 'unreachable', apiBase, authMode, loginPath, modules, bakeRunner }

  // LOCAL vs SHARED comes from authMode, not from the hostname.
  //
  // The tempting signal is `location.hostname === 'localhost'`, but apiBase is
  // relative by default (that is what keeps CORS from ever existing), so the
  // URL carries no information about where the server actually runs — and the
  // hostname check reports a port-forwarded cluster service as local.
  //
  // authMode answers the question that is actually being asked. The design
  // defines `none` AS the local mode: a synthetic "local" identity owns
  // everything, so nobody else can be present. Anything else means real
  // identities, which means other people.
  const state: ServerState = authMode === 'none' ? 'local' : 'remote'
  return { state, apiBase, authMode, loginPath, modules, bakeRunner }
}

// Resolved once per page load and shared. A screen that mounts later gets the
// answer instantly instead of probing again — which also means the indicator
// cannot disagree with itself between two screens.
let pending: Promise<ServerStatus> | undefined
let current: ServerStatus | undefined

export function getServerStatus(): Promise<ServerStatus> {
  if (!pending) {
    pending = probe().then((status) => {
      current = status
      return status
    })
  }
  return pending
}

// The last known answer, or undefined before the first probe resolves. Lets a
// component render immediately when the answer is already in rather than
// flashing a placeholder on every screen change.
export function peekServerStatus(): ServerStatus | undefined {
  return current
}

// Re-probe. Called after a request fails against a server that was believed to
// be up, so the indicator reflects reality rather than the state at page load.
// There is deliberately no polling: a timer that checks a healthy server
// forever is noise, and the moments that matter are exactly the ones where
// something already went wrong.
export function refreshServerStatus(): Promise<ServerStatus> {
  pending = undefined
  current = undefined
  return getServerStatus()
}
