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

// The index of the kept state at or before `time` in a history from
// `start` to `end`: its last at its end. The end is mostly not a step of
// KEEP_YEARS from the start: a floor of the time alone gives the state
// before the last there, and the map showed it while the languages panel
// showed the last (2026-10-31).
export function keptIndex(start: number, end: number, time: number): number {
  if (time >= end) return Math.ceil((end - start) / KEEP_YEARS)
  return Math.max(0, Math.floor((time - start) / KEEP_YEARS))
}

// A kept state's people a km², in steps of PEOPLE_FRAME_STEP (16 bits; the
// farmers reach 15 a km² and more, the foragers' 0.1 is 100 steps).
export const PEOPLE_FRAME_STEP = 1e-3
