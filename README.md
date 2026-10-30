# Casas Eternas

100% hands off, no seatbelt, clanker jesus take the wheel.

A world generator and the game it is built for. A world is simulated from
its first crust: plates, mountains, erosion, climate, rivers and ecology.
Then the incubator grows its prehistory: peoples, farming, copper, the
first city. Worlds are flat tori or spheres.

## Parts

| | |
|---|---|
| `client/` | TypeScript, Babylon.js, Vite: the generator, the incubator, the map |
| `engine/` | Rust: the world's computation, native for the job worker, WASM for the browser |
| `internal/`, `cmd/` | Go server: worlds, artifacts, bake jobs, accounts |
| `docs/` | decisions, design notes, changelog, handbook, operations |

## Run

Needs Go 1.26 or later, Node 26, Rust 1.98.1 through rustup (it installs
the WASM targets from `engine/rust-toolchain.toml`) and wasm-bindgen-cli
0.2.129.

```
make run                    # builds engine, client and docs, serves on :8080
cd client && npm run dev    # the client loop
```

Checks: `make lint`, `make test`. More in [CLAUDE.md](./CLAUDE.md#commands).

## Docs

- [docs/README.md](./docs/README.md): how the docs are organised
- [docs/operations/](./docs/operations/): run it locally, in Docker, on Kubernetes
- [docs/decisions/](./docs/decisions/): why things are the way they are
- [docs/changelog/](./docs/changelog/): what arrived when
