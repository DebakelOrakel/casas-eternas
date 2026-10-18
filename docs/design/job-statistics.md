---
id: DES-0030
title.en: Job statistics — local, and shared across installations
title.de: Job-Statistik — lokal, und geteilt über Installationen
summary.en: Idea sketch for a record of what each task of a job cost: the
  engine's versions, the level, the nodes and epochs, the time per phase,
  the CPU, its limit and its throttling, the peak memory. First kept by
  each installation in jobs.db, for its end estimate and its admin window;
  then, opt-in, sent to a central service that collects the same rows from
  every installation — the same binary with a target of its own. Only
  numbers, never a seed or a world. Nothing decided.
summary.de: Ideenskizze für eine Aufzeichnung, was jede Aufgabe eines Jobs
  gekostet hat: die Versionen der Engine, die Stufe, Knoten und Epochen,
  die Zeit je Phase, die CPU, ihr Limit und ihre Drosselung, der höchste
  Speicher. Zuerst hält jede Installation sie in jobs.db, für ihre
  Endschätzung und ihr Admin-Fenster; dann, auf Wunsch, an einen zentralen
  Dienst geschickt, der dieselben Zeilen von allen Installationen sammelt —
  dasselbe Binary mit einem eigenen Target. Nur Zahlen, nie ein Seed oder
  eine Welt. Nichts entschieden.
area: platform
stage: idea
createdAt: 2026-10-18
related: [DES-0024, DEC-0032, DEC-0043]
---

Records a discussion (2026-10-18). It started on the first install of the
chart in a cluster (DEC-0043): a level-1 replay that took about 5.8 h
there, and the question why. The answer came from files in the worker's
pod, not from the server: the CPU model in `/proc/cpuinfo`, the limit in
`/sys/fs/cgroup/cpu.max`, the use and the throttling in `cpu.stat`. The
replay used 1.1 cores of 6 and was never throttled; its time is the speed
of one core. Nothing of this is recorded today. The question became: what
if every task recorded it, and every installation could share it?

## What exists

- The worker's report of a done task (`jobs.done.<taskId>`) carries
  `nodes` and `durationMs` (client/scripts/jobWorker.ts, JobOutcome).
- The worker's presence (`jobs.worker.<id>`, every 15 s) carries its host,
  its cores (`availableParallelism`, which respects the cgroup's quota) and
  its build (`WORLD_PIPELINE`).
- The end estimate in the jobs window projects the stages that run now;
  it has no rates from earlier tasks.
- DES-0024 (worker profiles) wants each worker's rate per level, measured
  on its real tasks. This doc is the record that rate would be read from.

## What a row holds

One row per task, written when the task is done or has failed. Only
numbers and versions — nothing a world can be made again from:

| Field | From | Why |
|---|---|---|
| `worldPipeline` | the worker (`WORLD_PIPELINE`) | the engine's version |
| `pipelineVersion` | the artifact key of the stage | the stage's version: a tile constant moves only the tile's |
| `stage`, `tile` | the task | L1, or L2/L3 with x, y (local only, see below) |
| `nodes`, `epochs` | the result | the size of the work |
| `phases` | the worker | per phase: wall time and CPU seconds |
| `cpuModel` | `/proc/cpuinfo` | e.g. `AMD EPYC Processor (with IBPB)` |
| `cores`, `cpuLimit` | `availableParallelism`, `cpu.max` | what the task could use |
| `throttledMs` | `cpu.stat` (`throttled_usec`) | whether the limit braked it |
| `peakMemory` | `memory.peak` | what it held |
| `deliveries`, `queuedMs` | the coordinator | how it was handed out |
| `ok` | the coordinator | done or failed |

The CPU seconds per phase come from `process.cpuUsage()` around each phase,
which includes the engine's threads. Outside a cgroup (a laptop),
`cpuLimit`, `throttledMs` and `peakMemory` stay empty.

Not in a row: the seed, the world's id or name, the owner, the server's
address. The world's id is a hash of its state, and would tie rows from
two installations to the same world; locally the job id is enough to
group a world's tasks.

## Step 1 — local, in the jobs module

The worker adds the fields above to its done report. The coordinator
receives that report anyway; it writes the row into `jobs.db`, beside the
jobs. Kept for a time or a count, as the job history is.

What it gives at once:

- an end estimate from the rates of earlier tasks of the same stage and
  version, scaled by nodes (or by tiles), instead of only from the stages
  that run;
- a table in the admin window: per stage and version, time per node, per
  CPU model;
- DES-0024's rates per worker, without a second record.

Not a module of its own: it would need its own store and its own
subscription to the same messages, and its first reader, the end
estimate, is the jobs module's.

## Step 2 — shared, opt-in

An installation that opts in sends its rows to a central service, without
the local fields (`tile`, the job id). With them:

- how fast a stage is on which CPU, with how many cores and which limit;
- whether a new version made a stage slower, over many worlds instead of
  one;
- an end estimate for a new installation that has no rows of its own.

**The central service is the same binary**, with a target of its own: a
module that accepts rows and answers queries over them. Operated with the
same chart, as a component with that target alone. That keeps the rule
that a service is always the same binary.

**Rules for the sender:**

- Off by default; one setting turns it on, and the admin window says
  that it is on.
- Never in the way of a job: rows are sent in the background, buffered,
  and dropped when the service does not answer.
- An installation is named by a random id made once and kept in its state
  directory, not by its host or address.

**Rules for the service:**

- Anyone can send, so anyone can send nonsense: a rate limit per
  installation id and plausibility checks (nodes, times, versions it
  knows) at the start. Signed rows are a later question.
- It holds numbers only, but it is still a service that receives data:
  it needs a privacy statement, and someone to operate it at a fixed
  address.

## Names to agree on

Nothing below is agreed. These are proposals, to settle before any code:

- the setting that turns sharing on, e.g. `jobs.stats.share`, and the
  service's address, e.g. `jobs.stats.url`;
- the central target's name, e.g. `stats`;
- the local read, e.g. `GET /v1/jobs/stats`, and the central service's
  write and read;
- the admin window's keys for the table.

## Open questions

- How long the local rows are kept, and whether they survive a reset of
  the job history.
- Whether a failed task's row is useful (a failure after 4 h is a cost
  too), or only noise.
- Whether the central service publishes its tables, or answers only the
  installations that send.
- Whether the tile coordinates have value outside the installation
  (they say where on a world the work was hard, without saying which
  world).

## Status

Idea, 2026-10-18. Nothing built. The measurement that started it (the
level-1 replay at 1.1 of 6 cores, not throttled) was made by hand in the
pod.
