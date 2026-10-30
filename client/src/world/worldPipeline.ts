import { meshPipelineVersion } from './meshArtifacts'
import { readRecipeValue } from './save/recipeYaml'

// THE PIPELINE A WORLD IS MADE BY (2026-10-17): the mesh pipeline's
// version of level 1 (meshArtifacts.meshPipelineVersion), the one the
// binary reports (`casas-eternas version`). It holds the tuning the
// history's runs read (worldTuning.ts) and AMPLIFICATION_ALGO_VERSION, the
// number bumped by hand on a change to what the code computes. world.yaml
// records it as `status.pipeline`; a world is made again from its history
// (level 1's replay in the job worker, a load in the generator) only by the
// pipeline it records. A world whose runs were made by two pipelines
// records none: no pipeline makes it again.
//
// It replaced a hash of every source file under src/generator, which a
// comment, a performance change or a file the replay never runs moved —
// and made every world "made by other code".

export const WORLD_PIPELINE = meshPipelineVersion(1)

// What the worlds before `status.pipeline` record instead: a hash of the
// generator's source files per run (`history.*.code`). The ones made by the
// frozen engine (since 2026-10-15) are this pipeline — the file hash of the
// freeze, and of the freeze plus files the replay does not run (the cube
// atlas, 2026-10-17).
const PIPELINE_OF_CODE: Readonly<Record<string, string>> = {
  '54ee802771966159': 'v11-1b1f7f4a8b14250e',
  '9ac556ec02db1fff': 'v11-1b1f7f4a8b14250e',
}

// Pipelines that make the same worlds as a later one, by the later one:
// v11 and v12 differ in where code runs, not in a byte of a world or an
// artifact (2026-10-22, docs/decisions/rust-engine.md fork 7b: a level,
// tiles, the tile plan of a real world compared byte for byte), so a world
// v11 made is v12's to refine. v12 and v13 make the same worlds; v13
// derives level 1's waters from the save's climate (docs/decisions/
// level-waters.md), so their levels differ, each under its own version.
// v15 makes other worlds than v14: an epoch with coarse land remeshes
// (DES-0027 entry 19, 2026-10-29), the plates move otherwise (entries
// 4, 2 and 27, the same day), the land stands at other heights (entries
// 18, 9 and 26, 2026-10-30), the climate is warmer at the poles and
// wetter on the coastal slopes (entries 14 and 13, the same day) and the
// ice cuts by its basal stress and below the sea (entry 17, the same
// day), besides level 1's other ecology fields.
// Not a migration: a statement of equality of the worlds. Each entry
// names the current pipeline, not the next one: the lookup is one step.
const SAME_WORLDS_AS: Readonly<Record<string, string>> = {
  'v11-1b1f7f4a8b14250e': 'v13-53fe6efa9b110bf0',
  'v12-53fe6efa9b110bf0': 'v13-53fe6efa9b110bf0',
}

// The pipeline a world.yaml records: `status.pipeline`, or for a world
// before it the pipeline its runs' code names (all the same), or '' for
// none — runs of two pipelines, a code no pipeline is known for, no run.
// A pipeline that makes the same worlds as a later one reads as that one.
export function recordedPipeline(yaml: string): string {
  return sameWorldsPipeline(statedOrCoded(yaml))
}

// A stated pipeline (`status.pipeline`, as a world list mirrors it) as the
// pipeline that makes its worlds: the later one for one that makes the same
// worlds as a later one (SAME_WORLDS_AS).
export function sameWorldsPipeline(pipeline: string): string {
  return SAME_WORLDS_AS[pipeline] ?? pipeline
}

function statedOrCoded(yaml: string): string {
  const stated = readRecipeValue(yaml, 'status.pipeline')
  if (stated !== undefined) return stated
  const codes = new Set<string>()
  for (const name of ['genesis', 'tectonics']) {
    for (let index = 0; readRecipeValue(yaml, `history.${name}.${index}.epochs`) !== undefined; index++) {
      codes.add(readRecipeValue(yaml, `history.${name}.${index}.code`) ?? '')
    }
  }
  if (codes.size !== 1) return ''
  return PIPELINE_OF_CODE[[...codes][0]] ?? ''
}
