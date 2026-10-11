import { type FlowLine, flowLinePieces, type FlowPoint } from './flowLines'
import type { ChartPoint } from './worldView'

// THE MARKS OF A VECTOR FIELD (the wind's strokes, the currents' arrows) as
// symbols the world view places (worldView.ts, WorldSymbol): where each mark
// lies, the direction it points ON THE SURFACE, its length and its speed.
// Pure arithmetic, no scene, so a script can check it
// (scripts/symbolPlacement.mjs). The pictures are the screen's.
//
// Until 2026-10-11 the marks were painted into the 2:1 chart texture. On
// the globe the east–west part of each stroke then shrank by cos φ while
// its width and the spacing stayed, so toward the poles the marks turned
// into radial slivers, a ring of spikes at the pole and crowded rows. A
// placed mark keeps its shape everywhere.
//
// The sampling follows the world's shape:
// - the torus keeps its flow lines (flowLines.ts): one mark per piece of a
//   line, at the piece's place, along its chord;
// - the sphere samples the globe evenly in true lengths: rows of equal
//   spacing from pole to pole, in each row a number of marks in proportion
//   to its circumference, one mark at each pole.

// A mark. `at`: its centre. `angle`: its direction on the surface, the
// WorldSymbol contract (x toward +u, y toward +v, in true lengths).
// `length`: its length in chart texels at the equator (true lengths on the
// sphere). `speed`: the field's speed there, as a fraction of the reference
// speed. `loop`: a piece of a closed circuit (a gyre). `mid`: the point the
// mark takes its class from (warm or cold water), in chart fractions.
export interface VectorMark {
  at: ChartPoint
  angle: number
  length: number
  speed: number
  loop: boolean
  mid: ChartPoint
}

const wrapUnit = (f: number): number => ((f % 1) + 1) % 1

// --- the torus ----------------------------------------------------------------

// One mark per piece of the flow lines (flowLines.ts flowLinePieces), the
// pieces the painted marks were drawn from: a piece with fewer than
// `minPoints` points is left out, as the painting left it out. The mark
// runs straight from the piece's first point to its last (a painted mark
// followed the line's curve). `speed`: the mean over the piece, each point
// capped at `speedCap` (the arrows capped it at 1, the strokes did not).
export function flowLineMarks(lines: FlowLine[], options: {
  width: number
  height: number
  length: number
  gap: number
  closeLoops: boolean
  minPoints: number
  speedCap: number
}): VectorMark[] {
  const marks: VectorMark[] = []
  for (const { line, points } of flowLinePieces(lines, options.length, options.gap, options.closeLoops)) {
    if (points.length < options.minPoints) continue
    const first = points[0]
    const last = points[points.length - 1]
    const dx = last.x - first.x
    const dy = last.y - first.y
    let speed = 0
    for (const p of points) speed += Math.min(options.speedCap, p.s)
    const mid: FlowPoint = points[Math.floor(points.length / 2)]
    marks.push({
      at: { u: wrapUnit((first.x + last.x) / 2 / options.width), v: wrapUnit((first.y + last.y) / 2 / options.height) },
      angle: Math.atan2(dy, dx),
      length: Math.hypot(dx, dy),
      speed: speed / points.length,
      loop: options.closeLoops && lines[line].loop,
      mid: { u: wrapUnit(mid.x / options.width), v: wrapUnit(mid.y / options.height) },
    })
  }
  return marks
}

// --- the sphere ---------------------------------------------------------------

// Points evenly spread on the globe, `spacing` chart texels apart (texels
// at the equator, true lengths), for a chart `width` texels round: rows of
// equal colatitude steps from the north pole (v = 0) to the south pole
// (v = 1), the poles one point each; in each row as many points as its
// circumference holds, at a phase of its own (so the rows do not line up
// along a meridian).
export function globeSamplePoints(width: number, spacing: number): ChartPoint[] {
  const rows = Math.max(2, Math.round(width / 2 / spacing))
  const points: ChartPoint[] = []
  for (let k = 0; k <= rows; k++) {
    const v = k / rows
    const count = k === 0 || k === rows ? 1 : Math.max(1, Math.round((width * Math.sin(Math.PI * v)) / spacing))
    const phase = rowPhase(k)
    for (let j = 0; j < count; j++) points.push({ u: wrapUnit(phase + j / count), v })
  }
  return points
}

// A row's phase in [0, 1), deterministic: the same field always draws the
// same marks.
function rowPhase(k: number): number {
  let h = Math.imul(k ^ 0x9e3779b9, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

// A vector field read at a chart point, in that point's own frame
// ([east, south], Domain.delta's), written into `out`: a field mesh's,
// whose sampler mixes the corners' vectors in 3D (fields/fieldMesh.
// FieldSampler.sampleVector — every wind and current the screen shows since
// DEC-0036 phase 5; the screen makes that reader, so this module reads no
// simulation).
export type VectorReader = (at: ChartPoint, out: [number, number]) => [number, number]

// One mark per point of globeSamplePoints where the field is faster than
// `minSpeed`: along the field's direction there, `length` texels long, its
// speed against `refSpeed`. Open marks (no gyre is traced on the sphere).
export function globeVectorMarks(read: VectorReader, options: {
  width: number
  spacing: number
  length: number
  minSpeed: number
  refSpeed: number
}): VectorMark[] {
  const marks: VectorMark[] = []
  const v: [number, number] = [0, 0]
  for (const at of globeSamplePoints(options.width, options.spacing)) {
    read(at, v)
    const speed = Math.hypot(v[0], v[1])
    if (!(speed >= options.minSpeed) || speed === 0) continue
    marks.push({ at, angle: Math.atan2(v[1], v[0]), length: options.length, speed: speed / options.refSpeed, loop: false, mid: at })
  }
  return marks
}
