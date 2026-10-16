---
summary: What you are operating — one binary, targets, one configuration vocabulary, three auth modes.
date: 2026-08-13
updated: 2026-08-13
group: overview
order: 10
---

# Concepts

The server is **one binary**. It stores worlds, stores the artifacts baked
from them, serves the browser client and this documentation, runs bake
jobs, and handles login. Which of those a process actually does is chosen
at start:

```
casas-eternas start --target all                  everything, one process
casas-eternas start -t world -t artifacts         storage only
casas-eternas start -t auth                       login + user store only
```

A **target** is a deployment unit: every target can run alone, and a
multi-process deployment is the same binary started several times with
different `-t`. The targets are `client`, `world`, `artifacts`, `jobs`,
`docs`, `auth` — and `all` as the shorthand for every one.

## One configuration vocabulary

Every setting has exactly one name, and it is the dotted config key:

| where | shape | example |
|---|---|---|
| casas.yaml | nested keys | `global: { listen: ":8080" }` |
| flag | the key itself | `--global.listen :8080` |
| environment | `CASAS_` + key, dots/dashes → `_` | `CASAS_GLOBAL_LISTEN=:8080` |

Flags override the environment, which overrides the file. The full key
list with defaults and descriptions is on the [Configuration](configuration.md)
page — it is generated from the same source the `--help` texts come from,
so it cannot drift. Two deliberate strictnesses: an **unknown key in
casas.yaml refuses to start** (a typo must not become a silent default),
and **target selection is never a file key** — the same file serves every
process of a split deployment, so the role travels only in `-t` or
`CASAS_TARGET`.

## Auth modes

`global.auth.mode` decides where users live:

- **`none`** (the default) — the local, single-player mode: one synthetic
  identity owns everything, no login exists. Right for a machine you
  trust, wrong for anything reachable by others.
- **`password`** — this server holds the users, in its own store
  (`auth.state-dir`), administered over the admin socket with
  `casas-eternas auth user …` and `auth role …` (see the [CLI](cli.md)
  reference). Logging in exchanges name and password for a token; every
  other request carries the token.
- **`oidc`** — reserved: a foreign identity provider holds the users. Not
  implemented yet; the mode name parses and refuses to start.

## Where state lives

Each store module owns one directory or bucket — worlds
(`world.storage.dir.path`), artifacts (`artifacts.storage.dir.path`, or a
bucket, below), users (`auth.state-dir`), jobs (`jobs.state-dir`), the
relay's messages (`relay.state-dir`). Worlds and artifacts choose a
backend with `world.storage.type` and `artifacts.storage.type`: `dir`, or
`s3` for the artifacts (the world store refuses `s3` until it is built).
The others need a filesystem, so they take a plain directory.
**One process per store directory** is a hard rule; the user store
enforces it with a file lock, the others rely on you. Scaling means
splitting *targets* across processes, never pointing two processes at one
directory.

### Artifacts in S3

```yaml
artifacts:
  storage:
    type: s3              # required as soon as the s3 block is there
    s3:
      flavour: aws        # aws or ceph: the provider's row of the capability table
      region: eu-central-2
      bucket: casas-eternas-artifacts
      prefix: ""          # a key prefix, for a bucket shared with other data
      access-key-file: /run/secrets/aws-access-key
      secret-key-file: /run/secrets/aws-secret-key
  read-link-ttl: 15m      # how long a read link holds
```

For `ceph`, set `endpoint` (e.g. `https://objects.lpg.cloudscale.ch`) and
leave `region` empty or set the signing scope; `aws` refuses an endpoint.
The endpoint must be `https://`: over plain HTTP the S3 client cannot
upload a streamed body, so the server refuses to start with an `http://`
endpoint.
The key pair is two files, never values in the configuration file; for
local tests against the dev identity they are `dev/secrets/aws-access-key`
and `dev/secrets/aws-secret-key` (deploy/aws/storage.yaml makes the
identity). Each key is also a flag and a `CASAS_ARTIFACTS_STORAGE_S3_*`
variable. At start the server checks the bucket, makes it when it is
missing, and sets its CORS rule.

A read of an artifact answers `302` to a short-lived link: on `s3` a
presigned GET, so the bytes come from the bucket and not through the
server; on `dir` a link the server signs and serves itself under
`/v1/artifacts/blob/`, with the key in `artifacts.link-key` (a file with
at least 32 random bytes; without it the links stop working at restart).
The bucket's CORS rule allows every origin, for GET and HEAD, without
credentials: a link is the right to read one object for minutes, and
whoever holds it can use it outside a browser, so a narrower origin would
protect nothing. Uploads still go through the server.

