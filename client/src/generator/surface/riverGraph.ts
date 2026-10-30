import type { SpringFeature } from './surfaceTypes'
import type { WaterBody } from './hydrology'
import type { RiverCourse } from './surfaceTypes'

// THE FEATURE GRAPH — the erosion's output as data (ADAPTIVE_MESH_PLAN.md
// phase 2, decision 10 of adaptive-mesh.md). Rivers are REACHES between
// NODES: a reach is the run of channel cells from one node to the next along
// the single-flow receivers, with what a consumer wants to know about it —
// discharge in and out, width, length, slope, sediment load, bank material,
// Strahler order — and a node is where reaches begin, meet or end: a source,
// a junction, a mouth into the sea, an inlet into a lake, a lake's outlet.
// The standing-water bodies of phase 1 are members (a lake is what an inlet
// reach ends in and an outlet reach starts from), and every mouth's
// catchment is recorded, which is the divide as data: the cells of the
// world that drain to that mouth.
//
// Derived from a FLOW SUBSTRATE (flowSubstrate.ts) — the mesh's (phase 4.3;
// the raster's until DEC-0036 phase 7b) — deterministically. A reach's
// `cells` are that substrate's element ids (mesh vertex ids; a graph read
// back from an older artifact may still be a raster's), and
// every consumer that needs a place reads `cellX`/`cellY`, the elements'
// texel positions carried beside them, never the id as a raster index.
// The river ribbons the generator draws are DERIVED from it
// (the engine's `river_polylines_from_graph`) rather than traced from the D8 receivers a
// second time; where the graph agrees with the old tracing the picture is
// the same, and where the old tracing broke a line at an arbitrary trunk
// it now follows the main stem.
//
// One deliberate carry-over: a river still runs THROUGH a lake as a reach
// of kind 'lake' from the inlet to the outlet, so the picture keeps the
// continuous line the map reads (river → lake → river, 2026-08-06); a
// consumer that wants the network without the lakes skips that kind.

export type RiverNodeKind = 'source' | 'junction' | 'mouth' | 'inlet' | 'outlet'

export interface RiverNode {
  id: number
  kind: RiverNodeKind
  // The node's cell, and its centre in texel coordinates. A mouth or an
  // inlet sits ON the water cell the reach ends in; an outlet on the last
  // wet cell before the river leaves its lake.
  cell: number
  x: number
  y: number
  // The water body a mouth (-1: the sea), inlet or outlet belongs to.
  body: number
  // For a mouth: how many land cells drain to it (its catchment); 0 for
  // other kinds.
  catchmentCells: number
}

export type RiverReachKind = 'river' | 'lake'

export interface RiverReach {
  id: number
  kind: RiverReachKind
  from: number
  to: number
  // The reach's cells in flow order, from the `from` node's cell to the
  // `to` node's cell inclusive — stored concatenated in RiverGraph.cells.
  cellStart: number
  cellCount: number
  // Discharge (the hydrology's unit: mm/yr summed over contributing cells)
  // entering at the first cell and leaving at the last own cell.
  dischargeIn: number
  dischargeOut: number
  // Drawn width at the downstream end, the ribbon scale (RIVER_MIN_WIDTH..
  // RIVER_MAX_WIDTH, √ of relative discharge).
  widthPx: number
  lengthKm: number
  // Height lost along the reach, metres, and the mean slope (m/m).
  dropM: number
  slope: number
  // Sediment carried out of the reach's last cell, m³ per engine iteration
  // (the engine's ξ–q flux), 0 when the caller had none.
  sedimentM3: number
  // The most common biome id along the reach's own cells (the bank
  // material phase 3 reads as bank strength), -1 when the caller had none.
  bank: number
  // Strahler order.
  order: number
  // Flow regime from climate alone (F6; SURFACE_TUNING.regimeAridBelow and
  // regimeDrySeasonBelow): perennial when the caller had no regime inputs.
  // The hydrogeology (phase 5a, surface/hydrogeology.ts) re-judges it with
  // the ground's baseflow and sets the two below.
  regime: RiverRegime
  // The dry-season flow the regime was judged on once the hydrogeology ran
  // (quick runoff plus baseflow, the discharge's unit); 0 before.
  runoffOut: number
  // A spring feeds this reach or one upstream of it (perennial by rule).
  springFed: boolean
}

export type RiverRegime = 'perennial' | 'intermittent' | 'ephemeral'

export interface RiverGraph {
  width: number
  height: number
  // Which substrate the cell ids index: raster cells or mesh vertices.
  substrate: 'raster' | 'mesh'
  nodes: RiverNode[]
  reaches: RiverReach[]
  // Every reach's cells, concatenated in reach order (see RiverReach.cellStart).
  cells: Int32Array
  // The texel position of every entry in `cells`.
  cellX: Float32Array
  cellY: Float32Array
  // The standing-water bodies the inlets and outlets refer to (phase 1).
  bodies: WaterBody[]
  // The course of every reach wide enough to show one (phase 3,
  // riverCourse.ts), in reach order; absent until computed.
  courses?: RiverCourse[]
  // The springs (phase 5a, surface/hydrogeology.ts); absent until computed.
  springs?: SpringFeature[]
}

// The graph's serialised form, which the engine writes (DEC-0044, fork 7b:
// `riverGraphParts`): one JSON document for everything but the cell runs,
// which travel as raw Int32 bytes (a baked world's reaches run to
// millions of cells; JSON would be an order of magnitude larger).
export interface SerializedRiverGraph {
  json: string
  cells: Int32Array
  // Every course line and oxbow, concatenated [x, y, …]; the JSON's courses
  // carry (start, count) descriptors into it. Empty without courses.
  coursePoints: Float32Array
  // The cells' texel positions, x y interleaved — only for a mesh graph
  // (a raster graph's positions follow from its cells and are not
  // written, so the artifact layout of the raster bake is unchanged).
  positions?: Float32Array
}
