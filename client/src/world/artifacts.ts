import { artifactPath } from '../storage/ArtifactStore'
import type { ArtifactKey, ArtifactStore } from '../storage/ArtifactStore'
import { derivePipelineVersion } from './identity'
import { bakeLayer, decodeLayer } from './save/worldLayers'
import type { AmplificationArtifact } from '../worldgen/surface/bakeInBrowser'

export type { AmplificationArtifact }
import type { Encoding } from './save/worldLayers'
import { AMPLIFY_CONSTANTS } from '../worldgen/surface/amplify'
import { AMPLIFY_EROSION_ROUNDS } from './bakeSettings'

// The PIPELINE half of an artifact's key, assembled in one place.
//
// This spread used to be written out at every call site — five in two screens,
// two in the Node baker, one in the harness — each rebuilding
// `{...AMPLIFY_CONSTANTS, rounds}` by hand. They agreed, but nothing made them:
// adding a constant at one site and not the others mints two keys for one
// artifact, and the reader would find terrain filed under a key that does not
// describe it. `artifactKey.derivePipelineVersion` deliberately takes the
// constants as an argument so it has no opinion on where they live — this is
// that opinion, held once.
//
// `rounds` is a parameter because the server's baker takes it per job, not from
// the shipped default.
export function amplificationPipelineVersion(rounds: number = AMPLIFY_EROSION_ROUNDS): string {
  return derivePipelineVersion({ ...AMPLIFY_CONSTANTS, rounds })
}

// What one amplification bake produces, and how it is written to (and read
// back from) an ArtifactStore. The store deals in bytes at paths; this is
// the layer that knows what the bytes mean, so the same encoding serves the
// local store today and the server store later.

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
// An ENCODING, not a world field: this is the amplified 4k/8k raster, which is
// derived presentation and never a queryable layer (worldmap-amplification.md,
// rule 4). It borrows the save's quantiser, not its field registry.
const ELEVATION_ENCODING: Encoding = { dtype: 'u16', scale: 2 / 65535, offset: -1 }

// Rivers travel as raw binary rather than the save's JSON form: a baked
// world's network runs to six figures of points, and JSON would be an order
// of magnitude larger and slower to parse than the numbers it carries.
// Terrain-level files: one per world+pipeline+stage, shared by every river
// density. The expensive ones — the 8192x4096 elevation raster is 67 MB and
// takes minutes to produce.
const FILES = {
  elevation: 'elevation.u16',
  meta: 'meta.json',
} as const

// River files, keyed by the density that produced them, so changing the slider
// adds a small variation beside the terrain instead of orphaning it. Density is
// an integer 0-100 from the generator's slider; it is rounded and clamped here
// so a stray float cannot mint an endless family of near-identical entries.
//
// Everything else the extraction depends on — the eroded field, precipitation,
// the erosion controls — is already fixed by the worldId and pipeline version
// above it in the path, so the density is the whole of the remaining freedom.
export function riverDensityKey(density: number | undefined): string {
  const value = Math.round(density ?? DEFAULT_RIVER_DENSITY)
  return String(Math.min(100, Math.max(0, value)))
}

// Mirrors hydrology's own fallback, so an artifact written for a save that
// predates the slider lands under the same name a reader will look for.
const DEFAULT_RIVER_DENSITY = 55

const riverFiles = (density: number | undefined): { points: string; lengths: string } => {
  const key = riverDensityKey(density)
  return { points: `rivers-${key}.f32`, lengths: `riverLengths-${key}.u32` }
}

// Every operation here is best-effort: an artifact store is a cache over
// deterministically recomputable data, so a partial write, a missing file or
// a corrupt read all mean the same thing — bake it again.
export async function writeAmplificationArtifact(store: ArtifactStore, key: ArtifactKey, artifact: AmplificationArtifact, bakeMs: number, riverDensity?: number): Promise<boolean> {
  const rivers = riverFiles(riverDensity)
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
    (await store.write(artifactPath(key, FILES.elevation), new Uint16Array(bakeLayer(artifact.elevation, ELEVATION_ENCODING)))) &&
    (await store.write(artifactPath(key, rivers.points), artifact.riverPoints)) &&
    (await store.write(artifactPath(key, rivers.lengths), artifact.riverLengths)) &&
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
export async function amplificationArtifactExists(store: ArtifactStore, key: ArtifactKey, riverDensity?: number): Promise<boolean> {
  // BOTH halves, because they can legitimately exist apart: the terrain may be
  // there from a bake at another density, and that is exactly the case this
  // split was made to allow. Asking only about meta.json would report a stage
  // as ready and then draw a world with no rivers.
  if (!(await store.exists(artifactPath(key, FILES.meta)))) return false
  return store.exists(artifactPath(key, riverFiles(riverDensity).points))
}

export async function readAmplificationArtifact(store: ArtifactStore, key: ArtifactKey, riverDensity?: number): Promise<{ artifact: AmplificationArtifact; bakeMs: number } | null> {
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

  // Rivers for THIS density, and their absence makes the whole read fail.
  //
  // Returning the terrain with empty rivers was the tempting shape and it is a
  // trap: the caller treats any hit as a complete cached stage, draws amplified
  // ground with no rivers on it, and never bakes — a permanent state that even
  // re-baking cannot leave, because the terrain it finds is exactly what stops
  // it. Before rivers were keyed per density this could not arise; meta.json
  // present meant rivers present.
  //
  // A file that EXISTS but is empty is different and stays legal: a world saved
  // before climate was computed bakes without hydrology, and riverless is then
  // the true answer rather than a missing one.
  const rivers = riverFiles(riverDensity)
  const pointBytes = await store.read(artifactPath(key, rivers.points))
  if (!pointBytes) return null
  const lengthBytes = await store.read(artifactPath(key, rivers.lengths))
  return {
    artifact: {
      elevation: decodeLayer(elevationBytes, ELEVATION_ENCODING),
      width: meta.width,
      height: meta.height,
      riverPoints: pointBytes ? new Float32Array(pointBytes) : new Float32Array(0),
      riverLengths: lengthBytes ? new Uint32Array(lengthBytes) : new Uint32Array(0),
    },
    bakeMs: meta.bakeMs,
  }
}
