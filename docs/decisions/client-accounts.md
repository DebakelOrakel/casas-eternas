---
id: DEC-0034
title.en: Accounts in the client: profile, administration, invite codes
title.de: Konten im Client: Profil, Verwaltung, Einladungscodes
summary.en: The account panels of the design move into the client. A profile where a
  user sets a display name, an avatar and their own password; an admin panel
  over the network for users, invite codes and compute nodes, gated by the
  token's adm claim, with the admin socket kept for bootstrap and
  emergencies; no e-mail anywhere — a new account comes only from an invite
  code an admin creates for a set number of registrations, and there is no
  self-signup. Avatars live with the identity, in the auth module's storage.
summary.de: Die Konto-Panels aus dem Design kommen in den Client. Ein Profil, in dem
  ein Nutzer Anzeigename, Avatar und eigenes Passwort setzt; ein Admin-Panel
  übers Netz für Nutzer, Einladungscodes und Rechenknoten, freigegeben über
  den Claim adm im Token, der Admin-Socket bleibt für Erststart und Notfall;
  nirgends E-Mail — ein neues Konto entsteht nur aus einem Einladungscode,
  den ein Admin für eine feste Zahl von Registrierungen erzeugt, ohne
  Selbstregistrierung. Avatare liegen bei der Identität, im Speicher des
  Auth-Moduls.
area: platform
stage: building
createdAt: 2026-10-04
updatedAt: 2026-10-04
related: [DEC-0023, DEC-0022, DEC-0019, DES-0011, DES-0012, DES-0013]
---

## Where this starts

The design canvas has two new panels: **My profile** (avatar, display name,
password, sign out) and **Admin settings** (a user table, figures, a side
navigation). The server cannot serve either today. Users are administered
only over the admin socket (DEC-0023), a user's name is their login name,
nobody can change their own password, and nothing knows when someone last
signed in.

The design is the direction, not the specification. Where it differs from
the model — global roles admin/editor/viewer, e-mail addresses, invitations
by mail, quotas and an audit log — the model stands, and the panels follow
it. This document records the forks that make the panels possible.

## Fork 1 — Administration over the network

**Options.** (a) Keep the admin socket the only door; the client shows no
admin panel. (b) Serve the auth module's admin endpoints on the network as
well, for a session whose token carries the `adm` claim.

**Answer: (b).** The same endpoints, mounted twice: on the socket as today,
and under `/v1/auth/admin/…` behind the adm claim. The socket stays the way
in for the first user and for a locked-out deployment — the bootstrap and
the emergency of DEC-0023 do not change.

**Why.** DES-0012 already placed administration in client panels, not in a
second frontend. The claim is verified in every process with the shared key
(DEC-0022), so no module calls another to ask who is an admin.

## Fork 2 — Roles

**Answer: global roles stay `user` and `admin`.** Rights on a world stay
grants on that world (owner, editor, viewer — DES-0011). The admin table
shows "administrator: yes/no" and how many worlds a user owns; who may edit
which world is shown where a world is shared, not here.

## Fork 3 — No e-mail

**Answer: the server stores no address and sends no mail.** Everything the
design does by mail is a code or a link an admin copies and hands over by
whatever channel they like:

- a new account: an invite code (fork 4);
- a forgotten password: the admin creates a one-time reset code for that
  user; it sets a new password once and expires after 24 h.

**Why.** Mail is infrastructure (a relay, deliverability, an address per
user to keep current) for a deployment of a few people who know each other.
If it is ever wanted, it is a delivery channel added on top of codes, not a
different model.

## Fork 4 — Invite codes, no self-signup

**Answer.** An account is created only with an invite code. An admin asks
for one and says for how many registrations it is good (3, 5, any number)
and how long it is valid (default 14 days). The code is shown once. Anyone
with the code may register, until its uses are spent or it expires; there
is no registration without a code.

- **The code** is 16 characters of Crockford base32 in four groups
  (`K7QF-2M9X-HW4T-8RNB`), about 80 bits: typed by hand if need be, guessed
  never. The server keeps its SHA-256, not the code — like the service
  accounts' secrets, a high-entropy value needs no slow hash.
- **A record per code** in auth.db: id, hash, uses allowed, uses left,
  expiry, who created it and when. The admin panel lists them with uses
  left and revokes one. No label: the few codes open at a time are told
  apart by when and by whom they were made, and the user record keeps the
  code's id; an optional label is a flag added later, never a name taken
  away.
- **Registering** is a public route, `POST /v1/auth/redeem` with code,
  login name and password, exempt from the gate like the login (built as
  `redeem`, not `register`: the same route spends a reset code). It checks
  the code, creates the user through the same `Create` the CLI uses (same
  name rules), counts the use, and answers like a login — the new user is
  signed in. The user record keeps the id of the code it came from, so the
  admin sees who joined with which code.
- **Abuse.** A wrong code answers the same way as an expired or spent one;
  failed attempts are rate-limited per client address. A code makes plain
  users only; an admin is made in the user table afterwards.
- **Only in mode `password`.** Mode `none` has no users, so no codes.

## Fork 5 — The profile

**Answer.** Three things a user changes about themselves, each its own
route under `/v1/auth/me`:

- **Display name**: a new field on the user. The login name does not change
  and stays the key a password is looked up under; the display name is what
  every panel shows. Empty means the login name.
- **Password**: the user's own change, with the current password. The admin
  socket's `auth user passwd` stays for an admin.
- **Avatar**: fork 6.

The login records **when** a user last signed in, for the admin table.

## Fork 6 — Avatars live with the identity

**Options.** (a) In the auth module's storage, one file per user. (b) In
auth.db as a value. (c) In the artifact store. (d) In the browser only.
(e) An external service such as Gravatar.

**Answer: (a)** — `avatars/<user id>` under `auth.storage`, PNG or JPEG
with its media type in the user record,
owned by the one process that owns that directory (the auth target when
targets are split, DES-0013).

- The client crops and scales to 256 × 256 in the browser and uploads a
  JPEG. The server takes at most 200 kB, square, 64 to 1024 pixels a side,
  and checks the type, the size and the image's dimensions only, so it
  needs no image library.
- `PUT` and `DELETE /v1/auth/me/avatar` for one's own;
  `GET /v1/auth/users/{id}/avatar` for any signed-in user, with an ETag.
  No image: the panels draw the initials, as the design does.

**Why not the others.** (b) would grow the small database that holds the
credentials, for no gain over files. (c) is content-addressed derived world
data, filed by world — an avatar is neither. (d) shows the picture to its
owner alone; the admin table and every shared view need others' pictures.
(e) needs an address (fork 3) and tells a third party who uses the server.

## Fork 7 — Blocking waits for revocation

**Answer.** "Block account" is not built until revocation is (DEC-0019:
short-lived tokens with refresh, revoked by a per-user stamp). A flag that
stops the next login but leaves a 720-hour token working would block
nothing for a month. Until then an admin deletes a user, or resets the
password.

## Fork 8 — The admin panel, first version

**Answer.** Three sections, the others of the design left out rather than
shown empty:

- **Users** — display name, login name, administrator yes/no, last sign-in,
  worlds owned; make or unmake an admin, reset code, delete.
- **Invite codes** — create (uses, validity), list with uses left, revoke.
- **Compute nodes** — the service accounts (create, rotate, delete) and the
  workers connected to the relay now.

Quotas and an audit log wait until there is something to put in them.

## Build order

1. The model: display name, last sign-in, the code records and the user's
   code id in auth.db; the routes of forks 4 and 5.
2. The profile panel and registration with a code in the sign-in panel.
3. Avatars.
4. The admin routes on the network and the admin panel's three sections.

The CLI gains the codes over the socket. Proposed, to be agreed before it
is written: `casas-eternas auth code add --uses N --valid DURATION`,
`auth code list`, `auth code revoke <id>`, and `auth user
reset <name>` for a reset code. Every new catalog key of the panels is
proposed before it is added.

## Status

2026-10-04, after a review: the network admin gate checks the stored role
as well as the token's adm claim, so a demoted admin is out at once; the
redeem limiter reads X-Forwarded-For only behind a private-network router,
and counts a refused name too, since it is checked after the code. A
person's password has at least 10 characters, upper- and lower-case
letters among them. Setting a password ends the user's other sessions
within an access token's life (DEC-0019 step 8, built the same day);
blocking (fork 7) is now unblocked, not built.

2026-10-04, later: the administration BUILT (forks 1, 3, 4 and 8) — the
admin API on the network under /v1/auth/admin behind the adm claim, with no
self-demotion or self-deletion there (internal/modules/auth/adminnet.go);
invite and reset codes in auth.db and the public /v1/auth/redeem, rate-
limited (codes.go); the admin window with users, invite codes and service
accounts (ui/adminPanel), and redeeming in the sign-in window. Open: the
workers connected to the relay in the compute nodes section, blocking (fork
7), and the CLI for codes.

decided 2026-10-04 in conversation. The profile BUILT the same day (forks 5
and 6): display name, last sign-in, the own password and the avatar, as
routes under /v1/auth/me (internal/modules/auth/profile.go) and as the
profile window on every screen (ui/profilePanel); the title bar shows the
display name and the picture. The CLI names in the build order are
proposals, not decided.
