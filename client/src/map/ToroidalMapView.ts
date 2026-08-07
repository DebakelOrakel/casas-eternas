import { Color3, DirectionalLight, HemisphericLight, MeshBuilder, RawTexture, Scene, StandardMaterial, Vector3, VertexBuffer } from '@babylonjs/core'
import type { InstancedMesh, Mesh } from '@babylonjs/core'
import type { ElevationSurface } from './elevationSurface'
import { HexGridMaterialPlugin } from './hexGridMaterialPlugin'

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
  // worldgenCamera's tilt handling), so recentering off raw position would
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
  // Hide/show the whole map view (all layers).
  setEnabled(enabled: boolean): void
  dispose(): void
}

// Relief grid resolutions against the 2048x1024 map raster. Coarse: one
// vertex per two raster cells (~15.6 km spacing) — cheap enough to have
// several wrap copies in frame at mid zoom. Fine: one vertex per raster
// cell — the mesh stops being the blurrier partner of the texture, shown
// only at deep zoom where at most a copy or two is in the frustum. Keep in
// step with WorldGenScreen's RELIEF_DECIMATION / zoom thresholds.
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
  let hexGridPlugin: HexGridMaterialPlugin | null = null
  if (hexGrid) {
    hexGridPlugin = new HexGridMaterialPlugin(reliefMaterial)
    hexGridPlugin.configure(hexGrid.spacingX, hexGrid.spacingY)
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

  function updateNearDetail(focusX: number, focusZ: number): void {
    if (!nearDetail) return
    const active = nearDetail.getActive() && coarseLevel !== null
    if (!active) {
      patchMesh?.setEnabled(false)
      return
    }
    if (!patchMesh) {
      patchMesh = MeshBuilder.CreateGround('mapNearDetail', { width: 1, height: 1, subdivisions: PATCH_SUBDIVISIONS, updatable: true }, scene)
      patchMesh.material = reliefMaterial
      patchMesh.scaling.y = heightScale
      sun.includedOnlyMeshes.push(patchMesh)
      fill.includedOnlyMeshes.push(patchMesh)
      patchLastSpacing = 0
    }
    patchMesh.setEnabled(true)
    const altitude = nearDetail.getAltitude()
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
      material.dispose()
      texture.dispose()
      reliefMaterial.dispose()
      reliefTexture.dispose()
      sun.dispose()
      fill.dispose()
    },
  }
}
