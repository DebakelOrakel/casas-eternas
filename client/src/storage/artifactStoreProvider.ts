import { createOpfsArtifactStore } from './OpfsArtifactStore'
import { createMemoryArtifactStore } from './MemoryArtifactStore'
import { createHttpArtifactStore } from './HttpArtifactStore'
import { createTieredArtifactStore } from './TieredArtifactStore'
import { getServerStatus, refreshServerStatus } from '../server/serverStatus'
import { apiBase } from '../server/worldClient'
import type { ArtifactStore } from './ArtifactStore'
import { authFetch } from '../server/session'

// One artifact store per page, resolved lazily and shared.
//
// Module-level rather than owned by a screen because the cache outlives any
// single screen: the worldmap fills it, and the storage panel reachable from
// the generator inspects the same entries. Two independently created stores
// would not be wrong (they address the same files), but each would probe
// OPFS again and neither could see the other's fallback state.
//
// TWO accessors, and the difference matters. The bake reads and writes through
// the TIERED store, so a world baked on another machine arrives as a download
// instead of as minutes of computation. Inventory and deletion go through the
// LOCAL one, because "clear my cache" must mean this machine — reaching across
// to drop a shared server's copy is a different act with a different blast
// radius, and the storage panel says so explicitly when it offers it.

let localPending: Promise<ArtifactStore> | null = null
let tieredPending: Promise<ArtifactStore> | null = null

// Throttle for re-probing an 'unreachable' verdict (see remoteAvailable below).
// One read of a baked stage asks remoteAvailable several times back to back —
// meta, elevation, rivers, lengths — and each probe costs up to 3 s against a
// server that is genuinely down, so the retry has to be per window, not per ask.
const UNREACHABLE_RETRY_MS = 30_000
let lastUnreachableRetry = 0

// This machine's own cache. Falls back to memory when OPFS is unavailable
// (insecure context, older browser, storage denied): the session still gets
// its within-session hits, and callers never have to branch on it.
export function getLocalArtifactStore(): Promise<ArtifactStore> {
  localPending ??= createOpfsArtifactStore().then((store) => store ?? createMemoryArtifactStore())
  return localPending
}

// The store the BAKE should use: local, then the server, then compute.
//
// This is the COMPOSITION ROOT for artifact storage, and the one place in
// `storage/` that may know about `server/`: deciding local-versus-remote and
// supplying the base URL is precisely its job. The stores themselves stay
// ignorant of both.
export function getArtifactStore(): Promise<ArtifactStore> {
  tieredPending ??= getLocalArtifactStore().then((local) =>
    createTieredArtifactStore(local, createHttpArtifactStore({ resolveBase: apiBase, fetch: authFetch }), {
      // Asked per call rather than captured once. getServerStatus resolves a
      // single shared probe, so this is a promise lookup rather than a request
      // — but it still reflects a refresh after a failure, which a value
      // captured at construction could not.
      remoteAvailable: async () => {
        let status = await getServerStatus()
        // 'unreachable' gets ONE retry per window rather than sticking for the
        // whole page. The probe runs once at load with a 3 s timeout, and
        // nothing between then and an artifact read re-asks — so a server that
        // was restarting at that moment silently degraded every later read
        // into "bake it yourself", which on a real world is minutes of
        // duplicate work for an artifact the server is holding. Found that
        // way, 2026-08-11.
        //
        // Only 'unreachable' — a CONFIGURED server that did not answer, the one
        // verdict a moment can change. 'none' means the page's own origin
        // served no config.json naming an API, which serverStatus calls "an
        // unambiguous statement", and re-asking would contradict that design.
        if (status.state === 'unreachable' && Date.now() - lastUnreachableRetry > UNREACHABLE_RETRY_MS) {
          lastUnreachableRetry = Date.now()
          status = await refreshServerStatus()
        }
        return status.state === 'local' || status.state === 'remote'
      },
    }),
  )
  return tieredPending
}
