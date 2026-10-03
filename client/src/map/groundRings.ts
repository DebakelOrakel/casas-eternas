import { Color3, Mesh, RawTexture, StandardMaterial, Texture, VertexData, type BaseTexture, type Scene } from '@babylonjs/core'
import { GroundNormalPlugin } from './groundNormalPlugin'

// THE GROUND AS RINGS, at every zoom (docs/decisions/near-ground-clipmap.md,
// decided 2026-08-15; rings first built 2026-10-02 for the incubator's near
// regime, made the only ground 2026-10-03): concentric square rings around
// the focus, each `quads` quads a side at twice the spacing of the one
// inside it, each but the innermost with a hole where the inner one lies.
// The ladder of spacings is FIXED — spacing0 · 2^k — so a zoom never moves
// a ring's grid; what the zoom decides is which rings are drawn: a ring
// whose texels fall below a pixel is left out, and the ring outside it
// has no hole. Resolution falls outward continuously, and the rings run
// on until the outermost spans the world.
//
// A ring is BUILT ELSEWHERE (the caller's `build`, a worker): its heights,
// and two textures finer than its quads — the albedo and the normals, see
// map/groundPaint.ts — arrive together and are swapped in together, so a
// ring is never half new. Until a ring's build for a new place arrives the
// old one stays where it stood: the ring outside it covers the gap, a
// little coarser, which is what streaming looks like in every game. One
// build in flight per ring; a place wanted meanwhile waits and only the
// latest is kept.
//
// Each ring snaps to a grid of twice its own spacing, so its heights stay
// put while the focus moves (no crawling) and its hole falls on its own
// quad lines. The rings meet with SKIRTS (a strip hanging from each ring's
// outer edge) and MATCHED EDGES (the builder's: the outer row takes the
// outer ring's ground), so no crack and no step opens between them.

export interface RingBuildRequest {
  // The ring's index on the ladder (0 the finest), its centre, its spacing
  // (world units) and its size; whether it is the outermost ring.
  k: number
  centerX: number
  centerZ: number
  spacing: number
  quads: number
  texels: number
  outermost: boolean
  // A PREVIEW: the textures at a quarter of the side (a sixteenth of the
  // work), shown until the full build follows — the inner rings arrive
  // in a moment after a pan instead of seconds.
  preview: boolean
}

export interface RingBuildResult {
  // (quads + 1)² heights in world Y units, before the exaggeration.
  heights: Float32Array
  // The ring's texels² RGBA each: the albedo, the world-space normals
  // and the material weights (groundPaint.ts).
  albedo: Uint8Array
  normals: Uint8Array
  materials: Uint8Array
  // Whether this is a preview's result (painted coarser, enlarged).
  preview: boolean
  // Whether the build read all the ground it wanted: a build that found
  // a tile still loading is drawn, and the builder calls `rebuild` once
  // the tile is in — a preview then waits for that call rather than
  // following up with a full build of the same incomplete ground.
  complete: boolean
}

export interface GroundRingsOptions {
  scene: Scene
  // Quads a ring has a side (a multiple of 4).
  quads: number
  // The innermost ring's spacing, world units.
  spacing0: number
  // World extent the outermost ring must reach.
  worldSpan: number
  // Texels a side of ring k's textures.
  texelsFor(k: number): number
  // Build a ring: null when the build was dropped (a newer one superseded
  // it, or the builder is gone).
  build(request: RingBuildRequest): Promise<RingBuildResult | null>
}

export interface GroundRings {
  readonly meshes: readonly Mesh[]
  // The number of rings on the ladder.
  readonly count: number
  // Place the rings for a focus; `unitsPerPixel` (world units a screen
  // pixel spans at the focus) decides the innermost ring drawn.
  update(focusX: number, focusZ: number, unitsPerPixel: number): void
  // The innermost ring drawn now.
  innermost(): number
  // Builds arrived and not yet applied (one is, per update).
  pendingArrivals(): number
  // The drawn ground's height (world Y units, before the exaggeration) at
  // a point: the finest ring drawn there; 0 where none is built yet.
  heightAt(x: number, z: number): number
  // Build ring k again where it stands: the ground it read changed.
  rebuild(k: number): void
  setEnabled(enabled: boolean): void
  setHeightScale(scale: number): void
  // The shader's detail under the texels (groundNormalPlugin): the set of
  // tiling textures, and the wavelengths and strength to draw them at.
  setDetailTextures(albedo: BaseTexture | null, normals: BaseTexture | null): void
  setDetail(micro: number, macro: number, strength: number, reach: number): void
  // The lighting's relief gain (groundNormalPlugin.setRelief).
  setRelief(gain: number): void
  // DEBUG: a tint per ring over the albedo, so the rings can be told apart.
  setTinted(on: boolean): void
  dispose(): void
}

interface Place {
  x: number
  z: number
}

interface Ring {
  k: number
  spacing: number
  half: number
  texels: number
  mesh: Mesh
  material: StandardMaterial
  albedo: RawTexture
  normals: RawTexture
  materials: RawTexture
  normalPlugin: GroundNormalPlugin
  // Whether the ring's textures are a preview's (the full build is due).
  previewed: boolean
  // Where the ring stands (its last applied build), its heights there.
  built: Place | null
  heights: Float32Array | null
  // The build in flight, and the place wanted after it.
  pending: Place | null
  wanted: Place | null
  // Whether the ring is wanted again where it stands (rebuild).
  stale: boolean
  // Where the inner ring stood when this ring's hole was last cut; NaN
  // for no hole.
  holeX: number
  holeZ: number
}

// The texel size, in screen pixels at the focus, below which a ring is
// left out: finer than this it only costs.
const MIN_TEXEL_PX = 0.8
// The rings from which a first build is previewed, and the preview's
// side divisor.
const PREVIEW_FROM = 6
const PREVIEW_DIVISOR = 4

export function createGroundRings(options: GroundRingsOptions): GroundRings {
  const { scene, quads, spacing0, worldSpan } = options
  if (quads % 4 !== 0) throw new Error('groundRings: quads must be a multiple of 4')
  const n = quads + 1
  let heightScale = 1
  let enabled = true
  let innermostActive = 0

  // The ladder: rings until one spans the world.
  let count = 1
  while (spacing0 * 2 ** (count - 1) * quads < worldSpan && count < 24) count++

  // Buffers shared by every rebuild: the grid, then the skirt (one vertex
  // under each of the 4·quads edge vertices).
  const edgeCount = 4 * quads
  const vertexCount = n * n + edgeCount
  // Each ring's own: Babylon keeps the array it is handed in an update as
  // the buffer's data, so one array for every ring left every ring's
  // bounds and any later read the last ring's (2026-10-03).
  const positionsOf = new Map<Ring, Float32Array>()
  const normalsOf = new Map<Ring, Float32Array>()
  // The edge vertices in order around the ring, as grid indices.
  const edge: number[] = []
  for (let i = 0; i < quads; i++) edge.push(i)
  for (let j = 0; j < quads; j++) edge.push(j * n + quads)
  for (let i = quads; i > 0; i--) edge.push(quads * n + i)
  for (let j = quads; j > 0; j--) edge.push(j * n)

  // The UVs never change: the ring's square is the texture's.
  const uvs = new Float32Array(vertexCount * 2)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      uvs[(j * n + i) * 2] = i / quads
      uvs[(j * n + i) * 2 + 1] = j / quads
    }
  }
  for (let e = 0; e < edgeCount; e++) {
    uvs[(n * n + e) * 2] = uvs[edge[e] * 2]
    uvs[(n * n + e) * 2 + 1] = uvs[edge[e] * 2 + 1]
  }

  const rings: Ring[] = []
  for (let k = 0; k < count; k++) {
    const spacing = spacing0 * 2 ** k
    const texels = options.texelsFor(k)
    const mesh = new Mesh(`groundRing${k}`, scene)
    mesh.isPickable = true
    mesh.scaling.y = heightScale
    mesh.setEnabled(false)
    const material = new StandardMaterial(`groundRing${k}Material`, scene)
    material.specularColor = new Color3(0, 0, 0)
    const blank = new Uint8Array(texels * texels * 4)
    const albedo = RawTexture.CreateRGBATexture(blank, texels, texels, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
    const normalMap = RawTexture.CreateRGBATexture(blank.slice(), texels, texels, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
    const materialMap = RawTexture.CreateRGBATexture(blank.slice(), texels, texels, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
    for (const t of [albedo, normalMap, materialMap]) {
      t.wrapU = Texture.CLAMP_ADDRESSMODE
      t.wrapV = Texture.CLAMP_ADDRESSMODE
      // Seen at a grazing angle, a texture without it is smeared along
      // the view (the flat slopes, 2026-10-03).
      t.anisotropicFilteringLevel = 16
    }
    material.diffuseTexture = albedo
    const normalPlugin = new GroundNormalPlugin(material)
    normalPlugin.setTexture(normalMap)
    normalPlugin.setMaterials(materialMap)
    mesh.material = material
    rings.push({ k, spacing, half: (quads / 2) * spacing, texels, mesh, material, albedo, normals: normalMap, materials: materialMap, normalPlugin, previewed: false, built: null, heights: null, pending: null, wanted: null, stale: false, holeX: NaN, holeZ: NaN })
  }

  // The ring's triangles: every quad but those inside the inner ring's
  // place (when it has one), and the skirt along the outer edge.
  function indicesFor(ring: Ring, hole: Place | null): Uint32Array {
    const out: number[] = []
    let box: { i0: number; i1: number; j0: number; j1: number } | null = null
    if (hole && ring.built) {
      // The inner ring's extent in this ring's quads: it spans quads/2 of
      // them, centred on its own centre (a multiple of this spacing).
      const di = Math.round((hole.x - ring.built.x) / ring.spacing)
      const dj = Math.round((hole.z - ring.built.z) / ring.spacing)
      const half = quads / 2
      box = { i0: half + di - quads / 4, i1: half + di + quads / 4, j0: half + dj - quads / 4, j1: half + dj + quads / 4 }
    }
    for (let j = 0; j < quads; j++) {
      for (let i = 0; i < quads; i++) {
        if (box && i >= box.i0 && i < box.i1 && j >= box.j0 && j < box.j1) continue
        // Babylon's front face, as its own CreateGround winds it (wound the
        // other way the ground was culled, 2026-10-02).
        const a = j * n + i
        const b = a + 1
        const c = a + n
        const d = c + 1
        out.push(a, b, c, b, d, c)
      }
    }
    for (let e = 0; e < edgeCount; e++) {
      const top0 = edge[e]
      const top1 = edge[(e + 1) % edgeCount]
      const low0 = n * n + e
      const low1 = n * n + ((e + 1) % edgeCount)
      out.push(top0, low0, top1, top1, low0, low1)
    }
    return new Uint32Array(out)
  }

  // The hole ring k should have now: the ring inside it, where it stands,
  // when that ring is drawn.
  function holeFor(k: number): Place | null {
    if (k <= innermostActive) return null
    const inner = rings[k - 1]
    return inner.built && inner.mesh.isEnabled() ? inner.built : null
  }

  function cutHole(ring: Ring): void {
    const hole = holeFor(ring.k)
    const hx = hole ? hole.x : NaN
    const hz = hole ? hole.z : NaN
    if (Object.is(hx, ring.holeX) && Object.is(hz, ring.holeZ)) return
    ring.mesh.setIndices(indicesFor(ring, hole))
    ring.holeX = hx
    ring.holeZ = hz
  }

  // The build arrived: the geometry and the textures in one step.
  function apply(ring: Ring, place: Place, result: RingBuildResult): void {
    let positions = positionsOf.get(ring)
    let normals = normalsOf.get(ring)
    if (!positions || !normals) {
      positions = new Float32Array(vertexCount * 3)
      normals = new Float32Array(vertexCount * 3)
      positionsOf.set(ring, positions)
      normalsOf.set(ring, normals)
    }
    const s = ring.spacing
    const half = ring.half
    const heights = result.heights
    for (let j = 0; j < n; j++) {
      const lz = j * s - half
      for (let i = 0; i < n; i++) {
        const idx = j * n + i
        positions[idx * 3] = i * s - half
        positions[idx * 3 + 1] = heights[idx]
        positions[idx * 3 + 2] = lz
      }
    }
    // Vertex normals from the grid: the light reads the normal map, these
    // serve the shadow's bias and anything that asks the mesh.
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i
        const hl = heights[j * n + Math.max(0, i - 1)]
        const hr = heights[j * n + Math.min(n - 1, i + 1)]
        const hu = heights[Math.max(0, j - 1) * n + i]
        const hd = heights[Math.min(n - 1, j + 1) * n + i]
        const dhdx = ((hr - hl) * heightScale) / (2 * s)
        const dhdz = ((hd - hu) * heightScale) / (2 * s)
        const inv = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz)
        normals[idx * 3] = -dhdx * inv
        normals[idx * 3 + 1] = inv
        normals[idx * 3 + 2] = -dhdz * inv
      }
    }
    // The skirt hangs two spacings down (in unscaled height units; the
    // mesh's own y scale stretches it with the exaggeration).
    const drop = 2 * s
    for (let e = 0; e < edgeCount; e++) {
      const top = edge[e]
      const at = (n * n + e) * 3
      positions[at] = positions[top * 3]
      positions[at + 1] = heights[top] - drop
      positions[at + 2] = positions[top * 3 + 2]
      normals[at] = normals[top * 3]
      normals[at + 1] = normals[top * 3 + 1]
      normals[at + 2] = normals[top * 3 + 2]
    }
    const wasBuilt = ring.built !== null
    ring.built = place
    ring.heights = heights
    if (!wasBuilt) {
      const data = new VertexData()
      data.positions = positions
      data.normals = normals
      data.uvs = uvs.slice()
      data.indices = indicesFor(ring, null)
      data.applyToMesh(ring.mesh, true)
      ring.holeX = NaN
      ring.holeZ = NaN
    } else {
      ring.mesh.updateVerticesData('position', positions)
      ring.mesh.updateVerticesData('normal', normals)
      // The hole is cut against the new place.
      ring.holeX = NaN
      ring.holeZ = NaN
    }
    cutHole(ring)
    // A preview's textures arrive enlarged to the ring's size already.
    ring.albedo.update(result.albedo)
    ring.normals.update(result.normals)
    ring.materials.update(result.materials)
    ring.previewed = result.preview
    ring.mesh.position.set(place.x, 0, place.z)
    ring.mesh.refreshBoundingInfo()
    // The ring outside takes its hole from the new place.
    if (ring.k + 1 < count) cutHole(rings[ring.k + 1])
  }

  let disposed = false

  // A ring is built in two steps only where it pays: an OUTER ring's
  // first build (1024 texels, seconds) gets a preview (the textures at a
  // quarter side) first. A ring that stands already keeps what it shows
  // until its full build arrives — a preview in between threw a sharp
  // ring away for a blur at every step of a pan (2026-10-03).
  function request(ring: Ring, place: Place, preview = ring.k >= PREVIEW_FROM && !ring.built): void {
    ring.pending = place
    ring.stale = false
    void options
      .build({ k: ring.k, centerX: place.x, centerZ: place.z, spacing: ring.spacing, quads, texels: preview ? ring.texels / PREVIEW_DIVISOR : ring.texels, outermost: ring.k === count - 1, preview })
      .then((result) => {
        if (disposed) return
        // Applied on a frame of its own (see `update`): four workers
        // delivering at once put four uploads in one frame (300 ms,
        // 2026-10-03).
        arrivals.push({ ring, place, result, preview })
      })
  }
  const arrivals: { ring: Ring; place: Place; result: RingBuildResult | null; preview: boolean }[] = []
  function applyOne(): void {
    const next = arrivals.shift()
    if (!next) return
    const { ring, place, result, preview } = next
    ring.pending = null
    if (result) apply(ring, place, result)
    const wanted = ring.wanted
    ring.wanted = null
    if (wanted && (!ring.built || wanted.x !== ring.built.x || wanted.z !== ring.built.z)) request(ring, wanted)
    else if (preview && result && result.complete) request(ring, place, false)
    else if (ring.stale && ring.built) request(ring, ring.built, false)
  }

  function wantAt(ring: Ring, place: Place): void {
    if (ring.pending) {
      if (ring.pending.x !== place.x || ring.pending.z !== place.z) ring.wanted = place
      return
    }
    if (ring.built && ring.built.x === place.x && ring.built.z === place.z) {
      if (ring.stale) request(ring, place)
      return
    }
    request(ring, place)
  }

  return {
    get meshes() {
      return rings.map((r) => r.mesh)
    },
    count,
    update(focusX, focusZ, unitsPerPixel) {
      applyOne()
      // The innermost ring whose texels are still a pixel's worth.
      let a = count - 1
      for (let k = 0; k < count; k++) {
        const texel = (rings[k].spacing * quads) / rings[k].texels
        if (texel >= MIN_TEXEL_PX * unitsPerPixel) {
          a = k
          break
        }
      }
      innermostActive = a
      // Outermost first: the coarse ground arrives before the fine one.
      for (let k = count - 1; k >= 0; k--) {
        const ring = rings[k]
        if (k < a) {
          ring.mesh.setEnabled(false)
          continue
        }
        const grid = 2 * ring.spacing
        wantAt(ring, { x: Math.round(focusX / grid) * grid, z: Math.round(focusZ / grid) * grid })
        ring.mesh.setEnabled(enabled && ring.built !== null)
      }
      // The holes follow what is drawn inside.
      for (let k = a; k < count; k++) if (rings[k].built) cutHole(rings[k])
    },
    innermost: () => innermostActive,
    pendingArrivals: () => arrivals.length,
    heightAt(x, z) {
      for (let k = innermostActive; k < count; k++) {
        const ring = rings[k]
        if (!ring.built || !ring.heights) continue
        const lx = x - ring.built.x + ring.half
        const lz = z - ring.built.z + ring.half
        if (lx < 0 || lz < 0 || lx > 2 * ring.half || lz > 2 * ring.half) continue
        const gi = Math.min(quads - 1, Math.floor(lx / ring.spacing))
        const gj = Math.min(quads - 1, Math.floor(lz / ring.spacing))
        const fx = lx / ring.spacing - gi
        const fz = lz / ring.spacing - gj
        const h = ring.heights
        const top = h[gj * n + gi] * (1 - fx) + h[gj * n + gi + 1] * fx
        const bottom = h[(gj + 1) * n + gi] * (1 - fx) + h[(gj + 1) * n + gi + 1] * fx
        return top * (1 - fz) + bottom * fz
      }
      return 0
    },
    rebuild(k) {
      const ring = rings[k]
      // A build still in flight (or just resolved, its apply a microtask
      // away) takes the stale mark up when it completes; a ring never
      // asked for has nothing to build again. Always the full build.
      if (!ring.built && !ring.pending) return
      ring.stale = true
      if (!ring.pending && ring.built) request(ring, ring.built, false)
    },
    setEnabled(next) {
      enabled = next
      for (const ring of rings) ring.mesh.setEnabled(next && ring.built !== null && ring.k >= innermostActive)
    },
    setHeightScale(scale) {
      if (scale === heightScale) return
      heightScale = scale
      for (const ring of rings) ring.mesh.scaling.y = scale
    },
    setDetailTextures(albedo, normals) {
      for (const ring of rings) ring.normalPlugin.setDetailTextures(albedo, normals)
    },
    setDetail(micro, macro, strength, reach) {
      for (const ring of rings) ring.normalPlugin.setDetail(micro, macro, strength, reach)
    },
    setRelief(gain) {
      for (const ring of rings) ring.normalPlugin.setRelief(gain)
    },
    setTinted(on) {
      for (const ring of rings) {
        const hue = (ring.k * 0.37) % 1
        ring.material.diffuseColor = on ? Color3.FromHSV(hue * 360, 0.5, 1) : new Color3(1, 1, 1)
      }
    },
    dispose() {
      disposed = true
      arrivals.length = 0
      for (const ring of rings) {
        ring.mesh.dispose()
        ring.material.dispose()
        ring.albedo.dispose()
        ring.normals.dispose()
        ring.materials.dispose()
      }
    },
  }
}
