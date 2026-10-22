// THE SEDIMENT COLUMN (ADAPTIVE_MESH_PLAN.md phase 5.2, decision 15 of
// docs/decisions/adaptive-mesh.md): what the erosion deposited at a node,
// as LAYERS over the bedrock. A deposit used to only raise z; here it is
// also a thickness with an age, a grain class and a provenance, and a
// node's erodibility is that of its top layer — a filled valley is soft,
// an exhumed bedrock floor hard, with no new physics.
//
// Layers are indexed by EPOCH across the whole mesh: layer k is the
// epoch `epochs[k]` for every node, so a node with nothing deposited in
// that epoch simply carries zero there. That is what lets the column ride
// the remesh as one stacked extensive field of mesh/meshState.ts — a new
// node interpolates layer by layer from its triangle, a removed node
// hands each layer to its neighbours by area — and what keeps a column
// exact through a merge: two nodes' k-th layers are the same layer.
//
// The cap (COLUMN_TUNING.layerCap, decided 2026-09-23: 8, the OLDEST two
// merge) bounds the state at a few floats per node; the merge sums the
// layers, so thickness and provenance products are conserved and only the
// boundary between the two oldest epochs is lost — the record stays fine
// at the top, where the resource layer reads it, and coarsens downward.
//
// Per layer six EXTENSIVE values, all in metres of column so that every
// one of them interpolates and merges linearly:
//   tFine    the fine class (mud, floodplain and marine wedge)
//   tCoarse  the coarse class (fans; written by phase 5.2b, zero until then)
//   pCraton  thickness × craton oldness of the source (crust/raftField, 1 =
//            ancient core) — a PRODUCT, so its ratio to the thickness is
//            the mean provenance, and the product stays linear under
//            interpolation where a mean would not
//   pHard    thickness × source hardness (the crust-history K story)
//   pTemp    thickness × the mean annual temperature at deposition, °C
//   pPrecip  thickness × the annual precipitation at deposition (the
//            climate grid's units) — the climate of a layer (phase 5.4:
//            coal from swamps, evaporites from arid closed basins) as the
//            same kind of product

export const COLUMN_TUNING = {
  // Layers per node; when full the two oldest merge.
  layerCap: 8,
  // A column thinner than this reads as bedrock for the erodibility — a
  // film a single iteration leaves is not a fill.
  softMinM: 1,
  // The erodibility of a sediment top relative to the neutral rock (1):
  // unconsolidated fill cuts several times faster than the lithology
  // lattice's median. To be measured against the golden valley fills.
  sedimentErodibility: 3,
} as const
export const COLUMN_VALUES = 6
export const COLUMN_DEPTH = COLUMN_TUNING.layerCap * COLUMN_VALUES

const T_FINE = 0
const T_COARSE = 1
const P_CRATON = 2
const P_HARD = 3
const P_TEMP = 4
const P_PRECIP = 5

// The column over a mesh: the stacked field (node-major, COLUMN_DEPTH per
// slot) and the epoch of every layer in use, oldest first.
export interface SedimentColumn {
  data: Float32Array
  epochs: number[]
}

// A deposit of `thicknessM` into the TOP layer, with its provenance.
export function deposit(column: SedimentColumn, v: number, thicknessM: number, craton: number, hard: number, tempC: number, precip: number, coarse = false): void {
  if (!(thicknessM > 0)) return
  const top = v * COLUMN_DEPTH + (column.epochs.length - 1) * COLUMN_VALUES
  const d = column.data
  d[top + (coarse ? T_COARSE : T_FINE)] += thicknessM
  d[top + P_CRATON] += thicknessM * craton
  d[top + P_HARD] += thicknessM * hard
  d[top + P_TEMP] += thicknessM * tempC
  d[top + P_PRECIP] += thicknessM * precip
}

// A cut of `thicknessM` taken from the column top down, layer by layer;
// returns the part that came out of sediment (the rest was bedrock).
// Within a layer the two classes and the provenance products go down in
// proportion, so the layer's means do not change as it thins.
export function cut(column: SedimentColumn, v: number, thicknessM: number): number {
  if (!(thicknessM > 0)) return 0
  const d = column.data
  let remaining = thicknessM
  let taken = 0
  for (let layer = column.epochs.length - 1; layer >= 0 && remaining > 0; layer--) {
    const base = v * COLUMN_DEPTH + layer * COLUMN_VALUES
    const t = d[base + T_FINE] + d[base + T_COARSE]
    if (t <= 0) continue
    if (t <= remaining) {
      remaining -= t
      taken += t
      for (let k = 0; k < COLUMN_VALUES; k++) d[base + k] = 0
    } else {
      const keep = (t - remaining) / t
      for (let k = 0; k < COLUMN_VALUES; k++) d[base + k] *= keep
      taken += remaining
      remaining = 0
    }
  }
  return taken
}
