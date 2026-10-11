---
id: DEC-0005
title.en: World Save / Load Format
title.de: Format zum Speichern und Laden einer Welt
summary.en: A saved world is a .zip — a human-readable YAML recipe/status + a JSON sim
  snapshot + the two heavy float rasters + a preview, restorable instantly
  and offline.
summary.de: Eine gespeicherte Welt ist ein .zip — ein lesbares YAML-Rezept mit Status,
  ein JSON-Schnappschuss der Simulation, die zwei schweren Float-Raster und
  eine Vorschau; sofort und offline wiederherstellbar.
area: platform
stage: built
createdAt: 2026-07-24
updatedAt: 2026-09-29
related: [DES-0003, DEC-0009, DEC-0033]
---

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
├── mantle.f64            # mantle buoyancy field, Float64 per cell of its field mesh
├── mantle.json           # that mesh: { cells, spacingM } (DEC-0036, formatVersion 8)
├── lattice.acc.f32       # boundary-detection accumulator, Float32 256×128
├── lattice.lock.i16      # epochs each lattice point has held its class, Int16
├── lattice.class.i8      # last boundary class per lattice point, Int8
├── oceanAge.f64          # ocean-floor age (epochs), Float64 per cell of its field mesh
├── oceanAge.json         # that mesh: { cells, spacingM } (DEC-0036 phase 2, formatVersion 8)
├── elevation.f32         # current (post-erosion) elevation, Float32 2048×1024
├── refined.json          # the climate refinement's mesh, months, fields, ENSO (DEC-0036 phase 5)
├── refined/…             # its values, Float32 per cell of the climate's field mesh, one file a field
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
  progress: <step id>       # since 2026-10-11; the last step accepted by moving forward — documentation, in no id or hash; absent for none
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

2026-10-11 (formatVersion 8, DEC-0036 phase 1): the mantle is no longer a raster.
It lives on a field mesh, and the save holds the mesh's values (`mantle.f64`,
Float64, the session's exact bytes) and what identifies the mesh (`mantle.json`:
cell count and spacing in metres); the mesh is rebuilt from the world's shape and
size. A save without the two entries, or with another mesh's, is refused on load
(no conversion: the format is alpha). An Archean save carries the same pair as
`archean.mantle.f64` / `.json`, and `archean.streak.i16` per mesh cell.

The same day (DEC-0036 phase 2, still formatVersion 8 — the DEC-0036 phases are
one move, one version): the ocean age left its 256 × 128 raster `oceanAge.f32`
the same way, for `oceanAge.f64` (its field mesh's values, Float64) and
`oceanAge.json` (cells, spacing). A tectonic save without the pair — a
version-8 save from a build before phase 2 among them — is refused on load. An
Archean save has none (no ocean age before the hand-over).

The same day (DEC-0036 phase 5, still formatVersion 8): the climate step's
refinement left its quantised raster layers (`layers/temperature.01` …
`layers/thunder`, one per month and field at 256 × 128, and
`layers/enso.json`) for its field mesh's values: `refined/<field>.f32`,
Float32 per cell of the climate's mesh (a month-stacked field months ×
cells), and `refined.json` (cells, spacing, months, the fields with their
units, the wind's unit in m/s, the ENSO see-saw's period and strength).
Float32 is what the session itself keeps, so a loaded refinement is the
session's to the bit and is adopted without computing it again; the layers
were coarser (u8/u16) and clipped at their ranges. A save without a
refinement loads unrefined; a save with the old layers and no
`refined.json`, or with the values of another mesh, is refused.

### Format choices

- Elevation → **binary Float32** (`.f32`), the field meshes' values (mantle,
  ocean age) → **binary Float64** (`.f64`), not png/jpg: they're
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

## Addendum 2026-09-29 — formatVersion 7

The fourteen ecology layers are no longer written: the ecology is a rule
evaluated where one looks (decisions/ecology-as-function.md) and is
computed on load. The generator now loads the climate refinement from the
save (the layers of formatVersion 6; its field mesh's values since DEC-0036
phase 5) instead of computing it again; a save
without it is refined on load. The hydrology is still computed on load;
whether to load it from the save too is open.

## Status

implemented (v1alpha1)
