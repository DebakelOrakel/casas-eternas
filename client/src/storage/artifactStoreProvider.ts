import { createOpfsArtifactStore } from './OpfsArtifactStore'
import { createMemoryArtifactStore } from './MemoryArtifactStore'
import type { ArtifactStore } from './ArtifactStore'

// One artifact store per page, resolved lazily and shared.
//
// Module-level rather than owned by a screen because the cache outlives any
// single screen: the worldmap fills it, and the cache manager reachable from
// the generator inspects the same entries. Two independently created stores
// would not be wrong (they address the same files), but each would probe
// OPFS again and neither could see the other's fallback state.
let pending: Promise<ArtifactStore> | null = null

export function getArtifactStore(): Promise<ArtifactStore> {
  // Falls back to memory when OPFS is unavailable (insecure context, older
  // browser, storage denied): the session still gets its within-session
  // hits, and callers never have to branch on it.
  pending ??= createOpfsArtifactStore().then((store) => store ?? createMemoryArtifactStore())
  return pending
}
