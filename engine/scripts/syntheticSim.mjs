// The synthetic plate simulation the epoch and the forcing fixtures start
// from: 18 plates and 12 rafts drawn from the fixtures' generator.
// crates/casas-engine/tests/synthetic_sim/mod.rs builds the same one:
// change one, change the other.

export function syntheticSim(M, d, seed) {
  let state = seed
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
  const uniform = (lo, hi) => lo + (hi - lo) * (next() / 4294967296)
  const seeds = []
  for (let i = 0; i < 18; i++) seeds.push({ x: uniform(0, d.width), y: uniform(0, d.height) })
  const rafts = []
  for (let r = 0; r < 12; r++) {
    const cx = uniform(0, d.width)
    const cy = uniform(0, d.height)
    const blobs = []
    for (let b = 0; b < 6; b++) {
      const blob = { x: d.wrapX(cx + uniform(-90, 90)), y: Math.min(d.height, Math.max(0, cy + uniform(-60, 60))), radius: uniform(40, 120) }
      if (b % 2 === 0) blob.birthEpoch = Math.floor(uniform(0, 150))
      blobs.push(blob)
    }
    rafts.push({ id: r, name: r % 3 === 0 ? 'Morvane' : null, blobs })
  }
  const snap = {
    width: d.width, height: d.height, initialPlateCount: 18, seeds,
    motions: M.PM.generatePlateMotions(seeds, d, M.mulberry32(seed)),
    ages: seeds.map(() => Math.floor(uniform(0, 80))), rafts, features: [], epoch: 0, archeanEpochs: 150,
    warpSeed: 2900000000 + seed, supercontinentActive: false, continentalRiftCooldownUntil: 0,
    hotspots: [], sutures: [], rngState: 12345 + seed,
  }
  return M.PS.deserializePlateSimulation(snap, M.OA.savedOceanAge(M.OA.createOceanAgeField(40, d), d), undefined, d.kind)
}
