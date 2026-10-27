---
summary: Running the server on your own machine — the zero-config local mode, the on-disk defaults, and how to try password mode locally.
date: 2026-08-13
updated: 2026-10-16
group: installation
order: 20
---

# Local

## The short version

From a checkout:

```
make run
```

builds the job worker bundle, the client and the docs site, then starts
everything on `:8080`. From a bare binary, the equivalent is:

```
casas-eternas start --target all \
  --client.content-dir client/dist \
  --docs.content-dir client/docs-dist
```

Leaving the two static paths empty is also fine — the server then serves
only the API plus `/config.json`, which is exactly what a dev run beside
`npm run dev` wants.

## Defaults are cwd-relative

With nothing configured, state lands beside where you started the
process, under `./data/`: `./data/worlds`, `./data/artifacts`, `./data/auth`,
`./data/relay` (the repository ignores `data/`). The relay — the message
bus the jobs and their workers talk over — listens on `127.0.0.1:4222`;
it stays on this machine because workers have no credentials yet. A `casas.yaml` in the same
directory is picked up automatically; `--config` points anywhere else.

## The local mode is `none`

No login exists, one synthetic identity owns every world — the deliberate
single-player shape. There is nothing to set up and nothing to bootstrap.
The only reason to leave it locally is to *test* multiplayer behaviour.

## Trying password mode locally

```
casas-eternas start -t all \
  --global.auth.mode password \
  --global.admin.socket ./admin.sock
```

The credential store starts empty and the log says so; create the first
user over the socket, from the same directory:

```
casas-eternas auth user add ada          # prompts for the password, twice
casas-eternas auth role bind ada admin   # optional: the global admin role
```

Whoever can reach the socket file is admin — that is the whole access
model, which is why it is a unix socket and not a port. Without
`global.auth.session-key` (a file with ≥32 random bytes) the server
generates an ephemeral signing key and warns: sessions then end at every
restart. Fine for an experiment, wrong for anything persistent.

## HTTPS without a proxy

A machine with no proxy in front serves HTTPS itself: `global.tls.cert`
and `global.tls.key` (both, or neither) name the certificate and its key.
Clients are not asked for a certificate — tokens authenticate them, as in
every mode. (The key `global.tls.ca`, mutual TLS, was removed on
2026-10-16 and refuses to start.)

With jobs and artifacts in this one process, the local job workers do not
use that listener: the certificate names the public host, and a worker on
the same machine would have to verify it for `localhost`. So the server
opens an **internal listener** for them: `127.0.0.1` only, a free port
chosen at each start, plain HTTP. It serves the same API with the same
gate — a worker sends its job token there, a request without a token is
refused. The log line `internal listener for the local job workers`
shows its address. Nothing configures it, and nothing outside the machine
can reach it; other users on the same machine can, which is why the gate
stays. Without TLS there is no internal listener; the workers use
`global.listen`.

## Verifying

`curl -s localhost:8080/config.json` shows what a client will be told
(including the auth mode); `curl -s localhost:8080/v1/capabilities` lists
the modules this process runs and the build answering.

`casas-eternas version` answers the same about the binary in front of you,
plus the one thing worth checking after a deploy: the **pipeline version**
of the bake bundle it would run. Artifacts are addressed by that version,
so a bundle built from a different commit than the client bakes perfectly
good bytes under a key no client ever looks for — the bake succeeds and the
map never changes. If the line reads `unknown`, this process has no bundle
(normal for a `world` or `auth` target) or `jobs.worker` points somewhere
empty. The **incubator** line is the same check for the incubator's histories
(H1): the version of `incubator.mjs` beside the bundle, which their jobs
run and their artifacts are keyed by; `none` where no such module is
shipped.
