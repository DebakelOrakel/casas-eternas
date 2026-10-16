package cmd

import (
	"context"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

// H3 (review of 2026-10-16): when the world and the artifacts targets run
// in one process, a start whose two storage roots are one or nested is
// refused before any bucket opens, naming both keys. Before, it started,
// and the artifact store's sweep deleted the worlds as junk.
func TestAStartRefusesWorldsInTheArtifactStorage(t *testing.T) {
	root := t.TempDir()
	var cfg config.Config
	cfg.Global.Listen = "127.0.0.1:8080"
	cfg.Global.Auth.Mode = string(config.AuthNone)
	cfg.World.ReadLinkTTL = 15 * time.Minute
	cfg.Artifacts.ReadLinkTTL = 15 * time.Minute
	cfg.Artifacts.WriteLinkTTL = time.Hour
	cfg.World.Storage = config.ObjectStorage{Type: "dir", Dir: &config.DirStorage{Path: root}}
	both := config.Targets{config.TargetWorld: true, config.TargetArtifacts: true}
	for _, artifactsPath := range []string{root, filepath.Join(root, "artifacts")} {
		cfg.Artifacts.Storage = config.ObjectStorage{Type: "dir", Dir: &config.DirStorage{Path: artifactsPath}}
		modules, _, _, err := buildModules(context.Background(), both, cfg)
		if err == nil {
			closeAll(t, modules)
		}
		if err == nil || !strings.Contains(err.Error(), "world.storage") || !strings.Contains(err.Error(), "artifacts.storage") {
			t.Errorf("artifacts at %s: %v, want a refusal that names both keys", artifactsPath, err)
		}
	}
	// Apart, they start.
	cfg.World.Storage.Dir.Path = filepath.Join(root, "worlds")
	cfg.Artifacts.Storage.Dir.Path = filepath.Join(root, "artifacts")
	modules, _, _, err := buildModules(context.Background(), both, cfg)
	if err != nil {
		t.Fatalf("two directories: %v", err)
	}
	closeAll(t, modules)
}

// Without TLS a local worker reaches this server over the public listener
// (DEC-0038, step 3).
func TestLocalWorkerAPIWithoutTLS(t *testing.T) {
	cases := []struct {
		listen, want, wantErr string
	}{
		{listen: ":8080", want: "http://127.0.0.1:8080/v1"},
		{listen: "0.0.0.0:8080", want: "http://127.0.0.1:8080/v1"},
		{listen: "[::]:8080", want: "http://[::1]:8080/v1"},
		{listen: "localhost:9000", want: "http://localhost:9000/v1"},
		{listen: "10.0.0.5:8080", want: "http://10.0.0.5:8080/v1"},
		{listen: "nonsense", wantErr: "global.listen"},
	}
	for _, c := range cases {
		var g config.Global
		g.Listen = c.listen
		got, listener, err := localWorkerAPI(g)
		if listener != nil {
			listener.Close()
			t.Errorf("%s: an internal listener without TLS", c.listen)
		}
		if c.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Errorf("%s: err = %v, want %q", c.listen, err, c.wantErr)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%s: %q, %v, want %q", c.listen, got, err, c.want)
		}
	}
}

// With TLS the local worker gets the internal listener: bound to exactly
// 127.0.0.1 (never a wildcard, it speaks plain HTTP), on a port of its own,
// and the URL names that address — whatever the public listener binds.
func TestLocalWorkerAPIWithTLSOpensTheInternalListener(t *testing.T) {
	for _, listen := range []string{":8443", "0.0.0.0:8443", "[::]:8443", "casas.example.org:443"} {
		var g config.Global
		g.Listen, g.TLS.Cert, g.TLS.Key = listen, "c.pem", "k.pem"
		got, listener, err := localWorkerAPI(g)
		if err != nil {
			t.Fatalf("%s: %v", listen, err)
		}
		addr, ok := listener.Addr().(*net.TCPAddr)
		if !ok || !addr.IP.Equal(net.IPv4(127, 0, 0, 1)) || addr.Port == 0 {
			t.Errorf("%s: bound to %v, want 127.0.0.1 with a port", listen, listener.Addr())
		}
		if want := "http://" + listener.Addr().String() + "/v1"; got != want {
			t.Errorf("%s: %q, want %q", listen, got, want)
		}
		listener.Close()
	}
}
