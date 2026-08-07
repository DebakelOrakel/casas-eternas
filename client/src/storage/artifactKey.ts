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
  riverDensity: number | undefined
}

// `seedLabel` is carried into the id purely so a human reading the store
// (a directory listing now, a server path later) can tell which world an
// entry belongs to. Correctness comes from the hash alone; the label is
// sanitised and may repeat.
export function deriveWorldId(seedLabel: string, inputs: BakeInputs): string {
  let [a, b] = hashBytes(inputs.elevation, 0x811c9dc5, 0x9e3779b9)
  if (inputs.precipitation) {
    const [pa, pb] = hashBytes(inputs.precipitation, a, b)
    a = pa
    b = pb
  }
  // The scalars go in through the same mixer, as text, so an absent value
  // and a zero cannot collapse into each other.
  const scalars = new TextEncoder().encode(
    `|s=${inputs.erosionStrength ?? 'd'}|r=${inputs.drainageRefresh ?? 'd'}|q=${inputs.riverDensity ?? 'd'}`,
  )
  const [sa, sb] = hashBytes(scalars, a, b)
  // Sanitised by REMOVING what would break a path, not by allowing only
  // ASCII: an allow-list turned "Ätna" into "tna", which is worse than
  // useless as a label. Path separators, the Windows-reserved characters
  // and control codes go; everything else — accents included — stays, and
  // whitespace becomes dashes so the id remains one token. The trailing
  // hash is always the last dash-separated group, so dashes inside the
  // label are harmless.
  const label = seedLabel
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    // A leading dot would make the segment read as "." or ".."; the
    // trailing hash means it can never actually BE one, so this is
    // tidiness plus defence in depth.
    .replace(/^[.\s]+/, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 24) || 'world'
  return `${label}-${hex8(sa)}${hex8(sb)}`
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
export const AMPLIFICATION_ALGO_VERSION = 1

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
