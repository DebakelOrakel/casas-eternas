import type { PlateSeed } from '../tectonics/plateSeeds'
import type { PlateType } from '../tectonics/plateTypes'
import type { Raft } from './raftTypes'
import { toroidalDistanceSq } from '../core/toroidal'
import { smoothstepBetween } from '../core/interpolation'
import { sampleNearestWorld } from '../core/field'

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
// -1. Feeds iron placement (old cratons) in the Ecology layer. O(cells × blobs);
// called on-demand, not per frame.
export function computeCratonOldnessField(rafts: Raft[], currentEpoch: number, resX: number, resY: number, width: number, height: number): Float32Array {
  const out = new Float32Array(resX * resY)
  for (let gy = 0; gy < resY; gy++) {
    const wy = ((gy + 0.5) / resY) * height
    for (let gx = 0; gx < resX; gx++) {
      const wx = ((gx + 0.5) / resX) * width
      let wSum = 0
      let ageSum = 0
      for (const raft of rafts) {
        for (const blob of raft.blobs) {
          const w = blobKernel(toroidalDistanceSq(wx, wy, blob.x, blob.y, width, height), blob.radius)
          if (w > 0) { wSum += w; ageSum += w * (blob.birthEpoch ?? 0) }
        }
      }
      out[gy * resX + gx] = wSum === 0 ? -1 : currentEpoch <= 0 ? 1 : Math.max(0, Math.min(1, 1 - (ageSum / wSum) / currentEpoch))
    }
  }
  return out
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
export function stabilisedFraction(rafts: Raft[], epoch: number, stabilisationEpochs: number): number {
  let total = 0
  let stable = 0
  for (const raft of rafts) {
    for (const blob of raft.blobs) {
      total++
      if (epoch - (blob.birthEpoch ?? 0) >= stabilisationEpochs) stable++
    }
  }
  return total === 0 ? 0 : stable / total
}
