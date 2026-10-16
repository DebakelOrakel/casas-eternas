---
id: DEC-0039
title.en: Artifacts by content
title.de: Artefakte nach Inhalt
summary.en: An artifact is keyed by its content only (worldId, pipeline
  version, stage), without the world's uid, so a copy and every reader of a
  world find what was baked for the same terrain. Only job workers write
  artifacts to the server; the browser does not bake and does not upload. A
  caller reads an artifact through a world they may read whose terrain ids
  include its worldId; the server learns a world's terrain ids from the
  worker. Every signed-in caller who may read a world may order a bake.
summary.de: Ein Artefakt wird nur nach Inhalt geschlüsselt (worldId,
  Pipeline-Version, Stufe), ohne die uid der Welt, damit eine Kopie und
  jeder Leser einer Welt findet, was für dasselbe Gelände gebacken wurde.
  Auf den Server schreiben nur Job-Worker; der Browser backt nicht und lädt
  nichts hoch. Gelesen wird über eine lesbare Welt, deren Gelände-Ids die
  worldId enthalten; die Ids erfährt der Server vom Worker. Jeder
  angemeldete Aufrufer mit Leserecht darf einen Bake bestellen.
area: platform
stage: decided
createdAt: 2026-10-16
related: [DES-0028, DEC-0017, DEC-0037, DES-0011]
---

## Where this starts

[rights-and-artifacts.md](../design/rights-and-artifacts.md) (DES-0028)
recorded the problem: both artifact stores key an entry by
`(worldUid, worldId, pipelineVersion, stage)`, so a copy of a template (a
new uid, the same `worldId`) finds none of the template's levels and tiles
and bakes them again. Players of a game will read the artifacts of worlds
they do not own, which is the same problem. The user decided forks 1 and 2
of that sketch on 2026-10-16; its forks 3–8 (roles, visibility, guards)
stay ideas there.

Two facts of the code shaped the answers:

- **The server does not know a world's `worldId`.** The client derives it
  in TypeScript from the dequantised layers (`world/identity.ts`). The
  world store holds only a hash of the zip bytes (`RevisionMeta.ContentHash`),
  which differs from the `worldId` by design. The job worker derives the
  `worldId` from the stored save, and that value is trustworthy.
- **The browser could upload what it baked** (`TieredArtifactStore.write`,
  in the background). With the uid in the key, a wrong upload hurt only the
  uploader's own world. With content keys, an editor of ANY world could
  write bytes under a foreign `worldId`, and every reader of that terrain
  would get them.

## Fork 1 — The key

**Answer: `(worldId, pipelineVersion, stage)`.** The uid leaves the key. An
artifact is a deterministic function of its key (the engine is
byte-identical across JS engines, `generator/core/detMath.ts`), so one copy
serves every world with that terrain. The flat layout
(`artifacts/{artifactUid}/meta.json`, DEC-0017) stays; the key in
`meta.json`, the resolve, the listing, the sweep and the access check
change. The browser's OPFS store uses the same key.

Rejected: a resolve that falls back to the `copied-from` uid (DEC-0037,
fork 5). The copy then loses its artifacts silently when the template is
deleted, and the fallback answers only copies, not players.

## Fork 2 — Who writes

- **Workers and browsers**, as today.
- **Two areas**: workers write the shared area by content; a browser's
  upload stays in the uploader's area under the old key.
- **Workers only.**

**Answer: workers only.** A job token is bound to one world, and its worker
computes the bytes from that world's stored save, so the content is a
function of the key by construction. The browser does not bake and does not
upload: it reads from the server and keeps a copy in OPFS. An `Authorization`
that is not a job token gets `403` on `resolve` with `create`, on
`write-link` and on `commit`. (Today the browser bakes nothing; this closes
the path before a browser bake can use it.)

## Fork 3 — How the server learns a world's terrain

**Answer: from the worker.** When a job token resolves an artifact, the
artifacts module records the pair (the token's world uid, the `worldId` of
the request) through an injected function, `BindTerrain(uid, worldId)`,
which cmd/ composes: a closure over the co-resident world module, or an
HTTP call to the world service on a route that accepts only a job token for
that world. The world module keeps the set as `terrains` in the world's
`meta.json`. Every Put carries the set across, as it does the owner (the
trap that DEC-0037, fork 1, names: the meta is rebuilt from the upload).

- A world that was never baked has no terrain ids, so it reads no
  artifacts. Its first job finds what already exists under its `worldId`,
  binds it and does not compute it again: for a copy uploaded from the
  browser, that job is short.
- A server copy (`POST …/copy`) copies the set: same terrain by
  construction.
- A new revision with new terrain adds its id at its first bake. Old ids
  stay in the set: the world had that terrain, and the artifacts are what a
  reader of the old revision needs. The set is not pruned with the
  revisions.

## Fork 4 — Who reads

**Answer: through a world.** Each read request names a world uid, as today.
The caller may read the artifact when they may read that world (viewer and
up, including the template rule of DEC-0037) AND the world's terrain ids
include the artifact's `worldId`. Knowing a `worldId` alone gives nothing.
`WorldAccess` returns the terrain ids with the level. The anonymous caller
reads the artifacts of a template; DEC-0037 kept them closed only because a
copy did not share them.

The listing shows an entry once, for each `worldId` bound to a world the
caller may read. `callerLevel` on an entry is the highest level the caller
has on such a world.

## Fork 5 — Who orders a bake

**Answer: every signed-in caller who may read the world.** The bytes are
the same whoever orders them, so ordering is a cost, not a right over the
world: the owner of a copy orders a level the template lacks, and the
template has it from then on. The anonymous caller cannot order (a job has
no one to answer for it otherwise). A job token orders nothing, as today.
Quotas, if they come, are a guard after this check (DES-0028, fork 6).
Cancelling stays with an editor of the world, plus the caller who ordered
the job.

## Fork 6 — Removing artifacts

- **Delete a world:** the client's sweep before the delete stays, but it
  removes only the artifacts of the world's terrain ids that NO OTHER world
  binds. The world module answers that through a second injected function,
  `TerrainHeld(worldId, exceptUid)`.
- **Drop a level** (editor today): allowed to an editor only when no other
  world binds the terrain; else it takes an admin. A shared level serves
  other people's worlds.
- The size eviction (`artifacts.cap`) is unchanged.

## Fork 7 — The old entries

**Answer: none are kept.** Old entries carry a uid in the key, and some may
come from a browser upload, which fork 2 no longer trusts. The new code
does not read them. The operator clears the store once after the deploy
(`DELETE /v1/artifacts`, admin), and the browser's OPFS cache drops entries
in the old format at start. Everything is computed again by the next jobs.

## Status

2026-10-16: decided with the user (forks 1 and 2 of DES-0028, the rest
here). Not built.
