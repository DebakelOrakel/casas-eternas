package cmd

import (
	"context"
	"fmt"
	"runtime"
	"time"

	"github.com/spf13/cobra"

	"github.com/DebakelOrakel/casas-eternas/internal/modules/bake"
	"github.com/DebakelOrakel/casas-eternas/internal/server"
)

// buildVersion is `git describe --always --dirty` at link time, written here by
// the linker (`-X …/cmd.buildVersion=…`, see the Makefile and
// deploy/Dockerfile). A plain `go build` or `go run` leaves "dev", which is
// honest: such a binary genuinely does not know what it is, and printing a
// guess would be worse than saying so.
//
// It lives in cmd/ because cmd/ is the composition root — the layer that knows
// what this program IS. internal/server publishes it at /v1/capabilities and is
// TOLD, exactly as it is told its gate; nothing below cmd/ needs to reach up
// for it.
//
// PROVENANCE, never a key — the same rule the client's BUILD_VERSION carries
// (client/src/app/buildVersion.ts). It says which build is answering; nothing
// may address, hash or compare content by it. What identifies content is the
// world hash and the pipeline version, and both are derived from inputs rather
// than announced.
var buildVersion = "dev"

// bakerVersionTimeout bounds the one thing here that runs a program. Node's
// startup is the whole cost — the bundle parses no world for --version — so a
// few seconds is generous, and a bound means `version` cannot hang on a broken
// or wedged bundle when the caller only wanted the build string.
const bakerVersionTimeout = 5 * time.Second

// VersionCmd reports what this binary IS.
//
// Four lines, and only the third one is the reason it exists. The build string
// and the Go runtime are the ordinary things a version command says. The
// PIPELINE version is the one this project actually needs: it is the key
// artifacts are addressed by, a baker built from a different commit than the
// client writes bytes under a key nobody looks for, and the resulting failure
// is silent — bakes succeed, artifacts appear, and the map never changes. That
// has happened once already (see client/scripts/bake.ts). This makes an
// image's pipeline something you read off it in a second rather than infer
// from a cache that never hits.
//
// Text only, on purpose: the machine-readable answer already exists and is
// better placed — GET /v1/capabilities carries the same build string from a
// RUNNING server, which is what a deploy check actually wants to know. A
// second format here would be a second surface saying the same thing.
var VersionCmd = &cobra.Command{
	Use:   "version",
	Short: "Prints the build, the API version and the bake pipeline this binary carries.",
	Long: `Prints what this binary is.

The pipeline version is the one worth reading: artifacts are addressed by it,
so a bake bundle from a different commit than the client expecting its output
produces artifacts nobody ever looks for — a failure that is otherwise silent.
It is read from the bake bundle itself (bake.baker), so it says what this
installation would actually run.

A running server reports the same build string at GET /v1/capabilities.`,
	Args: cobra.NoArgs,
	RunE: RunVersion,
}

func init() {
	RootCmd.AddCommand(VersionCmd)
}

func RunVersion(cmd *cobra.Command, args []string) error {
	out := cmd.OutOrStdout()
	// The program name as a bare header, then four labelled lines. The build is
	// labelled like the rest rather than sharing the header's line: it is one
	// of four versions this binary carries, and singling it out typographically
	// suggests the other three are footnotes — the pipeline in particular is
	// the one worth reading.
	fmt.Fprintf(out, "casas-eternas\n")
	fmt.Fprintf(out, "  binary    %s\n", buildVersion)
	fmt.Fprintf(out, "  api       %s\n", server.APIPrefix)
	fmt.Fprintf(out, "  pipeline  %s\n", pipelineLine(cmd))
	fmt.Fprintf(out, "  go        %s %s/%s\n", runtime.Version(), runtime.GOOS, runtime.GOARCH)
	return nil
}

// pipelineLine resolves the bake bundle exactly as `start` would and asks it.
//
// Every failure is a REPORTED line rather than an error that aborts the
// command: a binary without a bundle beside it is a perfectly valid world or
// auth target, and refusing to print the build string because such a process
// cannot bake would break `version` for the deployments that need it most.
func pipelineLine(cmd *cobra.Command) string {
	cfg, err := loadConfig()
	if err != nil {
		return fmt.Sprintf("unknown (%v)", err)
	}
	path := bakerPath(cfg.Bake.Baker)
	ctx, cancel := context.WithTimeout(cmd.Context(), bakerVersionTimeout)
	defer cancel()
	pipeline, err := bake.BakerVersion(ctx, path)
	if err != nil {
		return fmt.Sprintf("unknown (%v)", err)
	}
	return fmt.Sprintf("%s (%s)", pipeline, path)
}
