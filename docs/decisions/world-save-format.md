---
summary: A saved world is a .zip — a human-readable YAML recipe/status + a JSON sim snapshot + the two heavy float rasters + a preview, restorable instantly and offline.
date: 2026-07-24
updated: 2026-08-12
area: platform
stage: built
status: implemented (v1alpha1)
---

# World Save / Load Format

The format's contents are documented in the living reference
[design/world-save-format.md](../design/world-save-format.md); this doc records
the fork behind it.

The worldgen screen's top-left folder/floppy buttons load and save a world as a
`.zip`. Everything in the generation pipeline is deterministic (seeded), so in
principle the config alone could regenerate a world by replay — but replaying a
300-epoch tectonics run takes a while, so the sim state is stored too. Result:
loads are **instant** and survive generator-code changes.

## Zip contents

```
<name>.zip
├── world.yaml            # the recipe (spec) + what only it records (status)
├── state.json            # the sim snapshot (PlateSimulationSnapshot)
├── mantle.f32            # mantle buoyancy field, Float32 128×64
├── lattice.acc.f32       # boundary-detection accumulator, Float32 256×128
├── lattice.lock.i16      # epochs each lattice point has held its class, Int16
├── lattice.class.i8      # last boundary class per lattice point, Int8
├── oceanAge.f32          # ocean-age raster, Float32 256×128
├── elevation.f32         # current (post-erosion) elevation, Float32 2048×1024
├── manifest.json         # layer index for consumers (see queryable-world-save.md)
├── layers/…              # baked query layers (climate / ecology / rivers)
└── preview.png           # 512×256 thumbnail of the composited map
```

### world.yaml (Kubernetes-style)

```yaml
apiVersion: casas-eternas/v1alpha1
kind: FlatWorld
metadata:
  name: <name>
spec:
  seed: "<seed>"
  mantleVigour: <1-10>      # Archean mantle mixing (see archean-genesis.md)
  water: <0-100>            # water delivered; 50 = Earth-like
  tempOffset: <int>         # climate temperature offset °C
  humidity: <int>           # …and the rest of the climate / erosion / ecology sliders
status:
  erosionRun: <passes>
history:                    # since 2026-09-27; absent while no run has happened
  genesis:
    0: { epochs: 120, generator: <build>, values: { genesis: {…} } }
  tectonics:
    0: { epochs: 45, generator: <build>, values: { planet: {…}, tectonics: {…}, climate: {…} } }
    1: { epochs: 12, generator: <build>, values: {…} }
```

`spec` is the human-editable recipe. The four sliders that used to sit there —
plate count, land fraction, craton count, clustering — are gone: those specified an
OUTCOME, and the Archean simulation makes them emergent (see archean-genesis.md).

`status` holds **only what state.json does not**. It used to also carry
`tectonicsRun`, and `spec` an `archeanEpochs`, both duplicating fields the snapshot
already has (`epoch`, `archeanEpochs`) and neither read on load — two sources for
one fact. The erosion pass count has no home in the snapshot, so it stays here and
is genuinely load-bearing. `apiVersion` versions the *generator*: while worldgen is under active
development, a save only guarantees a faithful reload against the same code
version — bump the version on breaking generation changes so old saves are
recognizably out of date.

`history` records HOW the world came about: one entry per run of the Archean
and of the tectonics, with the slider values the run read, its epoch count and
the build that ran it. `spec` holds only the end values, and a world whose
sliders moved between runs was made by values the spec no longer shows. Runs
with unchanged values and build extend the last entry; a tectonics reset empties
the tectonics list, a fresh Archean both. Numbered maps rather than YAML
sequences, because the recipe reader walks dotted paths and knows no lists.
Documentation, not replay: nothing re-runs it (see `world/save/worldHistory.ts`).

## What's stored vs regenerated

- **Stored**: the sim snapshot — plate seeds/motions/ages, rafts (with blob birth
  epochs), terrain features, sutures, hotspots, ocean age, epoch, Archean epochs,
  sea-level offset, warp seed, the flags, and the **RNG internal state** — plus the
  eroded elevation, the mantle field, and the boundary-detection lattice.
- **Regenerated on demand** (cheap, not stored): the derived plate `types`, the
  lattice *geometry* (only its accumulated history is stored), and all **climate
  layers** (temperature/wind/precipitation recompute from the elevation +
  `tempOffset` when the climate panel opens).

The mantle field and the lattice accumulators used to be in the second list, on the
reasoning that both re-evolve toward the current configuration within a few epochs.
Measured against a world that was never saved, continuing for 40 epochs after a
round trip:

| restored | calibration | alpha | bravo |
|---|---|---|---|
| neither | differs | differs | differs |
| mantle only | identical | **differs** | identical |
| lattice only | differs | differs | differs |
| **both** | **identical** | **identical** | **identical** |

So they are needed together, and the RNG state alone never bought the bit-identical
continuation this section claimed. The reason is that neither is really derived: the
plate motions were *fitted* to the saved mantle field, and the plate positions came
from its extrema at the Archean handover — restoring a fresh field left the plates
drifting against a mantle that had never produced them.

Both are optional on load. Saves written before they were persisted still open, and
still get a regenerated mantle and an empty lattice.

### Format choices

- Elevation & ocean age → **binary Float32** (`.f32`), not png/jpg: they're
  physical float fields; a lossy image codec would corrupt sea-level edges, the
  lapse gradient, etc. The zip's DEFLATE compresses them losslessly.
- The sim snapshot → **JSON** (structured small data). Features dominate its
  size (~150 KB at 40 epochs, more at higher epochs); fine, it compresses.
- Preview → **PNG** (a lossy-tolerant color thumbnail for a future save browser).

## Flow

- **Save**: worker `serializeWorld` → returns the snapshot + ocean-age +
  elevation buffers → the screen builds `world.yaml` from the current UI + status
  and zips everything (JSZip, DEFLATE) → download.
- **Load**: file picker → unzip → set the UI + status from `world.yaml` → worker
  `restoreWorld` rebuilds the sim from the snapshot + ocean age and injects the
  stored elevation (no replay, no re-erosion) → the render it posts back displays
  the world. Climate recomputes on the next climate-panel open.

## Implementation

- `rng.ts` `SeededRandom.state()` exposes the mulberry32 counter for exact resume.
- `plateSimulation.ts` `serializePlateSimulation` / `deserializePlateSimulation`
  + `PlateSimulationSnapshot`.
- `plateSimulationWorker.ts` `serializeWorld` / `restoreWorld` messages +
  `WorkerWorldDataMessage`.
- `WorldGenScreen.ts` builds/parses the YAML (a tiny regex reader — no YAML dep),
  makes the preview, and drives JSZip; tracks `erosionRunCount` for the status.

## Not done / later

- Robustness against generator drift beyond the elevation raster (the replayed-
  free snapshot already covers it — this is why we store the state, not just the
  recipe).
- A save browser using `preview.png`; naming beyond the seed; validation of an
  `apiVersion` mismatch on load (currently best-effort).
