import { toroidalDistanceSq } from '../../core/toroidal'
import { derivePlateTypes } from '../../crust/raftField'
import { advanceRafts, recycleUnstabilisedCrust } from '../../crust/raftLifecycle'
import { MANTLE_RES_X, MANTLE_RES_Y } from '../mantleField'
import { advectOceanAge } from '../oceanAge'
import { advancePointByMotion, getVelocityAt } from '../plateMotion'
import { EPOCH_ANGLE_STEP, HOTSPOT_DEPOSIT_PER_EPOCH, HOTSPOT_EPOCH_INTERVAL, OCEANIC_SUBSIDENCE_DECAY_PER_EPOCH, RECYCLE_DOWNWELLING_THRESHOLD, STABILISATION_EPOCHS, THICKNESS_DECAY_PER_EPOCH } from '../tectonicsParams'
import { advanceTerrainFeatures, findOrCreateFeatureIndex } from '../terrainFeatures'
import type { PlateSimulation } from '../plateSimulationTypes'



// Each hotspot punches a volcano onto the overlying plate at its fixed location.
// tangent = the plate's motion direction there, so successive deposits (as the
// plate drifts the volcano off) line up into a chain; oceanic ones subside with
// age (old seamounts sink). plateA===plateB marks these as hotspot features so
// they only merge with each other, never with boundary ranges.
function depositHotspotVolcanoes(sim: PlateSimulation): void {
  const { width, height } = sim
  for (const hs of sim.hotspots) {
    let plate = 0
    let bestSq = Infinity
    for (let p = 0; p < sim.seeds.length; p++) {
      const d = toroidalDistanceSq(hs.x, hs.y, sim.seeds[p].x, sim.seeds[p].y, width, height)
      if (d < bestSq) {
        bestSq = d
        plate = p
      }
    }
    const v = getVelocityAt(hs, sim.motions[plate], width, height)
    const speed = Math.hypot(v.vx, v.vy) || 1
    // plateB = -1 is a dedicated hotspot marker (no real boundary can have it, and
    // plate-index shifts on merge only ever decrease indices, never to -1) — so
    // these only ever merge with other deposits from the SAME plume, never with
    // boundary ranges. Always subsides: the edifice cools + erodes once the plate
    // carries it off the plume, so the trail fades with age (old seamounts sink),
    // which also lets the feature prune bound the chain length.
    const idx = findOrCreateFeatureIndex(sim.features, hs.x, hs.y, plate, -1, plate, v.vx / speed, v.vy / speed, 'range', true, width, height)
    sim.features[idx].thickness += HOTSPOT_DEPOSIT_PER_EPOCH
    sim.features[idx].epochsSinceDeposit = 0
  }
}

// Phase 1. Advance every plate and everything riding on it — rafts, sutures,
// terrain features, the ocean-age field — along its own rotation.
export function advancePlatesAndCrust(sim: PlateSimulation, membership: Float32Array): void {
  const { width, height } = sim
  // 1. Advance every plate (and whatever terrain is attached to it)
  // along its own rotation.
  for (let i = 0; i < sim.seeds.length; i++) {
    const motion = sim.motions[i]
    const rotated = advancePointByMotion(sim.seeds[i].x, sim.seeds[i].y, motion, EPOCH_ANGLE_STEP, width, height)
    sim.seeds[i].x = rotated.x
    sim.seeds[i].y = rotated.y
    sim.ages[i] += 1
  }
  // Rafts (continents) ride their host plates, and plate types are re-derived
  // from the new raft positions so boundary classification below sees the
  // current crust layout. Phase 1: rafts only drift; split/merge/accretion
  // come later.
  advanceRafts(sim.rafts, sim.seeds, sim.motions, EPOCH_ANGLE_STEP, width, height)
  // Crust recycling, immediately after the drift that carried it here and before
  // derivePlateTypes below reads the result. Blobs accreted last epoch are one
  // epoch old now, so they are candidates — crust has to survive to the next epoch
  // to count, which is the right gate. See STABILISATION_EPOCHS.
  recycleUnstabilisedCrust(sim.rafts, sim.mantle, MANTLE_RES_X, MANTLE_RES_Y, sim.epoch, STABILISATION_EPOCHS, RECYCLE_DOWNWELLING_THRESHOLD, width, height)
  // Sutures are welded into the drifting crust — advect each with the plate it
  // sits on, so a collision belt stays ON its continent instead of being left
  // behind in open ocean as the plates move (which would strand the tin/gem
  // provenance offshore and mask it out in the ecology layer).
  for (const s of sim.sutures) {
    let host = 0
    let bestSq = Infinity
    for (let p = 0; p < sim.seeds.length; p++) {
      const d = toroidalDistanceSq(s.x, s.y, sim.seeds[p].x, sim.seeds[p].y, width, height)
      if (d < bestSq) { bestSq = d; host = p }
    }
    const rotated = advancePointByMotion(s.x, s.y, sim.motions[host], EPOCH_ANGLE_STEP, width, height)
    s.x = rotated.x
    s.y = rotated.y
  }
  sim.types = derivePlateTypes(sim.seeds, sim.rafts, width, height)
  // Advect the ocean-age field along with the plates that just moved (Phase 3).
  sim.oceanAge = advectOceanAge(sim.oceanAge, sim.seeds, sim.motions, EPOCH_ANGLE_STEP, width, height, membership, MANTLE_RES_X, MANTLE_RES_Y)
  advanceTerrainFeatures(sim.features, sim.motions, EPOCH_ANGLE_STEP, width, height)
  for (const feature of sim.features) {
    feature.thickness *= THICKNESS_DECAY_PER_EPOCH
    // Age-depth subsidence for oceanic features once idle (no longer fed by
    // their boundary, i.e. drifting off-ridge). Gated on epochsSinceDeposit
    // > 0 so a still-active ridge/arc (refreshed every epoch) keeps full
    // height — see OCEANIC_SUBSIDENCE_DECAY_PER_EPOCH.
    if (feature.subsides && feature.epochsSinceDeposit > 0) {
      feature.thickness *= OCEANIC_SUBSIDENCE_DECAY_PER_EPOCH
    }
    feature.epochsSinceDeposit += 1
  }
  // Hotspot volcanism: the plumes are fixed while plates drift over them, so this
  // deposits a fresh volcano at each plume onto the current overlying plate (after
  // the decay above, so today's deposit stands full height). See M3 / mantleField.
  if (sim.epoch % HOTSPOT_EPOCH_INTERVAL === 0) depositHotspotVolcanoes(sim)
}
