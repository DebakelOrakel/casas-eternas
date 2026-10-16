package blob

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Fixes after the review of 2026-10-16: a link is bound to its module, the
// gate's predicate checks the path the router routes, and a previous key
// verifies during a key change-over.

// L2: the gate's predicate (Signed) and the router must see the same path.
// The router matches the ESCAPED path, so `blob%2F<uid>` is one segment
// there (the PUT route of /v1/artifacts/{uid}/{name...}) while the decoded
// path looks like a link: such a request is not a signed one.
func TestSignedRefusesAnEscapedPath(t *testing.T) {
	artifacts := newSigner(t, time.Now(), keyA)
	put, err := artifacts.Sign(http.MethodPut, "a754f0db-ff5c-4b45-9f2c-1b4e7a30d001/meta.json", time.Minute, 3)
	if err != nil {
		t.Fatal(err)
	}
	_, query, _ := strings.Cut(put.URL, "?")
	if !artifacts.Signed(httptest.NewRequest(http.MethodPut, put.URL, nil)) {
		t.Fatal("the link itself is not signed")
	}
	escaped := "/v1/artifacts/blob%2Fa754f0db-ff5c-4b45-9f2c-1b4e7a30d001/meta.json?" + query
	if artifacts.Signed(httptest.NewRequest(http.MethodPut, escaped, nil)) {
		t.Error("an escaped artifacts path passes as a signed link")
	}

	world, err := NewLinkSigner("/v1/worlds/", 1<<20, keyA)
	if err != nil {
		t.Fatal(err)
	}
	get, err := world.Sign(http.MethodGet, "9f2c1b4e-7a30-4d55-8c11-2b6e5d0a1f83/rev/1/world.zip", time.Minute, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, query, _ = strings.Cut(get.URL, "?")
	escaped = "/v1/worlds/9f2c1b4e-7a30-4d55-8c11-2b6e5d0a1f83%2Frev%2F1%2Fworld.zip?" + query
	if world.Signed(httptest.NewRequest(http.MethodGet, escaped, nil)) {
		t.Error("an escaped world path passes as a signed link")
	}
	if !world.Signed(httptest.NewRequest(http.MethodGet, get.URL, nil)) {
		t.Error("the world link itself is not signed")
	}
}

// L3: a link verifies only under the base it was signed for. The world
// and the artifacts modules may be given the same key file; a link of one
// must not open the other.
func TestALinkIsBoundToItsBase(t *testing.T) {
	now := time.Now()
	artifacts := newSigner(t, now, keyA)
	world, err := NewLinkSigner("/v1/worlds/", 1<<20, keyA)
	if err != nil {
		t.Fatal(err)
	}
	world.now = func() time.Time { return now }
	link, err := artifacts.Sign(http.MethodGet, "9f2c1b4e-7a30-4d55-8c11-2b6e5d0a1f83/rev/1/world.zip", time.Minute, 0)
	if err != nil {
		t.Fatal(err)
	}
	key, q := splitLink(t, link)
	if _, err := artifacts.Verify(http.MethodGet, key, q); err != nil {
		t.Fatalf("at its own base: %v", err)
	}
	if _, err := world.Verify(http.MethodGet, key, q); !errors.Is(err, ErrLinkInvalid) {
		t.Errorf("an artifacts link at the world base = %v, want ErrLinkInvalid", err)
	}
	moved := strings.Replace(link.URL, "/v1/artifacts/blob/", "/v1/worlds/", 1)
	if world.Signed(httptest.NewRequest(http.MethodGet, moved, nil)) {
		t.Error("the gate takes an artifacts link at the world base")
	}
}

// L4: the previous key of a change-over (<module>.link-key-previous): unset
// is no key, a file is read as link-key is, a set path that cannot be read
// is an error.
func TestReadPreviousLinkKey(t *testing.T) {
	if key, err := ReadPreviousLinkKey(""); err != nil || key != nil {
		t.Errorf("unset = %d bytes, %v; want none", len(key), err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "previous")
	if err := os.WriteFile(path, []byte(strings.Repeat("p", 32)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if key, err := ReadPreviousLinkKey(path); err != nil || string(key) != strings.Repeat("p", 32) {
		t.Errorf("file = %q, %v", key, err)
	}
	if _, err := ReadPreviousLinkKey(filepath.Join(dir, "missing")); err == nil {
		t.Error("a missing file is no error")
	}
	short := filepath.Join(dir, "short")
	_ = os.WriteFile(short, []byte("short"), 0o600)
	if _, err := ReadPreviousLinkKey(short); err == nil {
		t.Error("a short key is no error")
	}
}
