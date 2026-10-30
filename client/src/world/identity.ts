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
  // A word view over an offset that is not a multiple of four throws; a
  // subarray of a packed buffer can land on one. Copying realigns it, and
  // the hash is over the bytes either way.
  const bytes = view.byteOffset % 4 === 0
    ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    : new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()
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

// WHAT DEFINES THE WORLD, as the save holds it (DEC-0036, the save step,
// 2026-10-12): the terrain mesh's own bytes and the field meshes' values —
// no raster. Until then the id hashed the elevation raster and the
// precipitation (later the climate's cells), with the mesh's bytes added
// in phase 5.8; the raster was the mesh's rasterisation, so it said
// nothing the mesh did not, and it left the save. Every world's id moved
// once with it (accepted, alpha): its artifacts are made again.
//
// Order matters (it is hashed as written), so this stays a single literal
// rather than an object spread from several places.
export interface BakeInputs {
  // The world's shape, the save's kind (worldRecord.ts, WorldKind): a torus
  // and a sphere with the same bytes are different terrains.
  kind: string
  // The v2 engine's controls. v1's erosionStrength/drainageRefresh were
  // carried here for backward-stable ids until the P5 teardown removed the
  // dead pass they belonged to — a deliberate id break for every save
  // (ALGO v11 had already orphaned all older artifacts, so what a changed id
  // costs is one re-bake, and what it buys is one hash shape instead of two).
  landscapeAge?: number
  alluvium?: number
  rockContrast?: number
  // THE TERRAIN (ADAPTIVE_MESH_PLAN.md phase 5.8): the node positions, the
  // heights and the sediment column — the connectivity is a function of the
  // positions through the canonical rebuild and adds nothing. Two worlds
  // with one surface but different columns are different worlds to every
  // job that reads the layers. Every tectonic save carries it.
  mesh: { nodes: Float32Array; z: Float32Array; column?: Uint8Array }
  // The annual climate per cell of its field mesh (save/climateFields.ts):
  // the bake samples it at its nodes. Null before the climate ran.
  climate: { seaLevelTemperature: Float32Array; precipitation: Float32Array; seasonalAmplitude: Float32Array; monsoonIndex: Float32Array } | null
  // The erosion's coarse forcing the bake erodes with, derived from the
  // snapshot (the engine's forcingOfSnapshot): the plates'
  // state as far as a bake reads it.
  forcing: { uplift: Float32Array; erodibility: Float32Array }
  // The field meshes the simulation continues from (Float64 per cell):
  // the mantle and the ocean age. No bake reads them; they are here because
  // the id names the world's state, and they change only with an epoch,
  // which moves the mesh as well — so they orphan no artifact the terrain
  // would not (the riverDensity trap below is a value that moves ALONE).
  mantle: Float64Array
  oceanAge: Float64Array
}

// riverDensity is DELIBERATELY absent, and it used to be here — twice removed.
//
// First from the key (2026-08-08): the rule is "hash what the bake consumes",
// but consuming and *costing* are not the same thing. With it in the key,
// nudging the slider minted a new worldId and orphaned the whole artifact —
// 17 MB at 4k, 67 MB at 8k, per slider position, to redo an extraction worth
// seconds; rivers were then keyed per-density BELOW the shared terrain.
//
// Then from the bake entirely (erosion-v2 P4): the network is extracted once
// at CANONICAL_RIVER_DENSITY and the slider became a pure draw filter, so
// even the per-density file names are gone. If a control ever needs this
// treatment again, that per-density file layout is the shape to bring back.

// A pure 64-bit content hash, sixteen hex characters. It used to carry the
// sanitised seed text as a readable prefix ("Ätna-1a2b…") — dropped
// 2026-08-12: identity came from the hash alone, the label was display data
// living in a key, and it was the only reason user text reached server paths
// at all (the accent-tolerant segment validation existed for it). The
// readable half now travels as `label` in the artifact's meta.json, and a
// world WITH a uid is named by the world store anyway.
export function deriveWorldId(inputs: BakeInputs): string {
  // The scalars first, as text, so an absent value and a zero cannot
  // collapse into each other — nor an absent column or climate and an
  // empty one.
  const scalars = new TextEncoder().encode(
    `|k=${inputs.kind}|a=${inputs.landscapeAge ?? 'd'}|al=${inputs.alluvium ?? 'd'}|rc=${inputs.rockContrast ?? 'd'}|col=${inputs.mesh.column ? 1 : 0}|c=${inputs.climate ? 1 : 0}`,
  )
  let [a, b] = hashBytes(scalars, 0x811c9dc5, 0x9e3779b9)
  const parts: ArrayBufferView[] = [inputs.mesh.nodes, inputs.mesh.z]
  if (inputs.mesh.column) parts.push(inputs.mesh.column)
  if (inputs.climate) parts.push(inputs.climate.seaLevelTemperature, inputs.climate.precipitation, inputs.climate.seasonalAmplitude, inputs.climate.monsoonIndex)
  parts.push(inputs.forcing.uplift, inputs.forcing.erodibility, inputs.mantle, inputs.oceanAge)
  for (const part of parts) [a, b] = hashBytes(part, a, b)
  return `${hex8(a)}${hex8(b)}`
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
// instead of the same one at more vertices (engine/crates/casas-engine/src/surface/amplify.rs has the measurements).
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
// generator's own `warpSeed` (itself `coastalWarpSeed(seed)`, archean/archeanState.ts,
// so derivable from the same seed text) xor the shared FINE_DETAIL_SEED_SALT.
// One field family per world instead of three unrelated ones — the bake's seed
// roughness, the near-field cascade and the generator's own fine relief now
// agree. This bump is the whole reason it could be changed at all: the seed
// feeds `runAmplification` but is NOT part of the artifact key, so without a
// new version the same key would name two different terrains depending on
// which client baked it.
// v9 (2026-08-15): the single-flow receiver is D8-LTD instead of plain
// steepest descent (engine/crates/casas-engine/src/surface/flow_routing.rs has the method and the
// measurements). Incision and river tracing follow the true fall line instead
// of accumulating the 8-direction rounding error — on a plane tilted 15° off
// an axis, plain D8 holds one direction for 750 cells straight, and on real
// terrain the defect grew with resolution (streaks of ≥8 cells: 3.1 % of
// routed land at 4K, 12.2 % at 16K; LTD: 4.7 % at 16K). The invisible kind of
// change again — a receiver choice inside a shared function, hashed by no
// constant — and it reorganises every drainage network, so a cached v8
// artifact holds rivers this pipeline would never draw.
// v10 (2026-08-16): the bake's erosion is the v2 ENGINE (erosion-v2 P3) —
// implicit mass-conserving solve with the save's U/hardness forcing layers,
// the world-seeded lithology lattice and the save's real precipitation as
// water contrast, replacing runErosionPass entirely. Old saves without the
// forcing layers bake with neutral forcing — the decided hard break. Every
// AMPLIFY_CONSTANTS member behind v1's pass left the key and the engine's
// parameter object entered it, so the membership change alone would move the
// hash; this bump names the fact that the MODEL changed, not a constant.
//
// v11 (2026-08-16): drainage density became climate-driven (erosion-v2 P4) —
// the 200 mm/yr runoffFloor left the runoff sampling, so arid regions carry
// genuinely few rivers, and the bake extracts its network at the one
// CANONICAL_RIVER_DENSITY instead of the save's slider value. Both change the
// baked rivers and lakes for an unchanged world; the floor was never in
// AMPLIFY_CONSTANTS, so the constants hash alone would not have moved.
//
// v12 (2026-10-22): what sets an artifact's bytes is the engine's
// (docs/decisions/rust-engine.md, fork 7b): the forcing, the artifacts'
// formats, the seeds, the raster and the land tiles moved into it, byte for
// byte, so the engine of a pipeline's release carries them. The worlds'
// mappings of their recorded controls (world/runParams.ts) entered the
// version at the same time. No byte of an artifact changed; the version
// moves because the image takes its engine from the release of its
// pipeline (docs/decisions/engine-releases.md), and a release of v11 has
// the engine without these.
//
// v13 (2026-10-25): level 1 is the generator's stages on the world at its
// replay's end — the save's refinement, the hydrology with its features —
// not `level_hydrology` on the last epoch's climate, and its artifact
// carries the land fields the ecology reads and the ecology's fields
// under the save's sliders (docs/decisions/level-waters.md). Its rivers and lakes change for an unchanged world,
// and the tiles that continue them with them; the worlds do not.
//
// v14 (2026-10-27): the history's shelf (docs/decisions/shelf-and-sea.md) —
// the margin profile's stops moved seaward, the profile stands on the mean
// sea of the last epochs instead of the ice-free datum, and the epoch's
// export fills the shelf. The worlds change: a recipe replays to other
// terrain. The fill's three numbers are in the surface tuning; the stops
// and the sea's anchor are in no hashed constant, hence the bump. With it,
// unpublished, the static annual range the history's ice reads
// (docs/decisions/seasons-and-ice.md): its form and its constants; and the
// volcanoes' build and the mesh in the open ocean
// (docs/decisions/volcanic-islands.md).
//
// v15 (2026-10-29): the ecology level 1 carries — the arable's crop
// response, season and leaching (docs/decisions/arable-crops.md) and the
// copper of the extinct arcs and of every active one
// (docs/decisions/copper-arcs.md). The worlds do not change (the ecology
// is a function on load, worldPipeline.ts SAME_WORLDS_AS); level 1's
// ecology fields do. The ecology's tuning is in no hashed constant (no
// run reads it, worldTuning.ts), hence the bump. Also in v15, unreleased:
// a tile's bake keeps its parent's level (docs/decisions/tile-jobs.md,
// 2026-10-29; no more crest on the tile borders) — its constants are
// tile constants, so the tiles' versions moved and the worlds' did not.
// And, unreleased: an epoch whose land holds a node coarser than twice
// the land's widest spacing remeshes (DES-0027 entry 19, 2026-10-29,
// HISTORY_DEFAULTS.remeshCoarseLand) — the worlds change: a recipe
// replays to other terrain, so v15 no longer makes v14's worlds
// (worldPipeline.ts SAME_WORLDS_AS).
// And, unreleased: the plates (DES-0027 entries 4, 2 and 27, 2026-10-29)
// — each seed moves toward its footprint's centre, a continent's keel
// drags its plate and the mantle's flow is faster (TECTONICS_TUNING
// seedRecentreRate, keelDrag, mantleFlowSpeedKmPerMyr), and the events
// and the history's trench read the crust beside a boundary, not the crust
// under a plate's seed. The worlds change again: a recipe replays to other
// terrain.
// And, unreleased: the heights (DES-0027 entries 18, 9 and 26, 2026-10-30)
// — a node under a lake cuts nothing, a basin below the sea that the
// ocean does not reach fills to its own spill level, and the interior
// push and the plateau's balance are lower (TECTONICS_TUNING
// intraplateShortening, collapseHeightM). The worlds change again: a
// recipe replays to other terrain.
// And, unreleased: the climate (DES-0027 entries 10, 13, 14 and 15,
// 2026-10-30) — the pole is warmer (CLIMATE_TUNING tempPoleC), a slope
// beside the sea gets its upslope rain, the tropical land's year is damped
// (ebmTropicDamping), and a basin under an ice sheet is flagged
// subglacial, not counted as a lake. The pole and the rain reach the
// epochs: the worlds change again, a recipe replays to other terrain.
// And, unreleased: the ice (DES-0027 entry 17, 2026-10-30) — the sliding
// cut goes with the basal shear stress up to the yield stress
// (SURFACE_TUNING glacialYieldStressPa, glacialErosionAtYieldMmPerYr; no
// cap of 800 m an epoch), and the ice stays grounded on a sea floor where
// it does not float, so a trough below the sea is cut on. The worlds
// change again: a recipe replays to other terrain.
// And, unreleased: the island arcs (DES-0027 entry 5, 2026-10-30) — an
// arc builds its volcanoes while it is active, not only in an epoch with
// a deposit, behind the trench (TECTONICS_TUNING volcanoArcGapM) and
// faster (volcanoBuildMPerMyr 1500 → 2250), so mature arcs rise above
// the sea as chains of islands. The worlds change again: a recipe
// replays to other terrain.
// And, unreleased: the ecology level 1 carries again (2026-10-30) — the
// flood silt raises the arable land on the floodplains of the large
// rivers that are not ephemeral, in a desert too (TEG-108,
// docs/decisions/arable-crops.md), and level 1 holds the ecology of the
// dry shelf to 120 m below the sea (TEG-13, shelfEcology.json and
// shelfEco.<id>.u8), which the incubator reads. The worlds do not change;
// level 1 does.
// And, unreleased: level 1 carries the temperature per node — the year's
// mean and the twelve months, in codes (TEG-109, the engine's
// `land_codes`). The worlds do not change; level 1's files do.
// And, unreleased: the mesh of a flat world locates a new node at the
// float32 position it stores (TEG-115, 2026-10-30). Flat worlds change
// a little; sphere worlds stay the same.
export const AMPLIFICATION_ALGO_VERSION = 15

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
// input is the world's substance rather than the zip's bytes: re-exporting
// the same world recompresses differently but does not change it. It was
// the elevation raster until the save stopped carrying one (DEC-0036, the
// save step); the mantle's values now, which every save holds (an Archean
// one too, `archean.mantle.f64`).
export function deriveWorldUid(substance: ArrayBufferView): string {
  const [a, b] = hashBytes(substance, 0x811c9dc5, 0x9e3779b9)
  // A second pass under different seeds, because a UUID needs 128 bits and one
  // pass yields 64. Chaining off the first keeps every input byte in both.
  const [c, d] = hashBytes(substance, (a ^ 0x85ebca6b) >>> 0, (b ^ 0xc2b2ae35) >>> 0)
  const digits = (hex8(a) + hex8(b) + hex8(c) + hex8(d)).split('')
  digits[12] = '8' // version
  digits[16] = '89ab'[parseInt(digits[16], 16) & 0x3] // RFC 4122 variant
  const hex = digits.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
