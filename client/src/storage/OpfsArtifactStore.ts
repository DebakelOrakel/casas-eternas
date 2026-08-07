import { splitPath } from './ArtifactStore'
import type { ArtifactStore, StorageUsage } from './ArtifactStore'

// ArtifactStore backed by the Origin Private File System — a real,
// on-disk, origin-scoped filesystem the browser hands the page, which
// survives reloads and restarts and takes binary natively (no base64, no
// serialisation).
//
// Chosen over IndexedDB for this job because the payload is a handful of
// large blobs rather than many small records: OPFS is faster for that shape,
// and its directory model lets the layout mirror the server's URL paths
// one-to-one (see ArtifactStore's path grammar), which is what keeps the two
// stores swappable.
//
// Three properties of the platform worth knowing, all of them harmless here
// because the data is recomputable:
//  - storage is scoped to the ORIGIN, port included — hence the pinned dev
//    port in vite.config.ts, without which the cache silently empties
//    whenever vite picks a different port;
//  - the browser may EVICT under disk pressure, and Safari clears storage
//    for sites unvisited for about a week;
//  - quota is a share of free disk, reported by navigator.storage.estimate.

// OPFS lives behind a secure context and a reasonably current browser. The
// factory probes rather than assuming, and returns null when unavailable so
// a caller can carry on with no cache at all.
export async function createOpfsArtifactStore(): Promise<ArtifactStore | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null
  let root: FileSystemDirectoryHandle
  try {
    root = await navigator.storage.getDirectory()
  } catch {
    return null
  }

  // Walk (optionally creating) a chain of directories from the root.
  async function resolveDirectory(segments: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let handle = root
    for (const segment of segments) {
      try {
        handle = await handle.getDirectoryHandle(segment, { create })
      } catch {
        return null // absent (create=false), or refused
      }
    }
    return handle
  }

  async function resolveFile(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const { directories, name } = splitPath(path)
    if (!name) return null
    const directory = await resolveDirectory(directories, create)
    if (!directory) return null
    try {
      return await directory.getFileHandle(name, { create })
    } catch {
      return null
    }
  }

  return {
    async read(path: string): Promise<ArrayBuffer | null> {
      const handle = await resolveFile(path, false)
      if (!handle) return null
      try {
        return await (await handle.getFile()).arrayBuffer()
      } catch {
        return null // a partially written or vanished entry reads as a miss
      }
    },

    async write(path: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean> {
      const handle = await resolveFile(path, true)
      if (!handle) return false
      try {
        const writable = await handle.createWritable()
        // ArrayBufferView is passed through as-is: writing a typed array's
        // own view avoids copying it just to hand over its buffer, and
        // matters at tens of megabytes.
        await writable.write(bytes as BufferSource)
        await writable.close()
        return true
      } catch {
        // Quota exhaustion arrives here, and so does a concurrent writer.
        // Both mean "not cached", which is not an error condition for a
        // cache — the caller recomputes.
        return false
      }
    },

    async exists(path: string): Promise<boolean> {
      return (await resolveFile(path, false)) !== null
    },

    async remove(path: string): Promise<void> {
      const { directories, name } = splitPath(path)
      if (!name) return
      const directory = await resolveDirectory(directories, false)
      if (!directory) return
      try {
        // recursive so the same call removes a single file or a whole
        // world's subtree — what both eviction and "forget this world" need.
        await directory.removeEntry(name, { recursive: true })
      } catch {
        // Already gone, or in use; nothing to repair either way.
      }
    },

    async listDirectory(path: string): Promise<string[]> {
      const segments = path.split('/').filter((segment) => segment.length > 0)
      const directory = await resolveDirectory(segments, false)
      if (!directory) return []
      const names: string[] = []
      try {
        for await (const name of directory.keys()) names.push(name)
      } catch {
        return names
      }
      return names
    },

    async usage(): Promise<StorageUsage | null> {
      if (!navigator.storage?.estimate) return null
      try {
        const estimate = await navigator.storage.estimate()
        return { usedBytes: estimate.usage ?? 0, quotaBytes: estimate.quota ?? 0 }
      } catch {
        return null
      }
    },
  }
}
