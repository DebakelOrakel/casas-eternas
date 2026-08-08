// A place to put big, deterministically recomputable blobs — today the
// amplification bake's output (docs/decisions/worldmap-amplification.md),
// which costs minutes to produce and is identical for every consumer of the
// same world.
//
// The interface is deliberately BYTES AT A PATH and nothing more. That is
// what makes the local store and the eventual server store the same thing
// seen twice: the server design (docs/design/server-storage.md) is a
// content-addressed artifact store reachable over plain REST, so an HTTP
// implementation of this interface is a near-mechanical translation — same
// paths, same keys, a different back end. Anything that knows what the bytes
// MEAN belongs above this layer, not in it.
//
// Everything here treats failure as ordinary. A cache over recomputable data
// has no correctness story to protect: a miss, a denied quota, an evicted
// entry and a corrupt read all have the same consequence — compute it again.
// Hence `read` returning null rather than throwing, and `write` returning a
// boolean rather than rejecting.

export interface StorageUsage {
  usedBytes: number
  quotaBytes: number
}

export interface ArtifactStore {
  // Null when the path holds nothing (or could not be read — see above).
  read(path: string): Promise<ArrayBuffer | null>
  // False when the bytes were not stored, for any reason. Never throws for
  // an expected condition; callers must carry on regardless.
  write(path: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean>
  exists(path: string): Promise<boolean>
  // Byte length without reading the contents — what an inventory needs, and
  // the reason it is its own method: summing a cache's size by `read`ing
  // every entry would pull tens of megabytes through memory to learn a
  // number the filesystem already knows.
  size(path: string): Promise<number | null>
  // Delete one entry or a whole subtree — the unit eviction and "forget this
  // world" both work in.
  remove(path: string): Promise<void>
  // Immediate children of a directory path (names, not paths); empty when
  // the directory is absent. Enough for an LRU sweep to enumerate worlds.
  listDirectory(path: string): Promise<string[]>
  usage(): Promise<StorageUsage | null>
}

// Path grammar, mirroring the server design's URL shape so the two stores
// stay swappable:
//
//   worlds/{worldId}/amp/{pipelineVersion}/{stage}/elevation.u16
//                                                 /meta.json
//                                                 /rivers-{density}.f32
//                                                 /riverLengths-{density}.u32
//
// The split is deliberate and was retrofitted: terrain is expensive (67 MB and
// minutes at 8192²) and does not depend on the river-density slider, while the
// rivers are cheap and do. With density folded into worldId instead, nudging
// the slider minted a new world and orphaned the whole entry. Measured after
// the split: a second density costs 217 KB beside a shared 16.4 MB terrain.
//
// Built here rather than at call sites so the layout is stated once, and so
// the HTTP store can reuse the identical builder against its own base URL.
export interface ArtifactKey {
  worldId: string
  pipelineVersion: string
  // Which bake tier the entry belongs to — the amplification factor, as a
  // string, so a world can hold several without them colliding.
  stage: string
}

export const artifactDirectory = (key: ArtifactKey): string =>
  `worlds/${key.worldId}/amp/${key.pipelineVersion}/${key.stage}`

export const artifactPath = (key: ArtifactKey, file: string): string => `${artifactDirectory(key)}/${file}`

// Splits a path into its directory segments plus the final name. Exported
// because it is the one piece of path handling with an off-by-one in it, and
// it is worth being able to test without a browser.
export function splitPath(path: string): { directories: string[]; name: string } {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  const name = segments.pop() ?? ''
  return { directories: segments, name }
}
