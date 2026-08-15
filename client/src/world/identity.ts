// Deriving the two halves of an artifact's identity: WHICH WORLD the bytes
// belong to, and WHICH PIPELINE produced them. Both are content-derived on
// purpose — see docs/design/server-storage.md, where the same keys address
// the eventual server store.

// --- the world half -------------------------------------------------------
//
// The obvious candidate was a hash of the save's own recipe (world.yaml's
// `spec` and `status`). It does not work, and the save writer says why in
// its own comment: the epoch counts were deliberately REMOVED from the yaml
// because state.json already carries them. So two genuinely different worlds
// can share an identical recipe — same seed, same sliders, same erosion
// count, but tectonics stopped at epoch 40 rather than 90, which is
// different continents. Keying on that would ALIAS: one world served the
// other's terrain, presenting as a corrupt save or a physics bug rather than
// as a cache fault. That is the one failure a cache must not have.
//
// So the key is hashed from WHAT THE BAKE ACTUALLY CONSUMES. Identical
// inputs then mean an identical result by construction, and the key cannot
// drift away from the computation — including for future generator changes
// that alter terrain without touching the recipe, and for worlds that never
// came from this generator at all.

// FNV-1a over 32-bit words, run twice with different constants to get 64
// bits of key. Non-cryptographic on purpose: this defends against accidental
// collision, not against an adversary, and 8 MB has to stay a ~10 ms cost
// against a bake measured in minutes.
function fnv1a32(words: Uint32Array, offsetBasis: number, prime: number): number {
  let hash = offsetBasis >>> 0
  for (let i = 0; i < words.length; i++) {
    hash = (hash ^ words[i]) >>> 0
    hash = Math.imul(hash, prime) >>> 0
  }
  return hash >>> 0
}

// A byte view hashed as words, tolerating a length that is not a multiple of
// four (the tail is folded in separately rather than dropped).
function hashBytes(view: ArrayBufferView, seedA: number, seedB: number): [number, number] {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  const wordCount = bytes.byteLength >>> 2
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, wordCount)
  let a = fnv1a32(words, seedA, 0x01000193)
  let b = fnv1a32(words, seedB, 0x00000095)
  for (let i = wordCount << 2; i < bytes.byteLength; i++) {
    a = Math.imul((a ^ bytes[i]) >>> 0, 0x01000193) >>> 0
    b = Math.imul((b ^ bytes[i]) >>> 0, 0x00000095) >>> 0
  }
  return [a, b]
}

const hex8 = (value: number): string => (value >>> 0).toString(16).padStart(8, '0')

// Anything scalar that reaches the bake and is not already inside one of the
// rasters. Order matters (it is hashed as written), so this stays a single
// literal rather than an object spread from several places.
export interface BakeInputs {
  elevation: Float32Array
  precipitation: Float32Array | null
  erosionStrength: number | undefined
  drainageRefresh: number | undefined
}

// riverDensity is DELIBERATELY absent, and it used to be here.
//
// The rule is "hash what the bake consumes", and the bake does read it — but
// consuming and *costing* are not the same thing. Erosion strength and drainage
// refresh change the terrain, so they must invalidate everything. River density
// touches nothing before the final extraction: measured on a stage-2 bake, 70
// of 79 seconds are erosion and the density is first read after them.
//
// With it in the key, nudging the slider minted a new worldId and orphaned the
// whole artifact — 17 MB at 4k, 67 MB at 8k, per slider position, to redo a
// step worth seconds. It made the store worse than useless: it filled up with
// entries nothing would ever ask for again.
//
// Rivers are keyed BELOW this instead, per density, next to a shared elevation
// (see amplificationArtifact). Terrain is computed once; densities are cheap
// variations on it.

// A pure 64-bit content hash, sixteen hex characters. It used to carry the
// sanitised seed text as a readable prefix ("Ätna-1a2b…") — dropped
// 2026-08-12: identity came from the hash alone, the label was display data
// living in a key, and it was the only reason user text reached server paths
// at all (the accent-tolerant segment validation existed for it). The
// readable half now travels as `label` in the artifact's meta.json, and a
// world WITH a uid is named by the world store anyway.
export function deriveWorldId(inputs: BakeInputs): string {
  let [a, b] = hashBytes(inputs.elevation, 0x811c9dc5, 0x9e3779b9)
  if (inputs.precipitation) {
    const [pa, pb] = hashBytes(inputs.precipitation, a, b)
    a = pa
    b = pb
  }
  // The scalars go in through the same mixer, as text, so an absent value
  // and a zero cannot collapse into each other.
  const scalars = new TextEncoder().encode(
    `|s=${inputs.erosionStrength ?? 'd'}|r=${inputs.drainageRefresh ?? 'd'}`,
  )
  const [sa, sb] = hashBytes(scalars, a, b)
  return `${hex8(sa)}${hex8(sb)}`
}

// --- the pipeline half ----------------------------------------------------
//
// Two parts, because two different things can invalidate an artifact and
// only one of them is detectable automatically:
//
//  - ALGORITHM changes (a reordered pass, a different formula) leave every
//    constant untouched, so they need a human to bump the number below;
//  - VALUE changes are caught by hashing the constants themselves. This is
//    the half that matters in practice: three of these were retuned in a
//    single afternoon (2026-08-07), and a hand-maintained version number
//    would have been forgotten at least once — serving old terrain, which
//    reads as a physics bug rather than a stale cache.
//
// v2 (2026-08-07): the bake's erosion now rescales deltaMinDrainageCells for
// the finer grid along with the rest of the per-cell constants. That changes
// baked terrain — and it is exactly the invisible kind of change this number
// exists for, since it lives in a shared scaling function rather than in any
// constant AMPLIFY_CONSTANTS hashes.
// v3 (2026-08-08): the river threshold is no longer rescaled to a constant
// physical catchment, so a finer bake now yields a genuinely denser network
// instead of the same one at more vertices (amplify.ts has the measurements).
// The same invisible kind of change as v2 — it lives in which function gets
// called, not in any constant AMPLIFY_CONSTANTS hashes — and without the bump
// every cached 4k and 8k artifact, local and on the server, would keep serving
// the old sparse rivers under a key that claims to describe the new ones.
// v4 (2026-08-08): the channel criterion is slope-area rather than area alone
// (hydrology.CHANNEL_SLOPE_EXPONENT). Mountain channels roughly triple, so a
// cached v3 artifact holds a visibly different river network under a key that
// claims to describe this one.
// v5 (2026-08-11): incision into the world ocean is floored at estuary depth
// (SURFACE_TUNING.estuaryMaxDepthM) instead of the receiver's bed, so the
// bake stops carving shelf-deep arms into macro land — a cached v4 artifact
// holds coastlines this pipeline no longer produces. The constant itself is
// hashed via AMPLIFY_CONSTANTS; this bump is for the clamp-shape change.
// v6 (2026-08-11): the channel mask is closed downstream
// (hydrology.buildChannelMask) — the slope-area criterion initiates a channel,
// it no longer ends one mid-course, so a cached v5 artifact holds rivers that
// break into dashes on every plain this pipeline now draws through.
// v7 (2026-08-14): TWO changes, deliberately in one bump so the caches turn
// over once. (a) A river polyline now REACHES the water it drains into: the
// channel mask still stops at the last land cell, and the extractor adds the
// receiving water cell as the mouth point. The old gap was exactly one cell at
// every resolution — 7.8 km on the macro raster, still ~2 km after an 8k bake,
// i.e. about six 300 m hex tiles, which is where it became visible (measured
// 2026-08-14). (b) The bake now also re-floods the basins: an artifact carries
// a `lakeDepth.u8` layer beside its elevation, so lakes stop being 7.8 km macro
// blocks under 2 km terrain. A cached v6 artifact has neither.
// v8 (2026-08-14): the world's fine-detail SEED changed. It used to be a djb2
// hash of the seed text, invented by the save reader; it is now the
// generator's own `warpSeed` (itself `hashSeedString(seed + ":coastalWarp")`,
// so derivable from the same seed text) xor the shared FINE_DETAIL_SEED_SALT.
// One field family per world instead of three unrelated ones — the bake's seed
// roughness, the near-field cascade and the generator's own fine relief now
// agree. This bump is the whole reason it could be changed at all: the seed
// feeds `runAmplification` but is NOT part of the artifact key, so without a
// new version the same key would name two different terrains depending on
// which client baked it.
// v9 (2026-08-15): the single-flow receiver is D8-LTD instead of plain
// steepest descent (flowRouting.computeLtdFlowTargets has the method and the
// measurements). Incision and river tracing follow the true fall line instead
// of accumulating the 8-direction rounding error — on a plane tilted 15° off
// an axis, plain D8 holds one direction for 750 cells straight, and on real
// terrain the defect grew with resolution (streaks of ≥8 cells: 3.1 % of
// routed land at 4K, 12.2 % at 16K; LTD: 4.7 % at 16K). The invisible kind of
// change again — a receiver choice inside a shared function, hashed by no
// constant — and it reorganises every drainage network, so a cached v8
// artifact holds rivers this pipeline would never draw.
export const AMPLIFICATION_ALGO_VERSION = 9

// The constants the bake's output actually depends on. Passed in by the
// caller rather than imported here, so this module has no opinion about
// where they live and the list is visible at the call site — the place
// someone editing a constant is most likely to look.
export function derivePipelineVersion(constants: Record<string, number>): string {
  const text = Object.keys(constants)
    .sort()
    .map((name) => `${name}=${constants[name]}`)
    .join('|')
  const [a, b] = hashBytes(new TextEncoder().encode(text), 0x811c9dc5, 0x9e3779b9)
  return `v${AMPLIFICATION_ALGO_VERSION}-${hex8(a)}${hex8(b)}`
}

// --- a world's OWN identity, which is a different question ----------------
//
// `deriveWorldId` above answers "which terrain is this", and it is SUPPOSED to
// change whenever the terrain does — erode a world once more and its artifacts
// must be rebaked. A world also needs the opposite: an identity that survives
// exactly that, so the thing you named and own stays one thing on the server
// while its terrain evolves underneath. That is `metadata.uid` in world.yaml.
//
// The two live side by side deliberately. Reaching for the wrong one is the
// mistake this whole design exists to prevent (see
// docs/decisions/server-storage.md), and it is much harder to make when both
// are on the same screen with this comment between them.

// A brand-new world's identity: random, because nothing about a world's
// content should determine it.
export function newWorldUid(): string {
  return crypto.randomUUID()
}

// A LEGACY save's identity, derived once from the terrain it carries.
//
// This is not a contradiction of the rule above: the content does not BECOME
// the identity, it only SEEDS it. Once written into the save the uid is fixed
// and further erosion never moves it. The reason to derive rather than roll a
// random one is that the same pre-uid save file opened on two machines must
// land on ONE world in the store — a random id would silently make two, with
// no way left to merge them.
//
// Shaped as a UUID (version 8, the "custom" form) so a uid is one format
// everywhere and nothing downstream has to care where it came from. The
// elevation raster is the input rather than the zip's bytes because it is the
// world's substance: re-exporting the same world recompresses differently but
// does not change its terrain.
export function deriveWorldUid(elevation: ArrayBufferView): string {
  const [a, b] = hashBytes(elevation, 0x811c9dc5, 0x9e3779b9)
  // A second pass under different seeds, because a UUID needs 128 bits and one
  // pass yields 64. Chaining off the first keeps every input byte in both.
  const [c, d] = hashBytes(elevation, (a ^ 0x85ebca6b) >>> 0, (b ^ 0xc2b2ae35) >>> 0)
  const digits = (hex8(a) + hex8(b) + hex8(c) + hex8(d)).split('')
  digits[12] = '8' // version
  digits[16] = '89ab'[parseInt(digits[16], 16) & 0x3] // RFC 4122 variant
  const hex = digits.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
