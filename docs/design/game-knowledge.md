---
summary: Idea sketch for the game's data that players can query — truth stays on the server, each player has a log of observations, an embedded SQL database per player gives the query language, and isolation is physical, not a filter. Nothing decided.
date: 2026-10-02
area: mechanics
stage: idea
status: IDEA ONLY — not decided, not built, needs more thought. Recorded from a discussion on 2026-10-02; every section below is a direction, not a plan. The open questions at the end are real
---

# Game knowledge and player queries

Records a discussion (2026-10-02). It started with metrics for the later
game (trade, dynasties) and Prometheus, and moved to a different question:
what a player can know, and how a player asks for it.

The mechanics themselves (what can be observed, how, at what cost) are game
design and stay outside the repository. This note holds only the technical
shape that such mechanics would need.

## Why not Prometheus

Prometheus measures wall-clock time on a server and only appends. A game
has game time: it pauses, it runs at a variable speed, and loading an older
save moves time back and starts a second branch of history. That is
simulation data, not operational data.

Prometheus stays a possible tool for **operations** (the job server's task
durations, worker load), through a `/metrics` endpoint. That use is separate
and is not part of this note.

## Direction

### 1. Truth is an event log in game time

The simulation writes events with a game tick. The log is part of the save
and is the authority. A load cuts the log at the tick of the load, so a
branch does not mix with the history it left. Same inputs, same events — the
determinism rule of the generator (core/detMath.ts) applies here too.

No player ever queries the truth.

### 2. Each player has a log of observations

A player knows only what the player observed or was told. An observation is
made only where the player has a "sensor" in the world (for example a
branch office or an agent — the list is game design). One record per
observation, roughly:

| Field | Meaning |
|---|---|
| `observed_tick` | when it was so |
| `learned_tick` | when the news arrived |
| `place`, `source` | where, and through what (own office, rumour, ally …) |
| `metric`, `value` | what, and how much |
| `reliability` | how far to trust it |

Consequences, if this direction holds:

- A time series starts and stops with the player's presence. No presence,
  no data.
- News can travel: `learned_tick` later than `observed_tick`.
- Sources can differ in accuracy.
- Sharing is an act in the game: observations are COPIED into the other
  player's log, with a new source and a new `learned_tick`. No player ever
  reads another player's store.
- Data volume follows observations, not ticks: an office that reports
  monthly gives twelve records a year, not one per tick.

What is truly common shrinks to real constants (the calendar, public
decrees). Even the map is knowledge (see [watercolor-map.md](./watercolor-map.md),
where the knowledge state already is the painting stage).

### 3. SQL as the query language

Players are to correlate data themselves, across entities (route ×
dynasty × region × century), not only over time. SQL does that; PromQL does
not. The game always runs as a server, also locally, so the database can be
EMBEDDED in the Go server — no extra service.

| Option | For | Against |
|---|---|---|
| DuckDB | columnar, built for analysis, window functions, Parquet export | the Go driver needs cgo: a larger binary, harder cross-compilation |
| SQLite (`modernc`, pure Go) | no cgo, SQL with window functions | row store, slower for large analyses |

The database is DERIVED: it can be built again from the logs at any time.
So the choice can change later without loss.

### 4. Isolation is physical, not a filter

Neither DuckDB nor SQLite has row-level security. A shared database with
per-player views or rewritten queries is fragile: one forgotten table,
function or subquery opens other players' data. So:

- one store per player (the observation log), plus a small common store;
- per query session the server attaches ONLY the common store (read-only)
  and the player's own store. Other players' data does not exist in the
  session;
- the player comes from the token, as everywhere on the server
  ([access-control.md](./access-control.md)).

The session itself must also be closed:

- no file access and no extensions (DuckDB: `enable_external_access=false`,
  then `lock_configuration=true`; SQLite: an authorizer that refuses
  `ATTACH`, `PRAGMA` and extension loading);
- a time limit, a memory limit, a row limit on the result;
- read-only: only the server writes, from the logs.

## Job measurements (related, separate)

The job windows need better estimates (2026-10-02: the jobs window could
project an end only from a previous run of the same world). Measurements per
task — phase durations, node and tile counts, code hash, machine — belong
in the coordinator's store, and a small cost model over them (seconds per
million nodes per level) gives estimates for worlds without a previous run.
That cost model could be a query on the same kind of embedded database.

## Open questions

- What can a player know, and how? (Game design, outside the repository.)
- Does the player see a value's reliability, or must the player infer it
  from the source?
- DuckDB or SQLite — how hard is the rule "one static binary"?
- Retention: does an observation log thin out with age (like a round-robin
  database), or does the game keep everything?
- Players without SQL: saved and shared queries, a visual query builder,
  Parquet export for their own tools?
- Where does the event log live at scale — in the save, or in a store the
  save points to?
