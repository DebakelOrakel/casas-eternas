---
summary: The detail ladder after the first tile jobs — five levels a factor of 4 apart in spacing (budget 4, 1, 1/4, 1/16, 1/64); level 1 replays the whole history at its own density instead of refining the end state; levels 2 and 3 are tile jobs ahead of time, level 4 near the camera only; a coordinator plans the tiles as a graph and hands them out over NATS from the start; the tile pick goes.
date: 2026-10-01
area: generator
stage: decided
status: decided 2026-10-01 — the ladder's five budgets (fork 1), level 1 as a replay of the whole history (fork 2), the coordinator with its graph and NATS from the start and the tile pick removed (fork 4). Also decided 2026-10-01: the tile sizes (fork 3), the seams (fork 5), the inflow through the coordinator (fork 6), the rain to be measured then built (fork 7), and the bus as its own target `relay` (fork 8). and the workers and the relay's subjects (fork 9). Nothing of it built; the tile jobs it starts from are (decisions/tile-jobs.md). The exploration behind it is design/tile-coordinator.md.
---

# The detail ladder

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
| `jobs.task.<pool>` | `JOBS_TASKS` (work queue) | the micro-computations; `<pool>` e.g. `level`, `tile` |
| `jobs.task.<pool>.urgent` | the same | the urgent ones (level 4) |
| `jobs.event.<jobId>` | `JOBS_EVENTS` (short retention) | progress and the end; `jobs` passes them to the client as server-sent events — the client never speaks NATS |
| `world.event.<uid>`, `artifacts.event.…` | later, a stream each | e.g. a world saved, an artifact written |

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
earns shallower valleys than it starts from.

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
5. **L2 tiles at 1/4, 16 × 16**, from L1; today's tile job moves to L3
   with L2 as its parent; staggered grids; inflow at every edge node, then
   in flow order through the graph.
6. **The rain downscaling** in the L1–L3 jobs, if step 1 says it pays.
7. **L4 on demand** near the camera (the incubator first).
