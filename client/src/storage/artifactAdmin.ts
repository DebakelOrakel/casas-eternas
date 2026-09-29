import type { LocalArtifactStore } from './ArtifactStore'

// Housekeeping and view-shaping for the artifact cache. Either tier lists
// FLAT entries (uid + meta fields, one shape for both); this module folds them
// into the rows the artifact window shows — one function, so the two tiers
// cannot drift.

export async function clearArtifacts(store: LocalArtifactStore): Promise<void> {
  await store.clear()
}

// One stored artifact, from either tier, as the window needs it.
export interface ArtifactEntry {
  artifactUid: string
  bytes: number
  worldUid: string
  worldId: string
  pipelineVersion: string
  stage: string
  label: string
  where: 'local' | 'server'
  // Whether the viewer may delete it: always on this machine; on the server
  // from its world's editor up.
  deletable: boolean
}

// What an artifact is: a finer level of the world (stage `L1`, `L2`, …, the
// level bake's), or something this client cannot name — a meta-less entry,
// or one from a bake that no longer exists (the raster bake's stages 2/4).
export type ArtifactKind = 'level' | 'unknown'

// One row: every artifact of one kind for one world, wherever it is kept.
export interface ArtifactRow {
  worldUid: string
  kind: ArtifactKind
  label: string
  // The levels present (1, 2, …); empty for the unknown kind.
  levels: number[]
  local: boolean
  server: boolean
  bytes: number
  // Outdated: some entry was baked by another pipeline version than this
  // client's; the unknown kind always is.
  stale: boolean
  deletable: boolean
  entries: ArtifactEntry[]
}

// The level an entry holds, from its stage (`L1` → 1), or null.
export function entryLevel(entry: ArtifactEntry): number | null {
  const match = /^L(\d+)$/.exec(entry.stage)
  return match ? Number(match[1]) : null
}

// `current` answers whether an entry's pipeline version is this client's for
// its level (world/meshArtifacts, which this module may not import).
export function artifactRows(entries: readonly ArtifactEntry[], current: (entry: ArtifactEntry, level: number) => boolean): ArtifactRow[] {
  const rows = new Map<string, ArtifactRow>()
  for (const entry of entries) {
    const level = entryLevel(entry)
    const kind: ArtifactKind = level === null ? 'unknown' : 'level'
    // Entries without a world stay on rows of their own: nothing joins them.
    const key = `${entry.worldUid || `?${entry.artifactUid}`}|${kind}`
    let row = rows.get(key)
    if (!row) {
      row = { worldUid: entry.worldUid, kind, label: entry.label, levels: [], local: false, server: false, bytes: 0, stale: false, deletable: true, entries: [] }
      rows.set(key, row)
    }
    row.entries.push(entry)
    row.bytes += entry.bytes
    if (entry.where === 'local') row.local = true
    else row.server = true
    if (!row.label) row.label = entry.label
    if (level !== null && !row.levels.includes(level)) row.levels.push(level)
    if (level === null || !current(entry, level)) row.stale = true
    if (!entry.deletable) row.deletable = false
  }
  for (const row of rows.values()) row.levels.sort((a, b) => a - b)
  return [...rows.values()].sort((a, b) => b.bytes - a.bytes)
}
