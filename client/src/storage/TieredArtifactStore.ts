import type { ArtifactHandle, ArtifactKey, ArtifactStore } from './ArtifactStore'

// Local first, server second, compute last.
//
// This is the tiering the whole artifact design exists for
// (docs/design/server-storage.md): the same world opened on a second machine
// should cost a download rather than the minutes its bake took.
//
// The two tiers mint their own uids for the same content, so a handle here
// carries BOTH and identity stays with the logical key. That is what makes
// the backfill sound: a remote hit is written into a locally minted entry,
// and the meta that travels with the files re-binds it to the same key.
//
//   RESOLVE  local, then remote; a hit on either side answers. `files` is the
//            union view a reader needs: what it can get from HERE, wherever
//            each byte happens to live.
//   READ     local, then remote, and a remote hit is written back locally.
//   WRITE    local first and awaited, remote afterwards and NOT awaited. A
//            bake that finished must be on this machine before the user does
//            anything else; pushing it onward is courtesy to the next reader.
//   MISS     is never an error. Every failure here has the same consequence,
//            which is to compute it again.

export interface TieredOptions {
  // Whether the remote tier should be consulted at all. Resolved per call
  // rather than captured once, because a server can appear or vanish while
  // the page is open.
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
    async resolve(key: ArtifactKey, create: boolean): Promise<ArtifactHandle | null> {
      const localHandle = await local.resolve(key, create)
      const remoteHandle = (await useRemote()) ? await remote.resolve(key, create) : null
      if (!localHandle && !remoteHandle) return null
      const files = [...new Set([...(localHandle?.files ?? []), ...(remoteHandle?.files ?? [])])].sort()
      return { key, local: localHandle?.local, remote: remoteHandle?.remote, files }
    },

    async read(handle: ArtifactHandle, name: string): Promise<ArrayBuffer | null> {
      if (handle.local) {
        const hit = await local.read(handle, name)
        if (hit) return hit
      }
      if (!handle.remote || !(await useRemote())) return null
      const fetched = await remote.read(handle, name)
      if (!fetched) return null
      // Backfill, deliberately awaited: the caller is about to use these bytes
      // and the write is to local storage, so it is milliseconds. Doing it in
      // the background would race the very next read of the same path — which
      // happens, because a bake reads elevation and rivers back to back.
      //
      // The local entry is minted on demand from the handle's own key — this
      // is why handles carry it. meta.json backfills like any other file:
      // completeness is judged from the files a resolve can NAME, not from
      // the meta's presence, so a partial backfill reads as what it is.
      if (!handle.local) handle.local = (await local.resolve(handle.key, true))?.local
      if (handle.local) await local.write(handle, name, fetched)
      return fetched
    },

    async write(handle: ArtifactHandle, name: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean> {
      const stored = handle.local ? await local.write(handle, name, bytes) : false
      if (handle.remote && (await useRemote())) {
        // Not awaited: a 17 MB upload must not sit between the user and the
        // world they just baked. Failing is fine — the next machine bakes it,
        // which is exactly what would have happened without a server.
        void remote.write(handle, name, bytes)
      }
      return stored
    },
  }
}
