# syntax=docker/dockerfile:1
#
# Container image for casas-eternas: ONE binary that serves the client and
# the docs site, stores worlds and artifacts, bakes amplified terrain, and
# runs the login (auth target).
#
# Build context is the REPO ROOT (needs client/, docs/changelog/, cmd/,
# internal/, main.go):
#   docker build -f deploy/Dockerfile -t casas-eternas:latest .
#
# WHY THE RUNTIME CARRIES NODE. The job worker is the client's own
# TypeScript, bundled for Node and spawned as a subprocess, computing on the
# Rust engine's native build beside it (stage 0) — that is what keeps
# a server-baked artifact byte-identical to a browser-baked one, since both
# carry a key derived from their inputs. Two images (Go here, Node there) would
# be two things that can drift, and drift means a pipeline-version mismatch,
# which fails SILENTLY: bakes succeed, artifacts appear, and no client ever
# looks for them. One image, one commit, no drift.
#
# OpenShift-ready: runs as a non-root, ARBITRARY UID (member of GID 0), listens
# on 8080, and keeps all writable state on mounted volumes.

# ---- Stage 0: the engine ----------------------------------------------------
# The Rust engine (docs/decisions/rust-engine.md) in its two builds: the
# native one for the job worker, the WASM one for the generator in the
# browser, which the client's bundle carries. From the pipeline's release
# (docs/decisions/engine-releases.md, fork 3), so the image holds the builds
# the release made: ENGINE_RELEASE names it (`engine-<pipeline>`; `make
# image` reads the pipeline from the tree), ENGINE_SOURCE where the releases
# are. Every file is checked against the release's SHA256SUMS, which the
# image keeps in /app/engine: with it the jobs module puts the files into
# the artifact store at its start, for workers elsewhere.
#
# ENGINE=source builds the engine here instead (fork 8), for an image of a
# pipeline that has no release yet: glibc, as the release's linux build,
# and without SHA256SUMS, so nothing of it goes into the artifact store.
# wasm-bindgen's CLI is the crate's version (the Makefile's WASM_BINDGEN);
# RUSTUP_TOOLCHAIN stands for engine/rust-toolchain.toml.
#
# Every stage's /out: dist/ as engine/dist holds it (casas-engine.node,
# wasm/, constants.json), and release/ the release's files as they are named
# there (empty from the source).
ARG ENGINE=release

FROM debian:bookworm-slim AS engine-release
ARG ENGINE_RELEASE
ARG ENGINE_SOURCE=https://github.com/DebakelOrakel/casas-eternas/releases/download
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /out/release
RUN test -n "$ENGINE_RELEASE" || { echo "ENGINE_RELEASE is not set: \`make image\` sets it, or ENGINE=source builds the engine" >&2; exit 1; } \
 && files="casas-engine-linux-amd64.node casas-engine-wasm.tar.gz constants.json pipeline.json pipeline.mjs" \
 && curl -fsSL -o SHA256SUMS.all "$ENGINE_SOURCE/$ENGINE_RELEASE/SHA256SUMS" \
 && for file in $files; do curl -fsSL -o "$file" "$ENGINE_SOURCE/$ENGINE_RELEASE/$file" || { echo "$ENGINE_RELEASE has no $file" >&2; exit 1; }; \
      grep -E "  $file\$" SHA256SUMS.all >> SHA256SUMS || { echo "$file is not in the SHA256SUMS of $ENGINE_RELEASE" >&2; exit 1; }; done \
 && rm SHA256SUMS.all && sha256sum -c SHA256SUMS \
 && mkdir -p /out/dist && tar -xzf casas-engine-wasm.tar.gz -C /out/dist \
 && cp constants.json /out/dist/ && cp casas-engine-linux-amd64.node /out/dist/casas-engine.node

FROM rust:1.98.1-bookworm AS engine-source
ENV RUSTUP_TOOLCHAIN=1.98.1
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version 0.2.129 --locked
WORKDIR /src/engine
COPY engine/Cargo.toml engine/Cargo.lock engine/clippy.toml ./
COPY engine/crates/ ./crates/
RUN cargo build --release --locked -p casas-engine-node \
 && cargo build --release --locked -p casas-engine-wasm --target wasm32-unknown-unknown \
 && mkdir -p /out/dist /out/release \
 && cp target/release/libcasas_engine_node.so /out/dist/casas-engine.node \
 && wasm-bindgen --target web --out-dir /out/dist/wasm --out-name casas-engine \
      target/wasm32-unknown-unknown/release/casas_engine_wasm.wasm \
 && cargo run --release --locked -q -p casas-engine-api --bin constants > /out/dist/constants.json

FROM engine-${ENGINE} AS engine

# ---- Stage 0b: the history ---------------------------------------------------
# The incubator's history (docs/decisions/incubator-history-engine.md) in its
# two builds, from the tree always: the WASM one for the incubator in the
# browser, the native one for the history's jobs (history.mjs). Its own
# crate and version, not the pipeline's: the history changes, the engine's
# release does not. Its release (`history-<version>`) is for workers of
# another history version; the image runs the tree's.
FROM rust:1.98.1-bookworm AS history
ENV RUSTUP_TOOLCHAIN=1.98.1
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version 0.2.129 --locked
WORKDIR /src/engine
COPY engine/Cargo.toml engine/Cargo.lock engine/clippy.toml ./
COPY engine/crates/ ./crates/
RUN cargo build --release --locked -p casas-history-node \
 && cargo build --release --locked -p casas-history-wasm --target wasm32-unknown-unknown \
 && mkdir -p /out/dist/history \
 && cp target/release/libcasas_history_node.so /out/dist/casas-history.node \
 && wasm-bindgen --target web --out-dir /out/dist/history --out-name casas-history \
      target/wasm32-unknown-unknown/release/casas_history_wasm.wasm \
 && cargo run --release --locked -q -p casas-history --bin history-version > /out/dist/history/version.json

# ---- Stage 1: the client bundle and the job worker -------------------------
FROM node:26-bookworm-slim AS web
# Mirrors the repo layout (/app/client + /app/docs) rather than flattening the
# client to /app. The title screen's changelog viewer imports
# `../../../../docs/changelog/*.md` with Vite's ?raw, which reaches OUT of
# client/ — flattened, that path resolved to a /docs that does not exist in the
# image and the build failed on five unresolved imports.
WORKDIR /app/client

COPY client/package.json client/package-lock.json ./
RUN npm ci

# All of docs/ — the changelog viewer reads changelog/, and build:docs renders
# the whole tree into the site. ideas/ never enters the build's OUTPUT (the
# generator only reads vision/decisions/design/changelog), and the runtime
# image copies only docs-dist, so nothing private can ship even by accident.
COPY docs/ /app/docs/
COPY client/ ./

# dist/ is the app, the engine's WASM build among its assets; job-worker.mjs
# is the job worker for the server to spawn, with its pipeline module
# (pipeline.mjs) and the native engine beside it (build:worker copies
# engine/dist's), and the history's module (history.mjs) with the
# history's native build. The host and the app come out of this tree. The pipeline
# module is the release's, where there is one: the tree's must be the same
# pipeline, or the build stops — a tree whose pipeline is not its release's
# is a release that is missing (or ENGINE=source).
COPY --from=engine /out/dist/ /app/engine/dist/
COPY --from=history /out/dist/ /app/engine/dist/
COPY --from=engine /out/release/ /app/engine-release/
RUN npm run build && npm run build:worker && npm run build:docs \
 && if [ -f /app/engine-release/pipeline.mjs ]; then \
      node -e 'const [tree, release] = process.argv.slice(1).map((v) => JSON.parse(v)); if (JSON.stringify(tree) !== JSON.stringify(release)) { console.error(`the tree is pipeline ${JSON.stringify(tree)}, the release ${JSON.stringify(release)}`); process.exit(1) }' \
        "$(node /app/job-worker.mjs --version)" "$(cat /app/engine-release/pipeline.json)" \
      && cp /app/engine-release/pipeline.mjs /app/pipeline.mjs; \
    fi

# ---- Stage 2: the server ----------------------------------------------------
FROM golang:1.26-alpine AS server
WORKDIR /src
# What `casas-eternas version` reports. Passed IN rather than derived here:
# .dockerignore keeps .git out of the build context on purpose, so nothing in
# this stage could run `git describe`. `make image` supplies it; a bare
# `docker build` leaves the honest default.
ARG CASAS_VERSION=dev
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/
# Static: the runtime image is Node's, which has no Go toolchain and need not
# match libc.
RUN CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/DebakelOrakel/casas-eternas/cmd.buildVersion=${CASAS_VERSION}" \
    -o /out/casas-eternas .

# ---- Runtime ----------------------------------------------------------------
FROM node:26-bookworm-slim AS runtime

# The CA roots for the Go binary's TLS (the releases, S3): the slim base has
# none, and Node brings its own. Measured 2026-10-22: without them a
# download of a release file failed with "tls: failed to verify".
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# jobs.worker defaults to beside the executable, so it needs no flag. The
# client directory is passed explicitly in CMD: its default is empty on
# purpose, so that a dev run without a build serves only /config.json instead
# of refusing to start.
WORKDIR /app
COPY --from=server /out/casas-eternas /app/casas-eternas
COPY --from=web    /app/job-worker.mjs /app/job-worker.mjs
COPY --from=web    /app/pipeline.mjs /app/pipeline.mjs
# The release's files with their SHA256SUMS (empty for ENGINE=source): what
# the jobs module puts into the artifact store at its start.
COPY --from=engine /out/release/ /app/engine/
COPY --from=web    /app/casas-engine.node /app/casas-engine.node
COPY --from=web    /app/history.mjs /app/history.mjs
COPY --from=web    /app/casas-history.node /app/casas-history.node
COPY --from=web    /app/client/dist   /app/dist
COPY --from=web    /app/client/docs-dist /app/docs-dist

# OpenShift assigns a random UID that is ALWAYS in the root group (GID 0). Give
# group 0 the owner's access on everything the process reads, so any assigned
# UID works. Writable state lives on mounted volumes, not here.
RUN chgrp -R 0 /app && chmod -R g=u /app \
 && mkdir -p /data/worlds /data/artifacts /data/auth /data/relay /data/jobs && chgrp -R 0 /data && chmod -R g=u /data

USER 1001
# 8080 the HTTP API, 4222 the relay (NATS) the job workers connect to.
EXPOSE 8080 4222
VOLUME ["/data"]

# Every module by default. A deployment that wants only storage, or only the
# frontend, overrides the arguments — see internal/config's target list.
ENTRYPOINT ["/app/casas-eternas"]
CMD ["start", "--target", "all", "--client.content-dir", "/app/dist", "--docs.content-dir", "/app/docs-dist", "--world.storage.dir.path", "/data/worlds", "--artifacts.storage.dir.path", "/data/artifacts", "--auth.state-dir", "/data/auth", "--relay.state-dir", "/data/relay", "--jobs.state-dir", "/data/jobs"]
