import { Color3, DirectionalLight, HemisphericLight, Mesh, MeshBuilder, RawTexture, Scene, StandardMaterial, Vector3, VertexBuffer } from '@babylonjs/core'
import type { AbstractMesh, InstancedMesh } from '@babylonjs/core'
import type { ElevationSurface } from './elevationSurface'
import { HexGridMaterialPlugin } from './hexGridMaterialPlugin'
import { WaterField, WaterMaterialPlugin } from './waterMaterialPlugin'

// Which representation the map should wear this frame — decided by the
// caller (it owns the camera/zoom semantics):
// 'flat' = the plain textured plane; 'coarse' = the half-res displaced
// relief; 'fine' = the full-res displaced relief (built lazily on first
// use — see setReliefSurfaces).
export type MapReliefDetail = 'flat' | 'coarse' | 'fine'

export interface ToroidalMapViewOptions {
  scene: Scene
  worldWidth: number
  worldHeight: number
  textureWidth: number
  textureHeight: number
  // The pan focus in world coords (x, z). Uses the focus rather than raw
  // camera position deliberately: once the camera is tilted its position is
  // offset backward from where the view is actually centered (see
  // generatorCamera's tilt handling), so recentering off raw position would
  // drift.
  getFocus: () => { x: number; z: number }
  // Detail level to show this frame (see MapReliefDetail). Evaluated each
  // frame; relief levels only take effect once surfaces have been supplied.
  // The caller keys this off zoom: at far zoom the displacement is subpixel
  // while its triangle count is at its most multiplied (all 9 wrap copies in
  // frame) — and the fine level is affordable only when the frustum holds
  // one or two wrap copies.
  reliefDetail?: () => MapReliefDetail
  // Camera yaw in radians (0 = north-up). The relief light is CAMERA-
  // relative: it stays top-left in SCREEN space however the view rotates,
  // because hillshade only reads correctly with light from the upper left —
  // world-fixed light would relief-invert (valleys become ridges) at half
  // the yaw range.
  getYaw?: () => number
  // 0..1: how far the sun should blend from camera-relative (0, the map
  // reading above) toward WORLD-fixed (1). Near the ground the view shows
  // silhouettes instead of hillshade — the inversion problem is gone, and a
  // stable world (fixed lit/shadow sides while rotating) is the natural
  // look. The worldmap screen feeds its near-regime blend here.
  getSunWorldBlend?: () => number
  // The 300 m hex grid drawn into the relief material's fragments (see
  // hexGridMaterialPlugin). Spacings must tile the toroidal period exactly
  // (mapSceneSettings' snapped values); strength and the view-distance fade
  // band are polled per frame — the screen keys both off altitude.
  hexGrid?: { spacingX: number; spacingY: number; getStrength: () => number; getFadeDistances: () => { start: number; end: number } }
  // Near-field detail patch (the near regime's answer to the silky 7.8 km
  // ground): one camera-following high-res grid whose heights come from
  // `detailSurface` (the fine sampler — see fineElevationSurface.ts) and
  // blend back into `baseSurface` (the plain raster surface the relief
  // meshes use) toward the patch rim, so the patch rim meets the base mesh
  // instead of cliffing over it. Patch extent scales with altitude, so its
  // resolution sharpens exactly as the camera descends.
  nearDetail?: { detailSurface: ElevationSurface; baseSurface: ElevationSurface; getActive: () => boolean; getAltitude: () => number }
  // Called each frame with the recenter block's center, so a screen can tile
  // extra meshes in lockstep (e.g. the river ribbon overlay).
  onRecenter?: (centerX: number, centerZ: number) => void
}

export interface ToroidalMapView {
  // The map's RGBA texture — update it with composited pixels each frame.
  readonly texture: RawTexture
  // The relief levels' own RGBA texture: the same composite WITHOUT the
  // baked hillshade (flat "paper"), because the relief meshes carry real
  // vertex normals and a real light — feeding them the shaded composite
  // would double-shade every slope. The screen updates it alongside
  // `texture` whenever relief is active.
  readonly reliefTexture: RawTexture
  // Supply (or clear, with null) the relief layers: subdivided copies of the
  // map plane, vertex Y displaced (and normals derived) from the surfaces.
  // `coarse` displaces the half-res mesh (built eagerly — it's the workhorse
  // level); `fine` feeds the full-res mesh, which is only BUILT the first
  // frame the caller actually asks for 'fine' (2M+ vertices — not worth
  // paying for while nobody deep-zooms). Re-call whenever the terrain
  // changes (e.g. after an erosion pass).
  setReliefSurfaces(coarse: ElevationSurface | null, fine?: ElevationSurface | null): void
  // Swap the near-detail patch's surfaces (see options.nearDetail) and force
  // an immediate rebuild — for a screen whose height data is replaced under
  // it, e.g. when the worldmap's amplification bake finishes.
  setNearDetailSurfaces(detail: ElevationSurface, base: ElevationSurface): void
  // Vertical exaggeration, applied as a scale on the relief meshes rather
  // than baked into their heights — so a screen can change it per frame
  // (the worldmap fades it out during the descent) without recomputing any
  // geometry. The surfaces themselves stay metre-true.
  setHeightScale(scale: number): void
  // The hovered hex tile's canonical center (map/hexGrid.ts), or null to
  // clear — forwarded to the grid plugin, which fills that tile on every
  // wrap copy. No-op when the view was built without a hexGrid.
  setHexHighlight(center: { x: number; z: number } | null): void
  // Forward a per-tile class window to the grid plugin (phase 2's debug
  // overlay; see HexGridMaterialPlugin.setClassOverlay for the encoding).
  // null clears it. No-op without a hexGrid.
  setHexClassOverlay(texture: RawTexture | null, window?: { col0: number; row0: number; cols: number; rows: number }): void
  // Standing water drawn at draw time (waterMaterialPlugin.ts): the terrain
  // the shores are found on, at the colour texture's resolution — re-supply
  // whenever the terrain changes.
  setWaterElevation(data: Float32Array, width: number, height: number): void
  // The per-cell level and surface kind from the hydrology
  // (hydrology.waterLevelField), or null for "the sea everywhere".
  setWaterLevels(level: Float32Array | null, surface: Uint8Array | null): void
  // Lakes follow the hydrology toggle; the sea is always drawn.
  setLakesVisible(visible: boolean): void
  // Pick the terrain THIS view renders, restricted to its own surfaces
  // (flat plane, relief levels, near-detail patch) — a plain scene.pick can
  // land on any stray pickable mesh, and any surface that is not the
  // rendered ground answers with a parallax-shifted point. The ray aims at
  // the pixel's CENTER (rasterizers sample fragments there, screen APIs
  // hand out corners); at grazing angles that half pixel is tile-sized on
  // the ground.
  pickGround(screenX: number, screenY: number): { x: number; z: number } | null
  // Hide the NEAR GROUND alone (the detail patch), leaving the relief meshes
  // drawn — a debug instrument, see the panel's
  // own note: two grounds over one another can only be told apart by
  // removing one of them.
  setNearGroundVisible(visible: boolean): void
  // Hide/show the whole map view (all layers).
  setEnabled(enabled: boolean): void
  dispose(): void
}

// WHICH GROUND WINS WHERE THEY OVERLAP.
//
// The relief levels are fixed grids over the whole world — 15.6 km and 7.8 km
// between vertices — and they span that with STRAIGHT triangles, while the
// near-field detail patch samples the same surface every ~200 m. Wherever a
// coarse chord passes above
// the surface it approximates, the near ground is INSIDE the relief mesh and
// its triangles show through as a second, stippled sheet over the terrain.
// Measured on a v8 4K bake (2026-08-15): at 14–17 % of land points on the
// fine level, median 33 m deep, p99 350 m — and worse in mountains, which is
// where it was spotted. The near ground's own anti-z-fight lift is 3.75 m at
// the camera's floor, two orders of magnitude short of covering it.
//
// So the near ground gets its own rendering group. Babylon clears the depth
// buffer between groups, so everything in the near group draws over the
// terrain group unconditionally, and the interpenetration cannot show. The
// assumption that makes this sound is the camera's: the near ground surrounds
// the focus, so nothing in the terrain group is ever BETWEEN the camera and
// it.
//
// THE COST, which is real and belongs next to the fix: the same depth clear
// means the near group has no occlusion against the terrain group at all. The
// river ribbons have to be in the near group — left behind in the terrain
// group, the ground they are draped on would paint over them — and they are
// drawn over the whole known world, so a distant river behind a ridge now
// shows through it. Fog mutes it; it is not free. The alternative, if that
// trade turns out to be the wrong way round, is to make the relief levels
// sit at or below the surface they approximate (displace their vertices from
// a MINIMUM over the raster cells each one stands for, rather than a point
// sample) — no render-order assumption, but it lowers ridges at the coarse
// level, which is a change to the map's own look.
export const NEAR_RENDERING_GROUP = 1

// Relief grid resolutions against the 2048x1024 map raster. Coarse: one
// vertex per two raster cells (~15.6 km spacing) — cheap enough to have
// several wrap copies in frame at mid zoom. Fine: one vertex per raster
// cell — the mesh stops being the blurrier partner of the texture, shown
// only at deep zoom where at most a copy or two is in the frustum. Keep in
// step with RELIEF_DECIMATION and the zoom thresholds beside it
// (mapSceneSettings), which the generator screen reads for the same view.
const COARSE_SUBDIVISIONS_X = 1024
const COARSE_SUBDIVISIONS_Y = 512
const FINE_SUBDIVISIONS_X = 2048
const FINE_SUBDIVISIONS_Y = 1024

// Relief lighting: a screen-top-left sun at ~45° elevation over a soft
// hemispheric fill. Contrasty on purpose (strong sun, low fill) so slopes
// pop, while a flat surface still lands near the flat view's brightness
// (1.0·sin45° + 0.25 ≈ 0.96) — the flat↔relief swap shouldn't read as an
// exposure change.
const SUN_INTENSITY = 1.0
const FILL_INTENSITY = 0.25
const SUN_ELEVATION_RAD = Math.PI / 4

// One displaced relief level: the base mesh + its 8 wrap instances. The
// instances share the displaced geometry, which is exactly right on a torus
// — every copy IS the same world.
interface ReliefLevel {
  base: Mesh
  instances: InstancedMesh[]
  subdivisionsX: number
  subdivisionsY: number
}

// A flat map on a ground plane with visible toroidal wraparound: a static 3x3
// block of plane copies (one real mesh + 8 instances — cheap, they share
// geometry and material) recentered each frame on whichever tile the camera is
// over. Because the camera's position is never wrapped or clamped, this reads
// as a truly infinite, seamlessly wrapping map rather than one that snaps at an
// edge. 3x3 fills the frame across the current zoom range; zooming out far
// enough to see more than one tile of margin would need a bigger block (5x5)
// or a chunked-LOD swap. Reusable by any full-surface map screen (worldgen,
// game). The flat plane is unlit (emissive — a top-down data map, the
// texture's own values are the only thing on screen, hillshade baked in);
// the relief levels are LIT — real normals, unshaded texture, camera-relative
// sun — which is what keeps slopes crisp when the texture itself has run out
// of resolution.
export function createToroidalMapView(options: ToroidalMapViewOptions): ToroidalMapView {
  const { scene, worldWidth, worldHeight, textureWidth, textureHeight, getFocus, reliefDetail, getYaw, getSunWorldBlend, hexGrid, nearDetail, onRecenter } = options

  // Starts as a flat white placeholder (the caller's clear color) until the
  // first composited frame is uploaded, so there's no flash.
  const placeholder = new Uint8Array(textureWidth * textureHeight * 4).fill(255)
  const texture = RawTexture.CreateRGBATexture(placeholder, textureWidth, textureHeight, scene, false, false)
  const material = new StandardMaterial('mapMaterial', scene)
  material.diffuseTexture = texture
  material.specularColor = new Color3(0, 0, 0)
  material.emissiveColor = new Color3(1, 1, 1)
  material.disableLighting = true

  const reliefTexture = RawTexture.CreateRGBATexture(placeholder.slice(), textureWidth, textureHeight, scene, false, false)
  const reliefMaterial = new StandardMaterial('mapReliefMaterial', scene)
  reliefMaterial.diffuseTexture = reliefTexture
  reliefMaterial.specularColor = new Color3(0, 0, 0)
  // The flat plane wears the shaded paper (the screen's composite base), the
  // relief meshes the unshaded one — the water plugin paints in each register.
  const waterField = new WaterField(scene)
  const waterPlugin = new WaterMaterialPlugin(material, 'paper', waterField)
  const reliefWaterPlugin = new WaterMaterialPlugin(reliefMaterial, 'paperUnshaded', waterField)
  let hexGridPlugin: HexGridMaterialPlugin | null = null
  if (hexGrid) {
    hexGridPlugin = new HexGridMaterialPlugin(reliefMaterial)
    hexGridPlugin.configure(hexGrid.spacingX, hexGrid.spacingY, worldWidth, worldHeight)
  }

  // The relief lights touch ONLY the relief meshes (includedOnlyMeshes,
  // maintained as levels are built) — everything else in the scene keeps its
  // unlit-emissive look no matter what lights exist here.
  const sun = new DirectionalLight('mapReliefSun', new Vector3(0.5, -0.7, -0.5), scene)
  sun.intensity = SUN_INTENSITY
  const fill = new HemisphericLight('mapReliefFill', new Vector3(0, 1, 0), scene)
  fill.intensity = FILL_INTENSITY
  fill.groundColor = new Color3(0.3, 0.3, 0.35)
  sun.includedOnlyMeshes = []
  fill.includedOnlyMeshes = []

  const tile = MeshBuilder.CreateGround('mapTile', { width: worldWidth, height: worldHeight, subdivisions: 1 }, scene)
  tile.material = material
  const wrapInstances: InstancedMesh[] = []
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue
      wrapInstances.push(tile.createInstance(`mapTile_${dx}_${dz}`))
    }
  }

  let coarseLevel: ReliefLevel | null = null
  let fineLevel: ReliefLevel | null = null
  let coarseSurface: ElevationSurface | null = null
  let fineSurface: ElevationSurface | null = null
  let enabled = true
  // What each layer's setEnabled was last given, so the per-frame visibility
  // sync only touches meshes on actual changes.
  const shown: Record<'flat' | 'coarse' | 'fine', boolean> = { flat: true, coarse: false, fine: false }

  function buildLevel(name: string, subdivisionsX: number, subdivisionsY: number): ReliefLevel {
    const base = MeshBuilder.CreateGround(name, { width: worldWidth, height: worldHeight, subdivisionsX, subdivisionsY, updatable: true }, scene)
    base.material = reliefMaterial
    base.setEnabled(false)
    sun.includedOnlyMeshes.push(base)
    fill.includedOnlyMeshes.push(base)
    const instances: InstancedMesh[] = []
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        const inst = base.createInstance(`${name}_${dx}_${dz}`)
        inst.setEnabled(false)
        instances.push(inst)
        sun.includedOnlyMeshes.push(inst)
        fill.includedOnlyMeshes.push(inst)
      }
    }
    return { base, instances, subdivisionsX, subdivisionsY }
  }

  // Displace and re-derive normals through each vertex's own UV rather than
  // assuming the ground's grid layout — that reuses the ground's actual UV
  // convention (the same one MapHoverTooltip picks against), so the relief
  // can never be mirrored or offset relative to the texture it wears.
  // Normals come from finite differences of the SAME surface (which wraps
  // toroidally), so lighting is seam-free across the wrap copies — a
  // mesh-based normal pass would shade the tile borders wrong.
  function displaceLevel(level: ReliefLevel, surface: ElevationSurface): void {
    const positions = level.base.getVerticesData(VertexBuffer.PositionKind)!
    const uvs = level.base.getVerticesData(VertexBuffer.UVKind)!
    const normals = level.base.getVerticesData(VertexBuffer.NormalKind)!
    // The ground's uv→world mapping is affine; derive its scales (including
    // signs) from the vertex data itself instead of trusting a convention.
    const u0 = uvs[0]
    const v0 = uvs[1]
    let dxdu = worldWidth
    let dzdv = -worldHeight
    for (let vi = 2, pi = 3; vi < uvs.length; vi += 2, pi += 3) {
      const du = uvs[vi] - u0
      if (Math.abs(du) > 0.5) {
        dxdu = (positions[pi] - positions[0]) / du
        break
      }
    }
    for (let vi = 2, pi = 3; vi < uvs.length; vi += 2, pi += 3) {
      const dv = uvs[vi + 1] - v0
      if (Math.abs(dv) > 0.5) {
        dzdv = (positions[pi + 2] - positions[2]) / dv
        break
      }
    }
    const epsU = 0.5 / level.subdivisionsX
    const epsV = 0.5 / level.subdivisionsY
    for (let vi = 0, pi = 0; vi < uvs.length; vi += 2, pi += 3) {
      const u = uvs[vi]
      const v = uvs[vi + 1]
      positions[pi + 1] = surface.heightAtUV(u, v)
      const dhdx = (surface.heightAtUV(u + epsU, v) - surface.heightAtUV(u - epsU, v)) / (2 * epsU * dxdu)
      const dhdz = (surface.heightAtUV(u, v + epsV) - surface.heightAtUV(u, v - epsV)) / (2 * epsV * dzdv)
      const inv = 1 / Math.hypot(dhdx, 1, dhdz)
      normals[pi] = -dhdx * inv
      normals[pi + 1] = inv
      normals[pi + 2] = -dhdz * inv
    }
    level.base.updateVerticesData(VertexBuffer.PositionKind, positions)
    level.base.updateVerticesData(VertexBuffer.NormalKind, normals)
    // Culling happens per bounding box, and displacement changed it.
    level.base.refreshBoundingInfo()
  }

  function disposeLevel(level: ReliefLevel | null): void {
    if (!level) return
    const levelMeshes = new Set<unknown>([level.base, ...level.instances])
    sun.includedOnlyMeshes = sun.includedOnlyMeshes.filter((m) => !levelMeshes.has(m))
    fill.includedOnlyMeshes = fill.includedOnlyMeshes.filter((m) => !levelMeshes.has(m))
    for (const inst of level.instances) inst.dispose()
    level.base.dispose()
  }

  function setLevelShown(key: 'flat' | 'coarse' | 'fine', level: { setEnabled(b: boolean): void } | null, instances: InstancedMesh[], want: boolean): void {
    if (want === shown[key]) return
    shown[key] = want
    level?.setEnabled(want)
    for (const inst of instances) inst.setEnabled(want)
  }

  function applyVisibility(): void {
    let detail: MapReliefDetail = enabled ? (reliefDetail?.() ?? 'flat') : 'flat'
    if (detail === 'fine' && !fineSurface) detail = 'coarse'
    if (detail !== 'flat' && !coarseSurface) detail = 'flat'
    // Lazy build: the fine level exists from the first frame it's wanted.
    if (detail === 'fine' && fineSurface && !fineLevel) {
      fineLevel = buildLevel('mapReliefFine', FINE_SUBDIVISIONS_X, FINE_SUBDIVISIONS_Y)
      displaceLevel(fineLevel, fineSurface)
      applyHeightScale()
    }
    setLevelShown('flat', tile, wrapInstances, enabled && detail === 'flat')
    setLevelShown('coarse', coarseLevel?.base ?? null, coarseLevel?.instances ?? [], enabled && detail === 'coarse')
    setLevelShown('fine', fineLevel?.base ?? null, fineLevel?.instances ?? [], enabled && detail === 'fine')
  }

  // --- Near-field detail patch (see options.nearDetail) ---
  const PATCH_SUBDIVISIONS = 192
  // Patch width as a multiple of camera altitude — matches the hex grid's
  // near-field disk, so detail exists wherever the grid invites close
  // reading.
  const PATCH_COVERAGE = 16
  let patchMesh: Mesh | null = null
  let patchPositions: Float32Array | null = null
  let patchUvs: Float32Array | null = null
  let patchNormals: Float32Array | null = null
  let patchHeights: Float32Array | null = null
  let patchColors: Float32Array | null = null
  let patchLastCenterX = 0
  let patchLastCenterZ = 0
  let patchLastSpacing = 0
  // Live surfaces for the patch — start at whatever the options carried and
  // can be replaced later (setNearDetailSurfaces).
  let patchDetailSurface: ElevationSurface | null = nearDetail?.detailSurface ?? null
  let patchBaseSurface: ElevationSurface | null = nearDetail?.baseSurface ?? null
  // Vertical exaggeration (see setHeightScale). A scale rather than baked
  // heights, so it can follow the zoom; re-applied whenever a mesh is built.
  let heightScale = 1

  function applyHeightScale(): void {
    for (const level of [coarseLevel, fineLevel]) {
      if (!level) continue
      level.base.scaling.y = heightScale
      for (const inst of level.instances) inst.scaling.y = heightScale
    }
    if (patchMesh) patchMesh.scaling.y = heightScale
  }

  // The ground meshes' own uv↔world mapping (derived from vertex data, same
  // trick as displaceLevel) so the patch samples and textures in exactly
  // the space everything else uses.
  function deriveUvMapping(level: ReliefLevel): { u0: number; x0: number; dxdu: number; v0: number; z0: number; dzdv: number } {
    const positions = level.base.getVerticesData(VertexBuffer.PositionKind)!
    const uvs = level.base.getVerticesData(VertexBuffer.UVKind)!
    let dxdu = worldWidth
    let dzdv = -worldHeight
    for (let vi = 2, pi = 3; vi < uvs.length; vi += 2, pi += 3) {
      const du = uvs[vi] - uvs[0]
      if (Math.abs(du) > 0.5) {
        dxdu = (positions[pi] - positions[0]) / du
        break
      }
    }
    for (let vi = 2, pi = 3; vi < uvs.length; vi += 2, pi += 3) {
      const dv = uvs[vi + 1] - uvs[1]
      if (Math.abs(dv) > 0.5) {
        dzdv = (positions[pi + 2] - positions[2]) / dv
        break
      }
    }
    return { u0: uvs[0], x0: positions[0], dxdu, v0: uvs[1], z0: positions[2], dzdv }
  }

  function rebuildPatch(centerX: number, centerZ: number, spacing: number, altitude: number): void {
    if (!nearDetail || !coarseLevel || !patchMesh || !patchDetailSurface || !patchBaseSurface) return
    const n = PATCH_SUBDIVISIONS + 1
    if (!patchPositions) {
      patchPositions = new Float32Array(n * n * 3)
      patchUvs = new Float32Array(n * n * 2)
      patchNormals = new Float32Array(n * n * 3)
      patchHeights = new Float32Array(n * n)
      patchColors = new Float32Array(n * n * 4)
    }
    const mapping = deriveUvMapping(coarseLevel)
    const half = (spacing * PATCH_SUBDIVISIONS) / 2
    // A whisker of lift over the base mesh where detail and base coincide,
    // scaled with altitude so it stays subpixel — without it the rim area
    // z-fights the relief mesh underneath.
    const lift = altitude * 0.0015
    for (let j = 0; j < n; j++) {
      const lz = j * spacing - half
      const v = mapping.v0 + (centerZ + lz - mapping.z0) / mapping.dzdv
      for (let i = 0; i < n; i++) {
        const lx = i * spacing - half
        const u = mapping.u0 + (centerX + lx - mapping.x0) / mapping.dxdu
        // Blend back into the plain base surface toward the rim.
        const rim = Math.max(Math.abs(lx), Math.abs(lz)) / half
        const edge = rim <= 0.75 ? 0 : Math.min(1, (rim - 0.75) / 0.23)
        const detail = patchDetailSurface.heightAtUV(u, v)
        const base = patchBaseSurface.heightAtUV(u, v)
        const y = detail + (base - detail) * edge + lift * (1 - edge)
        const idx = j * n + i
        patchHeights![idx] = y
        patchPositions![idx * 3] = lx
        patchPositions![idx * 3 + 1] = y
        patchPositions![idx * 3 + 2] = lz
        patchUvs![idx * 2] = u
        patchUvs![idx * 2 + 1] = v
      }
    }
    // Normals + micro-albedo from the height grid (matches the mesh
    // exactly; borders clamp). The vertex color darkens with local slope —
    // rock-shadow reading independent of the light angle, so fine structure
    // stays legible on the near-white paper even where N·L barely varies.
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i
        const hl = patchHeights![j * n + Math.max(0, i - 1)]
        const hr = patchHeights![j * n + Math.min(n - 1, i + 1)]
        const hu = patchHeights![Math.max(0, j - 1) * n + i]
        const hd = patchHeights![Math.min(n - 1, j + 1) * n + i]
        const dhdx = (hr - hl) / (2 * spacing)
        const dhdz = (hd - hu) / (2 * spacing)
        const inv = 1 / Math.hypot(dhdx, 1, dhdz)
        patchNormals![idx * 3] = -dhdx * inv
        patchNormals![idx * 3 + 1] = inv
        patchNormals![idx * 3 + 2] = -dhdz * inv
        const brightness = 1 - Math.min(0.4, Math.hypot(dhdx, dhdz) * 0.8)
        patchColors![idx * 4] = brightness
        patchColors![idx * 4 + 1] = brightness
        patchColors![idx * 4 + 2] = brightness
        patchColors![idx * 4 + 3] = 1
      }
    }
    patchMesh.updateVerticesData(VertexBuffer.PositionKind, patchPositions!)
    patchMesh.updateVerticesData(VertexBuffer.UVKind, patchUvs!)
    patchMesh.updateVerticesData(VertexBuffer.NormalKind, patchNormals!)
    patchMesh.setVerticesData(VertexBuffer.ColorKind, patchColors!, true)
    patchMesh.refreshBoundingInfo()
    patchLastCenterX = centerX
    patchLastCenterZ = centerZ
    patchLastSpacing = spacing
  }

  let nearGroundVisible = true

  function updateNearDetail(focusX: number, focusZ: number): void {
    if (!nearDetail) return
    const active = nearDetail.getActive() && coarseLevel !== null && nearGroundVisible
    if (!active) {
      patchMesh?.setEnabled(false)
      return
    }
    const altitude = nearDetail.getAltitude()
    if (!patchMesh) {
      patchMesh = MeshBuilder.CreateGround('mapNearDetail', { width: 1, height: 1, subdivisions: PATCH_SUBDIVISIONS, updatable: true }, scene)
      patchMesh.material = reliefMaterial
      patchMesh.renderingGroupId = NEAR_RENDERING_GROUP
      patchMesh.scaling.y = heightScale
      sun.includedOnlyMeshes.push(patchMesh)
      fill.includedOnlyMeshes.push(patchMesh)
      patchLastSpacing = 0
    }
    patchMesh.setEnabled(true)
    const spacing = (altitude * PATCH_COVERAGE) / PATCH_SUBDIVISIONS
    const centerX = Math.round(focusX / spacing) * spacing
    const centerZ = Math.round(focusZ / spacing) * spacing
    const moved = Math.hypot(centerX - patchLastCenterX, centerZ - patchLastCenterZ)
    const spacingChanged = patchLastSpacing === 0 || Math.abs(spacing / patchLastSpacing - 1) > 0.15
    // Rebuild only on real movement — the fill is a few ms of CPU, not a
    // per-frame cost.
    if (spacingChanged || moved > spacing * 2) rebuildPatch(centerX, centerZ, spacing, altitude)
    patchMesh.position.set(patchLastCenterX, 0, patchLastCenterZ)
  }

  // Keep the sun top-left in SCREEN space (see getYaw above): rotate the
  // fixed screen-space direction by the camera's yaw each frame. As the
  // world-blend rises the yaw's influence fades out — at 1 the sun is
  // world-fixed at the north-up azimuth, so rotating the view moves around
  // a stable lit world instead of spinning the light along.
  function updateSunDirection(): void {
    const worldBlend = getSunWorldBlend?.() ?? 0
    const yaw = (getYaw?.() ?? 0) * (1 - worldBlend)
    const upX = Math.sin(yaw)
    const upZ = Math.cos(yaw)
    const rightX = Math.cos(yaw)
    const rightZ = -Math.sin(yaw)
    const invSqrt2 = Math.SQRT1_2
    const horizontal = Math.cos(SUN_ELEVATION_RAD)
    sun.direction.set(
      (rightX - upX) * invSqrt2 * horizontal,
      -Math.sin(SUN_ELEVATION_RAD),
      (rightZ - upZ) * invSqrt2 * horizontal,
    )
  }

  // Stated rather than inherited: clearing depth between rendering groups IS
  // Babylon's default, but it is the entire mechanism the near group rests on,
  // and a default relied upon silently is a default someone changes.
  scene.setRenderingAutoClearDepthStencil(NEAR_RENDERING_GROUP, true, true, false)

  const observer = scene.onBeforeRenderObservable.add(() => {
    const focus = getFocus()
    const centerX = Math.round(focus.x / worldWidth) * worldWidth
    const centerZ = Math.round(focus.z / worldHeight) * worldHeight
    tile.position.set(centerX, 0, centerZ)
    coarseLevel?.base.position.set(centerX, 0, centerZ)
    fineLevel?.base.position.set(centerX, 0, centerZ)
    let i = 0
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        wrapInstances[i].position.set(centerX + dx * worldWidth, 0, centerZ + dz * worldHeight)
        coarseLevel?.instances[i].position.set(centerX + dx * worldWidth, 0, centerZ + dz * worldHeight)
        fineLevel?.instances[i].position.set(centerX + dx * worldWidth, 0, centerZ + dz * worldHeight)
        i++
      }
    }
    applyVisibility()
    if (shown.coarse || shown.fine) updateSunDirection()
    if (hexGrid && hexGridPlugin) {
      hexGridPlugin.setStrength(shown.coarse || shown.fine ? hexGrid.getStrength() : 0)
      const fade = hexGrid.getFadeDistances()
      hexGridPlugin.setFade(fade.start, fade.end)
    }
    updateNearDetail(focus.x, focus.z)
    onRecenter?.(centerX, centerZ)
  })

  return {
    texture,
    reliefTexture,
    setReliefSurfaces(coarse: ElevationSurface | null, fine: ElevationSurface | null = null): void {
      coarseSurface = coarse
      fineSurface = fine
      if (!coarse) {
        disposeLevel(coarseLevel)
        disposeLevel(fineLevel)
        coarseLevel = null
        fineLevel = null
        shown.coarse = false
        shown.fine = false
        applyVisibility()
        return
      }
      if (!coarseLevel) coarseLevel = buildLevel('mapRelief', COARSE_SUBDIVISIONS_X, COARSE_SUBDIVISIONS_Y)
      displaceLevel(coarseLevel, coarse)
      applyHeightScale()
      // The fine level re-displaces in place if it's already built; otherwise
      // it stays unbuilt until applyVisibility first wants it.
      if (fineLevel) {
        if (fine) displaceLevel(fineLevel, fine)
        else {
          disposeLevel(fineLevel)
          fineLevel = null
          shown.fine = false
        }
      }
      applyVisibility()
    },
    setNearDetailSurfaces(detail: ElevationSurface, base: ElevationSurface): void {
      patchDetailSurface = detail
      patchBaseSurface = base
      patchLastSpacing = 0 // force a rebuild on the next frame
    },
    setHeightScale(scale: number): void {
      if (scale === heightScale) return
      heightScale = scale
      applyHeightScale()
    },
    setHexHighlight(center: { x: number; z: number } | null): void {
      hexGridPlugin?.setHighlight(center)
    },
    setHexClassOverlay(texture: RawTexture | null, window?: { col0: number; row0: number; cols: number; rows: number }): void {
      hexGridPlugin?.setClassOverlay(texture, window)
    },
    setWaterElevation(data: Float32Array, width: number, height: number): void {
      waterField.setElevation(data, width, height)
    },
    setWaterLevels(level: Float32Array | null, surface: Uint8Array | null): void {
      waterField.setLevels(level, surface)
    },
    setLakesVisible(visible: boolean): void {
      waterPlugin.setLakesVisible(visible)
      reliefWaterPlugin.setLakesVisible(visible)
    },
    pickGround(screenX: number, screenY: number): { x: number; z: number } | null {
      const isGround = (mesh: AbstractMesh): boolean => {
        // A custom predicate REPLACES scene.pick's default enabled/visible
        // filter rather than adding to it — without this check the ray also
        // tests the HIDDEN levels, and the coarse mesh deviates from the
        // shown fine one by tens of metres on relief (it sits above it on
        // ridges), so picks land beside the surface the user actually sees.
        // Zero on flat ground, which is what made it look knowledge-related.
        if (!mesh.isEnabled() || !mesh.isVisible) return false
        if (mesh === tile || (patchMesh !== null && mesh === patchMesh)) return true
        if (wrapInstances.includes(mesh as InstancedMesh)) return true
        const inLevel = (level: ReliefLevel | null): boolean =>
          level !== null && (mesh === level.base || level.instances.includes(mesh as InstancedMesh))
        return inLevel(coarseLevel) || inLevel(fineLevel)
      }
      const pick = scene.pick(screenX + 0.5, screenY + 0.5, isGround)
      const point = pick?.hit ? pick.pickedPoint : null
      return point ? { x: point.x, z: point.z } : null
    },
    setNearGroundVisible(visible: boolean): void {
      nearGroundVisible = visible
      if (!visible) patchMesh?.setEnabled(false)
    },
    setEnabled(next: boolean): void {
      enabled = next
      applyVisibility()
    },
    dispose(): void {
      scene.onBeforeRenderObservable.remove(observer)
      patchMesh?.dispose()
      disposeLevel(coarseLevel)
      disposeLevel(fineLevel)
      for (const inst of wrapInstances) inst.dispose()
      tile.dispose()
      waterField.dispose()
      material.dispose()
      texture.dispose()
      reliefMaterial.dispose()
      reliefTexture.dispose()
      sun.dispose()
      fill.dispose()
    },
  }
}
