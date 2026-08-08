import { artifactPath } from './ArtifactStore'
import type { ArtifactKey, ArtifactStore } from './ArtifactStore'
import { bakeLayer, decodeLayer } from '../worldgen/worldSave/worldLayers'
import type { LayerSpec } from '../worldgen/worldSave/worldLayers'

// What one amplification bake produces, and how it is written to (and read
// back from) an ArtifactStore. The store deals in bytes at paths; this is
// the layer that knows what the bytes mean, so the same encoding serves the
// local store today and the server store later.

export interface AmplificationArtifact {
  elevation: Float32Array
  width: number
  height: number
  riverPoints: Float32Array
  riverLengths: Uint32Array
}

interface ArtifactMeta {
  width: number
  height: number
  riverPointCount: number
  riverPolylineCount: number
  // Wall-clock cost of the bake this entry replaces — the honest answer to
  // "was the cache worth it", and readable straight off disk.
  bakeMs: number
  createdAt: number
}

// Elevation is quantised to u16 rather than stored as raw f32, for two
// reasons and one accepted cost.
//
// It halves the entry (34 MB → 17 MB per stage at 4096²), which matters more
// for the eventual server tier than locally. More importantly it makes the
// two tiers BYTE-IDENTICAL: were the local store exact and the server store
// quantised, the same world would look subtly different depending on where
// it was fetched from — a difference nobody could explain and everybody
// would eventually chase.
//
// The cost is 2/65535 of the elevation range ≈ 0.27 m of height precision,
// far below anything the renderer or the hover readout can show. Reuses the
// save format's own quantiser so the conventions stay in one place.
const ELEVATION_SPEC: LayerSpec = {
  name: 'elevation',
  dtype: 'u16',
  scale: 2 / 65535,
  offset: -1,
  unit: 'relative',
  landOnly: false,
}

// Rivers travel as raw binary rather than the save's JSON form: a baked
// world's network runs to six figures of points, and JSON would be an order
// of magnitude larger and slower to parse than the numbers it carries.
const FILES = {
  elevation: 'elevation.u16',
  riverPoints: 'rivers.f32',
  riverLengths: 'riverLengths.u32',
  meta: 'meta.json',
} as const

// Every operation here is best-effort: an artifact store is a cache over
// deterministically recomputable data, so a partial write, a missing file or
// a corrupt read all mean the same thing — bake it again.
export async function writeAmplificationArtifact(store: ArtifactStore, key: ArtifactKey, artifact: AmplificationArtifact, bakeMs: number): Promise<boolean> {
  const meta: ArtifactMeta = {
    width: artifact.width,
    height: artifact.height,
    riverPointCount: artifact.riverPoints.length,
    riverPolylineCount: artifact.riverLengths.length,
    bakeMs,
    createdAt: Date.now(),
  }
  // Elevation first and meta LAST: meta is what the reader checks for, so a
  // write interrupted half way leaves an entry that reads as absent rather
  // than as present-but-truncated.
  const wrote =
    (await store.write(artifactPath(key, FILES.elevation), new Uint16Array(bakeLayer(artifact.elevation, ELEVATION_SPEC)))) &&
    (await store.write(artifactPath(key, FILES.riverPoints), artifact.riverPoints)) &&
    (await store.write(artifactPath(key, FILES.riverLengths), artifact.riverLengths)) &&
    (await store.write(artifactPath(key, FILES.meta), new TextEncoder().encode(JSON.stringify(meta))))
  if (!wrote) {
    // Don't leave a half-written entry behind to be found later.
    await store.remove(artifactPath(key, FILES.meta))
  }
  return wrote
}

// Is this stage there, without fetching it?
//
// Its own function because the difference is not small: `read` on a present
// 8192² artifact pulls and decodes ~134 MB, and a caller that only wants to
// know whether to OFFER a bake would be paying that to learn one bit. meta.json
// is written last (see the write order above), so its presence is also the
// signal that the rest of the entry is complete rather than half-written.
export async function amplificationArtifactExists(store: ArtifactStore, key: ArtifactKey): Promise<boolean> {
  return store.exists(artifactPath(key, FILES.meta))
}

export async function readAmplificationArtifact(store: ArtifactStore, key: ArtifactKey): Promise<{ artifact: AmplificationArtifact; bakeMs: number } | null> {
  const metaBytes = await store.read(artifactPath(key, FILES.meta))
  if (!metaBytes) return null
  let meta: ArtifactMeta
  try {
    meta = JSON.parse(new TextDecoder().decode(metaBytes)) as ArtifactMeta
  } catch {
    return null
  }
  const elevationBytes = await store.read(artifactPath(key, FILES.elevation))
  if (!elevationBytes) return null
  const expectedCells = meta.width * meta.height
  if (elevationBytes.byteLength !== expectedCells * 2) return null // truncated or from another shape

  const pointBytes = await store.read(artifactPath(key, FILES.riverPoints))
  const lengthBytes = await store.read(artifactPath(key, FILES.riverLengths))
  return {
    artifact: {
      elevation: decodeLayer(elevationBytes, ELEVATION_SPEC),
      width: meta.width,
      height: meta.height,
      riverPoints: pointBytes ? new Float32Array(pointBytes) : new Float32Array(0),
      riverLengths: lengthBytes ? new Uint32Array(lengthBytes) : new Uint32Array(0),
    },
    bakeMs: meta.bakeMs,
  }
}
