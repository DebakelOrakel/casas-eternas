package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
// failed in the field: CASAS_BAKE_MAX_CONCURRENT=3 refused to start.
func TestLoadConfigDecodesNumbersFromTheEnvironment(t *testing.T) {
	initConfig()
	viper.Set(flagConfig, "")
	t.Setenv("CASAS_BAKE_MAX_CONCURRENT", "3")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Bake.MaxConcurrent != 3 {
		t.Errorf("max-concurrent = %d, want 3", cfg.Bake.MaxConcurrent)
	}

	t.Setenv("CASAS_BAKE_MAX_CONCURRENT", "many")
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
}
