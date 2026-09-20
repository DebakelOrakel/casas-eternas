---
summary: How the server is configured, decided when the flag count started to hurt. One vocabulary — the dotted config key IS the flag name IS the CASAS_* variable, so nothing can drift between the three. A casas.yaml (Loki/Mimir-shaped) holds a `global:` section for the process and one section per target; storage is a tagged union (`storage.type` + one backend block) so a future S3 backend is a new block, not a renaming. Target selection is deliberately NOT a file key — the same file serves every process of a split deployment — and the loader refuses one loudly, as it refuses unknown keys. Every module receives the whole typed tree and reads only `global` plus its own section, a discipline enforced by review rather than the compiler.
date: 2026-08-12
updated: 2026-08-13
area: platform
stage: built
status: decided and BUILT 2026-08-12 — tree, loader, one-vocabulary flags, env replacer, strict unmarshal, smoke-tested end to end. The `services:` map exists but is not yet validated against /v1/capabilities; that lands with the bake decoupling.
---

# Server configuration

## The problem

The flag list grew one deployment concern at a time — storage paths, TLS,
auth, revision retention, the artifact cap, bake concurrency — until `start
--help` was the only place the full surface could be seen, and every flag had
invented its own name (`--dir-worlds`, `--auth-mode`, `--artifacts-cap`) with
no structure relating them. Three naming systems were about to exist: flags,
environment variables, and whatever a config file would call things.

## The decision: one vocabulary

Every setting has exactly ONE name: its dotted key in the configuration tree.

```
world.storage.dir.path
  = casas.yaml:   world: { storage: { dir: { path: ... } } }
  = flag:         --world.storage.dir.path
  = environment:  CASAS_WORLD_STORAGE_DIR_PATH   (dots and dashes → underscores)
```

The flag names ARE the viper keys, so the binding cannot drift; the env side
is one `SetEnvKeyReplacer`. Renaming a setting is one constant in
`cmd/root.go` and a breaking change everywhere at once — which is what a
rename should be, not a partial one.

Precedence is viper's: flags beat environment beats file beats defaults.
Verified by test (`cmd/configload_test.go`).

## The file: casas.yaml, Loki/Mimir-shaped

```yaml
global:            # the PROCESS: socket, TLS, auth, peer services
  listen: ":8080"
  auth:
    mode: password
    session-key: /etc/casas-eternas/auth/session.key
  services:        # peer addresses for split deployments; empty = co-resident
    worlds: ""
world:
  keep-revisions: 3
  storage:
    type: dir
    dir:
      path: /data/worlds
artifacts:
  cap: 50GB
  storage:
    dir: { path: /data/artifacts }
client:
  storage:
    dir: { path: /app/dist }
bake:
  max-concurrent: 1
```

`--config` names the file; without it, `./casas.yaml` is read if present and
silently skipped if not. The tree lives in `internal/config/tree.go` as plain
data with mapstructure tags — that package still imports neither cobra nor
viper; folding file, env and flags into the tree happens exactly once, in
`cmd/configload.go`.

## Storage is a tagged union

Kubernetes-volume-source style: `type` names the one backend block that must
be present. `type` may be omitted when exactly one block says it all; a
foreign block beside the named type refuses to start, because `type: dir`
next to a configured s3 block is almost always a copy-paste accident. `dir`
is the only implemented backend; S3 was the reason for the shape (and will
not be a mere backend swap — the artifact store's mtime index and both
stores' rename atomicity are filesystem semantics). A `memory` backend was
considered and banned.

There is deliberately NO inheritance from a `global.storage`: three stores
that happen to share a path prefix are still three settings, and an inherited
default that silently pointed the world store at the artifact disk is the
kind of surprise this file exists to prevent.

## Target selection is not configuration

`-t/--target` (or CASAS_TARGET) selects which modules this PROCESS runs. It
is deliberately absent from the tree: the same casas.yaml is mounted into
every process of a split deployment, and a role in a shared file would give
every process the same role. The loader refuses `target:`/`targets:` in the
file with a message saying exactly this.

## Strictness

Viper's own Unmarshal silently ignores unknown keys, which turns every typo
in casas.yaml into a default nobody chose. The loader decodes with
mapstructure's `ErrorUnused`, so an unknown key is a start error naming the
key — the same loudness as an unknown target or a typoed auth mode.
Validation that does not depend on the target selection (listen, TLS pairs,
auth mode, cap syntax) runs at load; per-target storage is validated only for
SELECTED targets, so a world-only deployment does not have to configure
artifact storage it will never touch.

## Modules receive the whole tree

Every module's `Config` carries the complete `config.Config` (Loki-style)
plus its non-config wiring (the identity resolver, the login path). The
boundary is a READ discipline: a module reads `Global` and its OWN section,
nothing else — enforced by review, not the compiler. The one temporary
exception is bake, which still needs the world and artifacts paths; those
reads sit at the composition root in `cmd/start.go` with a comment, so the
coupling stays visible until the bake decoupling removes it.

## What was rejected

- **Keeping ad-hoc flag names beside file keys** — three vocabularies, drift
  guaranteed; the migration cost of renaming every flag was paid once,
  breaking (Dockerfile CMD, manifests env names, Makefile updated in the same
  change).
- **A per-module config slice** (each module defining its own struct and cmd/
  cutting it out) — more type safety, but every cross-cutting addition
  (tracing, limits) would touch every module's struct; the Loki shape was
  chosen with the read discipline instead.
- **`global.storage` inheritance** — see above.
- **Registry/discovery for `services:`** — addresses are configuration (or
  the platform's DNS); capabilities are self-description via
  /v1/capabilities. Static map, validated by whoever needs a peer, at
  startup. Validation lands with the bake decoupling.
