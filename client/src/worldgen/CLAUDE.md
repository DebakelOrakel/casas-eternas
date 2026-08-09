# worldgen — the flat-torus generator

The world **wraps in both X and Y**. Every distance, sample and neighbour lookup
must go through the toroidal helpers in `core/`; a plain `dx = a - b` is a bug
near the seam. See `docs/decisions/world-topology-torus.md`.

`plateSimulationWorker.ts` is the entry point and stays at this root. It holds
the pipeline's live state as module-level `let`s and orchestrates everything
below.

```
core/       mapConfig, toroidal, rng, field (the shared samplers), minHeap, interpolation
archean/    the Archean era; hands over to tectonics via finalizeArchean.ts
tectonics/  plate*, boundary*, mantleField, oceanAge, terrainFeatures, volcanoes,
            tectonicsParams (all tuning constants), epoch/ (the per-epoch phases)
crust/      continental crust as rafts — deliberately decoupled from the plates
            (docs/decisions/continental-crust-rafts.md)
elevation/  elevationScale (what a height MEANS), elevationField, domainWarp, ridgedNoise
surface/    flowRouting, erosion, hydrology, amplify, deltaGrowth, tileErosion
climate/ ecology/ migration/ render/ worldSave/
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

In the baked save (`worldSave/worldLayers.ts`) only the layers marked `fullRes`
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

## Before touching anything: the golden harness

```
cd client && npm run golden               # check; ~13 min (4 world builds at 2048×1024)
cd client && npm run golden record        # re-record the metric baseline, on purpose
cd client && npm run golden hash-record   # arm the refactor guard (layer 4)
```

Three permanent layers: **invariants** (no baseline, so a failure is always a
bug), **determinism** (one seed built twice in the same run, hashed against
itself), and **metrics** (magnitudes against `golden.json` with per-metric
tolerances, default 2 %, reported as deltas). It loads the real modules through
Vite's SSR pipeline because these modules use extensionless imports.

**Refactoring? Arm layer 4 first.** `npm run golden hash-record` freezes a
per-stage byte hash into `golden-hashes.json`, and every later `npm run golden`
reports any stage that moved. Delete the file when the refactor lands — the
layer exists only while the file does. It is needed because the other three
cannot make this check: metrics carry a 2 % tolerance, so a sub-percent shift
passes green, and determinism only ever compares a run against itself inside one
process. The baseline is machine-local and gitignored; record it where you work.

**Know its blind spots:**

- It does **not** cover `plateSimulationWorker.ts`. Message ordering and cache
  invalidation are invisible to a field check; that needs a manual click-through
  (tectonics, erode and stop mid-pass, reset erosion, climate → rivers → ecology →
  migration, save and load).
- It does **not** cover the amplification bake. `AMPLIFY_CONSTANTS` and
  `derivePipelineVersion` are unguarded, so a change there can silently orphan
  every cached artifact.
- Before blaming a golden failure on your change, `git stash` and re-run to see
  whether it already fails on `HEAD`.

## Parameters and identity

Only `tectonics/tectonicsParams.ts` currently exists as a dedicated tuning file —
every other module keeps its constants as file-local `const`s. The agreed
direction (per-module `xyTuneParams.ts` / `xyInputParams.ts`, a `WorldSpec` type,
declared slider ranges) is written up in
`docs/design/architecture-unification.md`. Follow it for new work rather than
adding to the current spread.

**A hash belongs to the consumer, not to the module.** Do not add a canonical
`hashParams()` anywhere. `storage/artifactKey.ts` explains why in detail, and it
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
Firefox, and the worker is created but never runs. The render pool inside
`plateSimulationWorker` is exactly this case. (The Firefox failure is dev-server
only; production builds are fine.)

**Erosion deletes the material it removes** — there is no excavation budget. That
is a deliberate, documented unrealism; marine deltas are a separate shipped
mechanism. A sediment-budget attempt failed because erosion and deposition only
discriminate mountain from plain when they compete in one sweep.
