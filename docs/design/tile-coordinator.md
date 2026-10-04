---
id: DES-0022
title.en: Tile coordinator
title.de: Kachel-Koordinator
summary.en: A direction for the detail ladder after the first tile jobs — level 1
  replays the history at a finer budget, the finer levels come as tiles, and
  a coordinator plans them as a graph of small deterministic computations
  that long-lived workers take one by one. Covers the ladder, the
  coordinator and its one rule, the seams, the transport and the
  coordinator's state. Ideas and measurements; nothing decided.
summary.de: Eine Richtung für die Detail-Leiter nach den ersten Kachel-Jobs — Level 1
  spielt die Geschichte in einem feineren Budget nach, die feineren Ebenen
  kommen als Kacheln, und ein Koordinator plant sie als Graph kleiner
  deterministischer Rechnungen, die langlebige Worker einzeln übernehmen.
  Behandelt die Leiter, den Koordinator und seine eine Regel, die Nähte, den
  Transport und den Zustand des Koordinators. Ideen und Messungen; nichts
  entschieden.
area: platform
stage: idea
createdAt: 2026-09-30
concepts: [generator.concept.detail-levels, generator.concept.jobs]
related: [DEC-0032, DEC-0031]
---

## Where this starts

The tile jobs of [decisions/tile-jobs.md](../decisions/tile-jobs.md) are
built: level 1 is one global job, level 2 is one job per tile, each tile a
function of level 1, its id and the seed, with a pinned edge row so that
neighbours meet. Rivers and valleys are the first priority of the
generator, and two measurements of 2026-09-30 (world "Astrakan-2",
2048 × 1024, 12 % land) changed the view of where their quality comes
from.

**Cost of one history epoch, by budget** (the history continued from the
save, climate and remesh every epoch):

| Budget | Nodes | Seconds an epoch | Largest phases |
|---|---|---|---|
| 4 (the live history) | 122 k | 5 | remesh, climate, ice |
| 2 | 410 k | 14 | remesh 4, ice 3 |
| 1 | 1.85 M | 60 | remesh 19, ice 13–16, erosion 5 |
| 0.5 (level 1 today) | 7.6–8.4 M | 265–363 | remesh 82–113, ice 82–88 |

**Drift against the live budget, same epoch:** 5–8 % of the land cells
change between land and sea from the first epoch on and do not grow over
five epochs (the finer coastline, not moved continents); the mean height
difference on land is 30–70 m and grows 2–3 m an epoch. The outlines
agree; the valleys, the rivers and the coast detail differ. Any
continuation — at any budget — also ages the world: after five epochs
24–26 % of the coast cells differ from the save, from the plate motion.

**Today's level 1** gets no history: it refines the final state, adds
synthesis and erodes for 12 rounds without uplift. Its valleys at the
kilometre scale are painted and briefly worn, not earned.

## The ladder

The direction: spend the physics where it is affordable. Level 1 replays
the history — all of it, or most of it — at a finer budget, and the finer
levels come at the end, as tiles. With a factor of 4 in spacing a level:

| Level | Budget | Spacing from | Kind |
|---|---|---|---|
| L0 | 4 | 8 km | live history, the preview |
| L1 | 1 (or 2) | 2 km (4 km) | global, the history replayed |
| L2 | 1/4 | 500 m | tiles, computed ahead |
| L3 | 1/16 | 125 m | tiles, ahead or on demand, reads L2 |
| L4 | 1/64 | 30 m | tiles near the camera only |

At budget 2 a replay costs ~14 s an epoch (150 epochs ~35 min, one job)
and the level stays small (~400 k nodes, ~10 MB): every tile job reads
it in seconds, and level 1 needs no splitting. Smaller steps between the
levels let the synthesis invent less and the erosion earn more.

Open before it can be decided:

- **Does the erosion feed back into the tectonics?** Sediment export,
  eustasy, crust and land. If the plates, the rafts and the uplift do not
  depend on the surface, a replay at another budget diverges only at the
  surface (the drift above); if they do, it may diverge in its outlines
  over a hundred epochs — the history is chaotic: small differences grow.
  To be read in the code, then measured over long runs.
- **A replay from the recipe holds only with the same build** (code
  drift). Continuing from a checkpoint instead needs the checkpoint K
  epochs before the end in the save, so that the replay ends on the
  save's epoch and does not age the world.
- **How many epochs earn the valleys?** On budget 1 the river network
  settles in 1–2 epochs (drainage density 0.206 → 0.208 km/km², then ~1 %
  an epoch); a valley-depth measure is still missing.

## The coordinator

A tile that only reads its parent cannot know what flows into it from its
neighbour: small streams that cross a tile edge are lost today (the inflow
comes from level 1's river graph only). Tiles that talk to each other
would fix it, and would break the one property the artifact cache rests
on — an artifact is a function of its inputs.

The answer is a coordinator and a pool of workers:

- The **coordinator** holds a graph of small computations and their
  dependencies, gives every computation whose inputs are ready to a free
  worker, and records the results (in the artifact store). A worker that
  dies has its computation given out again; a computation is pure, so
  computing it twice does no harm.
- The **workers** live long and wait for work. A worker keeps level 1 in
  memory and computes tile after tile on it — today every tile job reads
  all of level 1 again (~1 GB and half its time).

**The one rule: every dependency is declared before the computation
starts.** "B waits for A" is deterministic; "B uses A if A is already
done, else level 1" is not — it would depend on timing. Which worker
computes what, and when, then changes no byte.

What the graph can hold:

- **Flow order.** A tile depends on the tiles whose outflow runs into it
  (level 1's drainage); the outflow over an edge becomes a fixed input of
  the tile below. Separate catchments are independent and run in
  parallel; the longest path is the longest river, ~50–100 tiles × ~2 s.
  Where rivers cross between two tiles both ways, the cycle is broken at
  a fixed edge with level 1's values, or the two tiles are one
  computation.
- **Rounds.** Round r of a tile depends on round r − 1 of its neighbours —
  still a graph, still deterministic, and the tiles need not run at the
  same time. Seams could relax over a few rounds.

**Why this is not the split bake that failed**
([splitting-the-bake.md](splitting-the-bake.md),
[nats-transport.md](nats-transport.md)): that one had to reproduce the
WHOLE bake from pieces and could not — the hydrology is global and the
system amplifies small differences. Here nothing whole exists to
reproduce: a tile level is DEFINED as its graph of computations. The
global part (the network) is level 1's, frozen; the tiles only receive
it.

The coordinator belongs to the jobs module, which already holds the queue
and the runners. It pays when thousands of tiles run; for one world, jobs
of blocks of tiles (one read of level 1 each) are enough.

## The seams

- **Built:** the pinned edge row — both neighbours hold the parent surface
  on their shared line (tile-jobs.md).
- **Staggered grids.** Each level's tile grid is shifted by half a tile
  against the level above. A seam of level 2 then runs through the inside
  of level-3 tiles and is eroded again there; only the finest level's
  seams remain, and they are the smallest.
- **Catchments as tiles.** Tiles along drainage divides: nothing flows
  across a seam, and a kink on a crest is where a kink belongs. The jobs
  module reserves a `basin` scope for it. Costs: catchments differ in size
  by orders of magnitude (large ones split at confluences into
  sub-catchments, the inflow at one known point), the edge row follows a
  polyline, and the divides are level 1's, frozen. A middle way: compute
  by catchment, store and show in squares.

## Transport

[nats-transport.md](nats-transport.md) placed NATS as a third variant of
the existing seam (closure | HTTP | subject), with trigger 1 "the worker
fleet becomes real". The coordinator is that trigger: a JetStream work
queue makes a worker anything with a credential — a Kubernetes pod, a
home machine over a leaf node — and progress arrives as events instead of
a poll every two seconds. The NATS server embeds in Go, so `-t all`
locally stays one binary. Bulk bytes stay HTTP: the artifacts are
content-addressed blobs; the queue carries references.

## The coordinator's state

The graph, the state of every computation and the references to its
results must survive a restart; the job registry is in memory today and
forgets past a cap. A small embedded database in the jobs target does it:
**bbolt**, as `auth.db` does — one file, one process per store directory.
Chosen 2026-09-30 over JetStream's key-value store: no new technology for
the state, whatever carries the messages.

## Next measurements

1. The feedback of the erosion into the tectonics (code, then long runs at
   two budgets).
2. A valley-depth measure (channels below the highest point within
   ~10 km), for the replay over K epochs against today's level 1.
3. The ladder as proposed on one world: level 1 at budget 2 with K epochs
   of history, level-2 tiles at 1/4 with a longer transient, against
   today's path (level 1 at 0.5, level-2 tiles at 1/16).

## Status

design discussion of 2026-09-30 — measured where marked; decided only that
the coordinator's state is bbolt; nothing of the coordinator built. The tile
jobs it builds on are built (decisions/tile-jobs.md). Carried into
decisions/detail-ladder.md on 2026-10-01 (the ladder's budgets decided, the
rest proposed there).
