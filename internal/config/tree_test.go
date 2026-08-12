package config

import (
	"strings"
	"testing"
)

// The union rules are what keeps a half-edited storage block from starting a
// server that quietly writes somewhere nobody meant.
func TestStorageValidate(t *testing.T) {
	cases := []struct {
		name    string
		storage Storage
		wantErr string // empty = valid
	}{
		{"nothing configured", Storage{}, "no backend"},
		{"dir without path", Storage{Type: "dir", Dir: &DirStorage{}}, "needs"},
		{"dir with path", Storage{Type: "dir", Dir: &DirStorage{Path: "/tmp/x"}}, ""},
		{"type inferred from block", Storage{Dir: &DirStorage{Path: "/tmp/x"}}, ""},
		{"unknown backend", Storage{Type: "s3"}, "unknown backend"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := c.storage.Validate("world")
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("want error containing %q, got %v", c.wantErr, err)
			}
			// Every message must name the owning section, or a split config
			// with three storage blocks produces an unattributable error.
			if !strings.Contains(err.Error(), "world.storage") {
				t.Errorf("error does not name the section: %v", err)
			}
		})
	}
}

func TestConfigValidate(t *testing.T) {
	valid := Config{}
	valid.Global.Listen = ":8080"
	valid.Global.Auth.Mode = string(DefaultAuthMode)
	if err := valid.Validate(); err != nil {
		t.Fatalf("minimal config should validate: %v", err)
	}

	badMode := valid
	badMode.Global.Auth.Mode = "passwrod"
	if err := badMode.Validate(); err == nil {
		t.Error("a typoed auth mode must refuse to start")
	}

	badCap := valid
	badCap.Artifacts.Cap = "fifty gigabytes"
	if err := badCap.Validate(); err == nil || !strings.Contains(err.Error(), "artifacts.cap") {
		t.Errorf("want artifacts.cap named, got %v", err)
	}
}
