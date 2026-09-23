import type { MeshState } from './meshState'
import type { PeriodicTriangulation } from './periodicDelaunay'

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

export const MESH_COLUMN = 'column'
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

export function createColumn(slots: number): SedimentColumn {
  return { data: new Float32Array(slots * COLUMN_DEPTH), epochs: [] }
}

// The column's stacked field in a MeshState, for the remesh; the caller
// copies the values in (by the node mapping) and out (by the canonical
// order) exactly as it does for the relief.
export function addColumnField(state: MeshState): Float32Array {
  return state.add(MESH_COLUMN, 'extensive', COLUMN_DEPTH)
}

// The stacked field permuted to a canonical order (mesh/meshSerial.permute
// for a depth of COLUMN_DEPTH).
export function permuteColumn(data: Float32Array, order: Int32Array): Float32Array {
  const out = new Float32Array(order.length * COLUMN_DEPTH)
  for (let i = 0; i < order.length; i++) {
    const src = order[i] * COLUMN_DEPTH
    const dst = i * COLUMN_DEPTH
    for (let k = 0; k < COLUMN_DEPTH; k++) out[dst + k] = data[src + k]
  }
  return out
}

// Opens the layer of a new epoch: when the cap is reached the two oldest
// layers merge into one (their values summed, the older epoch kept), the
// stack shifts down, and the top layer is the new epoch's, empty.
export function openLayer(column: SedimentColumn, epoch: number, slots: number): void {
  const { data, epochs } = column
  if (epochs.length >= COLUMN_TUNING.layerCap) {
    for (let v = 0; v < slots; v++) {
      const base = v * COLUMN_DEPTH
      for (let k = 0; k < COLUMN_VALUES; k++) data[base + k] += data[base + COLUMN_VALUES + k]
      for (let layer = 1; layer < epochs.length - 1; layer++) {
        const to = base + layer * COLUMN_VALUES
        const from = to + COLUMN_VALUES
        for (let k = 0; k < COLUMN_VALUES; k++) data[to + k] = data[from + k]
      }
      const top = base + (epochs.length - 1) * COLUMN_VALUES
      for (let k = 0; k < COLUMN_VALUES; k++) data[top + k] = 0
    }
    epochs.splice(1, 1)
  }
  epochs.push(epoch)
  const layer = epochs.length - 1
  for (let v = 0; v < slots; v++) {
    const top = v * COLUMN_DEPTH + layer * COLUMN_VALUES
    for (let k = 0; k < COLUMN_VALUES; k++) data[top + k] = 0
  }
}

// The whole column's thickness at a node, metres.
export function columnThickness(data: Float32Array, v: number, layers: number): number {
  let t = 0
  const base = v * COLUMN_DEPTH
  for (let layer = 0; layer < layers; layer++) t += data[base + layer * COLUMN_VALUES + T_FINE] + data[base + layer * COLUMN_VALUES + T_COARSE]
  return t
}

// The erodibility the engine runs a node with: the sediment's when a fill
// of at least softMinM lies on top, else the bedrock's (the forcing's).
export function erodibilityOver(data: Float32Array, v: number, layers: number, bedrock: number): number {
  return columnThickness(data, v, layers) >= COLUMN_TUNING.softMinM ? COLUMN_TUNING.sedimentErodibility : bedrock
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

// The column's volume over the mesh, m³ (thickness in metres × area in
// square metres) — the harness's mass balance.
export function columnVolumeM3(column: SedimentColumn, mesh: PeriodicTriangulation, areaM2: ArrayLike<number>): number {
  let sum = 0
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v]) continue
    sum += columnThickness(column.data, v, column.epochs.length) * areaM2[v]
  }
  return sum
}

// The column's bytes for the save (`mesh/column.bin`): the layer count,
// the layers' epochs, then the values of the layers in use per node in
// the mesh's canonical order — nothing of the unused layers.
export function encodeColumn(column: SedimentColumn, count: number): Uint8Array {
  const layers = column.epochs.length
  const values = layers * COLUMN_VALUES
  const bytes = new Uint8Array(4 + 4 * layers + 4 * count * values)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, layers, true)
  for (let k = 0; k < layers; k++) view.setInt32(4 + 4 * k, column.epochs[k], true)
  const out = new Float32Array(bytes.buffer, 4 + 4 * layers, count * values)
  for (let v = 0; v < count; v++) {
    const src = v * COLUMN_DEPTH
    const dst = v * values
    for (let k = 0; k < values; k++) out[dst + k] = column.data[src + k]
  }
  return bytes
}

// The values per layer are read off the byte length: a save from before
// the climate products (formatVersion 4, four per layer) restores with
// those two at zero.
export function decodeColumn(bytes: Uint8Array, count: number, slots: number): SedimentColumn {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const layers = view.getUint32(0, true)
  if (layers > COLUMN_TUNING.layerCap) throw new Error(`column: ${layers} layers over the cap`)
  const column = createColumn(slots)
  for (let k = 0; k < layers; k++) column.epochs.push(view.getInt32(4 + 4 * k, true))
  if (layers === 0 || count === 0) return column
  const body = bytes.byteLength - 4 - 4 * layers
  const perLayer = body / (4 * count * layers)
  if (perLayer !== 4 && perLayer !== COLUMN_VALUES) throw new Error('column: byte length does not match the node count')
  const values = layers * perLayer
  // Copied through a DataView: the bytes need not be 4-aligned.
  const at = 4 + 4 * layers
  for (let v = 0; v < count; v++) {
    const dst = v * COLUMN_DEPTH
    for (let layer = 0; layer < layers; layer++) {
      for (let k = 0; k < perLayer; k++) column.data[dst + layer * COLUMN_VALUES + k] = view.getFloat32(at + 4 * (v * values + layer * perLayer + k), true)
    }
  }
  return column
}
