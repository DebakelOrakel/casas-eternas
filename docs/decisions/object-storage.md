---
id: DEC-0038
title.en: Object storage for the server's stores
title.de: Object Storage für die Speicher des Servers
summary.en: The world store and the artifact store get an object-storage
  union (`dir` | `s3`) with a required `type`; the modules that need a
  filesystem (jobs, auth, relay) get a plain `state-dir`, the static ones
  (client, docs) a `content-dir` — a hard break, old keys are refused. The
  link lifetimes are module settings and hold for both backends: `dir`
  signs its own links, no S3 server is embedded. One blob leaf with a
  capability table per provider (aws, ceph) on aws-sdk-go-v2; workers
  upload with one presigned PUT per key; one bucket per store, one IAM
  user per installation.
summary.de: Der Weltenspeicher und der Artefaktspeicher bekommen eine
  Object-Storage-Union (`dir` | `s3`) mit Pflichtfeld `type`; die Module,
  die ein Dateisystem brauchen (jobs, auth, relay), bekommen ein schlichtes
  `state-dir`, die statischen (client, docs) ein `content-dir` — ein harter
  Bruch, alte Schlüssel werden abgelehnt. Die Lebensdauer der Links ist
  eine Moduleinstellung und gilt für beide Backends: `dir` signiert seine
  eigenen Links, kein S3-Server wird eingebettet. Ein Blob-Leaf mit einer
  Fähigkeitstabelle je Anbieter (aws, ceph) auf aws-sdk-go-v2; Worker laden
  mit einem presigned PUT je Schlüssel hoch; ein Bucket je Speicher, ein
  IAM-Benutzer je Installation.
area: platform
stage: building
createdAt: 2026-10-16
related: [DES-0029, DES-0028, DEC-0017, DEC-0021]
---

## Where this starts

[design/object-storage.md](../design/object-storage.md) (DES-0029) records
the conversation of 2026-10-15 and the configuration agreed with the user
on 2026-10-16. This document records the forks it decides. The design doc
keeps the reasoning in detail (the provider table, the upload flow, the
store changes); this document gives the options, the answer and why.

Not decided here: the forks of
[design/rights-and-artifacts.md](../design/rights-and-artifacts.md)
(DES-0028, artifacts keyed by content only). They stay open. The `s3`
backend works with today's artifact key, which includes the world's uid
(DEC-0017, addendum of 2026-08-11); when DES-0028 is decided, the key
changes in the store, not in the backend.

## Fork 1 — Which stores get object storage

- **A. Every store behind one union.** Every section keeps `storage` with
  `dir` and `s3`.
- **B. Only the stores that hold objects.** (chosen)

**Answer: B.** `world` (revision zips, grants.json, meta.json) and
`artifacts` (levels and tiles) get an object-storage union, `dir` | `s3`.
`jobs` (jobs.db, bbolt), `auth` (auth.db, bbolt) and `relay` (the JetStream
store) need a filesystem: file locks, mmap and a directory of segment
files. `client` and `docs` serve static files; with a CDN, a bucket serves
them at deploy time outside the server, and the module stays for local
runs.

**Why:** a union on a section that can never take `s3` promises something
false. The shape of a key must say what the module can do.

## Fork 2 — The shape of the configuration

- **A. Keep `storage.dir.path` everywhere** and refuse `s3` where it does
  not apply.
- **B. Infer the backend from the block** that is present (the rule of
  DEC-0021 until now: `type` may be omitted when one block says it all).
- **C. `type` as a CLI flag**, inferred when absent.
- **D. A required `type` on the object stores; plain directories on the
  others.** (chosen, user-approved 2026-10-16)

**Answer: D.**

- Only `world.storage` and `artifacts.storage` keep a `storage` union.
- **`type` is required as soon as an `s3` block is present.** No backend is
  inferred from a block. `world.storage.type` and `artifacts.storage.type`
  are real flags (`--world.storage.type`, `CASAS_WORLD_STORAGE_TYPE`; user
  decision 2026-10-16) with the default `dir`. So an `s3` block without
  `type: s3` meets `type: dir` and is refused as a foreign block, with a
  message that says to set `type: s3`.
- A `dir` block beside `type: s3` is refused. The flag default of
  `dir.path` does not count as a block: only a path that is set (file,
  variable or flag) is one. So a default can never be mistaken for a
  choice.
- `jobs`, `auth`, `relay` get `jobs.state-dir`, `auth.state-dir`,
  `relay.state-dir`. `client` and `docs` get `client.content-dir`,
  `docs.content-dir`.
- **A hard break.** The old keys (`jobs.storage.dir.path`,
  `auth.storage.dir.path`, `relay.storage.dir.path`,
  `client.storage.dir.path`, `docs.storage.dir.path`, and each
  `*.storage.type` of these five) are refused at start, in the file and as
  CASAS_* variables, with a message that names the new key. An old flag
  is an unknown flag; its error names the new flag. There is no transition
  release in which both are read.

**Why:** inference made a default (`dir.path` has a flag default) look like
a choice, and a backend chosen by the presence of a block is a backend
nobody chose. A transition release would keep two names for one setting,
against the one vocabulary of DEC-0021; the installations are few and the
message says what to rename.

## Fork 3 — The `s3` block

The names, approved 2026-10-16 (one vocabulary: each is a file key and a
CASAS_* variable):

| key | meaning |
|---|---|
| `flavour` | `ceph` \| `aws`: the row of the capability table |
| `region` | the signing scope; for aws also where the bucket is |
| `endpoint` | the provider's URL; ceph only, refused for aws (derived from the region) |
| `bucket` | the store's bucket |
| `prefix` | a key prefix, for a shared bucket |
| `access-key-file` | path to the file with the access key id |
| `secret-key-file` | path to the file with the secret key |

**Why:** the key pair is a path, never a value in the file, so the
configuration file can be read without the secret. The proposed
`presign-read` and `presign-write` in the block are dropped: see fork 4.

## Fork 4 — Link lifetimes at module level

- **A. In the `s3` block** (`presign-read`, `presign-write`).
- **B. In the module section, for both backends.** (chosen)

**Answer: B.** `artifacts.read-link-ttl` (default 15m),
`artifacts.write-link-ttl` (default 1h), `artifacts.link-key` (path to a
file with at least 32 random bytes; read only by the `dir` backend; when
missing, an ephemeral key is made and the links die at restart). `world`
may get the same keys later.

**Why:** the `dir` backend signs its own links (fork 5), so a link lifetime
is a property of the module's API, not of the provider. In the `s3` block
it would leave `dir` without one.

## Fork 5 — Without an external S3

- **A. Embed an S3 server in the binary.**
- **B. `dir` stays a full backend and signs its own links.** (chosen)

**Answer: B.** An embedded S3 server would offer the whole protocol to the
outside (Signature V4 verification, multipart, listing, ETags, ranges, the
XML errors, a key administration): a second attack surface for something
the clients do not need. They need links. The `dir` backend serves
`/v1/artifacts/blob/<key>?exp=…&sig=…` itself, with these checks: a
signing key of its own (rotatable, two keys valid for a change-over), a
constant-time compare, the method and the key in the signature, the
expiry, the key checked against our key format (no `..`, no path
traversal), a size limit on uploads; the right is checked when the link
is issued, as with S3.

## Fork 6 — The blob leaf and its library

- **A. One implementation per provider.**
- **B. One implementation with a capability table.** (chosen)
- Library: **aws-sdk-go-v2** (`service/s3` only; `feature/s3/manager`
  only if multipart becomes necessary). **minio-go is ruled out**: the
  MinIO server was archived in 2026 and the client depends on the same
  company.

**Answer:** a leaf package (no routes, no schema) with `Get`, `Put`,
`Head`, `List(prefix)`, `Delete`, presign for GET and PUT, and a
conditional `Put` where the provider has it. Each provider difference is
one field of a row: `aws` and `ceph` to start; a row claims only what was
measured. `Open` probes the module's own bucket at startup and creates it
when it is missing, with the settings the store needs (versioning for
worlds, CORS for presigned GETs). Tests: an `httptest` fake for the
wiring, and wire tests against the real provider, gated by an environment
variable and skipped without it (no MinIO, Garage or SeaweedFS in the
loop).

**Why:** a table makes a new provider a new row that the compiler checks;
two implementations drift.

## Fork 7 — Uploads from workers

**Answer:** the coordinator's task message carries one presigned PUT per
key the task writes, all with `write-link-ttl`. Before an upload the worker
checks that a margin is left; when not, or when the upload is refused all
the same, it asks for a fresh link for that key and uploads again. **The
error case is mandatory**, not an optimisation: a long task (L1) finds its
links expired. The worker reports the end of its task with each object's
size and checksum; the server checks with `HEAD`.

**Why:** a PUT per key allows exactly the task's keys; a POST policy on a
prefix would allow every key under it. Signing is a local HMAC, so many
links cost only bytes in the message. A long-lived link was refused: a
queue or a restart outlasts any lifetime, and a long link is useful to
anyone who picks it up.

## Fork 8 — Buckets and identities

**Answer:** one bucket per store (worlds, artifacts); one IAM user per
installation, its rights split per bucket (deploy/aws/storage.yaml). A
user per store when the targets run in separate processes. The leaf may
create its own bucket and nothing else; it never writes users, policies
or keys, and may not delete a bucket or (on the worlds bucket) an object
version.

## Order

1. The configuration change (fork 2; this document's first step).
2. The blob leaf with both rows, the fake and the gated wire tests; `s3`
   for the artifact store with presigned GET.
3. The link keys of fork 4 read; the `dir` backend's own links; uploads
   from workers (fork 7).
4. The world store.

## Status

2026-10-16: BUILDING — step 1 is built: the unions on `world` and
`artifacts` with a required `type` (flags `--world.storage.type`,
`--artifacts.storage.type`, default `dir`), `state-dir` and `content-dir`
on the others, the old keys refused, and the link keys of fork 4 read into
the configuration (nothing uses them yet). The `s3` block is declared and
checked; `type: s3` refuses to start as not implemented yet. Steps 2–4
are open.

2026-10-16: step 2, the blob leaf, is built (`internal/blob`), tested and
not used yet: no store opens a bucket, and `type: s3` still refuses to
start. The artifact store's `s3` backend with presigned GET moves to step
3. The leaf has `Get`, `Put` (atomic, exact length), `Head`, `List`
(paged, as an iterator), `Delete`, `PresignGet`, `PresignPut` and a
conditional `Put` (`IfAbsent`: a hard link on `dir`, `If-None-Match: *` on
a flavour that claims it). One key rule for both backends, checked before
anything is signed or sent. The `dir` links are an HMAC-SHA256 over the
method, the key, the expiry and (PUT) the length, checked against a list
of keys. Measured against AWS (eu-central-2, the dev identity of
deploy/aws/storage.yaml): the SDK's default checksums (CRC32) are
accepted; `If-None-Match: *` answers 412; a request signed for another
region answers 400 (not the documented 301, probably because eu-central-2
is an opt-in region), and `x-amz-bucket-region` names the region in both
cases; presigned PUT links carry no checksum, sign `Content-Length` and
refuse another length (403); an expired link answers 403; the CORS rule
and versioning are set as asked; new buckets block public access. The
`ceph` row claims nothing yet: no cloudscale bucket exists, its wire test
is skipped.
