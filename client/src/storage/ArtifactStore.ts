// A place to put big, deterministically recomputable blobs — today the
// amplification bake's output (docs/decisions/worldmap-amplification.md),
// which costs minutes to produce and is identical for every consumer of the
// same world.
//
// ADDRESSING (2026-08-12): an artifact is an opaque minted uid; the LOGICAL
// key below appears in exactly one operation, `resolve`, which maps it to a
// handle. Everything a store lists or reindexes comes from each entry's own
// meta.json — never from path shapes. That is the robustness lesson the
// path-encoded layouts kept teaching: every schema change made walkers blind
// and left ghost bytes nothing could list. Now a schema change edits meta
// fields, and a hand-copied entry (any directory name) is indexed as soon as
// its meta is readable.
//
// Everything here treats failure as ordinary. A cache over recomputable data
// has no correctness story to protect: a miss, a denied quota, an evicted
// entry and a corrupt read all have the same consequence — compute it again.
// Hence null/false returns rather than throws.

export interface StorageUsage {
  usedBytes: number
  quotaBytes: number
}

// The logical identity of one bake — what `resolve` translates into storage.
// TWO world components on purpose, one per identity (world/identity.ts):
// `worldUid` is the stable "which world do you own" key, `worldId` the
// content hash of the exact terrain that actually determines the bytes.
export interface ArtifactKey {
  worldUid: string
  worldId: string
  pipelineVersion: string
  stage: string
}

// Sentinel uid for worlds that have none — never saved, or a save too old to
// carry one where the reader deliberately does not derive it (see
// loadWorldInputs). Such artifacts never map to a deletable world; re-saving
// the world heals the split.
export const NO_UID = 'no-uid'

// The one place the sentinel is applied, so every caller builds keys the
// same way.
export function artifactKey(worldUid: string, worldId: string, pipelineVersion: string, stage: string): ArtifactKey {
  return { worldUid: worldUid || NO_UID, worldId, pipelineVersion, stage }
}

// What `resolve` hands back: where the artifact lives (per tier — the tiered
// store fills both) and which files it currently holds. The files list IS the
// batch existence answer: an entry is as complete as the files it can name.
export interface ArtifactHandle {
  // The key this handle answers for — carried so a later step can mint the
  // entry in another tier (the tiered read backfills a remote hit into a
  // local entry it creates on demand).
  key: ArtifactKey
  files: string[]
  // The artifact's uid in the local store, when it exists there.
  local?: string
  // The artifact's uid on the server, when it exists there. The two differ
  // for the same content — uids are minted per store; identity is the KEY,
  // carried by the meta that travels with the files.
  remote?: string
}

export interface ArtifactStore {
  // Null when the key is absent (create false) or could not be resolved.
  resolve(key: ArtifactKey, create: boolean): Promise<ArtifactHandle | null>
  // Null when the file holds nothing (or could not be read — see above).
  read(handle: ArtifactHandle, name: string): Promise<ArrayBuffer | null>
  // False when the bytes were not stored, for any reason. Never throws for
  // an expected condition; callers must carry on regardless.
  write(handle: ArtifactHandle, name: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean>
}

// One listed entry, flattened the same way the server's listing is, so both
// tiers group through one function (artifactAdmin.groupArtifacts). Meta
// fields are empty/zero for an entry with no readable meta — bytes with a
// name, reported rather than haunting the usage total.
export interface StoredArtifact {
  artifactUid: string
  bytes: number
  worldUid: string
  worldId: string
  pipelineVersion: string
  stage: string
  label: string
  width: number
  height: number
  bakeMs: number
}

// The inventory half, implemented by LOCAL stores (the storage panel's "this
// machine" section); the server's inventory is its own listing endpoint.
export interface ArtifactInventory {
  list(): Promise<StoredArtifact[]>
  removeArtifact(artifactUid: string): Promise<void>
  clear(): Promise<void>
  usage(): Promise<StorageUsage | null>
}

export type LocalArtifactStore = ArtifactStore & ArtifactInventory
