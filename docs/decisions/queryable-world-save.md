---
summary: Extend the world save into a self-describing, QUERYABLE dataset — every world aspect we generate is baked into field-layer rasters (+ vector layers) described by a manifest, so a game server can look up any value by sampling, with ZERO knowledge of the generation algorithms. The recipe (regenerate) and sim snapshot (continue) stay alongside, serving different consumers.
date: 2026-07-26
area: platform
stage: building
status: Phase 1 BUILT (2026-07-26) — main-thread bake from caches; see status note at end
---

# Queryable world save (baked layers)

Extends the existing `.zip` save (see `world-save-format.md`). Motivated by the
game **server**: when a generated world is handed to the server that runs the
game, the server must answer spatial queries ("what biome / temperature /
resources are at (x, y)?") **without running or even knowing the generation
algorithms**.

## Problem

Today's save stores only the *expensive-to-reconstruct* intermediates: the sim
snapshot (`state.json`) + the post-erosion elevation raster + ocean-age. Climate,
hydrology and ecology are **not** stored — the client recomputes them on demand.
For the server that's the wrong shape: it would have to either (a) run the exact
same generation code (hard coupling, TS-bound, every algorithm change must stay
in lockstep), or (b) look values up. **(b) is the goal.**

## Decision

Make the save a **three-purpose layered dataset**, each purpose independent:

| Purpose | Artifact | Consumer |
|---|---|---|
| **Regenerate** from scratch | `world.yaml` (recipe: seed + params) | the generator (deterministic replay) |
| **Continue / evolve** the sim | `state.json` (sim snapshot) | the generator/editor (step more epochs, re-erode, re-tune) |
| **Query** the finished world | **baked field layers + `manifest.json`** (+ vector layers) | the **game server** (pure lookup, no algorithms) |

The three coexist in the same zip; each consumer reads only what it needs (the
server ignores `state.json`; the generator ignores the baked layers). Keeping the
snapshot **and** baking is deliberate: the snapshot is small vs. the rasters, and
dropping it would force a full regenerate (expensive + algorithm-drift risk) to
ever reopen/evolve a world.

**Rejected: share-the-code** (server runs the generation modules). Smaller saves,
but couples the server to the client's exact algorithms + language, and any
generator change would silently alter old worlds. Baking freezes each world's
data so old saves stay readable forever without new code.

## Format

The zip gains a **`manifest.json`** (the self-describing contract) + a set of
baked **layer files**. A consumer needs *only* the manifest + a ~50-line sampler
— no generation knowledge.

### `manifest.json`

```jsonc
{
  "formatVersion": 1,
  "generatorVersion": "…",        // provenance; NOT needed to read
  "world": { "width": 2048, "height": 1024, "topology": "torus" },  // wraps x & y
  "layers": [
    { "name": "elevation",   "file": "layers/elevation.u16",  "kind": "raster",
      "resX": 2048, "resY": 1024, "dtype": "u16",
      "encoding": { "scale": …, "offset": … }, "unit": "relative" },
    { "name": "temperature", "file": "layers/temperature.u8", "kind": "raster",
      "resX": 256, "resY": 128, "dtype": "u8",
      "encoding": { "scale": 0.294, "offset": -30 }, "unit": "°C" },
    { "name": "carryingCapacity", …, "sentinel": 255 },   // ocean = sentinel
    { "name": "discharge", "file": "layers/discharge.u16", "kind": "raster",
      "resX": 2048, "resY": 1024, "dtype": "u16",
      "encoding": { "scale": 4, "offset": 0 }, "unit": "m3/s" },
    // …
  ]
}
```

Per-layer metadata makes each layer readable blind: `resX/resY` (its own grid —
climate/ecology are coarse 256×128; elevation, lakes, discharge and **biome**
are full-res), `dtype`, `encoding`
(`value = stored·scale + offset`), `unit`, and `sentinel` (a reserved stored code
marking "not applicable", e.g. ocean). A shared **`landMask`** raster is also
provided for the common land/ocean test.

### Baked layers (what gets stored)

- **Tectonics/erosion:** elevation (full-res), oceanAge, landMask.
- **Climate:** temperature, precipitation, seasonalAmplitude, monsoonIndex,
  wind (u,v), currents (u,v) — all coarse — plus **biome at full res** (2026-08-08:
  the classification is pointwise and reads elevation, so a 62 km biome cell could
  not place a treeline, and a game whose unit of place is a ~1.5 km hex asks
  exactly that. See climate-biomes.md).
- **Hydrology:** discharge, lakeDepth (raster) + **rivers** (vector polylines,
  reusing the existing `RiverPolylines` shape).
- **Ecology:** carryingCapacity + the 13 resource fields.
- **Later (Anthropology):** settlements, territories, trade graph — all as
  **vector layers in the same manifest** (forward-fit, no format change).

### Encoding / size

Coarse fields (256×128 = 32k cells) quantize to `u8`/`u16` with a documented
`scale/offset` → ~32–64 KB each; ~15 fields < 1 MB. Elevation full-res is the only
large raster (~4 MB as u16). All zip-compressed. Dequantise = one multiply-add
(in the manifest), so the sampler stays trivial.

### Versioning

`formatVersion` (sampler contract) + `generatorVersion` (provenance). The server
reads any `formatVersion` it supports from the manifest alone; it never needs the
generator that produced the world.

## The sampler (lookup contract)

A tiny, **algorithm-free** function, driven only by the manifest — shared by the
client (to bake + self-verify) and reimplemented by the server (any language):

```
lookup(manifest, layers, name, x, y):
  L = manifest.layer(name)
  gx = floor(wrap(x, world.width)  / world.width  * L.resX)
  gy = floor(wrap(y, world.height) / world.height * L.resY)
  raw = layers[name][gy * L.resX + gx]           // (bilinear for smooth fields)
  return raw == L.sentinel ? NONE : raw * L.encoding.scale + L.encoding.offset
```

Vector layers (rivers, later settlements/graph) are consumed directly or via a
spatial query. This `lookup(aspect, x, y)` is exactly the "simple lookup function"
the whole design is for.

## The bake step (client)

At **save time**, run the full derivation chain once (climate → hydrology →
ecology) in the worker, collect *every* field's output (the compute functions
already exist — we just stop discarding them), quantise per the manifest, and
write the layers + manifest into the zip. The client keeps its live
recompute-on-slider for the *editor*; baking freezes a snapshot of the fields for
the *server*. Determinism guarantee: the server sees exactly what the client
showed — no recompute, no drift.

## Open questions (finalise at build)

- Per-field quantisation precision (which fields need `u16`/`f32` vs `u8`;
  discharge has a huge dynamic range → maybe log-encode or `f32`).
- Sentinel vs. shared `landMask` per layer (some fields are ocean-valid: SST,
  currents — those keep data over ocean; land-only fields use the mask/sentinel).
- Keep oceanAge? (marginal for gameplay — decide by whether the server needs it.)
- River/vector on-disk shape (reuse `RiverPolylines` binary, or GeoJSON-ish JSON).
- Bilinear vs nearest per layer (smooth climate → bilinear; biome/enum → nearest).

## Implementation phases

1. **Manifest + sampler + bake for the existing aspects** (tectonics/climate/
   hydrology/ecology). Self-verify: client bakes, then samples back and compares
   to the live fields.
2. **Anthropology** outputs slot in as new vector/raster layers — no format change.

See also `world-save-format.md` (current zip layout) and
`resolution-strategy.md` (why climate/ecology are coarse).

## Implementation status (Phase 1, 2026-07-26)

Built as a **main-thread bake** (lower risk — no worker orchestration): the shared
contract module `client/src/worldgen/worldSave/worldLayers.ts` (`WORLD_LAYERS`
specs, `bakeLayer` quantiser, `decodeLayer`/`sampleAt` sampler, `downsampleMax`),
and `bakeQueryLayers()` in WorldGenScreen writes `manifest.json` + `layers/*.{u8,u16}`
into the save zip from the main thread's cached fields. `elevation.f32` (also the
restore raster) is referenced as a manifest layer; rivers as `layers/discharge.u16`.

## Rivers: a field, not polylines (revised 2026-08-08)

The river layer was `layers/rivers.json` — polylines of `[x, y, widthPx]`. It
was written by one place and read by **none**, and it served neither consumer:

- The **client** draws, and it has the algorithm. It re-derives its rivers
  deterministically from elevation + precipitation + `spec.hydrology.riverDensity`
  — all three in this save — or fetches an amplified artifact. The world map
  already ignored the stored polylines outright, because after a bake they lie
  beside the fine valleys rather than in them.
- The **game server** queries, and polylines answer nothing. Their only
  attribute is a drawing width, `0.4 + 3.6·√(Q/Qmax)` **clamped at 4**, so every
  large river saturates and discharge cannot be recovered.

Worse, once amplified bakes existed the save and the map gave two different
answers to "where are the rivers" — 13,000 km of channel against 101,000.

So rivers are now `discharge`: one number per cell, sampled like `biome` and
`lakeDepth`. Three choices worth recording:

- **Map resolution, not climate resolution.** It is the only baked layer that
  is. At 256×128 a cell spans ~62 km, which can say a region has a river but
  not where it is — useless for siting a settlement or a ford.
- **Cubic metres per second**, not the hydrology's own mm/yr-summed-over-cells.
  Converting costs the writer one multiply and saves the reader from needing
  the cell area and the runoff coefficient — precisely the algorithm knowledge
  this format exists to avoid.
- **Unthresholded.** Zeroing everything below our channel criterion would bake
  this generator's river-density setting into the data; the raw field lets a
  consumer choose its own.

Measured on a real world: largest river 8,114 m³/s, smallest channel 318 m³/s,
worst round-trip error 2 m³/s (half a step), nothing clipped, and **71 KB after
DEFLATE against 303 KB for the JSON polylines it replaces**. The save got
smaller and answers more.
Round-trip (bake→decode→sample) verified within quantisation error.

**Baked now:** landMask, temperature, precipitation, biome, seasonalAmplitude,
monsoonIndex, lakeDepth, the 14 ecology fields, elevation (f32), discharge.

**`precipitationEffective` added 2026-08-09.** The climate's precipitation plus
the riparian bonus — rivers and lakes moistening their surroundings — i.e. the
field the biomes were actually classified from, at climate resolution (64 KB).
It is here for one reason: **so biomes can be reclassified without a drainage
network.** The worldmap re-derives biomes on its amplified terrain, and deriving
the riparian effect there would mean routing and accumulating flow over an
8-million-cell raster on every load, to recover something that is regional
anyway. Stored beside `precipitation` rather than replacing it, because the two
answer different questions: one is what falls, the other is what the ground
effectively gets, and only the second classifies biomes.

**lakeDepth stopped being downsampled 2026-08-09.** It was `downsampleMax`'d to
climate resolution on the way out, which is the right reduction for "is there a
lake in this region" and the wrong one for a layer that gets *sampled per point*:
taking the maximum lets one lake cell claim its whole 62 km cell. Measured on the
calibration seed — the saved layer reported lakes covering **14.98% of the world
against a true 3.70%, a 4× inflation**, with 85% of the cells it called lake less
than half water, and an implied lake volume four times the real one. Costs 93.7 KB
deflated against 5.8 KB (2 MB raw, but the field is zero almost everywhere), which
is the same order as the discharge layer and ~1% of a save. This was pure loss:
the field is computed at 2048×1024 and was being thrown away at the door.

**Compute-on-save ✅ (2026-07-26):** the save button now runs the full derivation
chain first (climate → hydrology → ecology, awaited via one-shot resolvers on the
existing data handlers), *then* serialises + bakes — so completeness no longer
depends on which panels were visited. Gated on `erosionRunCount >= 1` (same
prerequisite as those panels): a pre-erosion world bakes only `elevation` +
manifest; a processed world bakes everything. No panel switch, no warning — the
manifest honestly lists whatever the world's stage produced. The chain runs on the
main thread reusing `requestClimate/Hydrology/Ecology` (no worker rewrite).

**Not yet / caveats (follow-ups):**
- **Not baked yet:** wind + currents (interleaved u,v → add as 2 layers each),
  raw discharge, oceanAge-as-query-layer (still saved as `oceanAge.f32` for
  restore, just not in the manifest — its resolution/gameplay value TBD).
- Nearest-sampling only so far (biome wants nearest anyway; smooth fields could
  add bilinear in the sampler later).
