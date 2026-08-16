import type { ArtifactHandle, ArtifactKey, ArtifactStore } from '../storage/ArtifactStore'
import { AMPLIFICATION_ALGO_VERSION, derivePipelineVersion } from './identity'
import { bakeLayer, decodeLayer } from './save/worldLayers'
import type { AmplificationArtifact } from '../worldgen/surface/bakeInBrowser'

export type { AmplificationArtifact }
import type { Encoding } from './save/worldLayers'
import { AMPLIFY_CONSTANTS } from '../worldgen/surface/amplify'
import { AMPLIFY_EROSION_ROUNDS, AMPLIFY_FINEST_STAGE } from './bakeSettings'
import { metersToElevation } from '../worldgen/elevation/elevationScale'
import { downsampleBox } from '../worldgen/core/field'

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
  lakeDepth: 'lakeDepth.u8',
  meta: 'meta.json',
} as const

// The same quantisation the SAVE gives its lake layer (world/save/
// worldLayers.ts): one byte per cell over a 3,000 m range. A field that is
// zero almost everywhere compresses to nearly nothing, and the artifact stays
// half the size of its own elevation layer instead of double.
const LAKE_DEPTH_ENCODING: Encoding = { dtype: 'u8', scale: metersToElevation(3000) / 255, offset: 0 }

// ONE river file set per artifact: extraction runs at the model's
// CANONICAL_RIVER_DENSITY since P4 (the slider is a draw filter and never
// reaches a bake), so the per-density suffixes — `rivers-55.f32` and its
// siblings, which let slider positions coexist beside one terrain — are gone
// with the freedom they encoded. identity.ts keeps the story.
const RIVER_FILES = { points: 'rivers.f32', lengths: 'riverLengths.u32' } as const

// The derived family (docs/decisions/derived-bake-tiers.md): the designated
// finest bake carries every coarser tier as a box-downsample of itself,
// stored as extra files IN THE SAME ENTRY — one key, atomically consistent,
// evicted as a unit. Rivers are deliberately NOT duplicated per member: a
// polyline is the same river at every resolution, and the member reader
// scales its texel coordinates instead.
// Two segments, not three: the server store's listing walks exactly one
// directory level (the `tiles/12_7` shape), so a deeper nesting would write
// fine and then be invisible to every file listing.
const familyFiles = (member: number): { elevation: string; lakeDepth: string } => ({
  elevation: `family-${member}/elevation.u16`,
  lakeDepth: `family-${member}/lakeDepth.u8`,
})

// Every operation here is best-effort: an artifact store is a cache over
// deterministically recomputable data, so a partial write, a missing file or
// a corrupt read all mean the same thing — bake it again.
export async function writeAmplificationArtifact(store: ArtifactStore, key: ArtifactKey, artifact: AmplificationArtifact, bakeMs: number, label = '', rounds: number = AMPLIFY_EROSION_ROUNDS): Promise<boolean> {
  const handle = await store.resolve(key, true)
  if (!handle) return false
  const rivers = RIVER_FILES
  const elevationBytes = new Uint16Array(bakeLayer(artifact.elevation, ELEVATION_ENCODING))
  const lakeBytes = artifact.lakeDepth ? new Uint8Array(bakeLayer(artifact.lakeDepth, LAKE_DEPTH_ENCODING)) : null
  // The designated finest stage writes its derived family beside itself:
  // box-downsampled on the RAW f32 field before quantisation, so a member
  // is exactly box(finest) and not box(quantised(finest)) — the family's
  // byte-consistency is the whole point.
  const family: { member: number; elevation: Uint16Array; lakeDepth: Uint8Array | null }[] = []
  if (key.stage === String(AMPLIFY_FINEST_STAGE)) {
    for (let member = AMPLIFY_FINEST_STAGE / 2; member >= 2; member /= 2) {
      const scale = member / AMPLIFY_FINEST_STAGE
      const w = Math.round(artifact.width * scale)
      const h = Math.round(artifact.height * scale)
      family.push({
        member,
        elevation: new Uint16Array(bakeLayer(downsampleBox(artifact.elevation, artifact.width, artifact.height, w, h), ELEVATION_ENCODING)),
        lakeDepth: artifact.lakeDepth ? new Uint8Array(bakeLayer(downsampleBox(artifact.lakeDepth, artifact.width, artifact.height, w, h), LAKE_DEPTH_ENCODING)) : null,
      })
    }
  }
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
      ...(lakeBytes ? { [FILES.lakeDepth]: lakeBytes.byteLength } : {}),
      [rivers.points]: artifact.riverPoints.byteLength,
      [rivers.lengths]: artifact.riverLengths.byteLength,
      ...Object.fromEntries(family.flatMap(({ member, elevation, lakeDepth }) => {
        const names = familyFiles(member)
        return [[names.elevation, elevation.byteLength] as const, ...(lakeDepth ? [[names.lakeDepth, lakeDepth.byteLength] as const] : [])]
      })),
    },
  }
  // Payload first, meta LAST: the meta is what makes an entry resolvable by
  // key across restarts, so a write interrupted half way leaves bytes that
  // read as unresolved rather than an entry pointing at half a file.
  for (const { member, elevation, lakeDepth } of family) {
    const names = familyFiles(member)
    if (!(await store.write(handle, names.elevation, elevation))) return false
    if (lakeDepth && !(await store.write(handle, names.lakeDepth, lakeDepth))) return false
  }
  return (
    (await store.write(handle, FILES.elevation, elevationBytes)) &&
    (lakeBytes === null || (await store.write(handle, FILES.lakeDepth, lakeBytes))) &&
    (await store.write(handle, rivers.points, artifact.riverPoints)) &&
    (await store.write(handle, rivers.lengths, artifact.riverLengths)) &&
    (await store.write(handle, FILES.meta, new TextEncoder().encode(JSON.stringify(meta))))
  )
}

// Is this stage there, without fetching it? One resolve answers: the handle's
// files ARE the batch existence check.
//
// BOTH halves still, though the per-density freedom that let them exist apart
// is gone: a half-written entry (payload without rivers) must read as absent,
// not as a stage that is ready and then draws a world with no rivers.
export async function amplificationArtifactExists(store: ArtifactStore, key: ArtifactKey): Promise<boolean> {
  const handle = await store.resolve(key, false)
  if (!handle) return false
  const needed = [FILES.meta, RIVER_FILES.points]
  return needed.every((name) => handle.files.includes(name))
}

// `familyMember` asks for a coarser tier OF THE SAME BAKE (the derived
// family): the member's own elevation/lake rasters plus the finest tier's
// rivers with their texel coordinates scaled down — a polyline is the same
// river at every resolution. Null when the entry predates the family or the
// member does not exist; the caller falls back to the finest.
export async function readAmplificationArtifact(store: ArtifactStore, key: ArtifactKey, familyMember?: number): Promise<{ artifact: AmplificationArtifact; bakeMs: number } | null> {
  const handle = await store.resolve(key, false)
  if (!handle) return null
  const meta = await readMeta(store, handle)
  if (!meta) return null
  const finestFactor = Number(key.stage)
  const memberScale = familyMember && finestFactor > 0 ? familyMember / finestFactor : 1
  const elevationName = familyMember ? familyFiles(familyMember).elevation : FILES.elevation
  const elevationBytes = await store.read(handle, elevationName)
  if (!elevationBytes) return null
  const width = Math.round(meta.width * memberScale)
  const height = Math.round(meta.height * memberScale)
  const expectedCells = width * height
  if (elevationBytes.byteLength !== expectedCells * 2) return null // truncated or from another shape

  // Rivers, and their absence makes the whole read fail.
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
  const rivers = RIVER_FILES
  const pointBytes = await store.read(handle, rivers.points)
  if (!pointBytes) return null
  const lengthBytes = await store.read(handle, rivers.lengths)
  // The lake layer is OPTIONAL, unlike the rivers above: a region bake makes
  // none, and neither did any bake before this layer existed. A wrong-sized
  // one is treated as absent rather than trusted — it would be from another
  // shape entirely.
  const lakeBytes = await store.read(handle, familyMember ? familyFiles(familyMember).lakeDepth : FILES.lakeDepth)
  const lakeDepth = lakeBytes && lakeBytes.byteLength === expectedCells
    ? decodeLayer(lakeBytes, LAKE_DEPTH_ENCODING)
    : null
  const riverPoints = new Float32Array(pointBytes)
  if (memberScale !== 1) {
    // [x, y, widthPx] per vertex: positions live in the finest grid's
    // texels and scale with the member; the drawn width is screen policy
    // and does not.
    for (let i = 0; i < riverPoints.length; i += 3) {
      riverPoints[i] *= memberScale
      riverPoints[i + 1] *= memberScale
    }
  }
  return {
    artifact: {
      elevation: decodeLayer(elevationBytes, ELEVATION_ENCODING),
      width,
      height,
      riverPoints,
      riverLengths: lengthBytes ? new Uint32Array(lengthBytes) : new Uint32Array(0),
      lakeDepth,
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
