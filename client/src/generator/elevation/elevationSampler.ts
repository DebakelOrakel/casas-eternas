import { mantleMesh } from '../mantle/mantleField'
import type { Domain } from '../core/domain'
import type { PlateSimulation } from '../tectonics/plateSimulation'
import { dynamicTopographyAt } from './dynamicTopography'
import { buildFeatureBuckets, computeElevation, raftBaselineAt, warpedSamplePoint } from './elevationField'
import { FINE_DETAIL_SEED_SALT, fineDetailNoiseOn, ridgedMultifractalOn } from './ridgedNoise'

// THE SYNTHESIS AT A POINT — the pre-erosion terrain as a function of
// (x, y), the form the adaptive mesh needs ("tectonics evaluates its fields
// on the nodes", decision 3 of docs/decisions/adaptive-mesh.md). Every
// piece was point-evaluable already (design/adaptive-mesh.md: "the
// pre-erosion stages are resolution-independent; the raster is only a
// sampling"): the raft baseline with the domain warp, the dynamic
// topography from the mantle raster, the ridged and fine noise at the
// warped point, and computeElevation over the feature buckets. This is the
// per-cell body of render/elevationRenderWorker.ts and
// render/elevationMapImage.ts, called at one point: a node placed between
// two raster cells gets the ridge that runs between them, not their
// average. The one raster-only step of that path, mountain redistribution,
// is switched off (ACCENTUATE_MOUNTAINS) and would have no point form.
//
// Takes the pieces of a PlateSimulation it reads, so the golden harness can
// hand in a deserialised snapshot as easily as the runtime hands in its live
// sim.
export interface SynthesisSources {
  width: number
  height: number
  domain: Domain
  rafts: PlateSimulation['rafts']
  features: PlateSimulation['features']
  oceanAge: Float32Array
  mantle: Float64Array
  warpSeed: number
  seaLevelOffset: number
}

export interface ElevationSampler {
  heightAt(x: number, y: number): number
}

export function synthesisSampler(s: SynthesisSources): ElevationSampler {
  const { domain, warpSeed } = s
  const buckets = buildFeatureBuckets(s.features, domain)
  const mantleSampler = mantleMesh(domain).sampler
  const fineSeed = (warpSeed ^ FINE_DETAIL_SEED_SALT) >>> 0
  return {
    heightAt(x, y) {
      const baseline = raftBaselineAt(x, y, s.rafts, s.oceanAge, domain, warpSeed, s.seaLevelOffset)
        + dynamicTopographyAt(s.mantle, mantleSampler, x, y)
      const { wx, wy } = warpedSamplePoint(x, y, domain, warpSeed)
      return computeElevation(wx, wy, baseline, buckets, domain,
        ridgedMultifractalOn(domain, wx, wy, warpSeed),
        fineDetailNoiseOn(domain, wx, wy, fineSeed))
    },
  }
}
