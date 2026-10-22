import { TILE_SPECS } from '../generator/mesh/meshTile'
import { meshPipelineVersion } from './meshArtifacts'
import { meshTilePipelineVersion } from './meshTileArtifacts'

// WHICH LEVEL AN ARTIFACT IS, AND WHETHER IT IS CURRENT — one answer for the
// screens that ask (the finishing step, the artifact window, the incubator).
// Each of them used to read the stage name and pick the pipeline version
// itself, with its own rule: a literal 'L1', a prefix 'L2:', a level number
// mapped to a tile version (2026-10-01, structure review).
//
// The stage grammar is the one the producers write (meshLevelStage,
// meshTileStage, the jobs module's StageName): `L<level>` for a whole level,
// `L<level>:<x>,<y>` for one tile of it. Not in meshArtifacts: the job worker
// bundles that module, and this one is the readers'.

export interface ParsedStage {
  level: number
  // The tile, for a tile's stage; null for a whole level.
  tile: { x: number; y: number } | null
}

export function parseStage(stage: string): ParsedStage | null {
  const match = /^L(\d+)(?::(\d+),(\d+))?$/.exec(stage)
  if (!match) return null
  return { level: Number(match[1]), tile: match[2] === undefined ? null : { x: Number(match[2]), y: Number(match[3]) } }
}

// THE VERSIONS OF ANOTHER PIPELINE (docs/decisions/engine-releases.md): a
// world made by another pipeline is refined by that pipeline's workers, and
// its levels are stored under that pipeline's versions. This client cannot
// compute them; the release's pipeline.json states them (jobClient
// .pipelineVersionsOf). Its level 1 and its tile levels only: the levels a
// job makes.
export interface PipelineVersions {
  pipelineVersion: string
  tilePipelineVersions: Record<string, string>
}

// The pipeline version this client writes and reads a stage under, or null
// for a stage it does not make: tiles exist on the levels with a TileSpec, whole levels
// on every other. With `versions`, the version of that pipeline instead.
export function currentPipelineVersion(stage: string, versions?: PipelineVersions): string | null {
  const parsed = parseStage(stage)
  return parsed ? levelPipelineVersion(parsed.level, parsed.tile !== null, versions) : null
}

// The same for a level: its tiles' version, or the whole level's.
export function levelPipelineVersion(level: number, tiles: boolean, versions?: PipelineVersions): string | null {
  if (versions) return tiles ? versions.tilePipelineVersions[level] ?? null : level === 1 ? versions.pipelineVersion : null
  if (tiles) return TILE_SPECS[level] ? meshTilePipelineVersion(level) : null
  return meshPipelineVersion(level)
}

// Whether an artifact is current for this client: made under the pipeline
// version it reads its stage with and, when the terrain is given, from that
// terrain. `worldId` null asks the pipeline alone. With `versions`, current
// for that pipeline instead.
export function isCurrentArtifact(artifact: { stage: string; pipelineVersion: string; worldId: string }, worldId: string | null = null, versions?: PipelineVersions): boolean {
  return artifact.pipelineVersion === currentPipelineVersion(artifact.stage, versions) && (worldId === null || artifact.worldId === worldId)
}
