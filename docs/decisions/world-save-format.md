---
summary: A saved world is a .zip — a human-readable YAML recipe/status + a JSON sim snapshot + the two heavy float rasters + a preview, restorable instantly and offline.
date: 2026-07-24
status: implemented (v1alpha1)
---

# World Save / Load Format

The worldgen screen's top-left folder/floppy buttons load and save a world as a
`.zip`. Everything in the generation pipeline is deterministic (seeded), so in
principle the config alone could regenerate a world by replay — but replaying a
300-epoch tectonics run takes a while, so the sim state is stored too. Result:
loads are **instant** and survive generator-code changes.

## Zip contents

```
<name>.zip
├── world.yaml       # the recipe (spec) + how far it was taken (status)
├── state.json       # the sim snapshot (PlateSimulationSnapshot)
├── oceanAge.f32     # ocean-age raster, Float32 256×128
├── elevation.f32    # current (post-erosion) elevation, Float32 2048×1024
└── preview.png      # 512×256 thumbnail of the composited map
```

### world.yaml (Kubernetes-style)

```yaml
apiVersion: casas-eternas/v1alpha1
kind: World
metadata:
  name: <name>
spec:
  seed: "<seed>"
  platesTotal: <int>        # plate count
  landRatio: <int>          # land fraction %
  initialContinents: <int>  # craton count
  clusterFactor: <int>      # clustering %
  tempOffset: <int>         # climate temperature offset °C
status:
  tectonicsRun: <epochs>
  erosionRun: <passes>
```

`spec` is the human-editable recipe; `status` records where the world was taken
to. `apiVersion` versions the *generator*: while worldgen is under active
development, a save only guarantees a faithful reload against the same code
version — bump the version on breaking generation changes so old saves are
recognizably out of date.

## What's stored vs regenerated

- **Stored** (in `state.json` + the two `.f32`): the sim snapshot — plate seeds/
  motions/ages, rafts, terrain features, ocean age, epoch, warp seed, the flags,
  and the **RNG internal state** (so continuation is bit-identical) — plus the
  eroded elevation. These are what's expensive to replay.
- **Regenerated on demand** (cheap, not stored): the derived plate `types`, the
  boundary-detection lattice (its accumulators reset — a rift/merge just re-locks
  over a few epochs), and all **climate layers** (temperature/wind/precipitation
  recompute from the elevation + `tempOffset` when the climate panel opens).

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
