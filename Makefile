# Build/ship targets for casas-eternas. Run from the repo root.
#
#   make lint    type-check the client and vet the server (the project's lint;
#                no ESLint/Biome is configured, and the branch convention is
#                "verify with tsc", so this is the honest gate)
#   make test    the Go tests, the engine's tests and the harnesses
#   make worker  bundle the job worker for Node (./job-worker.mjs, with
#                ./pipeline.mjs and ./casas-engine.node beside it)
#   make engine  build the Rust engine, native and WASM, into engine/dist/
#                (docs/decisions/rust-engine.md; the job worker runs on it)
#   make run     build everything and start a local server on :8080
#   make build   build the binary for macOS, Linux and Windows into bin/,
#                with the job worker beside it
#   make release worker + client + docs + build, one archive per platform in
#                bin/release/
#   make image   build the container image (deploy/Dockerfile, context = repo
#                root — it needs client/, docs/changelog/, cmd/, internal/),
#                on the release of the tree's pipeline, engine-<pipeline>;
#                ENGINE=source builds the engine in the image instead
#   make push    lint + image, then push to the registry
#
# The container is ONE binary that serves the client, stores worlds and
# artifacts, and bakes — see deploy/Dockerfile for why it also carries Node.
#
# Override the image/tag per invocation, e.g.:
#   make push TAG=v0.3.0
#   make image IMAGE=ghcr.io/someone-else/casas-eternas
#
# Pushing to ghcr.io needs a prior `docker login ghcr.io` with a token that
# has the `write:packages` scope.

IMAGE ?= ghcr.io/debakelorakel/casas-eternas
TAG   ?= latest
# Where the image's engine comes from: release (the pipeline's release) or
# source (built in the image, for a pipeline without a release).
ENGINE ?= release

# What `casas-eternas version` reports, stamped into the binary at link time.
# The same string the client bundle carries (client/vite.config.ts resolves it
# the same way), so one build says one thing about itself.
#
# Computed HERE and passed into the container build as an argument, because the
# image cannot work it out: .dockerignore keeps .git out of the build context on
# purpose, so `git describe` inside a stage has nothing to read.
VERSION ?= $(shell git describe --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X github.com/DebakelOrakel/casas-eternas/cmd.buildVersion=$(VERSION)

.PHONY: lint test engine engines worker client docs run build release image push cli-reference

# The platforms `make build` and `make release` make, as GOOS/GOARCH. The
# server is pure Go (CGO_ENABLED=0), so one machine builds them all; the job
# worker's engine is a Node addon per platform (`make engines`), and these
# are the platforms a Mac with Docker builds it for without other tools
# (2026-10-21: linux/arm64, windows/amd64 and darwin/amd64 went with the
# engine).
PLATFORMS := darwin/arm64 linux/amd64

lint:
	cd client && npx tsc --noEmit
	# The Node side separately: scripts/jobWorker.ts needs @types/node and the browser
	# code must not have it. Two configs, both checked — see tsconfig.node.json.
	cd client && npx tsc --noEmit -p tsconfig.node.json
	# The generator computes the same bits in every JavaScript engine only
	# through core/detMath.ts: Math's transcendental functions and `**`
	# differ between engines in the last bit (render/ draws, so it may).
	@! grep -rnE 'Math\.(exp|log|log2|log10|log1p|expm1|pow|sin|cos|tan|atan|atan2|asin|acos|hypot|cbrt|sinh|cosh|tanh|asinh|acosh|atanh)\(|\*\*[[:space:]]*[A-Za-z0-9(.]' \
		client/src/generator --include='*.ts' --exclude-dir=render --exclude=detMath.ts \
		| grep -vE ':[0-9]+:[[:space:]]*(//|\*)' \
		|| (echo "use core/detMath.ts in client/src/generator, not the Math functions above or **" >&2; exit 1)
	# The generator reaches the world's topology only through core/domain.ts
	# (DEC-0035, docs/decisions/two-shapes.md, fork 1): core/toroidal.ts is
	# the torus Domain's own arithmetic, and no other file may import it.
	@! grep -rnE "from '(\.\./)*(core/|\./)toroidal'" \
		client/src/generator --include='*.ts' --exclude=domain.ts --exclude=toroidal.ts \
		|| (echo "use the Domain (core/domain.ts) in client/src/generator, not core/toroidal.ts" >&2; exit 1)
	# A raster wraps through the DomainGrid its Domain gives (DEC-0035, fork
	# 1): core/field.ts's torus wrap and the samplers built on it belong to
	# the torus Domain, and nothing outside core/ calls them. The periodic
	# noise lattices are excepted: their period is a parameter (a level's
	# grid, the lithology lattice, a texture), and their wrap is the chart
	# lattice's own. A sphere world does not reach it: Domain.noise sends
	# its samples to the 3D lattice (elevation/globeNoise.ts, not excepted).
	@! grep -rnwE 'wrapValue|sampleBilinearGrid|sampleBilinearWorld|sampleNearestWorld|upscaleBilinearToroidal' \
		client/src/generator --include='*.ts' --exclude-dir=core \
		--exclude=ridgedNoise.ts --exclude=domainWarp.ts --exclude=hypsometry.ts \
		| grep -vE ':[0-9]+:[[:space:]]*(//|\*)' \
		|| (echo "wrap a raster through its DomainGrid (core/domain.ts) in client/src/generator, not core/field.ts" >&2; exit 1)
	# What a metre is belongs to the world's shape (DEC-0035, fork 6): code
	# reads it from the Domain (metresPerUnit, metresAround), not from the
	# shape constants in core/mapConfig.ts. Excepted: the places that mean
	# the torus's own scale and say so — the flat map's scene and its fine
	# relief, the tile sampler, the incubator (its worlds are tori).
	@! grep -rnwE 'TORUS_METERS_PER_CELL|SPHERE_EQUATOR_METERS' \
		client/src --include='*.ts' --exclude=mapConfig.ts --exclude=domain.ts \
		--exclude=mapSceneSettings.ts --exclude=channelField.ts --exclude=tileSampler.ts --exclude-dir=incubator \
		| grep -vE ':[0-9]+:[[:space:]]*(//|\*)' \
		|| (echo "read a length's scale from the Domain (metresPerUnit, metresAround), not from core/mapConfig.ts's shape constants" >&2; exit 1)
	gofmt -l . | tee /dev/stderr | (! read)
	go vet ./...
	# The committed CLI/config reference must match the cobra tree it is
	# generated from — a machine-maintained file with a drift gate, not a
	# hand-maintained list (docs/decisions/documentation-architecture.md).
	@go run ./tools/clidump | diff -q docs/operations/cli-reference.json - > /dev/null \
		|| (echo "docs/operations/cli-reference.json is stale — run 'make cli-reference'" >&2; exit 1)
	cd engine && cargo fmt --check
	# The workspace builds the engine with `parallel` (the native crate turns
	# it on); the engine alone builds it without, as the WASM build does.
	cd engine && cargo clippy --workspace --all-targets -- -D warnings
	cd engine && cargo clippy -p casas-engine --all-targets -- -D warnings

# Regenerate the CLI/config reference the docs site renders. Run after
# changing commands, flags or their help texts; lint fails until you do.
cli-reference:
	go run ./tools/clidump > docs/operations/cli-reference.json

test: engine
	go test ./internal/...
	# The engine's tests run on fixtures the TypeScript engine wrote before
	# it went (DEC-0044, fork 7c): data now, in engine/crates/*/tests/fixtures.
	cd engine && cargo test --workspace --release
	cd engine && cargo test -p casas-engine --release
	# WASM gives the native bits (DEC-0044, fork 4): the same tests built for
	# wasm32-wasip1 and run under Node's WASI, without `parallel`, as the
	# browser build is. About five minutes.
	cd engine && CARGO_TARGET_WASM32_WASIP1_RUNNER="node --no-warnings $(CURDIR)/engine/scripts/wasiRunner.mjs" \
		cargo test -p casas-engine --release --target wasm32-wasip1
	node engine/scripts/smoke.mjs
	# The incubator's history: its WASM build on two synthetic worlds against
	# the recorded reference, its native build against the WASM
	# (docs/decisions/incubator-history-engine.md).
	node engine/scripts/historySmoke.mjs
	cd client && npm run harness:roundtrip
	cd client && npm run test:http-store
	cd client && npm run harness:pipeline

# The Rust engine (docs/decisions/rust-engine.md), for this machine only: the
# native build is a Node addon, built for each platform on its own (the
# release's: `make engines`).
# The WASM build needs the wasm32-unknown-unknown target, which rustup
# installs from engine/rust-toolchain.toml.
ENGINE_NODE_LIB := libcasas_engine_node.$(if $(filter Darwin,$(shell uname -s)),dylib,so)
HISTORY_NODE_LIB := libcasas_history_node.$(if $(filter Darwin,$(shell uname -s)),dylib,so)

WASM_BINDGEN := 0.2.129

engine:
	cd engine && cargo build --release -p casas-engine-node
	cd engine && cargo build --release -p casas-engine-wasm --target wasm32-unknown-unknown
	# The CLI must be the crate's version (casas-engine-wasm/Cargo.toml):
	# cargo install wasm-bindgen-cli --version $(WASM_BINDGEN) --locked
	@wasm-bindgen --version | grep -qx 'wasm-bindgen $(WASM_BINDGEN)' \
		|| (echo "engine: needs wasm-bindgen $(WASM_BINDGEN) — cargo install wasm-bindgen-cli --version $(WASM_BINDGEN) --locked" >&2; exit 1)
	mkdir -p engine/dist
	cp engine/target/release/$(ENGINE_NODE_LIB) engine/dist/casas-engine.node
	# The constants the pipeline versions are derived from (DEC-0044, fork 7a).
	cd engine && cargo run --release -q -p casas-engine-api --bin constants > dist/constants.json
	wasm-bindgen --target web --out-dir engine/dist/wasm --out-name casas-engine \
		engine/target/wasm32-unknown-unknown/release/casas_engine_wasm.wasm
	# The incubator's history (docs/decisions/incubator-history-engine.md),
	# a crate of its own beside the engine: its WASM build and its version.
	cd engine && cargo build --release -p casas-history-node
	cp engine/target/release/$(HISTORY_NODE_LIB) engine/dist/casas-history.node
	cd engine && cargo build --release -p casas-history-wasm --target wasm32-unknown-unknown
	wasm-bindgen --target web --out-dir engine/dist/history --out-name casas-history \
		engine/target/wasm32-unknown-unknown/release/casas_history_wasm.wasm
	cd engine && cargo run --release -q -p casas-history --bin history-version > dist/history/version.json

# The job worker, bundled for Node, with the engine's native build beside it,
# and the history's module with the history's.
# Lands beside the binary because that is where jobs.worker looks by default.
worker: engine
	cd client && npm run build:worker

# The generator computes on the engine's WASM build (engine/dist/wasm).
client: engine
	cd client && npm run build

# The documentation site — docs/ rendered static (see the addendum in
# docs/decisions/documentation-architecture.md). The build link-checks itself.
docs:
	cd client && npm run build:docs

# Everything a local instance needs, then start it. `go build` rather than
# `go run` on purpose: jobs.worker resolves relative to the EXECUTABLE, and
# go run puts that in a temp directory.
# Extra arguments for `start`, e.g. make run ARGS="--config dev/with-auth.yaml"
# (make reads a bare --config as its own option).
run: worker client docs
	go build -ldflags="$(LDFLAGS)" -o casas-eternas .
	./casas-eternas start --target all --client.content-dir client/dist --docs.content-dir client/docs-dist $(ARGS)

# One binary per platform, bin/casas-eternas-<os>-<arch>, and the job worker
# beside them with this machine's engine: jobs.worker looks next to the
# executable, and the bundle is the same on every platform. The client and
# the docs are directories passed by flag (client.content-dir,
# docs.content-dir), built by the targets above.
build: worker
	@mkdir -p bin
	@cp job-worker.mjs pipeline.mjs casas-engine.node history.mjs casas-history.node bin/
	@for platform in $(PLATFORMS); do \
		os=$${platform%/*}; arch=$${platform#*/}; \
		echo "bin/casas-eternas-$$os-$$arch"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags="$(LDFLAGS)" \
			-o bin/casas-eternas-$$os-$$arch . || exit 1; \
	done

# The engine's native build for every platform of PLATFORMS,
# bin/engine/<os>-<arch>/casas-engine.node, and the history's beside it
# (casas-history.node). On a Mac: darwin/arm64 by
# rustup's target (engine/rust-toolchain.toml), linux/amd64 in Rust's
# Debian image, so for glibc (the image's own is built for musl, in
# deploy/Dockerfile). The registry is kept in a Docker volume between runs.
engines:
	cd engine && cargo build --release --locked -p casas-engine-node -p casas-history-node --target aarch64-apple-darwin
	docker run --rm --platform linux/amd64 -v $(CURDIR)/engine:/src -w /src \
		-v casas-engine-cargo:/usr/local/cargo/registry \
		-e RUSTUP_TOOLCHAIN=1.98.1 -e CARGO_TARGET_DIR=/src/target/linux-amd64 \
		rust:1.98.1-bookworm cargo build --release --locked -p casas-engine-node -p casas-history-node
	@mkdir -p bin/engine/darwin-arm64 bin/engine/linux-amd64
	cp engine/target/aarch64-apple-darwin/release/libcasas_engine_node.dylib bin/engine/darwin-arm64/casas-engine.node
	cp engine/target/linux-amd64/release/libcasas_engine_node.so bin/engine/linux-amd64/casas-engine.node
	cp engine/target/aarch64-apple-darwin/release/libcasas_history_node.dylib bin/engine/darwin-arm64/casas-history.node
	cp engine/target/linux-amd64/release/libcasas_history_node.so bin/engine/linux-amd64/casas-history.node

# One archive per platform with everything `start` serves, laid out as the
# container image is: the binary, job-worker.mjs, pipeline.mjs and
# history.mjs with the platform's engine and history beside them (where
# jobs.worker looks by default), dist/
# and docs-dist/, as a
# .tar.gz. Run from the unpacked directory:
#   ./casas-eternas start --target all --client.content-dir dist --docs.content-dir docs-dist
# The job worker needs Node on the machine, as in the image.
release: worker client docs build engines
	@rm -rf bin/release && mkdir -p bin/release
	@for platform in $(PLATFORMS); do \
		os=$${platform%/*}; arch=$${platform#*/}; \
		name=casas-eternas-$(VERSION)-$$os-$$arch; dir=bin/release/$$name; \
		mkdir -p $$dir; \
		cp bin/casas-eternas-$$os-$$arch $$dir/casas-eternas; \
		cp bin/job-worker.mjs bin/pipeline.mjs bin/history.mjs $$dir/; \
		cp bin/engine/$$os-$$arch/casas-engine.node bin/engine/$$os-$$arch/casas-history.node $$dir/; \
		cp -R client/dist $$dir/dist; \
		cp -R client/docs-dist $$dir/docs-dist; \
		tar -czf bin/release/$$name.tar.gz -C bin/release $$name; echo "bin/release/$$name.tar.gz"; \
		rm -rf $$dir; \
	done

# The release is the tree's pipeline: the worker bundle tells it.
image: worker
	pipeline=$$(node job-worker.mjs --version | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).pipelineVersion') && \
	docker build --platform linux/amd64 --build-arg CASAS_VERSION=$(VERSION) \
		--build-arg ENGINE=$(ENGINE) --build-arg ENGINE_RELEASE=engine-$$pipeline \
		-f deploy/Dockerfile -t $(IMAGE):$(TAG) .

push: lint image
	docker push $(IMAGE):$(TAG)
