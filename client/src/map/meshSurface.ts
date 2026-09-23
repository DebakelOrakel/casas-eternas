import type { MeshSampler } from '../generator/mesh/meshSampler'
import type { ElevationSurface } from './elevationSurface'
import { MAP_WORLD_WIDTH } from './mapSceneSettings'
import { ELEVATION_METERS } from '../generator/elevation/elevationScale'
import { METERS_PER_CELL } from '../generator/core/mapConfig'

// The terrain surface read from the MESH (decision 7 of
// docs/decisions/adaptive-mesh.md): the same ElevationSurface contract the
// relief levels and the ribbons drape on, with no raster in between. The
// mesh sampler is one of the generator's pure field functions, which is
// what the map→generator edge admits.
//
// UV → world: texel px of the map texture shows the field at world x = px
// (the synthesis convention, see mesh/meshRaster.ts), so the texel's
// centre u = (px + ½) / width maps to world x = u·width − ½ — the same
// half-texel step createElevationSurface takes on a raster, for the same
// reason: the geometry has to sit under the pixel that paints it.
//
// The gradient is the sampler's own normal, metre-true, turned into scene
// units — which is what lets the relief's lighting carry the mesh's ridges
// while its vertices stand a raster cell apart.
export function createMeshSurface(sampler: MeshSampler, heightScale: number, clampAtSeaLevel = true): ElevationSurface {
  const { width, height } = sampler.mesh.domain
  const normal = new Float64Array(3)
  // Scene units per metre, from THIS domain's width across the map's
  // period (mapSceneSettings.UNITS_PER_METER assumes the world raster's;
  // a harness world is smaller).
  const unitsPerMeter = MAP_WORLD_WIDTH / (width * METERS_PER_CELL)
  return {
    heightAtUV(u, v) {
      const h = sampler.heightAt(u * width - 0.5, v * height - 0.5)
      return (clampAtSeaLevel ? Math.max(0, h) : h) * heightScale
    },
    gradientAtUV(u, v, out) {
      const x = u * width - 0.5
      const y = v * height - 0.5
      if (clampAtSeaLevel && sampler.heightAt(x, y) <= 0) {
        out[0] = 0
        out[1] = 0
        return
      }
      sampler.normalAt(x, y, normal)
      // A unit normal (nx, ny, nz) in metres means dh/dx = −nx/ny; the
      // scene scales height and horizontal alike (metre-true), except for
      // the surface's own height scale against the metre.
      const scale = (heightScale / ELEVATION_METERS) / unitsPerMeter
      out[0] = normal[1] > 1e-9 ? (-normal[0] / normal[1]) * scale : 0
      out[1] = normal[1] > 1e-9 ? (-normal[2] / normal[1]) * scale : 0
    },
  }
}
