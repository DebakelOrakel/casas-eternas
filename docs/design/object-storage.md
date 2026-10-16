---
id: DES-0029
title.en: Object storage for the server's stores
title.de: Object Storage für die Speicher des Servers
summary.en: Decided in DEC-0038 (2026-10-16); the provider is still
  open. Give the artifact store and then the world store an S3 backend beside `dir`, through a small blob leaf package
  with a table of what the providers disagree about (Ceph RGW, as cloudscale
  runs it, and Amazon S3). Artifacts keyed by content (DES-0028) become
  write-once objects; the server checks the right and answers with a
  presigned URL, so the bytes do not pass through it.
summary.de: Entschieden in DEC-0038 (2026-10-16); der Anbieter ist
  noch offen. Der Artefaktspeicher und danach der Weltenspeicher bekommen neben `dir` ein S3-Backend, über ein kleines
  Blob-Leaf-Paket mit einer Tabelle dessen, worin sich die Anbieter
  unterscheiden (Ceph RGW, wie cloudscale es betreibt, und Amazon S3).
  Artefakte nach Inhalt (DES-0028) werden einmal geschriebene Objekte; der
  Server prüft das Recht und antwortet mit einer presigned URL, so dass die
  Bytes nicht durch ihn laufen.
area: platform
stage: building
createdAt: 2026-10-15
updatedAt: 2026-10-16
related: [DES-0028, DEC-0017, DES-0011]
---

Records a conversation (2026-10-15). Its forks are decided in
[decisions/object-storage.md](../decisions/object-storage.md) (DEC-0038,
2026-10-16); the provider is still open. It builds on
[rights-and-artifacts.md](./rights-and-artifacts.md) (DES-0028): artifacts
keyed by content only.

## Which stores

The configuration already has room for it: `Storage` is a tagged union with
`type: dir` and reserves a block for `s3` (internal/config/tree.go). Its
comment says, rightly, that S3 is not a mere backend swap: the artifact
store's mtime index and both stores' rename atomicity are filesystem
semantics.

| module (store) | holds | S3? |
|---|---|---|
| artifacts | levels and tiles: large, many, computable again | yes, the main gain |
| world | revision zips, grants.json, meta.json | yes, second (durability, backup) |
| client, docs | the static bundle and the static doc site | better served from a bucket behind a CDN at deploy time; the module stays for local runs |
| jobs | jobs.db (bbolt) | no: a database file needs a filesystem |
| auth | auth.db (bbolt) | no |
| relay | the JetStream store | no: JetStream needs a filesystem |

## Why artifacts first, and after DES-0028

Keyed by content, an artifact is written once and never changed. That is
what S3 does well: a PUT is atomic, so no rename is needed, and two writers
of the same key write the same bytes.

- **Presigned URLs.** The server checks the caller's right at resolve and
  answers `302` with a presigned URL: a link to one object, signed in
  advance with the server's key over the method, the object and an expiry
  (Signature V4). Client and worker load from the bucket (or a CDN) directly;
  the bytes do not pass through the server. The bucket stays private. The
  same works for upload: a worker gets a presigned PUT for exactly the key
  it computed. Limits: within its lifetime anyone holding the link can use
  it (keep it to minutes); a right withdrawn does not recall a link already
  given; the bucket needs CORS rules for the browser.
- **Scaling.** With idempotent writes the artifacts target could run with
  several replicas. Today the rule is one process per store directory.

## The blob leaf

A leaf package (no routes, no schema; any module may import it) that opens
a bucket and moves objects in and out: `Get`, `Put`, `Head`, `List(prefix)`,
`Delete`, presign for GET and PUT, and a conditional `Put` where the
provider has it. Each store keeps its layout private and talks to the leaf;
the `dir` backend gets the same interface, so a store has one code path.

**Its own bucket, made when missing.** At startup `Open` creates the
module's bucket if it is not there, with the settings that store needs
(versioning for worlds; CORS for presigned GETs). The identity may create
exactly that one bucket name and nothing else, may not delete a bucket,
and the worlds identity may not delete an object version (so a delete
leaves a recoverable marker). What the leaf does not do: write IAM users,
policies or keys. That is the operator's work (deploy/aws/storage.yaml for
AWS: one user per installation under the IAM path `/casas-eternas/`,
its rights split per bucket; a user per store once the targets run in
separate processes).

**The providers' differences as a table, not as two implementations.**
Every difference is one field of a capability row per provider; adding a
provider is adding a row and letting the compiler say what is missing. Two
rows to start:

| | ceph (cloudscale) | aws |
|---|---|---|
| endpoint | configured (`https://objects.lpg.cloudscale.ch`, `…rma…`) | derived from the region; configuring one is refused |
| addressing | path style (`<endpoint>/<bucket>`) | virtual host (`<bucket>.<endpoint>`) |
| wrong region | not applicable (one zonegroup; the region is the signing scope) | answers 301 with `x-amz-bucket-region`; the startup probe must say so |

To measure before a row is added, not to assume: request checksums (the
SDK sends `x-amz-checksum-crc32` on every PutObject since v1.36; recent Ceph
RGW accepts it, older versions refuse it), conditional writes
(`If-None-Match` / `If-Match`), CORS per bucket. A row that claims a
difference nobody measured is a comment nobody can check.

**Client library:** `aws-sdk-go-v2`, only `service/s3` (and
`feature/s3/manager` if multipart is needed). It is maintained and speaks
every S3-compatible provider (`BaseEndpoint`, `UsePathStyle`); presigning
is built in (`s3.NewPresignClient`). `minio-go` is ruled out: the MinIO
server was archived in 2026 and the client hangs on the same company.

**Opening.** `Open` reads the bucket, endpoint, region and flavour from the
module's configuration and the key pair from the environment or from
mounted files (never from the configuration file), and probes the bucket at
startup, so a wrong bucket fails at start, not at the first request.

## Uploads from workers

Two forms of a signed upload exist:

- **Presigned PUT**: a link for one object key, one method and a short
  expiry. The server can also sign headers into it (`Content-Type`,
  `Content-Length`, a checksum); an upload with other values is refused.
  One PUT carries up to 5 GB; above that a multipart upload, where each
  part is signed (`UploadPart` with its `partNumber`) and the server
  completes the upload. Our artifacts are far below the limit.
- **Presigned POST**: a signed policy, sent as a form. It allows room
  within limits: a key prefix instead of one key, a size range, a content
  type. Made for uploads from a browser (a form or `FormData`), e.g. a
  large world zip that goes to the bucket and not through the server.

**The tiles of L2 and L3 are many short tasks** (the coordinator hands
them out over NATS; docs/decisions/detail-ladder.md). Asking the server
for a link before every upload would add a round trip per tile. So:

- **The right to upload travels with the task, not per upload.** With
  artifacts keyed by content the keys are known before the task runs. The
  coordinator's task message carries one presigned PUT per key it will
  write, all with one standard expiry (e.g. 1 h). Signing is a local HMAC
  (no call to the provider), so a task of many tiles costs microseconds to
  sign.
- **Ask again only when needed — the error case must be covered.** A link
  carries its own expiry (`X-Amz-Date` + `X-Amz-Expires`). Before an
  upload the worker checks that a margin is left (e.g. 5 min); if not, or
  if the upload is refused all the same (clock skew, a slow upload), it
  asks the coordinator for a fresh link for that key and uploads again.
  Short tasks (L2, L3: minutes) use the links of their message and never
  ask; a long one (L1: about 1 h on a local Apple M4, about 7 h on a slow
  cloud CPU) finds its link expired at the end and asks once. So no
  expiry is estimated per level or per machine.
- **Why not simply a long link for L1:** a slow machine, a restarted job or
  a queue can outlast even a day; with temporary credentials (an AWS role)
  a link ends with them after a few hours anyway; and a link that is valid
  for a day is useful for a day to anyone who picks it up.
- **Expiry limits:** Signature V4 allows at most 7 days (to measure on
  Ceph RGW), and never more than the credential that signed it lasts.
  Servers need NTP: the provider checks against its own clock. Defaults to
  start with: downloads 5–15 min; task uploads 1 h; browser uploads (POST)
  15–30 min. They become configuration (new flags, proposed before they
  are written).
- **Why PUT per key, not one POST policy per task:** a PUT allows exactly
  the keys of the task and nothing else; a prefix policy would allow every
  key under it. The cost of more links is only bytes in the task message.
  POST stays for uploads from the browser.
- **Completion:** S3 does not tell the server that an upload finished. The
  worker reports the end of its task as today, with each object's size and
  checksum; the server checks with `HEAD` that the objects are there and
  match, then marks them present. (Event notifications from the provider
  would be the other way; whether cloudscale has them is to check. Not
  needed: the task reports its end anyway.)
- **Trust:** a worker holding a link can write wrong bytes under its keys,
  as a worker can today with its job token (limited to its world). The
  links narrow that to the task's own keys and its lifetime.

## Tests

- **Unit:** an `httptest` fake standing in for the provider, enough to
  test the wiring (keys, prefixes, errors, presign shape).
- **Wire:** the real provider, behind an environment variable naming an
  endpoint and a key pair; skipped when it is not set. Development runs
  against a real target rather than against a stand-in that agrees with
  neither (so no MinIO, Garage or SeaweedFS in the loop).

## What changes in the stores

- **Rename as atomic write** becomes one PUT.
- **The artifact store's mtime-validated index** is built from a listing
  (ETag, LastModified) at start, then kept in memory.
- **The LRU eviction** needs the last access; S3 has no atime. The server
  records it in its index, or a bucket lifecycle rule does the eviction.
- **`ReadDir`** becomes `ListObjectsV2` with paging.
- **world:** the in-process locks stay (one writer). With conditional
  writes, several replicas become possible later.

## Configuration

Agreed with the user on 2026-10-16, recorded in DEC-0038 (fork 2 to 4):

**Only the object stores keep a `storage` union.** `world.storage` and
`artifacts.storage` choose `dir` or `s3`. **`type` is required** as soon as
an `s3` block is there (`type: s3`); `type` is also a flag
(`--world.storage.type`, default `dir`); no backend is inferred from a block,
so a `dir.path` that comes only from its flag default can never be
mistaken for a choice, and a `dir` block beside `type: s3` is refused.

**The modules that need a filesystem get a plain directory, `state-dir`,**
not a `storage` union: their shape must not suggest that S3 is possible.

| section | today | becomes | why |
|---|---|---|---|
| world | `world.storage.dir.path` | `world.storage` (`dir` \| `s3`, `type` required) | files and objects |
| artifacts | `artifacts.storage.dir.path` | `artifacts.storage` (`dir` \| `s3`, `type` required) | files and objects |
| jobs | `jobs.storage.dir.path` | `jobs.state-dir` | jobs.db (bbolt): file locks, mmap |
| auth | `auth.storage.dir.path` | `auth.state-dir` | auth.db (bbolt) |
| relay | `relay.storage.dir.path` | `relay.state-dir` | the JetStream store |
| client | `client.storage.dir.path` | `client.content-dir` | static files (the bundle); with a CDN served outside the server anyway |
| docs | `docs.storage.dir.path` | `docs.content-dir` | static files (the doc site) |

The renames change the CLI, the CASAS_* variables and the manifests (a
public surface; agreed with the user, 2026-10-16). **A hard break:** the
old keys are refused at start with a message that names the new key; there
is no transition release in which both are read.

**The `s3` block** (approved names; file keys and CASAS_* variables, one
vocabulary): `flavour` (`ceph` | `aws`), `region`, `endpoint` (ceph only;
refused for aws), `bucket`, `prefix` (for a shared bucket), `access-key-file`,
`secret-key-file` (paths, never values in the file).

**The link lifetimes are module settings, not part of the `s3` block,**
because the `dir` backend signs its own links too (see "Without an
external S3"): `artifacts.read-link-ttl` (default 15m),
`artifacts.write-link-ttl` (default 1h), and `artifacts.link-key` (path to
a file with at least 32 random bytes; read only by `dir`; when missing, an
ephemeral key is made and the links die at restart). `world` may get the
same keys later.

## Without an external S3

S3 is not a requirement. An embedded S3 server in the binary was weighed
and refused: it would offer the S3 protocol to the outside — Signature V4
verification (canonical requests, presigned query parameters, streaming
chunk signatures), multipart, listing semantics, ETags, ranges, the XML
errors the SDKs expect, a key administration of its own — a second attack
surface of thousands of lines, for something the clients do not need.

What the clients and workers need is only links. So:

- **`dir` stays a full backend** behind the same blob interface as `s3`.
- **Presign for `dir` too:** the server signs its own links (e.g.
  `/v1/artifacts/blob/<key>?exp=…&sig=…`), an HMAC over the method, the key,
  the expiry (and for a PUT the length), and serves them itself. To a client
  or a worker it looks the same as S3: a short-lived link for a GET or a PUT;
  the rule for expired links holds unchanged.
- **The checks:** a signing key of its own (rotatable: two keys valid for a
  change-over), a constant-time compare, method and key bound into the
  signature, the expiry, keys checked against our key format (no `..`, no
  path traversal), a size limit on uploads; the right is checked when the
  link is issued, as with S3. Some 200–400 lines and their tests.
- **The operator chooses:** `dir` locally and for a small installation (one
  binary, no external service, one process per directory); `s3` for the
  public installation (the bytes pass by the server, several replicas
  become possible).

## The provider (open)

| | cloudscale (Ceph RGW) | Amazon S3 |
|---|---|---|
| data location | Switzerland (Lupfig, Rümlang) | region of choice, incl. Zurich (eu-central-2) |
| egress | to check: cost of download traffic | charged per GB out; less behind CloudFront |
| CDN | none of its own; an external CDN in front | CloudFront, signed URLs/cookies there too |
| credentials | static key pairs per user/bucket | IAM; on Kubernetes outside AWS still key pairs (IRSA needs EKS) |
| features | what the RGW version has (to measure: checksums, conditional writes, CORS) | the full API |
| same place as the cluster | if the cluster runs at cloudscale | if it runs on AWS |

The leaf supports both from the start, so the choice can come late and can
change.

## Order

1. Decide DES-0028 (artifacts by content).
2. The blob leaf with both rows, the `httptest` fake and the gated wire
   tests; `s3` for the artifact store with presigned GET.
3. Uploads from workers: one presigned PUT per key in the task message,
   a fresh link only after a refusal.
4. The world store.

## Status

2026-10-15: IDEA — recorded on the user's request; the provider is open.

2026-10-16: BUILDING — the forks are decided in
[decisions/object-storage.md](../decisions/object-storage.md) (DEC-0038);
step 1 there (the configuration) is built. The provider is still open.
