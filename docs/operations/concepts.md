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
  (`auth.storage`), administered over the admin socket with
  `casas-eternas auth user …` and `auth role …` (see the [CLI](cli.md)
  reference). Logging in exchanges name and password for a token; every
  other request carries the token.
- **`oidc`** — reserved: a foreign identity provider holds the users. Not
  implemented yet; the mode name parses and refuses to start.

## Where state lives

Each store module owns one directory — worlds (`world.storage.dir.path`),
artifacts (`artifacts.storage.dir.path`), users (`auth.storage.dir.path`).
**One process per store directory** is a hard rule; the user store
enforces it with a file lock, the others rely on you. Scaling means
splitting *targets* across processes, never pointing two processes at one
directory.

