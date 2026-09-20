---
summary: Reference for the .zip world save — what is inside (world.yaml recipe/status, state.json sim snapshot, .f32 rasters, preview.png) and how saving/loading flows through the worldgen screen.
date: 2026-07-26
updated: 2026-08-12
area: platform
stage: built
status: describes the shipped format and is kept current as it evolves; the fork behind it is decided in ../decisions/world-save-format.md
---

# World save format (`.zip`)

How a generated world is persisted and reloaded. Produced and consumed entirely
by the Hacedor del Mundo screen (`client/src/screens/worldgen/WorldGenScreen.ts`):
the floppy-disk button saves, the folder button loads. A browser can't write to an
arbitrary path, so saving triggers a normal download of `<seed>.zip`; loading takes
that file back via a file picker.

This replaces the earlier two-file (`.json` + `.f32`) *export* for hex-tile import,
which was removed — see git history if that's ever revived.

## What's in the `.zip`

Five entries, assembled in `saveWorld` / read back in the load handler:

| File | Purpose | Authoritative on restore? |
| --- | --- | --- |
| `world.yaml` | Human-readable recipe (`spec`) + how far it was taken (`status`) | No — drives the UI sliders only |
| `state.json` | The full simulation snapshot (`PlateSimulationSnapshot`) | **Yes** — the sim is rebuilt from this |
| `elevation.f32` | Full-resolution, post-erosion elevation raster | **Yes** — injected as-is (no re-erosion) |
| `oceanAge.f32` | Coarse ocean-floor age raster | **Yes** — restored into the sim |
| `preview.png` | Thumbnail for the file/gallery | No — cosmetic, not read on load |

The four load-critical files (`world.yaml`, `state.json`, `oceanAge.f32`,
`elevation.f32`) must all be present or the load is rejected as an invalid world
file; `preview.png` is optional.

Restore is a **rehydrate, not a replay**: `state.json` rebuilds the plate
simulation, `elevation.f32` is dropped in as the finished (eroded) terrain, and
`oceanAge.f32` restores the ocean floor — nothing re-steps or re-erodes. Climate and
hydrology are *not* stored; they're recomputed on demand from the restored terrain
when their panels are opened.

## `world.yaml`

A small Kubernetes-style manifest. Flat, single-occurrence keys — parsed by a tiny
regex reader (`readYamlValue`), not a full YAML library, so keep it flat.

```yaml
apiVersion: casas-eternas/v1alpha1
kind: FlatWorld
metadata:
  name: <seed or "world">
spec:
  seed: "<seed string>"
  platesTotal: 14          # initial plate count
  landRatio: 0.3           # target land fraction (0..1)
  initialContinents: 4     # craton count
  clusterFactor: 0.7       # continental clustering (0..1)
  tempOffset: 0            # global temperature offset, °C (greenhouse)
  humidity: 100            # global precipitation multiplier, %
  contrast: 100            # equator↔pole temperature spread, %
  equatorOffset: 0         # latitudinal shift of the climate band, % of map height
  riverDensity: 55         # river-density knob (0..100)
  erosionStrength: 4       # fluvial time-step multiplier (1..5)
  drainageRefresh: 5       # drainage-network re-derivations per erosion round (1..5)
status:
  tectonicsRun: <epoch>    # how many epochs of tectonics were stepped
  erosionRun: <count>      # how many on-demand erosion passes were applied
```

- **`kind: FlatWorld`** — the flat-torus generator (as opposed to the legacy sphere /
  Mars generators). Not validated on load, so older files with `kind: World` still load.
- **`spec`** mirrors the generation controls. On load, each field is written back to its
  slider (missing fields fall back to the slider's default), so a loaded world shows the
  parameters it was made with. The sim itself does **not** regenerate from `spec` — that
  comes from `state.json` — but the values are what a subsequent *regenerate* would use.
- The climate `spec` fields (`tempOffset`, `humidity`, `contrast`, `equatorOffset`) and
  `riverDensity` restore the climate/hydrology sliders so a recompute reproduces the same
  maps. `erosionStrength` / `drainageRefresh` restore the erosion sliders (they don't
  re-run erosion — `elevation.f32` already holds the eroded result).

## `state.json` — `PlateSimulationSnapshot`

The stateless "recipe" the tectonics field is generated from, plus the run's live
state. Serialized by `serializePlateSimulation` (`plateSimulation.ts`), restored by
`deserializePlateSimulation`. Shape:

```ts
{
  width, height,                 // grid dimensions (currently 2048 × 1024)
  initialPlateCount,             // starting plate count (drives the plate-count feedback)
  seeds:   PlateSeed[],          // Voronoi plate seed positions
  motions: PlateMotion[],        // per-plate rigid drift+spin (see plateMotion.ts)
  ages:    number[],             // per-plate age
  rafts:   Raft[],               // continental crust (metaball blob rafts, named)
  features: TerrainFeature[],    // mountain/rift/trench/volcanic deposits
  epoch,                         // tectonic epoch reached
  warpSeed,                      // domain-warp seed for the elevation field
  supercontinentActive,          // latch for the supercontinent milestone event
  continentalRiftCooldownUntil,  // breakup staging-interval bookkeeping
  hotspots: {x,y}[],             // fixed mantle-plume positions (volcanism)
  rngState                       // the sim RNG state, so a resumed run is deterministic
}
```

The mantle buoyancy field is **not** serialized — it's regenerated deterministically on
restore from `warpSeed` (see the worker's restore handler). Plate motions **are** stored
(a resumed run keeps drifting exactly as it was), whereas a pure frozen snapshot could
omit them.

## The `.f32` rasters

Raw little-endian `Float32Array` bytes, row-major, no header (dimensions come from
elsewhere):

- **`elevation.f32`** — `width × height` (2048 × 1024) floats = the worker's
  `lastRawElevations`: the **pre-redistribution physical** elevation (≈0 sea level,
  land baseline ~0.35, peaks approaching ~1), *after* whatever erosion passes were run.
  Not the cosmetic, display-gamma-curved values. This is what makes restore skip erosion.
- **`oceanAge.f32`** — `OCEAN_AGE_RES_X × OCEAN_AGE_RES_Y` (256 × 128) floats = the coarse
  ocean-floor age field, which drives age–depth on oceanic points (`elevationField.ts`).

## Compatibility

- `kind` and `apiVersion` are not enforced on load — forward/backward tolerant.
- Any missing `spec` field falls back to its slider default, so worlds saved before a new
  knob existed still load (they just get the default for the new knob).
- `state.json` is the source of truth for the terrain; a mismatch between `spec` and the
  snapshot (e.g. hand-edited yaml) affects only the displayed slider values, not the world.
