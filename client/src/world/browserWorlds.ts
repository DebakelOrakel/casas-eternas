import { createOpfsWorldStore, type WorldArchiveStore } from '../storage/OpfsWorldStore'

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
  // When this browser wrote it, ISO 8601. The server reports createdAt and
  // updatedAt separately; here there is only ever the one write that counts,
  // because keeping it again replaces what was there.
  savedAt: string
  // The client build that produced the archive — the same string the save's
  // own `status.generator` carries, so a world kept by an older build can be
  // recognised without opening it.
  generator: string
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
  meta: BrowserWorldMeta,
  thumbnail: Blob | null,
): Promise<boolean> {
  const opfs = await store()
  if (!opfs) return false
  return opfs.put(uid, archive, meta, thumbnail)
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
