// What the people's spread (people.ts) and the screen share. Its own
// module: a worker module imported by the screen runs in the window too,
// where its `self.onmessage` is the window's — a message to the window,
// answered by the window, ran a loop that left the page white (2026-10-25).

// The span of the people's history, years: from their departure, year 0,
// to the game. 65 000 until 2026-10-26, then 100 000 for the simulation
// (DES-0033), the rules with it.
export const SPAN_YEARS = 100_000
// A simulated history (simulation.ts) keeps its state every KEEP_YEARS, the
// playback's frames.
export const KEEP_YEARS = 2500

// A kept state's people a km², in steps of PEOPLE_FRAME_STEP (16 bits; the
// farmers reach 15 a km² and more, the foragers' 0.1 is 100 steps).
export const PEOPLE_FRAME_STEP = 1e-3
