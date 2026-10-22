---
id: DES-0024
title.en: Worker profiles — what each worker can do, and how fast
title.de: Worker-Profile — was jeder Worker kann, und wie schnell
summary.en: Idea sketch for knowing the job workers better than "connected": what
  each reports about itself (memory, CPU, Node), how fast it computes each
  level as measured on its real tasks, and an optional test bake at start
  whose hash proves it computes the same bytes. Shown in a section of its
  own in the admin window. With it, counting the workers that are there
  instead of the configured ones, and a server that runs only external
  workers. Nothing decided.
summary.de: Ideenskizze, um die Job-Worker besser zu kennen als nur „verbunden“: was
  jeder über sich meldet (Speicher, CPU, Node), wie schnell er jede Stufe
  rechnet, gemessen an seinen echten Aufgaben, und ein optionaler Test-Bake
  beim Start, dessen Hash beweist, dass er dieselben Bytes rechnet. Gezeigt
  in einem eigenen Bereich des Admin-Fensters. Dazu: die Worker zählen,
  die da sind, statt der konfigurierten, und ein Server, der nur externe
  Worker hat. Nichts entschieden.
area: platform
stage: idea
createdAt: 2026-10-05
updatedAt: 2026-10-05
related: [DEC-0034, DES-0022, DES-0015, DEC-0032]
---

Records a discussion (2026-10-05). The question: can the workers be
classified, or profiled — a test workload that finds out what each worker
can do and how fast it is?

## What exists

Since 2026-10-04 every worker reports itself on `jobs.worker.<id>` every
15 s (internal/modules/jobs/presence.go): a random id, its service account,
host, cores, pools, build and start time, and the task in hand with its
phase and percent. The jobs module keeps the list; an admin reads it at
`GET /v1/jobs/workers`, and the admin window shows it under the service
accounts. Everyone who may see jobs gets only the count.

Workers PULL their tasks from the bus. Which worker computes which task is
the worker's choice, limited only by the pools it subscribes to (`level`,
`tile`).

## Three steps, cheapest first

### 1. Capabilities, reported

The presence carries a few more facts the worker knows about itself:
total memory (`os.totalmem`), CPU model, Node version. No test needed.

Already useful: a level-1 replay holds the whole history in memory and
runs for hours (7 h 45 min in the cluster, 2026-10-04); a small machine
should not take it. Today the pools are the way to keep it off one.

### 2. Speed, measured on real tasks

The real tasks are the best benchmark, and they cost nothing extra. The
worker names its id in its done report; the coordinator keeps, per
worker and per level, nodes per second over its last tasks (the tile's
node count and its bake time are in the report already).

What it gives:

- the admin window shows each worker's rate per level, e.g. "L3: 85 k
  nodes/s";
- a slow or stalled worker stands out against the others on the same
  level;
- the end estimate of a running plan can use the rates of the workers
  actually connected — the cost table noted on 2026-10-02.

Kept in memory, or in jobs.db if it should survive a restart; a worker's
id changes with every start, so the key would be its host and account
rather than its id.

### 3. A test bake at start (optional)

At start, before it takes a task, the worker bakes a fixed small tile from
data built into the bundle (~3 s) and reports the time and the HASH of the
result.

The hash is the point. It proves the worker computes the same bytes as
every other: the class of fault the generator has met before — V8 and
Safari apart in the last bit (detMath, 2026-10-02), a worker image of a
different build. A worker whose hash is not the expected one gets no
tasks, instead of filing tiles that differ under the same artifact key.
The time is a second, coarser speed figure, available before any real
task ran.

Cost: ~3 s per worker start, and a fixture to keep current — the expected
hash moves with every tile pipeline version.

## Own workers, external workers

Discussed the same day, and part of the same picture: the server counts
workers by its configuration, not by who is there.

- `jobs.max-concurrent` bounds only the server's OWN workers: off a
  cluster the worker processes it starts, in a cluster the most replicas
  the scaler gives the worker Deployment. External workers (a service
  account, `RELAY_CREDENTIALS`) take tasks from the same queue, unbounded
  and uncounted.
- A value below 1 is read as 1, so one own worker always runs; with only
  external workers wanted, that cannot be said.
- In a cluster without a worker Deployment, the scaler says once that
  "refinements wait until there is" one — untrue with external workers,
  which compute the tasks anyway.
- The jobs window says "n of m workers busy" with m = `max-concurrent`:
  with external workers busy, n can exceed m. Its "workers starting: x of
  y" compares every connected worker with the own replicas wanted, so
  external workers can hide a slow start.

Proposed:

- `jobs.max-concurrent: 0` means no own workers — no pool, no scaling, no
  message about a missing Deployment. It changes what a value of an
  existing key means, so it is asked first. **Built 2026-10-22**: no pool,
  no scaler, no worker bundle needed, and the jobs window wants no number
  of workers (`/v1/jobs/workers` without `wanted`); below 0 is refused.
- The jobs window counts the connected workers from the presence, own and
  external together; "workers starting" compares only the own pods.

## Assigning by profile

A separate step, and a larger one. The simplest control exists: strong
machines subscribe to `level` and `tile`, weak ones to `tile` only. Finer
— large tiles to fast workers, level 1 only where the memory is — would
mean the coordinator assigns tasks instead of the workers pulling them:
per-worker subjects or a dispatcher, and a change to how a task is handed
on when its worker dies.

## In the admin window

A section of its own, "Worker", beside the service accounts that the
workers prove themselves with; or the present "Connected" block grown
into it. Per worker: host, account, cores, memory, build, the test bake's
time and whether its hash matched, the measured rate per level, the task
in hand. Every label is a new catalog key, to be agreed before it is
written.

## Open questions

- Is the test bake (step 3) worth its fixture, or is a wrong hash better
  caught by comparing a real tile from two workers now and then?
- Where do the rates live: memory only (lost at restart, rebuilt within
  minutes), or jobs.db?
- Does "worker" in the admin window become one section with accounts and
  connected workers, or two?
- Is assigning by profile wanted at all, or are the pools enough?
- With profiles, should the jobs window weigh workers by their speed —
  "6 workers" saying less than "the speed of 4 average ones"?

## Status

2026-10-05: IDEA ONLY — not decided, not built. Recorded from a
discussion; the steps above are a direction, not a plan. Step 2 is the
one proposed to come first, together with step 1; the counting of own and
external workers goes with them.
