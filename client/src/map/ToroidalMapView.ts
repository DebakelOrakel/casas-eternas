import { Color3, MeshBuilder, RawTexture, Scene, StandardMaterial } from '@babylonjs/core'
import type { InstancedMesh } from '@babylonjs/core'

export interface ToroidalMapViewOptions {
  scene: Scene
  worldWidth: number
  worldHeight: number
  textureWidth: number
  textureHeight: number
  // The pan focus in world coords (x, z). Uses the focus rather than raw
  // camera position deliberately: once the camera is tilted its position is
  // offset backward from where the view is actually centered (see
  // hexMapCamera's setTilt), so recentering off raw position would drift.
  getFocus: () => { x: number; z: number }
  // Called each frame with the recenter block's center, so a screen can tile
  // extra meshes in lockstep (e.g. a temporary debug relief mesh).
  onRecenter?: (centerX: number, centerZ: number) => void
}

export interface ToroidalMapView {
  // The map's RGBA texture — update it with composited pixels each frame.
  readonly texture: RawTexture
  // Hide/show the flat map plane (e.g. while a 3D preview replaces it).
  setEnabled(enabled: boolean): void
  dispose(): void
}

// A flat map on a ground plane with visible toroidal wraparound: a static 3x3
// block of plane copies (one real mesh + 8 instances — cheap, they share
// geometry and material) recentered each frame on whichever tile the camera is
// over. Because the camera's position is never wrapped or clamped, this reads
// as a truly infinite, seamlessly wrapping map rather than one that snaps at an
// edge. 3x3 fills the frame across the current zoom range; zooming out far
// enough to see more than one tile of margin would need a bigger block (5x5)
// or a chunked-LOD swap. Reusable by any full-surface map screen (worldgen,
// game). Flat, unlit (emissive): a top-down data map, the texture's own values
// are the only thing on screen.
export function createToroidalMapView(options: ToroidalMapViewOptions): ToroidalMapView {
  const { scene, worldWidth, worldHeight, textureWidth, textureHeight, getFocus, onRecenter } = options

  // Starts as a flat white placeholder (the caller's clear color) until the
  // first composited frame is uploaded, so there's no flash.
  const placeholder = new Uint8Array(textureWidth * textureHeight * 4).fill(255)
  const texture = RawTexture.CreateRGBATexture(placeholder, textureWidth, textureHeight, scene, false, false)
  const material = new StandardMaterial('mapMaterial', scene)
  material.diffuseTexture = texture
  material.specularColor = new Color3(0, 0, 0)
  material.emissiveColor = new Color3(1, 1, 1)
  material.disableLighting = true

  const tile = MeshBuilder.CreateGround('mapTile', { width: worldWidth, height: worldHeight, subdivisions: 1 }, scene)
  tile.material = material
  const wrapInstances: InstancedMesh[] = []
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue
      wrapInstances.push(tile.createInstance(`mapTile_${dx}_${dz}`))
    }
  }

  const observer = scene.onBeforeRenderObservable.add(() => {
    const focus = getFocus()
    const centerX = Math.round(focus.x / worldWidth) * worldWidth
    const centerZ = Math.round(focus.z / worldHeight) * worldHeight
    tile.position.set(centerX, 0, centerZ)
    let i = 0
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        wrapInstances[i].position.set(centerX + dx * worldWidth, 0, centerZ + dz * worldHeight)
        i++
      }
    }
    onRecenter?.(centerX, centerZ)
  })

  return {
    texture,
    setEnabled(enabled: boolean): void {
      tile.setEnabled(enabled)
      for (const inst of wrapInstances) inst.setEnabled(enabled)
    },
    dispose(): void {
      scene.onBeforeRenderObservable.remove(observer)
      for (const inst of wrapInstances) inst.dispose()
      tile.dispose()
      material.dispose()
      texture.dispose()
    },
  }
}
