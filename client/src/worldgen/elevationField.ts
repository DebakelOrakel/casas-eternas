import { Vector3 } from '@babylonjs/core'
import { warpPoint } from './coastlineNoise'
import { buildTerrainFeatureIndex, elevationAt, type CrustState } from './crust'
import { pointForCell } from './grid'
import { nearestPlateIndex, type PlateWorld } from './plates'

// Factored out of texture.ts's own per-texel loop (which used to compute
// this and throw it away, keeping only the derived color) so both the
// color texture and the erosion grid sample the same underlying field
// through one implementation instead of two. Resolution-agnostic — the
// continuous elevationAt field it samples doesn't care how many texels
// you ask for, so this is called at both the 1024x512 texture resolution
// and the 2048x1024 erosion grid resolution.
export interface ElevationField {
  width: number
  height: number
  elevations: Float32Array
  isContinental: Uint8Array
}

export function generateElevationField(world: PlateWorld, crust: CrustState, width: number, height: number): ElevationField {
  const featureIndex = buildTerrainFeatureIndex(crust.terrainFeatures)
  const texelCount = width * height
  const elevations = new Float32Array(texelCount)
  const isContinental = new Uint8Array(texelCount)
  const point = Vector3.Zero()
  const warpedPoint = Vector3.Zero()

  for (let y = 0; y < height; y++) {
    const rowBase = y * width
    for (let x = 0; x < width; x++) {
      pointForCell(x, y, width, height, point)
      // Domain-warp before every lookup — without this, plate/elevation
      // assignment (and therefore the coastline itself) comes straight
      // from the raw Voronoi partition, a straight-edge look. See
      // coastlineNoise.ts for why.
      warpPoint(point, crust.coastlineNoise, warpedPoint)

      const plateIndex = nearestPlateIndex(warpedPoint, world)
      const index = rowBase + x
      elevations[index] = elevationAt(warpedPoint, world.types[plateIndex], world.ids[plateIndex], crust, featureIndex)
      isContinental[index] = world.types[plateIndex] === 'continental' ? 1 : 0
    }
  }

  return { width, height, elevations, isContinental }
}
