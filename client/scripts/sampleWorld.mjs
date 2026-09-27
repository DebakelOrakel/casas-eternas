// The Planet step's SAMPLE WORLD, baked from a save — what the step shows its
// controls on before a world exists (generator/planet/sampleWorld.ts is the
// fallback when this file is missing or does not load).
//
//   node scripts/sampleWorld.mjs [save folder]     default: ~/Downloads/Astrakan
//
// Reads the save's elevation raster, box-downsamples it to half the map
// (1024×512: 1 MB instead of 4, and at 2× upsampling a preview cannot tell),
// encodes it as the bake artifacts store elevation (u16, world/artifacts.ts) and writes
// public/sample/astrakan-elevation.u16. The screen decodes it with the same
// layer spec and the worker resamples it to the map — no second codec, no
// header: the size is a constant the screen and this script share.
//
// Astrakan: seed 985192350, saved 2026-09-27.
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const M = {
  field: await L('/src/generator/core/field.ts'),
  layers: await L('/src/world/save/worldLayers.ts'),
  artifacts: await L('/src/world/artifacts.ts'),
}

const folder = process.argv[2] ?? join(homedir(), 'Downloads', 'Astrakan')
const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'))
const layer = manifest.layers.find((l) => l.name === 'elevation' && l.kind === 'raster')
const width = layer.resX ?? manifest.world.width
const height = layer.resY ?? manifest.world.height
const raw = readFileSync(join(folder, layer.file))
const elevation = new Float32Array(raw.buffer, raw.byteOffset, width * height)

const outW = width / 2
const outH = height / 2
const half = M.field.downsampleBox(elevation, width, height, outW, outH)
const spec = M.artifacts.ELEVATION_ENCODING
const bytes = M.layers.bakeLayer(half, spec)
const out = join(CLIENT, 'public', 'sample', 'astrakan-elevation.u16')
mkdirSync(join(CLIENT, 'public', 'sample'), { recursive: true })
writeFileSync(out, new Uint8Array(bytes))
console.log(`${manifest.world.width}×${manifest.world.height} → ${outW}×${outH} ${spec.dtype}, ${(bytes.byteLength / 1e6).toFixed(2)} MB → ${out}`)
await server.close()
