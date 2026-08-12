import type { ArtifactHandle, ArtifactKey, ArtifactStore } from '../storage/ArtifactStore'
import { AMPLIFICATION_ALGO_VERSION, derivePipelineVersion } from './identity'
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
// describe it. `identity.derivePipelineVersion` deliberately takes the
// constants as an argument so it has no opinion on where they live — this is
// that opinion, held once.
//
// `rounds` is a parameter because the server's baker takes it per job, not from
// the shipped default.
export function amplificationPipelineVersion(rounds: number = AMPLIFY_EROSION_ROUNDS): string {
  return derivePipelineVersion({ ...AMPLIFY_CONSTANTS, rounds })
}

// What one amplification bake produces, and how it is written to (and read
// back from) an ArtifactStore. The store deals in resolve/read/write over
// opaque artifact uids; this is the layer that knows what the bytes MEAN.

// The meta.json every artifact carries — deliberately its COMPLETE
// self-description (2026-08-12): the logical key makes a hand-copied entry
// re-indexable wherever it lands, and the pipeline constants WRITTEN OUT (not
// only their hash) are what makes a future key-schema migration possible at
// all — a hash cannot be reversed into the values that fed it. The store
// index reads `key` and the display fields; everything else rides along for
// whoever needs it later.
interface ArtifactMeta {
  key: ArtifactKey
  width: number
  height: number
  riverPointCount: number
  riverPolylineCount: number
  // Wall-clock cost of the bake this entry replaces — the honest answer to
  // "was the cache worth it", and readable straight off disk.
  bakeMs: number
  createdAt: number
  // The world's seed text, for listings — display data; for a `no-uid` entry
  // the only name there is.
  label: string
  pipeline: {
    algoVersion: number
    rounds: number
    constants: Record<string, number>
  }
  // Name → byte length of everything written beside this meta, so an entry
  // can state its own completeness without naming conventions.
  files: Record<string, number>
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
// the erosion controls — is already fixed by the artifact's key, so the
// density is the whole of the remaining freedom.
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
export async function writeAmplificationArtifact(store: ArtifactStore, key: ArtifactKey, artifact: AmplificationArtifact, bakeMs: number, riverDensity?: number, label = '', rounds: number = AMPLIFY_EROSION_ROUNDS): Promise<boolean> {
  const handle = await store.resolve(key, true)
  if (!handle) return false
  const rivers = riverFiles(riverDensity)
  const elevationBytes = new Uint16Array(bakeLayer(artifact.elevation, ELEVATION_ENCODING))
  const meta: ArtifactMeta = {
    key,
    width: artifact.width,
    height: artifact.height,
    riverPointCount: artifact.riverPoints.length,
    riverPolylineCount: artifact.riverLengths.length,
    bakeMs,
    createdAt: Date.now(),
    label,
    pipeline: { algoVersion: AMPLIFICATION_ALGO_VERSION, rounds, constants: { ...AMPLIFY_CONSTANTS } },
    files: {
      [FILES.elevation]: elevationBytes.byteLength,
      [rivers.points]: artifact.riverPoints.byteLength,
      [rivers.lengths]: artifact.riverLengths.byteLength,
    },
  }
  // Payload first, meta LAST: the meta is what makes an entry resolvable by
  // key across restarts, so a write interrupted half way leaves bytes that
  // read as unresolved rather than an entry pointing at half a file.
  return (
    (await store.write(handle, FILES.elevation, elevationBytes)) &&
    (await store.write(handle, rivers.points, artifact.riverPoints)) &&
    (await store.write(handle, rivers.lengths, artifact.riverLengths)) &&
    (await store.write(handle, FILES.meta, new TextEncoder().encode(JSON.stringify(meta))))
  )
}

// Is this stage there, without fetching it? One resolve answers: the handle's
// files ARE the batch existence check.
//
// BOTH halves, because they can legitimately exist apart: the terrain may be
// there from a bake at another density, and that is exactly the case the
// per-density river files exist to allow. Asking only about the meta would
// report a stage as ready and then draw a world with no rivers.
export async function amplificationArtifactExists(store: ArtifactStore, key: ArtifactKey, riverDensity?: number): Promise<boolean> {
  const handle = await store.resolve(key, false)
  if (!handle) return false
  const needed = [FILES.meta, riverFiles(riverDensity).points]
  return needed.every((name) => handle.files.includes(name))
}

export async function readAmplificationArtifact(store: ArtifactStore, key: ArtifactKey, riverDensity?: number): Promise<{ artifact: AmplificationArtifact; bakeMs: number } | null> {
  const handle = await store.resolve(key, false)
  if (!handle) return null
  const meta = await readMeta(store, handle)
  if (!meta) return null
  const elevationBytes = await store.read(handle, FILES.elevation)
  if (!elevationBytes) return null
  const expectedCells = meta.width * meta.height
  if (elevationBytes.byteLength !== expectedCells * 2) return null // truncated or from another shape

  // Rivers for THIS density, and their absence makes the whole read fail.
  //
  // Returning the terrain with empty rivers was the tempting shape and it is a
  // trap: the caller treats any hit as a complete cached stage, draws amplified
  // ground with no rivers on it, and never bakes — a permanent state that even
  // re-baking cannot leave, because the terrain it finds is exactly what stops
  // it.
  //
  // A file that EXISTS but is empty is different and stays legal: a world saved
  // before climate was computed bakes without hydrology, and riverless is then
  // the true answer rather than a missing one.
  const rivers = riverFiles(riverDensity)
  const pointBytes = await store.read(handle, rivers.points)
  if (!pointBytes) return null
  const lengthBytes = await store.read(handle, rivers.lengths)
  return {
    artifact: {
      elevation: decodeLayer(elevationBytes, ELEVATION_ENCODING),
      width: meta.width,
      height: meta.height,
      riverPoints: new Float32Array(pointBytes),
      riverLengths: lengthBytes ? new Uint32Array(lengthBytes) : new Uint32Array(0),
    },
    bakeMs: meta.bakeMs,
  }
}

async function readMeta(store: ArtifactStore, handle: ArtifactHandle): Promise<ArtifactMeta | null> {
  const metaBytes = await store.read(handle, FILES.meta)
  if (!metaBytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(metaBytes)) as ArtifactMeta
  } catch {
    return null
  }
}
