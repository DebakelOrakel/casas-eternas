package config

import (
	"strings"
	"testing"
	"time"
)

// The union rules are what keeps a half-edited storage block from starting a
// server that quietly writes somewhere nobody meant.
func TestObjectStorageValidate(t *testing.T) {
	dir := &DirStorage{Path: "/tmp/x"}
	aws := &S3Storage{Flavour: FlavourAWS, Region: "eu-central-2", Bucket: "worlds"}
	ceph := &S3Storage{Flavour: FlavourCeph, Endpoint: "https://objects.example", Bucket: "worlds"}
	cases := []struct {
		name    string
		storage ObjectStorage
		wantErr string // empty = valid
	}{
		{"nothing configured", ObjectStorage{}, "type is required"},
		{"no type, only a dir block", ObjectStorage{Dir: dir}, "type is required"},
		{"no type, only an s3 block", ObjectStorage{S3: aws}, "type is required"},
		{"dir without path", ObjectStorage{Type: "dir", Dir: &DirStorage{}}, "needs"},
		{"dir with path", ObjectStorage{Type: "dir", Dir: dir}, ""},
		{"s3 block beside type dir", ObjectStorage{Type: "dir", Dir: dir, S3: aws}, "set world.storage.type: s3"},
		{"dir block beside type s3", ObjectStorage{Type: "s3", Dir: dir, S3: aws}, "world.storage.dir is set beside"},
		{"type s3 without a block", ObjectStorage{Type: "s3"}, "needs the world.storage.s3 block"},
		{"s3 without flavour", ObjectStorage{Type: "s3", S3: &S3Storage{Bucket: "b"}}, "flavour is required"},
		{"s3 unknown flavour", ObjectStorage{Type: "s3", S3: &S3Storage{Flavour: "garage", Bucket: "b"}}, "unknown flavour"},
		{"aws with endpoint", ObjectStorage{Type: "s3", S3: &S3Storage{Flavour: FlavourAWS, Region: "r", Endpoint: "https://x", Bucket: "b"}}, "not for flavour aws"},
		{"aws without region", ObjectStorage{Type: "s3", S3: &S3Storage{Flavour: FlavourAWS, Bucket: "b"}}, "region"},
		{"ceph without endpoint", ObjectStorage{Type: "s3", S3: &S3Storage{Flavour: FlavourCeph, Bucket: "b"}}, "endpoint"},
		{"s3 without bucket", ObjectStorage{Type: "s3", S3: &S3Storage{Flavour: FlavourCeph, Endpoint: "https://x"}}, "bucket is required"},
		{"half a key pair", ObjectStorage{Type: "s3", S3: &S3Storage{Flavour: FlavourCeph, Endpoint: "https://x", Bucket: "b", AccessKeyFile: "/k"}}, "together"},
		// A correct s3 block passes every check and then meets the backend
		// that is not there yet — the last message, not the first.
		{"valid aws, not built", ObjectStorage{Type: "s3", S3: aws}, "not implemented yet"},
		{"valid ceph, not built", ObjectStorage{Type: "s3", S3: ceph}, "not implemented yet"},
		{"unknown backend", ObjectStorage{Type: "gcs"}, "unknown backend"},
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
			// with two storage blocks produces an unattributable error.
			if !strings.Contains(err.Error(), "world.storage") {
				t.Errorf("error does not name the section: %v", err)
			}
		})
	}
}

// A state-dir is a plain directory; its message names the full key.
func TestRequireDir(t *testing.T) {
	if err := RequireDir("jobs.state-dir", "/tmp/jobs"); err != nil {
		t.Errorf("a set directory refused: %v", err)
	}
	if err := RequireDir("jobs.state-dir", ""); err == nil || !strings.Contains(err.Error(), "jobs.state-dir") {
		t.Errorf("want jobs.state-dir named, got %v", err)
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

	badTTL := valid
	badTTL.Artifacts.WriteLinkTTL = -time.Minute
	if err := badTTL.Validate(); err == nil || !strings.Contains(err.Error(), "artifacts.write-link-ttl") {
		t.Errorf("want artifacts.write-link-ttl named, got %v", err)
	}
}
