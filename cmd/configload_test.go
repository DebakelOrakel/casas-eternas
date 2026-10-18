package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

// These tests exercise the REAL loader against the package's global viper —
// bindings, env replacer and all — because the precedence chain (flag > env >
// file > default) only exists in that assembled state; a fresh viper would
// test a different program. Each test points flagConfig at its own file;
// ReadInConfig replaces the previous file layer wholesale, so tests do not
// bleed into each other through it.

// configFile writes a casas.yaml for one test and points the loader at it.
func configFile(t *testing.T, content string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "casas.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	viper.Set(flagConfig, path)
	t.Cleanup(func() {
		viper.Set(flagConfig, "")
		// A failed ReadInConfig KEEPS the previous file layer, so a later
		// test running without a file would still see this one's values;
		// reading an empty document is how the layer is actually cleared.
		viper.SetConfigType("yaml")
		if err := viper.ReadConfig(strings.NewReader("")); err != nil {
			t.Fatal(err)
		}
	})
}

func TestLoadConfigReadsTheTree(t *testing.T) {
	configFile(t, `
global:
  listen: "127.0.0.1:9999"
  auth:
    token-ttl: 24h
world:
  keep-revisions: 7
  storage:
    type: dir
    dir:
      path: /tmp/worlds
`)
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Global.Listen != "127.0.0.1:9999" {
		t.Errorf("listen = %q", cfg.Global.Listen)
	}
	if cfg.Global.Auth.TokenTTL != 24*time.Hour {
		t.Errorf("token-ttl = %v, want the duration hook to parse 24h", cfg.Global.Auth.TokenTTL)
	}
	if cfg.World.KeepRevisions != 7 {
		t.Errorf("keep-revisions = %d", cfg.World.KeepRevisions)
	}
	if got := cfg.World.Storage.DirPath(); got != "/tmp/worlds" {
		t.Errorf("world storage path = %q", got)
	}
}

func TestLoadConfigRefusesUnknownKeys(t *testing.T) {
	// A typo must be a start error, not a silently-applied default.
	configFile(t, "wolrd:\n  keep-revisions: 7\n")
	if _, err := loadConfig(); err == nil || !strings.Contains(err.Error(), "wolrd") {
		t.Errorf("want an error naming the unknown key, got %v", err)
	}
}

func TestLoadConfigRefusesTargetInFile(t *testing.T) {
	// The same file serves every process of a split deployment; a role in it
	// would give every process the same role.
	for _, key := range []string{"target", "targets"} {
		configFile(t, key+": all\n")
		if _, err := loadConfig(); err == nil || !strings.Contains(err.Error(), key) {
			t.Errorf("want %q refused, got %v", key, err)
		}
	}
}

func TestLoadConfigEnvOverridesFile(t *testing.T) {
	initConfig() // wire CASAS_* exactly as a real start does
	t.Setenv("CASAS_GLOBAL_LISTEN", "127.0.0.1:7777")
	configFile(t, "global:\n  listen: \"127.0.0.1:9999\"\n")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Global.Listen != "127.0.0.1:7777" {
		t.Errorf("listen = %q, want the environment to beat the file", cfg.Global.Listen)
	}
}

// Environment values are strings whatever the key's type — a numeric key set
// via CASAS_* must decode into its int field, and garbage must stay a loud
// start error instead of a weakly-typed guess. Pinned because exactly this
// failed in the field: CASAS_JOBS_MAX_CONCURRENT=3 refused to start.
func TestLoadConfigDecodesNumbersFromTheEnvironment(t *testing.T) {
	initConfig()
	viper.Set(flagConfig, "")
	t.Setenv("CASAS_JOBS_MAX_CONCURRENT", "3")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Jobs.MaxConcurrent != 3 {
		t.Errorf("max-concurrent = %d, want 3", cfg.Jobs.MaxConcurrent)
	}

	t.Setenv("CASAS_JOBS_MAX_CONCURRENT", "many")
	if _, err := loadConfig(); err == nil {
		t.Error("a non-numeric value decoded without complaint")
	}
}

func TestLoadConfigWithoutFileUsesFlagDefaults(t *testing.T) {
	viper.Set(flagConfig, "")
	// The working directory is cmd/, which holds no casas.yaml — the ordinary
	// flags-and-defaults start.
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Global.Listen != ":8080" {
		t.Errorf("listen = %q, want the flag default", cfg.Global.Listen)
	}
	if cfg.World.KeepRevisions != 3 {
		t.Errorf("keep-revisions = %d, want the flag default", cfg.World.KeepRevisions)
	}
	// On unless a server says its workers all come from outside.
	if !cfg.Jobs.ScaleWorkers {
		t.Error("scale-workers off, want the flag default on")
	}
}

// A boolean from the environment, as the chart sets it for a server
// without workers of its own.
func TestLoadConfigTurnsTheScalerOff(t *testing.T) {
	initConfig()
	viper.Set(flagConfig, "")
	t.Setenv("CASAS_JOBS_SCALE_WORKERS", "false")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Jobs.ScaleWorkers {
		t.Error("scale-workers on, want CASAS_JOBS_SCALE_WORKERS=false to turn it off")
	}
	t.Setenv("CASAS_JOBS_SCALE_WORKERS", "nope")
	if _, err := loadConfig(); err == nil {
		t.Error("a non-boolean value decoded without complaint")
	}
}

// The HARD BREAK of DEC-0038: every renamed key is refused in the file and
// as a CASAS_* variable, and the message names the key that replaced it.
func TestLoadConfigRefusesRenamedKeys(t *testing.T) {
	initConfig()
	for old, renamed := range renamedKeys {
		t.Run("file "+old, func(t *testing.T) {
			parts := strings.Split(old, ".")
			yaml := ""
			for depth, part := range parts {
				yaml += strings.Repeat("  ", depth) + part + ":"
				if depth == len(parts)-1 {
					yaml += " /somewhere"
				}
				yaml += "\n"
			}
			configFile(t, yaml)
			_, err := loadConfig()
			if err == nil || !strings.Contains(err.Error(), old) || !strings.Contains(err.Error(), renamed) {
				t.Errorf("want %s refused naming %s, got %v", old, renamed, err)
			}
		})
		t.Run("env "+old, func(t *testing.T) {
			viper.Set(flagConfig, "")
			variable := "CASAS_" + strings.ToUpper(envKey.Replace(old))
			t.Setenv(variable, "/somewhere")
			_, err := loadConfig()
			want := "CASAS_" + strings.ToUpper(envKey.Replace(renamed))
			if err == nil || !strings.Contains(err.Error(), variable) || !strings.Contains(err.Error(), want) {
				t.Errorf("want %s refused naming %s, got %v", variable, want, err)
			}
		})
	}
}

// An old flag is an unknown flag, and the error says which flag replaced it.
func TestRenamedFlagNamesTheNewFlag(t *testing.T) {
	// Cobra applies the flag error function in Execute, after ParseFlags.
	err := StartCmd.ParseFlags([]string{"--jobs.storage.dir.path", "/x"})
	if err != nil {
		err = StartCmd.FlagErrorFunc()(StartCmd, err)
	}
	if err == nil || !strings.Contains(err.Error(), "--jobs.state-dir") {
		t.Errorf("want the new flag named, got %v", err)
	}
}

// The HARD BREAK for a key removed without replacement (global.tls.ca,
// mutual TLS): refused in the file, as a CASAS_* variable and as a flag,
// on every command, and each message says that mutual TLS went.
func TestRemovedKeysAreRefusedWithTheReason(t *testing.T) {
	initConfig()
	const reason = "mutual TLS is no longer supported"
	t.Run("file", func(t *testing.T) {
		configFile(t, "global:\n  tls:\n    ca: /ca.pem\n")
		_, err := loadConfig()
		if err == nil || !strings.Contains(err.Error(), "global.tls.ca is removed") || !strings.Contains(err.Error(), reason) {
			t.Errorf("want global.tls.ca refused with the reason, got %v", err)
		}
	})
	t.Run("env", func(t *testing.T) {
		viper.Set(flagConfig, "")
		t.Setenv("CASAS_GLOBAL_TLS_CA", "/ca.pem")
		_, err := loadConfig()
		if err == nil || !strings.Contains(err.Error(), "CASAS_GLOBAL_TLS_CA is removed") || !strings.Contains(err.Error(), reason) {
			t.Errorf("want CASAS_GLOBAL_TLS_CA refused with the reason, got %v", err)
		}
	})
	for _, cmd := range []*cobra.Command{StartCmd, RootCmd} {
		t.Run("flag on "+cmd.Name(), func(t *testing.T) {
			err := cmd.ParseFlags([]string{"--global.tls.ca", "/ca.pem"})
			if err != nil {
				err = cmd.FlagErrorFunc()(cmd, err)
			}
			if err == nil || !strings.Contains(err.Error(), "--global.tls.ca") || !strings.Contains(err.Error(), reason) {
				t.Errorf("want --global.tls.ca refused with the reason, got %v", err)
			}
		})
	}
}

// The new plain directories and the link lifetimes reach the tree.
func TestLoadConfigReadsDirsAndLinkSettings(t *testing.T) {
	initConfig()
	t.Setenv("CASAS_AUTH_STATE_DIR", "/env/auth")
	configFile(t, `
jobs:
  state-dir: /data/jobs
relay:
  state-dir: /data/relay
client:
  content-dir: /app/dist
docs:
  content-dir: /app/docs
artifacts:
  write-link-ttl: 2h
  link-key-previous: /keys/artifacts-old
world:
  read-link-ttl: 30m
`)
	t.Setenv("CASAS_WORLD_LINK_KEY", "/env/world-link-key")
	t.Setenv("CASAS_WORLD_LINK_KEY_PREVIOUS", "/env/world-link-key-old")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	got := []string{cfg.Jobs.StateDir, cfg.Relay.StateDir, cfg.Client.ContentDir, cfg.Docs.ContentDir, cfg.Auth.StateDir}
	want := []string{"/data/jobs", "/data/relay", "/app/dist", "/app/docs", "/env/auth"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("dir %d = %q, want %q", i, got[i], want[i])
		}
	}
	if cfg.Artifacts.WriteLinkTTL != 2*time.Hour || cfg.Artifacts.ReadLinkTTL != 15*time.Minute {
		t.Errorf("link ttls = %v / %v, want 2h from the file and the 15m default", cfg.Artifacts.WriteLinkTTL, cfg.Artifacts.ReadLinkTTL)
	}
	if cfg.World.ReadLinkTTL != 30*time.Minute || cfg.World.LinkKey != "/env/world-link-key" {
		t.Errorf("world links = %v, %q; want 30m from the file and the key from the environment", cfg.World.ReadLinkTTL, cfg.World.LinkKey)
	}
	if cfg.World.LinkKeyPrevious != "/env/world-link-key-old" || cfg.Artifacts.LinkKeyPrevious != "/keys/artifacts-old" {
		t.Errorf("previous link keys = %q, %q; want them from the environment and the file", cfg.World.LinkKeyPrevious, cfg.Artifacts.LinkKeyPrevious)
	}
}

// `type` is required for s3 and never inferred: the flag default is dir, an
// s3 block beside it is refused, and the dir.path flag default does not
// count as a dir block beside type s3 — a SET path does.
func TestLoadConfigObjectStorageType(t *testing.T) {
	initConfig()
	validate := func(t *testing.T) error {
		t.Helper()
		cfg, err := loadConfig()
		if err != nil {
			return err
		}
		return cfg.World.Storage.Validate("world")
	}
	const s3Block = `
world:
  storage:
%s    s3:
      flavour: ceph
      endpoint: https://objects.example
      bucket: worlds
`
	cases := []struct {
		name, file, wantErr string
	}{
		{"defaults are dir", "", ""},
		{"s3 block without type", fmt.Sprintf(s3Block, ""), "set world.storage.type: s3"},
		{"s3 with type, default path ignored", fmt.Sprintf(s3Block, "    type: s3\n"), ""},
		{"s3 with type and a set path", fmt.Sprintf(s3Block, "    type: s3\n    dir:\n      path: /data/worlds\n"), "world.storage.dir is set beside"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			configFile(t, c.file+"\n")
			err := validate(t)
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("want error containing %q, got %v", c.wantErr, err)
			}
		})
	}

	// The s3 block's keys reach the tree as CASAS_* variables too.
	t.Run("s3 from the environment", func(t *testing.T) {
		viper.Set(flagConfig, "")
		t.Setenv("CASAS_WORLD_STORAGE_TYPE", "s3")
		t.Setenv("CASAS_WORLD_STORAGE_S3_FLAVOUR", "aws")
		t.Setenv("CASAS_WORLD_STORAGE_S3_REGION", "eu-central-2")
		t.Setenv("CASAS_WORLD_STORAGE_S3_BUCKET", "worlds")
		if err := validate(t); err != nil {
			t.Fatalf("want the valid block from the environment accepted, got %v", err)
		}
	})
}

// A list from the environment is one comma-separated string, as the chart
// sets global.peers; a peer that is no http(s) URL refuses the start.
func TestLoadConfigReadsThePeers(t *testing.T) {
	initConfig()
	viper.Set(flagConfig, "")
	t.Setenv("CASAS_GLOBAL_PEERS", "http://casas-relay:8080,http://casas-artifacts:8080")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Global.Peers) != 2 || cfg.Global.Peers[1] != "http://casas-artifacts:8080" {
		t.Errorf("peers = %q, want the two", cfg.Global.Peers)
	}
	t.Setenv("CASAS_GLOBAL_PEERS", "casas-relay:8080")
	if _, err := loadConfig(); err == nil {
		t.Error("a peer without a scheme was accepted")
	}
}
