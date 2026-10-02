import { Color3, Mesh, StandardMaterial, VertexData, type Scene } from '@babylonjs/core'

// THE NEAR GROUND AS RINGS (docs/decisions/near-ground-clipmap.md, decided
// 2026-08-15, first built here 2026-10-02 for the incubator): concentric
// square rings around the focus, each `quads` quads a side at twice the
// spacing of the one inside it, each but the innermost with a hole where
// the inner one lies. Resolution falls outward continuously; the rings run
// on until the outermost spans the world, so they are the only ground —
// nothing behind them to show through.
//
// Each ring snaps to a grid of twice its own spacing, so its heights stay
// put while the focus moves (no crawling) and its hole falls on its own
// quad lines. A ring is rebuilt only when its snapped centre moves or the
// spacing changes.
//
// The rings meet with SKIRTS: a strip hanging down from each ring's outer
// edge. Where the coarser ring's straight edge passes under the finer
// ring's vertices a crack would open; the skirt fills it from below.
//
// The heights and colours come from the caller, per ring, with the ring's
// spacing — so a ring can read the level whose nodes its quads can carry
// (the incubator's tiles: level 3 near, level 2 further, level 1 beyond).

export interface NearRingsOptions {
  scene: Scene
  // Quads a ring has a side (even). The decision's sketch was 128.
  quads: number
  // World extent the outermost ring must reach (the torus' longer side).
  worldSpan: number
  // The ground at a world point, world units, for a ring of `spacing`.
  heightAt(x: number, z: number, spacing: number): number
  // Its colour, rgb 0..1 into out[0..2].
  colorAt(x: number, z: number, spacing: number, out: Float32Array): void
}

export interface NearRings {
  readonly meshes: readonly Mesh[]
  // Place the rings for a focus and the innermost spacing (world units).
  update(focusX: number, focusZ: number, spacing0: number): void
  // Rebuild the rings at their place whose spacing is at most
  // `maxSpacing` (all without it): the ground they read changed.
  refresh(maxSpacing?: number): void
  setEnabled(enabled: boolean): void
  setHeightScale(scale: number): void
  dispose(): void
}

interface Ring {
  mesh: Mesh
  spacing: number
  centerX: number
  centerZ: number
  built: boolean
  // Where the inner ring stood when this ring's hole was last cut.
  holeX: number
  holeZ: number
}

export function createNearRings(options: NearRingsOptions): NearRings {
  const { scene, quads, worldSpan } = options
  if (quads % 4 !== 0) throw new Error('nearRings: quads must be a multiple of 4')
  const n = quads + 1
  const material = new StandardMaterial('nearRingsMaterial', scene)
  material.specularColor = new Color3(0, 0, 0)
  const rings: Ring[] = []
  let spacing0 = 0
  let heightScale = 1
  let enabled = true

  // Buffers shared by every rebuild: the grid, then the skirt (one vertex
  // under each of the 4·quads edge vertices).
  const edgeCount = 4 * quads
  const vertexCount = n * n + edgeCount
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const colors = new Float32Array(vertexCount * 4)
  const heights = new Float32Array(n * n)
  const rgb = new Float32Array(3)

  // The edge vertices in order around the ring, as grid indices.
  const edge: number[] = []
  for (let i = 0; i < quads; i++) edge.push(i)
  for (let j = 0; j < quads; j++) edge.push(j * n + quads)
  for (let i = quads; i > 0; i--) edge.push(quads * n + i)
  for (let j = quads; j > 0; j--) edge.push(j * n)

  function ringCount(s0: number): number {
    let count = 1
    while (s0 * 2 ** (count - 1) * quads < worldSpan && count < 24) count++
    return count
  }

  function ensureRings(count: number): void {
    while (rings.length < count) {
      const mesh = new Mesh(`nearRing${rings.length}`, scene)
      mesh.material = material
      mesh.isPickable = true
      mesh.scaling.y = heightScale
      mesh.setEnabled(false)
      rings.push({ mesh, spacing: 0, centerX: 0, centerZ: 0, built: false, holeX: NaN, holeZ: NaN })
    }
  }

  // The ring's triangles: every quad but those inside the inner ring (from
  // ring 1 on), and the skirt along the outer edge.
  function indicesFor(k: number, ring: Ring): Uint32Array {
    const out: number[] = []
    const half = quads / 2
    let hole: { i0: number; i1: number; j0: number; j1: number } | null = null
    if (k > 0) {
      // The inner ring's extent in this ring's quads: it spans quads/2 of
      // them, centred on its own centre (a multiple of this spacing).
      const inner = rings[k - 1]
      const di = Math.round((inner.centerX - ring.centerX) / ring.spacing)
      const dj = Math.round((inner.centerZ - ring.centerZ) / ring.spacing)
      hole = { i0: half + di - quads / 4, i1: half + di + quads / 4, j0: half + dj - quads / 4, j1: half + dj + quads / 4 }
    }
    for (let j = 0; j < quads; j++) {
      for (let i = 0; i < quads; i++) {
        if (hole && i >= hole.i0 && i < hole.i1 && j >= hole.j0 && j < hole.j1) continue
        // Babylon's front face, as its own CreateGround winds it: seen from
        // above, a → b → c turns the way (x, z) → (x + s, z) → (x, z + s)
        // does (wound the other way the ground was culled, 2026-10-02).
        const a = j * n + i
        const b = a + 1
        const c = a + n
        const d = c + 1
        out.push(a, b, c, b, d, c)
      }
    }
    // The skirt: each edge segment and its two hanging vertices.
    for (let e = 0; e < edgeCount; e++) {
      const top0 = edge[e]
      const top1 = edge[(e + 1) % edgeCount]
      const low0 = n * n + e
      const low1 = n * n + ((e + 1) % edgeCount)
      out.push(top0, low0, top1, top1, low0, low1)
    }
    return new Uint32Array(out)
  }

  function build(k: number): void {
    const ring = rings[k]
    const s = ring.spacing
    const half = (quads / 2) * s
    for (let j = 0; j < n; j++) {
      const lz = j * s - half
      for (let i = 0; i < n; i++) {
        const lx = i * s - half
        const idx = j * n + i
        const y = options.heightAt(ring.centerX + lx, ring.centerZ + lz, s)
        heights[idx] = y
        positions[idx * 3] = lx
        positions[idx * 3 + 1] = y
        positions[idx * 3 + 2] = lz
      }
    }
    // MATCHED EDGES: the outermost row takes the ring outside's ground —
    // its spacing (so its level), at every second vertex, which lies on
    // that ring's grid (a ring's edge is quads/2 of its spacing from a
    // centre snapped to twice that), and the straight line between them
    // at the others: exactly the edge the outer ring's hole has. Without
    // it the two grounds met in a step, and where the outer one stood
    // higher the view looked through it (2026-10-02); the skirts only
    // reach down.
    if (k < activeCount - 1) {
      const outer = 2 * s
      for (let e = 0; e < edgeCount; e++) {
        const v = edge[e]
        const i = v % n
        const j = (v - i) / n
        if ((i + j) % 2 !== 0) continue
        heights[v] = options.heightAt(ring.centerX + i * s - half, ring.centerZ + j * s - half, outer)
      }
      for (let e = 0; e < edgeCount; e++) {
        const v = edge[e]
        const i = v % n
        const j = (v - i) / n
        if ((i + j) % 2 === 0) continue
        // Its neighbours along the edge, both on the outer grid.
        heights[v] = 0.5 * (heights[edge[(e + edgeCount - 1) % edgeCount]] + heights[edge[(e + 1) % edgeCount]])
      }
      for (const v of edge) positions[v * 3 + 1] = heights[v]
    }
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
        // Steeper is darker, as on the patch: fine structure stays legible
        // where the light barely varies.
        const brightness = 1 - Math.min(0.4, Math.sqrt(dhdx * dhdx + dhdz * dhdz) * 0.8)
        options.colorAt(ring.centerX + positions[idx * 3], ring.centerZ + positions[idx * 3 + 2], s, rgb)
        colors[idx * 4] = rgb[0] * brightness
        colors[idx * 4 + 1] = rgb[1] * brightness
        colors[idx * 4 + 2] = rgb[2] * brightness
        colors[idx * 4 + 3] = 1
      }
    }
    // The skirt hangs two spacings down (in unscaled height units: the
    // mesh's own y scale stretches it with the exaggeration), deep enough
    // for the step a finer ring's vertex can make over a coarser ring's
    // straight edge at any slope the ground has.
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
      colors.copyWithin((n * n + e) * 4, top * 4, top * 4 + 4)
    }
    // Copies: Babylon keeps the arrays it is given (picking, bounds and a
    // lost context read them back), and these buffers serve every ring.
    const data = new VertexData()
    data.positions = positions.slice()
    data.normals = normals.slice()
    data.colors = colors.slice()
    data.indices = indicesFor(k, ring)
    data.applyToMesh(ring.mesh, true)
    if (k > 0) {
      ring.holeX = rings[k - 1].centerX
      ring.holeZ = rings[k - 1].centerZ
    }
    ring.mesh.position.set(ring.centerX, 0, ring.centerZ)
    ring.mesh.refreshBoundingInfo()
    ring.built = true
  }

  let activeCount = 0

  function place(focusX: number, focusZ: number, force: boolean): void {
    const count = ringCount(spacing0)
    // A ring that becomes or stops being the outermost changes its edge.
    const countChanged = count !== activeCount
    activeCount = count
    ensureRings(count)
    // Innermost first: a ring's hole follows the ring inside it.
    for (let k = 0; k < rings.length; k++) {
      const ring = rings[k]
      if (k >= count) {
        ring.mesh.setEnabled(false)
        continue
      }
      const s = spacing0 * 2 ** k
      const grid = 2 * s
      const cx = Math.round(focusX / grid) * grid
      const cz = Math.round(focusZ / grid) * grid
      const changed = force || countChanged || !ring.built || ring.spacing !== s || ring.centerX !== cx || ring.centerZ !== cz
      ring.spacing = s
      ring.centerX = cx
      ring.centerZ = cz
      if (changed) build(k)
      else if (k > 0 && (rings[k - 1].centerX !== ring.holeX || rings[k - 1].centerZ !== ring.holeZ)) {
        // Only the inner ring moved: the same ground, the hole cut anew.
        ring.mesh.setIndices(indicesFor(k, ring))
        ring.holeX = rings[k - 1].centerX
        ring.holeZ = rings[k - 1].centerZ
      }
      ring.mesh.setEnabled(enabled)
    }
  }

  let lastFocusX = 0
  let lastFocusZ = 0

  return {
    get meshes() {
      return rings.map((r) => r.mesh)
    },
    update(focusX, focusZ, s0) {
      lastFocusX = focusX
      lastFocusZ = focusZ
      const force = s0 !== spacing0
      spacing0 = s0
      place(focusX, focusZ, force)
    },
    refresh(maxSpacing = Infinity) {
      rings.forEach((ring, k) => {
        if (ring.built && ring.spacing <= maxSpacing) build(k)
      })
    },
    setEnabled(next) {
      enabled = next
      for (const ring of rings) ring.mesh.setEnabled(next && ring.built && ring.spacing > 0)
    },
    setHeightScale(scale) {
      if (scale === heightScale) return
      heightScale = scale
      for (const ring of rings) ring.mesh.scaling.y = scale
      // The normals were taken with the old scale.
      if (spacing0 > 0) place(lastFocusX, lastFocusZ, true)
    },
    dispose() {
      for (const ring of rings) ring.mesh.dispose()
      material.dispose()
    },
  }
}
