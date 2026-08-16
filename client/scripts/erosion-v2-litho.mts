// Bake the erosion-v2 prototype's lithology field to a .f32 file — the
// threading spike (erosion-v2-spike.mjs) is plain JS because worker_threads
// cannot load the repo's TS, so its one TS dependency (fineDetailNoise) is
// baked out here once per resolution. Same constants as the spike's P.
//   npx tsx scripts/erosion-v2-litho.mts <res> <outFile>
import { writeFileSync } from 'node:fs'
import { fineDetailNoise } from '../src/worldgen/elevation/ridgedNoise'

const RES_X = Number(process.argv[2])
const RES_Y = RES_X / 2
const out = process.argv[3]
const lithoSigma = 1.4
const lithoSeed = 0x51702e77

const litho = new Float32Array(RES_X * RES_Y)
for (let y = 0; y < RES_Y; y++) {
  for (let x = 0; x < RES_X; x++) {
    const n = fineDetailNoise((x * 512) / RES_X, (y * 256) / RES_Y, 512, 256, lithoSeed)
    litho[y * RES_X + x] = Math.exp(lithoSigma * n)
  }
}
writeFileSync(out, Buffer.from(litho.buffer))
console.log(`${out}: ${RES_X}×${RES_Y}`)
