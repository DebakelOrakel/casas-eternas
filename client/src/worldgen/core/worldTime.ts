// How long an epoch represents, per phase — the basis for the world-age readout.
//
// The two phases run on different clocks, and that is not an inconsistency but a
// consequence of one of them already being pinned:
//
//  - **The tectonic phase is fixed at 1 Ma per epoch.** elevation/elevationField's
//    oceanFloorAtAge uses GDH1 (Stein & Stein 1992) for seafloor subsidence, and
//    that model's published coefficients are in millions of years; oceanAge's
//    MAX_SEAFLOOR_AGE = 180 is Earth's ~180 Ma oldest seafloor read on the same
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

// Formatted for display: Ga above a billion years, Ma below.
export function formatWorldAge(ma: number): string {
  return ma >= 1000 ? `${(ma / 1000).toFixed(2)} Ga` : `${Math.round(ma)} Ma`
}
