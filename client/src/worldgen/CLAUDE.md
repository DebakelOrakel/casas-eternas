# worldgen — the flat-torus generator

The world **wraps in both X and Y**. Every distance, sample and neighbour lookup
must go through the toroidal helpers in `core/`; a plain `dx = a - b` is a bug
near the seam. See `docs/decisions/world-topology-torus.md`.

`worldgenWorker.ts` is the entry point and stays at this root, but it is **only
transport** — twenty-odd lines wiring `self` to the pipeline. The pipeline is
`pipeline/runtime.ts`: it holds every stage's live state as module-level `let`s
and orchestrates everything below. It takes its emitter and its elevation
renderer from the host (`setEmitter`, `setElevationRenderer`) and touches no
browser API itself, so it can be driven directly from Node — which is the only
way this part of the generator can be tested at all, since the golden harness
does not reach it. `pipeline/messages.ts` is the message contract.

Where this is going: [docs/design/generator-pipeline.md](../../../docs/design/generator-pipeline.md).

```
pipeline/   messages (the worker contract), runtime (stage state + handlers)
core/       mapConfig, toroidal, rng, field (the shared samplers), minHeap, interpolation
mantle/     the buoyancy field BOTH eras run on — the substrate, so it depends only
            on core/ and crust/ and never on tectonics/
archean/    the Archean era; hands over to tectonics via finalizeArchean.ts, which
            is the ONLY archean file that may import from tectonics/
tectonics/  plate*, boundary*, oceanAge, terrainFeatures, volcanoes,
            tectonicsTuneParams (tuning constants), epoch/ (the per-epoch phases)
crust/      continental crust as rafts — deliberately decoupled from the plates
            (docs/decisions/continental-crust-rafts.md); crustTuneParams holds the
            raft rules both eras pass in
elevation/  elevationScale (what a height MEANS), elevationField, domainWarp, ridgedNoise
surface/    flowRouting, erosion, hydrology, amplify
climate/ ecology/ migration/ render/
```

## Resolutions — check before you sample

Fields do **not** share one grid. This is the single most common source of wrong
answers here.

| Grid | Size | Holds |
|---|---|---|
| World / macro raster | 2048×1024, 7800 m per cell | elevation, discharge, lakeDepth, biome |
| Climate | 256×128 (~62 km per cell) | temperature, precipitation, seasonality, monsoon, all ecology |
| Ocean age | 256×128 | oceanAge |
| Mantle | 128×64 | mantle buoyancy and flow |

In the baked save (`world/save/worldLayers.ts`) only the layers marked `fullRes`
are on the world raster — today `biome`, `lakeDepth`, `discharge` and `elevation`.
Everything else is written at climate resolution.

Note what a coarse save layer means for a field that is computed finely: the
reduction is a *choice*, and `downsampleMax` is the wrong one for anything
sampled per point. `lakeDepth` used to take it, which let a single lake cell
claim its whole 62 km cell and inflated saved lake area 4× (2026-08-09).

**The 2048 macro raster is the sole authority and the only persisted form.** The
4k/8k amplification bake is derived presentation: it may refine the macro shapes,
never contradict them, is never serialized into a save, and is never fed back
into the generator (`docs/decisions/worldmap-amplification.md`, rule 4). "Finest
available" is therefore never the right rule for picking a source.

Ocean is marked by a different sentinel per aspect — `OCEAN_PRECIP`,
`OCEAN_AMPLITUDE`, `ECOLOGY_OCEAN` (which is `-1`, so "no negatives" is the wrong
invariant for ecology fields) — plus plain `elevation > 0` in other places. Do
not assume; look up which one the field you touched uses.

## Before touching anything: the harnesses

```
cd client && npm run harness:roundtrip       # the save format; 0.2 s
cd client && npm run harness:pipeline        # the pipeline's behaviour; ~50 s
cd client && npm run harness:golden          # the generator; ~13 min (4 world builds at 2048×1024)
cd client && npm run harness:golden:record   # re-record the metric baseline, on purpose
cd client && npm run harness:golden:hash     # arm the refactor guard (layer 4)
```

`golden` has three permanent layers: **invariants** (no baseline, so a failure is always a
bug), **determinism** (one seed built twice in the same run, hashed against
itself), and **metrics** (magnitudes against `golden.json` with per-metric
tolerances, default 2 %, reported as deltas). It loads the real modules through
Vite's SSR pipeline because these modules use extensionless imports.

**Refactoring? Arm layer 4 first.** `npm run harness:golden:hash` freezes a
per-stage byte hash into `golden-hashes.json`, and every later `npm run harness:golden`
reports any stage that moved. Delete the file when the refactor lands — the
layer exists only while the file does. It is needed because the other three
cannot make this check: metrics carry a 2 % tolerance, so a sub-percent shift
passes green, and determinism only ever compares a run against itself inside one
process. The baseline is machine-local and gitignored; record it where you work.

**Know its blind spots:**

- It does **not** cover `pipeline/runtime.ts`. Message ordering and cache
  invalidation are invisible to a field check — that is `npm run harness:pipeline`'s job
  (see its own header). It drives the real pipeline headless on a small world:
  hand-over, resets, save→restore, the stage chain, invalidation, stopping a pass
  mid-flight. Run it after touching anything under `pipeline/`. What it still does
  NOT reach is the screen — panel switching, button state and the DOM half of a
  reset are unguarded.
- It does **not** cover the amplification bake's terrain. The artifact KEY is
  guarded (the pipeline version is a stage in layer 4, and `npm run harness:roundtrip`
  checks that every constant it lists actually moves it), but the baked heights
  themselves are not.
- It does **not** cover the save format. That is `npm run harness:roundtrip`'s job —
  quantisation, the recipe's layout, the identity hashes, the artifact bytes and
  the shared zip reader, in 0.2 s. Run it after touching anything under
  `world/save/` or `storage/`.
- Before blaming a golden failure on your change, `git stash` and re-run to see
  whether it already fails on `HEAD`.

## Parameters and identity

Every module with tuning has an `xyTuneParams.ts` holding ONE object; genesis,
erosion, climate, hydrology, ecology and migration also declare their sliders in
an `xyInputParams.ts` (min/max/step/default/unit/i18n key), and `world/save/worldSpec.ts`
turns those declarations into the save's recipe. The reasoning is in
`docs/design/architecture-unification.md`.

Deliberately still outside a tuning object: `elevationScale.ts` (a definition
module and a fifteen-file contract), each module's EXPORTED constants (an export
is a cross-module contract and moves separately), and `surface/`'s
`DEFAULT_*_PARAMS` (function arguments with defaults, not module constants).

**A tuning file exports ONE object, and callers read it under its full name** —
`TECTONICS_TUNING.splitGap`, never a destructured local and never an
`as TUNE` import. The object is what makes the constants hashable at all
(`derivePipelineVersion` takes a `Record<string, number>`); the full name is what
keeps every use site findable by grep. Both shortcuts were tried and removed the
same day.

**Not every constant belongs in a tuning object.** Only those whose change alters
the generated world. Grid sizes, unit anchors (`elevationScale` calls itself the
place that says what a height MEANS), enum ids and sentinels are structural;
colours, decimation and exaggeration are presentation — a colour change must
never invalidate an artifact. Slider endpoints are a third thing again: they are
the input's schema, so they belong with `xyInputParams`.

**A hash belongs to the consumer, not to the module.** Do not add a canonical
`hashParams()` anywhere. `world/identity.ts` explains why in detail, and it
was learned expensively: `deriveWorldId` hashes the output *rasters* rather than
the recipe, because the recipe cannot distinguish two worlds stopped at different
tectonic epochs; and `riverDensity` is deliberately excluded from the key even
though the bake reads it, because including it orphaned 17–67 MB of artifact per
slider position.

Tuning constants *are* hashed, via `derivePipelineVersion`, but only one module
feeds it today.

## Traps that have bitten before

**Routing differs by step, and conflating them is a recurring mistake.** Erosion
is hybrid: drainage-area *accumulation* is MFD, stream-power *incision* is D8.
Rivers in `hydrology.ts` are pure D8 for both — MFD smeared the drawn channels
into valley-floor bands.

**The overlay canvas is displayed vertically mirrored.** Draw "up" as `+y`; text
needs a further 180°. It is a vertical mirror, not a 180° rotation — arrow
directions depend on that distinction. Affects `render/continentLabelRenderer.ts`
and the paint layers in `screens/worldgen/`.

**Vector overlays must wrap.** The compositor canvas does not wrap, so a label or
marker straddling the seam gets clipped and the tiling then repeats the clipped
copy. Any new vector paint layer drawing at specific map coordinates goes through
`paintWrapped`; full-raster layers already cover the canvas and do not need it.

**Workers spawned from inside a worker use the `?worker` import form**, not
`new URL(..., import.meta.url)` — `import.meta.url` is empty in a nested worker in
Firefox, and the worker is created but never runs. The render pool that
`pipeline/runtime.ts` constructs is exactly this case. (The Firefox failure is
dev-server only; production builds are fine.)

**Erosion deletes the material it removes** — there is no excavation budget. That
is a deliberate, documented unrealism; marine deltas are a separate shipped
mechanism. A sediment-budget attempt failed because erosion and deposition only
discriminate mountain from plain when they compete in one sweep.
