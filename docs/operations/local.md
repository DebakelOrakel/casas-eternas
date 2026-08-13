---
summary: Running the server on your own machine — the zero-config local mode, the on-disk defaults, and how to try password mode locally.
date: 2026-08-13
group: installation
order: 20
---

# Local

## The short version

From a checkout:

```
make run
```

builds the baker bundle, the client and the docs site, then starts
everything on `:8080`. From a bare binary, the equivalent is:

```
casas-eternas start --target all \
  --client.storage.dir.path client/dist \
  --docs.storage.dir.path client/docs-dist
```

Leaving the two static paths empty is also fine — the server then serves
only the API plus `/config.json`, which is exactly what a dev run beside
`npm run dev` wants.

## Defaults are cwd-relative

With nothing configured, state lands beside where you started the
process: `./worlds`, `./artifacts`, `./auth`. A `casas.yaml` in the same
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

## Verifying

`curl -s localhost:8080/config.json` shows what a client will be told
(including the auth mode); `curl -s localhost:8080/v1/capabilities` lists
the modules this process runs.
