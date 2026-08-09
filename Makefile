# Build/ship targets for casas-eternas. Run from the repo root.
#
#   make lint    type-check the client and vet the server (the project's lint;
#                no ESLint/Biome is configured, and the branch convention is
#                "verify with tsc", so this is the honest gate)
#   make test    the Go tests plus the worldgen regression harness
#   make baker   bundle the bake pipeline for Node (./baker.mjs)
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

.PHONY: lint test baker client run build push

lint:
	cd client && npx tsc --noEmit
	gofmt -l . | tee /dev/stderr | (! read)
	go vet ./...

test:
	go test ./internal/...
	cd client && npm run roundtrip
	cd client && npm run golden

# The bake pipeline, bundled for Node. Lands beside the binary because that is
# where --baker looks by default.
baker:
	cd client && npm run build:baker

client:
	cd client && npm run build

# Everything a local instance needs, then start it. `go build` rather than
# `go run` on purpose: --baker and --dir-client resolve relative to the
# EXECUTABLE, and go run puts that in a temp directory.
run: baker client
	go build -o casas-eternas .
	./casas-eternas start --target all --dir-client client/dist

build:
	docker build --platform linux/amd64 -f deploy/Dockerfile -t $(IMAGE):$(TAG) .

push: lint build
	docker push $(IMAGE):$(TAG)
