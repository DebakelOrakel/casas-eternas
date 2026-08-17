import { periodicValueNoise2D } from '../../worldgen/elevation/ridgedNoise'
import { UNINHABITABLE_BIOMES } from '../../worldgen/climate/biomes'
import { SEA_LEVEL } from '../../worldgen/elevation/elevationScale'

// How much of the world the player KNOWS, as one scalar per place — the input
// the watercolour map's three registers are bands of (see
// docs/design/watercolor-map.md). 0 is bare paper, ~0.35 the flat first wash,
// 1 fully worked-out.
//
// The exploration mechanic does not exist yet, and this deliberately does not
// pretend otherwise: the two sources here are STAND-INS, meant to be deleted.
// A debug brush, because it can produce the hard shapes on purpose (thin
// corridors, islands, ragged tongues) which a real scout would only stumble
// into; and a handful of deterministic pseudo-settlements so a freshly loaded
// world shows something. What matters for the look is that the field is
// world-anchored and continuous — where the numbers come from is the part that
// will be replaced.
//
// The grid is COARSE on purpose. It is not a resolution compromise: the drawn
// boundary is warped by a cell or two anyway (same trick, and the same reason,
// as expandBiomeIds in map/biomeIds.ts), so a fine grid would buy
// nothing but memory — and if exploration is ever tracked per hex, that warp is
// also what keeps a honeycomb silhouette off the frontier.

export const KNOWLEDGE_RES_X = 512
export const KNOWLEDGE_RES_Y = 256

// How far a sample coordinate may wander, in COARSE cells. Peak displacement,
// so 1.5 lets the frontier bulge by about a cell and a half — enough to read as
// organic, not enough to leak a settlement's halo into the next valley.
const WARP_CELLS = 1.5
// Lattice density of the warp field as a multiple of the knowledge grid. Same
// reasoning as biomeIds' WARP_LATTICE_SCALE: at the grid's own frequency the
// warp is white noise and produces a ragged one-cell edge rather than a
// meander; a couple of cells per lattice step is what reads as a coastline.
const WARP_LATTICE_SCALE = 0.5

export interface KnowledgeField {
  // k per TEXTURE texel, 0..1 — what the presentation reads. Rebuilt only when
  // the field actually changes (see `revision`).
  readonly texels: Float32Array
  // Bumped on every mutation, so a caller can tell "worth repainting" from
  // "nothing happened" without diffing 8 million texels.
  readonly revision: number
  // Raise k in a disc around a world UV. `strength` is the value approached at
  // the centre; the rim falls off smoothly, and existing knowledge is never
  // lowered — you do not un-learn a place by walking past it again.
  paint(u: number, v: number, radiusUV: number, strength: number): void
  // The stand-in initial state: `count` sites on habitable land, each with an
  // active core inside an explored halo. Deterministic in `seed`.
  seed(elevations: Float32Array, width: number, height: number, biome: { data: Float32Array; resX: number; resY: number } | null, seed: number, count: number): void
  fill(value: number): void
  sampleAtUV(u: number, v: number): number
  // k as bytes at an arbitrary resolution, for handing to a shader. Sampled
  // through the same warp as everything else, so the frontier a fragment sees
  // is the frontier the paper was painted with.
  toBytes(width: number, height: number): Uint8Array
}

// Radii as a fraction of world width. A settlement's immediate surroundings are
// worked out in detail; what its people have merely walked through reaches a few
// times further.
const ACTIVE_RADIUS = 0.035
const EXPLORED_RADIUS = 0.13

export function createKnowledgeField(textureWidth: number, textureHeight: number, warpSeed: number): KnowledgeField {
  const resX = KNOWLEDGE_RES_X
  const resY = KNOWLEDGE_RES_Y
  const grid = new Float32Array(resX * resY)
  const texels = new Float32Array(textureWidth * textureHeight)
  let revision = 0
  let texelsRevision = -1

  // The warp, precomputed at the KNOWLEDGE grid's resolution and interpolated
  // when rasterising. Evaluating the noise per texture texel instead would be
  // 16 million evaluations for a field that is smooth by construction — the
  // interpolation is faithful and about ten times cheaper, which is the
  // difference between a brush that follows the pointer and one that does not.
  const latticeX = Math.max(2, Math.round(resX * WARP_LATTICE_SCALE))
  const latticeY = Math.max(2, Math.round(resY * WARP_LATTICE_SCALE))
  const warpU = new Float32Array(resX * resY)
  const warpV = new Float32Array(resX * resY)
  {
    const seedV = (warpSeed ^ 0x5bf03635) >>> 0
    const ampU = (WARP_CELLS / resX)
    const ampV = (WARP_CELLS / resY)
    for (let y = 0; y < resY; y++) {
      const ly = (y / resY) * latticeY
      for (let x = 0; x < resX; x++) {
        const lx = (x / resX) * latticeX
        const i = y * resX + x
        warpU[i] = (periodicValueNoise2D(lx, ly, latticeX, latticeY, warpSeed) - 0.5) * 2 * ampU
        warpV[i] = (periodicValueNoise2D(lx, ly, latticeX, latticeY, seedV) - 0.5) * 2 * ampV
      }
    }
  }

  const wrap = (i: number, n: number): number => ((i % n) + n) % n

  function bilinear(data: Float32Array, u: number, v: number): number {
    const x = u * resX - 0.5
    const y = v * resY - 0.5
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const x0w = wrap(x0, resX)
    const x1w = wrap(x0 + 1, resX)
    const y0w = wrap(y0, resY)
    const y1w = wrap(y0 + 1, resY)
    const top = data[y0w * resX + x0w] * (1 - fx) + data[y0w * resX + x1w] * fx
    const bottom = data[y1w * resX + x0w] * (1 - fx) + data[y1w * resX + x1w] * fx
    return top * (1 - fy) + bottom * fy
  }

  function sampleAtUV(u: number, v: number): number {
    const uw = u - Math.floor(u)
    const vw = v - Math.floor(v)
    const ou = bilinear(warpU, uw, vw)
    const ov = bilinear(warpV, uw, vw)
    return bilinear(grid, uw + ou - Math.floor(uw + ou), vw + ov - Math.floor(vw + ov))
  }

  function rasterise(): void {
    if (texelsRevision === revision) return
    for (let y = 0; y < textureHeight; y++) {
      const v = (y + 0.5) / textureHeight
      for (let x = 0; x < textureWidth; x++) {
        texels[y * textureWidth + x] = sampleAtUV((x + 0.5) / textureWidth, v)
      }
    }
    texelsRevision = revision
  }

  return {
    get texels(): Float32Array {
      rasterise()
      return texels
    },
    get revision(): number {
      return revision
    },

    paint(u: number, v: number, radiusUV: number, strength: number): void {
      // The disc is expressed in world UV, so it is round in WORLD terms; the
      // grid is twice as wide as it is tall, hence the two radii.
      const rx = radiusUV * resX
      const ry = radiusUV * 2 * resY
      const cx = u * resX
      const cy = v * resY
      const x0 = Math.floor(cx - rx)
      const x1 = Math.ceil(cx + rx)
      const y0 = Math.max(0, Math.floor(cy - ry))
      const y1 = Math.min(resY - 1, Math.ceil(cy + ry))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = (x - cx) / rx
          const dy = (y - cy) / ry
          const d = Math.hypot(dx, dy)
          if (d > 1) continue
          // Smooth rim, so a stroke has no visible disc edge once the warp has
          // had its say.
          const falloff = 1 - d * d * (3 - 2 * d) / 1
          const want = strength * Math.min(1, falloff * 1.4)
          const i = y * resX + wrap(x, resX)
          if (want > grid[i]) grid[i] = want
        }
      }
      revision++
    },

    seed(elevations, width, height, biome, seedValue, count): void {
      grid.fill(0)
      // Habitability, guessed from what a save actually carries: land, not ice,
      // not permanent desert. Crude on purpose — this only has to put the
      // stand-in settlements somewhere plausible.
      const habitable: number[] = []
      for (let i = 0; i < elevations.length; i++) {
        if (elevations[i] <= SEA_LEVEL) continue
        if (biome) {
          const bx = Math.min(biome.resX - 1, Math.floor(((i % width) / width) * biome.resX))
          const by = Math.min(biome.resY - 1, Math.floor((Math.floor(i / width) / height) * biome.resY))
          const id = Math.round(biome.data[by * biome.resX + bx])
          if (UNINHABITABLE_BIOMES.has(id)) continue
        }
        habitable.push(i)
      }
      if (habitable.length === 0) return
      // Deterministic in the seed, and spread out rather than clustered: taking
      // evenly spaced entries of the habitable list walks the raster in scan
      // order, which is not a real spatial spread but is enough for a stand-in.
      let s = (seedValue ^ 0x2545f491) >>> 0
      const next = (): number => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff }
      for (let n = 0; n < count; n++) {
        const pick = habitable[Math.floor(next() * habitable.length)]
        const u = (pick % width) / width
        const v = Math.floor(pick / width) / height
        this.paint(u, v, EXPLORED_RADIUS, 0.45)
        this.paint(u, v, ACTIVE_RADIUS, 1)
      }
    },

    fill(value: number): void {
      grid.fill(value)
      revision++
    },

    sampleAtUV,

    toBytes(width: number, height: number): Uint8Array {
      const out = new Uint8Array(width * height)
      for (let y = 0; y < height; y++) {
        const v = (y + 0.5) / height
        for (let x = 0; x < width; x++) {
          out[y * width + x] = Math.round(Math.min(1, Math.max(0, sampleAtUV((x + 0.5) / width, v))) * 255)
        }
      }
      return out
    },
  }
}
