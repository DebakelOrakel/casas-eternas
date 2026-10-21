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
//
// ONE EXCEPTION, the HTTP store (2026-10-16): a server that does not answer
// (network, TLS, 5xx) is not a miss. It throws ArtifactStoreUnavailableError
// instead, and each caller decides: the browser's tiered store goes on as on
// a miss (local, then compute), the job worker gives its task back to the
// relay, because a level or a tile that IS in the store must not be
// computed again for hours, and one that a tile needs is not "absent".

// The store could not answer — not "absent". Thrown by the HTTP store only
// (see above); `status` is the HTTP status when there was one.
export class ArtifactStoreUnavailableError extends Error {
  readonly status?: number
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ArtifactStoreUnavailableError'
    this.status = status
  }
}

// The store answered, and refused for good: a 4xx other than 404 (no right,
// a token that is not valid, a request it cannot take) on a resolve or a
// read. Asking again does not change the answer, so the job worker reports
// the task as failed at once instead of giving it back (jobWorker.ts).
// Thrown by the HTTP store only; the browser's tiered store takes it as a
// miss, as every other failure. A write that the server refuses stays false.
export class ArtifactStoreRefusedError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ArtifactStoreRefusedError'
    this.status = status
  }
}

export interface StorageUsage {
  usedBytes: number
  quotaBytes: number
}

// The logical identity of one bake — what `resolve` translates into storage.
// The CONTENT only (docs/decisions/artifacts-by-content.md, DEC-0039):
// `worldId` is the hash of the exact terrain (world/identity.ts), and with
// the pipeline version and the stage it determines the bytes. So one
// artifact serves every world with that terrain — a copy of a template
// finds the template's at once. Which world a reader reads through is the
// server's question (the worlds' terrain ids), not part of the key.
export interface ArtifactKey {
  worldId: string
  pipelineVersion: string
  stage: string
}

// The one place a key is built, so every caller builds it the same way.
export function artifactKey(worldId: string, pipelineVersion: string, stage: string): ArtifactKey {
  return { worldId, pipelineVersion, stage }
}

// Whether a meta.json's key is of the format before DEC-0039, which named
// the world's uid too: such an entry is not read (the local stores drop it,
// the server takes it for junk).
export function isOldKey(key: unknown): boolean {
  return typeof key === 'object' && key !== null && 'worldUid' in key
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
  // The HTTP store throws ArtifactStoreUnavailableError when its server does
  // not answer (see above), ArtifactStoreRefusedError when it refuses (a 4xx
  // other than 404).
  resolve(key: ArtifactKey, create: boolean): Promise<ArtifactHandle | null>
  // Null when the file holds nothing (or could not be read — see above).
  // The HTTP store: null only for a 404, else it throws as resolve does.
  read(handle: ArtifactHandle, name: string): Promise<ArrayBuffer | null>
  // False when the bytes were not stored, for any reason. Never throws for
  // an expected condition; callers must carry on regardless. The HTTP store
  // throws as resolve does when its server does not answer; a refusal
  // (4xx) is false.
  write(handle: ArtifactHandle, name: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean>
  // The files of an artifact, meta.json last: true when all were stored.
  // A store that can do better than one write after the other has it (the
  // HTTP store by link: all at once, one commit); callers use
  // writeArtifactFiles, which falls back to writeInTurn.
  writeFiles?(handle: ArtifactHandle, files: ArtifactFile[]): Promise<boolean>
}

export interface ArtifactFile {
  name: string
  bytes: ArrayBuffer | ArrayBufferView
}

// One write after the other, in order, up to the first that fails.
export async function writeInTurn(store: ArtifactStore, handle: ArtifactHandle, files: ArtifactFile[]): Promise<boolean> {
  for (const file of files) {
    if (!(await store.write(handle, file.name, file.bytes))) return false
  }
  return true
}

export function writeArtifactFiles(store: ArtifactStore, handle: ArtifactHandle, files: ArtifactFile[]): Promise<boolean> {
  return store.writeFiles ? store.writeFiles(handle, files) : writeInTurn(store, handle, files)
}

// One listed entry, flattened the same way the server's listing is, so both
// tiers group through one function (artifactAdmin.groupArtifacts). Meta
// fields are empty/zero for an entry with no readable meta — bytes with a
// name, reported rather than haunting the usage total.
export interface StoredArtifact {
  artifactUid: string
  bytes: number
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
