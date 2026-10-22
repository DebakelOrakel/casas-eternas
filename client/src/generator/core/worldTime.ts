// How long an epoch represents, per phase — the basis for the world-age readout.
//
// The two phases run on different clocks, and that is not an inconsistency but a
// consequence of one of them already being pinned:
//
//  - **The tectonic phase is fixed at 1 Ma per epoch.** elevation/elevationField's
//    oceanFloorAtAge uses GDH1 (Stein & Stein 1992) for seafloor subsidence, and
//    that model's published coefficients are in millions of years; the engine's
//    MAX_SEAFLOOR_AGE = 180 (tectonics/ocean_age.rs) is Earth's ~180 Ma oldest seafloor read on the same
//    scale. Changing this number would silently rescale ocean depth.
//  - **The Archean phase is free**, so it is chosen to make the phase last about as
//    long as the real Archean did. That eon ran 4.03-2.5 Ga, roughly 1530 Ma; the
//    usable stopping window measures ~300 epochs wide, which puts an Archean epoch
//    at about 5 Ma.
//
// The readout is deliberately ELAPSED time ("1.5 Ga old"), never an absolute date
// ("3.2 Ga"). An absolute scale would claim a correspondence to Earth's history
// that breaks the moment someone stops the Archean early and then runs tectonics
// for a long time — the world would arrive at a date it has no business being at.
export const ARCHEAN_MA_PER_EPOCH = 5
export const TECTONIC_MA_PER_EPOCH = 1

// Total elapsed world age in millions of years.
export function worldAgeMa(archeanEpochs: number, tectonicEpochs: number): number {
  return archeanEpochs * ARCHEAN_MA_PER_EPOCH + tectonicEpochs * TECTONIC_MA_PER_EPOCH
}

// The CONTINUOUS epoch axis: epochs since the world began, spanning the
// archean→tectonic handover. This is the axis every crust-age stamp and
// every crust-age reader must use — birthEpoch, suture epochs, the craton
// oldness normalization — because the tectonic clock restarts at zero while
// the stamps made during the Archean do not. Before this existed
// (2026-08-16), tectonic-era stamps used the restarted clock: on a young
// world every craton read as age zero, and a freshly-accreted margin could
// read OLDER than an Archean core. (An epoch counts a different Ma-span in
// each era — see the constants above — so this axis measures EPOCHS, not
// time; for elapsed time use worldAgeMa.)
export function worldEpoch(archeanEpochs: number, tectonicEpochs: number): number {
  return archeanEpochs + tectonicEpochs
}

// The world age, Ma, at which a stamp on the continuous epoch axis was made
// — worldAgeMa read at a worldEpoch stamp. A crust's AGE is a time, so an
// age gate compares this against the clock, never two epoch counts: an
// Archean epoch is five tectonic ones (DEC-0036 phase 8b-1 — the tectonic
// crust sink read every Archean craton at the hand-over as younger than
// its 150 epochs and recycled 26–55 % of the land in the first epoch).
export function worldEpochMa(stamp: number, archeanEpochs: number): number {
  return stamp <= archeanEpochs
    ? stamp * ARCHEAN_MA_PER_EPOCH
    : archeanEpochs * ARCHEAN_MA_PER_EPOCH + (stamp - archeanEpochs) * TECTONIC_MA_PER_EPOCH
}

// Formatted for display: always Ma, never Ga (user's call, 2026-08-06) — one
// unit for the whole readout's life beats a nicer-looking big number that
// changes units mid-run. Both the Genesis and Tectonics panels show this.
export function formatWorldAge(ma: number): string {
  return `${Math.round(ma)} Ma`
}
