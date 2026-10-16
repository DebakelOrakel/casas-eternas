package artifacts

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/blob"
	"github.com/DebakelOrakel/casas-eternas/internal/blob/blobtest"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
)

// The reads by link (DEC-0038, step 3): the module checks the right and
// answers 302 to a link; on dir it serves that link itself.

// linkedArtifact makes a module on a Dir with one artifact file and
// returns the link a read of it is redirected to.
func linkedArtifact(t *testing.T) (*Module, *http.ServeMux, string) {
	t.Helper()
	m, mux := newModule(t, openTestDir(t, t.TempDir()), identity.NewResolver(config.AuthNone, nil), adminWorlds())
	uid, _ := resolve(t, mux, true)
	if got := do(mux, http.MethodPut, "/v1/artifacts/"+uid+"/elevation.f32", "raster-bytes").Code; got != http.StatusNoContent {
		t.Fatalf("put = %d", got)
	}
	redirect := do(mux, http.MethodGet, "/v1/artifacts/"+uid+"/elevation.f32", "")
	if redirect.Code != http.StatusFound {
		t.Fatalf("read = %d, want 302", redirect.Code)
	}
	return m, mux, redirect.Header().Get("Location")
}

func TestDirLinkServesTheFile(t *testing.T) {
	m, mux, link := linkedArtifact(t)
	u, err := url.Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	if u.Host != "" || !strings.HasPrefix(u.Path, LinkBase) || u.Query().Get("sig") == "" || u.Query().Get("exp") == "" {
		t.Fatalf("link %q: want a same-origin signed path under %s", link, LinkBase)
	}
	// The read lifetime is the module's (15 minutes here).
	exp, _ := strconv.ParseInt(u.Query().Get("exp"), 10, 64)
	if left := time.Until(time.Unix(exp, 0)); left < 14*time.Minute || left > 15*time.Minute {
		t.Errorf("link lives %v, want about 15m", left)
	}
	// No credentials: the link is the right.
	response := do(mux, http.MethodGet, link, "")
	if response.Code != http.StatusOK || response.Body.String() != "raster-bytes" || response.Header().Get("Content-Length") != "12" {
		t.Errorf("link = %d %q (length %q)", response.Code, response.Body.String(), response.Header().Get("Content-Length"))
	}
	if !m.SignedRequest(httptest.NewRequest(http.MethodGet, link, nil)) {
		t.Error("the gate predicate refuses a valid link")
	}
}

// What a link that is not ours or no longer valid gets: 403 for a link that
// does not verify, whatever is wrong with it, and 410 only for one of ours
// that expired. The gate predicate lets through only links that we signed.
func TestDirLinkRefusals(t *testing.T) {
	m, mux, link := linkedArtifact(t)
	u, _ := url.Parse(link)
	q := u.Query()
	key := strings.TrimPrefix(u.Path, LinkBase)
	with := func(path string, change func(url.Values)) string {
		v := url.Values{}
		for k, vs := range q {
			v[k] = append([]string(nil), vs...)
		}
		change(v)
		return path + "?" + v.Encode()
	}
	otherKey := strings.Replace(u.Path, "elevation.f32", "meta.json", 1)
	cases := []struct {
		name   string
		target string
		want   int
	}{
		{"changed signature", with(u.Path, func(v url.Values) {
			sig := []byte(v.Get("sig"))
			if sig[0] == 'A' {
				sig[0] = 'B'
			} else {
				sig[0] = 'A'
			}
			v.Set("sig", string(sig))
		}), http.StatusForbidden},
		{"later expiry", with(u.Path, func(v url.Values) {
			exp, _ := strconv.ParseInt(v.Get("exp"), 10, 64)
			v.Set("exp", strconv.FormatInt(exp+3600, 10))
		}), http.StatusForbidden},
		{"another key", with(otherKey, func(url.Values) {}), http.StatusForbidden},
		{"no signature", with(u.Path, func(v url.Values) { v.Del("sig") }), http.StatusForbidden},
		{"a length on a read link", with(u.Path, func(v url.Values) { v.Set("len", "12") }), http.StatusForbidden},
		// Path traversal: the mux hands the unescaped value to the route,
		// and the key rule refuses it before any signature is compared.
		{"traversal", with(LinkBase+key+"/%2e%2e/%2e%2e/%2e%2e/etc/passwd", func(url.Values) {}), http.StatusForbidden},
		{"traversal in the key", with(LinkBase+"%2e%2e/"+key, func(url.Values) {}), http.StatusForbidden},
	}
	for _, c := range cases {
		if got := do(mux, http.MethodGet, c.target, "").Code; got != c.want {
			t.Errorf("%s: %s = %d, want %d", c.name, c.target, got, c.want)
		}
		if m.SignedRequest(httptest.NewRequest(http.MethodGet, c.target, nil)) {
			t.Errorf("%s: the gate predicate lets it through", c.name)
		}
	}
	// A PUT to the link path is no read: the gate does not let it pass.
	if m.SignedRequest(httptest.NewRequest(http.MethodPut, link, nil)) {
		t.Error("the gate predicate lets a PUT through")
	}
	// A route that is not a link is not one, whatever its query.
	if m.SignedRequest(httptest.NewRequest(http.MethodGet, "/v1/artifacts?"+q.Encode(), nil)) {
		t.Error("the gate predicate lets another route through")
	}
}

func TestDirLinkExpires(t *testing.T) {
	m, mux, _ := linkedArtifact(t)
	uid, _ := resolve(t, mux, false)
	link, err := m.store.Link(context.Background(), uid, "elevation.f32", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Until(link.Expires) + 20*time.Millisecond)
	if got := do(mux, http.MethodGet, link.URL, "").Code; got != http.StatusGone {
		t.Errorf("expired link = %d, want 410", got)
	}
	// Ours, so the gate lets it reach the route and its 410, not a 401
	// that would end a browser's session.
	if !m.SignedRequest(httptest.NewRequest(http.MethodGet, link.URL, nil)) {
		t.Error("the gate predicate refuses an expired link of ours")
	}
}

// A link to an object that went after it was signed answers 404.
func TestDirLinkToARemovedFile(t *testing.T) {
	_, mux, link := linkedArtifact(t)
	uid, _ := resolve(t, mux, false)
	if got := do(mux, http.MethodDelete, "/v1/artifacts/"+uid, "").Code; got != http.StatusNoContent {
		t.Fatalf("delete = %d", got)
	}
	if got := do(mux, http.MethodGet, link, "").Code; got != http.StatusNotFound {
		t.Errorf("link to a removed file = %d, want 404", got)
	}
}

// openFakeS3 serves `objects` from the shared fake provider
// (internal/blob/blobtest) over TLS and opens the bucket "artifacts" with
// the prefix "run" on it. TLS, as every real provider: over plain HTTP the
// SDK must hash the payload and so needs a seekable body, which an upload
// is not; over HTTPS it sends it unsigned (aws-sdk-go-v2,
// v4.ComputePayloadSHA256).
func openFakeS3(t *testing.T, objects map[string][]byte) (*blobtest.S3, *httptest.Server, blob.Bucket) {
	t.Helper()
	fake, srv := blobtest.NewS3(t, blobtest.Options{KeyID: "AKIDFAKE", TLS: true})
	fake.CreateBucket("artifacts")
	for key, data := range objects {
		fake.PutObject("artifacts", key, data)
	}
	access1, secret := blobtest.KeyFiles(t, "AKIDFAKE")
	bucket, err := blob.OpenS3(context.Background(), blob.S3Config{
		Flavour: blob.FlavourCeph, Endpoint: srv.URL, Bucket: "artifacts", Prefix: "run",
		AccessKeyFile: access1, SecretKeyFile: secret, HTTPClient: srv.Client(),
	}, BucketOptions())
	if err != nil {
		t.Fatal(err)
	}
	return fake, srv, bucket
}

// On s3 the module answers a read with a 302 to a presigned GET on the
// provider, so the bytes do not pass through it; the index is built from
// the provider's listing; there is no link route of its own.
func TestS3ReadRedirectsToAPresignedGet(t *testing.T) {
	key := testKey()
	const uid = "0001f5f4-4b3b-4f3d-861f-852b97080def"
	fake, srv, bucket := openFakeS3(t, map[string][]byte{
		// An artifact already in the bucket, under the prefix.
		"run/" + uid + "/meta.json":     []byte(metaFor(key, "Ätna")),
		"run/" + uid + "/elevation.u16": []byte("raster-bytes"),
	})
	if fake.CORS("artifacts") == "" {
		t.Error("the bucket's CORS rule was not set")
	}
	m, mux := newModule(t, bucket, identity.NewResolver(config.AuthNone, nil), adminWorlds())
	if m.signer != nil {
		t.Error("an s3 module signs links of its own")
	}

	body := `{"worldId":"` + key.WorldID + `","pipelineVersion":"` + key.PipelineVersion + `","stage":"` + key.Stage + `"}`
	if response := do(mux, http.MethodPost, "/v1/artifacts/resolve", body); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), uid) {
		t.Fatalf("resolve from the listing = %d %s", response.Code, response.Body)
	}
	redirect := do(mux, http.MethodGet, "/v1/artifacts/"+uid+"/elevation.u16", "")
	location := redirect.Header().Get("Location")
	if redirect.Code != http.StatusFound || !strings.HasPrefix(location, srv.URL+"/artifacts/run/"+uid+"/elevation.u16?") || !strings.Contains(location, "X-Amz-Signature=") {
		t.Fatalf("read = %d to %q, want 302 to a presigned GET on the provider", redirect.Code, location)
	}
	if !strings.Contains(location, "X-Amz-Expires=900") {
		t.Errorf("presigned GET %q: want the read lifetime of 15m (900 s)", location)
	}
	got, err := srv.Client().Get(location)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(got.Body)
	_ = got.Body.Close()
	if got.StatusCode != http.StatusOK || string(raw) != "raster-bytes" {
		t.Errorf("following the link = %d %q", got.StatusCode, raw)
	}
	// A file the index does not have is answered here, not by the provider.
	if code := do(mux, http.MethodGet, "/v1/artifacts/"+uid+"/rivers.f32", "").Code; code != http.StatusNotFound {
		t.Errorf("absent file = %d, want 404", code)
	}
	// Writes go through the server to the bucket, with their length.
	if code := do(mux, http.MethodPut, "/v1/artifacts/"+uid+"/rivers.f32", "rr").Code; code != http.StatusNoContent {
		t.Fatalf("put = %d", code)
	}
	if stored, _ := fake.Object("artifacts", "run/"+uid+"/rivers.f32"); string(stored) != "rr" {
		t.Errorf("stored object = %q", stored)
	}
	// No link route on s3.
	if code := do(mux, http.MethodGet, LinkBase+uid+"/rivers.f32?exp=1&sig=x", "").Code; code == http.StatusOK {
		t.Errorf("an s3 module serves dir links: %d", code)
	}
}
