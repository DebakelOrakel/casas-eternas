import type { PlateSeed } from '../tectonics/plateSeeds'
import type { PlateType } from '../tectonics/plateTypes'
import type { Raft } from './raftTypes'
import { toroidalDistanceSq } from '../core/toroidal'
import { smoothstepBetween } from '../core/interpolation'
import { sampleNearestWorld, wrapValue } from '../core/field'

// Continental crust modeled as persistent "rafts" that ride on the kinematic
// plates, decoupled from them — see docs/decisions/continental-crust-rafts.md. A
// raft is a set of soft metaball blobs whose union is one continent's outline.
//
// This module answers only ONE question, at any point on the torus: how
// continental is the crust here? Everything downstream — elevation's margin
// profile, mantle insulation, plate typing, the ocean-age sink — is a consumer of
// that single query. Keeping it apart from the lifecycle operations matters
// because the query is called millions of times per render while the lifecycle
// runs a handful of times per epoch.

// Metaball kernel: (1 - (d/r)²)² inside the blob, 0 outside. Smooth, finite
// support (so a query only sums nearby blobs), peaks at 1 at the center.
function blobKernel(distSq: number, radius: number): number {
  const r2 = radius * radius
  if (distSq >= r2) return 0
  const s = 1 - distSq / r2
  return s * s
}

// The summed metaball field maps to continental membership via a smooth
// threshold band: below FIELD_LO fully oceanic, above FIELD_HI fully
// continental, smoothstep between. A single blob peaks at field 1 at its
// center, so a lone blob's coastline sits partway out; overlapping blobs
// sum higher and union into one landmass with no seam.
const FIELD_LO = 0.35
const FIELD_HI = 0.65


// The raw summed metaball field at a world point — 0 far from any crust, 1 at a
// lone blob's centre, higher where blobs overlap. Sums every blob's kernel
// (toroidally wrapped); brute-force over blobs for now, like the feature query
// was before bucketing — add a spatial index later if it shows up in a profile.
//
// Exposed separately from raftMembership because elevation needs the field
// itself, not the thresholded membership: the margin profile (elevationScale.ts)
// runs its own, wider band over this same field so a continental shelf has room
// to exist. Thresholding first would throw away exactly the range it needs.
export function raftField(x: number, y: number, rafts: Raft[], width: number, height: number): number {
  let field = 0
  for (const raft of rafts) {
    for (const blob of raft.blobs) {
      field += blobKernel(toroidalDistanceSq(x, y, blob.x, blob.y, width, height), blob.radius)
    }
  }
  return field
}

// A BUCKET INDEX over the blobs, for a sweep that asks raftField (or the
// nearest raft) at every node of the mesh: built once per sweep, it hands
// a point only the blobs whose reach covers its bucket instead of every
// blob of every raft (2026-10-02: the brute-force scans were 12–14 % of an
// epoch). The SAME bits as the scans: a blob left out is one whose kernel
// is exactly 0 there (adding 0 changes nothing), and the blobs of a bucket
// keep the scans' order — raft by raft, blob by blob — so the sum adds in
// the same order and the nearest search breaks ties the same way.
//
// Valid only while the rafts do not change: build it right before the
// sweep, never keep it across a step that moves, grows or merges rafts.
export interface BlobIndex {
  rafts: Raft[]
  width: number
  height: number
  nx: number
  ny: number
  start: Int32Array
  items: Int32Array
  bx: Float64Array
  by: Float64Array
  br: Float64Array
  braft: Int32Array
}

const INDEX_NX = 32
const INDEX_NY = 16

// `reach` in radii: a blob is filed wherever a point within reach × its
// radius can lie (1 for raftField; the nearest search's own reach for it).
export function buildBlobIndex(rafts: Raft[], width: number, height: number, reach = 1): BlobIndex {
  let total = 0
  for (const raft of rafts) total += raft.blobs.length
  const bx = new Float64Array(total)
  const by = new Float64Array(total)
  const br = new Float64Array(total)
  const braft = new Int32Array(total)
  let g = 0
  for (let r = 0; r < rafts.length; r++) {
    for (const blob of rafts[r].blobs) {
      bx[g] = blob.x
      by[g] = blob.y
      br[g] = blob.radius
      braft[g] = r
      g++
    }
  }
  const nx = INDEX_NX
  const ny = INDEX_NY
  const cw = width / nx
  const ch = height / ny
  const buckets: number[][] = Array.from({ length: nx * ny }, () => [])
  const span = (centre: number, extent: number, size: number, n: number, period: number): number[] => {
    // A margin far above the wrapped distance's rounding and the point's
    // wrap: the filing must cover every point the kernel could reach.
    const e = extent * (1 + 1e-9) + 1e-6
    if (!(e < Infinity) || 2 * e >= period) return Array.from({ length: n }, (_, i) => i)
    const c = wrapValue(centre, period)
    const i0 = Math.floor((c - e) / size)
    const i1 = Math.floor((c + e) / size)
    if (i1 - i0 + 1 >= n) return Array.from({ length: n }, (_, i) => i)
    const out: number[] = []
    for (let i = i0; i <= i1; i++) out.push(((i % n) + n) % n)
    return out
  }
  for (let k = 0; k < total; k++) {
    const extent = br[k] * reach
    const xs = span(bx[k], extent, cw, nx, width)
    const ys = span(by[k], extent, ch, ny, height)
    for (const j of ys) for (const i of xs) buckets[j * nx + i].push(k)
  }
  const start = new Int32Array(nx * ny + 1)
  for (let b = 0; b < nx * ny; b++) start[b + 1] = start[b] + buckets[b].length
  const items = new Int32Array(start[nx * ny])
  for (let b = 0; b < nx * ny; b++) items.set(buckets[b], start[b])
  return { rafts, width, height, nx, ny, start, items, bx, by, br, braft }
}

function bucketOf(index: BlobIndex, x: number, y: number): number {
  const i = Math.min(index.nx - 1, Math.floor((wrapValue(x, index.width) / index.width) * index.nx))
  const j = Math.min(index.ny - 1, Math.floor((wrapValue(y, index.height) / index.height) * index.ny))
  return j * index.nx + i
}

// raftField through the index: the same value, bit for bit.
export function raftFieldIndexed(x: number, y: number, index: BlobIndex): number {
  if (!(Math.abs(x) < Infinity && Math.abs(y) < Infinity)) return raftField(x, y, index.rafts, index.width, index.height)
  const b = bucketOf(index, x, y)
  const { items, bx, by, br, width, height } = index
  let field = 0
  for (let k = index.start[b]; k < index.start[b + 1]; k++) {
    const g = items[k]
    field += blobKernel(toroidalDistanceSq(x, y, bx[g], by[g], width, height), br[g])
  }
  return field
}

// The raft whose blob is nearest in radii, within `reach` radii, or −1 —
// the scan `d < nearest` over every blob in order, through the index (built
// with at least this reach).
export function nearestRaftIndexed(x: number, y: number, index: BlobIndex, reach: number): number {
  const { items, bx, by, br, braft, width, height } = index
  let onRaft = -1
  let nearest = reach
  if (!(Math.abs(x) < Infinity && Math.abs(y) < Infinity)) {
    for (let g = 0; g < bx.length; g++) {
      const d = Math.sqrt(toroidalDistanceSq(x, y, bx[g], by[g], width, height)) / br[g]
      if (d < nearest) { nearest = d; onRaft = braft[g] }
    }
    return onRaft
  }
  const b = bucketOf(index, x, y)
  for (let k = index.start[b]; k < index.start[b + 1]; k++) {
    const g = items[k]
    const d = Math.sqrt(toroidalDistanceSq(x, y, bx[g], by[g], width, height)) / br[g]
    if (d < nearest) { nearest = d; onRaft = braft[g] }
  }
  return onRaft
}

// Continental membership 0..1 at a world point — 0 open ocean, 1 solid
// continental interior. This is the "is it continental crust" question (plate
// typing, accretion, mantle insulation, rift eligibility), NOT "is it above
// water" — see marginProfile for the latter.
export function raftMembership(x: number, y: number, rafts: Raft[], width: number, height: number): number {
  return smoothstepBetween(FIELD_LO, FIELD_HI, raftField(x, y, rafts, width, height))
}

// Continental membership sampled onto a coarse grid, computed ONCE per epoch and
// shared by every consumer that needs "is there continent here" over the whole
// surface. raftMembership is a brute-force scan over every blob of every raft, so
// a full-surface sweep costs cells × blobs — and blob counts grow through a run as
// margins accrete. mantleField already paid that (128×64 per epoch); adding a
// second independent sweep for the ocean-age sink would have roughly quintupled it
// at the 256×128 age resolution. One field, sampled by world coordinate, keeps it
// at a single sweep regardless of how many consumers there are.
export function computeMembershipField(rafts: Raft[], resX: number, resY: number, width: number, height: number): Float32Array {
  const out = new Float32Array(resX * resY)
  for (let gy = 0; gy < resY; gy++) {
    const wy = ((gy + 0.5) / resY) * height
    for (let gx = 0; gx < resX; gx++) {
      const wx = ((gx + 0.5) / resX) * width
      out[gy * resX + gx] = raftMembership(wx, wy, rafts, width, height)
    }
  }
  return out
}

// Nearest-cell sample of a membership field at a world point (torus-wrapped), so
// consumers on their own grids can read it without caring what resolution it was
// computed at. Nearest rather than bilinear on purpose: every consumer thresholds
// the result (> 0.5) rather than using its magnitude, so interpolation would only
// cost time.
export function sampleMembershipField(field: Float32Array, resX: number, resY: number, x: number, y: number, width: number, height: number): number {
  return sampleNearestWorld(field, resX, resY, x, y, width, height)
}

// A coarse (resX×resY) field of continental crust "oldness" 0..1 — 1 where the
// crust formed at epoch 0 (the ancient cratonic cores), lower toward margins
// accreted later (see RaftBlob.birthEpoch). Metaball-weighted mean birth epoch
// per cell, normalized against the current epoch. Cells over ocean / no crust get
// -1. Feeds iron placement (old cratons) in the Ecology layer, and the Archean's
// craton-age overlay.
//
// Scatters each blob over the cells it can reach, rather than asking every cell
// about every blob. blobKernel is exactly zero at and beyond the blob radius, so
// this is the same field to the last bit — only the work is proportional to the
// crust that exists instead of to (cells × blobs). That matters because the Archean
// recomputes this every epoch at 180 ms: gathering cost about 5 million kernel
// evaluations per frame at 256×128 with 156 blobs, scattering costs about 40
// thousand.
export function computeCratonOldnessField(rafts: Raft[], currentEpoch: number, resX: number, resY: number, width: number, height: number): Float32Array {
  // Float64 accumulators, not Float32: the gathering version this replaces summed
  // in JS numbers, and rounding each partial sum to float32 instead moved ~10% of
  // cells by up to 9e-8 — enough to shift the Ecology hashes downstream.
  const weight = new Float64Array(resX * resY)
  const ageWeighted = new Float64Array(resX * resY)
  const cellW = width / resX
  const cellH = height / resY

  for (const raft of rafts) {
    for (const blob of raft.blobs) {
      const birth = blob.birthEpoch ?? 0
      // Cell range the blob's radius can reach. Left unwrapped here and wrapped per
      // cell below, so a blob straddling the seam covers both sides.
      const gx0 = Math.floor((blob.x - blob.radius) / cellW)
      const gx1 = Math.ceil((blob.x + blob.radius) / cellW)
      const gy0 = Math.floor((blob.y - blob.radius) / cellH)
      const gy1 = Math.ceil((blob.y + blob.radius) / cellH)
      for (let gy = gy0; gy <= gy1; gy++) {
        const wy = (gy + 0.5) * cellH
        const row = (((gy % resY) + resY) % resY) * resX
        for (let gx = gx0; gx <= gx1; gx++) {
          const wx = (gx + 0.5) * cellW
          const w = blobKernel(toroidalDistanceSq(wx, wy, blob.x, blob.y, width, height), blob.radius)
          if (w <= 0) continue
          const i = row + (((gx % resX) + resX) % resX)
          weight[i] += w
          ageWeighted[i] += w * birth
        }
      }
    }
  }

  const out = new Float32Array(resX * resY)
  for (let i = 0; i < out.length; i++) {
    out[i] = weight[i] === 0 ? -1 : currentEpoch <= 0 ? 1 : Math.max(0, Math.min(1, 1 - ageWeighted[i] / weight[i] / currentEpoch))
  }
  return out
}

// Coarse "which raft owns this point" field — the index (into `rafts`) of
// whichever raft's blob contributes the MOST to the summed metaball field
// there, or -1 where no raft reaches at all (open ocean, or a volcanic
// island/ridge/hotspot-chain feature sitting on crust no raft claims — the
// raft model never says those points are continental). Grouping land by this
// is what lets applyMountainRedistribution (elevationField.ts) normalize each
// continent against its OWN achieved peak instead of the whole world's — a
// single exceptional summit anywhere used to flatten every other range's
// relative prominence too, since they all shared one normalization reference.
//
// Scatter over each blob's own reach (same pattern as
// computeCratonOldnessField below), not a per-cell scan over every raft's
// every blob — cost proportional to how much crust exists, not to
// resX*resY*raftCount. "Most contribution" (not just "any contribution") is
// what makes this well-defined at a border where two continents' fields both
// reach the same cell: whichever's blob is closer/bigger there wins that
// cell, which is the same tie-break spirit as raftMembership's own summed
// field, just tracked per-raft instead of pooled.
export function computeOwnerField(rafts: Raft[], resX: number, resY: number, width: number, height: number): Int32Array {
  const best = new Float32Array(resX * resY)
  const owner = new Int32Array(resX * resY).fill(-1)
  const cellW = width / resX
  const cellH = height / resY
  rafts.forEach((raft, raftIndex) => {
    for (const blob of raft.blobs) {
      const gx0 = Math.floor((blob.x - blob.radius) / cellW)
      const gx1 = Math.ceil((blob.x + blob.radius) / cellW)
      const gy0 = Math.floor((blob.y - blob.radius) / cellH)
      const gy1 = Math.ceil((blob.y + blob.radius) / cellH)
      for (let gy = gy0; gy <= gy1; gy++) {
        const wy = (gy + 0.5) * cellH
        const row = (((gy % resY) + resY) % resY) * resX
        for (let gx = gx0; gx <= gx1; gx++) {
          const wx = (gx + 0.5) * cellW
          const v = blobKernel(toroidalDistanceSq(wx, wy, blob.x, blob.y, width, height), blob.radius)
          const i = row + (((gx % resX) + resX) % resX)
          if (v <= best[i]) continue
          best[i] = v
          owner[i] = raftIndex
        }
      }
    }
  })
  return owner
}

export function sampleOwnerField(owner: Int32Array, resX: number, resY: number, x: number, y: number, worldWidth: number, worldHeight: number): number {
  const gx = Math.min(resX - 1, Math.floor((wrapValue(x, worldWidth) / worldWidth) * resX))
  const gy = Math.min(resY - 1, Math.floor((wrapValue(y, worldHeight) / worldHeight) * resY))
  return owner[gy * resX + gx]
}

// Phase 1 bridge: the existing crust-type-consuming code (boundary
// classification, events, rift/merge) still reads a per-plate PlateType, but
// rafts are the source of truth now, so a plate's type is DERIVED — it's
// continental if a raft covers its seed. Later phases move those consumers
// onto direct raft geometry and this goes away.
const SEED_CONTINENTAL_THRESHOLD = 0.5

export function derivePlateTypes(seeds: PlateSeed[], rafts: Raft[], width: number, height: number): PlateType[] {
  return seeds.map((seed) => (raftMembership(seed.x, seed.y, rafts, width, height) >= SEED_CONTINENTAL_THRESHOLD ? 'continental' : 'oceanic'))
}

// Fraction of crust blobs that have passed the stabilisation age and can no longer
// be recycled — the Archean's progress indicator.
//
// Measured over 600 epochs this is the one quantity that reads the phase cleanly:
// 6% at epoch 50, 54% at 200, 58% at 300, 91% at 600, monotone throughout. The age
// SPREAD does not work for this (it just grows linearly forever, since the oldest
// cores keep aging), and the crust fraction does not either (it keeps climbing).
//
// It also lines up with what the map is doing: "several separate cratons" holds
// until roughly 60%, and past ~85% the destructible pool has nearly vanished, so
// the world stops changing shape and only accumulates land.
// AREA-weighted (Σ radius²), not blob-counted (2026-08-06): blob
// consolidation (consolidateRaftBlobs) merges stabilised blobs into fewer,
// larger ones, so a count-based fraction structurally DEFLATES as the phase
// matures — measured 61-63% at epoch 300 against 81-88% without
// consolidation, for the same amount of stable crust. Area is what the
// gauge always meant: how much of the CRUST is immune, not how many
// bookkeeping blobs are.
export function stabilisedFraction(rafts: Raft[], epoch: number, stabilisationEpochs: number): number {
  let total = 0
  let stable = 0
  for (const raft of rafts) {
    for (const blob of raft.blobs) {
      const area = blob.radius * blob.radius
      total += area
      if (epoch - (blob.birthEpoch ?? 0) >= stabilisationEpochs) stable += area
    }
  }
  return total === 0 ? 0 : stable / total
}
