import type { Raft } from './raftTypes'
import type { CellBox, Domain } from '../core/domain'
import { worldEpochMa } from '../core/worldTime'

// Continental crust modeled as persistent "rafts" that ride on the kinematic
// plates, decoupled from them — see docs/decisions/continental-crust-rafts.md. A
// raft is a set of soft metaball blobs whose union is one continent's outline.
//
// The query "how continental is the crust here" (the summed metaball field)
// and everything it feeds are the engine's (crust/raft_field.rs). What is left
// here is what the screen draws from the rafts: the craton age and the
// Archean's progress.

// Metaball kernel: (1 - (d/r)²)² inside the blob, 0 outside. Smooth, finite
// support (so a query only sums nearby blobs), peaks at 1 at the center.
function blobKernel(distSq: number, radius: number): number {
  const r2 = radius * radius
  if (distSq >= r2) return 0
  const s = 1 - distSq / r2
  return s * s
}

// A coarse (resX×resY) field of continental crust "oldness" 0..1 — 1 where the
// crust formed at epoch 0 (the ancient cratonic cores), lower toward margins
// accreted later (see RaftBlob.birthEpoch). Metaball-weighted mean birth
// AGE per cell, normalized against the world's age — both in Ma
// (core/worldTime.worldEpochMa), because the stamps lie on the continuous
// epoch axis, on which an Archean epoch is five tectonic ones' worth
// (DEC-0036 phase 8b-2: counted in epochs, a margin born at the hand-over
// of a 1000 Ma Archean read 0.33 old after 100 tectonic epochs instead of
// 0.09). `archeanEpochs`: the Archean's length, the axis's era boundary —
// in the Archean itself its current epoch. Cells over ocean / no crust get
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
export function computeCratonOldnessField(rafts: Raft[], currentEpoch: number, archeanEpochs: number, resX: number, resY: number, domain: Domain): Float32Array {
  // Float64 accumulators, not Float32: the gathering version this replaces summed
  // in JS numbers, and rounding each partial sum to float32 instead moved ~10% of
  // cells by up to 9e-8 — enough to shift the Ecology hashes downstream.
  const weight = new Float64Array(resX * resY)
  const ageWeighted = new Float64Array(resX * resY)
  const cellW = domain.width / resX
  const cellH = domain.height / resY
  const grid = domain.grid(resX, resY)
  const box: CellBox = { x0: 0, x1: 0, y0: 0, y1: 0 }

  for (const raft of rafts) {
    for (const blob of raft.blobs) {
      const birth = worldEpochMa(blob.birthEpoch ?? 0, archeanEpochs)
      // Cell range the blob's radius can reach (DomainGrid.discBox). Left
      // unwrapped here and wrapped per cell below, so a blob straddling the
      // seam covers both sides.
      grid.discBox(blob.x, blob.y, blob.radius, box)
      for (let gy = box.y0; gy <= box.y1; gy++) {
        const wy = (gy + 0.5) * cellH
        for (let gx = box.x0; gx <= box.x1; gx++) {
          const wx = (gx + 0.5) * cellW
          const w = blobKernel(domain.distanceSq(wx, wy, blob.x, blob.y), blob.radius)
          if (w <= 0) continue
          const i = grid.index(gx, gy)
          weight[i] += w
          ageWeighted[i] += w * birth
        }
      }
    }
  }

  const out = new Float32Array(resX * resY)
  const nowMa = worldEpochMa(currentEpoch, archeanEpochs)
  for (let i = 0; i < out.length; i++) {
    out[i] = weight[i] === 0 ? -1 : nowMa <= 0 ? 1 : Math.max(0, Math.min(1, 1 - ageWeighted[i] / weight[i] / nowMa))
  }
  return out
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
// consolidation (the engine's consolidate_raft_blobs) merges stabilised
// blobs into fewer, larger ones, so a count-based fraction structurally
// DEFLATES as the phase matures — measured 61-63% at epoch 300 against 81-88% without
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
