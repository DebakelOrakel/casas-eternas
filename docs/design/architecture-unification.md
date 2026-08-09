---
summary: Plan for two connected rebuilds — a `world` module as the single, provenance-carrying place world data is queried, and a shared module architecture in the generator (separated tuning and input parameters, declared slider ranges, a real WorldSpec type). Includes the order of work, the safety net it needs first, and what is deliberately excluded.
date: 2026-08-09
status: Parts 0, A, B (all of B1-B6) and C0 (the save round-trip net) BUILT 2026-08-09, each verified; C1-C5 and D not started. Order and boundaries decided, detail questions listed at the end
---

# Architecture unification: world-data access and module contracts

Two efforts that depend on each other. The parameter contract (part B) is the
prerequisite for the provenance and the cache key of the world-data access
(part C), so it comes first — even though part C is the more visible problem.

## The finding

**World data lives in five places** — live fields in the worker, their mirrors on
the main thread, the restore half of the save zip, the query half (manifest +
layers), and the artifact cache. There is no shared place to ask. `worldLayers.sampleAt`
was meant to be one and has **zero callers**; it is now a one-line alias for
`sampleNearestWorld`.

Measurable consequences: "elevation" names three different arrays in the worker
(`lastRawElevations`, `lastDisplayElevations`, `lastLakeBasinElevations`); biome
exists in three representations and the world-map tooltip has two branches
reading two grids; "is this land?" is answered through at least four mechanisms
(`OCEAN_PRECIP`, `OCEAN_AMPLITUDE`, `ECOLOGY_OCEAN`, `elevation > 0`) plus a
`landMask` derived from the first at climate resolution; the worldgen tooltip
reads elevation at 256×128 while the map underneath it is 2048×1024.

**The generator has no shared module philosophy.** Four contracts coexist:
`(state, params)` (archean), a mutating state blob with no params (tectonics),
`(inputs, params)` (ecology), and loose positional arguments with trailing
optional knobs (climate, crust, elevation, hydrology). `computeRiparianBiomes`
takes 15 positional parameters. One of eleven modules has a params file.

**There is no `WorldSpec` type.** The DOM inputs *are* the store of a world's
parameters; `buildWorldYaml()` concatenates strings from `input.value`, and
reading back goes through a hand-rolled path regex. 27 of 28 sliders have
hardcoded min/max/step. Defaults exist in triplicate. Demonstrable consequence:
**the three migration sliders never reach the spec at all** — they exist in the
UI and in the worker message, but not in the save.

## Guiding decisions

**1. Authority beats resolution.** The facade does *not* return the finest
available resolution. `worldmap-amplification.md` rule 4 states that the 2048
raster is the sole authority and the amplified layer is derived presentation. So
the finest data is the least authoritative. Today `WorldMapScreen` swaps its
height field from 2048 to 4096 at runtime — same question, same session, two
answers. A "finest wins" rule would promote that non-determinism from a blemish
to a system guarantee.

Instead the caller declares its **purpose**:

- `authoritative` — the authority tier only. Deterministic, reproducible, the
  same answer a server would give. Never opportunistically upgraded.
- `presentation` — best available. May improve within a session when a bake lands.

These are two separate axes. The **cost** axis (local → server → compute) may
optimise freely and already does, in `TieredArtifactStore` ("local first, server
second, compute last", "MISS is never an error"). The **authority** axis may not.

**2. Every answer carries its provenance.** The return value is not a bare
number but the value plus source, resolution, unit and validity. Without that,
the facade becomes exactly the place where provenance is lost — worse than
today, because the inconsistency would then be invisible rather than merely
inconvenient.

**3. Acquire, don't query point by point.** Live fields sit in memory
synchronously; artifacts come from OPFS or over HTTP. An `await get(aspect, x, y)`
per point is unusable for overlays spanning two million cells. The interface is
two-stage: `acquire(aspect, purpose)` returns a synchronously samplable view. One
await per field, not per cell.

**4. A hash belongs to the consumer, not the module.** No canonical
`hashParams()` per module. The reasoning is in `storage/artifactKey.ts` and was
learned expensively: `deriveWorldId` deliberately hashes the *rasters* rather
than the params, because the recipe cannot distinguish two worlds stopped at
different tectonic epochs and a params hash would alias them; and `riverDensity`
is deliberately out of the key even though the bake reads it, because including
it orphaned 17–67 MB of artifact per slider position. Save identity, cache key
and memoisation need different subsets. Modules declare their parameters in a
structured form; **what gets hashed is the consumer's decision.**

**5. Tuning constants *are* hashed — as an object.** `derivePipelineVersion`
exists and works, but exactly **one** module feeds it (`AMPLIFY_CONSTANTS`, nine
values). Tectonics' 47, climate's 43 and ecology's 46 constants enter no hash at
all. The comment on `AMPLIFICATION_ALGO_VERSION` says why this matters: three
constants were retuned in a single afternoon, and a hand-maintained version
number would have been forgotten. For a module to get an automatic tuning
version, its constants must be **one object**, not a swarm of flat `export const`.

Note that the tuning version is consumer-specific too. `render/` constants change
the picture, not the world — they belong in no world hash.

## Part 0 — the safety net, first and non-negotiable

`client/scripts/golden.mjs` is deliberately **not** a hash harness: invariants,
determinism, metrics with 2 % tolerance. A refactor meant to change nothing that
introduces a sub-2 % drift passes **green** — and the determinism layer cannot
catch it, because it compares a run against itself within the same run, never
against a previous version. There are no unit tests otherwise.

The argument against hashes in the harness comment ("a gate that goes red when
you did the right thing teaches people to ignore it") applies to *tuning*
changes. For a refactor that must be bit-exact by definition, a hash is exactly
the right shape.

**BUILT 2026-08-09.** `npm run golden hash-record` freezes a per-stage byte hash
into `golden-hashes.json`; every later `npm run golden` reports the stages that
moved. The layer exists only while the file does, so it cannot go red for anyone
who did not arm it, and part D's "remove it" is a deletion. The baseline is
machine-local and gitignored — determinism holds within a process, but Math
results can move between V8 versions.

Two choices worth recording. Recording refuses on **non-reproducibility only**,
not on a failed invariant: `golden.json` claims "this is correct", so a broken
world recorded there bakes the breakage in, while this file claims only "this is
what the code does today" — exactly what you want to hold fixed while refactoring
something already wrong. And the determinism layer now reads the *same* stage
list, so the two cannot drift apart, and it names the stage that moved instead of
comparing two opaque blobs.

Verified end to end: record, then check in a **separate process**, gave 36 of 36
stages byte-identical on all three seeds. Cross-process reproducibility had never
been measured before — the determinism layer only ever compared a run against
itself.

Two gaps in the net turned up while building it, both now closed:

- The harness guarded only `computeBiomes` (coarse, 256×128). Since the split,
  `computeBiomesFine` is what the screen draws and the save bakes — the path with
  the consequences was unwatched. Now hashed as its own stage.
- The invariant "every land cell must be classified" read `biomes[i] < 0` on a
  `Uint8Array` and **could never fire**. It is the dead-check class the coverage
  layer exists to expose, and it survived because coverage compares metrics
  across seeds, not invariants. Replaced with the live form: `Biome.Ocean` on a
  cell above sea level.

- **Remaining gap:** the amplification bake is still unguarded. `AMPLIFY_CONSTANTS`
  and `derivePipelineVersion` feed no check, so part B2's regrouping of those
  constants could change the artifact key and silently orphan every cached bake.
  Cheap fix if wanted: carry the derived pipeline-version string as one more
  stage in the baseline.

## Part A — correct the module boundaries

Before the parameters, because it is cheap and because it defines *what a module
is* before we start adding files per module. Pure moves, no logic change — the
hash baseline must come back identical.

**BUILT 2026-08-09**, and verified the way this part demanded: 38 of 38 stages
byte-identical on all three seeds, `tsc` green, no import cycle introduced.

**A1. Extract `mantle/`.** `tectonics/mantleField.ts` was used by **five archean
files and five tectonics files**, plus the worker and the renderer. It is not a
tectonics concern but the substrate both eras run on, and it sat in `tectonics/`
for historical reasons.

It could not move as one file, which the plan had assumed. `fitMotionsToFlow`
takes plate seeds and returns plate motions, so carrying it along would have made
the substrate depend on what rides on it — the exact inversion the extraction
exists to remove. It was the *only* thing pulling those types in, and its only
caller is `epoch/mantleCoupling.ts`, so it moved to `tectonics/plateMotion.ts`
where both types live. `mantle/` now imports `core/` and `crust/raftField` and
nothing else.

**A2. Move the raft constants to `crust/`.** `MERGE_OVERLAP_FACTOR` and
`RAFT_CONNECT_FACTOR` now live in `crust/crustTuneParams.ts`.

The plan's reasoning was wrong in one detail worth recording, because it changes
what the file is. `crust/` does **not** import them — it takes them as function
parameters (`mergeOverlappingRafts(rafts, overlapFactor, …)`), which is what lets
the Archean pass its own values where it deliberately differs. So this is not a
hidden dependency being relocated to its owner; it is the shared *default* that
both callers agree on, given a home neither era owns.

**Result:** of the five files in `archean/`, only `finalizeArchean.ts` still
imports from `tectonics/` — the handover itself, one file, one direction.

**Not: merging archean and tectonics.** The coupling decomposes cleanly. After
A1/A2, exactly **one** of the five archean files still imports from `tectonics/`:
`finalizeArchean.ts`, which builds the `PlateSimulation`. That is the handover
between two geological eras, and the fact that it happens in one file in one
direction makes it a *healthy* boundary. Merging would produce a 19-file module
and delete the only clearly named seam in the generator. The reverse direction is
only a field name (`archeanEpochs`), not code — there is no real cycle.

## Part B — module contracts and parameters

**B1. Reference implementation in `migration/`. BUILT 2026-08-09**, verified
38 of 38 stages byte-identical. One file, 193 lines, small enough that the
pattern rather than the module is what one sees, and it is going to grow.

Two things the reference settled that the plan had not:

- **The tuning object is read directly, under its full name — no aliases of any
  kind.** Two attempts went the other way and both were wrong. Destructuring
  each field back to its old `SCREAMING_CASE` name kept the diff small, but that
  reason expires when the change lands and leaves two names per constant plus a
  second place to edit when one is added. Importing the object `as TUNE` for
  brevity is worse in a subtler way: it **defeats grep**. `TECTONICS_TUNING` then
  appears only on the seven import lines, not at the 66 places the values are
  actually used — against this repo's own rule of searching for the operation
  before writing one. Line length is the weaker concern.
- **`InputParam` needs an `inSpec` flag.** Not every control is a world
  parameter. Migration's arrow threshold only changes which arrows are drawn; in
  the spec it would make two identical worlds differ by a rendering preference,
  and once inputs feed a cache key it would orphan every artifact whenever
  someone nudged it. That is the mistake `artifactKey.ts` records for
  `riverDensity`, and the declaration now carries the distinction.

**B2 will not objectify every constant.** Three kinds live in these modules and
only one belongs in a hash: **world tuning** (changes the generated world),
**structural** (grid sizes, resolutions, the elevation unit anchor, enum ids —
`elevationScale.ts` calls itself "the single place that says what a height value
MEANS", which is a definition, not a knob), and **presentation** (colours,
decimation, exaggeration — a colour change must never orphan an artifact).
Classify before grouping.

**B2. BUILT 2026-08-09** — 170 constants across seven modules, every value machine-compared against `git HEAD`, no drift, guard green at each step. Three findings the grouping forced out: the amplification key was missing three values that move baked geometry (fixed, all artifacts invalidated); `ADVECT_STEP` existed twice in climate with different values and would have collided silently; and climate's Whittaker thresholds are inline literals inside `classify`, so the largest block of climate tuning in the repo stays invisible to any grouping. Deliberately out: `elevationScale.ts` (a definition module and a fifteen-file contract), exported constants (contracts move separately), and the `x / 9000` anchor hardcodings (a coupling change does not belong in a move step).

**B2 as planned. `xyTuneParams.ts` per module, as an object.** Constants grouped rather than
flat, so `derivePipelineVersion` can take them. `tectonicsParams.ts` becomes
`tectonicsTuneParams.ts`. Climate's 43 constants are collected from nine files;
ecology's 46 are grouped within their one file; elevation, surface and render
follow. Inline literals that are genuinely knobs move with them — the rest stays
where it is, since not every number is a constant.

**B3. One deriver instead of the hand-assembled call sites. BUILT 2026-08-09.**
`derivePipelineVersion({ ...AMPLIFY_CONSTANTS, rounds })` was written out at
**eight** places, not the five the plan counted: five in two screens, two in the
Node baker, and one in the harness — where a guard that rebuilds what it guards
cannot notice the two drifting apart. All of them now call
`amplificationPipelineVersion(rounds?)` in `storage/amplificationArtifact.ts`.

That home was forced: `artifactKey.ts` states in its own header that it takes
the constants as an argument so it has *no opinion* about where they live, and
`amplificationArtifact.ts` already owns artifact identity and is proven
Node-safe by the baker importing it. `rounds` stays a parameter because the
server's baker takes it per job.

Confirmed independently of the harness: `node baker.mjs --version` still prints
`v4-5fadfe0c881a887e`, so no cached artifact was orphaned by the consolidation.

**B4. BUILT 2026-08-09.** `InputParam` now lives in `core/inputParams.ts`; genesis, erosion, climate, hydrology and ecology have declarations. Ranges and defaults are read from them by the markup, the reset handlers and the load-path fallbacks — three copies down to one, verified by comparing all twelve sliders' emitted numbers against `git HEAD`. The per-panel markup shapes were left alone on purpose: unifying them is B6 and must not ride along unnoticed in a step that is supposed to change nothing visible.

**B4 as planned. `xyInputParams.ts` for modules with sliders.** Per slider: min, max, step,
default, unit, i18n key, help key. Covers genesis, erosion, climate, hydrology
and ecology. Modules without sliders (core, crust, mantle, render, worldSave)
get none.

**Migration comes along structurally but stays out of the save and any hash**
(decided 2026-08-09). The layer may leave the generator for a screen of its own,
so its values must not enter `world.yaml` or a params hash yet: a format written
now is a format to migrate later for a layer that might not live here. Its three
controls are still declared and still render from the declaration like every
other panel.

The `inSpec` flag introduced in B1 already carries exactly this, which is the
useful part — one boolean separates "the UI knows about this control" from "the
world is defined by it", and the second is the commitment worth deferring.

One consequence B4 handles first rather than inherits: the shared `InputParam`
interface lives in `migration/migrationInputParams.ts`, because migration is
where the pattern was proved. Nothing about the type is migration-specific and
every other panel needs it, so it gets a neutral home before anything else moves.

**B5. `WorldSpec` as a type, assembled from B4.** Replaces string concatenation
and regex reading with a real round trip. The triple defaults disappear, and the
missing migration sliders become structurally impossible rather than merely
fixed.

**B6. Render the sliders generically** from the declaration instead of 28
hand-written template lines. Side effect: `WorldGenScreen.ts` (4006 lines, one
`innerHTML` template) gets noticeably smaller.

**Explicitly not in part B:** no per-module hash (see guiding decision 4).

## Part C — world-data access

Shape settled in discussion 2026-08-09; nothing built. The decisions below are
the ones that are expensive to reverse, so they are recorded before any code.

### Where `world/` goes, and why it is not a taste question

**Top level, a peer of `worldgen/`, `map/`, `storage/` and `server/`** — because
a module that depends on all four cannot live inside any of them. Putting it
under `worldgen/` would make the generator import `storage` and `server`.

The decisive evidence is that **a dependency cycle already exists**:

```
worldgen ──2──▶ storage   (bakeInBrowser→amplificationArtifact, loadWorldInputs→artifactKey)
storage  ──3──▶ worldgen  (amplificationArtifact→worldLayers, →amplify)
storage  ──2──▶ server
server   ──1──▶ worldgen  (bakeClient→bakeInBrowser)
```

Every file in that tangle is about world identity, the save format, artifacts or
commissioning a bake — which is exactly what `world/` is for. So the module is
not an addition, it is an **extraction**: it already exists, smeared across three
directories, and the cycle is the symptom. Afterwards the layering is acyclic:
`worldgen/` computes, `storage/` moves bytes, `server/` talks HTTP, `world/`
identifies and answers, `map/` draws.

**`map/` is the parallel, and it holds.** `map/` is the presentation vocabulary
of a world, `world/` the data vocabulary; both sit below the screens and neither
should depend on the other. That `map → worldgen` is only four edges, all reading
*units* (`elevationScale`, `mapConfig`, `ridgedNoise`) rather than data, is what
confirms `map/` is genuinely presentation.

One edge to delete on the way: `storage → map`, introduced in B3 when
`amplificationPipelineVersion` reached for `AMPLIFY_EROSION_ROUNDS`.
`AMPLIFY_BAKE_STAGES`, `AMPLIFY_FETCH_STAGES` and `AMPLIFY_EROSION_ROUNDS` are
**bake parameters filed under "map scene settings"** because the map screen
happens to trigger the bake. They belong in `world/`.

### What it owns — and the test that keeps it honest

`world/` **owns the answers, not the work**: identity, the spec, the save format,
artifacts, and "what is true at this location". It does not own computing
(`worldgen`), drawing (`map`), byte transport (`storage`/`server`) or UI state.

> **If a function does not need to know *which* world is meant, it does not
> belong in `world/`.**

`runErosionPass` does not (it is handed an array); `deriveWorldId` does;
`computeBiomes` does not; `readWorldInputs` does. Sharp enough to decide with
while building, instead of re-arguing each time.

Against the monolith the phrase "central point of contact for everything" invites:
one entry point **per aspect** over a small shared core — identity, spec, the
layer contract, source resolution. Everything else is an aspect.

### `world/` deals in IMMUTABLE worlds — the live state stays put

Decided 2026-08-09, and it follows from the identity model rather than from
convenience: `deriveWorldId` moves whenever the terrain moves, so one more
erosion pass *is* formally a different world; only `worldUid` persists.

So the generator produces a result and **hands it over**: `world.from(result)`,
never `world.readLiveField()`. The worker stays in `worldgen/` because it
computes. That removes cache invalidation, the "is this field still current"
question and any worker handle from `world/` entirely.

**The price, stated rather than glossed:** the *editor's* own inconsistencies
survive this. The worldgen tooltip keeps reading elevation at 256×128 under a
2048 map, and biome keeps three representations. Part C answers the question for
finished worlds — the ones the server and the game consume — not for the
workbench.

### Spec ownership: read facade first, one-way data flow later

The DOM being the store has one genuine advantage, which is why it survives: there
is exactly **one copy** of each value, so a synchronisation bug is impossible.
The costs are the ones B4/B5 measured — values are strings every reader parses,
nothing headless can obtain a spec, and a change is observable only as a DOM
event.

The resolution keeps the advantage: the DOM stays the **input** and stops being
the **store**. A small spec object owns the values, inputs write into it on
`input`, the panel renders from it. One-way (spec → view) plus an explicit event
path back, so there is still exactly one authority — it is just no longer the DOM.
The wiring for 28 sliders would have been handwork before B4/B6; now the
declarations know every control, so it can be generated the way the markup now is.

Sequence: **the read facade first**, spec ownership after.

### C0. The net, first — BUILT 2026-08-09

The extraction is done **in one move** (decided 2026-08-09) so the cycle is never
a maintained intermediate state. That makes a safety net a precondition, exactly
as in part 0: the golden harness covers the generator and, since 2026-08-09, the
pipeline version — but `loadWorldInputs`, `worldLayers`' quantisation, the zip
assembly and the artifact path are **unguarded**. The move would happen precisely
where nothing goes red.

So C0 is `client/scripts/roundtrip.mjs` (`npm run roundtrip`, in `make test`):
41 checks in **0.2 s**, on synthetic rasters. It covers layer quantisation across
each spec's full declared range (a wrong scale clips at the ends, which a
mid-range spot check misses), the recipe's write→read round trip plus a layout
lock, `deriveWorldId` frozen against fixed bytes, that every constant
`AMPLIFY_CONSTANTS` lists actually moves the pipeline version, the artifact
store's encoding, and the shared zip reader — including the property that
`readWorldInputs` reaches the same worldId as deriving it by hand, since a drift
there files bakes under a key nothing will ask for.

Speed is a feature, not a detail: the golden harness costs thirteen minutes and
is therefore run at milestones, which is the wrong cadence for a format you touch
while moving files.

**Known gap, stated rather than implied:** the zip ASSEMBLY still lives in
WorldGenScreen and needs a DOM, so the check builds its test zip from
`WORLD_LAYERS` itself rather than calling the real writer. That closes when C3
extracts the writer — at which point roundtrip.mjs should call it instead of
describing it.

### C1 onwards

**C1. One land mask. BUILT 2026-08-09**, verified 38 of 38 stages byte-identical.

The "four mechanisms" turned out to be three different things, and only one was a
problem. The many `SEA_LEVEL` comparisons in erosion, delta growth and tile
erosion are **geometry** — depths, flow blocking, coast finding — and use the
datum rather than testing land; they stay. `ECOLOGY_OCEAN`, `OCEAN_AMPLITUDE` and
`OCEAN_PRECIP` are **output sentinels** marking "this field has no value here",
a property of each output; they stay too.

The actual predicate was written out six times in two polarities — `e <= SEA_LEVEL
&& !dry` in seasonality, precipitation and biomes, its negation `e > SEA_LEVEL ||
dry` in ocean currents. Logically identical with the same short-circuit, so
extracting it was bit-exact.

`isLandAt(elevation, dryLand)` now lives in `elevationScale.ts`, beside
`SEA_LEVEL`, because that file is by its own account the one place that says what
a height means. `isLandAtCell(...)` in `climateField.ts` samples the coarse grid
and applies it — definition with the datum, sampling with the samplers, and
`elevation/` still must not import `climate/`.

What makes it more than a sign test is the `dryLand` term: a terminal basin below
sea level holding no water IS land, and every field that skips ocean has to skip
it the same way or the biome map and the ecology mask disagree about one cell.

**Deliberately unchanged:** ecology, migration and hydrology still derive land
from `precipitation !== OCEAN_PRECIP`. That is the same mask propagated through a
field, not a second definition — precipitation writes the sentinel exactly where
the ocean test says ocean. Passing the mask explicitly instead is a signature
change and belongs to C2, where the field contracts are drawn.

**C2. Field contracts. BUILT 2026-08-09**, verified 38 of 38 stages
byte-identical and the round-trip green.

`LayerSpec` carried two kinds of truth at once, and its own comment on `fullRes`
had already named the problem — "a property of the source field, not of this
format". Split:

- **`FieldSpec`** (`worldSave/fieldSpec.ts`) — name, grid, unit, land-only. True
  of a field *wherever* it lives: worker memory, a save, an artifact.
- **`Encoding`** — dtype, scale, offset. True of one storage form.

`LayerSpec` is now simply both, and `WORLD_LAYERS` composes itself from the
registry, so the save can no longer describe a field differently from the rest of
the program. `fullRes?: boolean` became `grid: 'world' | 'climate'` — a statement
instead of a flag with an implied opposite.

The split paid immediately. Two callers were **fabricating a LayerSpec** purely
to reach the quantiser — the amplification artifact for its own elevation, and
the save reader rebuilding a spec from the manifest it had just parsed, complete
with an invented `unit: ''`. Neither has a world field behind it. `bakeLayer` and
`decodeLayer` now take an `Encoding`, so the quantiser stops claiming it needs to
know what a field *is*. A dead parameter fell out with it: `readLayer(…, landOnly)`
passed a value `decodeLayer` never read, at seven call sites.

The registry also makes two absences visible. `elevation` is listed even though
it is not a quantised layer — it rides as raw f32 because it doubles as the
restore raster, but the manifest lists it as a field and nothing said so before.
And `oceanAge` and the mantle field are documented as deliberately *out*: they
have their own grids and are restore rasters, not queryable layers. Whether
oceanAge should become one is the open question in queryable-world-save.md, and
this registry is now the place the answer would land.

**Still open, and deferred on purpose:** the live path has no contract yet. The
registry describes the fields, but the worker's `last*` mirrors are not yet
registered against it and consumers still do open-coded index arithmetic. That is
C3's work — the facade is what gives a source something to describe itself *to*.

**C3. The `world` module.** Per aspect, not monolithic. Covers finished worlds —
save, artifact cache, server — and NOT the generator's live fields (see above;
this reverses the first sketch). The core is `acquire(aspect, purpose)` → a
samplable view plus provenance. It also owns writing saves, delegating to
`worldgen/`.

Saving is where the payoff lands first. Today it is spread across
`buildWorldYaml` and `bakeQueryLayers` in a 4000-line screen, the zip assembly,
the restore half and `loadWorldInputs` for the query half — and `loadWorldFromZip`
**parses the same zip twice**, once raw for `elevation.f32` and once through
`readWorldInputs` merely to obtain the `worldId`. Two readers, one file, which is
the drift `loadWorldInputs` warns about in its own header ("one reader cannot
drift from itself").

**C4. Migrate the consumers.** Worldgen tooltip and overlays, world-map tooltip,
save writer, bake path. A facade is only proven once a consumer goes through it.

**C5. Revive or delete `sampleAt`.** A contract nobody honours is the worst of
both worlds.

**A trap to avoid while doing this:** `deriveWorldId` hashes the *quantised*
precipitation from the save, not the generator's raw floats (`WorldGenScreen.ts`
already documents this). A facade that "picks the best source" and gets the live
floats mints a different worldId — the bake then runs correctly, writes real
bytes, and is invisible to the world map forever.

**Do not build:** a facade meant to serve climate, biome or ecology from the
artifact cache. The cache holds only elevation and river polylines; for
everything else there is exactly one source, so there is nothing to choose. The
resolution question only genuinely arises for elevation and rivers.

## Part D — clean up

Remove the hash baseline. Bring the documentation up to date. Decisions from this
plan that turn out to be real forks while building get their own docs in
`docs/decisions/`.

## Order, and why

```
0  safety net        ─ without it nothing below is verifiable
A  module boundaries ─ defines what a module is, before B
B  parameter contracts ─ gives C its provenance and its key
C  world-data access ─ the visible problem, solved last
D  clean up
```

One module at a time, and **never a behaviour change in the same step as a
move**. Every step ends with a green hash baseline and `tsc`.

## Documenting these conventions

Split by audience, not by topic:

- **`docs/design/` and `docs/decisions/`** — for humans, and as the durable store
  of reasoning. The existing taxonomy stands; this document belongs here, and the
  individual forks encountered while building go to `decisions/`.
- **`CLAUDE.md` at the repo root** — short, an index rather than a copy: which
  conventions exist, where they live, when to read which. Loaded at every session
  start.
- **`client/src/worldgen/CLAUDE.md`** — the module-level traps and, once part B
  lands, the module contract. Subdirectory files load **on demand** when a file
  there is touched, so it costs nothing while nobody works on the generator.
- **`README.md`** — stays for humans and is not loaded automatically.
- **`AGENTS.md`** — unnecessary while Claude Code is the only agent in use.

## Open questions

1. ~~**`lakeDepth` is downsampled to 256×128 on save**~~ — **answered 2026-08-09**:
   an oversight, and a measurable one. The reduction used `downsampleMax`, which
   let a single lake cell claim its whole 62 km cell and inflated saved lake area
   4×. The layer is now `fullRes`. The general lesson outlives the fix: a coarse
   save layer for a finely computed field is a *choice*, and the reduction
   function is part of the layer's contract — C2 should make it declarable
   instead of implicit at the call site.
2. **`oceanAge` is in the zip but in no manifest** — invisible to a query
   consumer. `queryable-world-save.md` lists it as open; C2 forces the decision.
3. **Which tier is authoritative once the hex game arrives.** Rule 4 says 2048;
   the hex view wants finer data. Should the amplified tier ever become
   authoritative, it needs determinism guarantees and server reproduction. Not
   needed now, but the `purpose` parameter from C3 must survive the answer.
4. **New i18n keys.** The input declaration references existing keys. Any slider
   without a help key needs new ones, to be approved first.
5. **`world.yaml` gains the migration sliders.** Old saves read defaults; whether
   that warrants a format version is undecided.

## Related

- [queryable-world-save.md](../decisions/queryable-world-save.md) — the manifest
  and sampler part C builds on
- [worldmap-amplification.md](../decisions/worldmap-amplification.md) — rule 4,
  from which guiding decision 1 follows
- [resolution-strategy.md](./resolution-strategy.md) — why the sim grid and the
  detail resolution are separate layers
- [server-storage.md](./server-storage.md) — worldId versus worldUid, the two
  identities
- [amplification-artifacts.md](./amplification-artifacts.md) — the cost axis
  (local, server, compute)
