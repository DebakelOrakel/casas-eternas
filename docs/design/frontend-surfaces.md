---
id: DES-0012
title.en: Frontend surfaces
title.de: Frontend-Flächen
summary.en: A map of every user-facing surface the project will grow — game client,
  public docs, notes, admin, login, settings — and the vocabulary that sorts
  them. The frontend equivalent of a server TARGET is a STATIC BUNDLE (a
  directory anyone can serve, talking to the API via /config.json), so
  "independently operable" is automatic and never the question; the real
  decisions are "own bundle or not" and "same origin or not", because the
  session (localStorage) is shared per origin. Settings decompose by OWNER
  (device / account / deployment / world), not by where a UI might live.
  Direction notes, nothing built.
summary.de: Eine Karte aller Oberflächen für Nutzer, die das Projekt bekommen wird —
  Spiel-Client, öffentliche Doku, Notizen, Admin, Login, Einstellungen — und
  das Vokabular, das sie ordnet. Das Gegenstück zu einem Server-TARGET ist
  im Frontend ein STATISCHES BUNDLE; die eigentlichen Entscheide sind
  „eigenes Bundle oder nicht“ und „gleiche Origin oder nicht“, weil die
  Session pro Origin geteilt wird. Einstellungen zerfallen nach BESITZER
  (Gerät / Konto / Deployment / Welt). Richtungsnotizen, nichts gebaut.
area: platform
stage: decided
createdAt: 2026-08-12
updatedAt: 2026-10-04
related: [DES-0013]
---

Captures a design discussion (2026-08-12) that started as "what visible
frontends will exist besides the client?" and resolved into a small
vocabulary, the same move that sorted the Go server: name the unit, and the
questions answer themselves.

## The vocabulary

**The frontend equivalent of a server target is a static bundle**: a built
directory that anyone can serve — the `client` module, nginx, a static host
— and that talks to the API through `/config.json`. The game client already
has exactly this shape.

Two consequences carry the whole map:

- **"Independently operable?" is never the question.** A static bundle is
  standalone by construction. The real decision is *own bundle or not* —
  i.e. does this surface build, version and deploy separately?
- **The origin is the session boundary.** `localStorage` is shared per
  origin, not per path: every surface on the server's origin shares the
  login for free; a surface on another origin would need its own. Anything
  that needs the session should therefore live on the same origin; anything
  public is free to live anywhere.

Serving a second bundle from the binary is a second `client`-shaped module
(serve a directory, nothing else) — cheap, and it keeps a self-hosted
deployment's surfaces in version lockstep with the server.

## The surfaces

**Game client** — exists; the reference shape. Sign-in, panels, and the
`adm` claim are already available in it.

**Public docs** — its own bundle, and (corrected 2026-08-12) its content
already largely EXISTS: the repo's `docs/` is public in principle (game
design material lives outside the repository — the game never states its
ideas outright). A doc site would therefore render
decisions/design/changelog/vision — the front matter is data, overviews
are generated — plus the *planned* player-facing manual
(`docs/handbook/`, see decisions/documentation-architecture.md, whose
"defer the public website" call still stands). Public means no gate
concern — static serving is already outside the `/v1` guard. Served
either by a `docs` module/target (version lockstep for self-hosting) or
any static host; links from the client are plain links, trivial.

**Notes (player's editable notes)** — the UI belongs in the client. The
OPEN FORK is where the data lives: in the save (notes travel with the
world), an own server store (per player per world, survives sharing), or
local-only. That fork touches the save format, the params hash and the
knowledge question, so it deliberately WAITS for the game-side write-up
(possession / trade / knowledge).

**Admin** — NOT its own interface to start. Split on trigger, not by
default: today's admin surface (clear the store, see and transfer foreign
worlds, watch bake jobs) overlaps almost entirely with existing panels, and
the `adm` claim is already in the client's token — the client only gates
affordances; the server enforces regardless. Admin affordances become
claim-gated panels in the client; an own bundle happens IF the surface
grows its own concerns (user management, a deployment view) — and is cheap
then, because bundles are just directories. Note: the biggest admin topic,
creating users, exists server-side since 2026-08-13 — the auth module's
admin handlers, today served only on the unix admin socket
(docs/decisions/server-user-admin.md). An admin panel would put the same
handlers on the network listener behind the `adm` claim; they gain a gate,
they do not move. Decided so on 2026-10-04 in
[client-accounts.md](../decisions/client-accounts.md) (DEC-0034), with a
profile panel beside it; built the same day (internal/modules/auth/adminnet.go).

**Login** — server-side, YES: that is the planned auth target
(docs/design/access-control.md). Frontend-side, NO standalone login page: a
separate login frontend pays only for SSO across origins, which the
same-origin rule avoids; the docs need no login; and OIDC brings the
provider's own login page — we only redirect. A login bundle would be a
deployable containing one form.

**Settings** — decompose by OWNER, not by UI location:

| owner | examples | home |
|---|---|---|
| device | language, rendering, camera | client-local (localStorage) — already separable, never server data |
| account | password, display name | the auth target's future surface |
| deployment | listen, storage, caps | casas.yaml — operator territory, deliberately NO ui |
| world | generator sliders, grants | the save / grants.json — already placed |

**Named but deferred** — the changelog found its page 2026-08-13: the DOCS
SITE (built — `npm run build:docs`, served by the `docs` module under
/docs/) carries it per area. The in-client viewer that was kept beside it was
removed 2026-09-20, unused since; its parser moved to `scripts/`. Still deferred:
an operations/status view (running
bakes, storage fill; today half of StoragePanel, really admin material),
and the GAME SCREEN itself: under the one-running-world-per-server model it leans toward
being its own per-instance surface rather than another client screen — but
that, too, waits for the game-side write-up.

## Status

2026-10-04: the admin and profile panels are decided in DEC-0034 and built.

direction agreed in discussion 2026-08-12 — nothing here is built or
scheduled; the notes fork and the game screen deliberately wait for the
game-side write-up
