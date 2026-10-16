package world

import (
	"context"
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

// The reads by link (DEC-0038, 2026-10-16): the zip and the preview answer
// 302 to a link after the access check; on dir the module serves that link
// itself under LinkBase; the meta stays a direct answer.

// linkedWorld makes a module on a Dir with one world and returns the link
// a read of its zip is redirected to.
func linkedWorld(t *testing.T) (*Module, *http.ServeMux, string) {
	t.Helper()
	m, mux := newTestModule(t)
	if got := upload(t, mux, sampleUID, "").Code; got != http.StatusCreated {
		t.Fatalf("create = %d", got)
	}
	redirect := do(mux, http.MethodGet, "/v1/worlds/"+sampleUID, nil, nil)
	if redirect.Code != http.StatusFound {
		t.Fatalf("read = %d, want 302", redirect.Code)
	}
	return m, mux, redirect.Header().Get("Location")
}

func TestDirLinkServesTheZip(t *testing.T) {
	m, mux, link := linkedWorld(t)
	u, err := url.Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	if u.Host != "" || u.Path != LinkBase+sampleUID+"/rev/1/world.zip" || u.Query().Get("sig") == "" || u.Query().Get("exp") == "" {
		t.Fatalf("link %q: want a same-origin signed path to the revision's zip", link)
	}
	// The read lifetime is the module's (15 minutes here).
	exp, _ := strconv.ParseInt(u.Query().Get("exp"), 10, 64)
	if left := time.Until(time.Unix(exp, 0)); left < 14*time.Minute || left > 15*time.Minute {
		t.Errorf("link lives %v, want about 15m", left)
	}
	want, _, err := m.store.ReadCurrent(context.Background(), sampleUID)
	if err != nil {
		t.Fatal(err)
	}
	// No credentials: the link is the right.
	response := do(mux, http.MethodGet, link, nil, nil)
	if response.Code != http.StatusOK || response.Body.String() != string(want) || response.Header().Get("Content-Length") != strconv.Itoa(len(want)) {
		t.Errorf("link = %d, %d bytes (length %q)", response.Code, response.Body.Len(), response.Header().Get("Content-Length"))
	}
	if !m.SignedRequest(httptest.NewRequest(http.MethodGet, link, nil)) || !m.SignedRequest(httptest.NewRequest(http.MethodHead, link, nil)) {
		t.Error("the gate predicate refuses a valid link")
	}
	// The preview by link too, with its type.
	redirect := do(mux, http.MethodGet, "/v1/worlds/"+sampleUID+"/preview.png", nil, nil)
	preview := do(mux, http.MethodGet, redirect.Header().Get("Location"), nil, nil)
	if redirect.Code != http.StatusFound || preview.Code != http.StatusOK || preview.Body.String() != "PNG" || preview.Header().Get("Content-Type") != "image/png" {
		t.Errorf("preview = %d, link %d %q (%s)", redirect.Code, preview.Code, preview.Body, preview.Header().Get("Content-Type"))
	}
}

// What a link that is not ours or no longer valid gets: 403 for a link that
// does not verify, whatever is wrong with it. The gate predicate lets
// through only links that we signed.
func TestDirLinkRefusals(t *testing.T) {
	m, mux, link := linkedWorld(t)
	u, _ := url.Parse(link)
	q := u.Query()
	with := func(path string, change func(url.Values)) string {
		v := url.Values{}
		for k, vs := range q {
			v[k] = append([]string(nil), vs...)
		}
		change(v)
		return path + "?" + v.Encode()
	}
	cases := []struct {
		name   string
		target string
	}{
		{"changed signature", with(u.Path, func(v url.Values) {
			sig := []byte(v.Get("sig"))
			if sig[0] == 'A' {
				sig[0] = 'B'
			} else {
				sig[0] = 'A'
			}
			v.Set("sig", string(sig))
		})},
		{"later expiry", with(u.Path, func(v url.Values) {
			exp, _ := strconv.ParseInt(v.Get("exp"), 10, 64)
			v.Set("exp", strconv.FormatInt(exp+3600, 10))
		})},
		{"another object", with(strings.Replace(u.Path, "world.zip", "meta.json", 1), func(url.Values) {})},
		{"another revision", with(strings.Replace(u.Path, "/rev/1/", "/rev/2/", 1), func(url.Values) {})},
		{"no signature", with(u.Path, func(v url.Values) { v.Del("sig") })},
		// Path traversal: the mux hands the unescaped value to the route,
		// and the key rule refuses it before any signature is compared.
		{"traversal in the name", with(LinkBase+sampleUID+"/rev/1/%2e%2e", func(url.Values) {})},
		{"escaped slashes", with(LinkBase+sampleUID+"/rev/1/%2e%2e%2f%2e%2e%2fmeta.json", func(url.Values) {})},
	}
	for _, c := range cases {
		if got := do(mux, http.MethodGet, c.target, nil, nil).Code; got != http.StatusForbidden {
			t.Errorf("%s: %s = %d, want 403", c.name, c.target, got)
		}
		if m.SignedRequest(httptest.NewRequest(http.MethodGet, c.target, nil)) {
			t.Errorf("%s: the gate predicate lets it through", c.name)
		}
	}
	// Only reads: a PUT or a DELETE with the link's query is no link.
	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		if m.SignedRequest(httptest.NewRequest(method, link, nil)) {
			t.Errorf("the gate predicate lets a %s through", method)
		}
	}
	// A route that is not a link is not one, whatever its query.
	if m.SignedRequest(httptest.NewRequest(http.MethodGet, "/v1/worlds/"+sampleUID+"?"+q.Encode(), nil)) {
		t.Error("the gate predicate lets another route through")
	}
}

func TestDirLinkExpires(t *testing.T) {
	m, mux, _ := linkedWorld(t)
	link, _, err := m.store.ZipLink(context.Background(), sampleUID, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Until(link.Expires) + 20*time.Millisecond)
	if got := do(mux, http.MethodGet, link.URL, nil, nil).Code; got != http.StatusGone {
		t.Errorf("expired link = %d, want 410", got)
	}
	// Ours, so the gate lets it reach the route and its 410, not a 401
	// that would end a browser's session.
	if !m.SignedRequest(httptest.NewRequest(http.MethodGet, link.URL, nil)) {
		t.Error("the gate predicate refuses an expired link of ours")
	}
}

// A link to a revision that was pruned after it was signed answers 404.
func TestDirLinkToAPrunedRevision(t *testing.T) {
	_, mux, link := linkedWorld(t)
	if got := do(mux, http.MethodDelete, "/v1/worlds/"+sampleUID, nil, nil).Code; got != http.StatusNoContent {
		t.Fatalf("delete = %d", got)
	}
	if got := do(mux, http.MethodGet, link, nil, nil).Code; got != http.StatusNotFound {
		t.Errorf("link to a deleted world = %d, want 404", got)
	}
}

// The access check comes before the link: a stranger gets the 404 of a
// private world and no Location (TestPrivateWorldsAreInvisibleAndGrantsOpenThem
// and TestATemplateIsReadableByEveryone hold the levels); a world without
// a preview answers 404, not a link to nothing.
func TestNoLinkWithoutTheRight(t *testing.T) {
	f := newTemplateFixture(t)
	for _, path := range []string{"/v1/worlds/" + sampleUID, "/v1/worlds/" + sampleUID + "/preview.png"} {
		got := f.as(http.MethodGet, path, f.grace, nil)
		if got.Code != http.StatusNotFound || got.Header().Get("Location") != "" {
			t.Errorf("stranger GET %s = %d to %q, want 404 and no link", path, got.Code, got.Header().Get("Location"))
		}
		got = f.as(http.MethodGet, path, "", nil)
		if got.Code != http.StatusUnauthorized || got.Header().Get("Location") != "" {
			t.Errorf("anonymous GET %s = %d to %q, want 401 and no link", path, got.Code, got.Header().Get("Location"))
		}
	}
	_, mux := newTestModule(t)
	data := buildSave(t, sampleYAML(), nil, nil)
	if got := do(mux, http.MethodPut, "/v1/worlds/"+sampleUID, data, nil).Code; got != http.StatusCreated {
		t.Fatalf("create = %d", got)
	}
	if got := do(mux, http.MethodGet, "/v1/worlds/"+sampleUID+"/preview.png", nil, nil); got.Code != http.StatusNotFound || got.Header().Get("Location") != "" {
		t.Errorf("preview of a world without one = %d to %q, want 404", got.Code, got.Header().Get("Location"))
	}
}

// On s3 the zip and the preview answer 302 to a presigned GET on the
// provider, so the bytes do not pass through the server; the bucket gets
// the CORS rule of the read links; there is no link route of its own.
func TestS3ReadRedirectsToAPresignedGet(t *testing.T) {
	fake, srv := blobtest.NewS3(t, blobtest.Options{KeyID: "AKIDFAKE"})
	bucket := openFakeBucket(t, srv, blob.FlavourCeph)
	if cors := fake.CORS("worlds"); !strings.Contains(cors, "<AllowedOrigin>*</AllowedOrigin>") || !strings.Contains(cors, "<AllowedHeader>*</AllowedHeader>") {
		t.Errorf("the bucket's CORS rule = %q, want the read-link rule", cors)
	}
	m, mux := adminModule(newTestStoreOn(t, bucket, 0))
	if m.signer != nil {
		t.Error("an s3 module signs links of its own")
	}
	if got := upload(t, mux, sampleUID, "").Code; got != http.StatusCreated {
		t.Fatalf("create = %d", got)
	}
	for path, want := range map[string]string{
		"/v1/worlds/" + sampleUID:                  "/worlds/test/run/" + sampleUID + "/rev/1/world.zip?",
		"/v1/worlds/" + sampleUID + "/preview.png": "/worlds/test/run/" + sampleUID + "/rev/1/preview.png?",
	} {
		redirect := do(mux, http.MethodGet, path, nil, nil)
		location := redirect.Header().Get("Location")
		if redirect.Code != http.StatusFound || !strings.HasPrefix(location, "https://objects.example"+want) || !strings.Contains(location, "X-Amz-Signature=") {
			t.Errorf("GET %s = %d to %q, want 302 to a presigned GET", path, redirect.Code, location)
		}
		if !strings.Contains(location, "X-Amz-Expires=900") {
			t.Errorf("presigned GET %q: want the read lifetime of 15m (900 s)", location)
		}
	}
	if code, body := follow(t, mux, bucket, "/v1/worlds/"+sampleUID+"/preview.png"); code != http.StatusOK || string(body) != "PNG" {
		t.Errorf("following the preview link = %d %q", code, body)
	}
	// The 304 is the server's, before any link.
	if got := do(mux, http.MethodGet, "/v1/worlds/"+sampleUID, nil, map[string]string{"If-None-Match": `"1"`}); got.Code != http.StatusNotModified || got.Header().Get("Location") != "" {
		t.Errorf("If-None-Match of the revision = %d to %q, want 304", got.Code, got.Header().Get("Location"))
	}
	// No link route on s3.
	if code := do(mux, http.MethodGet, LinkBase+sampleUID+"/rev/1/world.zip?exp=1&sig=x", nil, nil).Code; code == http.StatusOK {
		t.Errorf("an s3 module serves dir links: %d", code)
	}
	if m.SignedRequest(httptest.NewRequest(http.MethodGet, LinkBase+sampleUID+"/rev/1/world.zip?exp=1&sig=x", nil)) {
		t.Error("an s3 module's gate predicate lets a request through")
	}
}

// New refuses a read lifetime outside (0, 7 days], as artifacts does.
func TestNewChecksTheReadLinkLifetime(t *testing.T) {
	for _, ttl := range []time.Duration{0, -time.Second, blob.MaxLinkTTL + time.Second} {
		cfg := config.Config{}
		cfg.World.ReadLinkTTL = ttl
		_, err := New(context.Background(), Config{All: cfg, Bucket: testDir(t, t.TempDir()), Identity: identity.NewResolver(config.AuthNone, nil)})
		if err == nil || !strings.Contains(err.Error(), "world.read-link-ttl") {
			t.Errorf("read-link-ttl %v: err %v, want a refusal naming the key", ttl, err)
		}
	}
	cfg := config.Config{}
	cfg.World.ReadLinkTTL = time.Minute
	m, err := New(context.Background(), Config{All: cfg, Bucket: testDir(t, t.TempDir()), Identity: identity.NewResolver(config.AuthNone, nil)})
	if err != nil || m.signer == nil || m.readTTL != time.Minute {
		t.Errorf("New = %v; want a module with the dir's signer and the lifetime", err)
	}
}
