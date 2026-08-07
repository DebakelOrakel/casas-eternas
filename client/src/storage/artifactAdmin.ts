import type { ArtifactStore } from './ArtifactStore'

// Minimal housekeeping for the artifact cache — deliberately just "how much
// is in there" and "throw it all away", which is all a cache over
// recomputable data needs to be operable while it is still a debug
// affordance. Per-entry eviction (LRU against a size cap) is the obvious
// next step and is NOT here: it needs an access-time index that nothing yet
// reads, and until worlds accumulate, "clear everything" is the same
// operation with less machinery.

// Everything the cache writes lives under this one prefix, so removing it is
// the whole clear operation (see ArtifactStore's path grammar).
const ROOT = 'worlds'

export async function clearArtifacts(store: ArtifactStore): Promise<void> {
  await store.remove(ROOT)
}

export async function removeCachedWorld(store: ArtifactStore, worldId: string): Promise<void> {
  // The world id is the whole subtree — every pipeline version and every
  // stage baked for it.
  await store.remove(`${ROOT}/${worldId}`)
}

// One baked tier of one world, as the manager lists it.
export interface CachedStage {
  // The amplification factor the entry was baked at.
  stage: string
  width: number
  height: number
  bytes: number
  bakeMs: number
  createdAt: number
}

export interface CachedWorld {
  worldId: string
  // The readable half of the id — the seed the world was generated from
  // (see artifactKey.deriveWorldId), which is the only part a human can
  // recognise.
  label: string
  bytes: number
  stages: CachedStage[]
}

// Grid width → the shorthand people actually use for it. Derived rather than
// tabulated so 16384 keeps working the day someone tries it.
export const resolutionLabel = (width: number): string => `${Math.round(width / 1024)}k`

const FILE_NAMES = ['elevation.u16', 'rivers.f32', 'riverLengths.u32', 'meta.json']

// Walks the cache tree and reports what is in it. Sizes come from the
// filesystem's own metadata (see ArtifactStore.size), so this stays cheap
// even when the entries are tens of megabytes; only the tiny meta.json is
// actually read, because width/height and the bake cost live there rather
// than in the path.
//
// Entries that fail to parse are skipped rather than reported as errors: an
// inventory of a cache should show what is usable, and anything else is
// something `clear` will deal with.
export async function listCachedWorlds(store: ArtifactStore): Promise<CachedWorld[]> {
  const worlds: CachedWorld[] = []
  for (const worldId of await store.listDirectory(ROOT)) {
    const stages: CachedStage[] = []
    let worldBytes = 0
    for (const version of await store.listDirectory(`${ROOT}/${worldId}/amp`)) {
      for (const stage of await store.listDirectory(`${ROOT}/${worldId}/amp/${version}`)) {
        const directory = `${ROOT}/${worldId}/amp/${version}/${stage}`
        let bytes = 0
        for (const file of FILE_NAMES) bytes += (await store.size(`${directory}/${file}`)) ?? 0
        worldBytes += bytes
        const metaBytes = await store.read(`${directory}/meta.json`)
        if (!metaBytes) continue
        try {
          const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as { width: number; height: number; bakeMs: number; createdAt: number }
          stages.push({ stage, width: meta.width, height: meta.height, bytes, bakeMs: meta.bakeMs, createdAt: meta.createdAt })
        } catch {
          // Unreadable metadata: its bytes still count toward the world's
          // size (they are occupying the disk), but it cannot be described.
        }
      }
    }
    if (stages.length === 0 && worldBytes === 0) continue
    stages.sort((a, b) => a.width - b.width)
    worlds.push({
      worldId,
      label: worldId.slice(0, worldId.lastIndexOf('-')) || worldId,
      bytes: worldBytes,
      stages,
    })
  }
  worlds.sort((a, b) => b.bytes - a.bytes)
  return worlds
}

export const formatBytes = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`

// Deliberately reports the ORIGIN's usage rather than a tree-walked sum of
// the cache's own files: for this app they are the same number to within
// rounding, and the honest one is what the browser will actually enforce a
// quota against. Null when the browser declines to estimate.
export async function describeArtifactUsage(store: ArtifactStore): Promise<string | null> {
  const usage = await store.usage()
  if (!usage) return null
  const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(bytes < 1e8 ? 1 : 0)} MB`
  // A quota of 0 means "not reported" (the memory store says so), in which
  // case a share would be meaningless.
  if (usage.quotaBytes <= 0) return mb(usage.usedBytes)
  const share = (usage.usedBytes / usage.quotaBytes) * 100
  return `${mb(usage.usedBytes)} / ${mb(usage.quotaBytes)} (${share.toFixed(share < 1 ? 2 : 0)}%)`
}
