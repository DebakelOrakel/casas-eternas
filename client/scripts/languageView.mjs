// Data check for THE LANGUAGES PANEL's view (TEG-140): what the panel shows
// is derived right, without a browser.
//
//   npm run harness:languages
//
// 1. The adapter (screens/incubator/languageView.ts) on a peoples' tree of
//    the history's shape (historyPack.ts PeoplesTree) and its log, with the
//    languages' tree the crate makes of it (casas-incubator languages.rs,
//    through its WASM build: TEG-138): at every kept state the speakers of
//    the families together are the people of the peoples; a family's are
//    its languages' and its proto-language's; a language has none before
//    it arose; a dialect dies out exactly at its people's end in the log
//    (peopleGone, peopleMerged, peopleReplaced), a language at its
//    languageGone, a family and its proto-language at its familyGone. The
//    peoples are made here, seeded: a real tree needs a world and a
//    history run (minutes), and the languages read only the tree's
//    arrays. Needs `make engine` (engine/dist/incubator).
// 2. The fixture (scripts/fixtures): it loads as a view, and its numbers
//    add up as the adapter's do.
// 3. The window set (ui/windows/windowSet.ts): one window at a time, and
//    the screen's furniture called as before the set existed.
// 4. The catalog: one `language.meaning.<id>` for every meaning of the
//    language kit, and no other.
// 5. The names (TEG-139, the crate's place_names.rs): on the trees of 1.,
//    a village for each people at a year of its life and some rivers,
//    mountains, lakes and landmasses: every village has a name; the native
//    build (engine/dist/casas-incubator.node) gives the WASM's names, bit
//    for bit; the view lists each name under its namer and the nodes above
//    it, by the time; the search finds a name.
// 6. The other names (TEG-142, TEG-143, the crate's name_contact.rs): on
//    the places of 5., a third taken by a people of another family that
//    holds them to the end, and some pairs of peoples of two families in
//    contact: the taken places keep their name as a loan or
//    are renamed, the peoples in contact name each other's places; the
//    native build gives the WASM's, bit for bit; every loan is in its
//    borrower's sounds of its year, and its syllable rules allow it; the
//    view lists a taken name under its new namer from the taking on, with
//    its older name, and its exonyms.
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const M = {
  view: await L('/src/screens/incubator/languageView.ts'),
  pack: await L('/src/screens/incubator/historyPack.ts'),
  fixture: await L('/scripts/fixtures/fixtureView.ts'),
  windows: await L('/src/ui/windows/windowSet.ts'),
  types: await L('/src/ui/languagePanel/languageTypes.ts'),
}

// The incubator's WASM build (engine/dist/incubator, `make engine`).
const INCUBATOR = new URL('../../engine/dist/incubator/', import.meta.url)
const wasm = await import(new URL('casas-incubator.js', INCUBATOR).href)
await wasm.default({ module_or_path: await readFile(new URL('casas-incubator_bg.wasm', INCUBATOR)) })
// The native build (the job worker's), for the names' check (5.).
const native = createRequire(import.meta.url)(fileURLToPath(new URL('../../engine/dist/casas-incubator.node', import.meta.url)))

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

// What the history keeps of each people for the languages (peoples.rs
// `People`: its largest share of the km² lived in while big, its last
// heart, its heart LANGUAGE_APART_YEARS after its birth, whether it was
// replaced), from the made tree's rows and log.
function languageInputs(history) {
  const { tree, log } = history
  const n = tree.parent.length
  const lived = new Map()
  for (let r = 0; r < tree.frame.length; r++) lived.set(tree.frame[r], (lived.get(tree.frame[r]) ?? 0) + tree.km2[r])
  const times = M.view.keptTimes(history.start, history.end)
  const share = new Float64Array(n)
  const heart = new Int32Array(n).fill(-1)
  const heartApart = new Int32Array(n).fill(-1)
  for (let p = 0; p < n; p++) {
    for (let r = tree.frameStart[p]; r < tree.frameStart[p + 1]; r++) {
      if (tree.big[p]) share[p] = Math.max(share[p], tree.km2[r] / lived.get(tree.frame[r]))
      heart[p] = tree.centre[r]
      if (heartApart[p] < 0 && times[tree.frame[r]] - tree.born[p] >= 1500) heartApart[p] = tree.centre[r]
    }
  }
  const replaced = new Uint8Array(n)
  for (const e of log) if (e.kind === 'peopleReplaced') replaced[e.people] = 1
  return { share, heart, heartApart, replaced }
}

// The history's languages as the crate makes them (its WASM build): the
// tree, the events into the log, what the crate makes of the tree.
function languagesOf(history, seed) {
  const { tree } = history
  const x = languageInputs(history)
  const out = JSON.parse(wasm.languagesOfPeoples(tree.parent, tree.group, Float64Array.from(tree.born), Float64Array.from(tree.ended), tree.mergedInto, tree.big, x.share, x.replaced, x.heart, x.heartApart, seed, history.start, history.end))
  const types = { peopleLanguage: Int32Array, parent: Int32Array, level: Uint8Array, people: Int32Array, from: Float32Array, at: Float32Array, until: Float32Array, seed: Int32Array, style: Uint8Array, changeStart: Int32Array, changeYear: Uint16Array, change: Uint8Array, changeChoice: Uint8Array, wordStart: Int32Array, wordYear: Uint16Array, wordMeaning: Uint8Array }
  const packed = Object.fromEntries(Object.entries(types).map(([key, T]) => [key, T.from(out.arrays[M.pack.LANGUAGE_ARRAYS[key]])]))
  packed.description = new TextEncoder().encode(out.arrays.languages)
  const l = packed
  const made = JSON.parse(wasm.languageView(l.peopleLanguage, l.parent, l.level, l.people, l.from, l.at, l.until, l.seed, l.style, l.changeStart, l.changeYear, l.change, l.changeChoice, l.wordStart, l.wordYear, l.wordMeaning))
  return { languages: { tree: packed, made }, events: out.log }
}

console.log('1. the adapter (languageView.ts) on the crate\'s languages (its WASM build)')
for (const seed of [1, 7, 2840]) {
  const made = makeHistory(seed)
  const { languages, events } = languagesOf(made, seed)
  const log = [...made.log, ...events].sort((a, b) => a.at - b.at)
  const history = { ...made, log, languages }
  const { tree } = history
  const view = M.view.deriveLanguageView(history)
  const byId = new Map(view.nodes.map((n) => [n.id, n]))
  const ofLevel = (level) => view.nodes.filter((n) => n.level === level)
  const families = ofLevel('family')
  const proper = ofLevel('language').filter((n) => !n.proto)
  const peopleCount = tree.parent.length
  const bigCount = tree.big.reduce((s, b) => s + b, 0)
  const count = (kind) => events.filter((e) => e.kind === kind).length
  console.log(`  seed ${seed}: ${peopleCount} peoples (${bigCount} big), ${view.times.length} kept states; ${families.length} families, ${proper.length} languages, ${ofLevel('dialect').length} dialects; ${count('languageArises')} arise, ${count('languageGone')} languages and ${count('familyGone')} families gone`)
  check(`seed ${seed}: the tree has languages of its own, and some arise and some go`, proper.length > 0 && count('languageArises') > 0 && count('languageGone') > 0)

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
    for (let k = 0; k < view.times.length; k++) {
      const sum = below.reduce((s, c) => s + c.speakers[k], 0)
      if (node.level === 'family' ? !near(sum, node.speakers[k]) : sum > node.speakers[k] * (1 + 1e-5) + 1e-3) parts ||= `${node.id} at ${k}: ${node.speakers[k]} vs ${sum}`
    }
  }
  check(`seed ${seed}: a family's speakers are its languages' (its proto-language's with them), a language's at least its dialects'`, parts === '', parts)
  // A language arisen from a people has its speakers from its arising on.
  let early = ''
  for (const node of proper) {
    for (let k = 0; k < view.times.length; k++) if (view.times[k] < node.born && node.speakers[k] > 0) early ||= `${node.id} at ${view.times[k]}, born ${node.born}`
  }
  check(`seed ${seed}: a language has no speakers before it arose`, early === '', early)

  // The dialects die out at their people's end in the log, and only there.
  const ends = M.view.peopleEnds(log)
  let wrong = ''
  let told = 0
  for (let p = 0; p < peopleCount; p++) {
    if (!tree.big[p]) continue
    const dialect = ofLevel('dialect').find((d) => d.peoples.length === 1 && d.peoples[0] === p)
    if (!dialect) { wrong ||= `people ${p}: no dialect`; continue }
    const end = ends.get(p) ?? null
    if (end !== null) told++
    if (dialect.ended !== end) wrong ||= `people ${p}: † ${dialect.ended}, its end ${end}`
  }
  check(`seed ${seed}: each big people's dialect ends exactly at its end event (${told} told)`, wrong === '' && told > 0, wrong)
  // The languages and the families die out at their log events, and only
  // there; a language gone is spoken no more after it.
  let gone = ''
  const languageGone = new Map(events.filter((e) => e.kind === 'languageGone').map((e) => [`l${e.language}`, e.at]))
  const familyGone = new Map(events.filter((e) => e.kind === 'familyGone').map((e) => [`f${e.family}`, e.at]))
  for (const node of proper) {
    if (node.ended !== (languageGone.get(node.id) ?? null)) gone ||= `${node.id}: † ${node.ended}, its event ${languageGone.get(node.id)}`
    if (node.ended !== null) for (let k = 0; k < view.times.length; k++) if (view.times[k] > node.ended && node.speakers[k] > 0) gone ||= `${node.id}: speakers after its †`
  }
  for (const node of families) {
    const end = familyGone.get(node.id) ?? null
    if (node.ended !== end || byId.get(`${node.id}p`).ended !== end) gone ||= `${node.id}: † ${node.ended}, its event ${end}`
  }
  check(`seed ${seed}: a language, a family and its proto-language end at their log events (${languageGone.size} and ${familyGone.size})`, gone === '', gone)
  check(`seed ${seed}: every big people speaks one dialect and is counted in its family`, families.reduce((s, f) => s + f.peoples.length, 0) === bigCount)
  check(`seed ${seed}: each node is born by its parent`, view.nodes.every((n) => n.parent === null || n.born >= byId.get(n.parent).born))
  check(`seed ${seed}: each language has a detail, each node and people a name`, ofLevel('language').every((n) => view.detail(n.id) !== null) && view.nodes.every((n) => n.name !== '') && Array.from({ length: peopleCount }, (_, p) => view.peopleName(p)).every((s) => s !== ''))
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

// --- 5. the names -------------------------------------------------------------

console.log('5. the names (the crate\'s place_names.rs, its WASM and native builds)')
const KINDS = ['village', 'river', 'mountain', 'lake', 'landmass']
for (const seed of [1, 7, 2840]) {
  const made = makeHistory(seed)
  const { languages, events } = languagesOf(made, seed)
  const { tree } = made
  const x = languageInputs(made)
  // A village for each people, at a year of its life; then a river, a
  // mountain, a lake, a landmass for every fifth people.
  const draw = random(seed + 1)
  const kinds = []
  const peoples = []
  const years = []
  for (let p = 0; p < tree.parent.length; p++) {
    const until = Math.min(tree.ended[p], made.end)
    kinds.push(0)
    peoples.push(p)
    years.push(Math.round(tree.born[p] + draw() * (until - tree.born[p])))
  }
  for (let p = 0; p < tree.parent.length; p += 5) for (let k = 1; k < 5; k++) {
    kinds.push(k)
    peoples.push(p)
    years.push(tree.born[p])
  }
  // 6. A third of the places taken by a people of another family, a third
  // of the way from its year to the end (at a tree step), and held to the
  // end; peoples of two families in contact.
  const living = [...tree.parent.keys()]
  const held = { place: [], year: [], people: [] }
  for (let j = 0; j < kinds.length; j += 3) {
    const at = Math.round((years[j] + (made.end - years[j]) / 3) / 500) * 500
    const by = living.find((q) => tree.group[q] !== tree.group[peoples[j]] && tree.born[q] <= at)
    if (by === undefined || made.end - at < 1000 || at <= years[j]) continue
    held.place.push(j, j)
    held.year.push(years[j], at)
    held.people.push(peoples[j], by)
  }
  const contacts = []
  for (const a of living) for (const b of living) if (a < b && tree.group[a] !== tree.group[b] && contacts.length < 5 * 12) contacts.push(a, b, 200 + 100 * (a % 9), 5 + (b % 30), a % 4)
  const args = [tree.parent, tree.group, Float64Array.from(tree.born), Float64Array.from(tree.ended), tree.mergedInto, tree.big, x.share, x.replaced, x.heart, x.heartApart, seed, made.start, made.end, Uint8Array.from(kinds), Int32Array.from(peoples), Float64Array.from(years), Int32Array.from(held.place), Float64Array.from(held.year), Int32Array.from(held.people), Float64Array.from(contacts)]
  const fromWasm = wasm.namesOfPlaces(...args)
  const fromNative = native.namesOfPlaces(...args)
  check(`seed ${seed}: the native build gives the WASM's names`, fromWasm === fromNative)
  const out = JSON.parse(fromWasm)
  const a = out.arrays
  const villages = kinds.filter((k) => k === 0).length
  const villageNames = a.nameKind.filter((k) => k === 0).length
  check(`seed ${seed}: every village has a name (${villageNames} of ${villages}), not empty at the end`, villageNames === villages && a.nameKind.length === kinds.length && out.atEnd.every((s) => s !== ''))
  const changed = out.forms.filter((f) => f.length > 2).length
  check(`seed ${seed}: names wear down over time (${changed} of ${out.forms.length} change their form)`, changed > 0)
  console.log(`  seed ${seed}: ${a.nameKind.length} names, e.g. ${out.atEnd.slice(0, 4).join(', ')}; ${KINDS.map((k, i) => `${a.nameKind.filter((x) => x === i).length} ${k}`).join(', ')}`)
  // The view: a name under its namer and every node above it.
  const names = {
    kind: Uint8Array.from(a.nameKind), town: new Uint8Array(a.nameKind.length), place: Int32Array.from(a.namePlace), cell: Int32Array.from(a.nameCell),
    namer: Uint16Array.from(a.nameNamer), year: Float32Array.from(a.nameYear),
    forms: out.forms.map(M.view.formsOf),
    ...M.view.otherNamesOf(out.others),
  }
  const log = [...made.log, ...events].sort((p, q) => p.at - q.at)
  const view = M.view.deriveLanguageView({ ...made, log, languages: { ...languages, names } })
  const listed = a.nameKind.length
  const families = view.nodes.filter((n) => n.level === 'family')
  const total = families.reduce((s, f) => s + view.names(f.id, 0, 0).total, 0)
  check(`seed ${seed}: the families list every name, the landmasses' too (${total} of ${listed})`, total === listed)
  const mid = (made.start + made.end) / 2
  const byMid = families.reduce((s, f) => s + view.names(f.id, 0, 0, mid).total, 0)
  check(`seed ${seed}: by a year, the names given by then (${byMid})`, byMid === a.nameYear.filter((y, j) => y <= mid).length)
  const row = view.names(families[0].id, 0, 1)
  const word = row.rows[0]?.name.toLowerCase().slice(0, 4) ?? ''
  check(`seed ${seed}: the search finds a name's node ("${word}")`, word !== '' && view.namesFound(word, made.end).has(row.rows[0].language))

  // 6. the other names.
  const HOW = M.pack.NAME_HOW
  const count = (h) => a.aliasHow.filter((x) => x === HOW.indexOf(h)).length
  const takings = held.place.length / 2
  check(`seed ${seed}: every place taken has a later name (${count('kept')} kept, ${count('renamed')} renamed of ${takings})`, count('kept') + count('renamed') === takings && count('kept') > 0 && count('renamed') > 0)
  const exonyms = count('borrowed') + count('translated') + count('own')
  check(`seed ${seed}: the peoples in contact name each other's places (${count('borrowed')} borrowed, ${count('translated')} translated, ${count('own')} own)`, exonyms > 0 && count('borrowed') > 0)
  const loans = out.loans
  const inSounds = loans.filter((l) => l.sounds.flat().every((p) => l.inventory.includes(p))).length
  const fits = loans.filter((l) => l.fits.every(Boolean)).length
  check(`seed ${seed}: every loan is in its borrower's sounds (${inSounds} of ${loans.length}), its syllable rules allow it (${fits})`, loans.length > 0 && inSounds === loans.length && fits === loans.length)
  // A taken place: under its new namer from the taking on, its older name.
  const taken = [...names.chain.keys()].find((j) => names.chain[j].length > 1 && KINDS[names.kind[j]] !== 'landmass')
  const [first, later] = names.chain[taken]
  const familyOf = (node) => {
    let at = view.nodes.find((n) => n.id === node)
    while (at && at.parent !== null) at = view.nodes.find((n) => n.id === at.parent)
    return at
  }
  const rowsAt = (year) => families.flatMap((f) => view.names(f.id, 0, 1e6, year).rows).filter((r) => r.cell === names.cell[taken])
  const before = rowsAt(later.year - 1)
  const after = rowsAt(later.year)
  check(`seed ${seed}: a taken name moves to its new namer's family, with its older name ("${before[0]?.name}" → "${after[0]?.name}" ← "${after[0]?.older?.[0]?.name}")`, before.length === 1 && after.length === 1 && familyOf(before[0].language) !== familyOf(after[0].language) && after[0].older?.[0]?.name === first.form && after[0].name === M.view.nameAt(names, taken, later.year))
  const withExonym = [...names.exonyms.keys()].find((j) => names.exonyms[j].length > 0 && KINDS[names.kind[j]] !== 'landmass')
  const shown = withExonym === undefined ? [] : families.flatMap((f) => view.names(f.id, 0, 1e6).rows).filter((r) => r.cell === names.cell[withExonym])
  check(`seed ${seed}: a name lists its exonyms (${shown[0]?.exonyms?.map((e) => e.name).join(', ')})`, shown.length === 1 && shown[0].exonyms?.length === names.exonyms[withExonym].length)
  // The book's place(): the current name, the older ones and the exonyms.
  const l = languages.tree
  const book = new wasm.PlaceNames(l.peopleLanguage, l.parent, l.level, l.people, l.from, l.at, l.until, l.seed, l.style, l.changeStart, l.changeYear, l.change, l.changeChoice, l.wordStart, l.wordYear, l.wordMeaning, names.kind, names.place, names.cell, names.namer, names.year, Uint8Array.from(a.namePattern), Uint8Array.from(a.nameMeaning), Uint8Array.from(a.nameOwnLength), Uint8Array.from(a.nameOwn), Int32Array.from(a.aliasName), Uint8Array.from(a.aliasHow), Uint16Array.from(a.aliasNamer), Float32Array.from(a.aliasYear), Uint8Array.from(a.aliasPattern), Uint8Array.from(a.aliasMeaning), Uint8Array.from(a.aliasLength), Uint8Array.from(a.aliasSounds))
  const place = JSON.parse(book.place(taken, made.end))
  book.free()
  check(`seed ${seed}: the book gives a place's name, its older names and its exonyms`, place.name === M.view.nameAt(names, taken, made.end) && place.older.length === names.chain[taken].length - 1 && place.older[0][0] === first.form)
  console.log(`  seed ${seed}: e.g. ${names.chain[taken].map((e) => `"${e.form}" (${HOW[e.how] ?? 'first'})`).join(' → ')}`)
}

await server.close()
if (failures > 0) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
