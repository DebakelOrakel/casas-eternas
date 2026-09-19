import type { StorageUsage } from './ArtifactStore'

// A world's save archive kept in the Origin Private File System, so closing
// the tab is not the same as losing the world.
//
// SEPARATE from OpfsArtifactStore although both sit on OPFS, and the reason is
// not tidiness: that store has a 4 GB cap and evicts least-recently-used
// entries to stay under it. A bake may be evicted — it recomputes. A save may
// NOT: it is the one thing in this app that cannot be recomputed, and a store
// that drops a world to make room for terrain would be a store that quietly
// destroys work. Same platform, opposite policy, so they do not share code
// that would let one policy leak into the other.
//
// Root is `saves/`, and NOT `worlds/`: OpfsArtifactStore removes a `worlds/`
// tree on every startup (its pre-2026-08-11 cache root), so a store placed
// there would be deleted on the next reload with nothing said.
//
// The three platform properties documented in OpfsArtifactStore hold here too
// — origin scoping (port included), eviction under disk pressure, quota as a
// share of free disk. The difference is that here they are NOT harmless: a
// browser clearing site data takes the worlds with it. That is what the
// browser save target promises and no more, and it is why the server target
// exists beside it.

const ROOT = 'saves'

const ARCHIVE = 'archive.zip'
const META = 'meta.json'
// Kept BESIDE the archive rather than read out of it: a listing wants every
// world's thumbnail at once, and unzipping a 30 MB archive per row to reach a
// 512×256 image is the difference between a list that opens and one that hangs.
const THUMBNAIL = 'thumbnail.png'

// One saved world, as the store hands it back. `meta` is whatever the caller
// wrote — this module never looks inside it, which is what keeps the storage
// layer free of world vocabulary (see the layering note in CLAUDE.md).
export interface StoredWorld<M> {
  uid: string
  meta: M
  // Bytes of the archive alone, read from the file rather than remembered, so
  // it cannot drift from what is actually on disk.
  bytes: number
  hasThumbnail: boolean
}

export interface WorldArchiveStore<M> {
  // Writes archive and meta together. Returns false when the write failed —
  // out of quota is the expected case — having removed the partial entry, so
  // a refused save never leaves a half-world that would list as real.
  put(uid: string, archive: Blob, meta: M, thumbnail?: Blob | null): Promise<boolean>
  // The archive bytes, or null when this browser does not hold that world.
  get(uid: string): Promise<Blob | null>
  // The thumbnail written alongside, or null when there is none.
  thumbnail(uid: string): Promise<Blob | null>
  list(): Promise<StoredWorld<M>[]>
  remove(uid: string): Promise<void>
  clear(): Promise<void>
  usage(): Promise<StorageUsage | null>
}

// Probes rather than assuming: OPFS needs a secure context and a reasonably
// current browser. Null means this browser cannot keep worlds, and the caller
// is expected to hide the target rather than offer one that fails.
export async function createOpfsWorldStore<M>(): Promise<WorldArchiveStore<M> | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null
  let opfsRoot: FileSystemDirectoryHandle
  try {
    opfsRoot = await navigator.storage.getDirectory()
  } catch {
    return null
  }

  const rootDir = (create: boolean): Promise<FileSystemDirectoryHandle | null> =>
    opfsRoot.getDirectoryHandle(ROOT, { create }).catch(() => null)

  const worldDir = async (uid: string, create: boolean): Promise<FileSystemDirectoryHandle | null> => {
    const root = await rootDir(create)
    if (!root) return null
    return root.getDirectoryHandle(uid, { create }).catch(() => null)
  }

  const write = async (dir: FileSystemDirectoryHandle, name: string, data: Blob | string): Promise<void> => {
    const handle = await dir.getFileHandle(name, { create: true })
    const stream = await handle.createWritable()
    await stream.write(data)
    await stream.close()
  }

  // A plain function rather than a method, because `put` calls it on the
  // failure path: `this` inside an object literal is whatever the call site
  // made it, and a cleanup that silently does nothing is worse than none.
  const removeWorld = async (uid: string): Promise<void> => {
    const root = await rootDir(false)
    await root?.removeEntry(uid, { recursive: true }).catch(() => undefined)
  }

  const readFile = async (dir: FileSystemDirectoryHandle, name: string): Promise<File | null> => {
    const handle = await dir.getFileHandle(name, { create: false }).catch(() => null)
    if (!handle) return null
    return handle.getFile().catch(() => null)
  }

  return {
    async put(uid: string, archive: Blob, meta: M, thumbnail?: Blob | null): Promise<boolean> {
      const dir = await worldDir(uid, true)
      if (!dir) return false
      try {
        // Archive first, thumbnail second, meta LAST: meta.json is what `list`
        // treats as proof that an entry is complete, so an interrupted write
        // leaves an entry that lists as nothing rather than as a world with no
        // bytes behind it.
        await write(dir, ARCHIVE, archive)
        if (thumbnail) await write(dir, THUMBNAIL, thumbnail)
        await write(dir, META, JSON.stringify(meta))
        return true
      } catch {
        // A failed write is almost always the quota. Remove the remains rather
        // than leaving bytes that count against the quota and belong to no
        // world the user can see or delete.
        await removeWorld(uid)
        return false
      }
    },

    async get(uid: string): Promise<Blob | null> {
      const dir = await worldDir(uid, false)
      if (!dir) return null
      return await readFile(dir, ARCHIVE)
    },

    async thumbnail(uid: string): Promise<Blob | null> {
      const dir = await worldDir(uid, false)
      if (!dir) return null
      return await readFile(dir, THUMBNAIL)
    },

    async list(): Promise<StoredWorld<M>[]> {
      const root = await rootDir(false)
      if (!root) return []
      const worlds: StoredWorld<M>[] = []
      for await (const [uid, handle] of root.entries()) {
        if (handle.kind !== 'directory') continue
        const dir = handle as FileSystemDirectoryHandle
        const metaFile = await readFile(dir, META)
        const archiveFile = await readFile(dir, ARCHIVE)
        // Both halves or nothing — see the write order in `put`.
        if (!metaFile || !archiveFile) continue
        const thumbFile = await readFile(dir, THUMBNAIL)
        try {
          worlds.push({
            uid,
            meta: JSON.parse(await metaFile.text()) as M,
            bytes: archiveFile.size,
            hasThumbnail: thumbFile !== null,
          })
        } catch {
          // Unreadable meta: skip it rather than drop it. It is not listable,
          // but it is also not this module's call to delete a world because
          // one JSON file went bad.
        }
      }
      return worlds
    },

    remove: removeWorld,

    async clear(): Promise<void> {
      await opfsRoot.removeEntry(ROOT, { recursive: true }).catch(() => undefined)
    },

    // The ORIGIN's usage, for the same reason the artifact store reports it
    // that way: it is the number the browser enforces a quota against. Note
    // that it therefore counts the artifact cache too — the two stores share
    // one budget, which is exactly the thing worth knowing before a save.
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
