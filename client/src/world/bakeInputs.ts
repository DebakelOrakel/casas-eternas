import type { MeshBakeInputs } from '../generator/pipeline/meshBakeStage'
import type { TileBakeInputs } from '../generator/pipeline/meshTileBake'
import type { TileParent } from '../generator/mesh/meshTile'
import type { SavedMesh } from '../generator/mesh/meshSerial'
import type { RiverGraph } from '../generator/surface/riverGraph'
import { meanLandRunoff } from '../generator/surface/hydrology'
import type { WorldInputs } from './save/loadWorldInputs'

// A SAVE'S INPUTS AS A BAKE TAKES THEM — one mapping for the level bake and
// one for the tile bake, used by the job worker and by the mesh harness's
// measure mode. Both used to spell the mapping out, the worker twice; the
// harness then guarded a mapping production did not run (2026-10-01,
// structure review). A coordinator that hands out bakes will take its
// inputs from here too.

// Level 1 from the save's mesh. `mesh` replaces the save's own (the
// harness bakes a mesh it eroded itself); the save must carry one otherwise.
export function levelBakeInputs(inputs: WorldInputs, mesh: SavedMesh | null = inputs.mesh): MeshBakeInputs | null {
  if (!mesh) return null
  return {
    mesh,
    width: inputs.width,
    height: inputs.height,
    detailSeed: inputs.detailSeed,
    lithoSeed: inputs.lithoSeed,
    controls: { alluvium: inputs.erosionControls.alluvium, rockContrast: inputs.erosionControls.rockContrast },
    uplift: inputs.uplift?.data ?? null,
    erodibility: inputs.erodibility?.data ?? null,
    forcingResX: inputs.uplift?.resX ?? 0,
    forcingResY: inputs.uplift?.resY ?? 0,
    precipitation: inputs.climate?.data ?? null,
    temperature: inputs.temperature?.data ?? null,
    monsoonIndex: inputs.biomeInputs?.monsoonIndex.data ?? null,
    climateResX: inputs.climate?.resX ?? 0,
    climateResY: inputs.climate?.resY ?? 0,
  }
}

// One tile on its parent level. The world's mean land water is taken over
// the SAVE's land (its elevation raster): the discharge a river carries into
// the tile is in that unit (meshTileBake.ts).
export function tileBakeInputs(inputs: WorldInputs, parent: TileParent, parentGraph: RiverGraph | null): TileBakeInputs {
  const precipitation = inputs.climate?.data ?? null
  const climateResX = inputs.climate?.resX ?? 0
  const climateResY = inputs.climate?.resY ?? 0
  return {
    parent,
    parentGraph,
    width: inputs.width,
    height: inputs.height,
    detailSeed: inputs.detailSeed,
    lithoSeed: inputs.lithoSeed,
    controls: { alluvium: inputs.erosionControls.alluvium, rockContrast: inputs.erosionControls.rockContrast },
    uplift: inputs.uplift?.data ?? null,
    erodibility: inputs.erodibility?.data ?? null,
    forcingResX: inputs.uplift?.resX ?? 0,
    forcingResY: inputs.uplift?.resY ?? 0,
    precipitation,
    climateResX,
    climateResY,
    meanLandWater: precipitation ? meanLandRunoff(precipitation, inputs.elevations, inputs.width, inputs.height, climateResX, climateResY) : 0,
  }
}
