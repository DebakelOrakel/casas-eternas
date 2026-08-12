import type { ArtifactHandle, ArtifactKey, LocalArtifactStore, StorageUsage, StoredArtifact } from './ArtifactStore'

// In-memory LocalArtifactStore — the fallback when OPFS is unavailable
// (insecure context, storage denied), and what the harnesses exercise the
// artifact read/write path against. Same semantics as the real one, held in
// two Maps; entries live for the session, which for a cache over
// recomputable data is a perfectly good floor.

const keyString = (key: ArtifactKey): string => `${key.worldUid}\0${key.worldId}\0${key.pipelineVersion}\0${key.stage}`

export function createMemoryArtifactStore(): LocalArtifactStore {
  const files = new Map<string, Map<string, ArrayBuffer>>() // uid → name → bytes
  const byKey = new Map<string, string>()
  let minted = 0

  const toBuffer = (bytes: ArrayBuffer | ArrayBufferView): ArrayBuffer => {
    if (ArrayBuffer.isView(bytes)) {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }
    return bytes.slice(0)
  }

  const parseMeta = (uid: string): { key?: Partial<ArtifactKey>; label?: string; width?: number; height?: number; bakeMs?: number } | null => {
    const raw = files.get(uid)?.get('meta.json')
    if (!raw) return null
    try {
      return JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return null
    }
  }

  return {
    async resolve(key: ArtifactKey, create: boolean): Promise<ArtifactHandle | null> {
      let uid = byKey.get(keyString(key))
      if (!uid) {
        if (!create) return null
        uid = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `mem-${++minted}`
        files.set(uid, new Map())
        byKey.set(keyString(key), uid)
      }
      return { key, local: uid, files: [...(files.get(uid)?.keys() ?? [])].sort() }
    },

    async read(handle: ArtifactHandle, name: string): Promise<ArrayBuffer | null> {
      if (!handle.local) return null
      return files.get(handle.local)?.get(name) ?? null
    },

    async write(handle: ArtifactHandle, name: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean> {
      if (!handle.local) return false
      const entry = files.get(handle.local)
      if (!entry) return false
      entry.set(name, toBuffer(bytes))
      return true
    },

    async list(): Promise<StoredArtifact[]> {
      const out: StoredArtifact[] = []
      for (const [uid, entry] of files) {
        let bytes = 0
        for (const raw of entry.values()) bytes += raw.byteLength
        if (bytes === 0) continue
        const meta = parseMeta(uid)
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
      files.delete(artifactUid)
      for (const [key, uid] of byKey) if (uid === artifactUid) byKey.delete(key)
    },

    async clear(): Promise<void> {
      files.clear()
      byKey.clear()
    },

    async usage(): Promise<StorageUsage | null> {
      let used = 0
      for (const entry of files.values()) for (const raw of entry.values()) used += raw.byteLength
      // Quota 0 = "not reported"; the panel treats it as such.
      return { usedBytes: used, quotaBytes: 0 }
    },
  }
}
