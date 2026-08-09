---
summary: Plan for two connected rebuilds — a `world` module as the single, provenance-carrying place world data is queried, and a shared module architecture in the generator (separated tuning and input parameters, declared slider ranges, a real WorldSpec type). Includes the order of work, the safety net it needs first, and what is deliberately excluded.
date: 2026-08-09
status: Parts 0 (safety net) and A (module boundaries) BUILT 2026-08-09, both verified byte-identical; B–D not started. Order and boundaries decided, detail questions listed at the end
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

**B1. Reference implementation in `migration/`.** One file, 193 lines, 8
constants, and it already has a `MigrationParams` — small enough that the pattern
rather than the module is what one sees, and it is going to grow. Its
`migrationTuneParams.ts` and `migrationInputParams.ts` become the template.

**B2. `xyTuneParams.ts` per module, as an object.** Constants grouped rather than
flat, so `derivePipelineVersion` can take them. `tectonicsParams.ts` becomes
`tectonicsTuneParams.ts`. Climate's 43 constants are collected from nine files;
ecology's 46 are grouped within their one file; elevation, surface and render
follow. Inline literals that are genuinely knobs move with them — the rest stays
where it is, since not every number is a constant.

**B3. One deriver instead of five call sites.**
`derivePipelineVersion({ ...AMPLIFY_CONSTANTS, rounds: AMPLIFY_EROSION_ROUNDS })`
appears at five places across three files, hand-assembled each time. They are
identical today; whoever adds a constant at one of them mints two keys for one
artifact. This becomes an exported function.

**B4. `xyInputParams.ts` for modules with sliders.** Per slider: min, max, step,
default, unit, i18n key, help key. Covers genesis, erosion, climate, hydrology,
ecology, migration. Modules without sliders (core, crust, render, worldSave) get
none.

**B5. `WorldSpec` as a type, assembled from B4.** Replaces string concatenation
and regex reading with a real round trip. The triple defaults disappear, and the
missing migration sliders become structurally impossible rather than merely
fixed.

**B6. Render the sliders generically** from the declaration instead of 28
hand-written template lines. Side effect: `WorldGenScreen.ts` (4006 lines, one
`innerHTML` template) gets noticeably smaller.

**Explicitly not in part B:** no per-module hash (see guiding decision 4).

## Part C — world-data access

**C1. One land mask.** Four mechanisms down to one. Cheap, immediately
verifiable, and every other query depends on it ("does this field apply here at
all?").

**C2. Field contracts for the live path too.** `LayerSpec`/`WORLD_LAYERS`
describe only the save side today. The live path has **no contract at all** —
each of ~14 fields is read by open-coded index arithmetic at every call site,
against whichever resolution that field happens to use. The manifest concept
becomes the universal description: every source describes itself as a set of
layer specs.

**C3. The `world` module.** Per aspect, not monolithic. Covers finished worlds
(save, artifact cache, server) *and* the generator's live fields. The core is
`acquire(aspect, purpose)` → a samplable view plus provenance. It also owns
writing saves, delegating to `worldgen/`.

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
