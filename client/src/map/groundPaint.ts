// PAINTING THE GROUND — one ring of the near-ground clipmap (groundRings.ts)
// as a height grid for its vertices plus two textures over the same square:
// the ALBEDO (the material the eye reads the land by) and the NORMALS (what
// the light reads the relief by). The textures are finer than the vertices
// on purpose: a ring of 192 quads carries 512 texels a side, so the look
// no longer waits for the geometry — the lesson of the legacy world map and
// of every game whose mountains look right from above (2026-10-03). The
// relief stays in the mesh for the silhouettes and the shadows; everything
// finer than a quad lives here.
//
// Pure: a source of fields in, buffers out. It runs in a worker (the
// incubator's) and in a node script alike, which is how the look is judged
// without a browser.
//
// THE MATERIAL, by what games do (Transport Fever, Anno): colour by
// surface, not by height. The biome gives the ground cover; the DRAWN
// slope (the exaggeration included, since that is what the eye sees) turns
// it to rock; the local temperature (sea level minus the lapse) turns rock
// and ground to snow; the sea is coloured by its depth and the shore by a
// band of sand; a cavity term from the curvature darkens hollows and
// lightens crests, the poor man's ambient occlusion; a slow noise breaks
// the flatness of a biome's one colour.

export interface GroundSource {
  // The world in cells, and the metre per cell.
  width: number
  height: number
  metersPerCell: number
  // Metres per elevation unit.
  elevationMeters: number
  // The elevation (units) at a world point, from levels up to `maxLevel`.
  elevationAt(x: number, y: number, maxLevel: number): number
  // The same with the surface's unit normal (metre-true, y up): out[0]
  // the elevation, out[1..3] the normal, out[4] the local node spacing
  // of the level that answered, cells.
  surfaceAt(x: number, y: number, maxLevel: number, out: Float64Array): number
  // The material inputs at a world point, nearest cell: the biome id
  // (climate/biomes.ts Biome), the sea-level temperature in °C, the yearly
  // precipitation in mm and the lake depth in metres (0 outside a lake).
  biomeAt(x: number, y: number): number
  seaTemperatureAt(x: number, y: number): number
  precipitationAt(x: number, y: number): number
  lakeDepthAt(x: number, y: number): number
  // The water level (elevation units) a point's water stands at — the
  // sea's 0, a basin's own — and the surface kind there (0 the sea, 1 a
  // lake, 2 ice), nearest world cell, the basin's rim included.
  waterLevelAt(x: number, y: number): number
  waterSurfaceAt(x: number, y: number): number
}

export interface RingPaintRequest {
  // The ring's centre and its quad spacing, cells; `quads` a side.
  centerX: number
  centerY: number
  spacing: number
  quads: number
  // Texels a side of each texture.
  texels: number
  // The texel size of the ring outside this one, metres (null for the
  // outermost ring): the outer edge takes the outer ring's ground, so the
  // two meet without a step. Which levels a ring reads follows from its
  // own texel size (LEVEL_FADE_M), not from a level per ring: two rings
  // with the same texel then draw the same ground, whatever their index.
  outerTexelM: number | null
  // Drawn metres per true metre: the vertical exaggeration, which the
  // normals and the slope material see as the eye does.
  verticalScale: number
}

export interface RingPaint {
  // (quads + 1)² heights, elevation units, clamped at the sea's level.
  heights: Float32Array
  // texels² RGBA each: the colour, the world-space normals, and the
  // MATERIAL weights the shader lays its detail textures by
  // (groundDetail.ts): R rock, G bare ground, B snow, A canopy; what is
  // left is grass. The sea is all zero.
  albedo: Uint8Array
  normals: Uint8Array
  materials: Uint8Array
  texels: number
}

type Rgb = readonly [number, number, number]

// The ground cover per biome (climate/biomes.ts Biome ids), sRGB. Vegetation
// where there is some, soil where there is not.
const BIOME_COVER: Rgb[] = [
  [60, 110, 150], // 0 Ocean (never painted: the sea has its own colours)
  [228, 234, 240], // 1 Ice
  [156, 150, 116], // 2 Tundra
  [76, 106, 66], // 3 Boreal
  [146, 166, 86], // 4 Grassland
  [118, 148, 76], // 5 Woodland
  [92, 132, 70], // 6 TemperateForest
  [72, 116, 70], // 7 TemperateRainforest
  [214, 194, 146], // 8 Desert
  [176, 164, 96], // 9 Savanna
  [62, 110, 60], // 10 TropicalRainforest
  [140, 136, 116], // 11 Alpine
  [228, 224, 214], // 12 SaltFlat
  [220, 230, 240], // 13 Glacier
  [150, 154, 98], // 14 MediterraneanScrub
  [180, 166, 110], // 15 Steppe
  [128, 146, 76], // 16 TropicalDryForest
  [182, 164, 134], // 17 ColdDesert
]
// The canopy's share of the ground per biome: what the forest detail
// (groundDetail.ts) covers, before the tree line, the rock and the snow
// take theirs.
const BIOME_CANOPY: number[] = [0, 0, 0.05, 0.75, 0.08, 0.5, 0.85, 0.95, 0, 0.25, 0.95, 0, 0, 0, 0.35, 0.03, 0.7, 0]
// Biomes whose cover is bare ground rather than grass.
const BIOME_BARE: number[] = [0, 0.3, 0.5, 0, 0, 0, 0, 0, 1, 0.2, 0, 0.6, 1, 0.2, 0.3, 0.5, 0, 0.9]
// The canopy's patchiness: a noise of this wavelength (cells) opens
// clearings and closes stands, between these shares of the biome's.
const CANOPY_PATCH_CELLS = 0.25
const ROCK_DARK: Rgb = [118, 106, 94]
const ROCK_LIGHT: Rgb = [178, 166, 148]
const SNOW: Rgb = [238, 241, 247]
const SAND: Rgb = [214, 198, 154]
const SEA_SHALLOW: Rgb = [96, 172, 190]
const SEA_DEEP: Rgb = [22, 62, 124]
const SEA_ABYSS: Rgb = [12, 38, 92]

// Drawn slope (rise over run) where the cover gives way to rock, and where
// the rock is bare.
const ROCK_SLOPE_LO = 0.6
const ROCK_SLOPE_HI = 1.4
// Height (m) over which bare rock takes over regardless of slope, and
// below it the band where the cover turns alpine (above the tree line).
const ROCK_HEIGHT_LO = 3000
const ROCK_HEIGHT_HI = 4400
const ALPINE_HEIGHT_LO = 1800
const ALPINE_HEIGHT_HI = 2600
// Local mean temperature (°C) between which snow sets in, and the lapse.
const SNOW_T_HI = 1
const SNOW_T_LO = -5
const LAPSE_C_PER_M = 6.5 / 1000
// The sand band's height (m) and the sea's colour depths (m).
const SAND_HEIGHT_M = 10
const SEA_DEEP_M = 500
const SEA_ABYSS_M = 3000
// The sea floor's drawn depth (elevation units): 10 m under its plane.
const SEA_FLOOR_SINK = -10 / 9000
// A lake's colour depths (m): a lake is clearer than the sea.
const LAKE_SHALLOW: Rgb = [112, 176, 184]
const LAKE_DEEP: Rgb = [38, 86, 128]
const LAKE_DEEP_M = 120
// The cavity term: curvature (metres per metre, from the texel stencil)
// times this, clamped.
const CAVITY_GAIN = 1.2
// The cavity's stencil, texels either way.
const CAVITY_STENCIL = 3
const CAVITY_DARK = 0.22
const CAVITY_LIGHT = 0.1
// The slow variation's wavelength (cells) and depth.
const VARIATION_CELLS = 0.6
const VARIATION = 0.07
// The detail band: its longest wavelength (m, the finest level's node
// spacing), its height per wavelength on a full slope, the slope (rise over
// run, true) at which it is full, and the share left on flat ground.
const DETAIL_MAX_WAVELENGTH_M = 320
// A level's typical node spacing, metres (level 1 ~2 km; the tiles'
// floors are 500 m and 125 m, flat land coarser).
const NODE_SPACING_M: Record<number, number> = { 0: 7800, 1: 2200, 2: 600, 3: 220 }
// The softening of the facets: the slope blurred to this fraction of the
// local node spacing, between two fixed radii (the node spacings, metres,
// a dense range and a sparse plain have).
const SOFTEN_SPACINGS = 0.5
const SOFTEN_RADII_M = [200, 800] as const
// The ring spacing, as a fraction of the node spacing, from which a vertex
// samples a footprint rather than a point.
const FOOTPRINT_FROM = 0.3
// The outer band of a ring, as a fraction of its half-width, over which
// its level blends into the outer ring's.
const RIM_BLEND = 0.5
// Per level, the texel size (m) between which its share of the ground
// falls to the level below's: level 3 is read whole under 150 m texels
// and not at all over 340 m (the rings of 360 m texels read none of it:
// at a sixth of a share it was invisible and cost 36 tiles' rasters,
// 300 MB, 2026-10-03), level 2 from 500 m to 1 400 m. Level 1 is what
// remains.
// Level 1 (nodes ~2 km) from 2 km to 5 km; past that the save's own
// raster (7.8 km cells) is all a texel can show.
const LEVEL_FADE_M: Record<number, readonly [number, number]> = { 3: [150, 340], 2: [500, 1400], 1: [2000, 5000] }
const SHARE_FLOOR = 0.05
const DETAIL_ROUGHNESS = 0.02
const DETAIL_FULL_SLOPE = 0.25
const DETAIL_FLAT_SHARE = 0.08

const smooth = (lo: number, hi: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}
const mix = (a: Rgb, b: Rgb, t: number, out: Float32Array): void => {
  out[0] = a[0] + (b[0] - a[0]) * t
  out[1] = a[1] + (b[1] - a[1]) * t
  out[2] = a[2] + (b[2] - a[2]) * t
}

// A hashed value noise over world cells, periodic in nothing — used only
// for variation, where a seam at the world's edge is invisible.
const hash2 = (ix: number, iy: number): number => {
  let h = (ix * 374761393 + iy * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = x - x0
  const ty = y - y0
  const sx = tx * tx * (3 - 2 * tx)
  const sy = ty * ty * (3 - 2 * ty)
  const a = hash2(x0, y0)
  const b = hash2(x0 + 1, y0)
  const c = hash2(x0, y0 + 1)
  const d = hash2(x0 + 1, y0 + 1)
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
}

// A box blur of radius r texels (width 2r + 1) over an m × m field,
// separable with running sums, the border clamped. A new array.
function boxBlur(field: Float32Array, m: number, r: number): Float32Array {
  const tmp = new Float32Array(m * m)
  const out = new Float32Array(m * m)
  const w = 2 * r + 1
  for (let j = 0; j < m; j++) {
    const row = j * m
    let sum = 0
    for (let i = -r; i <= r; i++) sum += field[row + Math.min(m - 1, Math.max(0, i))]
    for (let i = 0; i < m; i++) {
      tmp[row + i] = sum / w
      sum += field[row + Math.min(m - 1, i + r + 1)] - field[row + Math.max(0, i - r)]
    }
  }
  for (let i = 0; i < m; i++) {
    let sum = 0
    for (let j = -r; j <= r; j++) sum += tmp[Math.min(m - 1, Math.max(0, j)) * m + i]
    for (let j = 0; j < m; j++) {
      out[j * m + i] = sum / w
      sum += tmp[Math.min(m - 1, j + r + 1) * m + i] - tmp[Math.max(0, j - r) * m + i]
    }
  }
  return out
}

export function paintRing(source: GroundSource, request: RingPaintRequest): RingPaint {
  const { centerX, centerY, spacing, quads, texels, outerTexelM, verticalScale } = request
  const n = quads + 1
  const half = (quads / 2) * spacing
  const x0 = centerX - half
  const y0 = centerY - half

  // THE LEVELS BY THE TEXEL: each level's share of the ground falls as
  // the texel grows past its node spacing (LEVEL_FADE_M), so a ring whose
  // texels cannot show level 3's relief draws level 2's, and two rings
  // with one texel size draw one ground — by a level per ring, ring 5
  // drew level 3 whole beside ring 6's level 2 and the range sat in a
  // square (2026-10-03). The levels differ by hundreds of metres on a
  // peak (a tile sharpens what level 1 rounded off), so the fade is what
  // makes the ladder continuous.
  //
  // AND AT THE RIM: over the ring's outer band the ground slides from
  // this ring's mix to the outer ring's, so the two meet without a step.
  const texelM = ((2 * half) / texels) * source.metersPerCell
  // A share under SHARE_FLOOR is none: at a few percent a level is
  // invisible but every one of its tiles across the ring is still read
  // (ring 8 rastered 140 level-2 tiles for a 2 % share, 2026-10-03).
  const share = (lo: number, hi: number, texel: number): number => {
    const v = 1 - smooth(lo, hi, texel)
    return v < SHARE_FLOOR ? 0 : v
  }
  const shares = (texel: number): [number, number, number] => [share(LEVEL_FADE_M[3][0], LEVEL_FADE_M[3][1], texel), share(LEVEL_FADE_M[2][0], LEVEL_FADE_M[2][1], texel), share(LEVEL_FADE_M[1][0], LEVEL_FADE_M[1][1], texel)]
  const [s3, s2, s1] = shares(texelM)
  const [o3, o2, o1] = outerTexelM !== null ? shares(outerTexelM) : [s3, s2, s1]
  // The height mixed over the levels by their shares (a level with no
  // share is not read, so no tile is asked for in vain); what no level
  // takes is level 0's, the save's raster.
  const mixedAt = (x: number, y: number, a3: number, a2: number, a1: number): number => {
    let h = 0
    let rest = 1
    if (a3 > 0) {
      h += source.elevationAt(x, y, 3) * a3
      rest -= a3
    }
    if (rest > 0 && a2 > 0) {
      const w = rest * a2
      h += source.elevationAt(x, y, 2) * w
      rest -= w
    }
    if (rest > 0 && a1 > 0) {
      const w = rest * a1
      h += source.elevationAt(x, y, 1) * w
      rest -= w
    }
    if (rest > 0) h += source.elevationAt(x, y, 0) * rest
    return h
  }
  const rimAt = (x: number, y: number): number => {
    if (outerTexelM === null) return 0
    const rim = Math.max(Math.abs(x - centerX), Math.abs(y - centerY)) / half
    return rim <= 1 - RIM_BLEND ? 0 : smooth(0, 1, (rim - (1 - RIM_BLEND)) / RIM_BLEND)
  }
  const blended = (x: number, y: number): number => {
    const t = rimAt(x, y)
    return mixedAt(x, y, s3 + (o3 - s3) * t, s2 + (o2 - s2) * t, s1 + (o1 - s1) * t)
  }

  // --- the vertices -------------------------------------------------------
  // A vertex takes the mean over a footprint of its quad where the ring's
  // spacing nears the level's node spacing: sampled at a point there, a
  // vertex lands on a node's bump or beside it at random, and the ground
  // is pocked — and at ×6 every pock cast a shadow (2026-10-03). The
  // finest rings, whose quads are well inside a node's spacing, sample
  // the point.
  const heights = new Float32Array(n * n)
  const nodeSpacingM = s3 > 0.5 ? NODE_SPACING_M[3] : s2 > 0.5 ? NODE_SPACING_M[2] : s1 > 0.5 ? NODE_SPACING_M[1] : NODE_SPACING_M[0]
  const footprint = spacing * source.metersPerCell > nodeSpacingM * FOOTPRINT_FROM ? spacing * 0.25 : 0
  for (let j = 0; j < n; j++) {
    const y = y0 + j * spacing
    for (let i = 0; i < n; i++) {
      const x = x0 + i * spacing
      heights[j * n + i] = footprint > 0
        ? 0.25 * (blended(x - footprint, y - footprint) + blended(x + footprint, y - footprint) + blended(x - footprint, y + footprint) + blended(x + footprint, y + footprint))
        : blended(x, y)
    }
  }
  // MATCHED EDGES: the outermost row takes the outer ring's ground — its
  // level, at every second vertex (which lies on the outer ring's grid), and
  // the straight line between them at the others: exactly the edge the outer
  // ring's hole has. Without it the two grounds met in a step and the view
  // looked through the higher one (2026-10-02).
  if (outerTexelM !== null) {
    const onEdge = (i: number, j: number): boolean => i === 0 || j === 0 || i === quads || j === quads
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (!onEdge(i, j) || (i + j) % 2 !== 0) continue
        heights[j * n + i] = mixedAt(x0 + i * spacing, y0 + j * spacing, o3, o2, o1)
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (!onEdge(i, j) || (i + j) % 2 === 0) continue
        // The two edge neighbours, both on the outer grid.
        const a = i === 0 || i === quads ? heights[(j - 1) * n + i] : heights[j * n + i - 1]
        const b = i === 0 || i === quads ? heights[(j + 1) * n + i] : heights[j * n + i + 1]
        heights[j * n + i] = 0.5 * (a + b)
      }
    }
  }
  // The sea floor is drawn flat, a little under the sea's plane (so the
  // two never fight); a lake keeps its floor, which its water's
  // translucency shows (groundWater.ts).
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i
      if (heights[k] < SEA_FLOOR_SINK && source.waterSurfaceAt(x0 + i * spacing, y0 + j * spacing) === 0) heights[k] = SEA_FLOOR_SINK
    }
  }

  // --- the texel grid: heights and the data's normals -------------------
  const m = texels + 2
  const pitch = (2 * half) / texels
  const pitchM = pitch * source.metersPerCell
  const metres = new Float32Array(m * m)
  // The data's slope at each texel, the exaggeration in, from the
  // interpolated normals: dh/dx = −nx/ny.
  const slopeX = new Float32Array(m * m)
  const slopeZ = new Float32Array(m * m)
  // The local node spacing per texel, metres: the facets are softened by
  // it below.
  const nodeSpacing = new Float32Array(m * m)
  const inner = new Float64Array(5)
  for (let tj = 0; tj < m; tj++) {
    const y = y0 + (tj - 0.5) * pitch
    for (let ti = 0; ti < m; ti++) {
      const x = x0 + (ti - 0.5) * pitch
      const c = tj * m + ti
      const t = rimAt(x, y)
      const a3 = s3 + (o3 - s3) * t
      const a2 = s2 + (o2 - s2) * t
      const a1 = s1 + (o1 - s1) * t
      let h = 0
      let sx = 0
      let sz = 0
      let spacingCells = 0
      let rest = 1
      const take = (level: number, w: number): void => {
        const hl = source.surfaceAt(x, y, level, inner)
        h += hl * w
        if (inner[2] > 1e-6) {
          sx += (-inner[1] / inner[2]) * w
          sz += (-inner[3] / inner[2]) * w
        }
        spacingCells += inner[4] * w
      }
      if (a3 > 0) {
        take(3, a3)
        rest -= a3
      }
      if (rest > 0 && a2 > 0) {
        take(2, rest * a2)
        rest -= rest * a2
      }
      if (rest > 0 && a1 > 0) {
        take(1, rest * a1)
        rest -= rest * a1
      }
      if (rest > 0) take(0, rest)
      metres[c] = h * source.elevationMeters
      slopeX[c] = sx * verticalScale
      slopeZ[c] = sz * verticalScale
      nodeSpacing[c] = spacingCells * source.metersPerCell
    }
  }
  // The slope under the widest blur, for the cavity, and the cavity's
  // stencil (set with the softening below).
  const wide: Float32Array[] = []
  let cavityStencil = CAVITY_STENCIL
  // THE FACETS SOFTENED: the nodes sit jittered on their lattice, and at
  // the map's exaggeration every node is a bump the interpolated normals
  // show as a cobble — at every spacing the level has, 150 m in a range
  // and 700 m on a snowfield (2026-10-03). So the slope is box-blurred
  // (twice: a triangle filter) to half the LOCAL node spacing: two blurs
  // at fixed radii, the texel takes the mix its own spacing asks for.
  {
    const r1 = Math.max(1, Math.round((SOFTEN_SPACINGS * SOFTEN_RADII_M[0]) / pitchM))
    const r2 = Math.max(r1 + 1, Math.round((SOFTEN_SPACINGS * SOFTEN_RADII_M[1]) / pitchM))
    const cap = Math.floor(texels / 6)
    const ra = Math.min(cap, r1)
    const rb = Math.min(cap, r2)
    for (const field of [slopeX, slopeZ]) {
      const a = boxBlur(boxBlur(field, m, ra), m, ra)
      const b = ra === rb ? a : boxBlur(boxBlur(field, m, rb), m, rb)
      wide.push(b)
      for (let c = 0; c < m * m; c++) {
        const t = Math.min(1, Math.max(0, (nodeSpacing[c] - SOFTEN_RADII_M[0]) / (SOFTEN_RADII_M[1] - SOFTEN_RADII_M[0])))
        field[c] = a[c] + (b[c] - a[c]) * t
      }
    }
    cavityStencil = Math.max(CAVITY_STENCIL, rb)
  }
  // DETAIL BELOW THE DATA: the levels bottom out at 60–300 m between
  // nodes. Octaves of a world-fixed noise fill the band from the finest
  // data down to the texel, rough where the ground is steep and nearly
  // nothing on a plain or a plateau — the eye reads a crag on a hillside,
  // but noise on flat ground reads as noise. The sea keeps its level.
  const detail = new Float32Array(m * m)
  if (pitchM < DETAIL_MAX_WAVELENGTH_M / 4) {
    const octaves: { cells: number; amplitude: number }[] = []
    // Down to two texels, each octave's lattice turned against the last
    // (an offset): one octave of value noise is a lattice of dots.
    // Down to eight texels: the last octave of a value noise is a lattice
    // of blobs, and at four texels it drew a honeycomb over every near
    // view (2026-10-03); below it the shader's detail tiles take over.
    for (let wave = DETAIL_MAX_WAVELENGTH_M; wave >= pitchM * 8; wave /= 2) octaves.push({ cells: wave / source.metersPerCell, amplitude: wave * DETAIL_ROUGHNESS })
    for (let tj = 0; tj < m; tj++) {
      const y = y0 + (tj - 0.5) * pitch
      for (let ti = 0; ti < m; ti++) {
        const c = tj * m + ti
        if (metres[c] <= 0) continue
        const x = x0 + (ti - 0.5) * pitch
        const steepness = Math.min(1, Math.hypot(slopeX[c], slopeZ[c]) / (DETAIL_FULL_SLOPE * verticalScale))
        const gain = DETAIL_FLAT_SHARE + (1 - DETAIL_FLAT_SHARE) * steepness
        let d = 0
        for (let k = 0; k < octaves.length; k++) {
          const o = octaves[k]
          d += (valueNoise(x / o.cells + k * 0.37, (y + x * 0.5 * (k % 2)) / o.cells + k * 0.61) - 0.5) * o.amplitude
        }
        detail[c] = d * gain
      }
    }
  }

  // THE CAVITY from the WIDELY softened slope: how much the true slope
  // turns over a stencil of a blur radius either way, scaled to the
  // stencil — dimensionless, so a hollow reads the same on every ring.
  // From the heights it was the crease of every triangle's edge, drawn
  // as a line; from the lightly softened slope every node's bump, drawn
  // as a dot (2026-10-03). A hollow is wider than a node.
  const cs = cavityStencil
  const wideX = wide[0] ?? slopeX
  const wideZ = wide[1] ?? slopeZ
  const cavityAt = (c: number): number =>
    (((wideX[c + cs] - wideX[c - cs]) + (wideZ[c + cs * m] - wideZ[c - cs * m])) / verticalScale) * (CAVITY_STENCIL / cs)

  const varyCells = Math.max(VARIATION_CELLS, pitch * 6)

  // --- the textures ---------------------------------------------------------
  const albedo = new Uint8Array(texels * texels * 4)
  const normals = new Uint8Array(texels * texels * 4)
  const materials = new Uint8Array(texels * texels * 4)
  const rgb = new Float32Array(3)
  const tone = new Float32Array(3)
  for (let tj = 0; tj < texels; tj++) {
    const y = y0 + (tj + 0.5) * pitch
    for (let ti = 0; ti < texels; ti++) {
      const x = x0 + (ti + 0.5) * pitch
      const c = (tj + 1) * m + (ti + 1)
      const h = metres[c]
      const p = (tj * texels + ti) * 4

      // The normal of the DRAWN surface: the data's interpolated slope
      // plus the detail's; the sea floor is flat.
      let nx = 0
      let ny = 1
      let nz = 0
      if (h > SEA_FLOOR_SINK * source.elevationMeters || source.waterSurfaceAt(x, y) !== 0) {
        const dhdx = slopeX[c] + ((detail[c + 1] - detail[c - 1]) * verticalScale) / (2 * pitchM)
        const dhdz = slopeZ[c] + ((detail[c + m] - detail[c - m]) * verticalScale) / (2 * pitchM)
        const inv = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz)
        nx = -dhdx * inv
        ny = inv
        nz = -dhdz * inv
      }
      normals[p] = Math.round((nx * 0.5 + 0.5) * 255)
      normals[p + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      normals[p + 2] = Math.round((nz * 0.5 + 0.5) * 255)
      normals[p + 3] = 255

      // Under water: by the depth below the LOCAL level — the sea's, or
      // the basin's this point lies in (a terminal sea's floor can lie
      // kilometres under the sea's level and still be land, 2026-10-03).
      const waterLevel = source.waterLevelAt(x, y) * source.elevationMeters
      const surface = source.waterSurfaceAt(x, y)
      if (h <= waterLevel) {
        const depth = waterLevel - h
        if (surface === 0) {
          if (depth < SEA_DEEP_M) mix(SEA_SHALLOW, SEA_DEEP, smooth(0, SEA_DEEP_M, depth), rgb)
          else mix(SEA_DEEP, SEA_ABYSS, smooth(SEA_DEEP_M, SEA_ABYSS_M, depth), rgb)
        } else mix(LAKE_SHALLOW, LAKE_DEEP, smooth(0, LAKE_DEEP_M, depth), rgb)
        albedo[p] = rgb[0]
        albedo[p + 1] = rgb[1]
        albedo[p + 2] = rgb[2]
        albedo[p + 3] = 255
        continue
      }
      const overWater = h - waterLevel

      // The cover: the four nearest cells' colours blended, so a biome's
      // edge is a band and not a 7.8 km step.
      const bx = x - 0.5
      const by = y - 0.5
      const cx0 = Math.floor(bx)
      const cy0 = Math.floor(by)
      const fx = bx - cx0
      const fy = by - cy0
      rgb.fill(0)
      let canopy = 0
      let bare = 0
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy)
          if (w === 0) continue
          const biome = source.biomeAt(cx0 + dx + 0.5, cy0 + dy + 0.5)
          const cover = BIOME_COVER[biome] ?? BIOME_COVER[4]
          rgb[0] += cover[0] * w
          rgb[1] += cover[1] * w
          rgb[2] += cover[2] * w
          canopy += (BIOME_CANOPY[biome] ?? 0) * w
          bare += (BIOME_BARE[biome] ?? 0) * w
        }
      }
      // The stands and the clearings.
      if (canopy > 0) canopy *= smooth(0.3, 0.7, valueNoise(x / CANOPY_PATCH_CELLS + 3.1, y / CANOPY_PATCH_CELLS + 7.7) * 0.7 + valueNoise(x / (CANOPY_PATCH_CELLS * 0.3), y / (CANOPY_PATCH_CELLS * 0.3)) * 0.3)
      // Above the tree line the cover is alpine, whatever the biome.
      const alpine = smooth(ALPINE_HEIGHT_LO, ALPINE_HEIGHT_HI, h)
      if (alpine > 0) {
        mix([rgb[0], rgb[1], rgb[2]], BIOME_COVER[11], alpine, rgb)
        canopy *= 1 - alpine
        bare = bare + (0.6 - bare) * alpine
      }
      // The shore's sand, under everything else.
      const sand = 1 - smooth(0, SAND_HEIGHT_M, overWater)
      if (sand > 0) {
        mix([rgb[0], rgb[1], rgb[2]], SAND, sand, rgb)
        canopy *= 1 - sand
        bare = bare + (1 - bare) * sand
      }

      // Rock by the drawn slope (the data's, not the detail's) and by the
      // height.
      const steep = smooth(ROCK_SLOPE_LO, ROCK_SLOPE_HI, Math.hypot(slopeX[c], slopeZ[c]))
      const high = smooth(ROCK_HEIGHT_LO, ROCK_HEIGHT_HI, h)
      const rock = Math.max(steep, high * 0.7)
      if (rock > 0) {
        // The rock's grain at a few texels, whatever the ring: a fixed
        // wavelength was speckle on the coarse rings.
        const grain = valueNoise(x / (pitch * 5), y / (pitch * 5)) * 0.6 + valueNoise(x / (pitch * 20), y / (pitch * 20)) * 0.4
        mix(ROCK_DARK, ROCK_LIGHT, grain, tone)
        mix([rgb[0], rgb[1], rgb[2]], [tone[0], tone[1], tone[2]], rock, rgb)
      }
      // Snow by the local temperature; it slides off the steep rock.
      const t = source.seaTemperatureAt(x, y) - LAPSE_C_PER_M * h
      const snow = smooth(0, 1, (SNOW_T_HI - t) / (SNOW_T_HI - SNOW_T_LO)) * (1 - 0.4 * steep)
      if (snow > 0) mix([rgb[0], rgb[1], rgb[2]], SNOW, snow, rgb)
      // The material weights, the later layers over the earlier.
      const wSnow = snow
      const wRock = rock * (1 - wSnow)
      const wCanopy = canopy * (1 - rock) * (1 - wSnow)
      const wBare = Math.max(0, bare * (1 - rock) * (1 - wSnow) - wCanopy)
      materials[p] = Math.round(Math.min(1, wRock) * 255)
      materials[p + 1] = Math.round(Math.min(1, wBare) * 255)
      materials[p + 2] = Math.round(Math.min(1, wSnow) * 255)
      materials[p + 3] = Math.round(Math.min(1, wCanopy) * 255)

      // Cavity: hollows dark, crests light.
      const curvature = ti >= cs && tj >= cs && ti < texels - cs && tj < texels - cs ? cavityAt(c) * CAVITY_GAIN : 0
      const shade = 1 - Math.min(CAVITY_DARK, Math.max(0, curvature)) + Math.min(CAVITY_LIGHT, Math.max(0, -curvature))
      // The slow variation — never finer than a few texels, or a coarse
      // ring samples it as static (the poles at the world view, 2026-10-03).
      const vary = 1 + (valueNoise(x / varyCells, y / varyCells) - 0.5) * 2 * VARIATION
      const f = shade * vary
      albedo[p] = Math.min(255, rgb[0] * f)
      albedo[p + 1] = Math.min(255, rgb[1] * f)
      albedo[p + 2] = Math.min(255, rgb[2] * f)
      albedo[p + 3] = 255
    }
  }
  return { heights, albedo, normals, materials, texels }
}

// RGBA texels enlarged `scale` times a side, bilinear (a block per texel
// read as steps while the full build was still to come, 2026-10-03).
export function enlargeRgba(src: Uint8Array, side: number, scale: number): Uint8Array {
  const big = side * scale
  const out = new Uint8Array(big * big * 4)
  for (let j = 0; j < big; j++) {
    const sy = Math.min(side - 1, Math.max(0, (j + 0.5) / scale - 0.5))
    const y0 = Math.floor(sy)
    const y1 = Math.min(side - 1, y0 + 1)
    const fy = sy - y0
    for (let i = 0; i < big; i++) {
      const sx = Math.min(side - 1, Math.max(0, (i + 0.5) / scale - 0.5))
      const x0 = Math.floor(sx)
      const x1 = Math.min(side - 1, x0 + 1)
      const fx = sx - x0
      const a = (y0 * side + x0) * 4
      const b = (y0 * side + x1) * 4
      const c = (y1 * side + x0) * 4
      const d = (y1 * side + x1) * 4
      const dp = (j * big + i) * 4
      for (let ch = 0; ch < 4; ch++) {
        const top = src[a + ch] + (src[b + ch] - src[a + ch]) * fx
        const bottom = src[c + ch] + (src[d + ch] - src[c + ch]) * fx
        out[dp + ch] = top + (bottom - top) * fy
      }
    }
  }
  return out
}

