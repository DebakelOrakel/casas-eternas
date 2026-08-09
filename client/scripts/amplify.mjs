// Regression checks for the AMPLIFICATION BAKE — `runAmplification`, the pipeline
// that turns a saved macro raster into 4K or 8K terrain.
//
//   npm run harness:amplify              run every layer
//   npm run harness:amplify hash-record  freeze the byte baseline (the refactor guard)
//
// WHY THIS EXISTS. Until now the bake's terrain was covered by nothing at all,
// and both other harnesses say so in their own headers: golden guards the
// GENERATOR's fields and never calls this pipeline; roundtrip guards the save
// format. What is guarded is the artifact KEY — that every constant listed in
// AMPLIFY_CONSTANTS moves the pipeline version — which catches a retuned
// constant and is blind to everything else. A changed loop, a reordered pass, a
// different clamp: all of them alter the bytes under a key that claims to
// describe the old ones, and every cached 4K and 8K artifact on every machine
// and on the server then serves terrain nobody asked for.
//
// It is also step one of splitting the bake across machines
// (docs/design/splitting-the-bake.md). A decomposed bake that produces ALMOST
// the same field is precisely the failure nobody sees, so the whole plan rests
// on being able to say "these two bakes are the same bytes". This is the half of
// that comparison which can exist today.
//
// Three layers, the same shape golden settled on and for the same reasons:
//
//   1. INVARIANTS   things that must hold of any bake, ever. No baseline, so a
//                   failure is always a bug rather than a stale file.
//   2. DETERMINISM  one bake run twice in one process, hashed against itself.
//                   A property of the code, needing no stored file — and the
//                   thing the artifact cache depends on absolutely, since two
//                   machines baking one world must agree byte for byte.
//   3. BYTE HASHES  opt-in and temporary, for a refactor that must change
//                   nothing. Delete the baseline file to end the layer.
//
// Small on purpose: a 256x128 macro at factor 2 is 512x256, which exercises
// every stage in seconds. This is not a measurement of world quality — that is
// golden's job on the real grid — it is a check that the pipeline still does
// what it did.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const HASHES = fileURLToPath(new URL('./amplify-hashes.json', import.meta.url))
const MODE = process.argv[2] ?? 'check'

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)

const M = {
  amplify: await L('/src/worldgen/surface/runAmplification.ts'),
  scale: await L('/src/worldgen/elevation/elevationScale.ts'),
  plan: await L('/src/worldgen/surface/bakePlan.ts'),
}

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const MACRO_W = 256
const MACRO_H = 128
const FACTOR = 2

// A macro world with continents, coasts, a shelf and deep ocean — deterministic,
// and not a real generator run: this pipeline takes an elevation raster and does
// not care where it came from, so synthesising one keeps the check independent
// of everything golden already covers.
function macroWorld() {
  const { SEA_LEVEL, LAND_BASE, SHELF_BREAK, ABYSSAL_FLOOR } = M.scale
  const elevation = new Float32Array(MACRO_W * MACRO_H)
  for (let y = 0; y < MACRO_H; y++) {
    for (let x = 0; x < MACRO_W; x++) {
      const u = (x / MACRO_W) * Math.PI * 2
      const v = (y / MACRO_H) * Math.PI * 2
      // Two continent-sized bumps plus a mountain range, so there is real
      // relief to erode and a coastline for the marine deposition to work at.
      const continents = Math.sin(u * 1.5) * Math.cos(v) + 0.6 * Math.sin(u * 3 + 1) * Math.sin(v * 2)
      const range = 0.5 * Math.exp(-((y - MACRO_H * 0.4) ** 2) / 200) * Math.max(0, Math.sin(u * 2))
      const height = continents * 0.5 + range
      elevation[y * MACRO_W + x] = height > 0
        ? SEA_LEVEL + LAND_BASE * height * 3
        : SEA_LEVEL + Math.max(ABYSSAL_FLOOR, SHELF_BREAK + height * 2)
    }
  }
  return elevation
}

// Precipitation on the climate grid, wet enough everywhere that rivers form.
function precipitation(resX, resY) {
  const field = new Float32Array(resX * resY)
  for (let y = 0; y < resY; y++) {
    for (let x = 0; x < resX; x++) {
      field[y * resX + x] = 800 + 400 * Math.sin((x / resX) * Math.PI * 2)
    }
  }
  return field
}

// A world that genuinely WRAPS, for the one check that needs it. Integer
// harmonics only, so the field is continuous across both seams — which is what
// makes a catchment straddle x = 0 and a toroidal bounding box mean something.
// Deliberately not the shared macroWorld: see the check that uses it.
function wrappingWorld() {
  const { SEA_LEVEL, LAND_BASE, SHELF_BREAK, ABYSSAL_FLOOR } = M.scale
  const elevation = new Float32Array(MACRO_W * MACRO_H)
  for (let y = 0; y < MACRO_H; y++) {
    for (let x = 0; x < MACRO_W; x++) {
      const u = (x / MACRO_W) * Math.PI * 2
      const v = (y / MACRO_H) * Math.PI * 2
      // A single continent centred on x = 0, so the seam runs through its middle
      // rather than round its edge.
      const height = 0.9 * Math.cos(u) * Math.cos(v) + 0.35 * Math.cos(u * 2) * Math.sin(v * 3) - 0.1
      elevation[y * MACRO_W + x] = height > 0
        ? SEA_LEVEL + LAND_BASE * height * 3
        : SEA_LEVEL + Math.max(ABYSSAL_FLOOR, SHELF_BREAK + height * 2)
    }
  }
  return elevation
}

const CLIMATE_RES_X = 64
const CLIMATE_RES_Y = 32

async function bake(seed = 12345) {
  return M.amplify.runAmplification({
    elevation: macroWorld(),
    macroWidth: MACRO_W,
    macroHeight: MACRO_H,
    factor: FACTOR,
    seed,
    erosionRounds: 2,
    erosionStrength: 1,
    drainageRefresh: 1,
    precipitation: precipitation(CLIMATE_RES_X, CLIMATE_RES_Y),
    climateResX: CLIMATE_RES_X,
    climateResY: CLIMATE_RES_Y,
    riverDensity: 55,
  })
}

const hash = (array) => createHash('sha256').update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)).digest('hex').slice(0, 16)

// The stages a refactor could move, named individually so a failure says WHICH.
const fingerprints = (result) => ({
  elevation: hash(result.elevation),
  riverPoints: hash(result.rivers.points),
  riverLengths: hash(result.rivers.lengths),
})

console.log('')
const started = Date.now()
const result = await bake()

// --- 1. invariants -----------------------------------------------------------
console.log('— invariants')
{
  const { SEA_LEVEL } = M.scale
  const field = result.elevation
  check('the bake is the size it was asked for', result.width === MACRO_W * FACTOR && result.height === MACRO_H * FACTOR,
    `${result.width}x${result.height}`)

  let nonFinite = 0
  for (let i = 0; i < field.length; i++) if (!Number.isFinite(field[i])) nonFinite++
  check('every cell is a finite number', nonFinite === 0, `${nonFinite} are not`)

  let land = 0
  for (let i = 0; i < field.length; i++) if (field[i] > SEA_LEVEL) land++
  const landFraction = land / field.length
  check('there is a world here, not all sea or all rock', landFraction > 0.05 && landFraction < 0.8,
    `${(landFraction * 100).toFixed(1)}% land`)

  check('rivers were extracted', result.rivers.lengths.length > 0,
    `${result.rivers.lengths.length} polylines, ${result.rivers.points.length / 3} vertices`)

  // The point buffer is [x, y, widthPx] per vertex, read against the length
  // table; a mismatch draws rivers through the wrong vertices rather than
  // failing. The detail printed is the two MEASURED numbers, not the product
  // being compared — a first version printed the product, so a wrong factor in
  // the assertion looked like a discrepancy in the data.
  let vertices = 0
  for (const length of result.rivers.lengths) vertices += length
  check('the point buffer holds three values per vertex', vertices * 3 === result.rivers.points.length,
    `${vertices} vertices, ${result.rivers.points.length} floats`)

  // RULE 4, the one this whole layer exists for: amplification may REFINE the
  // macro shape and must not contradict it
  // (docs/decisions/worldmap-amplification.md). The seeded field is the ceiling
  // erosion carves into, so the bake must stay at or below it — with one
  // measured exception.
  //
  // THE EXCEPTION, measured 2026-08-09 rather than assumed: deposition on land
  // fills valley floors, and 3% of cells end up above the seeded field by up to
  // ~42 m on a 9000 m scale. None of them are below sea level, so this is
  // alluvium and not the delta mechanism. That is refinement — a filled valley
  // floor is what alluvium IS — and it means runAmplification's own comment
  // ("never past it") is stronger than the code.
  //
  // So the invariant is a BOUND rather than zero: a bake may fill, and may not
  // invent terrain the macro does not have. The numbers below are the measured
  // ones with room, so a runaway shows up and normal fill does not.
  const ceiling = await M.amplify.runAmplification({
    elevation: macroWorld(), macroWidth: MACRO_W, macroHeight: MACRO_H,
    factor: FACTOR, seed: 12345, erosionRounds: 0,
  })
  let above = 0
  let worst = 0
  let worstBelowSea = 0
  for (let i = 0; i < field.length; i++) {
    const over = field[i] - ceiling.elevation[i]
    if (over <= 1e-6) continue
    above++
    if (over > worst) worst = over
    if (field[i] <= SEA_LEVEL && over > worstBelowSea) worstBelowSea = over
  }
  const overM = (v) => v * 9000
  check('nothing rises far above the macro ceiling', overM(worst) < 150,
    `worst ${overM(worst).toFixed(1)} m over, on ${((above / field.length) * 100).toFixed(2)}% of cells`)
  check('filling stays a minority of the map', above / field.length < 0.1,
    `${((above / field.length) * 100).toFixed(2)}%`)
  // Deltas are the one mechanism meant to raise sea floor, and they are capped
  // by a depth-graded freeboard — so this stays small even when it is not zero.
  check('nothing below sea level rises far', overM(worstBelowSea) < 150, `${overM(worstBelowSea).toFixed(1)} m`)
}

// --- 1b. the bake plan -------------------------------------------------------
//
// `planBake` is the cut a split bake is made along
// (docs/design/splitting-the-bake.md, step 2), and the property it must have is
// the one its name claims: a PARTITION. Every land cell in exactly one job, no
// job holding a cell twice, ocean in none. Get that wrong in either direction
// and the failure is invisible in a rendered map — a cell in two jobs is eroded
// twice and a cell in none keeps its seeded height, and both look like terrain.
console.log('\n— the bake plan')
{
  const { SEA_LEVEL } = M.scale
  const elevation = macroWorld()
  const precip = precipitation(CLIMATE_RES_X, CLIMATE_RES_Y)
  const args = {
    elevation, width: MACRO_W, height: MACRO_H,
    precipitation: precip, climateResX: CLIMATE_RES_X, climateResY: CLIMATE_RES_Y,
  }
  let land = 0
  for (let i = 0; i < elevation.length; i++) if (elevation[i] > SEA_LEVEL) land++

  // A budget that forces several jobs, because a plan of one is a partition
  // trivially and would prove nothing about the packing.
  const budgetCells = Math.ceil(land / 6)
  const plan = await M.plan.planBake({ ...args, budgetCells })

  check('the plan splits the world into jobs', plan.groups.length > 1, `${plan.groups.length} jobs, ${land} land cells`)

  const owner = new Int32Array(65536).fill(-1)
  let claimedTwice = 0
  plan.groups.forEach((group, g) => {
    for (const label of group.catchments) {
      if (owner[label] >= 0) claimedTwice++
      owner[label] = g
    }
  })
  check('no catchment is in two jobs', claimedTwice === 0, `${claimedTwice} are`)

  let unowned = 0
  let oceanLabelled = 0
  let counted = 0
  const perGroup = new Uint32Array(plan.groups.length)
  for (let i = 0; i < elevation.length; i++) {
    const label = plan.labels[i]
    if (elevation[i] <= SEA_LEVEL) {
      if (label !== M.plan.NO_CATCHMENT) oceanLabelled++
      continue
    }
    const g = owner[label]
    if (g < 0) { unowned++; continue }
    perGroup[g]++
    counted++
  }
  check('every land cell belongs to a job', unowned === 0, `${unowned} do not`)
  check('no ocean cell carries a catchment', oceanLabelled === 0, `${oceanLabelled} do`)
  check('the jobs together cover the land exactly once', counted === land, `${counted} of ${land}`)

  const mismatched = plan.groups.filter((group, g) => group.cells !== perGroup[g])
  check('each job knows its own size', mismatched.length === 0, `${mismatched.length} disagree with the raster`)

  // Deterministic, and not incidentally: the packing decides which bytes each
  // job writes, so a plan that depended on iteration order would make the bake
  // depend on it too — the one thing the artifact cache cannot survive.
  const again = await M.plan.planBake({ ...args, budgetCells })
  const shape = (p) => JSON.stringify(p.groups)
  check('the same world plans the same way twice', shape(plan) === shape(again))

  // The two scalars every job is handed, so nobody derives a different river
  // density from their own slice.
  check('the world-wide thresholds are real numbers', plan.maxDischarge > 0 && plan.meanRunoff > 0,
    `maxDischarge ${plan.maxDischarge.toFixed(0)}, meanRunoff ${plan.meanRunoff.toFixed(1)}`)

  // Merging small catchments is what keeps the job count sane; the budget is the
  // only thing stopping it, so a job may exceed it only by being ONE catchment
  // that is itself too big. Measured on a real world: the largest catchment is
  // 4.9% of land, so this is not expected to fire at all.
  const oversized = plan.groups.filter((g) => g.cells > budgetCells && g.catchments.length > 1)
  check('no job is over budget through packing', oversized.length === 0, `${oversized.length} are`)

  // The box is a diagnostic (see BakeJobGroup), and the only way to get it wrong
  // is the toroidal one: a min/max box round a catchment straddling the seam
  // grows to the whole world. So it is checked as containment — on a DIFFERENT
  // world, for a reason worth writing down.
  //
  // `macroWorld` does not wrap. Its `sin(u * 1.5)` is one and a half cycles
  // across the map, so the field jumps at x = 0 and no catchment ever crosses
  // it — a naive min/max span passes every check above. Verified by writing one
  // and watching it stay green. That makes the shared world unable to see this
  // class of bug at all, so the check brings its own world rather than the
  // shared one being changed, which would move every number and hash already
  // recorded against it.
  const wrapped = await M.plan.planBake({ ...args, elevation: wrappingWorld(), budgetCells })
  let outside = 0
  let crossing = 0
  const inSpan = (v, start, len, size) => len === size || (v - start + size) % size < len
  const wrapOwner = new Int32Array(65536).fill(-1)
  wrapped.groups.forEach((group, g) => { for (const label of group.catchments) wrapOwner[label] = g })
  for (const group of wrapped.groups) if (group.box.x + group.box.w > MACRO_W) crossing++
  const wrappedElevation = wrappingWorld()
  for (let y = 0; y < MACRO_H; y++) {
    for (let x = 0; x < MACRO_W; x++) {
      const i = y * MACRO_W + x
      if (wrappedElevation[i] <= SEA_LEVEL) continue
      const g = wrapOwner[wrapped.labels[i]]
      if (g < 0) continue
      const box = wrapped.groups[g].box
      if (!inSpan(x, box.x, box.w, MACRO_W) || !inSpan(y, box.y, box.h, MACRO_H)) outside++
    }
  }
  // This line is the one that catches the bug, and containment is not — verified
  // by replacing the wrapping span with a min/max one: a box that has grown to
  // the whole world CONTAINS everything, so the check below stayed green while
  // this one went to 0 of 5. Containment proves the box is not too small;
  // nothing but this proves it is not uselessly large.
  check('the seam world actually has a job crossing the seam', crossing > 0, `${crossing} of ${wrapped.groups.length}`)
  check('every job box contains that job, wrapping included', outside === 0, `${outside} cells outside`)
}

// --- 2. determinism ----------------------------------------------------------
console.log('\n— determinism')
{
  const again = await bake()
  const first = fingerprints(result)
  const second = fingerprints(again)
  const moved = Object.keys(first).filter((k) => first[k] !== second[k])
  // The artifact cache rests on this completely: two machines baking one world
  // must produce the same bytes, or they file them under one key and disagree.
  check('the same world bakes to the same bytes twice', moved.length === 0, moved.join(', '))

  const other = await bake(999)
  check('a different seed bakes differently', fingerprints(other).elevation !== first.elevation)
}

// --- 3. byte hashes, opt-in --------------------------------------------------
console.log('\n— byte hashes (refactor guard)')
{
  const current = fingerprints(result)
  if (MODE === 'hash-record') {
    writeFileSync(HASHES, `${JSON.stringify(current, null, 2)}\n`)
    console.log(`  recorded ${Object.keys(current).length} stage hashes -> ${HASHES}`)
    console.log('  refactor now; delete the file when you are done.')
  } else if (!existsSync(HASHES)) {
    console.log('  not armed (no amplify-hashes.json). `npm run harness:amplify hash-record` before a refactor.')
  } else {
    const baseline = JSON.parse(readFileSync(HASHES, 'utf8'))
    const moved = Object.keys(current).filter((k) => baseline[k] !== current[k])
    for (const key of moved) console.log(`  MOVED ${key}  ${baseline[key]} -> ${current[key]}`)
    check('every stage is byte-identical to the baseline', moved.length === 0,
      moved.length ? 'a refactor should move nothing; re-record on purpose or delete the file' : '')
  }
}

await server.close()
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed, ${Math.round((Date.now() - started) / 1000)}s`)
process.exit(failures === 0 ? 0 : 1)
