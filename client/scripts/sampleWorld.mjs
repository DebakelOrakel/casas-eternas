// The Planet step's SAMPLE WORLDS, baked from a save — what the step shows its
// controls on before a world exists (generator/planet/sampleWorld.ts is the
// fallback when a file is missing or does not load).
//
//   node scripts/sampleWorld.mjs [save folder] [name]
//                                  defaults: ~/Downloads/Astrakan, astrakan
//
// Reads the save's elevation raster, box-downsamples it to half the map
// (1024×512: 1 MB instead of 4, and at 2× upsampling a preview cannot tell),
// encodes it with the sample world's u16 (worldLayers.ELEVATION_ENCODING) and writes
// public/sample/<name>-elevation.u16. The screen decodes it with the same
// layer spec and the worker resamples it to the map — no second codec, no
// header: the size is a constant the screen and this script share.
// A SphereWorld's save has the same raster layout (the 2:1 chart), so the
// same steps bake it; the screen fetches that file for sphere worlds only.
//
// Astrakan (astrakan, the flat worlds' sample): seed 985192350, saved 2026-09-27.
// Pyrrhen (pyrrhen, the sphere worlds' sample): seed 692978684.
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const M = {
  field: await L('/src/generator/core/field.ts'),
  layers: await L('/src/world/save/worldLayers.ts'),
  record: await L('/src/world/worldRecord.ts'),
}

const folder = process.argv[2] ?? join(homedir(), 'Downloads', 'Astrakan')
const name = process.argv[3] ?? 'astrakan'
const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'))
const layer = manifest.layers.find((l) => l.name === 'elevation' && l.kind === 'raster')
const width = layer.resX ?? manifest.world.width
const height = layer.resY ?? manifest.world.height
// The shape, from world.yaml (the manifest does not say it): printed, so
// a sphere world baked under a flat name shows.
const yaml = join(folder, 'world.yaml')
const kind = existsSync(yaml) ? M.record.worldKindOf(readFileSync(yaml, 'utf8')) ?? 'unknown kind' : 'no world.yaml'
const raw = readFileSync(join(folder, layer.file))
const elevation = new Float32Array(raw.buffer, raw.byteOffset, width * height)

const outW = width / 2
const outH = height / 2
const half = M.field.downsampleBox(elevation, width, height, outW, outH)
const spec = M.layers.ELEVATION_ENCODING
const bytes = M.layers.bakeLayer(half, spec)
const out = join(CLIENT, 'public', 'sample', `${name}-elevation.u16`)
mkdirSync(join(CLIENT, 'public', 'sample'), { recursive: true })
writeFileSync(out, new Uint8Array(bytes))
console.log(`${kind} ${manifest.world.width}×${manifest.world.height} → ${outW}×${outH} ${spec.dtype}, ${(bytes.byteLength / 1e6).toFixed(2)} MB → ${out}`)
await server.close()
