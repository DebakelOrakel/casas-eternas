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

// The pipeline a world.yaml records: `status.pipeline`, or for a world
// before it the pipeline its runs' code names (all the same), or '' for
// none — runs of two pipelines, a code no pipeline is known for, no run.
export function recordedPipeline(yaml: string): string {
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
