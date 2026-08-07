import { upscaleBilinearToroidal } from '../core/field'
import { SEA_LEVEL, metersToElevation } from '../elevation/elevationScale'
import { fineDetailNoise, periodicValueNoise2D } from '../elevation/ridgedNoise'

// Terrain AMPLIFICATION — the derived fine tier of
// docs/decisions/worldmap-amplification.md. Takes the authoritative macro
// elevation raster (2048x1024, the only thing a save carries) and produces a
// finer raster for the worldmap to present: upsample, then inject seed
// roughness. Erosion (phase 2) then runs on that result; this module is
// deliberately only the PREPARATION, because the two halves fail differently
// and are worth verifying apart.
//
// Why seed roughness at all: bilinear upsampling adds no information, so an
// upscaled raster is glass below the macro cell — and erosion on glass does
// nothing interesting, because the priority flood has no texture to pick a
// drainage side with and every micro-catchment is a tie. The micro-tile
// prototype learned this first (tileErosion.ts's TILE_SEED_ROUGHNESS): fine
// erosion needs something to bite into. This is the same idea at global
// scale.
//
// Everything here is deterministic in (macro raster, factor, seed): the same
// world always amplifies to the identical field, which is what lets the bake
// be a per-load recomputation rather than something the save must carry.

// Peak seed amplitude, in metres. The micro tile's 30 m was the starting
// point, but measurement (2026-08-07, esbuild transect over a synthetic
// world) showed why this case needs more: the noise rarely reaches its
// nominal peak, so 30 m produced only ~5 m RMS and ~2 m between neighbouring
// cells — far below the tens of metres a stream-power pass carves, i.e. no
// tiebreaker at all. The micro tile could afford that because it ALSO
// resamples the analytic tectonic field at sub-cell spacing; a save carries
// no rafts or features, so here this layer is the only sub-macro-cell
// content that exists. 60 m peak lands near ~10 m RMS while the height fade
// below still protects the coasts.
const SEED_ROUGHNESS_M = 60

// Height-scaled fade toward sea level, straight from the micro tile's
// lesson: on a low coastal plain, the macro valley that should steer the
// trunk river is only metres deep (plain incision is damped on purpose), so
// full-amplitude noise would out-shout it and the river would wander off its
// inherited course. Full roughness stays in the highlands, where competing
// micro-valleys are exactly what we want. Ocean cells get none — nothing
// routes on the seabed.
export function seedRoughnessAmplitude(elevation: number): number {
  if (elevation <= SEA_LEVEL) return 0
  return Math.min(metersToElevation(SEED_ROUGHNESS_M), elevation * 0.5)
}

// The noise cascade for the seed layer. fineDetailNoise's own octave table
// bottoms out at width/1024 — i.e. ~8 macro px, ~16 fine px at factor 2 —
// which is far too coarse to seed fine drainage, so the field is summed over
// several DOMAIN DIVISORS: passing width/s makes every octave s times finer
// while staying torus-periodic (the world period must stay an integer
// multiple of the noise period, which it does for integer s that divide the
// resolution). The cascade is cut off where the finest octave would approach
// the fine grid's own Nyquist limit — noise below ~3 px is aliasing, not
// detail, and erosion cannot act on it either.
const MIN_OCTAVE_PIXELS = 3
const CASCADE_FALLOFF = 0.55

export function seedCascadeScales(resX: number): number[] {
  const scales: number[] = []
  // Doubling (not quadrupling) so the spectrum keeps filling in as the
  // resolution rises: at 4096 this yields [1] (one call = 8 px and 4 px
  // octaves = 8 and 4 cells, exactly the band erosion needs), at the decided
  // 8192 target [1, 2] — the second call restoring that same few-cells band
  // at the finer spacing rather than leaving it at 16/8 cells.
  for (let s = 1; s <= 64; s *= 2) {
    // fineDetailNoise's finest octave is 1024 cells across the domain it is
    // given (resX / s), so its wavelength in fine pixels is resX / (s * 1024).
    // Below ~3 px there is nothing left to resolve and erosion cannot act on
    // it either — that is the cutoff, not an aesthetic choice.
    if (resX / (s * 1024) < MIN_OCTAVE_PIXELS) break
    scales.push(s)
  }
  return scales.length > 0 ? scales : [1]
}

// The per-cell rescaling the bake runs its erosion under lives in erosion.ts,
// next to the constants it corrects — see scaleErosionParamsForCellSize.

// The river threshold's counterpart to that rescaling. The channel
// criterion is a critical drainage area counted in CELLS (see
// hydrology.densityToCriticalArea), so on a grid refined by 1/r the same
// PHYSICAL catchment covers 1/r² times as many cells — leave the number
// alone and every minor gully clears the bar, turning the map into a mesh of
// parallel lines. Multiplying by 1/r² keeps "a river is a river" meaning the
// same real thing at any resolution.
//
// The same conclusion arrives from the discharge side: accumulateDischarge
// sums a per-cell runoff over upstream cells, so discharge for a fixed
// physical catchment also grows by 1/r² — threshold and signal scale
// together, as they must.
export function criticalAreaForCellSize(criticalAreaCells: number, cellSizeRatio: number): number {
  return criticalAreaCells / (cellSizeRatio * cellSizeRatio)
}

// RIDGELINE RELIEF — why mountains read as round lumps, and what fixes it.
//
// The generator does add ridged-multifractal detail (elevationField's
// `detail` term), but its octave table runs 32/64/128/256 cells across the
// world: at 16,000 km that is wavelengths of 500/250/125/63 km, with the
// STRONGEST octave at 500 km. That is mountain-RANGE scale. Real ridgelines
// and arêtes sit 1–10 km apart, and there was nothing in that band at all —
// so ranges came out as a few big bulges with smooth flanks.
//
// Measured 2026-08-07 on the same synthetic world, after erosion, at
// 7.8 km/cell (crest sharpness = mean curvature at local maxima):
//
//   no ridging                       46 m,     19 peaks
//   generator octaves (63–500 km)    67 m,  5,809 peaks
//   RIDGELINE octaves (16–63 km)    122 m, 78,692 peaks
//
// So it was never a question of strength — it was scale. A first attempt
// that ridged the SEED ROUGHNESS instead changed nothing measurable
// (65 → 64 m), for the obvious reason once seen: a 60 m perturbation cannot
// shape a 3,000 m mountain. The amplitude has to scale with the mountain's
// own relief, exactly as the generator scales its own term by uplift.
//
// LATER THAT DAY the generator's own octave table was reweighted onto the
// crest band too (ridgedNoise.RIDGE_OCTAVES), so it now supplies 63 and 31 km
// itself — two of the three bands below, with an independent seed. That
// raised a fair worry: two uncorrelated crest patterns at one wavelength read
// as mush, not sharpness. Measured on the full chain (generator -> macro
// erosion -> this bake), crest sharpness per km of ground at the baked 4096
// grid:
//
//   old generator table   macro  2.0 m/km  ->  baked  9.8 m/km
//   new generator table   macro 15.1 m/km  ->  baked 15.2 m/km
//
// So the layers do not compound: the macro world now carries the relief this
// used to have to invent, and the bake's remaining contribution is the finest
// octave plus sub-macro-cell structure (peaks 8,029 -> 9,641 over the same
// terrain). Left as-is deliberately — narrowing it to only what the macro
// grid cannot carry would cost two of three octaves to fix a problem the
// measurement says does not exist.
const RIDGE_OCTAVE_CELLS = [256, 512, 1024]
const RIDGE_OCTAVE_AMPLITUDES = [1, 0.5, 0.25]
// Fraction of a cell's local relief the ridging may move it by. 0.5 matches
// the generator's own RIDGE_RELATIVE_STRENGTH; 0.8 measured sharper still
// (146 m) but starts to fight the macro shape, which the authority rule
// says wins.
const RIDGE_STRENGTH = 0.5
// Mean of the ridged field, subtracted so ridgelines add height and gullies
// cut down with no net elevation bias — the same centring, and the same
// measured constant, as ridgedNoise.RIDGE_MEAN.
const RIDGE_FIELD_MEAN = 0.47
// Neighbourhood radius for "how far does this cell stand above its
// surroundings", as a fraction of the grid width. ~1/64 of the world is a
// few hundred km — wide enough that a whole range counts as raised, narrow
// enough that a plain does not.
const RELIEF_RADIUS_FRACTION = 1 / 64

// How the bake's erosion differs from the generator's defaults. These are
// AMPLIFICATION POLICY, not worker mechanics, so they live next to the rest
// of the policy rather than inline at the one call site — which also lets
// the artifact cache hash them (see storage/artifactKey.ts: a value change
// must invalidate cached terrain, and a hand-maintained version number would
// be forgotten).
//
// Measured 2026-08-07: mean incision of channel cells below their
// surroundings 84 m → 167 m at identical cost, ridge crests and mean land
// height essentially unchanged — this deepens valleys, it does not lower the
// world.
//
//  - upliftRate 0: runErosionPass reads its input as both terrain AND uplift
//    envelope, re-lifting cells toward it every round. Right when simulating
//    a landscape rising while rivers cut into it — but here the envelope IS
//    the finished macro world, so uplift undoes the carving this bake exists
//    for. Pure denudation is also the safer reading of the authority rule:
//    without it the pass can only cut into the macro shape, never push
//    anything back up.
//  - plainFactor 0.4: the plain damping keeps 7.8 km cells from growing
//    valleys everywhere, which reads wrong at macro scale. At half that
//    spacing gentle drainage is exactly what should appear — relaxed, not
//    removed, or plains lose their flatness entirely.
//  - talusAngleDeg 6: a finer grid resolves steeper slopes, so the "steepest
//    sustainable slope at this grid's scale" argument behind erosion.ts's 3°
//    puts the angle higher here; leaving it planes the valley walls the pass
//    just cut.
export const AMPLIFICATION_EROSION_OVERRIDES = {
  upliftRate: 0,
  plainFactor: 0.4,
  talusAngleDeg: 6,
} as const

// Everything in this module whose value changes the bake's output, in one
// place a cache key can hash. Kept beside the constants themselves so an
// edit and its invalidation stay in the same field of view.
export const AMPLIFY_CONSTANTS: Record<string, number> = {
  seedRoughnessM: SEED_ROUGHNESS_M,
  cascadeFalloff: CASCADE_FALLOFF,
  minOctavePixels: MIN_OCTAVE_PIXELS,
  ridgeStrength: RIDGE_STRENGTH,
  ridgeOctaveCount: RIDGE_OCTAVE_CELLS.length,
  ridgeFinestCells: RIDGE_OCTAVE_CELLS[RIDGE_OCTAVE_CELLS.length - 1],
  upliftRate: AMPLIFICATION_EROSION_OVERRIDES.upliftRate,
  plainFactor: AMPLIFICATION_EROSION_OVERRIDES.plainFactor,
  talusAngleDeg: AMPLIFICATION_EROSION_OVERRIDES.talusAngleDeg,
}

export interface AmplifiedField {
  data: Float32Array
  width: number
  height: number
}

// Ridged fBm at an explicit octave table (the point of the exercise — see
// RIDGE_OCTAVE_CELLS), in [0, 1). Each octave folds value noise into a ridge
// and squares it to sharpen the crest, exactly as ridgedNoise does; the
// table is local because the shared one is tuned for range scale.
function ridgedAt(x: number, y: number, width: number, height: number, seed: number): number {
  let sum = 0
  let norm = 0
  for (let i = 0; i < RIDGE_OCTAVE_CELLS.length; i++) {
    const cellsX = RIDGE_OCTAVE_CELLS[i]
    const cellsY = Math.max(2, Math.round(cellsX / 2))
    const noise = periodicValueNoise2D((x / width) * cellsX, (y / height) * cellsY, cellsX, cellsY, (seed + i * 0x9e3779b9) >>> 0)
    const ridge = 1 - Math.abs(2 * noise - 1)
    sum += ridge * ridge * RIDGE_OCTAVE_AMPLITUDES[i]
    norm += RIDGE_OCTAVE_AMPLITUDES[i]
  }
  return sum / norm
}

// How far each cell stands above the floor of its neighbourhood — the
// stand-in for the generator's `uplift`, computable from a raster alone.
// Sampled on a coarse ring rather than a full window: this only has to say
// "is this raised ground", and a full min-filter at this radius would cost
// more than the rest of the bake.
function localRelief(field: Float32Array, width: number, height: number): Float32Array {
  const radius = Math.max(1, Math.round(width * RELIEF_RADIUS_FRACTION))
  const out = new Float32Array(field.length)
  const wrap = (v: number, n: number): number => ((v % n) + n) % n
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let lowest = Infinity
      for (let dy = -radius; dy <= radius; dy += radius) {
        const ny = wrap(y + dy, height) * width
        for (let dx = -radius; dx <= radius; dx += radius) {
          const value = field[ny + wrap(x + dx, width)]
          if (value < lowest) lowest = value
        }
      }
      // Floored at sea level, which is not a detail: measured against the
      // raw neighbourhood minimum, a 100 m coastal plain beside a 3,000 m
      // deep ocean scored 3,100 m of "relief" and got ridged as hard as an
      // alpine crest — 36,000 cells were driven below sea level and the
      // plains moved by an average of 258 m. Relief means height above the
      // surrounding LAND.
      out[y * width + x] = Math.max(0, field[y * width + x] - Math.max(SEA_LEVEL, lowest))
    }
  }
  return out
}

// Upsample + seed roughness. `factor` is the linear refinement (2 → 4096x2048,
// 4 → 8192x4096); `seed` should derive from the world so a given world always
// amplifies identically. `onProgress` reports 0..1 over the roughness pass,
// which is the part long enough to be worth reporting.
export function amplifyElevation(
  macro: Float32Array,
  macroWidth: number,
  macroHeight: number,
  factor: number,
  seed: number,
  onProgress?: (fraction: number) => void,
): AmplifiedField {
  const width = macroWidth * factor
  const height = macroHeight * factor
  const data = upscaleBilinearToroidal(macro, macroWidth, macroHeight, width, height)
  if (factor <= 1) return { data, width, height }

  const scales = seedCascadeScales(width)
  const amplitudes = scales.map((_, i) => Math.pow(CASCADE_FALLOFF, i))
  const norm = amplitudes.reduce((a, b) => a + b, 0)
  // Relief is read from the SMOOTH upsample, before either layer perturbs
  // it: "is this raised ground" is a property of the macro world, and
  // letting the ridging feed back into its own amplitude would compound.
  const relief = localRelief(data, width, height)
  const ridgeSeed = (seed ^ 0x5f356495) >>> 0

  const reportEvery = Math.max(1, Math.floor(height / 50))
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const base = data[row + x]
      const amplitude = seedRoughnessAmplitude(base)
      if (amplitude === 0) continue
      let noise = 0
      for (let i = 0; i < scales.length; i++) {
        const s = scales[i]
        noise += fineDetailNoise(x, y, width / s, height / s, (seed + i * 0x9e3779b9) >>> 0) * amplitudes[i]
      }
      // Two layers with different jobs: the seed roughness gives erosion
      // something to bite into at cell scale, the ridging shapes the
      // MOUNTAIN at ridgeline scale. Only the second can make a range read
      // as crests rather than a bulge — and it scales with the terrain's own
      // relief, so plains stay plains.
      const ridge = (ridgedAt(x, y, width, height, ridgeSeed) - RIDGE_FIELD_MEAN) * relief[row + x] * RIDGE_STRENGTH
      data[row + x] = base + (noise / norm) * amplitude + ridge
    }
    if (onProgress && y % reportEvery === 0) onProgress(y / height)
  }
  onProgress?.(1)
  return { data, width, height }
}
