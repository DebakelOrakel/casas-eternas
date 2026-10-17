import type { MeshBakeInputs } from '../generator/pipeline/meshBakeStage'
import type { TileBakeInputs, UpstreamTile } from '../generator/pipeline/meshTileBake'
import type { TileParent } from '../generator/mesh/meshTile'
import type { SavedMesh } from '../generator/mesh/meshSerial'
import type { RiverGraph } from '../generator/surface/riverGraph'
import { climateCellsFromSaved, meanLandRunoff } from '../generator/climate/climatePoints'
import { domainOfKind } from '../generator/core/domain'
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
    climate: inputs.climate,
  }
}

// One tile on its parent level. The world's mean land water is taken over
// the save's climate's land (climatePoints.meanLandRunoff): the discharge a
// river carries into the tile is in that unit (meshTileBake.ts).
export function tileBakeInputs(inputs: WorldInputs, parent: TileParent, parentGraph: RiverGraph | null, upstream: UpstreamTile[]): TileBakeInputs {
  return {
    parent,
    parentGraph,
    upstream,
    width: inputs.width,
    height: inputs.height,
    detailSeed: inputs.detailSeed,
    lithoSeed: inputs.lithoSeed,
    controls: { alluvium: inputs.erosionControls.alluvium, rockContrast: inputs.erosionControls.rockContrast },
    uplift: inputs.uplift?.data ?? null,
    erodibility: inputs.erodibility?.data ?? null,
    forcingResX: inputs.uplift?.resX ?? 0,
    forcingResY: inputs.uplift?.resY ?? 0,
    climate: inputs.climate,
    meanLandWater: inputs.climate ? meanLandRunoff(climateCellsFromSaved(domainOfKind(inputs.kind === 'SphereWorld' ? 'sphere' : 'torus', inputs.width, inputs.height), inputs.climate)) : 0,
  }
}
