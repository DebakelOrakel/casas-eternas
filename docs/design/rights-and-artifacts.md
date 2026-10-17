---
id: DES-0028
title.en: Rights by role, artifacts by content
title.de: Rechte nach Rolle, Artefakte nach Inhalt
summary.en: Idea sketch, not decided. Store artifacts by content only, so a
  copy and the game find a world's artifacts without baking again; let the
  right to read an artifact follow the worlds that hold its content; turn
  the access levels into roles that are sets of actions, with two
  pseudo-principals (authenticated, anyone) in place of the public and
  template bits; keep conditions such as quotas as separate guards; let the
  API tell the client the allowed actions. Go only; hand-made, no policy
  library.
summary.de: Ideenskizze, nicht entschieden. Artefakte nur nach Inhalt
  ablegen, damit eine Kopie und das Spiel die Artefakte einer Welt finden,
  ohne neu zu backen; das Leserecht an einem Artefakt folgt den Welten mit
  seinem Inhalt; die Zugriffsstufen werden zu Rollen, die Mengen von
  Aktionen sind, mit zwei Pseudo-Principals (angemeldet, jeder) statt der
  Bits public und template; Bedingungen wie Kontingente bleiben eigene
  Wächter; die API sagt dem Client die erlaubten Aktionen. Nur Go;
  handgemacht, keine Policy-Bibliothek.
area: platform
stage: idea
createdAt: 2026-10-15
related: [DEC-0037, DEC-0017, DES-0011]
---

Records a conversation (2026-10-15), after template worlds (DEC-0037) were
built. Nothing here is decided; the user wants to think it over. When it is
decided, the forks below become a decision document that revises parts of
DEC-0017 (server storage), DES-0011 (access control) and DEC-0037.

## The problem

**A copy bakes again.** Both artifact stores key an entry by the world's
uid as well as by its terrain id: `meta.json` carries
`(worldUid, worldId, pipelineVersion, stage)` (DEC-0017, addendum of
2026-08-11). The uid was put there as a grouping: deleting a world sweeps
what it earned, a listing reads per world, and the rights of an artifact
follow its world. A copy of a template has a new uid and the same
`worldId`, so it finds none of the template's baked levels and tiles,
although their bytes would be the same. It computes them again: time and
storage spent twice.

**The game has the same problem.** Players must read the artifacts of a
world they do not own.

**Rights.** A user who does not own a world should not start a new fine
simulation (a bake) for it; a reader should still read what exists.

**The access model is outgrowing its shape.** Today: levels in one order
(`none < viewer < editor < owner < admin`), each action needs a minimum
level, and two bits make exceptions: `public` (every signed-in caller is a
viewer) and `template` (every caller, also anonymous, is a viewer; DEC-0037).
Coming needs do not fit one order: game roles (player, game master,
spectator) are not ranked; each new kind of visibility adds a bit and an
`if`; "may bake only within a quota" is a condition, not a level.

## Fork 1 — Artifacts by content

Key an artifact by `(worldId, pipelineVersion, stage)` only. The uid
leaves the key. An artifact is a deterministic function of its key, so one
copy on disk serves every world with that content.

- **Copy**: same `worldId`, so it finds everything at once. No copying, no
  fallback through `copied-from`.
- **Delete**: the store is a cache (all of it can be computed again; the
  size eviction `--artifacts-cap` exists). When a world is deleted, a sweep
  removes the artifacts whose `worldId` no remaining world has. No
  reference counts.
- **Change**: the flat store (`artifacts/{artifactUid}/meta.json`, since
  2026-08-12) stays; the key in `meta.json`, the resolve, the sweep and the
  access check change. The browser's OPFS store the same. Old entries with
  a uid in the key: rewrite once, or let the eviction age them out.

Rejected on the way: a resolve that falls back to the `copied-from` uid
(the copy loses its artifacts silently when the template is deleted);
copying the entries on a server copy as hard links (works on the server,
not for a copy into the browser, and keeps the uid grouping that causes the
problem).

## Fork 2 — Who reads an artifact, who makes one

- **Read**: a caller may read an artifact if the caller may read ANY world
  whose `worldId` it is. Knowing the `worldId` alone is not enough; the
  right always comes through a world.
- **Make (commission a bake or a tile job)**: only an editor or the owner
  of the world. A viewer, and so the owner of a copy, consumes what exists.
  - When the owner of a copy computes further, the content changes, the
    copy gets a new `worldId`, and from then on it is that user's world, to
    bake (and pay for) themselves.
  - A level a template lacks can be baked only by the template's owner or
    an admin; the copy shows "not baked yet".
- **Storage, later**: if quotas come, an artifact counts against the owner
  of the world it was baked for.

## Fork 3 — Roles as sets of actions

A role is a set of actions, not a rank:

| role | actions |
|---|---|
| viewer | read, read artifacts, copy |
| editor | viewer's, plus write revisions, commission bakes |
| owner | editor's, plus share, delete, transfer, set visibility |

Later roles (player, game master, spectator) are new rows; nothing is
re-ranked. Admin may do everything, as today.

## Fork 4 — Visibility as pseudo-principals

Grants map a principal to a role. A principal is a user, or one of two
pseudo-principals:

| visibility | grant | who sets it |
|---|---|---|
| private | users only | owner |
| signed in | `authenticated → viewer` | owner |
| public | `anyone → viewer` | admin (to start with: anonymous reads load the server with no one to answer for it) |

The bits `public` and `template` (as a read right) go away. The gate's
anonymous routes ask whether `anyone` holds a role on the world. A game
world is private; its players get grants.

## Fork 5 — Template is a purpose

"This world is offered as a starting point": it appears under the
Templates filter, and its main action is Make a copy. An admin sets it. It
needs a visibility of at least "signed in", else no one sees it; a
template for signed-in users only becomes possible. It grants nothing.

## Fork 6 — Conditions as guards

Conditions that are not roles (a quota, a rate limit, a job slot) run as
guards after the role check: `allow(caller, action, resource)` first, then
the guards of that action. The role table stays a table.

## Fork 7 — Where the rules live

- **Only the Go server enforces.** One function, `allow(caller, action,
  resource)`: collect the caller's roles (their own grants and the
  pseudo-principals'), take the union of the actions, check. A matrix test
  covers every role × action × visibility.
- **The client has no rights system.** It shows what the server allows:
  the API gives each world the caller's allowed actions (e.g.
  `actions: ["read", "copy", "bake"]`) in place of today's `callerLevel`.
  The client renders by that list and derives nothing; a new rule changes
  the server only. The derivations in `worldCards.ts` go away.
- **Worlds in the browser** belong to its user; nothing to check. Rights
  matter only where data comes from or goes to the server.

## Fork 8 — Hand-made or a library

Hand-made: about 100–200 lines of Go in `internal/access` plus the matrix
test, on the existing `grants.json`.

- Casbin: its own model file, policy language and storage adapters; our
  grants would need translating. More frame than rule.
- cedar-go (Cedar embedded, no server): clean and analysable, but its own
  language and entity model. Worth it when operators change rules at run
  time, or with many resource types and inheritance (organisation →
  project → world). The role table translates to Cedar 1:1, so that way
  stays open.
- ory/ladon and similar: hardly maintained.

## Open

- The names and the catalog keys of the visibility levels (to be proposed
  before they are added).
- Whether the owner may set "public" too, or only an admin.
- Migration of existing `grants.json` (`public`, `template`) and of the
  artifact keys.

## Status

2026-10-15: IDEA — recorded on the user's request; the user thinks it
over before anything is decided or built.

2026-10-16: forks 1 and 2 decided in
[artifacts-by-content.md](../decisions/artifacts-by-content.md) (DEC-0039),
with two changes: only job workers write artifacts (the browser does not
bake and does not upload), and every signed-in caller who may read a world
may order a bake, the owner of a copy included. Forks 3–8 stay ideas.

2026-10-17: forks 3–8 decided in
[roles-and-visibility.md](../decisions/roles-and-visibility.md) (DEC-0040):
the visibility as pseudo-principals, the template as a purpose and the
actions in the API are built; the roles stay ranked levels and the guards
wait for their first condition; hand-made.
