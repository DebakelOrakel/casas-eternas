import type { TKey } from '../../i18n/i18n'

// A job's phase names as the jobs window and the admin window's worker list
// say them (scripts/jobWorker.ts, runJob and replayLevel). A tile's phases
// have no names of their own; their percent says enough.
export const JOB_PHASE_KEYS: Record<string, TKey> = {
  read: 'generator.jobs.phase.read',
  verify: 'generator.jobs.phase.verify',
  history: 'generator.jobs.phase.history',
  hydrology: 'generator.jobs.phase.hydrology',
  store: 'generator.jobs.phase.store',
  plan: 'generator.jobs.phase.plan',
}
