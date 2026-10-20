// The state hashes the epoch and Archean fixtures share: FNV-1a over the
// two words of each value as a double (a NaN and an absent value as the
// canonical NaN), a string as its UTF-16 units. crates/casas-engine/tests/
// sim_hash/mod.rs is the same in Rust.

const f = new Float64Array(1)
const w = new Uint32Array(f.buffer)
let h = 0
const add = (v) => {
  if (v === undefined || v !== v) {
    w[1] = 0x7ff80000
    w[0] = 0
  } else f[0] = v
  h = Math.imul(h ^ w[0], 0x01000193) >>> 0
  h = Math.imul(h ^ w[1], 0x01000193) >>> 0
}
const addAll = (a) => {
  for (let i = 0; i < a.length; i++) add(a[i])
}
const addName = (s) => {
  if (s === null || s === undefined) {
    add(-1)
    return
  }
  add(s.length)
  for (let i = 0; i < s.length; i++) add(s.charCodeAt(i))
}
const bool = (b) => (b === undefined ? undefined : b ? 1 : 0)
const EVENTS = ['continent_collided', 'continent_broke_up', 'supercontinent_formed', 'oceanic_created', 'oceanic_subducted']

export function stateHash(sim, events) {
  h = 0x811c9dc5
  add(sim.epoch)
  add(sim.seeds.length)
  for (const s of sim.seeds) {
    add(s.x)
    add(s.y)
  }
  for (const t of sim.types) add(t === 'continental' ? 1 : 0)
  for (const m of sim.motions) {
    if ('rate' in m) for (const v of [m.poleX, m.poleY, m.poleZ, m.rate]) add(v)
    else for (const v of [m.driftX, m.driftY, m.spin, m.centroidX, m.centroidY]) add(v)
  }
  addAll(sim.ages)
  add(sim.rafts.length)
  for (const r of sim.rafts) {
    add(r.id)
    addName(r.name)
    add(r.noMergeUntilEpoch)
    add(r.blobs.length)
    for (const b of r.blobs) for (const v of [b.x, b.y, b.radius, b.birthEpoch]) add(v)
  }
  add(sim.features.length)
  for (const t of sim.features) {
    for (const v of [t.x, t.y, t.thickness, t.tangentX, t.tangentY, t.kind === 'trench' ? 1 : 0, t.plateA, t.plateB, t.movesWithPlate === 'both' ? -1 : t.movesWithPlate, t.subsides ? 1 : 0, t.epochsSinceDeposit, bool(t.volcanic), t.shorteningKmPerMyr]) add(v)
  }
  addAll(sim.latticeAccumulated)
  addAll(sim.latticeLockedEpochs)
  addAll(sim.latticeLastClassCode)
  addAll(sim.oceanAge)
  addAll(sim.mantle)
  for (const p of sim.hotspots) for (const v of [p.x, p.y, p.id, p.birthEpoch]) add(v)
  for (const s of sim.sutures) for (const v of [s.x, s.y, s.tangentX, s.tangentY, s.epoch]) add(v)
  add(sim.supercontinentActive ? 1 : 0)
  add(sim.continentalRiftCooldownUntil)
  add(sim.random.state())
  for (const e of events) {
    add(EVENTS.indexOf(e.type))
    addName(e.name)
    addName(e.nameA)
    addName(e.nameB)
    for (const v of [e.x, e.y, e.dirX, e.dirY, e.plateIndex, e.otherPlateIndex]) add(v)
  }
  return h.toString(16).padStart(8, '0')
}


// The Archean world's state: its epoch, readouts, credit, rafts, mantle,
// streaks and generator.
export function archeanHash(sim) {
  h = 0x811c9dc5
  for (const v of [sim.epoch, sim.lastRecycled, sim.lastSplits, sim.lastNucleated, sim.nucleationCredit, sim.warpSeed]) add(v)
  add(sim.rafts.length)
  for (const r of sim.rafts) {
    add(r.id)
    addName(r.name)
    add(r.noMergeUntilEpoch)
    add(r.blobs.length)
    for (const b of r.blobs) for (const v of [b.x, b.y, b.radius, b.birthEpoch]) add(v)
  }
  addAll(sim.mantle)
  addAll(sim.upwellingStreak)
  add(sim.random.state())
  return h.toString(16).padStart(8, '0')
}
