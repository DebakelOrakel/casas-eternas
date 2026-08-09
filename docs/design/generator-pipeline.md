---
summary: The generator's runtime pipeline — its state is already stage-shaped but never
  declared, which is why invalidation is a set of hand-written rules. The target is the
  chain as data; this records the design, the reset taxonomy and the staged path there.
date: 2026-08-09
status: direction agreed, implementation staged — step 3 complete 2026-08-09; steps 4 and 5 open
---

# The generator pipeline: the chain as data

One module runs the whole generator — archean, tectonics, erosion, climate,
hydrology, ecology, migration, the micro-tile inspector, save and restore.
Nineteen inbound message types, 1503 lines, 39 module-level `let`s, and the one
part of the generator the golden harness explicitly does not cover. Until
2026-08-09 it was a single file called `plateSimulationWorker.ts`; step 1 below
split it, and the measurements in this document are from before that split.

This document is about its *runtime* structure. Module boundaries, parameter
contracts and world-data access are
[architecture-unification.md](./architecture-unification.md); the pipeline is the
place where those contracts are actually sequenced, and the last one still written
as imperative prose.

## The finding

The 39 `let`s are not disorder. They group cleanly by pipeline stage:

| Group | Count | Examples |
|---|---|---|
| Archean | 6 | `archean`, `archeanSeed`, `archeanParams`, `archeanWater` |
| Tectonics | 4 | `sim`, `pendingEvents`, `epochIntervalMs`, `intervalId` |
| Handover | 3 | `handoverSnapshot`, `handoverOceanAge`, `handoverMantle` |
| Erosion | 3 | `lastRawElevations`, `preErosionElevations`, `erosionStopRequested` |
| Climate | 8 | `lastClimatePrecip`, `lastClimateBiomes`, `lastClimateParams` |
| Hydrology | 9 | `lastHydrologyDischarge`, `hydrologyDirty` |
| Ecology | 1 | `lastEcologyCarryingCapacity` |
| Presentation | 5 | `renderOptions`, `lastDisplayElevations`, `renderInFlight` |

**The state is already stage-shaped — it was simply never declared.** The prefix
`lastHydrology*` *is* a struct, written as a naming convention instead of a type.

Two asymmetries say the rest. Exactly one stage carries an explicit freshness flag
(`hydrologyDirty`) and exactly one stores the inputs that produced it
(`lastClimateParams` — declared on line 1034, 470 lines from the rest of its
family, so already adrift). Every other stage encodes "stale" as "the field is
`null`". Nulling fields out *is* the invalidation mechanism, which is why the
rules have to exist as hand-written helpers:

```ts
function invalidateAfterTopographyChange(): void {
  hydrologyDirty = true
  lastLakeBasinElevations = null
}
```

Their own header comment calls the module state "the single riskiest thing about
this file" and names the fix correctly — *"makes a caller state its intent rather
than its mechanism"*. That was the right move for loose assignments. It is still a
list of rules a human maintains, and both worker bugs found on 2026-08-09 were
exactly this class: an archean leftover that reset a loaded world, and
`archeanFinalised` carrying two meanings so that repairing one broke the other.
(The comment also says "~24 pieces of module state". There are 39.)

## The target design

Four layers, and the notable thing is how much of it already exists.

**1. The chain as data.** One table, one entry per stage:

```
{ id: 'climate',
  dependsOn: ['erosion'],
  inputs:  CLIMATE_INPUT_PARAMS,                 // built, part B
  outputs: ['temperature', 'precipitation', …],  // built, FieldSpec / part C2
  kind:    'oneShot' | 'steppable',
  run(inputs, upstream) → ClimateResult }
```

Three of those five fields are already built and living in the stage modules. What
is missing is **the edge** — `dependsOn` — and a runner over the table. The worker
is the last place where the pipeline is expressed as prose rather than as data.

**2. One result object per stage, not nine nullable fields.** A stage's outputs
exist or do not exist, together. Freshness becomes structural rather than
conventional, and reset becomes dropping one object instead of a correct sequence
of assignments.

**3. The result carries the inputs that produced it.** Generalising what
`lastClimateParams` already does for one stage. Then "is this stale?" is a
comparison rather than a flag, and the same record answers three questions we had
been treating as separate work: cache invalidation, the save's recipe, and the
unsaved-changes indicator in the editor. Spec ownership (architecture-unification,
part C) is a consequence of this rather than a parallel task.

**4. Pipeline separated from transport.** The file was both the state machine and
the `postMessage` adapter: 14 `self.postMessage` sites and one `self.onmessage`.
Split, the pipeline is plain TypeScript that runs anywhere — including in Node,
directly, without a `globalThis.self` stub. That is the difference between a test
net that needs scaffolding and one that does not, and it is why this came first.

The transport turned out to be only half the tie. Splitting it revealed the other
half: the render pool, constructed at module level, spawns eight nested workers and
reads `self.navigator.hardwareConcurrency`, so merely importing the pipeline in Node
threw. The rest of the render path uses no browser API at all — it produces raw
buffers, which is why the golden harness can build worlds — so the pool was the
whole of it. It is now built lazily and the renderer is injectable
(`ElevationRenderer`, one method), which makes the host seam two functions:
`setEmitter` and `setElevationRenderer`. A pipeline that never renders now also
never spawns a worker.

### What a redesign would keep

The `HANDLERS` table, typed as `{ [K in WorkerInboundMessage['type']]: … }`, so an
unhandled message type is a compile error. It would be reinvented as-is.

The distinction between **steppable** stages (archean and tectonics run
interactively with start/stop; erosion runs progressively with a progress bar) and
**one-shot** stages (climate, hydrology, ecology, migration). That is a real
difference in kind, not an accident of history, and a runner has to carry it.

## Reset: the taxonomy

Agreed 2026-08-09, before any of this is built.

Two distinct gestures, which the current UI conflates:

- **State reset** — discard a stage's *derivation*, keep its inputs. "Run it again."
- **Input reset** — discard the *intent* for one stage as well, returning its
  sliders to defaults, and with it the derivation.

Two rules govern both:

1. **Invalidation flows downstream only.** A reset in ecology leaves tectonics,
   erosion, climate and hydrology untouched; a reset in tectonics invalidates
   everything after it. This falls directly out of `dependsOn` once the chain is
   data — it stops being a rule someone remembers.
2. **Downstream *inputs* are never reset.** Invalidation discards derived state.
   The user's sliders in a later stage are stated intent, and losing them because
   an earlier stage was re-run would be a data-loss bug, not a cleanup.

So `resetStage(id)` discards that stage's result and every result downstream of it;
the input-reset gesture additionally restores that one stage's inputs to their
declared defaults. Both are derived from the same table.

## What this means for the names

Recorded here rather than acted on separately, because a rename with no other
reason to touch the file is churn.

**The file name was stale — renamed in step 1.** `plateSimulationWorker.ts`
described what it was on the first day; plate simulation is one stage of seven. It
also collided with `tectonics/plateSimulation.ts`, which *is* the plate simulation,
making the worker read like that module's concurrency wrapper. It cost two real code
sites (the `import type` and the `new Worker(new URL(…))` in `WorldGenScreen.ts`)
plus seven comment references, two of which pointed at the wrong half afterwards —
the `self`-typing note belongs to the transport, not to the pipeline.

**The message names carry three conventions at once** — unprefixed (`start`, `stop`,
`erode`, `resetErosion`), stage-prefixed (`archeanStart`, `archeanFinalize`,
`archeanReset`) and verb-prefixed (`computeClimate`, `computeHydrology`). `start`
means "start tectonics" only by convention, and sits next to `handleArcheanStart`.
The stage table forces a stage identifier per message anyway, so
`start → tectonicsStart` and `erode → erosionStart` fall out of that step instead of
being a rename for its own sake.

**`sustainMantleVigour` is two quantities under one word.** It renormalises the
mantle field's *amplitude* (`targetRms`), while the `mantleVigour` slider becomes
the per-epoch *stirring rate* via `vigourToDiffusion`. `mantleField.ts` says so
itself — "This *was* the mantle-vigour knob" — so the name is a fossil of an earlier
design. `sustainMantleRms` matches the parameter its caller already passes. The
i18n key `worldgen.panel.genesis.mantleVigour` is unaffected: the slider carries the
name rightfully. This closes the open half of the naming audit note.

## The staged path

The golden harness does not run the worker and neither does layer 4's hash guard,
so nothing below has a net until step 2 builds one. That is the reason for the
order, not thoroughness.

| Step | What | Verified by |
|---|---|---|
| 1 | **Transport seam + rename. BUILT 2026-08-09.** `pipeline/messages.ts` (the contract), `pipeline/runtime.ts` (state + handlers, `self`-free), `worldgenWorker.ts` (transport only, 24 lines). | `tsc`, a headless run in Node, a manual click-through |
| 2 | **The test net. BUILT 2026-08-09.** `client/scripts/pipeline.mjs`, `npm run harness:pipeline`, in `make test`: 21 checks in ~50 s driving the real pipeline headless, both bugs of 2026-08-09 among them as named regression cases. | itself |
| 3a | **Declare the chain. BUILT 2026-08-09.** `pipeline/stages.ts` — seven stages with `dependsOn`, `kind`, inputs and outputs, plus `downstreamOf(id)`. Nothing reads it yet. | nine checks in the harness, tying it to `fieldSpec` and `WORLD_SPEC_FIELDS` |
| 3b | **Result per stage. BUILT 2026-08-09.** Climate, hydrology and ecology: sixteen `let`s became three nullable result objects, 39 pieces of module state down to 28. | step 2, plus a new check on the cached hydrology path |
| 3c | **Derive invalidation from the chain. BUILT 2026-08-09.** Both sides — the pipeline and WorldGenScreen — read `downstreamOf()`; the hand-written cascades are gone, and a stage that cannot run says so. | step 2, extended with the refusal contract |
| 3d | **`resetStage(id)` in both gestures. BUILT 2026-08-09.** One reset message for all seven stages, one table-driven input reset on the screen, and every message named after its stage. | step 2, plus a coverage check over the message contract |
| 4 | **Spec ownership** — the DOM stays the input and stops being the store; the unsaved-changes indicator is the first consumer. | step 2, `tsc` |
| 5 | **Untangle `showPanel`** — navigation must not commit. | step 2 |

Steps 1 and 3a–3c change no behaviour by construction. Step 3d does (that is the
point), and step 4 needs an i18n key for the indicator, to be proposed before it is
added.

### What the net found immediately

`resetTectonics` returned to the hand-over **only the first time**. Every later
reset landed on a world drifted by however far tectonics had run since the previous
one, and differently each time.

`deserializePlateSimulation` adopted the snapshot's arrays rather than copying them
— `seeds`, `motions`, `ages`, `rafts`, `features`, `hotspots`, `sutures`. That is
harmless for a snapshot read from a file and thrown away, which is every other
caller; the tectonics reset is the one place that keeps a snapshot alive and
restores from it repeatedly, so the sim built by the first reset wrote its own
drift back into the state it was meant to be able to return to. The epoch counter
is a number and reset correctly, which is why it looked fine.

It is the exact mirror of a problem the code already knew about: `finalizeArchean`'s
hand-over does a `structuredClone` because `serializePlateSimulation` hands back the
sim's OWN arrays, and its comment records the measurement (after 60 epochs a reset
restored epoch 0 but 20 rafts and 386 features instead of 13 and 0). Only the write
half had been closed. The read half now copies too, so no caller has to remember.

Worth noting for how the net is judged: this was found by a check nobody would
write from suspicion — "do it twice" — and it is invisible to golden, which never
sends a message and never deserializes anything.

### What the result objects changed, beyond tidiness

**A flag and two null checks became one question.** The hydrology's re-route
condition was `hydrologyDirty || !lastHydrologyRouting || !lastHydrologyDischarge`
— three expressions for "is the cache usable", which could disagree with each
other. It is now `!hydrology`. The state "dirty, but the arrays are still there"
stopped being representable.

**Two non-null assertions and a dead branch went with it.** The climate refinement
inside the hydrology pass re-read `lastClimatePrecip!` after replacing the cache;
`cacheAndPostClimate` now returns what it cached, so the pass rebinds instead of
asserting. And the branch guarded by `lastClimateTemperature && lastClimatePrecip`
was already unreachable — the handler's own entry check required the second, and
the first is only ever set together with it.

**One invalidation rule was found written out by hand.** `handleResetTectonics`
set `lastLakeBasinElevations = null` and `hydrologyDirty = true` inline: the exact
body of `invalidateAfterTopographyChange`, which exists so that rule lives in one
place. It calls the helper now.

**A gap the chain makes visible, left for 3c.** Going back to the hand-over drops
the hydrology and nothing else — a computed climate and ecology stay standing on a
world that no longer exists. `stages.ts` says every stage after tectonics is
downstream. The rules are still hand-written, so this is exactly what deriving
them from the edges fixes; changing it now would be a behaviour change inside a
restructuring step.

**Deliberately not converted:** the terrain. `lastRawElevations` is written by
genesis, tectonics *and* erosion, so it is the chain's shared substrate rather
than any one stage's result, and it belongs with the runner. Likewise the live
Archean and plate simulations, and the presentation state
(`renderOptions`, `renderInFlight`, the dry-basin/salt-flat render mirrors), which
is a different concern from stage results and was never part of the `last*`
families.

One harness bug found while writing the check for the cached path: the tests fed
`riverDensity: 0.5` into a control that runs 0..100, so "half" was in fact the
sparsest network it can ask for and two very different requests came back
identical. The harness now uses the slider's own default and says why.

### 3c found the rule written twice, and drifted

The cascade existed in two places. In the screen:
`invalidateClimate()` called hydrology and ecology, `invalidateEcology()` called
migration — which is exactly `downstreamOf('climate')` and `downstreamOf('ecology')`.
In the pipeline: two named helpers doing a smaller version of the same thing.

They disagreed. The screen dropped the climate on every topography change (six
sites: starting tectonics, starting erosion, resetting erosion, loading,
regenerating, resetting tectonics); the pipeline kept it and dropped only the
hydrology. So after an erosion the two halves of one pipeline held different
answers to "what is this world now", and the rivers could be routed over a climate
computed for the terrain of one pass ago.

A real bug fell out of the same gap: retuning a **climate slider** recomputed the
climate but staled nothing, so the ecology overlay went on showing values derived
from a climate that no longer existed. Both sides now derive the cascade from
`stages.ts`, and the screen stales downstream when a fresh climate lands.

**One exemption, and it needs the message to carry it.** The hydrology pass
refines the climate mid-flight (v2, for terminal basins that turn out to be dry
land) and emits a second `climateData`. Cascading on that would have torn down the
river display in the middle of building it, so the message says `refinement: true`
and the screen skips the cascade — the pass that sent it is redoing that work
itself.

### Silence was the other half of the problem

Deriving invalidation on the pipeline side alone would have introduced a hang.
Every compute handler has an early return for a missing upstream result, and those
returns were silent: the screen had already set its in-flight flag, disabled the
controls and begun waiting. WorldGenScreen carried a comment about precisely this
("the worker no-ops without it, which would leave ecologyInFlight stuck") and
guarded one of the five cases by mirroring the pipeline's state — a guard that
holds only while both copies agree, which is what 3c set out to stop relying on.

So a stage that declines now says so, naming itself and what it is short of
(`stageDeclined`), and the screen releases the flag and any promise the save chain
is holding. That removes the class, not the instance: it also covers the four
cases nobody had guarded, and a save begun in that state used to never finish.

**A gap the change exposed:** there was no `WorkerOutboundMessage` union.
WorldGenScreen listed the twelve result types by hand in its `onmessage`
signature, so adding a thirteenth compiled cleanly and simply never reached a
handler — the inbound direction has had an exhaustive table all along. The union
now exists and the screen takes it.

### 3d: both gestures, named

**The state reset was three messages for one idea.** `resetErosion`,
`resetTectonics` and `archeanReset` — and the other four stages had no reset at
all. Now one `resetStage(stage)`: what "back where it started" means stays
stage-specific (the Archean rebuilds from its seed, tectonics returns to the
hand-over, erosion re-renders the terrain it was handed), but what follows is
generic and comes from the chain. The four stages that had no reset got one for
free, and the switch is exhaustive over `StageId`, so a new stage cannot be added
without deciding what resetting it means.

**The input reset already existed, unnamed, three times.** The climate, ecology and
migration panels each restored their own sliders with a hand-written list. The
climate one wrote its *labels* as literals (`'0'`, `'100'`) beside values it took
from the declaration — so a changed default would have left the panel showing a
number the slider was not on. `resetInputs(stage)` reads the controls from the
stage table instead, via a binding that `sliderField` records as it emits the
markup. The thirteen ecology abundance nudges keep their own loop: they share one
range and reach the save as a group, so they are deliberately not named controls.

**The messages say which stage they belong to.** `start` → `tectonicsStart`,
`erode` → `erosionStart`, `computeClimate` → `climateRun`, `archeanInit` →
`genesisInit`, and so on. The Archean stage is `genesis` in the pipeline — the
panel and every save on disk already said so — while the module stays `archean/`,
which models the geological era. Two names, each with a domain: Genesis is the
phase in the editor, the Archean is what it simulates.

**A gap closed on the way:** the harness listed message types by hand to check they
all dispatch, which could silently fall behind the contract. The pipeline now
exports `HANDLED_MESSAGE_TYPES` and the harness asserts every one of them is
exercised somewhere in the file.

## Deliberately not doing

**Splitting per stage into `archeanStage.ts`, `climateStage.ts`, …** The handlers
are thin — gather inputs, call the real module in `climate/`, store, post — because
the work already lives in the stage modules. Per-stage files would mostly be 30-line
adapters, and once the runner is generic several of them collapse into one shared
one-shot path. Splitting first would freeze exactly the adapters the generic path
should delete. This is the trigger rule from `CLAUDE.md`, and the erosion/deposition
split is the local precedent for getting it wrong.

Make it data first; then see how much file is left. A 1500-line file of which 400
lines are a declaration table is not a problem.

**A from-scratch rewrite.** The design above and the staged plan converge — the
steps are the incremental path to it. The thought experiment earned two
sharpenings, not a rebuild: declare the *contract* table rather than a reset-only
dependency list, and do the per-stage result structs in the same step as the chain,
since reset over nine separate `let`s stays fragile however well the chain is
declared.

### What declaring it settled, and what it exposed

Three things the table had to get right, each of which would have been a plausible
guess and each of which the code answered differently:

- **`landMask` is not a climate output.** It is a climate-grid field, and the
  climate stage looks like its producer — but the save derives it from
  precipitation's ocean sentinel at write time. Listing it would have been a lie
  the harness now catches.
- **A module's controls are not a stage's controls.** `surface/` declares three,
  belonging to two different stages: `erosionStrength` and `drainageRefresh` to
  erosion, `riverDensity` to hydrology. The table is keyed by stage, so it says so.
- **Three stages write `elevation`, two write `biome`.** Overlapping outputs are
  real — genesis, tectonics and erosion each refine the same field, and hydrology
  overrides the climate's biome for riparian and salt-flat cells. This is why
  `outputs` cannot be a partition.

The spec table turned out to already agree: every path in `WORLD_SPEC_FIELDS` is
exactly `<stage>.<control>`, for all twelve. The stage grouping existed implicitly
in the save format before it existed anywhere in the code, which is a good sign for
the ids being the right ones — and the harness now asserts the two tables reference
the *same* `InputParam` objects, so they cannot drift.

One duplication fell out on the way: `ECOLOGY_FIELD_NAMES` in the save's field
registry relisted the fourteen ids of `EcologyFieldId`, in the same order — and
that order is the save's layer order, so the two had to agree with nothing making
them. The ids are now an array in `ecology/ecologyField.ts` with the union derived
from it, and the registry takes them from there.

## Open questions

1. **What the Archean stage is called.** Three names for one thing: the module is
   `archean/`, the panel and every save on disk say `genesis`, the messages say
   `archeanInit`/`archeanStart`. The table picked `genesis` because that is what
   the two user-facing surfaces already committed to, but step 3d renames the
   messages and is the moment to decide whether the module follows.
2. **Where the stage table lives.** With the pipeline (it describes runtime
   sequencing) or in `world/` (it is close to the save's recipe). The criterion from
   `CLAUDE.md` argues for the pipeline: running a stage does not need to know *which*
   world is meant.
3. **Whether the micro-tile inspector is a stage at all.** It consumes the pipeline
   but produces nothing downstream — closer to a query than to a stage.
4. **Whether `restoreWorld` sets stage results or replaces the chain's state
   wholesale.** It currently writes state directly, which is how the archean leftover
   bug survived.

## Related

- [architecture-unification.md](./architecture-unification.md) — module contracts,
  the input/tune parameter split, and part C's spec-ownership sequence
- [archean-genesis.md](../decisions/archean-genesis.md) — the handover this pipeline
  sequences
- [world-save-format.md](../decisions/world-save-format.md) — where a stage's
  recorded inputs end up
