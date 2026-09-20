---
summary: One manifest convention (apiVersion/kind/metadata/spec/status) for stored objects, the exact shape of each kind, and which generated files move out of the world save into the artifact store.
date: 2026-08-15
updated: 2026-08-15
area: platform
stage: idea
status: proposal — nothing built; the WorldLayers kind needs a pipeline version that does not exist yet (see Open)
---

# Stored object manifests, and the save/artifact split

Two proposals in one doc because the second produces the kinds the first
specifies.

## 1. The convention

**Envelope for what LIES, plain JSON for what FLIES.** A stored, long-lived
object with an identity gets a manifest; a request body, a response body and a
serializer's private format do not.

```yaml
apiVersion: <group>/<version>
kind: <Kind>
metadata:   # identity and display
spec:       # what was asked for; the artifact key is a subset of it
status:     # what came out; observed, may be rewritten
```

The value is the three rules, not the four words: the schema is versioned,
identity is separate from content, and **asked-for is separate from observed**.

### `metadata`, identical in every kind

```yaml
metadata:
  name: <readable, changeable, display only>
  uid: <the object's own durable identity — only where it has one>
  createdAt: <RFC3339, written once>
```

- **`name` replaces the artifact's `label`**, which was the readable name under
  the wrong word. Never a path segment and never part of a key: the readable
  seed prefix was cut out of `worldId` on 2026-08-12 because it was the only
  route by which user text reached server paths.
- **`uid` is filled only where identity is independent of the store.** A world
  keeps its uuid on the server, in OPFS and in a downloaded zip. An artifact does
  not — the same bytes get a *different* uid in each store ("uids are minted per
  store; identity is the KEY",
  [ArtifactStore.ts](../../client/src/storage/ArtifactStore.ts)) — so a uid in
  the manifest would make a copied entry lie about itself. Artifacts identify
  themselves through `spec`, which is already what lets a hand-copied directory
  of any name be re-indexed. Deriving the artifact uid *from* the key instead
  would reinstate the path-encoded layout abandoned on the same date.
- **`createdAt` is RFC3339**, unifying the client's epoch millis with the Go
  store's `time.Time`. Written once and carried across re-saves.
- **No `labels`.** Every fact a listing groups by is in `spec`, and `spec` is
  authoritative; a selector map would be a second source for one fact. Not built
  on spec.
- **No `updatedAt`.** Artifacts are immutable; for a world `status.revision`
  already says what changed.
- `metadata` is never read to decide *identity*. It may be read for policy —
  artifact eviction falls back to `createdAt` for LRU after a restart.

### API groups

One group per *migration cadence*, not per module.

| Group | Kinds | Migration cost |
|---|---|---|
| `casas-eternas` | `FlatWorld` | High — data nobody can recompute |
| `artifacts.casas-eternas` | `AmplifiedTerrain`, `WorldLayers` | Zero — the store is droppable |

### Exceptions

| File | Why no envelope |
|---|---|
| HTTP request/response bodies | Wire, not storage. `{stages:[2,4]}` gains nothing from a kind. |
| `casas.yaml` | Would break "a setting's dotted key IS its flag IS its `CASAS_*` variable" — a `spec:` prefix is a second name for one thing. |
| `state.json` | Private format of `serializePlateSimulation`, read only by its inverse. Gets a bare `formatVersion` — it has **no** version today, which is a real gap. |
| `manifest.json` | Describes bytes in its own container, not an object with identity. Keeps `formatVersion`. |
| Server world/revision `meta.json` | Server-owned bookkeeping, and headed into `world.db`, where the bucket is the kind. |
| `golden.json`, `golden-hashes.json` | Machine-local baselines, no identity. |

### Parser constraint

`world.yaml` is read by two hand-written indentation-tracking regex parsers —
[recipeYaml.ts](../../client/src/world/save/recipeYaml.ts) and
[save.go](../../internal/modules/world/save.go). Flat, single-occurrence keys
only. `apiVersion`/`kind`/`metadata` are free; lists, anchors and repeated keys
are not.

## 2. The kinds

### `casas-eternas/v1alpha1`, `kind: FlatWorld` — `world.yaml`

Shipped, and near enough unchanged. `apiVersion` henceforth versions **this
object's schema** and not the generator (that is `status.generator`), so it stays
`v1alpha1` and the next *schema* change bumps it. `metadata.createdAt` is new.

```yaml
apiVersion: casas-eternas/v1alpha1
kind: FlatWorld
metadata:
  name: <seed text or "world">
  uid: <world uuid — the world store's address>
  createdAt: <RFC3339 — when the world was generated>
spec:
  seed: "<seed string>"
  genesis: { mantleVigour, water }
  erosion: { erosionStrength, drainageRefresh }
  climate: { tempOffset, humidity, contrast, equatorOffset }
  hydrology: { riverDensity }
  ecology:  { carryingCapacity, concentration, provinceStrength, <13 abundances, grouped> }
status:
  erosionRun: <int>     # no home in the snapshot; load-bearing
  revision:  <int>      # the server's optimistic lock / ETag
  generator: <BUILD_VERSION>
```

`spec` is generated from [worldSpec.ts](../../client/src/world/save/worldSpec.ts)
— the table's order IS the file order. `status` holds only what `state.json`
does not.

`createdAt` must be **carried across save and load**, the way `metadata.uid` and
`status.revision` already are, or every save re-births the world. It is a
different fact from the server world record's own `createdAt` (when *that* server
first saw the world); the server keeps its own and does not copy this one.

### `artifacts.casas-eternas/v1alpha1`, `kind: AmplifiedTerrain` — artifact `meta.json`

Shipped as a flat bag; this regroups the same fields.

```json
{
  "apiVersion": "artifacts.casas-eternas/v1alpha1",
  "kind": "AmplifiedTerrain",
  "metadata": {
    "name": "<seed text · 4096² — the only name a no-uid entry has>",
    "createdAt": "2026-08-15T09:20:00Z"
  },
  "spec": {
    "worldUid": "<uuid | no-uid>",
    "worldId": "<16 hex — deriveWorldId>",
    "pipelineVersion": "<derivePipelineVersion(AMPLIFY_CONSTANTS + rounds)>",
    "variant": "2",
    "algoVersion": 8,
    "rounds": 2,
    "constants": { "seedRoughnessM": 60, "...": 0 }
  },
  "status": {
    "width": 4096, "height": 2048,
    "bakeMs": 102000,
    "riverPointCount": 0, "riverPolylineCount": 0,
    "files": { "elevation.u16": 16777216, "lakeDepth.u8": 8388608,
               "rivers-55.f32": 0, "riverLengths-55.u32": 0 }
  }
}
```

- **No `metadata.uid`** — see the convention: identity is `spec`.
- **`constants` stays written out**, not only hashed — a hash cannot be reversed
  into the values a future key migration needs.
- **`status.files` is an observation**, which is what "an entry is as complete as
  the files it can name" rests on. Payload is written first, this manifest last.
- Files beside it, unchanged: `elevation.u16`, `lakeDepth.u8`,
  `rivers-{density}.f32`, `riverLengths-{density}.u32`.

### `artifacts.casas-eternas/v1alpha1`, `kind: WorldLayers` — new

The macro query layers, lifted out of the save. Same envelope, plus the layer
table that `manifest.json` used to carry for them — verbatim the same entry
shape, so one reader serves both.

```json
{
  "apiVersion": "artifacts.casas-eternas/v1alpha1",
  "kind": "WorldLayers",
  "metadata": { "name": "<seed text · macro layers>", "createdAt": "2026-08-15T09:20:00Z" },
  "spec": {
    "worldUid": "<uuid | no-uid>",
    "worldId": "<16 hex>",
    "pipelineVersion": "<TO BE DEFINED — see Open>",
    "variant": "macro"
  },
  "status": {
    "world": { "width": 2048, "height": 1024, "topology": "torus" },
    "generator": "<BUILD_VERSION>",
    "layers": [
      { "name": "biome", "file": "biome.u8", "kind": "raster",
        "resX": 2048, "resY": 1024, "dtype": "u8",
        "encoding": { "scale": 1, "offset": 0 }, "unit": "id", "landOnly": false }
    ],
    "files": { "biome.u8": 2097152, "lakeDepth.u8": 2097152, "discharge.u16": 4194304 }
  }
}
```

### The key

`ArtifactKey` grows a kind and renames `stage`:

```
{ kind, worldUid, worldId, pipelineVersion, variant }
```

`variant` is the kind's own discriminator: the amplification factor
(`"2"`, `"4"`, `"8"`) for `AmplifiedTerrain`, `"macro"` for `WorldLayers`. The
rename is the point — one field was about to carry both *what a thing is* and
*which variant of it*, and the near-field hex tiles
([hex-world-view.md](hex-world-view.md)) do not fit a resolution string at all.

Server-side this is `artifacts.Key` plus one field; the store is droppable, so
the migration is "drop the store".

## 3. What moves out of the save

Classification, not a size cut:

| Class | Files | Where |
|---|---|---|
| Recipe | `world.yaml` | World record (a DB row) |
| Irreducible history | `state.json`, `mantle.f32`, `lattice.{acc.f32,lock.i16,class.i8}`, `oceanAge.f32` | World record — 300 epochs of replay, not recomputable |
| Authority | `elevation.f32` | World record — **stays**, see below |
| Derived, coarse | `layers/` at 256×128 (temperature, precipitation, precipitationEffective, seasonalAmplitude, monsoonIndex, landMask, 13 ecology fields) | Save — ~64 KB each, and `precipitation` feeds `deriveWorldId` |
| Derived, full-res | `layers/biome.u8`, `layers/lakeDepth.u8`, `layers/discharge.u16` | **→ `WorldLayers` artifact** |
| Face | `preview.png` | Save — 50 KB, the server already extracts it for listings |

≈ 8 MB raw out of the save, the full-res half.

**Why `elevation.f32` stays**, though it is derivable (2K erosion is today a pure
function of snapshot + `erosionStrength` + `drainageRefresh`):

1. `deriveWorldId(elevation, precipitation, …)` is the basis of *every* artifact
   key. As an artifact it could not be named without first being fetched.
2. `worldgen/CLAUDE.md`: the 2048 raster is the sole authority and the only
   persisted form. An artifact is droppable by definition — a generator change
   would silently alter an old world's terrain, which is exactly what
   "rehydrate, not replay" exists to prevent.

Keeping the coarse climate layers in the save is what makes (1) hold without a
second key basis.

**`manifest.json` stays** and shrinks to the layers still in the archive. The
three that left are listed with their location instead of a file, so the
"sample any world value with no generation code" promise
([queryable-world-save.md](../decisions/queryable-world-save.md)) degrades to one
resolve call rather than to nothing:

```json
{ "name": "discharge", "location": "artifact",
  "key": { "kind": "WorldLayers", "worldId": "…", "pipelineVersion": "…", "variant": "macro" } }
```

## 4. Open

- **`WorldLayers` has no pipeline version.** `derivePipelineVersion` takes its
  constants as an argument on purpose, and only `AMPLIFY_CONSTANTS` feeds it
  today. The macro layers consume the climate, hydrology and ecology tuning
  objects; none of them is hashed. This must be built before the kind can be
  keyed at all.
- **`worldId` does not fully determine `WorldLayers`.** It hashes elevation and
  precipitation; `lakeDepth` and `biome` also read *temperature*. Either extend
  the key basis for this kind or record temperature's inputs in `spec`.
- **Cross-machine determinism of the macro pass is unmeasured.** The amplify
  harness asserts it for the bake; nothing asserts it for the 2K path. Required
  before anything macro is treated as recomputable rather than stored.
- 2K erosion is a pure function only *because* a second press restarts it
  ([runtime.ts:553](../../client/src/worldgen/pipeline/runtime.ts#L553) re-renders
  from the simulation and discards the eroded field). Making erosion cumulative
  would make `status.erosionRun` part of what identifies the terrain.
