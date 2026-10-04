---
id: DEC-0032
title.en: The detail ladder
title.de: Die Detail-Leiter
summary.en: The detail ladder after the first tile jobs — five levels a factor of 4
  apart in spacing (budget 4, 1, 1/4, 1/16, 1/64); level 1 replays the whole
  history at its own density instead of refining the end state; levels 2 and
  3 are tile jobs ahead of time, level 4 near the camera only; a coordinator
  plans the tiles as a graph and hands them out over NATS from the start;
  the tile pick goes.
summary.de: Die Detail-Leiter nach den ersten Kachel-Jobs — fünf Ebenen, im Abstand je
  um den Faktor 4 auseinander (Budget 4, 1, 1/4, 1/16, 1/64); Level 1 spielt
  die ganze Geschichte in seiner eigenen Dichte nach, statt den Endzustand
  zu verfeinern; Level 2 und 3 sind vorab berechnete Kachel-Jobs, Level 4
  nur nahe der Kamera; ein Koordinator plant die Kacheln als Graph und
  verteilt sie von Anfang an über NATS; die Kachelwahl entfällt.
area: generator
stage: building
createdAt: 2026-10-01
updatedAt: 2026-10-04
concepts: [generator.concept.detail-levels, generator.concept.jobs, generator.concept.same-world]
related: [DEC-0031, DES-0022, DEC-0033]
---

## Where this starts

Built today (decisions/tile-jobs.md): level 1 is one global job that
refines the save's END STATE to budget 0.5 (2–8 M nodes), adds synthesis
and erodes 12 rounds without uplift; level 2 is a tile job of 8 × 8 macro
cells at budget 1/16, its edge line pinned, its rivers entering from level
1's network. Level 1 has no history of its own: its valleys at the
kilometre scale are painted and briefly worn, not earned — and rivers and
valleys are the generator's first priority.

What changed since (2026-10-01): the live history builds and keeps real
ranges (uplift doubled, ranges ride their continent: land p99 5–6 km while
active, ~4 km after); every artifact of before is outdated (the key's
gaps were closed); the rain is 62 km coarse everywhere below level 0.

## Fork 1 — the levels: DECIDED

Five levels, a factor of 4 apart in spacing, so each level invents a
quarter of the detail the step to it needs and the erosion earns the rest:

| Level | Budget | Spacing from | Made as | When |
|---|---|---|---|---|
| L0 | 4 | ~8 km | the live history | the generator |
| L1 | 1 | ~2 km | global, the history's last epochs replayed (fork 2) | finishing |
| L2 | 1/4 | ~500 m | tiles from L1 | finishing, all land |
| L3 | 1/16 | ~125 m | tiles from L2 | finishing, all land |
| L4 | 1/64 | ~30 m | tiles from L3 | on demand, near the camera |

Measured on 2048 × 1024 (2026-09-30): budget 1 is 1.85 M nodes and ~60 s
an epoch, budget 0.5 (today's L1) 7.6–8.4 M and 265–363 s. Each level down
is ~16× the nodes of the one above, so from L2 on only tiles fit a job.
Today's tile job (1/16, 8 × 8) becomes L3 with its parent changed; today's
level-1 job is replaced (fork 2).

## Fork 2 — how level 1 is made: DECIDED — replay the whole history

**Options.**
1. Refine the end state, as today, at budget 1.
2. Replay the whole history from the recipe at budget 1.
3. Replay the last K epochs from a checkpoint the save carries.

**Decided 2026-10-01: 2** (the user's call; option 3 was proposed). A
replay at another density is a sibling world — the history is chaotic.
Measured: the outlines agree, 5–8 % of the coast differs and the valleys differ from the first epoch on; any continuation
also ages the world (24–26 % of the coast in 5 epochs). Option 2 therefore
holds only with the very build that made the save, and costs ~2.5 h a
world (150 epochs × 60 s). Option 3 ends on the save's own epoch, so the
outlines stay the save's: the live history writes the terrain of epoch
N − K into the save beside its end state, and the job replays K epochs at
budget 1. Option 1 keeps the painted valleys.

**What option 2 takes, and what it costs:**
- **The same build.** A replay reproduces the world only with the code
  that made it; the save's `history:` block names the build per run
  (world/save/worldHistory.ts). A world whose runs span two builds cannot
  be replayed; the job refuses it rather than baking a third world.
  Confirmed 2026-10-01: no fallback to refining the end state — a world
  saved before the code hash, or with other code, gets no level 1 until it
  is made again (the engine changes too fast to carry old worlds).
- **The whole recipe, in order.** `history:` holds every Archean and
  tectonics run with its values and epochs; still missing for a replay
  (worldHistory.ts says so): the resets and the loads in order. A reset
  already empties its list, so what is left is to verify that the lists
  alone reproduce the save's level 0 bit for bit at budget 4 — the
  replay's own check before it runs at budget 1.
- **A sibling world.** Level 1's outlines are its own, not the save's: the
  coast differs by 5–8 % from the first epoch (measured over 5 epochs;
  over 150 the drift is unmeasured — the erosion's feedback into the
  tectonics decides it). Level 0 stays the preview; level 1 and below are
  the world.
- **Time.** ~150 epochs × ~60 s ≈ 2.5 h a world on one machine, which is
  why the coordinator and its workers come first (fork 4).

**Open, to be measured:** how far a whole replay drifts from the save
over 150 epochs (the erosion's feedback into the tectonics: sediment
export, eustasy, flexure), and how many epochs at budget 1 earn the
valleys — on budget 1 the river network settles in 1–2 epochs (drainage
density 0.206 → 0.208 km/km², then ~1 % an epoch); a valley-depth measure
(channels below the highest point within ~10 km) is still missing. Option
3 stays the fallback should the replay prove unreproducible.

## Fork 3 — tile sizes: DECIDED

A job should hold ~50–250 k nodes and read its parent once. Per level,
in macro cells (7.8 km) — estimates from the spacing, to be measured:

| Level | Tile | ~km | Land tiles (12 % land) | Nodes a tile |
|---|---|---|---|---|
| L2 | 16 × 16 | 125 | ~1 000 | ~60 k |
| L3 | 8 × 8 | 62 | ~4 000 | ~50–250 k (built: 19–48 k, the floor rarely reached) |
| L4 | 2 × 2 | 16 | on demand | ~250 k |

Square tiles stay the stored unit; how a level is COMPUTED may differ
(fork 5).

## Fork 4 — the coordinator: DECIDED — graph and NATS from the start

The coordinator plans a level as a graph of small deterministic
computations and gives every one whose inputs are ready to a free worker
(design/tile-coordinator.md). Its one rule: **every dependency is declared
before the computation starts** — "B waits for A" is deterministic, "B
uses A if A is done" is not.

**Decided 2026-10-01: the graph (stage B) and NATS (stage C) from the
start**, not the batch stage A first; the tile pick in the finishing step
goes with it (its seven `generator.finishing.tile.*` keys). The stages
below stay as the description of what the coordinator does.

- **Stage A — batches, no dependencies.** "Refine the world" orders L1,
  then all L2 land tiles, then all L3, as block jobs that read their
  parent once (today every tile job reads all of its parent again: ~1 GB
  and half its time). The network stays frozen (tile-jobs.md answer 4),
  so the tiles are independent. The tile pick in the finishing step goes.
  Lives in the jobs module; its state in bbolt (decided 2026-09-30).
- **Stage B — flow order.** A tile depends on the tiles whose outflow runs
  into it (from L1's drainage); the outflow over an edge becomes a fixed
  input of the tile below. Cycles across an edge are cut at a fixed edge
  with the parent's values. This brings the small streams across tile
  edges (fork 6) and needs the graph.
- **Stage C — NATS.** A JetStream work queue when workers run on more than
  one machine (Kubernetes pods, a home machine over a leaf node); bulk
  bytes stay HTTP, the queue carries references. Not before stage B has a
  real fleet to feed.

## Fork 5 — seams: DECIDED

The pinned edge line holds (built). **Staggered grids:** each level's tile
grid is shifted by half a tile against the level above, so a level's seam
runs through the inside of the tiles of the level below and is eroded
again there; only the finest level's seams remain. Catchments as tiles
(computing by basin, storing in squares) stay an option for stage B.

## Fork 6 — inflow: DECIDED — through the coordinator

Today a tile takes inflow only from level 1's river graph; small streams
that cross an edge are lost. Decided: inflow at every edge node, from the
upstream tile's own outflow in flow order through the coordinator's graph
(fork 4); where no upstream tile is computed at that level, from the
parent's discharge at the edge node.

## Fork 7 — the rain: DECIDED — measure, then build

The climate stays on its 256 × 128 grid (~62 km). Below level 0 the rain
is downscaled onto each level's own terrain with an orographic model
(Smith & Barstad's linear model, FFT, cheap) from the coarse climate's
wind, moisture and temperature, its totals tied to the coarse cells. Used
for the erosion's water and the hydrology in the L1–L3 jobs, never in the
live history (its erosion is calibrated on the coarse rain). Measured
first on one L1: how far the downscaled rain departs from the coarse one
over the ranges, and what that does to the valleys' discharge.

## Fork 8 — where the bus runs: DECIDED — its own target, `relay`

The NATS server (JetStream) is a target of its own, `relay`, not part of
`jobs`:

- **Its own state.** JetStream keeps the queue on disk; one process per
  store directory keeps it apart from the coordinator's bbolt.
- **Its own port.** Workers connect to the bus (TCP), not to the jobs
  module's HTTP API; a cluster runs it as its own pod with a volume.
- **Replaceable.** `global.services.relay` pointing at an external NATS
  cluster replaces the target, the same pattern as `services.worlds` and
  `services.artifacts`. Under `-t all` it runs in the process and `jobs`
  connects to it in memory.
- **The name says the role, not the technology** (not `nats`). The relay
  will carry more than jobs later, which is why its subjects are
  namespaced by the module that owns them (fork 9).

Configuration (key = flag = `CASAS_*` variable), agreed 2026-10-01:

| Key | Default | What |
|---|---|---|
| `-t relay` | part of `all` | the bus: the embedded NATS server with JetStream |
| `relay.storage.type`, `relay.storage.dir.path` | `dir`, `./data/relay` | JetStream's store |
| `relay.listen` | `127.0.0.1:4222` | the workers' port; loopback locally |
| `global.services.relay` | empty: in the process | the bus's URL for `jobs` and the workers when apart |
| `jobs.storage.type`, `jobs.storage.dir.path` | `dir`, `./data/jobs` | the coordinator's state (bbolt, `jobs.db`) |
| `jobs.max-concurrent` (exists) | as today | becomes the number of local workers `jobs` starts and keeps |

No new subcommands. New dependencies: Go `nats-server/v2` and `nats.go`;
npm `@nats-io/transport-node` and `@nats-io/jetstream` (the workers).
Credentials for workers outside the machine come with the cluster.

## Fork 9 — workers and subjects: DECIDED

**Workers.** The job-worker bundle gains a serving mode: it connects to
`relay`, pulls a task from its pool's queue, computes, acknowledges, pulls
the next. It keeps parent levels in memory up to a budget (least recently
used out). A long task reports that it is still working; one that falls
silent past the acknowledgement deadline is handed to another worker —
harmless, a task being pure.

**On demand.** Locally `jobs` starts `jobs.max-concurrent` workers and
keeps them. In a cluster the workers are a Deployment scaled by queue
depth (KEDA's NATS JetStream scaler), down to zero when the queue is
empty. Level 4 near the camera goes to an urgent queue workers drain
first, so it does not wait behind thousands of level-3 tiles.

**Level 1's replay** is one task of ~2.5 h. It writes a checkpoint to the
artifact store every few epochs, and a task handed out again resumes from
the last one — deterministic, the checkpoint being so.

**Subjects.** The first token is the module that owns the subject, as a
module's routes live under `/v1/<module>`; no module publishes into
another's namespace.

| Subject | Stream | What |
|---|---|---|
| `jobs.task.<pool>.<jobId>` | `JOBS_TASKS` (work queue) | the micro-computations; `<pool>` e.g. `level`, `tile`; the job's id last, so a cancel purges its tasks in one call |
| `jobs.task.<pool>-urgent.<jobId>` | the same | the urgent ones (level 4), a pool of their own |
| `jobs.event.<jobId>` | `JOBS_EVENTS` (short retention) | progress and the end; `jobs` passes them to the client as server-sent events — the client never speaks NATS |
| `world.event.<uid>`, `artifacts.event.…` | later, a stream each | e.g. a world saved, an artifact written |

## The relay and the coordinator, as agreed 2026-10-01

**Packages.**
- `internal/modules/relay/` — the module behind `-t relay`: the embedded
  NATS server with JetStream, its store and its port; no HTTP routes
  (its port is said under `/v1/capabilities`).
- `internal/relay/` — a leaf package like `token` and `identity`: connect
  in the process or to `global.services.relay`, subjects that always start
  with the owning module's name, stream setup. With `cmd/`, the only
  importer of `nats.go`.
- `internal/modules/jobs/` gains the coordinator: the graph and the tasks'
  states in bbolt (`jobs.db`). The routes under `/v1/jobs` stay the outside.

**Terms.** A *job* is what is ordered ("refine the world"): a graph of
*tasks*, its progress the share of tasks done. A *task* is one pure
computation with its dependencies declared before it starts and one
artifact as its result.

**Subjects** (the first token is the owning module; the task id is the
message id, so JetStream drops a task published twice):

| Subject | Stream | What |
|---|---|---|
| `jobs.task.<pool>.<jobId>` | `JOBS_TASKS`, work queue | a task: id, kind, world uid and id, input artifact keys, parameters, output key |
| `jobs.done.<taskId>` | `JOBS_DONE`, work queue, read by the coordinator | the artifact key, pipeline version, duration — or the error |
| `jobs.event.<jobId>` | `JOBS_EVENTS`, short retention | progress, for the client |

**Flow.** The coordinator writes a job's tasks and their dependencies to
bbolt and publishes every task with none open. A worker pulls a task
(acknowledgement deadline ~5 min, a "still working" every 30 s, at most 5
deliveries), writes its artifact to the artifact store as today, publishes
`done`, acknowledges. The coordinator marks the task, releases its
dependents. On a restart, what bbolt holds as dispatched is still in
JetStream; what is ready and not dispatched is published again. A
computation's error ends the task (it is deterministic); a transient one
(a store out of reach) is delivered again.

**Workers.** `job-worker.mjs --serve --relay <url> --pool <pool>` pulls in
a loop and keeps parent levels in memory (least recently used out); the
one-shot form stays for the harnesses. Locally `jobs` starts
`jobs.max-concurrent` serving workers and restarts one that dies; the
local subprocess runner goes. Kubernetes keeps its runner (a Job per
order) until the worker Deployment (scaled by KEDA) is built.

**Access.** Now: the relay listens on loopback only, without credentials —
reachable by `jobs` (in the process under `-t all`) and the workers it
starts, as safe as today's subprocesses. In a cluster: workers prove
themselves with our own tokens, signed with the shared key and checked by
NATS's auth callout — one identity system, not a second set of passwords.

**Progress to the client.** Server-sent events: `jobs` reads
`jobs.event.*` and serves them at `/v1/jobs/events`; the jobs window and
the finishing step subscribe, and fall back to polling when the stream
drops.

**Build order.** (1) the relay module, its config and wiring, Go tests
with an embedded server; (2) `internal/relay`, `jobs` connects and
declares its streams; (3) the coordinator on bbolt with today's two task
kinds (level 1, tile), a Go test with a fake worker, and the event
stream; (4) the workers' serving mode and the local pool; (5) the client:
the tile pick goes, "refine the world" orders the graph, progress by
events; (6) Kubernetes, later. Steps (1)–(5) built 2026-10-01; the
refine plan is level 1 then every tile with land, today's two task kinds.

## Measured 2026-10-01 (build steps 1 and 2)

**Step 1 — valleys and rain** (seed 434430010, 120 coupled epochs at the
new defaults, land p99 5.5 km; today's level 1: 6.3 M nodes, ~1.6 km land
spacing, 139 s). Valley depth = highest point within R − channel, mountain
channels (> 1500 m), R = 10 km, p50/p90: level 0 153/331 m; level 1 after
synthesis only 295/555 m; after its 12 rounds 211/415 m; after 120 rounds
with uplift 142/299 m. The depth level 1 has over level 0 is the
synthesis'; its erosion fills channels (+16 m median) and lowers
hillslopes (−20 m), and runs longer make the valleys shallower still.
**The engine does not incise at ~1.5 km spacing** — to be found and fixed
before level 1 replays the history at budget 1 (fork 2), or the replay
earns shallower valleys than it starts from. *Found and fixed the same day:*
three closures were set for level 0's ~127 km² nodes and did not scale —
the sub-grid drainage area (a constant 500 km²), the land settle lengths
and the hillslope diffusivity. They now scale with each node's own area,
and a channel head (5 km²) keeps ridges from being cut
(surface/erosionEngine.ts). On level 1 with history-like settings the
valleys deepen over the run (d10 256 → 317 m over 120 iterations) where
they shallowed (169 → 117 m); level 0 changes a little (land p99 5.5 →
5.2 km, mountain d10 p90 331 → 377 m).

Rain downscaled (Smith & Barstad, FFT, ~25 s a world): moves 20–35 % of
the mountain channel nodes and changes small streams' discharge 0.1–1.6×;
big rivers ±5 %; the valleys' statistics < 1 % under the same erosion. So:
into the levels' hydrology first, into their erosion once a level
incises. Found on the way: the bake's hydrology reads the coarse rain
nearest-cell; bilinear alone moves 11 % of the channel nodes.

**Step 2 — the replay's ground truth** (2048 × 1024, budget 4): a save's
`history:` replays level 0 bit for bit — through the runtime's messages
and directly (what a job worker does), with any stop points and with the
engine pool, `sedimentExportM3` included; also across a tectonics reset,
an Archean save-and-reload and the save chain. Two cases break it, both
fixable: (1) a tectonic load is not recorded, and a restored world
recomputes the climate at its first epoch (`decodeCoupledTerrain` drops
the weather cache), shifting the climateEvery schedule; (2) the Archean
count loses an epoch when the hand-over is committed while a step's render
is in flight (the finalize clears the Archean before that step reports).
Also: the value → message conversions live in the screen (the replay must
share them), and the build id (`git describe --dirty`, fixed at Vite's
start) does not identify the code — a content hash of the generator
sources should.

## Measured 2026-10-01 (build step 4, level 1 by replay)

World "Calvessor" (seed 983721401, 2048 × 1024, made fresh with the code
of the day), level 1 ordered from the finishing step on the local server,
one worker: **2 h 30 min** (9 008 s) for the check and the replay at
budget 1; **4.32 M nodes** (3.46 M on land, ~2.5 km land spacing) — more
than the 1.85 M measured on Astrakan at budget 1, this world being more
mountainous. The worker held **6.2 GB** (its heap ceiling is 6 GB, the
engine threads included); a checkpoint is **763 MB**, written every ten
epochs and removed at the end.

Valley depth (method of step 1: highest point within R minus the
channel, channels ≥ 1 macro cell of drainage, mountains > 1 500 m), p50 /
p90:

| | mtn d10 | mtn d5 | low d10 | drainage density km/km² |
|---|---|---|---|---|
| L0 (the save) | 58 / 168 m | 29 / 87 m | 43 / 124 m | 0.069 |
| L1 replayed | 209 / 576 m | 113 / 364 m | 105 / 553 m | 0.090 |
| L1, lakes filled | 205 / 594 m | 105 / 351 m | 93 / 527 m | 0.092 |

The replayed level 1's mountain valleys are **3.6× deeper than level
0's**; on the old level 1 (refined, Astrakan, step 1) the ratio was
1.4 / 1.25. Level 1 holds three times the land in closed depressions
(11.7 % against 4.2 %, depth p50 80 m, 25 230 water bodies); measured on
the filled surface the valleys are as deep, so the depressions are not
what makes them. Not yet known: what the depressions are (overdeepened
glacial troughs, flexure, the engine's own pits) — to be looked at with
the incubator.

**Correction, 2026-10-02: much of that depth was roughness.** Seen in
the incubator as rows of scales: level 1's ground is 5–8× rougher per km
than level 0's (|z − mean of the neighbours| over the spacing, p50
4.5–7.2 against 1.0–1.2 m/km), twice the single-node peaks and pits, 432
below-sea nodes inland. It is in the relief, not in the tectonic
baseline (p90 0.5 m/km), and it grows epoch by epoch at budget 1 while it
stays flat at budget 4. A node-scale peak raises the valley measure's
maximum and a pit lowers its channel, so the 3.6× above is inflated.
Switched off one at a time on a 512 × 256 world at budget 1 (roughness
p50 / p90 m/km): the folds 10.0 → 5.6 in the mountains only; a channel
head 10× larger made it worse; the hillslope diffusion's size scaling is
the lever — `hillRefKm2` 127 → 25 gave 5.8 / 28.0 → 1.6 / 8.5, and the
mountain valleys 354 / 1 029 → 158 / 555 m against level 0's 107 / 293.
Built: the scale's power `hillScaleExponent` 0.5 (surface/erosionEngine.ts)
— a level-0 node stays where it was calibrated, a level-1 node gets ~0.22
of it. On the same world: level 0 1.2 / 4.8 m/km (was 1.1 / 4.4), its
land p99 4 187 m (3 997), its valleys 116 / 314 m (107 / 293); level 1
2.1 / 9.7 m/km, valleys 181 / 615 m — **1.7–2.1× level 0's**, the honest
figure. Every level and tile made before is outdated.

**The tile levels on the same world** (2026-10-01/02, a refine plan to
level 3 on the local server, two workers, level 1 reused): the plan took
~8 s from the stored level 1 (2 610 level-2 and 8 763 level-3 tiles, its
report 1.31 MB — past NATS's default of 1 MB, so the relay's limit is
8 MB); the tiles took **3 h 53 min**.

| | tiles | nodes a tile (mean) | nodes in all | bake a tile (mean / max) | on disk |
|---|---|---|---|---|---|
| L2 | 2 610 | 12.7 k | 33 M | 0.5 / 2 s | 1.3 GB |
| L3 | 8 763 | 85 k | 749 M | 2.8 / 8 s | 30.5 GB |

The bakes alone sum to 7.2 worker-hours; the rest is reading parents.
Level 3 is the size to watch: 30 GB for one world, without a cap on the
artifact store (`artifacts.cap` empty by default) nothing evicts it.

## Step 5 — the tile levels: DECIDED 2026-10-01, plan

What step 5 of the build order builds, worked out against the code as it
stands (meshTile.ts, meshTileBake.ts, the coordinator). The four points
at the end were decided by the user on 2026-10-01.

**One tile, a level as a parameter.** Today's tile is one fixed shape
(`TILE_CELLS` 8, `TILE_BUDGET` 1/16, `TILE_LEVEL` 2). It becomes a spec
per level — cells, budget, grid offset, halo, edge steps, placement levels,
position quantum — and `TILE_CONSTANTS` per level enters that level's
pipeline version:

| Level | Cells | Budget | Offset | Parent |
|---|---|---|---|---|
| L2 | 16 × 16 | 1/4 | 0 | L1, the global mesh |
| L3 | 8 × 8 | 1/16 | 4 cells | the L2 tiles it overlaps |
| L4 | 2 × 2 | 1/64 | 1 cell | the L3 tiles it overlaps (step 7) |

Today's tile is L3's shape; its artifacts (`L2:x,y` today) are outdated by
the change of level and parent. The float32-exact frame (`MAX_SIDE` 16
cells at a quantum of 2⁻²⁰) does not hold an L2 tile with its halo
(18 cells); the quantum scales with the level's floor spacing, so L2 runs
at 2⁻¹⁸ with a 64-cell frame.

**Staggered grids (fork 5), made exact.** A level's grid is shifted by
half of ITS OWN tile against the level above: L2's seams at 16k fall in
the middle of L3's tiles [16k − 4, 16k + 4]; a shift of half the PARENT's
tile (8) would put them on L3's seams. Only the finest level's seams stay.

**A patchwork parent.** An L3 tile's parent is not one mesh but the L2
tiles it overlaps with its halo (two, four at a corner). `TileParent`
becomes a sampler over tile artifacts: a point is answered by the tile
that holds it, its edge row shared by both neighbours, so the surface is
continuous; halos are never read. L2's parent stays the global L1 mesh
(`TileParent` as today). A worker caches L1 once and the few L2 tiles an
L3 tile needs.

**The graph (fork 4, stage B; fork 6).** When level 1 finishes, its
worker plans both tile levels from L1's drainage and reports them; the
coordinator only wires what it is told:

- the tasks: every L2 and L3 tile with land or shelf;
- the parent edges: an L3 tile waits for the L2 tiles it overlaps;
- the flow edges: a tile waits for the tiles of its level whose water
  enters it, read off L1's routing (the drainage crossing each shared
  edge, summed). For L3 the same L1 drainage is used, not L2's, so the
  whole graph is known before the first tile runs.
- cycles: two neighbours drain into each other at different places along
  their edge, so cycles are the rule, not the exception. Cut
  deterministically from L1 alone: of a pair, only the direction with the
  larger crossing discharge is an edge; remaining longer cycles are cut at
  their weakest edge, visited in tile order. A crossing against a cut edge
  takes its inflow from the parent's discharge at the edge, as today.

The worker reports `tasks: [{ level, x, y, deps: [[level, x, y], …] }]`
in place of today's `tiles`; the coordinator turns each dep into a task
id, adds the dependency on level 1, and publishes in that order. Go stays
ignorant of the hydrology.

**Inflow at every edge node.** A tile's artifact gains its outflow: per
edge-row node, the discharge (engine units) that left the interior over
it. The tile below reads its upstream tiles' outflow on the shared edge
and adds each to the drainage weight of the first node inside (today's
mechanism, applied per edge node instead of per L1 river crossing). Small
streams then cross tile edges instead of being lost.

**The order of building, each with its check:**
1. The tile spec per level; L3 = today's tile with the offset, still on
   L1. Check: today's tile harness passes per level; seams continuous.
   *Built 2026-10-01* (meshTile.ts `TILE_SPECS`, a tile's id carries its
   level, stage `L<level>:x,y`, a pipeline version per level): the seam,
   halo, world-seam, drainage and artifact checks of harness:mesh pass for
   L3 and L2 alike. A refine plan up to stage 2 now bakes L2's 16-cell
   tiles; old `L2:x,y` artifacts are outdated.
2. L2 tiles on L1 (inflow from L1's river graph, as today). Check:
   valley depth L1 vs L2 on one region; time and nodes per tile.
3. The patchwork parent; L3 on L2. Check: the parent surface continuous
   across L2 seams; L3 valley depth vs L2.
   *Built 2026-10-01* (meshTile.ts `parentTilesOf`, `tileParentFromTiles`;
   the worker reads the level-2 tiles an L3 tile overlaps, level 1 once
   per worker for the inflow and the synthesis' relief, `TileParent.macro`
   — the relief looks ~32 cells around, past any patch). harness:mesh: the
   join holds every L2 node at its height, a shared one once; two L3
   tiles, each on its own patchwork, meet on their edge; a tile on it
   drains. Found on the way: the bootstrap lattice meets tile corners, so
   a point landing on a lattice node is inserted again (as the tile does).
   The valley depths wait for a real L1.
4. The graph: the L1 task reports tasks and deps, the coordinator wires
   them; the outflow artifact and the inflow at every edge node. Check:
   across every shared edge, the outflow upstream equals the inflow
   below; no lost stream (channels ending at an edge) on one region.
   *Built 2026-10-01* (generator/pipeline/tilePlan.ts; the worker plans
   from the level-1 ARTIFACT, decoded and routed, so a fresh and a reused
   level 1 plan alike; the report's `tasks` replace `tiles`; the tile
   artifact gains `tileOutflow.f32`; a crossing from a non-upstream side
   still comes from level 1's rivers). harness:mesh: the plan acyclic and
   whole (synthetic world: 114 + 369 tiles, 992 flow edges); an upstream
   tile's outflow over the shared edge is the tile's inflow to the float
   sum (242.15 = 242.15 over 102 edge nodes); the water arrives in the
   tile's drainage. Found on the way: an edge node in sparse ground can
   have only edge nodes around it, so its water enters at the nearest
   inside node by the mesh (a breadth-first search), not by a fixed
   neighbourhood. The coordinator test runs a plan in its order (upstream
   first, parents first, level 3 dropped below stage 3).
5. The L3 button in the finishing step; `maxRefineStage` 3.
   *Built 2026-10-01.* End to end on a fresh 512 × 256 world (local
   server, two workers, a refine plan to level 3): 23.5 min, no failure —
   level 1 629 k nodes in 67 s; 391 level-2 tiles (17 k nodes, 0.3 s
   each); 1 401 level-3 tiles (97 k nodes, 1.8 s each). On 2048 × 1024
   that suggests a few hours for the tile levels on two workers; measured
   on a real world is still to come.

**Decided 2026-10-01 (all four as proposed):**
1. The offset is half the level's own tile — the reading of fork 5 that
   keeps seams apart.
2. A cycle is cut by the larger crossing discharge, from L1 alone.
3. L3's flow edges come from L1's drainage, not L2's (all known up
   front; L2's own drainage would plan L3 only after every L2 tile).
4. The erosion rounds are 12 on every level for now, calibrated with the
   valley-depth checks of 2 and 3.

## Build order

Each step ends with its measurement; the next starts on its result.

1. **Measure on today's ladder with the new ranges.** A fresh world, its
   L1 (today's job), the valley-depth measure and the rain comparison.
2. **The replay's ground truth.** Replay a save's `history:` at budget 4
   and compare with its level 0 — bit for bit, or say where it parts.
   Fill what the history lacks.
3. **The relay and the coordinator.** The `relay` target (fork 8), the
   jobs module's coordinator with its graph in bbolt, the workers' serving
   mode (fork 9). The tile pick goes.
4. **L1 by replay** at budget 1, as the coordinator's first computation.
   *Built 2026-10-01* (world/replay.ts, scripts/jobWorker.ts replayLevel):
   the worker refuses a history whose runs' code is not its own (its
   bundle carries the hash, scripts/buildWorker.mjs), replays at budget 4
   and compares the mesh with the save's bit for bit, then replays at
   budget 1 with a checkpoint every 10 epochs where one restores exactly
   (before an epoch that computes its climate), and derives the waters
   from the last epoch's climate (meshBakeStage.levelHydrology).
   `levelBudget` is the ladder now (4, 1, 1/4, 1/16). The pipeline harness
   checks the replay against the runtime across a load and a resume. Open:
   the waters use the history's coarse climate, not the climate step's
   refinement; the time at 2048 × 1024 is still to be measured.
5. **L2 tiles at 1/4, 16 × 16**, from L1; today's tile job moves to L3
   with L2 as its parent; staggered grids; inflow at every edge node, then
   in flow order through the graph.
6. **The rain downscaling** in the L1–L3 jobs, if step 1 says it pays.
7. **L4 on demand** near the camera (the incubator first).


## Addendum 2026-10-03: workers in a cluster

**Scaling: the jobs module, not KEDA.** The worker Deployment ships with
`replicas: 0` and a label the coordinator finds it by. The coordinator
scales it up when tasks wait and back to zero when every job is through —
no scaling down while any job runs, so no pod is ever stopped in the
middle of a task, and no busy/idle bookkeeping per pod is needed. Upper
bound: `jobs.max-concurrent`, the same key that counts the local workers.
Why not KEDA: the coordinator knows the plan, not only a queue length; it
needs no operator installed by a cluster admin; and the jobs target stays
able to run alone. Needed: `get`/`patch` on `deployments/scale` in the
namespace's Role. NOT BUILT yet — steps 2 and 3 below.

**Access: BUILT the same day.** In a mode that checks identity the relay
admits only tokens of this server, minted with the shared key for the
bus's own audience (`token.AudienceRelay`), checked in the process through
the embedded NATS server's custom authentication — what the auth callout
is for a server that is not embedded; no NKeys, no accounts, no second
set of credentials.

- A module connects as `module:<name>` and may do anything. Its token is
  minted afresh at every (re)connect.
- A worker connects as `worker` and may do what the jobs module grants
  (`jobs.WorkerGrant`): pull from the task stream through the shared
  consumer, acknowledge, report on `jobs.done.*` and `jobs.event.*`, hear
  `jobs.cancel.*`. It may not manage a stream or read other subjects. The
  grant is composed in `cmd/`, so the relay names no module's subjects.
- A worker's HTTP access is unchanged: each task carries its job's own
  token, narrowed to its world.
- Locally, the jobs module gives each worker it starts a token in its
  environment (`RELAY_TOKEN`), never on its command line.
- In mode `none` the relay checks nobody, as before; it must then stay on
  loopback.

The deployment listens on `0.0.0.0:4222`, exposed as port `relay` of the
`casas-eternas` Service (not on the Route); the image now passes the relay's
and the jobs module's storage under `/data`, which `-t all` needed since
the relay arrived and the read-only root file system refused.

**Order from here**: (2) the worker Deployment, `replicas: 0`, labelled,
with its credential from a Secret; (3) the scaling loop in the jobs module;
(4) the Kubernetes Job runner and `job.yaml` go, and a cluster runs the
coordinator as a machine does.

**Service accounts, decided and BUILT the same day** (with step 2): workers
in the cluster and outside it prove themselves the same way — with a
service account of the auth system, not with a token the jobs server would
write into a Secret, and not with Kubernetes service accounts (TokenReview
needs a cluster-scoped role a namespace owner cannot bind). A service
account is a name and a secret in auth.db, in buckets of its own: never a
user, no login, no world. `casas-eternas auth service add|list|delete|rotate`
over the admin socket; `add` and `rotate` print `<name>:<secret>` once, on
stdout alone, so it pipes into a Secret. A worker reads that file
(`RELAY_CREDENTIALS`) and trades it at `POST /v1/auth/token` (basic auth,
public like the login) for a bus token of subject `worker:<account id>`,
valid an hour, and again at half its life — reading the file anew each
time, so a rotated Secret needs no restart. Deleting the account ends its
access within that hour; no process ever looks the account up. The jobs
server's own local workers keep their plain `worker` token (`RELAY_TOKEN`).

The worker Deployment is in deploy/manifests.yaml: `replicas: 0`, the
label `casas-eternas/component: worker` the coordinator will find it by,
its pods `component: worker` beside the server's `component: server`
(same `app`), so neither the server's Deployment nor the Service selects
them, no API token mounted, 7 Gi
requested (a level-1 replay held 6.2 GB), the credential from the Secret
`casas-eternas-worker`.

**Step 3, BUILT the same day**: in a cluster the coordinator runs too, and
`internal/modules/jobs/scaler.go` sets the Deployment's replicas every ten
seconds — while any job is open, its handed-out tasks up to
`jobs.max-concurrent` (at least one, never fewer than run), else zero. A
loop that compares and corrects, so a restarted server or a re-applied
manifest is put right. Role: `list` on Deployments, `get`/`update` on
`deployments/scale`. Every job now goes to the workers. Not yet: checkpoints for a
level-1 replay in the cluster (the task directory is local-only), so a
worker that dies mid-replay starts it again.

**Open: a worker outside the cluster.** Not built, and four things short,
the token the smallest of them: the relay reached from outside (NATS's
websocket listener behind a Route, so the router's TLS covers it), the
task specs naming the server's public URL instead of its pod IP, and a
worker token handed over by an operator — an admin command over the
socket, its name to be agreed before it is written. The worker token
itself needs no change. **mTLS was considered and declined**: it is a
second identity system (a CA, issuing and revoking certificates), and a
browser cannot present a client certificate on a websocket — the client
joining the bus later would be locked out. Tokens work for the Go server,
the Node worker and a browser on `nats.ws` alike; a browser would be one
more grant beside the worker's.

**Step 4, BUILT the same day**: the Kubernetes Job runner is gone — its
runner, `job.yaml`, the Job calls of the cluster client, the
`POST /v1/jobs/{id}/progress` route a Job reported through, the spec's
`jobsUrl`, `CASAS_JOBS_IMAGE` and the `jobs.batch` rights. A server in a
cluster refuses to start without the relay. What stays: the job tokens
(every task carries one for its world) and `CASAS_POD_IP` (the address the
tasks name). The run-once deadline trap of docs/operations went with the
Jobs: the workers are long-lived pods. docs/decisions/distributed-bake.md
records the Job design this replaces.

**The local subprocess runner went the same day**: off a cluster too the
jobs module now runs only over the relay — its own serving workers, never a
subprocess per job. The `Runner` interface, the in-memory queue and their
cancel path are gone; the jobs module refuses to start without a relay, as
cmd/ already did. `bakeRunner` in `/v1/capabilities` always answers
`relay`.

## Status

2026-10-04: building — level 1 by replay, the coordinator, the relay and the worker Deployment are built; levels 2 to 4 as the ladder sets them are open.

decided 2026-10-01 — the ladder's five budgets (fork 1), level 1 as a replay
of the whole history (fork 2), the coordinator with its graph and NATS from
the start and the tile pick removed (fork 4). Also decided 2026-10-01: the
tile sizes (fork 3), the seams (fork 5), the inflow through the coordinator
(fork 6), the rain to be measured then built (fork 7), and the bus as its
own target `relay` (fork 8). and the workers and the relay's subjects (fork
9). Built 2026-10-01: the relay, the coordinator and its workers, and the
client's refine plan (build order step 3); level 1 by replay (step 4); the
tile jobs it starts from are built too (decisions/tile-jobs.md). The
exploration behind it is design/tile-coordinator.md. ADDENDUM 2026-10-03: in
a cluster the jobs module scales the worker Deployment itself (replacing
KEDA); the relay checks this server's own tokens (BUILT).
