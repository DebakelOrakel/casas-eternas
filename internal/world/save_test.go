package world

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

// buildSave assembles a minimal .zip in the shape the client writes.
func buildSave(t *testing.T, yaml string, preview []byte, extra map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	add := func(name string, data []byte) {
		f, err := w.Create(name)
		if err != nil {
			t.Fatalf("creating %s: %v", name, err)
		}
		if _, err := f.Write(data); err != nil {
			t.Fatalf("writing %s: %v", name, err)
		}
	}
	if yaml != "" {
		add("world.yaml", []byte(yaml))
	}
	if preview != nil {
		add("preview.png", preview)
	}
	for name, data := range extra {
		add(name, data)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("closing zip: %v", err)
	}
	return buf.Bytes()
}

const sampleUID = "9f2c1b4e-7a30-4d55-8c11-2b6e5d0a1f83"

func sampleYAML() string {
	return strings.Join([]string{
		"apiVersion: casas-eternas/v1alpha1",
		"kind: FlatWorld",
		"metadata:",
		"  name: alpha",
		"  uid: " + sampleUID,
		"spec:",
		`  seed: "alpha"`,
		"  genesis:",
		"    water: 12",
		"  erosion:",
		"    erosionStrength: 100",
		"status:",
		"  erosionRun: 3",
		"  revision: 7",
		"",
	}, "\n")
}

func TestReadYAMLValueFollowsThePath(t *testing.T) {
	yaml := sampleYAML()
	cases := []struct{ path, want string }{
		{"metadata.name", "alpha"},
		{"metadata.uid", sampleUID},
		{"spec.seed", "alpha"},       // quoted; quotes must come off
		{"spec.genesis.water", "12"}, // three levels deep
		{"status.erosionRun", "3"},
		{"status.revision", "7"},
	}
	for _, c := range cases {
		got, ok := readYAMLValue(yaml, c.path)
		if !ok || got != c.want {
			t.Errorf("%s = %q (ok=%v), want %q", c.path, got, ok, c.want)
		}
	}
}

// The bug the client already had once: matching the LEAF name anywhere in the
// document. `seed` exists only under `spec`, so a leaf match would find it at
// the bare path and every world would silently share one label.
func TestReadYAMLValueRejectsLeafOnlyMatches(t *testing.T) {
	yaml := sampleYAML()
	for _, path := range []string{"seed", "uid", "name", "water", "genesis.water", "spec.water"} {
		if got, ok := readYAMLValue(yaml, path); ok {
			t.Errorf("%s resolved to %q; only full paths may match", path, got)
		}
	}
}

// Two groups sharing a leaf name must not collapse into each other.
func TestReadYAMLValueDistinguishesSharedLeafNames(t *testing.T) {
	yaml := strings.Join([]string{
		"spec:",
		"  erosion:",
		"    strength: 100",
		"  climate:",
		"    strength: 42",
		"",
	}, "\n")
	if got, _ := readYAMLValue(yaml, "spec.erosion.strength"); got != "100" {
		t.Errorf("erosion.strength = %q, want 100", got)
	}
	if got, _ := readYAMLValue(yaml, "spec.climate.strength"); got != "42" {
		t.Errorf("climate.strength = %q, want 42", got)
	}
}

func TestReadYAMLValueSurvivesJunk(t *testing.T) {
	// A group header carries no value and must not be returned as one; and a
	// malformed document must yield "absent", never a panic.
	if _, ok := readYAMLValue(sampleYAML(), "metadata"); ok {
		t.Error("a group header should not resolve to a value")
	}
	for _, junk := range []string{"", "not yaml at all", ":::", "\x00\x01", strings.Repeat("a", 5000)} {
		if _, ok := readYAMLValue(junk, "metadata.uid"); ok {
			t.Errorf("junk %q unexpectedly resolved", junk[:min(len(junk), 12)])
		}
	}
}

func TestInspectSaveReadsMetadataAndPreview(t *testing.T) {
	preview := []byte("\x89PNG\r\n\x1a\n-pretend-this-is-a-thumbnail")
	data := buildSave(t, sampleYAML(), preview, map[string][]byte{
		// The bulk of a real save, which the server must ignore entirely.
		"elevation.f32": bytes.Repeat([]byte{1, 2, 3, 4}, 1024),
		"state.json":    []byte(`{"epoch":90}`),
	})
	info, err := inspectSave(data)
	if err != nil {
		t.Fatalf("inspectSave: %v", err)
	}
	if info.UID != sampleUID {
		t.Errorf("uid = %q", info.UID)
	}
	if info.Name != "alpha" {
		t.Errorf("name = %q", info.Name)
	}
	if info.Revision != 7 || info.ErosionRun != 3 {
		t.Errorf("revision/erosionRun = %d/%d, want 7/3", info.Revision, info.ErosionRun)
	}
	if !bytes.Equal(info.Preview, preview) {
		t.Error("preview not extracted verbatim")
	}
}

// A save without metadata.uid is refused rather than assigned one: the client
// mints or derives it, and a server that invented its own would let the same
// world enter the store twice under two ids.
func TestInspectSaveRequiresUID(t *testing.T) {
	yaml := strings.Join([]string{"metadata:", "  name: alpha", "status:", "  erosionRun: 1", ""}, "\n")
	if _, err := inspectSave(buildSave(t, yaml, nil, nil)); err == nil {
		t.Fatal("a save with no metadata.uid must be refused")
	}
}

func TestInspectSaveRejectsUnusableArchives(t *testing.T) {
	if _, err := inspectSave([]byte("this is not a zip")); err == nil {
		t.Error("garbage bytes must not parse as a save")
	}
	if _, err := inspectSave(buildSave(t, "", nil, map[string][]byte{"elevation.f32": {1}})); err == nil {
		t.Error("an archive without world.yaml must be refused")
	}
}

// A save is still valid without a usable preview — the listing simply shows no
// thumbnail. An oversized entry must not take the whole upload down with it.
func TestInspectSaveToleratesAnUnusablePreview(t *testing.T) {
	huge := bytes.Repeat([]byte{0}, previewLimit+1)
	info, err := inspectSave(buildSave(t, sampleYAML(), huge, nil))
	if err != nil {
		t.Fatalf("an oversized preview must not fail the save: %v", err)
	}
	if len(info.Preview) != 0 {
		t.Errorf("oversized preview should be dropped, got %d bytes", len(info.Preview))
	}
	if info.UID != sampleUID {
		t.Error("metadata should still have been read")
	}
}
