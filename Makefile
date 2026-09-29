# Build/ship targets for casas-eternas. Run from the repo root.
#
#   make lint    type-check the client and vet the server (the project's lint;
#                no ESLint/Biome is configured, and the branch convention is
#                "verify with tsc", so this is the honest gate)
#   make test    the Go tests plus the worldgen regression harness
#   make baker   bundle the level bake for Node (./baker.mjs)
#   make run     build everything and start a local server on :8080
#   make build   build the container image (deploy/Dockerfile, context = repo
#                root — it needs client/, docs/changelog/, cmd/, internal/)
#   make push    lint + build, then push to the registry
#
# The container is ONE binary that serves the client, stores worlds and
# artifacts, and bakes — see deploy/Dockerfile for why it also carries Node.
#
# Override the image/tag per invocation, e.g.:
#   make push TAG=v0.3.0
#   make build IMAGE=ghcr.io/someone-else/casas-eternas
#
# Pushing to ghcr.io needs a prior `docker login ghcr.io` with a token that
# has the `write:packages` scope.

IMAGE ?= ghcr.io/debakelorakel/casas-eternas
TAG   ?= latest

# What `casas-eternas version` reports, stamped into the binary at link time.
# The same string the client bundle carries (client/vite.config.ts resolves it
# the same way), so one build says one thing about itself.
#
# Computed HERE and passed into the container build as an argument, because the
# image cannot work it out: .dockerignore keeps .git out of the build context on
# purpose, so `git describe` inside a stage has nothing to read.
VERSION ?= $(shell git describe --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X github.com/DebakelOrakel/casas-eternas/cmd.buildVersion=$(VERSION)

.PHONY: lint test baker client run build push cli-reference

lint:
	cd client && npx tsc --noEmit
	# The Node side separately: scripts/bake.ts needs @types/node and the browser
	# code must not have it. Two configs, both checked — see tsconfig.node.json.
	cd client && npx tsc --noEmit -p tsconfig.node.json
	gofmt -l . | tee /dev/stderr | (! read)
	go vet ./...
	# The committed CLI/config reference must match the cobra tree it is
	# generated from — a machine-maintained file with a drift gate, not a
	# hand-maintained list (docs/decisions/documentation-architecture.md).
	@go run ./tools/clidump | diff -q docs/operations/cli-reference.json - > /dev/null \
		|| (echo "docs/operations/cli-reference.json is stale — run 'make cli-reference'" >&2; exit 1)

# Regenerate the CLI/config reference the docs site renders. Run after
# changing commands, flags or their help texts; lint fails until you do.
cli-reference:
	go run ./tools/clidump > docs/operations/cli-reference.json

test:
	go test ./internal/...
	cd client && npm run harness:roundtrip
	cd client && npm run harness:pipeline
	cd client && npm run harness:mesh
	cd client && npm run harness:golden

# The bake pipeline, bundled for Node. Lands beside the binary because that is
# where bake.baker looks by default.
baker:
	cd client && npm run build:baker

client:
	cd client && npm run build

# The documentation site — docs/ rendered static (see the addendum in
# docs/decisions/documentation-architecture.md). The build link-checks itself.
docs:
	cd client && npm run build:docs

# Everything a local instance needs, then start it. `go build` rather than
# `go run` on purpose: bake.baker resolves relative to the EXECUTABLE, and
# go run puts that in a temp directory.
run: baker client docs
	go build -ldflags="$(LDFLAGS)" -o casas-eternas .
	./casas-eternas start --target all --client.storage.dir.path client/dist --docs.storage.dir.path client/docs-dist

build:
	docker build --platform linux/amd64 --build-arg CASAS_VERSION=$(VERSION) -f deploy/Dockerfile -t $(IMAGE):$(TAG) .

push: lint build
	docker push $(IMAGE):$(TAG)
