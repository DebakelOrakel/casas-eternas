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

# ---- Stage 0: the engine and the incubator ---------------------------------
# The Rust workspace's two crates, from the tree, each in its two builds
# (docs/decisions/engine-releases.md, fork 3): the engine
# (docs/decisions/rust-engine.md) native for the job worker and WASM for the
# generator in the browser; the incubator
# (docs/decisions/incubator-history-engine.md) native for its history jobs
# (incubator.mjs) and WASM for the incubator in the browser. The client's
# bundle carries the WASM builds. glibc, as the releases' linux builds. A
# worker of another pipeline or incubator version gets its files from that
# release, through the server, which keeps them in the artifact store.
# wasm-bindgen's CLI is the crates' version (the Makefile's WASM_BINDGEN);
# RUSTUP_TOOLCHAIN stands for engine/rust-toolchain.toml.
#
# /out/dist is what engine/dist holds (casas-generator.node, wasm/,
# constants.json, casas-incubator.node, incubator/).
FROM rust:1.98.1-bookworm AS engine
ENV RUSTUP_TOOLCHAIN=1.98.1
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version 0.2.129 --locked
WORKDIR /src/engine
COPY engine/Cargo.toml engine/Cargo.lock engine/clippy.toml ./
COPY engine/crates/ ./crates/
RUN cargo build --release --locked -p casas-generator-node -p casas-incubator-node \
 && cargo build --release --locked -p casas-generator-wasm -p casas-incubator-wasm --target wasm32-unknown-unknown \
 && mkdir -p /out/dist/incubator \
 && cp target/release/libcasas_generator_node.so /out/dist/casas-generator.node \
 && cp target/release/libcasas_incubator_node.so /out/dist/casas-incubator.node \
 && wasm-bindgen --target web --out-dir /out/dist/wasm --out-name casas-generator \
      target/wasm32-unknown-unknown/release/casas_generator_wasm.wasm \
 && wasm-bindgen --target web --out-dir /out/dist/incubator --out-name casas-incubator \
      target/wasm32-unknown-unknown/release/casas_incubator_wasm.wasm \
 && cargo run --release --locked -q -p casas-generator-api --bin constants > /out/dist/constants.json \
 && cargo run --release --locked -q -p casas-incubator --bin incubator-version > /out/dist/incubator/version.json \
 && cargo run --release --locked -q -p casas-incubator --bin incubator-constants > /out/dist/incubator/constants.json

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
# engine/dist's), and the incubator's module (incubator.mjs) with the
# incubator's native build.
COPY --from=engine /out/dist/ /app/engine/dist/
# The incubator's catalogs, which the client reads as the crate does
# (vite.config.ts, casas-incubator-data).
COPY engine/crates/casas-incubator/data/ /app/engine/crates/casas-incubator/data/
RUN npm run build && npm run build:worker && npm run build:docs

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
COPY --from=web    /app/casas-generator.node /app/casas-generator.node
COPY --from=web    /app/incubator.mjs /app/incubator.mjs
COPY --from=web    /app/casas-incubator.node /app/casas-incubator.node
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
