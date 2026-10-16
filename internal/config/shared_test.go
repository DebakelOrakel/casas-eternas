package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// H3 (review of 2026-10-16): the world store and the artifact store may not
// share a storage root. The artifact store's sweep and clear take what is
// not an artifact as junk, so worlds in its root would be deleted.
func TestSeparateStorageRefusesASharedRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "worlds", "deep"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "worlds"), filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	dir := func(path string) ObjectStorage { return ObjectStorage{Type: "dir", Dir: &DirStorage{Path: path}} }
	s3 := func(flavour, endpoint, bucket, prefix string) ObjectStorage {
		return ObjectStorage{Type: "s3", S3: &S3Storage{Flavour: flavour, Endpoint: endpoint, Bucket: bucket, Prefix: prefix}}
	}
	cases := []struct {
		name             string
		world, artifacts ObjectStorage
		shared           bool
	}{
		{"one directory", dir(filepath.Join(root, "worlds")), dir(filepath.Join(root, "worlds")), true},
		{"one directory, spelled two ways", dir(filepath.Join(root, "worlds")), dir(filepath.Join(root, "worlds", "..", "worlds") + "/"), true},
		{"one directory by a link", dir(filepath.Join(root, "worlds")), dir(filepath.Join(root, "alias")), true},
		{"artifacts inside the worlds", dir(filepath.Join(root, "worlds")), dir(filepath.Join(root, "worlds", "deep")), true},
		{"artifacts inside the worlds, not made yet", dir(filepath.Join(root, "worlds")), dir(filepath.Join(root, "worlds", "later", "artifacts")), true},
		{"worlds inside the artifacts", dir(filepath.Join(root, "worlds", "deep")), dir(filepath.Join(root, "worlds")), true},
		{"a relative path to the same directory", dir(filepath.Join(root, "worlds")), dir(relative(t, filepath.Join(root, "worlds"))), true},
		{"two directories", dir(filepath.Join(root, "worlds")), dir(filepath.Join(root, "artifacts")), false},
		{"a common start of the name only", dir(filepath.Join(root, "worlds")), dir(filepath.Join(root, "worlds-artifacts")), false},
		{"one bucket, one prefix", s3("aws", "", "b", "p"), s3("aws", "", "b", "p/"), true},
		{"one bucket, no prefix for one", s3("aws", "", "b", ""), s3("aws", "", "b", "artifacts"), true},
		{"one bucket, nested prefixes", s3("aws", "", "b", "x/worlds"), s3("aws", "", "b", "x"), true},
		{"one bucket, two prefixes", s3("aws", "", "b", "worlds"), s3("aws", "", "b", "artifacts"), false},
		{"one bucket, a common start of the prefix only", s3("aws", "", "b", "w"), s3("aws", "", "b", "w2"), false},
		{"two buckets", s3("aws", "", "worlds", ""), s3("aws", "", "artifacts", ""), false},
		{"two providers", s3("ceph", "https://a.example", "b", ""), s3("ceph", "https://b.example", "b", ""), false},
		{"one provider, its endpoint spelled two ways", s3("ceph", "https://A.example/", "b", ""), s3("ceph", "https://a.example", "b", ""), true},
		{"a directory and a bucket", dir(filepath.Join(root, "worlds")), s3("aws", "", "b", ""), false},
	}
	for _, c := range cases {
		err := SeparateStorage(c.world, c.artifacts)
		if c.shared {
			if err == nil || !strings.Contains(err.Error(), "world.storage") || !strings.Contains(err.Error(), "artifacts.storage") {
				t.Errorf("%s: %v, want a refusal that names both keys", c.name, err)
			}
		} else if err != nil {
			t.Errorf("%s: %v, want no refusal", c.name, err)
		}
	}
}

// relative is `path` relative to the working directory.
func relative(t *testing.T, path string) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	rel, err := filepath.Rel(wd, path)
	if err != nil {
		t.Fatal(err)
	}
	return rel
}
