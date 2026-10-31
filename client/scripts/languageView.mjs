// Data check for THE LANGUAGES PANEL's view (TEG-140): what the panel shows
// is derived right, without a browser.
//
//   npm run harness:languages
//
// 1. The adapter (screens/incubator/languageView.ts) on a peoples' tree of
//    the history's shape (historyPack.ts PeoplesTree) and its log, through
//    the stub engine: at every kept state the speakers of the families
//    together are the people of the peoples; a family's are its languages';
//    a dialect dies out exactly at its people's end in the log
//    (peopleGone, peopleMerged, peopleReplaced), and a language or a family
//    when the last of its dialects does. The tree is made here, seeded: a
//    real one needs a world and a history run (minutes), and the
//    derivation reads only the tree's arrays.
// 2. The fixture (scripts/fixtures): it loads as a view, and its numbers
//    add up as the adapter's do.
// 3. The window set (ui/windows/windowSet.ts): one window at a time, and
//    the screen's furniture called as before the set existed.
// 4. The catalog: one `language.meaning.<id>` for every meaning of the
//    language kit, and no other.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const M = {
  view: await L('/src/screens/incubator/languageView.ts'),
  fixture: await L('/scripts/fixtures/fixtureView.ts'),
  windows: await L('/src/ui/windows/windowSet.ts'),
  types: await L('/src/ui/languagePanel/languageTypes.ts'),
}

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok    ${name}`)
  else { failures++; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`) }
}
const near = (a, b) => Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a), Math.abs(b))

// --- 1. the adapter on a tree of the history's shape ------------------------

// A seeded draw (mulberry32).
function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A history: three groups' peoples over the kept states, splitting, merging,
// replaced, gone; small peoples among them. Returns the tree (CSR as
// pack.rs), its log, its start and end.
function makeHistory(seed) {
  const draw = random(seed)
  const start = 21_000
  const end = 51_300
  const times = M.view.keptTimes(start, end)
  const peoples = []
  const log = []
  const born = (parent, group, at, big) => {
    peoples.push({ parent, group, born: at, ended: Infinity, mergedInto: -1, big, rows: [], alive: true, count: 500 + draw() * 5000 })
    return peoples.length - 1
  }
  for (let g = 0; g < 3; g++) born(-1, g, start, 1)
  for (let k = 0; k < times.length; k++) {
    const living = peoples.map((p, id) => ({ p, id })).filter((x) => x.p.alive)
    for (const { p } of living) {
      p.count *= 1 + draw() * 0.3
      p.rows.push({ frame: k, people: Math.round(p.count), km2: p.count / 3, centre: Math.floor(draw() * 9000) })
    }
    if (k === times.length - 1) break
    // Between this state and the next.
    const at = (f) => times[k] + f * (times[k + 1] - times[k])
    for (const { p, id } of living) {
      const r = draw()
      if (r < 0.3) {
        const child = born(id, p.group, times[k + 1], draw() < 0.6 ? 1 : 0)
        if (peoples[child].big && p.big) log.push({ kind: 'peopleSplit', at: at(0.3), cell: 0, people: id, new: child, count: 1, km2: 1 })
      } else if (r < 0.42) {
        const others = living.filter((x) => x.id !== id && x.p.alive)
        const kind = r < 0.35 ? 'peopleGone' : r < 0.39 ? 'peopleMerged' : 'peopleReplaced'
        if (kind !== 'peopleGone' && others.length === 0) continue
        const into = kind === 'peopleGone' ? -1 : others[Math.floor(draw() * others.length)].id
        p.alive = false
        p.ended = times[k + 1]
        p.mergedInto = into
        if (into >= 0) peoples[into].count += p.count
        const when = at(0.1 + 0.8 * draw())
        if (p.big) log.push(kind === 'peopleGone' ? { kind, at: when, cell: 0, people: id, count: 1, km2: 1 } : { kind, at: when, cell: 0, people: id, into, count: 1, km2: 1 })
      }
    }
  }
  const n = peoples.length
  const frameStart = new Int32Array(n + 1)
  peoples.forEach((p, i) => (frameStart[i + 1] = frameStart[i] + p.rows.length))
  const rows = peoples.flatMap((p) => p.rows)
  const tree = {
    parent: Int32Array.from(peoples, (p) => p.parent),
    group: Int32Array.from(peoples, (p) => p.group),
    born: Float32Array.from(peoples, (p) => p.born),
    ended: Float32Array.from(peoples, (p) => p.ended),
    mergedInto: Int32Array.from(peoples, (p) => p.mergedInto),
    big: Uint8Array.from(peoples, (p) => p.big),
    frameStart,
    frame: Uint16Array.from(rows, (r) => r.frame),
    people: Float32Array.from(rows, (r) => r.people),
    km2: Float32Array.from(rows, (r) => r.km2),
    farmers: new Uint8Array(rows.length),
    centre: Int32Array.from(rows, (r) => r.centre),
  }
  log.sort((a, b) => a.at - b.at)
  return { tree, log, start, end }
}

console.log('1. the adapter (languageView.ts, stub engine)')
for (const seed of [1, 7, 2840]) {
  const history = makeHistory(seed)
  const { tree, log } = history
  const view = M.view.deriveLanguageView(history, M.view.stubLanguageEngine)
  const byId = new Map(view.nodes.map((n) => [n.id, n]))
  const ofLevel = (level) => view.nodes.filter((n) => n.level === level)
  const families = ofLevel('family')
  const peopleCount = tree.parent.length
  const bigCount = tree.big.reduce((s, b) => s + b, 0)
  console.log(`  seed ${seed}: ${peopleCount} peoples (${bigCount} big), ${log.length} log events, ${view.times.length} kept states, ${families.length} families, ${ofLevel('language').length} languages, ${ofLevel('dialect').length} dialects`)

  // The speakers add up to the people, state by state.
  let worst = ''
  for (let k = 0; k < view.times.length; k++) {
    let people = 0
    for (let r = 0; r < tree.frame.length; r++) if (tree.frame[r] === k) people += tree.people[r]
    const speakers = families.reduce((s, f) => s + f.speakers[k], 0)
    if (!near(people, speakers) && !worst) worst = `state ${k}: people ${people}, speakers ${speakers}`
  }
  check(`seed ${seed}: the families' speakers are the peoples' people at every kept state`, worst === '', worst)
  let parts = ''
  for (const node of view.nodes) {
    if (node.level === 'dialect') continue
    const below = view.nodes.filter((c) => c.parent === node.id)
    if (node.level === 'family') {
      for (let k = 0; k < view.times.length; k++) {
        const sum = below.reduce((s, c) => s + c.speakers[k], 0)
        if (!near(sum, node.speakers[k]) && !parts) parts = `${node.id} at ${k}: ${node.speakers[k]} vs ${sum}`
      }
    } else {
      for (let k = 0; k < view.times.length; k++) {
        const sum = below.reduce((s, c) => s + c.speakers[k], 0)
        if (sum > node.speakers[k] * (1 + 1e-5) + 1e-3 && !parts) parts = `${node.id} at ${k}: dialects ${sum} over ${node.speakers[k]}`
      }
    }
  }
  check(`seed ${seed}: a family's speakers are its languages', a language's at least its dialects'`, parts === '', parts)

  // The dialects die out at their people's end in the log, and only there.
  const ends = new Map()
  for (const e of log) if (e.kind === 'peopleGone' || e.kind === 'peopleMerged' || e.kind === 'peopleReplaced') ends.set(e.people, e.at)
  let wrong = ''
  let told = 0
  for (let p = 0; p < peopleCount; p++) {
    if (!tree.big[p]) continue
    const dialect = ofLevel('dialect').find((d) => d.peoples.length === 1 && d.peoples[0] === p && d.id === `d${p}`)
    if (!dialect) { wrong ||= `people ${p}: no dialect`; continue }
    const end = ends.get(p) ?? null
    if (end !== null) told++
    if (dialect.ended !== end) wrong ||= `people ${p}: † ${dialect.ended}, its end ${end}`
  }
  check(`seed ${seed}: each big people's dialect ends exactly at its end event (${told} told)`, wrong === '' && told > 0, wrong)
  let above = ''
  for (const node of view.nodes) {
    if (node.level === 'dialect') continue
    const dialects = []
    const walk = (id) => { for (const c of view.nodes) if (c.parent === id) { if (c.level === 'dialect') dialects.push(c); walk(c.id) } }
    walk(node.id)
    const expect = dialects.length > 0 && dialects.every((d) => d.ended !== null) ? Math.max(...dialects.map((d) => d.ended)) : null
    if (node.ended !== expect) above ||= `${node.id}: † ${node.ended}, expected ${expect}`
  }
  check(`seed ${seed}: a language and a family end with the last of their dialects`, above === '', above)
  check(`seed ${seed}: every big people speaks one dialect and is counted in its family`, families.reduce((s, f) => s + f.peoples.length, 0) === bigCount)
  check(`seed ${seed}: each node is born by its first people`, view.nodes.every((n) => n.parent === null || n.born >= byId.get(n.parent).born))
  const centre = M.view.peopleCentre(tree, families[0].peoples, view.times.length - 1)
  check(`seed ${seed}: a family's centre is one of its peoples' hearts`, families[0].peoples.length === 0 || tree.centre.includes(centre))
}

// --- 2. the fixture ----------------------------------------------------------

console.log('2. the fixture (scripts/fixtures/languages.json)')
const fixture = await M.fixture.loadFixtureView()
const level = (l) => fixture.nodes.filter((n) => n.level === l)
const languages = level('language').filter((n) => !n.proto)
console.log(`  ${level('family').length} families, ${languages.length} languages, ${level('dialect').length} dialects, ${fixture.times.length} times`)
check('the fixture has the boards\' 4 families and 17 languages', level('family').length === 4 && languages.length === 17)
check('the fixture has some 200 dialects', Math.abs(level('dialect').length - 198) <= 10)
check('its times rise', fixture.times.every((t, k) => k === 0 || t > fixture.times[k - 1]))
let sums = ''
for (const node of fixture.nodes) {
  const below = fixture.nodes.filter((c) => c.parent === node.id)
  if (below.length === 0) continue
  for (let k = 0; k < fixture.times.length; k++) {
    const sum = below.reduce((s, c) => s + c.speakers[k], 0)
    if (!near(sum, node.speakers[k])) sums ||= `${node.id} at ${k}: ${node.speakers[k]} vs ${sum}`
  }
}
check('its speakers add up from the dialects to the families', sums === '', sums)
check('every speaker count is a list as long as the times', fixture.nodes.every((n) => n.speakers.length === fixture.times.length))
const keldisch = languages.find((n) => n.name === 'Keldisch')
check('Keldisch has a detail, 4 dialects, 9 peoples', !!keldisch && fixture.detail(keldisch.id) !== null && level('dialect').filter((d) => d.parent === keldisch.id).length === 4 && keldisch.peoples.length === 9)
const sample = M.types.sampleAt(fixture.times, 1e9)
check('the time after the last sample reads the last sample', sample === fixture.times.length - 1)

// --- 3. the window set -------------------------------------------------------

console.log('3. the window set (ui/windows/windowSet.ts)')
const calls = []
const fake = (name) => {
  let open = false
  return { name, open: () => { open = true; calls.push(`open ${name}`) }, close: () => { open = false; calls.push(`close ${name}`) }, isOpen: () => open }
}
const [a, b, c] = [fake('a'), fake('b'), fake('c')]
const windows = M.windows.createWindowSet([a, b, c], { beforeOpen: () => calls.push('before'), afterClose: () => calls.push('after') })
windows.open(a)
windows.open(a)
windows.open(b)
windows.close(a)
windows.close(b)
check('one window at a time; the furniture away before one opens and back when the last closes', calls.join(', ') === 'before, open a, close a, after, before, open b, close b, after', calls.join(', '))
check('none open at the end', !windows.anyOpen())

// --- 4. the catalog ------------------------------------------------------------

console.log('4. the catalog (language.meaning.*)')
const kit = JSON.parse(readFileSync(`${CLIENT}/../engine/crates/casas-incubator/data/language/meanings.json`, 'utf8')).meanings.map((m) => m.id)
for (const locale of ['en', 'de']) {
  const catalog = JSON.parse(readFileSync(`${CLIENT}/src/i18n/locales/${locale}/language.json`, 'utf8'))
  const keys = Object.keys(catalog).filter((k) => k.startsWith('language.meaning.')).map((k) => k.slice('language.meaning.'.length))
  check(`${locale}: one meaning key for each of the kit's ${kit.length} meanings, no other`, keys.length === kit.length && kit.every((id) => keys.includes(id)))
}

await server.close()
if (failures > 0) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
