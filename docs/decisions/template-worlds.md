---
id: DEC-0037
title.en: Template worlds
title.de: Vorlagen-Welten
summary.en: An admin marks a server world as a template. A template is readable by
  every caller, also without an account, and anyone can make a copy of it — a
  new world with a new uid and the caller as owner, the same terrain, and the
  source named in world.yaml as the annotation casas-eternas/copied-from. The
  mark is a field of grants.json; the copy goes to the browser or, signed in,
  to the server, where the server makes it.
summary.de: Ein Admin markiert eine Server-Welt als Vorlage. Eine Vorlage ist für
  jeden lesbar, auch ohne Konto, und jeder kann eine Kopie erstellen — eine
  neue Welt mit neuer uid und dem Aufrufer als Besitzer, demselben Gelände und
  der Quelle in world.yaml als Annotation casas-eternas/copied-from. Die
  Markierung ist ein Feld der grants.json; die Kopie geht in den Browser oder,
  angemeldet, auf den Server, wo der Server sie erstellt.
area: platform
stage: built
createdAt: 2026-10-15
concepts: [generator.overview.worlds]
related: [DES-0011, DEC-0017, DEC-0022]
---

## Where this starts

The server should offer a few worlds as a start: a visitor, with or without
an account, picks one and works on a copy of it. The design was agreed with
the user on 2026-10-15. Its open points were five forks, recorded below.

Before this, a private world answered 404 to a stranger, and every route
under `/v1/` refused a request without credentials at the gate
([access-control.md](../design/access-control.md)). The rights of a world
live in its `grants.json`: an owner, named roles, a public bit.

## Fork 1 — Where the mark lives

- **A field in `grants.json`.** The grants are the world's ACL, and a
  template is first a rule of reading: every caller is a viewer.
- **A file of its own** (`template.json`) beside the grants. The ranking
  then reads two documents for one answer.
- **A field in `meta.json`.** The meta is rebuilt from the uploaded save at
  every Put — the bug class that once moved the owner with the last writer.

**Answer: the grants** — `"template": true`, with `Meta.Template` as a
display mirror, like the owner. The rule lives in one place,
`access.Grants.LevelOf`: on a template every caller is a viewer, the
anonymous caller (empty id) included. Wider than `public` by exactly that
caller. The world's content does not change, so its revision, its content
hash and its terrain id stay.

Who sets it: a new action `world.template` that needs `admin`. The owner
cannot set it: a template is offered to every visitor of the server, which
is a decision about the server, not about one world. `Store.WriteGrants`,
the owner's share path, keeps the mark as it is on disk whatever its
argument says; `Store.SetTemplate` is the mark's one writer. A world without
`grants.json` (from before grants existed) cannot be marked (409): the mark
must not decide its owner by the way.

## Fork 2 — How a caller without credentials gets through

- **Exempt paths** in the gate. The gate's exempt list holds exact paths;
  `/v1/worlds/{uid}` is a pattern, and an exempt route is public for every
  world, not for templates only.
- **A predicate from the module.** The gate lets a request through that
  carries NO credentials and that the predicate accepts; the module ranks
  the anonymous caller itself.

**Answer: the predicate**, `world.AnonymousReads`, which cmd/ hands to
`server.Gate` beside the exempt list. It accepts the four reads:
`GET /v1/worlds`, `/v1/worlds/{uid}`, `/meta`, `/preview.png`. The world
module then answers the anonymous caller with templates only — the list
holds nothing else, and every other world answers 401, as the gate would
have, so nothing tells whether a private world exists. A request WITH
credentials that do not verify is still refused at the gate: a client whose
session ran out must learn it on every route, these too.

Artifacts are not opened to the anonymous caller. A copy is a new world,
and its artifacts are its own (fork 5).

## Fork 3 — The copy

Routes:

| route | needs | does |
|---|---|---|
| `PUT /v1/worlds/{uid}/template` | admin | sets the mark; answers the meta |
| `DELETE /v1/worlds/{uid}/template` | admin | removes it |
| `POST /v1/worlds/{uid}/copy` | a signed-in caller who may read the world | a new world, 201 with its meta |

`GET /v1/worlds` gives each entry `template` and `callerLevel`, the level
the meta endpoint already states. The client offers "Make a copy" or "Open"
by it, and the mark only to an admin. No `?template=` filter: the list is
small, and the client filters.

A copy is a new world: a new random uid, the caller as owner (pinned in new
grants, private, not a template), the template's name, the same content.
world.yaml's `metadata` says the new uid and names the source:

```yaml
metadata:
  name: Calvessor
  uid: 282f8a72-6a5f-499b-adf6-1ccb720f9299
  annotations:
    casas-eternas/copied-from: 9f2c1b4e-7a30-4d55-8c11-2b6e5d0a1f83
```

**The annotation key.** Kubernetes style, `metadata.annotations` with a
prefixed key, as asked. The repo had no annotation or label convention in a
save yet; the one prefix in use is the save's own `apiVersion:
casas-eternas/v1alpha1`, so the key is `casas-eternas/copied-from`. The
prefix holds no dot, and that matters: the two world.yaml readers (Go
`readYAMLValue`, TS `readRecipeValue`) use the dot as their path separator.
Both now accept a `/` in a key. The annotation is documentation only;
nothing ranks or keys by it. A copy of a copy names its direct source. The
generator keeps the annotations through a load and a save
(`WorldRecord.annotations`), and they are no change in the "unsaved"
comparison.

**Which worlds may be copied.** Any world the caller may READ, not
templates only. A viewer can already download the archive and upload it
under a new uid, so a narrower rule would refuse nothing a caller cannot
already do. A world the caller may not read is the stranger's 404, as
everywhere. The anonymous caller cannot copy on the server: a server world
needs an owner.

## Fork 4 — Where the copy goes, and the list

"Make a copy" asks where, with the two rows of the title bar's save menu,
its words (`titlebar.save.browser.*`, `titlebar.save.server.*`) and its row
classes:

- **Keep in this browser** — for everyone, the signed-out user included.
  The client fetches the template's archive (templates are readable without
  an account), rewrites world.yaml with a new uid and the annotation
  (`world/worldCopy.ts`, the mirror of the server's rewrite, held to the
  same text by `harness:roundtrip` and the Go tests), and keeps it in the
  browser.
- **Store on server** — signed in: `POST …/copy`, nothing travels through
  the browser. Signed out the row is shown, not usable, with "Sign-in
  required".

The world list shows a template with a "Template" badge. Someone else's
template is copied, not opened: its card's main action is "Make a copy",
and its panel offers that alone. The owner and an admin open it as usual,
and may copy it too. An admin marks a server world, or removes the mark, in
its panel.

**The filter.** Templates are a fourth value of the place row — All · In
browser · On server · Templates — not a separate toggle. A template is
always a server world, so a toggle would add a combination (browser +
templates) that is empty by construction, and the place row already answers
"which worlds am I looking at". "All" keeps the templates, with their badge.
The shape row combines with it as before.

## Fork 5 — The artifacts of a copy

Both artifact stores key an entry by the world's uid as well as by its
terrain id (`artifacts/{artifactUid}/meta.json` with the key `worldUid,
worldId, pipelineVersion, stage`, [server-storage.md](./server-storage.md);
the browser's OPFS store the same). A copy has a new uid, so it finds NONE
of the template's baked levels and tiles, although its terrain id is the
same: they are computed again, as for any new world. The store is not
redesigned for this. The day it pays, a resolve that falls back from
(uid, worldId) to the same worldId under the `copied-from` uid would be the
smallest change; the access check would then rank the caller against the
source.

## Status

Built 2026-10-15. Go: `internal/access` (`Grants.Template`,
`ActionTemplate`), `internal/modules/world` (routes, `SetTemplate`,
`copySave`, `AnonymousReads`), `internal/server/gate.go` (the predicate),
`cmd/start.go` (the wiring). Client: `world/worldCopy.ts`,
`world/worldRecord.ts`, `server/worldClient.ts`, the world list. Not built:
an admin CLI command for the mark (the panel is the one way); the fallback
of fork 5.

2026-10-15: under review. [rights-and-artifacts.md](../design/rights-and-artifacts.md)
(DES-0028) sketches a revision: artifacts keyed by content only, so a copy
finds the template's artifacts; visibility as grants to pseudo-principals in
place of the `public` and `template` bits; the template mark as a purpose
that grants nothing. Not decided.

2026-10-16: **a job token never writes a world.** A bake job's token reads
the world it was made for and writes artifacts; the routes that write a
world — create (`PUT` of a new uid), copy, delete and the template mark —
answer `403` to it before they rank it, so the answer says nothing about
whether the world exists. Before, a job token could create or copy a
world, and its owner was then `job` (`token.SubjectJob`): every job token
owned it. Found in the review of DEC-0038; test
`TestAJobTokenWritesNoWorld`.
