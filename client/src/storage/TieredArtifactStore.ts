import type { ArtifactStore, StorageUsage } from './ArtifactStore'

// Local first, server second, compute last.
//
// This is the tiering the whole artifact design exists for
// (docs/design/server-storage.md): the same world opened on a second machine
// should cost a download rather than the minutes its bake took. The consumer
// is unchanged — it still asks a store for bytes at a path — which is the
// point of having kept that interface narrow.
//
// Three rules make it behave the way a cache should:
//
//   READ  local, then remote, and a remote hit is written back locally. The
//         next open is a local hit, so a machine pays the download once.
//   WRITE local first and awaited, remote afterwards and NOT awaited. A bake
//         that finished must be on this machine before the user does anything
//         else; pushing it onward is courtesy to the next reader and must
//         never make them wait for it.
//   MISS  is never an error. Every failure here — offline, denied quota,
//         truncated read — has the same consequence, which is to compute it.

export interface TieredOptions {
  // Whether the remote tier should be consulted at all. Resolved per call
  // rather than captured once, because a server can appear or vanish while
  // the page is open and a store that decided at construction time would be
  // wrong for the rest of the session.
  remoteAvailable(): Promise<boolean>
}

export function createTieredArtifactStore(local: ArtifactStore, remote: ArtifactStore, options: TieredOptions): ArtifactStore {
  const useRemote = async (): Promise<boolean> => {
    try {
      return await options.remoteAvailable()
    } catch {
      return false
    }
  }

  return {
    async read(path: string): Promise<ArrayBuffer | null> {
      const hit = await local.read(path)
      if (hit) return hit
      if (!(await useRemote())) return null

      const fetched = await remote.read(path)
      if (!fetched) return null
      // Backfill, deliberately awaited: the caller is about to use these bytes
      // and the write is to local storage, so it is milliseconds. Doing it in
      // the background would race the very next read of the same path — which
      // happens, because a bake reads elevation and rivers back to back.
      await local.write(path, fetched)
      return fetched
    },

    async write(path: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean> {
      const stored = await local.write(path, bytes)
      if (await useRemote()) {
        // Not awaited: a 17 MB upload must not sit between the user and the
        // world they just baked. Failing is fine — the next machine bakes it,
        // which is exactly what would have happened without a server.
        void remote.write(path, bytes)
      }
      return stored
    },

    async exists(path: string): Promise<boolean> {
      if (await local.exists(path)) return true
      if (!(await useRemote())) return false
      return remote.exists(path)
    },

    async size(path: string): Promise<number | null> {
      const localSize = await local.size(path)
      if (localSize !== null) return localSize
      if (!(await useRemote())) return null
      return remote.size(path)
    },

    // Removal and inventory are LOCAL ONLY, and that is a decision rather than
    // an omission. "Clear my cache" must not reach across and delete a shared
    // server's copy — dropping bytes this machine can recompute is harmless,
    // dropping the ones every other client is relying on is not. The storage
    // panel talks to the server's own listing and delete endpoints for that
    // side, where the action is explicit about what it affects.
    remove(path: string): Promise<void> {
      return local.remove(path)
    },

    listDirectory(path: string): Promise<string[]> {
      return local.listDirectory(path)
    },

    usage(): Promise<StorageUsage | null> {
      return local.usage()
    },
  }
}
