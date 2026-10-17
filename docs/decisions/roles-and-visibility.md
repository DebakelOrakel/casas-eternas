---
id: DEC-0040
title.en: Visibility by pseudo-principals, actions in the API
title.de: Sichtbarkeit über Pseudo-Principals, Aktionen in der API
summary.en: A world's visibility is a grant to a pseudo-principal
  (authenticated or anyone), in place of the public and template bits;
  the owner sets private or signed in, only an admin sets public. The
  template mark is a purpose and grants nothing. The API gives the client
  the actions the caller may perform, and the client derives no rule of
  its own. Roles stay ranked levels until a role comes that does not fit
  the order; guards wait for their first condition. Hand-made, no policy
  library.
summary.de: Die Sichtbarkeit einer Welt ist eine Berechtigung an einen
  Pseudo-Principal (angemeldet oder jeder) statt der Bits public und
  template; der Besitzer setzt privat oder angemeldet, nur ein Admin
  öffentlich. Die Vorlagen-Markierung ist ein Zweck und gewährt nichts. Die
  API gibt dem Client die erlaubten Aktionen; der Client leitet keine Regel
  selbst ab. Rollen bleiben geordnete Stufen, bis eine Rolle kommt, die
  nicht in die Ordnung passt; Wächter warten auf ihre erste Bedingung.
  Handgemacht, keine Policy-Bibliothek.
area: platform
stage: built
createdAt: 2026-10-17
related: [DES-0028, DEC-0039, DEC-0037, DES-0011]
---

## Where this starts

[rights-and-artifacts.md](../design/rights-and-artifacts.md) (DES-0028)
sketched forks 3–8; forks 1 and 2 became
[artifacts-by-content.md](./artifacts-by-content.md) (DEC-0039). The user
decided the rest on 2026-10-17, in this order: the actions in the API
first, then the visibility with the template as a purpose, the roles and
the guards when a need comes.

## Fork 3 — Roles as sets of actions

**Answer: not yet.** The three roles contain each other (viewer ⊂ editor ⊂
owner), so the total order still holds, and `access.Required` stays the
table. A role that does not fit the order (player, game master, spectator)
is the trigger to turn the levels into sets of actions. Fork 7 already
keeps the client independent of that change.

The table as it is since DEC-0039:

| level | actions |
|---|---|
| viewer | read, copy, read artifacts, order a bake |
| editor | viewer's, plus write revisions, remove artifacts of a terrain no other world holds |
| owner | editor's, plus share, set the visibility up to signed in, delete |
| admin | everything, plus the template mark and the public visibility |

Ordering a bake and cancelling it are checked in the jobs module
(DEC-0039, fork 5); `access.ActionBake` was not used any more and is
removed.

## Fork 4 — Visibility as pseudo-principals

**Answer: yes.** `grants.json` gives a role to a user or to one of two
pseudo-principals: `authenticated` (every signed-in caller) and `anyone`
(every caller, the anonymous one included). Only `viewer` is granted to
them. The visibility names the widest grant:

| visibility | grants | who sets it |
|---|---|---|
| `private` | users only | owner |
| `signedIn` | `authenticated → viewer` | owner |
| `public` | `anyone → viewer` (and `authenticated`) | admin |

- Route: `PUT /v1/worlds/{uid}/visibility`, body `{"visibility": …}`.
  It needs `world.share` (owner); `public` needs the new action
  `world.publish` (admin): anonymous reads load the server with nobody to
  answer for them. The owner may narrow a public world: who reads their
  world is theirs to restrict.
- The owner's share path (`Store.WriteGrants`) keeps `anyone` as it is
  stored, as it keeps the template mark.
- `Meta.Visibility` is a display mirror, as the owner and the template
  mark are.
- The gate's anonymous routes are unchanged: `world.AnonymousReads` lets
  the request through and the module ranks the anonymous caller, who is a
  viewer exactly where `anyone` holds the role.

**Migration:** none on disk. `access.Grants` reads the old form, which
always holds the key `public` (it had no `omitempty`) while the new form
never does: `public: true` becomes `authenticated → viewer`, and
`template: true` becomes `anyone → viewer` plus the mark. The next write
stores the new form. A template from before stays readable by everyone.

## Fork 5 — Template is a purpose

**Answer: yes.** The mark (`Grants.Template`, admin only) says "offered as
a start": it puts the world under the Templates filter and makes Make a
copy its main action. It grants nothing; who reads the world is its
visibility. A template for signed-in callers only is now possible. A
template that is private shows only to the callers who already read it.

## Fork 6 — Conditions as guards

**Answer: the pattern, nothing built.** A condition that is not a role (a
quota, a rate limit, a job slot) runs after the role check, as a guard of
that action. The first candidate is a quota on bakes, since every reader
orders them (DEC-0039).

## Fork 7 — Where the rules live

**Answer: only the server.** Every answer that the client renders by
carries `actions`:

| resource | route | actions |
|---|---|---|
| world | `GET /v1/worlds`, `GET /v1/worlds/{uid}/meta` | `world.read`, `world.write`, `world.share`, `world.delete`, `world.publish`, `world.template` (`access.Actions`) |
| job | `GET /v1/jobs`, `/v1/jobs/{id}`, the events | `job.cancel` |
| artifact | `GET /v1/artifacts`, `/v1/artifacts/levels` | `artifact.remove` |

The world answers keep `callerLevel`: the peer services rank a caller
through it (cmd/'s `artifactWorlds` and `WorldAccess` over HTTP); the
client does not read it. The jobs and artifacts answers lose
`callerLevel`, `mayCancel` and `shared`. The client's derivations
(`worldCards.ts`, the artifact window, the job window, the upload's
check for a world it may write) read the actions.

## Fork 8 — Hand-made or a library

**Answer: hand-made**, in `internal/access`, with its tests. Cedar stays
the way out when operators change rules at run time or resources nest.

## Status

2026-10-17: decided with the user, and **built**: forks 4, 5 and 7. Go:
`internal/access` (`Grants.Authenticated`/`Anyone`, the old form read,
`Visibility`, `Actions`, `ActionPublish`; `ActionBake` removed),
`internal/modules/world` (`SetVisibility`, the route, `Meta.Visibility`,
`actions` in the list and the meta), `internal/modules/jobs` and
`internal/modules/artifacts` (`actions`). Client: the actions in the world
list, the artifact window, the job window and the upload's check; the
visibility in the world panel (`generator.load.visibility.*`), three
buttons for whoever has `world.share`, Public greyed out without
`world.publish`. Tests: `TestActionsFollowTheLevel`, `TestOldGrantsAreRead`,
`TestOnlyAnAdminMakesAWorldPublic`, `TestAPublicWorldIsReadableByEveryone`,
`TestTheIndexFollowsTheGrants`. Forks 3 and 6 are not built (see there).
