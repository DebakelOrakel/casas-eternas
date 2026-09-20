import type { LocalArtifactStore, StoredArtifact } from './ArtifactStore'

// Housekeeping and view-shaping for the artifact cache. The store lists FLAT
// entries (uid + meta fields, identical in shape to the server's listing);
// this module folds either tier's list into the grouping the panel renders —
// one function, so the two sections cannot drift.

export async function clearArtifacts(store: LocalArtifactStore): Promise<void> {
  await store.clear()
}

// One baked tier, as the panel lists it.
export interface CachedStage {
  stage: string
  width: number
  height: number
  bytes: number
  bakeMs: number
}

// One pipeline version of one terrain — a LINE in the panel: the stages this
// exact algorithm + constants combination has produced.
export interface CachedVersion {
  pipelineVersion: string
  bytes: number
  stages: CachedStage[]
}

// One terrain (content hash) of a world — several accumulate as a world is
// eroded on, and telling them apart is what the panel's lines exist for.
export interface CachedTerrain {
  worldId: string
  bytes: number
  versions: CachedVersion[]
}

export interface CachedWorld {
  // The owning world's uid — NO_UID for worlds never saved with one, and the
  // artifact's own uid for an entry whose meta is unreadable (bytes with a
  // name, still deletable).
  worldUid: string
  label: string
  bytes: number
  terrains: CachedTerrain[]
  // Every artifact uid in this group — the unit deletion works in.
  artifactUids: string[]
}

// Grid width → the shorthand people actually use for it. Derived rather than
// tabulated so 16384 keeps working the day someone tries it. Uppercase K,
// matching the bake buttons in the erosion panel.
export const resolutionLabel = (width: number): string => `${Math.round(width / 1024)}K`

// Folds a flat listing into world groups: uid → terrain → version → stages.
// Entries without a readable meta (no key fields) become their own group so
// their bytes stay visible and deletable — the phantom-total lesson.
export function groupArtifacts(entries: StoredArtifact[]): CachedWorld[] {
  const byUid = new Map<string, CachedWorld>()
  for (const entry of entries) {
    if (!entry.worldUid) {
      byUid.set(`?${entry.artifactUid}`, {
        worldUid: entry.artifactUid,
        label: entry.artifactUid,
        bytes: entry.bytes,
        terrains: [],
        artifactUids: [entry.artifactUid],
      })
      continue
    }
    let world = byUid.get(entry.worldUid)
    if (!world) {
      world = { worldUid: entry.worldUid, label: '', bytes: 0, terrains: [], artifactUids: [] }
      byUid.set(entry.worldUid, world)
    }
    world.label ||= entry.label
    world.bytes += entry.bytes
    world.artifactUids.push(entry.artifactUid)
    let terrain = world.terrains.find((candidate) => candidate.worldId === entry.worldId)
    if (!terrain) {
      terrain = { worldId: entry.worldId, bytes: 0, versions: [] }
      world.terrains.push(terrain)
    }
    terrain.bytes += entry.bytes
    let version = terrain.versions.find((candidate) => candidate.pipelineVersion === entry.pipelineVersion)
    if (!version) {
      version = { pipelineVersion: entry.pipelineVersion, bytes: 0, stages: [] }
      terrain.versions.push(version)
    }
    version.bytes += entry.bytes
    version.stages.push({ stage: entry.stage, width: entry.width, height: entry.height, bytes: entry.bytes, bakeMs: entry.bakeMs })
  }
  const worlds = [...byUid.values()]
  for (const world of worlds) {
    world.label ||= world.worldUid
    world.terrains.sort((a, b) => b.bytes - a.bytes)
    for (const terrain of world.terrains) {
      terrain.versions.sort((a, b) => a.pipelineVersion.localeCompare(b.pipelineVersion))
      for (const version of terrain.versions) version.stages.sort((a, b) => a.width - b.width)
    }
  }
  worlds.sort((a, b) => b.bytes - a.bytes)
  return worlds
}

// Deliberately reports the ORIGIN's usage rather than a tree-walked sum of
// the cache's own files: for this app they are the same number to within
// rounding, and the honest one is what the browser will actually enforce a
// quota against. Null when the browser declines to estimate.
export async function describeArtifactUsage(store: LocalArtifactStore): Promise<string | null> {
  const usage = await store.usage()
  if (!usage) return null
  const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(bytes < 1e8 ? 1 : 0)} MB`
  // A quota of 0 means "not reported" (the memory store says so), in which
  // case a share would be meaningless.
  if (usage.quotaBytes <= 0) return mb(usage.usedBytes)
  const share = (usage.usedBytes / usage.quotaBytes) * 100
  return `${mb(usage.usedBytes)} / ${mb(usage.quotaBytes)} (${share.toFixed(share < 1 ? 2 : 0)}%)`
}
