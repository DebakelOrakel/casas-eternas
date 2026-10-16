package cmd

import (
	"context"
	"net"
	"os"
	"runtime"
	"strings"
	"testing"

	"github.com/DebakelOrakel/casas-eternas/internal/blob"
	"github.com/DebakelOrakel/casas-eternas/internal/blob/blobtest"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
	"github.com/DebakelOrakel/casas-eternas/internal/modules/world"
)

// A wiring that fails after the internal listener is open closes it again:
// bakeConfig returns no listener then, so its caller cannot. The world store
// on s3 (a local worker reads its saves over the API, DEC-0038 step 5) and
// TLS on the public listener open it in the world branch; the artifact sink
// fails after it.
func TestAFailedJobsWiringClosesTheInternalListener(t *testing.T) {
	_, srv := blobtest.NewS3(t, blobtest.Options{KeyID: "AKIDFAKE", TLS: true})
	access, secret := blobtest.KeyFiles(t, "AKIDFAKE")
	bucket, err := blob.OpenS3(context.Background(), blob.S3Config{
		Flavour: blob.FlavourCeph, Endpoint: srv.URL, Bucket: "worlds",
		AccessKeyFile: access, SecretKeyFile: secret, HTTPClient: srv.Client(),
	}, world.BucketOptions())
	if err != nil {
		t.Fatal(err)
	}
	caller := identity.NewResolver(config.AuthNone, nil)
	worldModule, err := world.New(context.Background(), world.Config{Bucket: bucket, Identity: caller})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = worldModule.Close() })
	if worldModule.Store().LocalFiles() {
		t.Fatal("the s3 world store claims local files")
	}

	cases := map[string]struct {
		targets   config.Targets
		artifacts string // global.services.artifacts
		want      string // "" for a wiring that succeeds
	}{
		"no artifact sink":           {want: "artifact sink"},
		"an artifact peer not there": {artifacts: "http://127.0.0.1:1", want: "artifacts"},
		"the artifacts co-resident":  {targets: config.Targets{config.TargetArtifacts: true}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			var cfg config.Config
			cfg.Global.Listen = "127.0.0.1:8443"
			cfg.Global.TLS.Cert, cfg.Global.TLS.Key = "c.pem", "k.pem"
			cfg.Global.Services.Artifacts = c.artifacts
			targets := config.Targets{config.TargetWorld: true, config.TargetJobs: true}
			for target := range c.targets {
				targets[target] = true
			}

			var opened []net.Listener
			restore := listenInternal
			t.Cleanup(func() { listenInternal = restore })
			listenInternal = func() (net.Listener, error) {
				l, err := restore()
				if err == nil {
					opened = append(opened, l)
				}
				return l, err
			}

			_, internal, err := bakeConfig(targets, cfg, worldModule, nil, nil, caller, nil)
			if len(opened) != 1 {
				t.Fatalf("%d internal listeners opened, want 1 (err %v)", len(opened), err)
			}
			if c.want == "" {
				// The success path keeps it open, for server.Run.
				if err != nil || internal != opened[0] {
					t.Fatalf("bakeConfig = %v, listener %v; want the one it opened", err, internal)
				}
				_ = internal.Close()
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("bakeConfig = %v, want an error about %q", err, c.want)
			}
			if internal != nil {
				t.Error("a failed wiring returned a listener")
			}
			// Closed: its port can be bound again.
			again, err := net.Listen("tcp", opened[0].Addr().String())
			if err != nil {
				_ = opened[0].Close()
				t.Fatalf("the internal listener is still open: %v", err)
			}
			_ = again.Close()
		})
	}
}

// A start that fails after the world module is made closes the module
// again, and with it the bucket (a Dir holds its root open): no file
// descriptor outlives the failed start.
func TestAFailedWiringClosesTheModulesItMade(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("counts the open files in /dev/fd")
	}
	open := func() int {
		entries, err := os.ReadDir("/dev/fd")
		if err != nil {
			t.Fatal(err)
		}
		return len(entries)
	}
	var cfg config.Config
	cfg.Global.Listen = "127.0.0.1:8080"
	cfg.Global.Auth.Mode = string(config.AuthNone)
	cfg.World.Storage = config.ObjectStorage{Type: "dir", Dir: &config.DirStorage{Path: t.TempDir()}}
	targets := config.Targets{config.TargetWorld: true, config.TargetJobs: true}
	build := func() {
		modules, _, _, err := buildModules(context.Background(), targets, cfg)
		if err == nil || !strings.Contains(err.Error(), "artifact sink") {
			closeAll(t, modules)
			t.Fatalf("buildModules = %v, want the missing artifact sink", err)
		}
	}
	build() // once first, so that what the runtime opens once is open
	before := open()
	for range 3 {
		build()
	}
	if after := open(); after != before {
		t.Errorf("%d open files after three failed starts, %d before", after, before)
	}
}
