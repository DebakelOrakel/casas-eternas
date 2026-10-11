import type { Domain } from '../core/domain'
import { MANTLE_TUNING } from './mantleTuneParams'
import type { Raft } from '../crust/raftTypes'
import { computeMembershipAt } from '../crust/raftField'
import { rasteriseField, sharedFieldMesh, type FieldMesh, type FieldSampler, type SavedField } from '../fields/fieldMesh'
import { diffuseExplicit, gradient, solveHelmholtz, stableDiffusionStep } from '../fields/fieldOperators'

// A coarse, evolving mantle buoyancy/temperature field under the whole
// surface — the CAUSE the plates ride on (Phase M2 of
// docs/decisions/evolving-euler-poles.md). Hot = upwelling, cold = downwelling.
// Its surface coupling closes the Wilson cycle: continents INSULATE the mantle
// (heat builds beneath them → an upwelling grows → the flow diverges under them →
// their plates are pushed apart → breakup), while ocean COOLS (downwelling →
// convergence → continents drift together → assembly). Bounded by diffusion +
// decay, so the whole thing stays stable — and the plate motions are FIT to the
// resulting flow (a bounded function of a bounded field), avoiding force-
// integration runaway.
//
// ON A FIELD MESH (DEC-0036 phase 1, docs/decisions/fields-on-meshes.md):
// the state is one Float64 value per cell of the mantle's field mesh
// (fields/fieldMesh.ts — Goldberg cells on the sphere, hexagons on the
// torus), and every operation on it is a phase-0 operator: finite-volume
// diffusion, the Poisson solve by conjugate gradients, the least-squares
// gradient. One code for both shapes, no pole rows, no line solves, no
// sub-steps. The 128 × 64 chart raster it had until 2026-10-11 survives
// only as the screen's overlay (rasteriseMantle); the save holds the mesh's
// own values (SavedField).
// Its readers take a value at a point through the mesh's sampler
// (mantleAt), the extrema searches walk the mesh's neighbour graph.
//
// LIVES IN ITS OWN MODULE because BOTH eras run on it: the Archean and the
// tectonics read this field, so filing it under either one made the other
// import across a boundary for its own substrate.
//
// The fit itself — `fitMotionsToFlow` — deliberately does NOT live here. It
// takes plate seeds and returns plate motions, so keeping it would have made
// the substrate depend on the thing riding on it. It is in
// `tectonics/plateMotion.ts` with the types it speaks in.

// The chart raster the field is written to (the screen's overlay) and, as
// a length, the mesh's spacing: the domain's width over MANTLE_RES_X — a cell as wide as the raster's at the equator
// (156 km on the 20 000 km sphere, 125 km on the torus at 2048 × 1024).
// Counted on the domain's width as the raster was, so a harness world
// narrower than 2048 has the same number of cells, each smaller.
export const MANTLE_RES_X = 128
export const MANTLE_RES_Y = 64

// The mantle's field mesh on a domain, with its sampler and what the
// operators below need of its geometry, built once per domain shape and
// size (the mesh reads only those: the same inputs give the same bytes).
export interface MantleMesh {
  readonly mesh: FieldMesh
  readonly sampler: FieldSampler
  // The spacing, metres: the raster's cell, which the field's former
  // units were counted in (a diffusion pass's reach, the flow's scale).
  readonly cellM: number
  // The spacing in domain units.
  readonly cellUnits: number
  // The total area, m², and the largest explicit diffusion step that
  // stays a convex combination (stableDiffusionStep at κ = 1), m².
  readonly totalArea: number
  readonly stableStep: number
}

const meshes = new Map<string, MantleMesh>()
// The last domain asked for, so a reader per point (a baseline per node)
// pays a comparison, not a key.
let lastDomain: Domain | null = null
let lastMesh: MantleMesh | null = null

export function mantleMesh(domain: Domain): MantleMesh {
  if (domain === lastDomain && lastMesh) return lastMesh
  const made = mantleMeshOf(domain)
  lastDomain = domain
  lastMesh = made
  return made
}

function mantleMeshOf(domain: Domain): MantleMesh {
  const key = `${domain.kind}:${domain.width}:${domain.height}:${domain.metresPerUnit}`
  const known = meshes.get(key)
  if (known) return known
  const cellUnits = domain.width / MANTLE_RES_X
  const cellM = cellUnits * domain.metresPerUnit
  const { mesh, sampler } = sharedFieldMesh(domain, cellM)
  let totalArea = 0
  for (let i = 0; i < mesh.count; i++) totalArea += mesh.area[i]
  const made: MantleMesh = { mesh, sampler, cellM, cellUnits, totalArea, stableStep: stableDiffusionStep(mesh, 1) }
  meshes.set(key, made)
  return made
}

// The field at a point: linear in the mesh's triangle under it.
export function mantleAt(field: ArrayLike<number>, domain: Domain, x: number, y: number): number {
  return mantleMesh(domain).sampler.sample(field, x, y)
}

// The field on the chart raster, cell centres (the DomainGrid's
// convention): the screen's overlay.
export function rasteriseMantle(field: ArrayLike<number>, domain: Domain): Float32Array {
  return rasteriseField(mantleMesh(domain).mesh, field, MANTLE_RES_X, MANTLE_RES_Y)
}

// THE FIELD AS A SAVE HOLDS IT (DEC-0036 phase 1, 2026-10-11): the mesh's
// own values with the mesh's identity (fields/fieldMesh.SavedField). No
// raster of the field is saved (the chart raster is the overlay's, made at
// runtime).
export function savedMantle(field: Float64Array, domain: Domain): SavedField {
  const mm = mantleMesh(domain)
  return { values: field.slice(), cells: mm.mesh.count, spacingM: mm.cellM }
}

// Whether a saved field's mesh (its cell count and spacing) is this
// domain's — what a loader asks before it hands the save on.
export function mantleFits(domain: Domain, cells: number, spacingM: number): boolean {
  const mm = mantleMesh(domain)
  return cells === mm.mesh.count && spacingM === mm.cellM
}

// The field back from a save, or null when there is none (the caller makes
// a new one). A field of another mesh — another spacing or cell count, a
// save from another build of the mesh — is refused with an error that says
// so: values per cell mean nothing on other cells.
export function restoreMantleField(domain: Domain, saved: SavedField | undefined): Float64Array | null {
  if (!saved) return null
  const mm = mantleMesh(domain)
  if (!mantleFits(domain, saved.cells, saved.spacingM) || saved.values.length !== mm.mesh.count) {
    throw new Error(`the saved mantle is for a mesh of ${saved.cells} cells at ${saved.spacingM} m (${saved.values.length} values); this world's has ${mm.mesh.count} at ${mm.cellM} m`)
  }
  return saved.values
}

// Smoothed random initial field — a few upwelling/downwelling blobs so there's
// convection (and therefore plate motion) from epoch 0, before surface coupling
// has reshaped it.
// How many blur passes smooth the initial random field into convection cells.
//
// This was the mantle-vigour knob, on the reasoning that changing the field's
// initial characteristic scale steers the world while leaving the tuned epoch
// dynamics alone. Measurement killed it: the per-epoch diffusion below erases the
// initial smoothing within a few dozen epochs. Field roughness by starting value
// (on the 128 × 64 raster, 2026-08):
//
//     passes   epoch 0   epoch 10   epoch 40
//       10      0.353      0.249      0.167
//        1      0.894      0.336      0.189
//     spread    2.53x      1.35x      1.13x
//
// Nine tenths of the difference is gone by epoch 40, and the phase is not stopped
// before epoch 150. A sweep over the full slider range confirmed the consequence:
// craton count, plate count and land fraction all varied non-monotonically, by no
// more than they varied between two seeds at the same setting.
//
// The knob moved to the per-epoch diffusion, which cannot wash out because it is
// reapplied every epoch — see ArcheanParams.diffusion. This constant is now just
// the starting scale, with no claim to steer anything.
export const DEFAULT_INITIAL_SMOOTHING = 6

export function createMantleField(random: () => number, domain: Domain, smoothingPasses = DEFAULT_INITIAL_SMOOTHING): Float64Array {
  const mm = mantleMesh(domain)
  let field: Float64Array = new Float64Array(mm.mesh.count)
  for (let i = 0; i < field.length; i++) field[i] = random() * 2 - 1
  for (let pass = 0; pass < smoothingPasses; pass++) field = diffusionPass(field, 0.5, mm)
  return zeroMean(clampField(field), mm)
}

// One pass of diffusion: what the raster's pass was — each cell moving
// `weight` of the way to its four neighbours' mean, φ + (weight / 4) h² ∇²φ
// with h the cell — as the finite-volume step on the mesh, κ dt = weight ·
// h² / 4 in m². In as many equal explicit steps as keep each a convex
// combination (one on the torus's hexagons at weight ½, whose bound is
// h² / 4; the sphere's smallest cells may take two).
function diffusionPass(field: Float64Array, weight: number, mm: MantleMesh): Float64Array {
  const kappaDt = (weight * mm.cellM * mm.cellM) / 4
  const steps = Math.max(1, Math.ceil(kappaDt / mm.stableStep))
  let a: Float64Array = field
  let b: Float64Array = new Float64Array(field.length)
  for (let s = 0; s < steps; s++) {
    diffuseExplicit(mm.mesh, a, kappaDt / steps, 1, b)
    const t = a
    a = b
    b = t
  }
  return a
}

// The area-weighted mean taken out.
function zeroMean(field: Float64Array, mm: MantleMesh): Float64Array {
  const { area } = mm.mesh
  let mean = 0
  for (let i = 0; i < field.length; i++) mean += field[i] * area[i]
  mean /= mm.totalArea
  for (let i = 0; i < field.length; i++) field[i] -= mean
  return field
}

function clampField(field: Float64Array): Float64Array {
  for (let i = 0; i < field.length; i++) field[i] = Math.max(-MANTLE_TUNING.clamp, Math.min(MANTLE_TUNING.clamp, field[i]))
  return field
}

// One epoch of field evolution: continents heat the mantle beneath (insulation →
// the doming driver), ocean cools it (downwelling), then diffuse + decay to a
// zero mean. Returns the new field (the argument may be reused).
//
// The continental membership is asked at each cell's centre
// (crust/raftField.computeMembershipAt), the question the raster asked at
// its cells' centres.
export function evolveMantleField(
  field: Float64Array,
  rafts: Raft[],
  domain: Domain,
  diffusionPasses: number = MANTLE_TUNING.diffusionPasses,
): Float64Array {
  const mm = mantleMesh(domain)
  const membership = computeMembershipAt(rafts, mm.mesh.x, mm.mesh.y, domain)
  for (let i = 0; i < field.length; i++) {
    if (membership[i] > 0.5) field[i] += MANTLE_TUNING.insulationRate
    else field[i] -= MANTLE_TUNING.oceanCoolRate
  }
  // Fractional passes: whole ones at full weight, then a partial one for the
  // remainder. Integer passes alone would give the Archean's mixing knob three
  // usable positions (0, 1, 2 — it saturates past that), which is not a slider.
  const wholePasses = Math.floor(diffusionPasses)
  for (let p = 0; p < wholePasses; p++) field = diffusionPass(field, MANTLE_TUNING.diffusionWeight, mm)
  const remainder = diffusionPasses - wholePasses
  if (remainder > 0) field = diffusionPass(field, MANTLE_TUNING.diffusionWeight * remainder, mm)
  for (let i = 0; i < field.length; i++) field[i] *= MANTLE_TUNING.decayKeep
  return zeroMean(clampField(field), mm)
}

// Keeps Archean convection alive by renormalising the field to a target RMS.
//
// evolveMantleField is written for a world that HAS continents: they insulate, the
// ocean cools, and the difference between the two sustains the pattern. With no
// crust at all the ocean term is uniform, zeroMean cancels it exactly, and all that
// remains is MANTLE_TUNING.decayKeep — so the field decays exponentially to nothing. Measured
// with zero crust: peak amplitude 0.443 at epoch 0, 0.007 by epoch 60.
//
// That would make the Archean impossible by construction — crust needs upwellings,
// and upwellings would need crust. The resolution is physical rather than a fudge:
// Archean convection was driven by RADIOGENIC HEAT and secular core cooling, not by
// surface insulation. Internal heating is the driver; the insulation feedback is a
// modulation on top of it, and it is the only one evolveMantleField models because
// by the time plates exist it is the only one that varies.
//
// Renormalising rather than injecting fresh noise is deliberate: it preserves the
// pattern the field has developed (cells keep their identity, drift and reorganise)
// while holding its amplitude steady, so a fixed nucleation threshold keeps meaning
// the same thing at epoch 10 and at epoch 300.
// The RMS is area-weighted.
export function sustainMantleVigour(field: Float64Array, targetRms: number, domain: Domain): Float64Array {
  const mm = mantleMesh(domain)
  const { area } = mm.mesh
  let sq = 0
  for (let i = 0; i < field.length; i++) sq += field[i] * field[i] * area[i]
  const rms = Math.sqrt(sq / mm.totalArea)
  if (rms < 1e-6) return field
  const scale = targetRms / rms
  for (let i = 0; i < field.length; i++) field[i] = Math.max(-MANTLE_TUNING.clamp, Math.min(MANTLE_TUNING.clamp, field[i] * scale))
  return field
}

// Release the thermal doming at a continental breakup: subtract a broad bump of
// buoyancy around the rift point (linear falloff to 0 at `worldRadius`). Physically,
// the upwelling that built under the insulating supercontinent has now breached the
// surface (the flood-basalt eruption) and the widening gap is floored with new,
// cooling ocean — so the buoyancy that DROVE the divergence is spent. This is what
// lets the global CONT_RIFT_COOLDOWN band-aid be retired (Option C): without it, the
// broad hot dome under an assembled continent keeps many boundary points divergent,
// so one breakup fires every epoch (strobing); draining the dome at breakup collapses
// that forcing regionally, so the flow (recomputed next epoch) stops pushing the
// halves apart at that spot and the strobing stops on its own. Mutates the field;
// the next evolveMantleField re-clamps + re-zero-means it.
export function coolMantleAt(field: Float64Array, x: number, y: number, domain: Domain, worldRadius: number, amount: number): void {
  const { mesh } = mantleMesh(domain)
  const r2 = worldRadius * worldRadius
  for (let i = 0; i < mesh.count; i++) {
    const d2 = domain.distanceSq(mesh.x[i], mesh.y[i], x, y)
    if (d2 > r2) continue
    const falloff = 1 - Math.sqrt(d2) / worldRadius
    field[i] = Math.max(-MANTLE_TUNING.clamp, field[i] - amount * falloff)
  }
}

// The surface flow, per cell in its own east/south frame, domain units per
// epoch (the frame Domain.advance moves a point in).
export interface MantleFlow {
  readonly east: Float64Array
  readonly south: Float64Array
}

// The relative residual the flow's Poisson solve stops at. The flow fits
// plate motions; 1e-8 of the right-hand side is far below anything they
// resolve. Measured 2026-10-11 at 2048 × 1024 after 40 Archean epochs: 190
// iterations on the torus (9 472 cells, 20 ms), 152 on the sphere (6 252,
// 11 ms); 1e-10 takes 223 / 191, 1e-6 still 171 / 131 — CG's cost here is
// its start, not its tail.
const FLOW_SOLVE_TOLERANCE = 1e-8

// Surface flow from the field: solve ∇²φ = T (zero-mean source on a closed
// surface, conjugate gradients), then u = ∇φ. u DIVERGES from hot upwellings
// and CONVERGES to cold downwellings (φ has a minimum at a hot source, so ∇φ
// points outward). In the units the raster counted in — φ in cell², the
// gradient per cell, h the cell (cellM) — then scaled by flowSpeedScale to
// domain units per epoch: ∇φ_cells = ∇φ_metres / h.
//
// The raster's Gauss-Seidel stopped after 260 sweeps, short of convergence
// at the longest wavelengths (a 128-cell mode about a quarter of the way);
// the solve here converges, so the broadest flow is the stronger by that.
export function computeMantleFlow(field: Float64Array, domain: Domain): MantleFlow {
  const mm = mantleMesh(domain)
  const { mesh } = mm
  const phi = new Float64Array(mesh.count)
  solveHelmholtz(mesh, 0, field, phi, { tolerance: FLOW_SOLVE_TOLERANCE })
  const east = new Float64Array(mesh.count)
  const south = new Float64Array(mesh.count)
  gradient(mesh, phi, east, south)
  const scale = MANTLE_TUNING.flowSpeedScale / mm.cellM
  for (let i = 0; i < mesh.count; i++) {
    east[i] *= scale
    south[i] *= scale
  }
  return { east, south }
}

// The flow at a point, read in the point's own frame. Into out.x, out.y.
export function mantleFlowAt(flow: MantleFlow, domain: Domain, x: number, y: number, out: { x: number; y: number }): void {
  mantleMesh(domain).sampler.sampleVector(flow.east, flow.south, x, y, -1, out)
}
