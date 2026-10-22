// WHERE A TASK'S TIME GOES, for the jobs' wall time (the profiling of
// 2026-10-21): the milliseconds since the last lap under each phase's name,
// summed where a name comes again. The worker writes them per task to
// stderr, which the server logs; nothing of it goes to the coordinator.
// The host's laps (jobWorker.ts) and the pipeline module's
// (workerPipeline.ts) alike; bundled into each.
export interface Laps {
  lap: (name: string) => void
  times: Record<string, number>
}
export function laps(): Laps {
  let last = performance.now()
  const times: Record<string, number> = {}
  return {
    times,
    lap: (name) => {
      const now = performance.now()
      times[name] = (times[name] ?? 0) + Math.round(now - last)
      last = now
    },
  }
}
