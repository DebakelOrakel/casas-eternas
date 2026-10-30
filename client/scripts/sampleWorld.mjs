// The Planet step's SAMPLE WORLDS, baked from a save — what the step shows its
// controls on before a world exists (generator/planet/sampleWorld.ts is the
// fallback when a file is missing or does not load).
//
//   node scripts/sampleWorld.mjs [save .zip or unpacked folder] [name]
//                                  defaults: ~/Downloads/Astrakan, astrakan
//
// Opens the save through world/query.ts, the reader every consumer uses: the
// save holds no raster since DEC-0036's save step, so the elevation is the
// terrain mesh's rasterisation (meshRaster.rasteriseNodeField — the raster the
// generator draws from it after every epoch). Box-downsamples it to half the
// map (1024×512: 1 MB instead of 4, and at 2× upsampling a preview cannot
// tell), encodes it with the sample world's u16 (worldLayers.ELEVATION_ENCODING)
// and writes public/sample/<name>-elevation.u16. The screen decodes it with the
// same encoding and the worker resamples it to the map — no second codec, no
// header: the size is a constant the screen and this script share.
// A SphereWorld's chart has the same layout (2:1), so the same steps bake
// it; the screen fetches that file for sphere worlds only.
//
// Astrakan (astrakan, the flat worlds' sample): seed 985192350, saved 2026-09-27.
// Pyrrhen (pyrrhen, the sphere worlds' sample): seed 692978684.
// (Both were baked from saves with an elevation raster; a save of today's
// format makes the same file from its mesh.)
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
// The engine's WASM build, as the browser loads it: the world layer reads
// a save's forcing through it (DEC-0044, fork 7b).
const ENGINE = await import(`${CLIENT}/../engine/dist/wasm/casas-generator.js`)
await ENGINE.default({ module_or_path: await (await import('node:fs/promises')).readFile(`${CLIENT}/../engine/dist/wasm/casas-generator_bg.wasm`) })
const M = {
  field: await L('/src/generator/core/field.ts'),
  layers: await L('/src/world/save/worldLayers.ts'),
  query: await L('/src/world/query.ts'),
}
const JSZip = (await import(`${CLIENT}/node_modules/jszip/dist/jszip.min.js`)).default

const source = process.argv[2] ?? join(homedir(), 'Downloads', 'Astrakan')
const name = process.argv[3] ?? 'astrakan'
// A folder (an unpacked save) is zipped in memory: one reader for both.
async function archiveOf(path) {
  if (!statSync(path).isDirectory()) return readFileSync(path)
  const zip = new JSZip()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else zip.file(relative(path, full), readFileSync(full))
    }
  }
  walk(path)
  return zip.generateAsync({ type: 'uint8array' })
}
const world = await M.query.openWorld(await archiveOf(source), ENGINE)
if (!world) throw new Error(`${source}: not a world this build opens (a save from before the save held no raster is refused)`)
const elevation = (await world.acquire('elevation')).data
const { width, height } = world

const outW = width / 2
const outH = height / 2
const half = M.field.downsampleBox(elevation, width, height, outW, outH)
const spec = M.layers.ELEVATION_ENCODING
const bytes = M.layers.bakeLayer(half, spec)
const out = join(CLIENT, 'public', 'sample', `${name}-elevation.u16`)
mkdirSync(join(CLIENT, 'public', 'sample'), { recursive: true })
writeFileSync(out, new Uint8Array(bytes))
console.log(`${width}×${height} → ${outW}×${outH} ${spec.dtype}, ${(bytes.byteLength / 1e6).toFixed(2)} MB → ${out}`)
await server.close()
