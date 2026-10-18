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
  upload with one presigned PUT per file, asked for when the file is
  written, with its length, and commit; one bucket per store, one IAM
  user per installation.
summary.de: Der Weltenspeicher und der Artefaktspeicher bekommen eine
  Object-Storage-Union (`dir` | `s3`) mit Pflichtfeld `type`; die Module,
  die ein Dateisystem brauchen (jobs, auth, relay), bekommen ein schlichtes
  `state-dir`, die statischen (client, docs) ein `content-dir` — ein harter
  Bruch, alte Schlüssel werden abgelehnt. Die Lebensdauer der Links ist
  eine Moduleinstellung und gilt für beide Backends: `dir` signiert seine
  eigenen Links, kein S3-Server wird eingebettet. Ein Blob-Leaf mit einer
  Fähigkeitstabelle je Anbieter (aws, ceph) auf aws-sdk-go-v2; Worker laden
  mit einem presigned PUT je Datei hoch, beim Schreiben mit der Länge
  angefragt, und bestätigen danach; ein Bucket je Speicher, ein
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
may get the same keys later. It did on 2026-10-16: `world.read-link-ttl`
(default 15m) and `world.link-key`, with the same meaning, for the reads
of zips and previews (see the status).

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

**Revised at step 4 (2026-10-16):** the links are not in the task message,
because neither the key nor the length is known when the task is handed
out. The worker asks for one link per file when it writes the file, with
the length; the rule for expired links and the check with `HEAD` are as
above. See the status.

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

2026-10-16: the artifact store runs on the blob leaf (`dir` and `s3`, one
code path), with reads by link; `type: s3` starts for `artifacts`, the
world store still refuses it. What changed:

- **Store.** Every read and write goes through `blob.Bucket`; the layout
  (`{artifactUid}/meta.json` and the files) is DEC-0017's, so an existing
  `./data/artifacts` opens as it is. The index is built at start from one
  `List` and a read of each meta.json (16 in parallel), then kept in
  memory: this process is the one writer. Measured on a clone of a real
  store (11 363 artifacts, 68 184 files, 14.6 GB, dir): 2.5 s at start.
  Writes are the leaf's atomic `Put` with the request's length (a chunked
  upload is spooled to a temporary file first); the 512 MiB limit stays.
- **LRU.** The last access is recorded in the index (resolve, a link given,
  a write), in memory only, as before: S3 has no atime, and a write per
  read is not worth a cache's recency. After a restart the meta's
  `createdAt`, then the newest write, orders the sweep. Eviction and
  removal drop entries from the index under the lock and delete the
  objects after it, 16 at a time.
- **Reads by link.** `GET /v1/artifacts/{uid}/{name}` checks the right as
  before and answers `302` (`Cache-Control: no-store`) to a link with
  `artifacts.read-link-ttl`: a presigned GET on `s3`, the module's own
  signed link on `dir` (`GET /v1/artifacts/blob/<key>?exp&sig`, key from
  `artifacts.link-key`). The gate lets a request through without
  credentials when its link is one we signed, also an expired one, so that
  the route answers 410 and the gate no 401; anything else on that path
  meets the gate as usual. The route answers 403 for a link that does not
  verify, 410 for an expired one, 404 for a signed key whose object went.
- **CORS origin: `*`, no new key.** A presigned GET is a capability URL:
  the right was checked when it was issued, and a holder can use it
  outside a browser, so a narrower origin protects nothing. `*` also
  covers the `Origin: null` a browser sends after a redirect from a third
  origin. Methods GET and HEAD, every request header allowed, `ETag` and
  `Content-Length` exposed. The headers, because a browser drops the
  session's `Authorization` on the redirect to the bucket but still asks
  for it in the preflight (measured in Safari 26.6).
- **Workers.** A job worker beside the artifact store writes over this
  server's API now (`http://127.0.0.1:<port>/v1`, from `global.listen`),
  as a cluster worker always did: the in-memory index sees only what
  passes through the server, and on `s3` there is no directory.
  With `global.tls.cert` the worker does not use the public listener: the
  certificate names the public host and cannot be verified for
  `localhost`, and a private authority's certificate is not trusted by
  Node at all (both measured 2026-10-16: `ERR_TLS_CERT_ALTNAME_INVALID`,
  `DEPTH_ZERO_SELF_SIGNED_CERT`). The server opens an INTERNAL LISTENER
  for its local workers instead: `127.0.0.1`, a free port, plain HTTP, the
  same handler and gate (the job token is still required), no flag. Only
  the local workers get its address; it closes with the server. Mutual TLS
  (`global.tls.ca`) was removed the same day.
- **Measured against AWS** (eu-central-2, `casas-eternas-dev-artifacts`,
  TestAWSWireArtifacts): an upload through the server with a body that
  cannot seek (about 1 MiB, the SDK's trailing checksum over HTTPS) is
  stored; a restart indexes it from the listing; Go's client follows the
  302 to the bucket and drops the caller's `Authorization` on the way; the
  bucket answers `Access-Control-Allow-Origin: *`; a presigned GET that
  still carries an `Authorization` header answers 400 (two kinds of
  authorization), so a client must drop the header on a cross-origin
  redirect, as the Fetch standard, Go and Node do. Over plain HTTP the SDK
  needs a seekable body to hash, so an `http://` endpoint refuses uploads;
  every real provider is HTTPS.

2026-10-16: fixes after the review of step 3.

- **A worker's read error is not "absent".** The client's HTTP artifact
  store returns null only for a 404 (resolve without create for an unknown
  key, a file the artifact does not hold, a link whose object has gone).
  No answer (network, TLS), a 5xx or an answer it cannot read throws
  `ArtifactStoreUnavailableError`; a write the server refuses (4xx) is
  still false. Before, every failure read as a miss: a worker whose server
  was away computed a stored level again, or failed a tile late with "not
  in the artifact store". The job worker gives such a task back to the
  relay (`nak`, 15 s), as for a worker that crashed, and reports the
  failure on the task's last delivery (5), so that a store that stays away
  fails the job. The coordinator does not change. The browser's tiered
  store catches the error and goes on as on a miss (local, then compute),
  as before, with one console warning per kind of call. Test:
  `npm run test:http-store` (404 / 500 / a failed TLS handshake / a
  refused connection, and the tiered store over each).
- **Junk with invalid names.** An entry whose top-level name breaks the
  key rule (copied in by hand: a space, a non-ASCII letter) was indexed as
  junk but could not be deleted through the leaf, so each start found it
  again. `blob.Dir.RemoveJunk` removes such a name, with what it holds,
  through the `os.Root` (one segment, never a valid key, never a temp
  file); the store's sweep and removals use it. S3 has no such path: only
  this server writes into its bucket, and every key it writes is valid. A
  file with a bad name under a valid uid still stays (logged).
- **Empty directories.** `Dir.Delete` removes the directories it makes
  empty, up to (not including) the root. A concurrent `Put` into the same
  directory does not fail: `Put` makes the directory again when it goes
  between `MkdirAll` and the temp file (ENOENT, on macOS also EINVAL), and
  once the temp file is in it, the directory is not empty. A failed `Put`
  leaves no empty directory either.
- **`http://` endpoints are refused.** `s3.endpoint` must be an `https://`
  URL with a host; the server refuses to start otherwise, because over
  plain HTTP the S3 client cannot upload a streamed body (see above).
- **Dead configuration.** `jobs.Config.ArtifactsDir` and the spec's
  `artifactsDir` are gone from the Go side: cmd/ gives every worker the
  artifacts URL, so every task carries a job token where tokens are
  checked. The worker keeps its filesystem store for a manual run without
  a server (jobWorker.ts, `pool`).
- **The relay warns.** At start, when `relay.listen` is not a loopback
  address, the relay logs once that its traffic is not encrypted and that
  it is for a trusted network only (e.g. a cluster network). Nothing else
  changes.

2026-10-16: step 4, uploads from workers (fork 7), is built. A job
worker's bytes go straight to the bucket; the browser still uploads
through the server. What changed against the answer of fork 7, and why:

- **No links in the task message.** The DES assumed that the keys are
  known before the task runs. They are not: an object key is
  `{artifactUid}/{file}`, and the uid comes from `resolve`, which needs the
  logical key — the worker computes the world id and the pipeline version
  from the save and its own code; the coordinator knows neither for level
  1. And the length of each file follows from the result (the node count),
  so it is known only after the computation. A link without a signed
  length was refused: a presigned PUT has no size limit (only a POST
  policy has one), so it would let its holder write up to 5 GB, and a
  link for another length would no longer be refused.
- **So the worker asks per file, at write time, with the length:**
  `POST /v1/artifacts/{uid}/write-link` `{name, size}` answers `{method,
  url, header, expires}` with `artifacts.write-link-ttl` to live: a
  presigned PUT on `s3`, the module's own signed link on `dir`
  (`PUT /v1/artifacts/blob/<key>?exp&len&sig`, beside the GET route of
  step 3). The right is the right to write the artifact, as for the PUT
  through the server: a job token whose world is the artifact's world, an
  editor of that world, or the operator. The server does not know a
  task's keys, so a link is scoped to the uid (and so to the world) and
  to the one file and length. One request more per file than before;
  against a tile's seconds, nothing.
- **The rule for expired links** is kept as decided: before the upload
  the worker checks that 5 minutes are left of the link; if not, or if
  the upload is refused (403, 410), it asks once for a fresh link and
  uploads again. With links asked for at write time the margin check
  rarely triggers (a write-link-ttl under 5 minutes, clock skew); the
  refusal path is the one that matters. A second refusal is a failed
  write; a 5xx or no answer is the store being unavailable (the task is
  given back).
- **Completion: a commit, not the task report.** The worker uploads its
  files, meta.json last, and with meta.json it sends
  `POST /v1/artifacts/{uid}/commit` `{files: [{name, size}]}`. The server
  checks that each file was signed for this artifact, `HEAD`s each object
  (there, and of that size), reads meta.json back, and only then enters
  the files into its index; all or none. 409 when a file is not in the
  bucket as said or was never signed. Not in the coordinator's report
  (`jobs.done`), because the index belongs to the artifacts module and the
  coordinator may run in another process: the worker already talks to
  the artifacts API, so no new edge between the modules is needed. The
  commit comes before `jobs.done`, so a task that waits on this one finds
  the artifact whole. No checksum: a presigned PUT carries none (step 2),
  so the server could only compare the worker's word with the worker's
  word; the length is signed and checked twice.
- **Pending uploads.** A file a link was given for and that no commit
  confirmed is kept in memory with the link's expiry: removing the
  artifact deletes its object too, and the cap's sweep spares the
  artifact while a link is valid. A worker that dies after the upload
  leaves objects that the index does not list until the next start (then
  as an entry with or without meta, as any other).
- **The server's PUT route stays**, for the browser's tiered store: it
  uploads in the background, and the bucket's CORS rule allows no PUT.
- **Measured against AWS** (eu-central-2, `casas-eternas-dev-artifacts`,
  TestAWSWireArtifacts, a prefix of its own, deleted after): a worker
  upload by presigned PUT, then the commit, then a read by 302 gives the
  bytes; key A's link used for key B answers 403 and writes nothing; a
  body of another length answers 403; an expired link answers 403. The
  client's store in Node (`uploads: 'links'`) against a server on `s3`:
  1 MiB and a meta, uploaded straight to the bucket, resolvable whole
  after the commit only, read back equal.
- **No real job ran end to end:** the only world (`b39d5739`) does not
  replay with today's code. The path is covered at the store and route
  level (Go, `npm run test:http-store`).
- **Also fixed:** the worker's read of its world returned "absent" for any
  failure, so a world server that was away failed the task. Now only a
  404 is absent; other failures give the task back, as for the artifact
  store.

2026-10-16: fixes after the review of step 4.

- **Help texts.** `artifacts.read-link-ttl` and `artifacts.link-key` said
  "Not used yet"; both are used since step 3. The texts say what they do
  now (cli-reference.json regenerated).
- **The sweep does not take an entry that is still being written.** The
  grace covered only meta-less entries this process had never touched, so
  a reservation that `resolve` with create had just minted, or an entry
  between two writes, was the sweep's first victim, and the writer's next
  PUT answered 404. THE RULE: the sweep never takes an entry with a write
  in flight in this process — a server PUT or a commit between its check
  and its record (a counter on the entry), or a write link that is still
  valid — whole or not. A meta-less entry is spared also while less than
  the grace (1 h) has passed since something last touched it: a resolve, a
  write link, a write, a commit, or, after a restart, the newest object's
  LastModified. It becomes junk only when no write is in flight AND the
  grace has passed. The grace is not shorter because a write in progress
  needs no grace (the counter and the links cover it); it covers the gaps
  between the requests of one writer, and junk loses nothing by waiting.
  Junk first, then LRU, as before. Tests (`-race`): a reservation with no
  file; a server PUT held in the bucket's Put while the clock passes the
  grace; a commit held in its Head after its link expired.
- **A reservation lost at a restart gives the task back.** The server
  holds a reservation in memory only; after a restart the write-link, the
  upload or the commit for its uid answers 404 (the uid is unknown, or
  known only as a meta-less entry with no key, which ranks nobody; the
  operator and the local mode write on into that entry, which works), and
  the worker failed the task. THE RULE (client, `uploads: 'links'`): on a 404
  for an artifact it is writing, the store resolves the key with create
  once more, which mints a fresh uid, and uploads the artifact again from
  its first file, then the file in hand; later calls for the old uid go to
  the new one. A second 404 under the fresh uid throws
  `ArtifactStoreUnavailableError`, and the worker gives the task back. For
  that, the store keeps the bytes of the files it uploaded until the commit
  — references to the caller's buffers, no copies — and lets them go at the
  commit, a refusal or a throw. A read's 404 stays "absent". The server
  does not change: the files under the old uid are indexed at the start as
  a meta-less entry with no key, spared for the grace from their newest
  write, then junk that the sweep takes first. A file that a link written
  before the restart puts into the bucket after it is not in the index
  until the next start (as before, step 4). Tests: Go (the 404s after a
  restart, the old files spared and then taken), `npm run test:http-store`
  (a fake server that forgets its reservations before a write link, an
  upload or the commit, and twice).

2026-10-16: step 5, the world store on the blob leaf, is built; `type:
s3` starts for `world` too, and the "not implemented" refusal is gone.
What changed:

- **Store.** Every read and write goes through `blob.Bucket`, one code
  path for `dir` and `s3`. The layout is DEC-0017's, so an existing
  `./data/worlds` opens as it is (checked on an APFS clone of the dev
  store: the world `b39d5739`, 2 revisions, 68 MB, listed, read back
  byte-equal, copied, updated; and on a fixture in the old layout with a
  `.DS_Store` and a temp file in it). The index (each world's meta.json
  and grants.json) is built at start from one `List` and a read of each
  (16 at a time), then kept in memory; Get, the list and the ranking read
  no object. Writes are the leaf's atomic `Put`; on `dir` with an fsync
  of the file and the directory, as the store had before
  (`blob.PutOptions.Sync`). A world's delete deletes every key under
  `{uid}/`; a key the leaf refuses (a `.DS_Store`) is logged and left.
- **Create-only writes.** A revision's `world.zip` and a new world's
  `meta.json` are conditional (`IfAbsent`): a hard link on `dir`,
  `If-None-Match: *` on aws. So a second writer against the same bucket,
  outside the model, gets 412 instead of overwriting a revision. The next
  revision is one above the current one AND above every revision with
  objects in the bucket (from the start's `List`, and from this process's
  own claims), so a revision that an interrupted upload left is stepped
  over instead of blocking the world; revision numbers can have gaps, and
  a create answers 201 also when its first revision is not 1. On ceph the
  row claims no conditional write: the store falls back to plain writes,
  logs it once, and relies on the per-world lock (one writer).
- **Overwritten documents** (meta.json after its creation, grants.json):
  plain writes under the per-world lock. Several replicas would need
  `If-Match` on the ETag that was read; not built (the leaf has none).
- **Versioning.** `world.BucketOptions` asks for versioning; no CORS rule,
  because zips and previews are served through the server. No read links
  for zips in this step: the route answers the bytes as before.
- **Local job workers.** On `dir` a worker reads the save's file, as
  before (`blob.Dir.LocalPath`); on `s3` it reads the world over the
  server's API (the internal listener under TLS), as a cluster worker does.
- **Measured against AWS** (eu-central-2, `casas-eternas-dev-worlds`,
  TestAWSWireWorlds and a local server on `type: s3`): versioning is
  enabled; a stale second writer's revision answers 412 and stores
  nothing; a restart indexes the world from the listing; `If-None-Match:
  *` SUCCEEDS over a delete marker, so a world deleted and uploaded again
  under its uid starts at revision 1 again. What stays: the wire test
  leaves 14 versions (3 694 bytes) and 13 delete markers under its
  `test/<random>/`, the local run 16 versions (4 383 bytes) and 13
  markers; the identity cannot remove them (no `s3:DeleteObjectVersion`,
  as decided), an administrator or the lifecycle rule for `test/` does
  (deploy/aws/README.md).

2026-10-16: cleanups after step 5. On `dir`, a world's delete also removes
what its keys leave under `{uid}/` (`.DS_Store`, temp files, other invalid
names) with `blob.Dir.RemoveTree`, as the store before the leaf did; a
failed start closes the internal listener and the modules it made; the
tests share one fake S3 (`internal/blob/blobtest`, test-only).

2026-10-16: world zips and previews are read by link, with the keys of
fork 4 for `world` (approved the same day: `world.read-link-ttl`, default
15m, and `world.link-key`, dir only). What changed:

- **Routes.** `GET /v1/worlds/{uid}` and `GET /v1/worlds/{uid}/preview.png`
  check the right as before (private → 404, a template readable without an
  account, DEC-0037) and answer `302` (`Cache-Control: no-store`) to a link
  with `world.read-link-ttl`: a presigned GET on `s3`, the module's own
  signed link on `dir`. The meta and the list stay direct answers (some
  hundred bytes). The `dir` link is the object's key under the module's
  namespace, `GET /v1/worlds/{uid}/rev/{n}/world.zip?exp&sig` (and
  `preview.png`): `/v1/worlds/blob/{key...}`, as for artifacts, cannot be
  registered beside `/v1/worlds/{uid}/meta` (Go's mux finds both matching
  `/v1/worlds/blob/meta`, neither more specific, and refuses). 403 for a
  link that does not verify, 410 for an expired one of ours, 404 for an
  object that went (a pruned revision).
- **The 304 comes first.** A reader that sends `If-None-Match` with the
  current revision gets `304` from the server, with no link. Otherwise
  the `302` carries the revision as its `ETag`: the link's answer is the
  bucket's, whose ETag is its own (an MD5 on S3, measured), so a reader
  that keeps the revision must take it from the `302` or from the meta.
  The job worker (client/scripts/readWorld.ts) asks with `redirect:
  'manual'`, takes the ETag of the `302` and reads the link itself with no
  header of the task (no job token, no `If-None-Match`); a link that fails
  gives the task back. The browser's fetch cannot see the `302`, so
  `fetchWorld` asks the meta first: a cached copy of that revision is used
  without the zip, and a fetched zip is filed under that revision. The zip
  read after the meta is of that revision or a newer one, so the revision
  filed is never newer than the bytes (at worst a 409/412 on the next save,
  never an overwrite).
- **One implementation of the gate's predicate.** `blob.LinkSigner.Signed`
  (from artifacts' SignedRequest) checks a request against the signer's
  base; both modules use it, and cmd/ joins the two modules' predicates
  for the gate. The CORS rule of the read links is `blob.ReadLinkCORS`,
  used by both buckets. The link routes stay in each module (a few lines
  each): their answers name the module's objects.
- **The worlds bucket gets the CORS rule** (`world.BucketOptions`), the
  same as the artifacts bucket. A local worker on `dir` still reads the
  file (`blob.Dir.LocalPath`).
- **COEP and the previews.** The page is cross-origin isolated
  (`require-corp`). The previews are fetched (worldClient.ts,
  fetchWorldPreview) and shown by a `blob:` URL, and a fetch in CORS mode
  is not limited by COEP, so nothing changes there. Measured in Safari
  (WebDriver, a probe page served by the client module, crossOriginIsolated
  true): against the dev bucket the preview fetch follows the `302` to the
  bucket and the image decodes; the zip arrives byte-equal (SHA-256), and
  its ETag is the bucket's; an `<img src>` straight at the route fails
  (no CORP on the bucket's answer), which the app does not do. On `dir`
  both are same-origin and work.
- **Measured against AWS** (eu-central-2, `casas-eternas-dev-worlds`,
  TestAWSWireWorldLinks, one upload, and a local server on `type: s3`,
  one upload): the `302` goes to a presigned GET with `X-Amz-Expires=900`;
  Go's client follows it from a real server and drops the caller's
  `Authorization`; with an `Origin` the bucket answers
  `Access-Control-Allow-Origin: *`, and the preflight for `authorization`
  is allowed; `If-None-Match` of the revision answers `304` from the
  server. The worker's read (readWorld.ts, Node) of the local server:
  302, the bucket, the bytes equal, then `unchanged` with the ETag. The
  same on `dir` with a clone of the dev store (the world `b39d5739`, 36
  MB, SHA-256 equal, the preview equal, 304). What stays: 5 versions
  (1 127 bytes) and 5 delete markers under the wire test's `test/<random>/`,
  5 versions (3 374 bytes) and 5 markers under `test/ziplinks-8f1823b8/`;
  the lifecycle rule for `test/` removes them. The CORS rule on the dev
  worlds bucket stays set (the server sets it at each start).

2026-10-16: fixes after the review of `5be7f6e^..55583ed` (all approved
the same day). Each has a test that failed before the fix (`-race`).

- **A write the bucket stored but answered with an error.** A lost answer,
  a cut request or the SDK's retry that meets its own `If-None-Match`
  (`412`) can store an object and still fail the Put. The world store now
  takes the revision number of a save whose claim failed in any way, so
  the next update steps over it (before: every update chose it again and
  answered `412` until a restart). A meta.json Put that failed is read
  back: are the bytes ours, the write is done; at a creation with another
  meta.json there, the index enters the stored world and the answer is
  `409` — Get, a retry and an update then agree (before: Get `404`, retry
  `409`, update `412`).
- **A write is not cut half-way by its request.** The world store's write
  sequences (a revision: save, preview, two metas; a delete; grants; the
  template mark) run under the request's values without its cancel, with
  a timeout of 10 minutes, so a closed browser tab does not leave a world
  without its meta.
- **The lock of a deleted world.** The per-world locks are counted: an
  entry stays while a writer holds it or waits on it. Before, Delete
  dropped it while a writer waited, and the next writer got a fresh mutex:
  two writers of one world ran at once (on ceph, without the conditional
  write, nothing else kept them apart).
- **Retention counts whole revisions.** `world.keep-revisions` keeps the
  newest revisions that have a revision meta.json; an orphan (a save whose
  upload ended before its meta) takes no slot and is pruned. The current
  revision is never pruned. Before, orphans took slots, and the last good
  revision before the current one could go.
- **A job token writes no world** (DEC-0037, Status): create, copy, delete
  and the template mark answer `403` to it.
- **Uncommitted uploads count against the cap.** THE RULE: the signed
  length of every write link counts against `artifacts.cap` from the link
  on, also after the link expires, until the artifact is committed or
  goes; a write link is refused (`507`, the worker gives its task back)
  when the uncommitted uploads of the whole store would pass the cap with
  it. The sweep counts them as well, and an artifact whose links expired
  uncommitted no longer is spared: it is junk after the grace, and the
  sweep deletes the objects the links may have put there. An artifact
  holds at most 64 uncommitted files (6 to 12 today); a fresh link for the
  same file takes no second place (`409` above it). Why "also after the
  link expires" rather than dropping an expired entry: the object may be
  in the bucket, and an entry that forgot it would let a writer fill the
  bucket one link lifetime at a time.
- **A meta.json names its own artifact's key.** A meta whose key is not
  the reservation's (or the landed meta's) is refused with `409`, at the
  server's PUT before anything is written and at a commit, where nothing
  is entered and the uploaded meta.json is deleted (a whole artifact whose
  meta was replaced so goes as a whole: it is recomputable). Before, a
  writer with the right to world A could file bytes under world B's key.
  After the commit of its meta.json an artifact is whole and takes no more
  uploads by link: the write-link route answers `409`, and the `dir` link
  route refuses (`403`) a link given before the commit, a link whose file
  is not pending (one given before a restart), and a meta.json with
  another key (`409`). On `s3` the provider takes an upload by a valid
  link without asking: until `artifacts.write-link-ttl` has passed, a
  holder can still write into a committed artifact's objects. THE LOAD
  RULE: the start has only the bucket, so it believes what it finds — a
  meta.json written so is indexed at the next start as it stands. The
  window is the link's lifetime; closing it would need a record of the
  committed key outside the holder's reach. Not built.
- **A clear lists first.** Clear lists the bucket, then resets the index,
  then deletes what it listed. Before, it reset first, and an artifact
  written between the reset and the List was in the index with its
  objects deleted.
- **A meta.json that cannot be read is not "no meta".** At a commit a
  failed read (a `503`) fails the commit (`500`, the worker gives its task
  back); before, the commit answered success for an artifact that stayed
  meta-less. At start, THE CHOICE: a meta.json is read up to 4 times
  (0.25 s, 0.5 s, 0.75 s apart), then the start fails with the object's
  key. Not "skip it without marking it junk": an entry with no meta is
  junk to the sweep by definition, so a skipped entry needs a third state
  that every rule must know; and an artifact store that evicts on a flaky
  start, or starts with entries it cannot rank, is worse than one that
  does not start and says why.
- **World and artifact storage are never shared.** When one process runs
  both targets, the start refuses `world.storage` and `artifacts.storage`
  that are one directory or nested (after `filepath.Abs` and the symbolic
  links of the part that exists), or one bucket of one provider (flavour,
  endpoint, bucket) with equal or nested prefixes, `""` holding every
  other; the message names both keys. Reproduced before on `dir`: the
  artifact sweep deleted the worlds as junk. DEFENCE IN DEPTH for two
  processes: the artifact store does not index an entry shaped like a
  world (`grants.json`, `rev/…`, a meta.json with `uid` and `revision`
  and no `key`), logs it at start, and a clear leaves it; an artifact file
  may not be named `grants.json` or under `rev/`.
- **Links.** The gate's predicate refuses a request whose path has
  escapes (`RawPath`): the router matches the escaped path, where
  `blob%2F<uid>` or `<uid>%2Frev%2F1%2Fworld.zip` is one segment of
  another route. The MAC text holds the signer's base path (format
  `casas-blob-link-v2`), so a link opens only the module that signed it,
  also with one key file for both; links live minutes, so v1 links stop
  at the update. Key change-over with the new keys `world.link-key-previous`
  and `artifacts.link-key-previous` (approved 2026-10-16): a path to the
  previous key file, accepted to verify, never used to sign; a path that
  is set but cannot be read, or a key under 32 bytes, refuses the start
  (cli-reference.json regenerated).
- **Shutdown.** The public and the internal listener shut down at the
  same time, each with the whole grace. Before, the internal one waited
  for the public one: it took new requests meanwhile, and a local
  worker's uploads had only what was left of the grace.

2026-10-16: the client and worker side of the same review (approved the
same day). Each has a test that failed before the fix.

- **Another writer committed first.** Two workers can write the same
  artifact under one uid; after the first commit, write-link answers `409`
  and the second worker failed its task ("could not write the artifact")
  although the artifact was there. The `409` of write-link has two causes,
  told apart by a code in the body: `{"error": …, "code": "committed"}`
  for a whole artifact (`artifacts.WriteLinkCommitted`,
  `httpjson.ClientErrorCode`), no code for too many uncommitted files. THE
  RULE (client, `uploads: 'links'`): "committed" is "already written" — the
  write is true, the artifact's other files are skipped up to its
  meta.json, no commit. On `dir` the link route refuses the upload first
  (`403`); the fresh link then answers the `409`. Other answers stay: a
  write-link `409` without the code and a commit `409` (another key) are a
  refusal (false), `507` and a commit's `5xx` give the task back. Tests:
  Go (`TestWriteLinkConflictsCarryACode`), `npm run test:http-store`.
- **A refusal is final.** A resolve or a read that the API answers with a
  4xx other than 404 (`400`, `401`, `403`) throws `ArtifactStoreRefusedError`,
  and the worker's read of its world `WorldRefusedError`: the task fails at
  once (`ok: false`). Before, both threw "unavailable" and the task was
  given back 4 times, 15 s apart, for the same answer. Still unavailable:
  no answer, a 5xx, a `410` (a read link that expired on the way), a `403`
  from the link a read was sent to (not from the API).
- **A creation that was stored.** A create can store a world and still
  fail (a lost answer, a `500` for a meta it could not confirm); the next
  save, again a create, got `409` and said "conflict" for the user's own
  world. THE RULE (`worldClient.ts`, `uploadWorldTo`): a `409` to a create
  reads the world's meta; when its `contentHash` is the SHA-256 of this
  archive and the caller is an editor or above, the save is stored and its
  revision remembered. Else the conflict, as before. Checked against a
  throwaway server on `dir`: a create sent raw (answer ignored), then the
  client's save of the same archive → stored with revision 1; of another
  archive → conflict.
- **The copy's rewrite of world.yaml.** An annotation key with a `.`
  (`example.com/x`) ended the annotations block, and the lines after it
  were copied out of it (invalid YAML). Now every line under
  `  annotations:` that is indented deeper belongs to it and is kept as it
  is; the new copied-from entry takes the indent of the block's first
  entry; CRLF stays CRLF. Go (`save.go`) and the browser (`worldCopy.ts`)
  pass one table of cases (`internal/modules/world/testdata/
  copy-identity.json`), read by `go test` and `npm run harness:roundtrip`.
- **Annotation values keep their meaning.** The browser wrote annotation
  values as they were, so `a: b` made world.yaml invalid. They are
  double-quoted when YAML needs it (`recipeYaml.ts`, `yamlScalar`: empty,
  `: `, `#`, a space at either end, a leading indicator, a control
  character, a value YAML reads as another type), and read back with their
  escapes. The server writes only the copied-from value, a uid, and keeps
  the other lines as they are.
- **The template mark.** A failed mark or unmark said "The server list
  cannot be reached"; it says `generator.load.template.failed` now.

Open: **the relay is plain NATS over TCP**, not encrypted. The plan for
external workers, and later the browser: NATS's WebSocket listener behind
the Ingress/Route, with TLS from the router (or, standalone, the WebSocket
listener's own TLS with `global.tls.cert`/`global.tls.key`); TCP only
inside the cluster. A known limit of the same kind: the artifacts URL in a
task message is the server's internal one (`127.0.0.1` for a local
worker, the pod IP in a cluster), so a worker on another host would get an
address it cannot reach. Both belong to "a worker outside the cluster"
([detail-ladder.md](detail-ladder.md), the open part on workers outside
the cluster). Built 2026-10-18 behind the Ingress at `/relay`, TLS from
the router (detail-ladder.md, "A worker outside the cluster").
