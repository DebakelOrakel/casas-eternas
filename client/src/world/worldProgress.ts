// HOW FAR A WORLD WAS TAKEN, as its user sees it: the last step the user
// ACCEPTED, which is the last step left by moving forward — the same gesture
// that commits the Archean (GeneratorScreen's commitGenesis). Recorded in
// world.yaml as `status.progress` (worldRecord.ts) and shown by the world
// list. Documentation only: it is not part of the spec, the world id or the
// "unsaved" comparison.
//
// The steps themselves are the generator screen's (screens/generator/
// steps.ts). They are named here again because this is the vocabulary of a
// save field, and the world layer may not import a screen; steps.ts checks at
// startup that its chain and this list agree.

// The step chain, in order: a world's progress is counted on it, for both
// shapes, so the count does not change with what a shape runs today.
export const PROGRESS_STEPS = ['world', 'genesis', 'tectonics', 'climate', 'ecology', 'finishing'] as const
export type ProgressStep = (typeof PROGRESS_STEPS)[number]

// A recorded value as a step, or null for none or for one this client does
// not know (a later build may add steps).
export function progressStepOf(value: string | null | undefined): ProgressStep | null {
  return (PROGRESS_STEPS as readonly string[]).includes(value ?? '') ? (value as ProgressStep) : null
}

// The progress after a move from step `from` to step `to`, both indices into
// `order` (the screen's whole step list). A move forward
// accepts every step before the one it enters, so the progress becomes the
// last chain step before `to`. A move back, or to the same step, changes
// nothing; and the progress never goes down.
export function advanceProgress(current: ProgressStep | null, order: readonly string[], from: number, to: number): ProgressStep | null {
  if (to <= from) return current
  let accepted: ProgressStep | null = null
  for (let i = Math.min(to, order.length) - 1; i >= 0 && accepted === null; i--) accepted = progressStepOf(order[i])
  if (accepted === null) return current
  if (current === null) return accepted
  return PROGRESS_STEPS.indexOf(accepted) > PROGRESS_STEPS.indexOf(current) ? accepted : current
}

// The progress after the user reset `step`: the step is open again, so it
// and every step after it are no longer accepted — the progress drops to
// the chain step before it, or to none. A step off the chain, or a reset
// behind the progress, changes nothing.
export function withdrawProgress(current: ProgressStep | null, step: string): ProgressStep | null {
  const at = (PROGRESS_STEPS as readonly string[]).indexOf(step)
  if (current === null || at < 0 || PROGRESS_STEPS.indexOf(current) < at) return current
  return at === 0 ? null : PROGRESS_STEPS[at - 1]
}

// The steps the world list counts: the ones after the setup ('world', step
// 0 in the step bar) up to the ecology. The finishing is not counted: it is
// never left forward, so it is never accepted, and what it makes are levels
// on the server, which the list shows as levels (2026-10-18).
export const COUNTED_STEPS = PROGRESS_STEPS.indexOf('ecology')

// What the world list says: the accepted step's number, of the counted
// steps, and whether that was the last one. Null for a world that has
// accepted no step.
export function progressPosition(progress: ProgressStep | null): { n: number; all: number; done: boolean } | null {
  if (progress === null) return null
  const n = Math.min(PROGRESS_STEPS.indexOf(progress), COUNTED_STEPS)
  return { n, all: COUNTED_STEPS, done: n === COUNTED_STEPS }
}
