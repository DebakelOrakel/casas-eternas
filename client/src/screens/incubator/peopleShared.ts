// What the incubator's worker and the screen share of the people. Its own
// module: a worker module imported by the screen runs in the window too,
// where its `self.onmessage` is the window's — a message to the window,
// answered by the window, ran a loop that left the page white (2026-10-25).

// The span of the people's prehistory, years from their departure, year
// 0 (casas-incubator SPAN_YEARS): the history ends at its first city, at
// this at the latest (DES-0032).
export const SPAN_YEARS = 100_000
// A history (casas-incubator simulation.rs) keeps its state every
// KEEP_YEARS from its start, and at its end: the playback's frames.
export const KEEP_YEARS = 2500

// A kept state's people a km², in steps of PEOPLE_FRAME_STEP (16 bits; the
// farmers reach 15 a km² and more, the foragers' 0.1 is 100 steps).
export const PEOPLE_FRAME_STEP = 1e-3
