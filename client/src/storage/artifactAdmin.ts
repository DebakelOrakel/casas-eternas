import type { LocalArtifactStore } from './ArtifactStore'

// Housekeeping for the artifact cache.

export async function clearArtifacts(store: LocalArtifactStore): Promise<void> {
  await store.clear()
}
