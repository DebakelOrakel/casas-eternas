---
summary: How an amplification bake could be split across machines, and what it would
  cost. The unit is the CATCHMENT, not a rectangle, because nothing flows across a
  divide — which is also why the compute decomposition and the tile decomposition are
  two different things that must not be conflated. Measurement removed the one cheap
  step this plan thought it had: the ocean is already skipped where it costs anything,
  so 95% of a bake is genuine land work and decomposition is the only lever left.
date: 2026-08-09
status: direction agreed. STEPS 1-2 BUILT 2026-08-09 (`npm run harness:amplify`, `surface/bakePlan.ts`); nothing decomposed yet. Measurement retired the plan's hardest open question and killed the obvious implementation of step 3
---

# Splitting the bake

A bake at 8192² peaks near 2.6 GB and takes minutes; a 16384² tiled render is
wanted eventually. Both point at the same question: can the work be cut into
pieces that run on separate machines, and along what line.

## What is actually coupled

The pipeline (`runAmplification`) has three stages, and they differ completely:

| Stage | Coupling | Splittable |
|---|---|---|
| `amplifyElevation` — upsample, ridges, warp | per pixel, small radius | trivially, anywhere |
| `runErosionPass` | **downstream**: drainage area accumulates from divide to sea | along the flow structure |
| routing → discharge → river extraction | the same | the same |

The important word is *downstream*, not *global*. Erosion is not coupled to the
whole world; it is coupled to everything upstream of a cell.

## Why catchments, and not tiles

Nothing flows across a divide. A catchment is therefore the only region that can
compute its own erosion: it receives water from rain, and rain it knows.

A rectangular tile in the middle of a river system cannot. A river enters it from
outside, carrying a drainage area computed elsewhere. The micro-tile prototype
needed `buildTileInflow` and `burnMacroTrunks` for exactly this — machinery that
catchment cuts do not need at all. (That prototype was removed 2026-08-09; the
code is in the history and its findings in
[the removed-prototype note](../decisions/worldmap-amplification.md).)

**The partition already exists.** `computeWatersheds` labels every land cell with
its catchment, ordered by area, ocean excluded. It is the watersheds overlay
today; it is the same question.

**A halo is still needed.** The divide itself erodes, and thermal transport is a
neighbourhood operator, so each job takes its catchment plus a margin, erodes,
and keeps only the interior. Without it there is a visible seam along the ridge —
the one place the eye is naturally drawn.

## Two decompositions, deliberately different

This is where 16k comes in, and where the design is easy to get wrong.

- **Compute by catchment**, because that is where the physics is local.
- **Store and serve by tile**, because a viewer wants a rectangle.

The bridge is better than it sounds: **every pixel belongs to exactly one
catchment**, so two jobs never write the same pixel. There is no arithmetic at
the seams — no blending, no averaging, no conflict rule.

**There is still an assembly step, though**, and an earlier draft of this section
glossed over it. Disjoint PIXELS are not disjoint FILES: a tile is touched by
several catchments, and the artifact store writes whole blobs (`write(path,
bytes)` — no random access, by design). So jobs deposit their own pieces, and the
server composes tiles at the completion barrier: for each tile, read the pieces
overlapping it, paint them in, write the tile.

That is byte copying rather than a second computation, and it streams — memory is
one tile, not the whole raster. At 16384×8192 the assembled raster is ~268 MB in
total and ~2 MB per 1024² tile.

It is also why the server, and not a job, writes the completeness marker: it is
the one doing the assembling. See below.

## Sizes: merging is free, splitting is not

Catchment areas are wildly unequal — a few enormous, thousands tiny.

**Merging small ones costs nothing.** They are independent, so a job is simply a
set of them, packed to a memory and time budget. One requirement: the packing
must be **deterministic**, derived from a sorted order rather than from which
worker happened to be free — otherwise the bytes depend on scheduling.

**Splitting a huge one is the expensive case.** It can only be cut at
confluences, and then flow does cross the cut, which brings inflow injection
back — the machinery catchments were chosen to avoid.

So: do not build it until it is needed. Measure whether the largest catchment of
a quarter-Earth at 16k actually exceeds the budget. If it does not, the hard part
never has to exist.

### It does not. Measured 2026-08-09, two real worlds

Two 2048×1024 worlds built through the real generator (seeds `alpha` and
`bravo`, 8.6 % and 14.3 % land), planned by `surface/bakePlan.ts`:

| | alpha | bravo |
|---|---|---|
| catchments | 9 327 | 13 760 |
| largest, as a share of land | **4.9 %** | **6.3 %** |
| largest, amplified at factor 8 (16 384 px) | 0.56 M cells | 1.2 M cells |

A whole world's land at factor 8 is 11–27 M amplified cells. The largest single
catchment is a twentieth of that — nowhere near any budget a machine would have.
**The hard part does not have to exist**, and this is the measurement that says
so rather than an expectation that it probably would not.

The shape is the expected one for drainage on a random landmass — no dominant
basin, a long tail — and it held across two worlds with very different land
fractions, which is why one seed was not left to carry the conclusion.

## Two numbers that belong to nobody

`maxDischargeOverLand` and `meanLandRunoff` set the channel threshold, and both
are defined over the whole world. A job cannot know them, and if each computed
its own, every catchment would get a different river density — visible at every
boundary.

They come from a **macro pre-pass** on the saved raster, which is cheap and needs
no amplification, and are handed to every job as constants.

## A job is a set of cells, never a rectangle

The obvious way to write step 3 is to hand each job the bounding box of its
catchments and let it work on that. **Measured 2026-08-09, that is hopeless**,
and it is worth stating before the code exists rather than after.

A single catchment fills about half of its own toroidal box (median 0.50 and 0.47
on the two worlds) — a river system reaching from a range to the sea is long and
bent, not blobby. Pack several catchments into one job and the fill collapses:

| jobs | box fill | boxes together | the land itself |
|---|---|---|---|
| 8 | 0.02–0.03 | 4.0–5.8× the world | 0.09–0.14× |
| 16 | 0.02 | 6.2–8.7× | " |
| 32 | 0.01 | 9.6–14.8× | " |

A job allocating its box would allocate fifty to a hundred times what it touches,
and the jobs together would allocate several times the raster the split exists to
avoid holding.

**Tiles are the better cover, and not a cure.** Counting instead the tiles a
job's catchments actually touch:

| tile (macro cells) | 8 jobs | 16 jobs | 32 jobs |
|---|---|---|---|
| 64 | 0.9× the world | 1.4× | 2.3× |
| 128 | 1.6× | 2.6× | 4.4× |
| 256 | 2.7× | 5.0× | 8.8× |

Two to five times tighter than the boxes, and at eight jobs with small tiles it
is finally *under* one world. But it still grows with the job count, because the
packing here is by SIZE alone: first-fit-decreasing happily puts two catchments
on opposite sides of the map in one job. Making the packing locality-aware —
choosing, among the groups a catchment fits in, the one whose cover grows least —
is the obvious answer, and it is deliberately not built yet: step 3 is what
supplies the real budget to tune it against, and a packer tuned against a guessed
budget is a packer tuned against nothing.

What this settles for now: **the plan's `box` is a diagnostic, not an
allocation.** It is kept because it makes the locality problem visible in one
number — a job whose box is most of the map is a job whose catchments have
nothing to do with each other.

## Label everything: the minimum catchment size is not the overlay's

`computeWatersheds` keeps only basins of at least 200 cells, because colouring
tens of thousands of one-cell systems reads as noise rather than as a map. For a
partition that default is actively wrong: everything below it stays unlabelled,
and unlabelled land has to go somewhere.

Measured on the same two worlds, as a share of all land:

| minimum | alpha | bravo |
|---|---|---|
| 200 (the overlay's) | 36.7 % | 35.7 % |
| 32 | 19.1 % | 18.4 % |
| 8 | 9.4 % | 8.7 % |
| **1** | **none** | **none** |

At 200 more than a third of the work lands in one group of scattered coastal
fragments — the largest job in the plan, and the one spanning the whole map. At 1
it disappears entirely and costs only labels: 9 327 and 13 760 catchments, both
comfortably inside the 65 535 the label type allows.

So the plan asks for 1. The fragment group still exists in the code, because a
world with far more coastline could cross that cap and the overflow would land
there again — rare, and handled, rather than a partition that quietly stops being
one.

## The macro pass is the gate

That pre-pass is not only the two scalars. It is also where the catchments are
labelled — so it produces the partition, the threshold and the job list in one
step.

Which means the ordering needs no new mechanism: without its output there are no
jobs to start too early. A gate by construction rather than by state.

## The ocean skip: already done, measured 2026-08-09

This section proposed skipping the ocean as the cheapest saving available, worth
doing before any decomposition. **That was wrong, and the measurement says so.**

Where a bake actually spends itself, at 1024×512 with two rounds:

| | |
|---|---|
| seeding (`amplifyElevation`) | **1 %** |
| erosion (`runErosionPass`) | **95 %** |
| hydrology re-run | 4 % |

And inside erosion:

| | |
|---|---|
| stream power | 70 % |
| thermal | 22 % |
| priority flood | 7 % |
| accumulation | 1 % |

Both hot loops already carry `if (!isLand[cell]) continue`. The ocean is skipped
where it costs something, and has been since thermal went land-only on
2026-08-06. What remains over deep water is the seeding — one percent of the
whole bake, so skipping the abyssal plain would save a quarter of a percent.

The priority flood necessarily covers everything: the ocean is the outlet every
river drains to, so it is not skippable in principle.

**What this changes.** There is no cheap warm-up step, and the plan is shorter
for it: the 95 % is genuine land work, so the only levers left are doing less per
land cell — a tuning question, not an architectural one — or spreading that work
across machines, which is what the rest of this document is about. The
decomposition is not an optimisation among several; it is the one available.

The thresholds worked out above (`SHELF_BREAK` for deposition, `SLOPE_FOOT` for
seeding) are kept here because they remain right for anything that DOES touch the
sea floor — they simply have nothing to earn today.

## Who declares an artifact complete

`meta.json` is written by whoever ran the bake — the browser for a local one, the
Job for a cluster one — and it is written LAST on purpose: a reader checks for it
to decide whether the stage is there at all, so an interrupted write leaves an
entry that reads as absent rather than as present-but-truncated.

That is defensible today, and it is the reason to keep it: there is exactly one
writer, `writeAmplificationArtifact`, shared by the browser and the Job. Having
the server produce the same file for cluster bakes would be two producers of one
format, which is the duplication this codebase spends its time removing.

**Splitting inverts the argument.** With N catchment jobs, no single one can
claim completeness — each knows only its own piece, and the first meta written
would tell every reader the bake was finished. `bakeMs` changes meaning too: the
duration of the WHOLE bake is known only to whoever waited for all of them.

So the rule the split needs is: **the completeness marker is written by whoever
knows the work is complete.** In the browser that is the browser; with a fan-out
it is necessarily the server's barrier, and the jobs write only their own bytes.

Worth doing as one rule rather than as "it depends": for server-side bakes the
server writes the meta, always. The way for a job to hand back what the server
needs already exists — it reports over `POST /v1/bakes/{id}/progress` as of
2026-08-09, and its result can travel the same road. The Kubernetes runner
returns no `Result` today on the grounds that fetching the pod's log back would
be a second connection; that objection is spent.

## A split bake is not the whole bake. Measured 2026-08-09

Before writing any region-limited erosion, the physics was tested without it: a
job that owns one catchment was simulated by drowning everything outside its
region and halo to abyssal depth — which makes those cells not-land and makes
them the outlet the flood drains to, exactly a job's view — and the result
compared against the same catchment eroded as part of the whole world. Same
`runErosionPass`, same params, both sides.

The three largest catchments of the harness world, at 512×256 over two rounds,
differences in metres on a 9000 m scale:

| halo | mean \|Δ\| | cells over 10 m | worst |
|---|---|---|---|
| 0 | 211–260 m | 43–60 % | 2570 m |
| 2 | 18–36 m | 18–25 % | 794 m |
| 4 | 0.7–1.2 m | 0.7–3.1 % | 146 m |
| 8 | 0.05–0.27 m | 0.0–0.7 % | 59 m |
| 16 | 0.00–0.21 m | 0.0–0.7 % | 58 m |

**The halo works, and then it stops.** The mean falls by three orders of
magnitude and a halo of 8 is plainly enough for it. The worst case does not
follow: between halo 8 and halo 16 it moves from 49.4 m to 49.4 m and from 58.6 m
to 58.4 m. A boundary effect would keep shrinking; this does not, so it is not
one.

What is left is 12 cells out of 3650 differing by more than 10 m. Their cause is
structural rather than marginal: **the partition is derived from the MACRO
drainage while the erosion runs on the FINE one.** A cell just inside a macro
divide can, on the amplified terrain, drain the other way — so computed alone it
never receives water the whole world gave it. Closed basins straddling the divide
are one instance of this and, checked directly, not the main one: the worst cell
in the largest catchment sits in no basin at all.

Chasing exactness is a dead end, and cheaply shown to be: a partition faithful to
the fine grid needs a flood over the fine grid, which is the global pass the whole
split exists to avoid.

### What that costs: the artifact key

This is the part that matters more than the numbers. Step 1 was written expecting
to "bake it whole, bake it decomposed, compare byte for byte". That comparison
will never come out equal, so it cannot be the gate — and if both ways of baking
stay available, two machines produce different bytes under one key, which is the
exact failure the cache cannot survive.

The way out is not to close the gap but to remove the choice: **the split IS the
bake, at every tier.** A single machine runs the same N regions in sequence and
gets the same bytes as N machines running them at once, because the partition is
a deterministic function of the macro raster and nothing in it depends on who
executes it. Determinism — the property the cache actually needs — is kept in
full. Equivalence to an undivided bake is given up knowingly, and it is a thing
no reader ever asks for.

"At every tier" sounds like it costs the small bakes something, and it does not,
because **N = 1 is today's bake exactly.** Give `planBake` a budget larger than
the world and it returns one group holding every catchment; a region-limited pass
over a region that covers all the land has nothing to limit, no halo to speak of,
and everything outside it is already ocean. The masking is a no-op and the
arithmetic is unchanged, byte for byte.

So there is no mode, no threshold and no second code path — the tier chooses a
budget, and the budget chooses N. A 4K bake in the browser can keep running as
one region and still be the same function the cluster runs at 16K with thirty.
That is worth more than the megabytes: two erosion paths, where the tested one is
the small one and the cluster runs the other, is the failure this design should
be least willing to buy.

Which turns the harness check around. It cannot be "the same as whole"; it is
"the same however it is scheduled", and `npm run harness:amplify` can make it: run
one world region by region in one process, twice, in different orders.

## What comes first: proving reproducibility

The bake's terrain is an explicitly documented blind spot — the golden harness
did not cover it, which is why step 1 exists. The instinct was to gate the split
on producing the same field as an undivided bake. **The measurement above
retired that**: it produces almost the same field, and "almost" was exactly the
failure this section was written to prevent.

So the gate is the other property, and it is the one the artifact cache actually
rests on: **a split bake must be reproducible, not equivalent.** Same world, same
plan, same bytes — whoever runs the regions, in whatever order, on however many
machines. That is checkable in one process and does not need a cluster to fail
honestly.

## Order of work

1. **The whole-bake check. BUILT 2026-08-09** as `npm run harness:amplify`:
   invariants, determinism and an opt-in byte baseline over a 256×128 macro baked
   at factor 2, in 13 s. It is the "whole bake" half of the comparison, and it
   closes a gap that existed regardless of splitting — the bake's terrain was
   covered by nothing at all. What it can NOT become is the decomposed half of a
   byte-for-byte comparison; see the measurement above.
2. **Catchment labelling in the macro pre-pass. BUILT 2026-08-09** as
   `worldgen/surface/bakePlan.ts`: one deterministic pass over the macro raster
   producing the labels, the two world-wide scalars and the packed job list, in
   about a second at 2048×1024. Covered by `npm run harness:amplify`, which
   checks the one property the name claims — that it is a PARTITION: every land
   cell in exactly one job, no cell twice, no ocean labelled. Both failure modes
   are invisible in a rendered map (a cell in two jobs is eroded twice, a cell in
   none keeps its seeded height, and both look like terrain).

   Not yet an artifact. Nothing reads it — the plan is the input to step 3, and
   giving it a cache key and a store before there is a consumer would fix its
   format before its shape is known. It is a pure function of the macro raster,
   so it can be recomputed for the price of a second whenever that changes.
3. **Region-limited erosion and routing.** This is where nearly all the real work
   is — 95 % of a bake, and 92 % of that in stream power and thermal, both of
   which are per-cell over land and therefore exactly what a catchment bounds.
   `fillDepressionsAndRouteFlow` still carries the `bounded` parameter from the
   micro-tile prototype, which is what a region needs.

   **Enter this one knowing three things measured before it was written:** a job
   is a cell set and not a rectangle; a halo of 8 fine cells is enough and 16 buys
   nothing; and N = 1 must come out byte-identical to today's pass, which is both
   the compatibility guarantee and the easiest possible first test of the new
   code.

   It splits in two, and the first half is the one carrying the risk:

   - **3a — the region-limited pass over full-size arrays.** Buys TIME only:
     N machines each doing 1/N of the per-cell work, every one still holding the
     raster. Verifiable in one process, and the place the physics either works or
     does not.
   - **3b — sparse tile storage, so a job holds only the tiles it touches.**
     Buys MEMORY, which is the half 16K actually needs (a 16384² Float32 layer is
     537 MB and the pass holds a dozen). Pure engineering, entered with 3a's
     checks already standing.

   This step also supplies the budget the packing should become locality-aware
   against.
4. **Fan-out into N jobs plus a completion barrier.** The job model gains parents
   and children, and progress becomes a weighted sum of theirs — the reporting
   built 2026-08-09 is what makes that possible.
5. **The server writes the meta**, and the jobs stop doing it — a one-line rule
   with a fan-out barrier behind it.
6. **Tiled artifacts.** After which 16k is a question of budget rather than of
   architecture.

Steps 1–2 are small. Step 3 is the project. Steps 4–6 are bookkeeping.

## Related

- [worldmap-amplification.md](../decisions/worldmap-amplification.md) — rule 4,
  and why the macro raster stays the authority whatever the bake produces
- [distributed-bake.md](../decisions/distributed-bake.md) — the Job model this
  would fan out, and the progress reporting it would aggregate
- [resolution-strategy.md](./resolution-strategy.md) — why the simulation grid
  and the detail resolution are separate layers
