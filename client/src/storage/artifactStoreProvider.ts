import { createOpfsArtifactStore } from './OpfsArtifactStore'
import { createMemoryArtifactStore } from './MemoryArtifactStore'
import { createHttpArtifactStore } from './HttpArtifactStore'
import { createTieredArtifactStore } from './TieredArtifactStore'
import { getServerStatus } from '../server/serverStatus'
import { apiBase } from '../server/worldClient'
import type { ArtifactStore } from './ArtifactStore'
import { authHeaders } from '../server/session'

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
    createTieredArtifactStore(local, createHttpArtifactStore({ resolveBase: apiBase, authHeaders }), {
      // Asked per call rather than captured once. getServerStatus resolves a
      // single shared probe, so this is a promise lookup rather than a request
      // — but it still reflects a refresh after a failure, which a value
      // captured at construction could not.
      remoteAvailable: async () => {
        const status = await getServerStatus()
        return status.state === 'local' || status.state === 'remote'
      },
    }),
  )
  return tieredPending
}
