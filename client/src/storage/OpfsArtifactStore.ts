import type { ArtifactHandle, ArtifactKey, LocalArtifactStore, StorageUsage, StoredArtifact } from './ArtifactStore'

// LocalArtifactStore backed by the Origin Private File System — a real,
// on-disk, origin-scoped filesystem the browser hands the page, which
// survives reloads and restarts and takes binary natively (no base64, no
// serialisation).
//
// Layout mirrors the server's: `artifacts/{artifactUid}/…` with meta.json as
// the only truth about what an entry is. The uid is minted locally
// (crypto.randomUUID) and never travels — the same content on the server has
// a different uid there, and identity lives in the meta's key.
//
// The key→uid index is built by reading every entry's meta.json once per
// page and maintained on writes and removals. No mtime dance like the Go
// store: within one page this store is the only writer, and a second tab's
// writes costing a re-read after reload is a cache being a cache.
//
// Three properties of the platform worth knowing, all of them harmless here
// because the data is recomputable:
//  - storage is scoped to the ORIGIN, port included — hence the pinned dev
//    port in vite.config.ts, without which the cache silently empties
//    whenever vite picks a different port;
//  - the browser may EVICT under disk pressure, and Safari clears storage
//    for sites unvisited for about a week;
//  - quota is a share of free disk, reported by navigator.storage.estimate.

const ROOT = 'artifacts'

// The local cache's own budget, enforced with the same policy as the server's
// artifacts.cap: least-recently-used artifacts go once the cache outgrows
// it, meta-less junk first. 4 GB holds roughly fifty baked stages — far more
// than one person iterates on — while staying well under the pressure at
// which browsers start evicting origins wholesale (that remains the second
// net, documented above). A CONSTANT rather than a setting: cache tuning, not
// operator surface.
const LOCAL_CAP_BYTES = 4e9

// How often the sweep may walk the tree. Writes arrive in bursts (a bake
// lands four files back to back); one walk per burst is plenty.
const SWEEP_INTERVAL_MS = 30_000

interface ParsedMeta {
  key?: Partial<ArtifactKey>
  label?: string
  width?: number
  height?: number
  bakeMs?: number
}

const keyString = (key: ArtifactKey): string => `${key.worldUid}\0${key.worldId}\0${key.pipelineVersion}\0${key.stage}`

// OPFS lives behind a secure context and a reasonably current browser. The
// factory probes rather than assuming, and returns null when unavailable so
// a caller can carry on with no cache at all.
export async function createOpfsArtifactStore(): Promise<LocalArtifactStore | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null
  let opfsRoot: FileSystemDirectoryHandle
  try {
    opfsRoot = await navigator.storage.getDirectory()
  } catch {
    return null
  }

  // One-time sweep of the pre-2026-08-11 cache root (`worlds/…`) — those
  // entries were stale under every current key and nothing else ever wrote
  // there. (Trees from the short-lived path-grammar era inside `artifacts/`
  // need no sweep: they list as unresolved bytes and are deletable in the
  // panel.) Fire-and-forget; removable once no browser still carries it.
  void opfsRoot.removeEntry('worlds', { recursive: true }).catch(() => undefined)

  const rootDir = (create: boolean): Promise<FileSystemDirectoryHandle | null> =>
    opfsRoot.getDirectoryHandle(ROOT, { create }).catch(() => null)

  async function artifactDir(uid: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    const root = await rootDir(create)
    if (!root) return null
    return root.getDirectoryHandle(uid, { create }).catch(() => null)
  }

  async function fileHandle(uid: string, name: string, create: boolean): Promise<FileSystemFileHandle | null> {
    let dir = await artifactDir(uid, create)
    if (!dir) return null
    const segments = name.split('/').filter((s) => s.length > 0)
    const leaf = segments.pop()
    if (!leaf) return null
    for (const segment of segments) {
      const next: FileSystemDirectoryHandle | null = await dir.getDirectoryHandle(segment, { create }).catch(() => null)
      if (!next) return null
      dir = next
    }
    return dir.getFileHandle(leaf, { create }).catch(() => null)
  }

  async function readFile(uid: string, name: string): Promise<ArrayBuffer | null> {
    const handle = await fileHandle(uid, name, false)
    if (!handle) return null
    try {
      return await (await handle.getFile()).arrayBuffer()
    } catch {
      return null
    }
  }

  async function readMeta(uid: string): Promise<ParsedMeta | null> {
    const bytes = await readFile(uid, 'meta.json')
    if (!bytes) return null
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as ParsedMeta
    } catch {
      return null
    }
  }

  // Last time this page touched an entry (resolve hit, read, write) — the
  // sweep's recency signal. IN-MEMORY only, same reasoning as the server's:
  // persisting per-read access would mean a write per read, and losing
  // recency across a reload costs at worst one re-fetch.
  const lastAccess = new Map<string, number>()
  let lastSweep = 0

  // key-string → uid, built once per page and maintained by write/remove.
  let index: Map<string, string> | null = null
  async function ensureIndex(): Promise<Map<string, string>> {
    if (index) return index
    index = new Map()
    const root = await rootDir(false)
    if (!root) return index
    for await (const [uid, child] of root.entries()) {
      if (child.kind !== 'directory') continue
      const meta = await readMeta(uid)
      const key = meta?.key
      if (key?.worldUid && key.worldId && key.pipelineVersion && key.stage) {
        index.set(keyString(key as ArtifactKey), uid)
      }
    }
    return index
  }

  async function fileNames(uid: string): Promise<string[]> {
    const dir = await artifactDir(uid, false)
    if (!dir) return []
    const names: string[] = []
    for await (const [name, child] of dir.entries()) {
      if (child.kind === 'file') {
        names.push(name)
        continue
      }
      const nested: FileSystemDirectoryHandle = child as FileSystemDirectoryHandle
      for await (const [inner, grand] of nested.entries()) {
        if (grand.kind === 'file') names.push(`${name}/${inner}`)
      }
    }
    return names.sort()
  }

  async function subtreeBytes(dir: FileSystemDirectoryHandle): Promise<number> {
    let total = 0
    for await (const [, child] of dir.entries()) {
      if (child.kind === 'file') {
        total += await (child as FileSystemFileHandle).getFile().then((f) => f.size).catch(() => 0)
      } else {
        total += await subtreeBytes(child as FileSystemDirectoryHandle)
      }
    }
    return total
  }

  async function removeEntry(uid: string): Promise<void> {
    const root = await rootDir(false)
    if (!root) return
    await root.removeEntry(uid, { recursive: true }).catch(() => undefined)
    lastAccess.delete(uid)
    if (index) {
      for (const [key, indexed] of index) if (indexed === uid) index.delete(key)
    }
  }

  // Evicts least-recently-used artifacts until the cache fits its budget —
  // never the one just written. Entries this page never touched fall back to
  // their meta's createdAt; entries with neither (junk from older layouts,
  // abandoned writes) go first. Locally there is no grace period: this page
  // is the only writer, so a mid-write entry always has an access time.
  async function enforceCap(justWritten: string): Promise<void> {
    const now = Date.now()
    if (now - lastSweep < SWEEP_INTERVAL_MS) return
    lastSweep = now
    const root = await rootDir(false)
    if (!root) return
    const entries: { uid: string; bytes: number; recency: number; junk: boolean }[] = []
    let total = 0
    for await (const [uid, child] of root.entries()) {
      if (child.kind !== 'directory') continue
      const bytes = await subtreeBytes(child as FileSystemDirectoryHandle)
      total += bytes
      if (uid === justWritten) continue
      const meta = await readMeta(uid)
      const recency = lastAccess.get(uid) ?? (meta && typeof (meta as { createdAt?: number }).createdAt === 'number' ? (meta as { createdAt?: number }).createdAt! : 0)
      entries.push({ uid, bytes, recency, junk: !meta && !lastAccess.has(uid) })
    }
    if (total <= LOCAL_CAP_BYTES) return
    entries.sort((a, b) => (a.junk !== b.junk ? (a.junk ? -1 : 1) : a.recency - b.recency))
    for (const victim of entries) {
      if (total <= LOCAL_CAP_BYTES) break
      await removeEntry(victim.uid)
      total -= victim.bytes
    }
  }

  return {
    async resolve(key: ArtifactKey, create: boolean): Promise<ArtifactHandle | null> {
      const byKey = await ensureIndex()
      let uid = byKey.get(keyString(key))
      if (!uid) {
        if (!create) return null
        uid = crypto.randomUUID()
        if (!(await artifactDir(uid, true))) return null
        // Reserved immediately: a second resolve of the same key must land in
        // the same entry, or two writers duplicate the bytes.
        byKey.set(keyString(key), uid)
      }
      lastAccess.set(uid, Date.now())
      return { key, local: uid, files: await fileNames(uid) }
    },

    async read(handle: ArtifactHandle, name: string): Promise<ArrayBuffer | null> {
      if (!handle.local) return null
      const bytes = await readFile(handle.local, name)
      if (bytes) lastAccess.set(handle.local, Date.now())
      return bytes
    },

    async write(handle: ArtifactHandle, name: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean> {
      if (!handle.local) return false
      const file = await fileHandle(handle.local, name, true)
      if (!file) return false
      try {
        const writable = await file.createWritable()
        // Cast for the DOM types' sake: a view over a SharedArrayBuffer cannot
        // reach here, and copying 17 MB to satisfy the type would be absurd.
        await writable.write(bytes as FileSystemWriteChunkType)
        await writable.close()
        lastAccess.set(handle.local, Date.now())
        // The cap is enforced off the write path (writes are what grow the
        // cache) but not awaited — a finished bake must not wait on a sweep.
        void enforceCap(handle.local)
        return true
      } catch {
        return false
      }
    },

    async list(): Promise<StoredArtifact[]> {
      const out: StoredArtifact[] = []
      const root = await rootDir(false)
      if (!root) return out
      for await (const [uid, child] of root.entries()) {
        if (child.kind !== 'directory') continue
        const meta = await readMeta(uid)
        const bytes = await subtreeBytes(child as FileSystemDirectoryHandle)
        if (bytes === 0 && !meta) continue
        out.push({
          artifactUid: uid,
          bytes,
          worldUid: meta?.key?.worldUid ?? '',
          worldId: meta?.key?.worldId ?? '',
          pipelineVersion: meta?.key?.pipelineVersion ?? '',
          stage: meta?.key?.stage ?? '',
          label: meta?.label ?? '',
          width: meta?.width ?? 0,
          height: meta?.height ?? 0,
          bakeMs: meta?.bakeMs ?? 0,
        })
      }
      return out.sort((a, b) => b.bytes - a.bytes)
    },

    async removeArtifact(artifactUid: string): Promise<void> {
      await removeEntry(artifactUid)
    },

    async clear(): Promise<void> {
      await opfsRoot.removeEntry(ROOT, { recursive: true }).catch(() => undefined)
      index = new Map()
    },

    // Deliberately reports the ORIGIN's usage rather than a tree-walked sum:
    // for this app they are the same number to within rounding, and the
    // honest one is what the browser will actually enforce a quota against.
    async usage(): Promise<StorageUsage | null> {
      try {
        const estimate = await navigator.storage.estimate()
        return { usedBytes: estimate.usage ?? 0, quotaBytes: estimate.quota ?? 0 }
      } catch {
        return null
      }
    },
  }
}
