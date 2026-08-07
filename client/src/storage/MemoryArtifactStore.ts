import type { ArtifactStore, StorageUsage } from './ArtifactStore'

// An ArtifactStore that keeps everything in a Map. Two jobs:
//
//  - it makes the cache flow TESTABLE OUTSIDE A BROWSER. OPFS exists only in
//    a page, so without this the only way to exercise "hit skips the bake,
//    miss computes and stores" would be by hand, in a browser, on a
//    multi-minute bake.
//  - it is the honest fallback when OPFS is unavailable (older browser,
//    insecure context, storage denied): the session still gets its
//    within-session hits, and nothing above has to know the difference.
//
// Deliberately unbounded: a cache with no eviction is fine for a store whose
// lifetime is one page, and adding a policy here would only duplicate the
// one the persistent store needs.
export function createMemoryArtifactStore(): ArtifactStore {
  const files = new Map<string, ArrayBuffer>()
  const normalise = (path: string): string => path.split('/').filter((segment) => segment.length > 0).join('/')

  return {
    async read(path: string): Promise<ArrayBuffer | null> {
      return files.get(normalise(path)) ?? null
    },
    async write(path: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean> {
      // Copied, not referenced: a caller that reuses its scratch buffer must
      // not be able to mutate what it already "stored".
      const view = ArrayBuffer.isView(bytes)
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes)
      files.set(normalise(path), view.slice().buffer)
      return true
    },
    async exists(path: string): Promise<boolean> {
      return files.has(normalise(path))
    },
    async remove(path: string): Promise<void> {
      const prefix = normalise(path)
      // Removes an entry or a whole subtree, matching the OPFS store's
      // recursive removal.
      for (const key of [...files.keys()]) {
        if (key === prefix || key.startsWith(`${prefix}/`)) files.delete(key)
      }
    },
    async listDirectory(path: string): Promise<string[]> {
      const prefix = normalise(path)
      const children = new Set<string>()
      for (const key of files.keys()) {
        if (prefix.length > 0 && !key.startsWith(`${prefix}/`)) continue
        const rest = prefix.length > 0 ? key.slice(prefix.length + 1) : key
        const head = rest.split('/')[0]
        if (head) children.add(head)
      }
      return [...children]
    },
    async usage(): Promise<StorageUsage | null> {
      let usedBytes = 0
      for (const bytes of files.values()) usedBytes += bytes.byteLength
      return { usedBytes, quotaBytes: 0 }
    },
  }
}
