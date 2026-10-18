import JSZip from 'jszip'
import { createOpfsWorldStore, type WorldArchiveStore } from '../storage/OpfsWorldStore'
import { readRecipeValue } from './save/recipeYaml'
import { worldKindOf, type WorldKind } from './worldRecord'
import { progressStepOf, type ProgressStep } from './worldProgress'

// Worlds this browser keeps for itself — the third save target beside the
// server and a download.
//
// World-layer, not storage-layer: this is the module that knows a save has a
// name, a seed, a revision and an erosion count, and that those are the same
// facts the server's world list reports. `storage/OpfsWorldStore` underneath
// it only moves an archive, a thumbnail and an opaque blob of metadata — which
// is the split CLAUDE.md asks for, and the reason the storage layer can stay
// ignorant of what a world is.
//
// The summary below deliberately mirrors `server/worldClient`'s WorldSummary,
// because the load screen lists both kinds side by side and a row that means
// the same thing should not have to be read twice. It carries one field the
// server's does not — `seed` — because here it costs nothing, and one fewer:
// there is no owner, since a world in your own browser has no one else to
// belong to.

export interface BrowserWorldMeta {
  // What the save calls itself (`metadata.name` in world.yaml). The generator
  // writes the seed there today, so the two usually read alike; they are kept
  // apart because a world that arrived from elsewhere may carry a real name.
  name: string
  seed: string
  revision: number
  erosionRun: number
  // When this browser wrote it, ISO 8601 — or, for a copy taken from the
  // server, when the server got it. The server reports createdAt and
  // updatedAt separately; here there is only ever the one write that counts,
  // because keeping it again replaces what was there.
  savedAt: string
  // The client build that produced the archive — the same string the save's
  // own `status.generator` carries, so a world kept by an older build can be
  // recognised without opening it.
  generator: string
  // The pipeline that made it, the save's `status.pipeline` ('' for none).
  // Since 2026-10-18; an older entry has none until completeBrowserWorld
  // fills it in.
  pipeline?: string
  // The save's kind, its shape (worldRecord.ts), so the list can say it
  // without opening the archive. Since 2026-10-11; an older entry has none
  // until completeBrowserWorld fills it in.
  kind?: WorldKind
  // The last step the user accepted (worldProgress.ts), null for none. Same
  // age as `kind`.
  progress?: ProgressStep | null
  // SHA-256 of the archive bytes, lowercase hex — the same hash the server
  // keeps as `contentHash`, so the list can tell whether the two places hold
  // the same version. Computed here at every write, never by the caller.
  // Same age as `kind`.
  contentHash?: string
}

export interface BrowserWorld extends BrowserWorldMeta {
  uid: string
  bytes: number
  hasThumbnail: boolean
}

// One store per page, created on first use. The factory probes the platform
// and does I/O, so it is not something each caller should repeat; the promise
// is memoised rather than the store, so concurrent first callers share one
// probe instead of racing two.
let storePromise: Promise<WorldArchiveStore<BrowserWorldMeta> | null> | undefined

function store(): Promise<WorldArchiveStore<BrowserWorldMeta> | null> {
  storePromise ??= createOpfsWorldStore<BrowserWorldMeta>()
  return storePromise
}

// Whether this browser can keep worlds at all. False on a browser without
// OPFS or outside a secure context — the save menu hides the target rather
// than offering one that is certain to fail.
export async function canKeepWorldsInBrowser(): Promise<boolean> {
  return (await store()) !== null
}

// Keeps (or replaces) a world under its uid. False when the write did not
// happen — no store, or the browser refused, which in practice means the
// quota. The caller says so; this module does not notify, because what a
// failure should look like is a screen's decision.
export async function keepWorldInBrowser(
  uid: string,
  archive: Blob,
  meta: Omit<BrowserWorldMeta, 'contentHash'>,
  thumbnail: Blob | null,
): Promise<boolean> {
  const opfs = await store()
  if (!opfs) return false
  return opfs.put(uid, archive, { ...meta, contentHash: await archiveContentHash(archive) }, thumbnail)
}

// SHA-256 of an archive's bytes, lowercase hex: the algorithm and the
// encoding of the server's `contentHash` (internal/modules/world/store.go),
// so equal hashes mean byte-identical archives in both places. Empty where
// the browser offers no digest (outside a secure context, where this
// browser keeps no worlds either); an empty hash compares as unknown.
export async function archiveContentHash(archive: Blob): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return ''
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await archive.arrayBuffer()))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// What a save says of itself in world.yaml, as the meta above holds it.
// Null when the archive is no zip or carries no world.yaml.
async function readArchiveFacts(archive: Blob): Promise<{ yaml: string; preview: Blob | null } | null> {
  try {
    const zip = await JSZip.loadAsync(await archive.arrayBuffer())
    const yaml = await zip.file('world.yaml')?.async('string')
    if (!yaml) return null
    const preview = await zip.file('preview.png')?.async('blob')
    return { yaml, preview: preview ? new Blob([preview], { type: 'image/png' }) : null }
  } catch {
    return null
  }
}

// Keeps an archive that came from elsewhere — the server's copy of a world —
// with its meta read from its own world.yaml and its thumbnail from its own
// preview. `savedAt` is when the source saved it. False when the archive is
// no world with a uid, or the write failed.
export async function keepArchiveInBrowser(archive: Blob, savedAt: string): Promise<boolean> {
  const facts = await readArchiveFacts(archive)
  const uid = facts ? readRecipeValue(facts.yaml, 'metadata.uid') : undefined
  if (!facts || !uid) return false
  const seed = readRecipeValue(facts.yaml, 'spec.seed') ?? ''
  return keepWorldInBrowser(uid, archive, {
    name: readRecipeValue(facts.yaml, 'metadata.name') ?? seed,
    seed,
    revision: Number(readRecipeValue(facts.yaml, 'status.revision') ?? 0),
    erosionRun: Number(readRecipeValue(facts.yaml, 'status.erosionRun') ?? 0),
    savedAt,
    generator: readRecipeValue(facts.yaml, 'status.generator') ?? '',
    pipeline: readRecipeValue(facts.yaml, 'status.pipeline') ?? '',
    kind: worldKindOf(facts.yaml) ?? undefined,
    progress: progressStepOf(readRecipeValue(facts.yaml, 'status.progress')),
  }, facts.preview)
}

// Whether an entry was kept before its meta carried the kind and the hash.
export function browserWorldIncomplete(world: BrowserWorld): boolean {
  return world.kind === undefined || world.contentHash === undefined || world.pipeline === undefined
}

// Fills in what an older entry's meta lacks — the kind and the progress from
// its world.yaml, the hash from its bytes — and writes it back, so this is
// done once per world. Reads the whole archive: call it after the list is
// shown, not before. The entry as it is now, or null when it is gone.
export async function completeBrowserWorld(uid: string): Promise<BrowserWorld | null> {
  const opfs = await store()
  if (!opfs) return null
  const entry = (await opfs.list()).find((stored) => stored.uid === uid)
  const archive = entry ? await opfs.get(uid) : null
  if (!entry || !archive) return null
  const meta: BrowserWorldMeta = { ...entry.meta }
  if (meta.kind === undefined || meta.progress === undefined || meta.pipeline === undefined) {
    const facts = await readArchiveFacts(archive)
    // A world.yaml with a kind this client does not know stays without one;
    // it is asked again next time, which costs a read and says nothing wrong.
    meta.kind ??= facts ? worldKindOf(facts.yaml) ?? undefined : undefined
    if (meta.progress === undefined && facts) meta.progress = progressStepOf(readRecipeValue(facts.yaml, 'status.progress'))
    if (meta.pipeline === undefined && facts) meta.pipeline = readRecipeValue(facts.yaml, 'status.pipeline') ?? ''
  }
  meta.contentHash ??= await archiveContentHash(archive)
  await opfs.putMeta(uid, meta)
  return { uid, bytes: entry.bytes, hasThumbnail: entry.hasThumbnail, ...meta }
}

// Newest first, which is the order a list of worlds is nearly always wanted
// in. Sorted here rather than at each call site: the store returns directory
// order, which is neither stable nor meaningful.
export async function listBrowserWorlds(): Promise<BrowserWorld[]> {
  const opfs = await store()
  if (!opfs) return []
  const stored = await opfs.list()
  return stored
    .map((entry) => ({ uid: entry.uid, bytes: entry.bytes, hasThumbnail: entry.hasThumbnail, ...entry.meta }))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

// The archive, ready to hand to the same reader a picked file goes through —
// a world from here and a world from disk must take one path, or the two
// would drift (see `world/query.openWorld`).
export async function openBrowserWorld(uid: string): Promise<Blob | null> {
  const opfs = await store()
  return opfs ? opfs.get(uid) : null
}

export async function browserWorldThumbnail(uid: string): Promise<Blob | null> {
  const opfs = await store()
  return opfs ? opfs.thumbnail(uid) : null
}

export async function forgetBrowserWorld(uid: string): Promise<void> {
  const opfs = await store()
  await opfs?.remove(uid)
}
