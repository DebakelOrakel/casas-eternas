package blob

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeS3 stands in for an S3 provider, enough for the wiring: buckets,
// objects, ListObjectsV2 with pages of two, conditional PUT, versioning,
// CORS, and the not-found shapes. It does not check signatures; it checks
// that a request is signed with the access key id of the key file.
type fakeS3 struct {
	mu         sync.Mutex
	t          *testing.T
	buckets    map[string]bool
	objects    map[string][]byte // "<bucket>/<key>"
	versioning map[string]string
	cors       map[string]string
	created    []string // bodies of CreateBucket
	requests   []string // "METHOD host path?query"
	// moved: HeadBucket answers 301 with this region; forbidden: 403.
	moved, movedOptIn, forbidden string
	keyID                        string
}

func newFake(t *testing.T) (*fakeS3, *httptest.Server) {
	f := &fakeS3{
		t:          t,
		buckets:    map[string]bool{},
		objects:    map[string][]byte{},
		versioning: map[string]string{},
		cors:       map[string]string{},
		keyID:      "AKIDFAKE",
	}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeS3) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func xmlError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>fake</Message></Error>`, code)
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r.Method+" "+r.Host+" "+r.URL.RequestURI())
	q := r.URL.Query()
	presigned := q.Get("X-Amz-Signature") != ""
	auth := r.Header.Get("Authorization")
	if presigned {
		auth = q.Get("X-Amz-Credential")
	}
	if !strings.Contains(auth, f.keyID+"/") {
		xmlError(w, http.StatusForbidden, "InvalidAccessKeyId")
		return
	}
	bucket, key, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	body, _ := io.ReadAll(r.Body)
	if key == "" {
		f.bucketOp(w, r, bucket, q, body)
		return
	}
	if !f.buckets[bucket] {
		xmlError(w, http.StatusNotFound, "NoSuchBucket")
		return
	}
	id := bucket + "/" + key
	switch r.Method {
	case http.MethodPut:
		if cl := r.Header.Get("Content-Length"); cl != "" && cl != strconv.Itoa(len(body)) {
			xmlError(w, http.StatusBadRequest, "IncompleteBody")
			return
		}
		if _, ok := f.objects[id]; ok && r.Header.Get("If-None-Match") == "*" {
			xmlError(w, http.StatusPreconditionFailed, "PreconditionFailed")
			return
		}
		f.objects[id] = body
		w.Header().Set("ETag", `"`+md5hex(body)+`"`)
	case http.MethodGet, http.MethodHead:
		obj, ok := f.objects[id]
		if !ok {
			switch {
			case r.Method == http.MethodHead:
				w.WriteHeader(http.StatusNotFound) // HEAD has no body
			case strings.HasSuffix(key, "variant"):
				xmlError(w, http.StatusNotFound, "NotFound") // another provider's word
			default:
				xmlError(w, http.StatusNotFound, "NoSuchKey")
			}
			return
		}
		w.Header().Set("ETag", `"`+md5hex(obj)+`"`)
		w.Header().Set("Last-Modified", time.Unix(1_800_000_000, 0).UTC().Format(http.TimeFormat))
		w.Header().Set("Content-Length", strconv.Itoa(len(obj)))
		if r.Method == http.MethodGet {
			_, _ = w.Write(obj)
		}
	case http.MethodDelete:
		delete(f.objects, id)
		w.WriteHeader(http.StatusNoContent)
	default:
		xmlError(w, http.StatusMethodNotAllowed, "MethodNotAllowed")
	}
}

func (f *fakeS3) bucketOp(w http.ResponseWriter, r *http.Request, bucket string, q url.Values, body []byte) {
	switch {
	case r.Method == http.MethodHead:
		switch {
		case bucket == f.moved:
			// 301 is documented; 400 is what eu-central-2 answers.
			w.Header().Set("X-Amz-Bucket-Region", "us-west-2")
			w.WriteHeader(http.StatusMovedPermanently)
		case bucket == f.movedOptIn:
			w.Header().Set("X-Amz-Bucket-Region", "us-west-2")
			w.WriteHeader(http.StatusBadRequest)
		case bucket == f.forbidden:
			w.WriteHeader(http.StatusForbidden)
		case f.buckets[bucket]:
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	case r.Method == http.MethodPut && q.Has("versioning"):
		if strings.Contains(string(body), "<Status>Enabled</Status>") {
			f.versioning[bucket] = "Enabled"
		}
	case r.Method == http.MethodGet && q.Has("versioning"):
		_, _ = fmt.Fprintf(w, `<VersioningConfiguration><Status>%s</Status></VersioningConfiguration>`, f.versioning[bucket])
	case r.Method == http.MethodPut && q.Has("cors"):
		f.cors[bucket] = string(body)
	case r.Method == http.MethodPut:
		f.buckets[bucket] = true
		f.created = append(f.created, string(body))
	case r.Method == http.MethodGet && q.Get("list-type") == "2":
		f.list(w, bucket, q)
	default:
		xmlError(w, http.StatusNotImplemented, "NotImplemented")
	}
}

func (f *fakeS3) list(w http.ResponseWriter, bucket string, q url.Values) {
	if !f.buckets[bucket] {
		xmlError(w, http.StatusNotFound, "NoSuchBucket")
		return
	}
	prefix := q.Get("prefix")
	var keys []string
	for id := range f.objects {
		if k, ok := strings.CutPrefix(id, bucket+"/"); ok && strings.HasPrefix(k, prefix) && k > q.Get("continuation-token") {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	const page = 2 // small, so that paging is exercised whatever MaxKeys says
	truncated := len(keys) > page
	if truncated {
		keys = keys[:page]
	}
	type content struct {
		Key          string
		Size         int
		ETag         string
		LastModified string
	}
	out := struct {
		XMLName               xml.Name `xml:"ListBucketResult"`
		IsTruncated           bool
		NextContinuationToken string `xml:",omitempty"`
		Contents              []content
	}{IsTruncated: truncated}
	for _, k := range keys {
		out.Contents = append(out.Contents, content{Key: k, Size: len(f.objects[bucket+"/"+k]), ETag: `"x"`, LastModified: "2027-01-15T08:00:00.000Z"})
	}
	if truncated {
		out.NextContinuationToken = keys[len(keys)-1]
	}
	_ = xml.NewEncoder(w).Encode(out)
}

func md5hex(b []byte) string { s := md5.Sum(b); return hex.EncodeToString(s[:]) }

// keyFiles writes a fake key pair, each file ending in a newline as the
// user's files do.
func keyFiles(t *testing.T, id string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	a, s := filepath.Join(dir, "access"), filepath.Join(dir, "secret")
	if err := os.WriteFile(a, []byte(id+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s, []byte("fake-secret-value\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return a, s
}

// hostRewrite sends every request to the fake, turning a virtual-host
// request (<bucket>.fake.test) into a path-style one, so the aws row can
// run against the fake. The original host stays in r.Host.
type hostRewrite struct{ target *url.URL }

func (h hostRewrite) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	if r.Host == "" {
		r.Host = r.URL.Host
	}
	if bucket, ok := strings.CutSuffix(r.URL.Hostname(), ".fake.test"); ok {
		r.URL.Path = "/" + bucket + r.URL.Path
		r.URL.RawPath = ""
	}
	r.URL.Scheme, r.URL.Host = h.target.Scheme, h.target.Host
	return http.DefaultTransport.RoundTrip(r)
}

func fakeConfig(t *testing.T, srv *httptest.Server, flavour, bucket string) S3Config {
	a, s := keyFiles(t, "AKIDFAKE")
	cfg := S3Config{Flavour: flavour, Bucket: bucket, Prefix: "pre/fix/", AccessKeyFile: a, SecretKeyFile: s}
	switch flavour {
	case FlavourCeph:
		cfg.Endpoint = srv.URL
	case FlavourAWS:
		cfg.Region = "eu-central-2"
		cfg.testEndpoint = "http://fake.test"
		target, _ := url.Parse(srv.URL)
		cfg.HTTPClient = &http.Client{Transport: hostRewrite{target}}
	}
	return cfg
}

func TestS3OpenCreates(t *testing.T) {
	f, srv := newFake(t)
	ctx := context.Background()

	// ceph: path style, no LocationConstraint, versioning and CORS applied.
	cfg := fakeConfig(t, srv, FlavourCeph, "worlds")
	cors := []CORSRule{{AllowedOrigins: []string{"https://casas.example"}, AllowedMethods: []string{"GET"}, MaxAge: time.Hour}}
	if _, err := OpenS3(ctx, cfg, OpenOptions{Versioning: true, CORS: cors}); err != nil {
		t.Fatalf("OpenS3 ceph: %v", err)
	}
	if !f.buckets["worlds"] || len(f.created) != 1 || strings.Contains(f.created[0], "LocationConstraint") {
		t.Errorf("ceph create: buckets %v, bodies %q", f.buckets, f.created)
	}
	if f.versioning["worlds"] != "Enabled" {
		t.Error("versioning not turned on")
	}
	if c := f.cors["worlds"]; !strings.Contains(c, "https://casas.example") || !strings.Contains(c, "<MaxAgeSeconds>3600</MaxAgeSeconds>") {
		t.Errorf("CORS body = %s", c)
	}

	// Again: the bucket exists, so no second create and no second
	// versioning PUT.
	before := f.count()
	if _, err := OpenS3(ctx, cfg, OpenOptions{Versioning: true}); err != nil {
		t.Fatalf("OpenS3 again: %v", err)
	}
	for _, r := range f.requests[before:] {
		if strings.HasPrefix(r, "PUT") {
			t.Errorf("a second Open sent %s", r)
		}
	}

	// aws: virtual host and the region's LocationConstraint.
	acfg := fakeConfig(t, srv, FlavourAWS, "artifacts")
	if _, err := OpenS3(ctx, acfg, OpenOptions{}); err != nil {
		t.Fatalf("OpenS3 aws: %v", err)
	}
	if len(f.created) != 2 || !strings.Contains(f.created[1], "<LocationConstraint>eu-central-2</LocationConstraint>") {
		t.Errorf("aws create body = %q", f.created)
	}
	if !slices.ContainsFunc(f.requests, func(r string) bool { return strings.HasPrefix(r, "HEAD artifacts.fake.test /") }) {
		t.Errorf("aws did not use the virtual host: %v", f.requests)
	}
}

func TestS3OpenRefusals(t *testing.T) {
	f, srv := newFake(t)
	ctx := context.Background()

	f.moved, f.movedOptIn = "elsewhere", "optin"
	for _, bucket := range []string{"elsewhere", "optin"} {
		_, err := OpenS3(ctx, fakeConfig(t, srv, FlavourAWS, bucket), OpenOptions{})
		if err == nil || !strings.Contains(err.Error(), "is in region us-west-2") {
			t.Errorf("wrong region (%s) = %v", bucket, err)
		}
	}
	f.forbidden = "theirs"
	if _, err := OpenS3(ctx, fakeConfig(t, srv, FlavourAWS, "theirs"), OpenOptions{}); err == nil || !strings.Contains(err.Error(), "access denied") {
		t.Errorf("forbidden = %v", err)
	}
	if len(f.created) != 0 {
		t.Errorf("a refusal led to a create: %q", f.created)
	}

	base := fakeConfig(t, srv, FlavourCeph, "b")
	bad := map[string]func(c *S3Config){
		"unknown flavour":       func(c *S3Config) { c.Flavour = "gcs" },
		"no bucket":             func(c *S3Config) { c.Bucket = "" },
		"ceph without endpoint": func(c *S3Config) { c.Endpoint = "" },
		"aws with endpoint": func(c *S3Config) {
			c.Flavour, c.Region = FlavourAWS, "eu-central-2"
		},
		"aws without region": func(c *S3Config) { c.Flavour, c.Endpoint = FlavourAWS, "" },
		"bad prefix":         func(c *S3Config) { c.Prefix = "../up" },
		"no key files":       func(c *S3Config) { c.AccessKeyFile, c.SecretKeyFile = "", "" },
		"missing key file":   func(c *S3Config) { c.SecretKeyFile = filepath.Join(t.TempDir(), "none") },
	}
	for name, change := range bad {
		c := base
		change(&c)
		_, err := OpenS3(ctx, c, OpenOptions{})
		if err == nil {
			t.Errorf("%s: accepted", name)
		} else if strings.Contains(err.Error(), "fake-secret-value") {
			t.Errorf("%s: the error shows the secret", name)
		}
	}

	// A key id other than the file's is refused by the fake: the trimmed
	// file content is what signs.
	wrong := base
	wrong.AccessKeyFile, wrong.SecretKeyFile = keyFiles(t, "AKIDOTHER")
	if _, err := OpenS3(ctx, wrong, OpenOptions{}); err == nil {
		t.Error("a request signed with another key id was accepted")
	}
}

func openFake(t *testing.T, flavour string) (*fakeS3, *S3) {
	t.Helper()
	f, srv := newFake(t)
	b, err := OpenS3(context.Background(), fakeConfig(t, srv, flavour, "bkt"), OpenOptions{})
	if err != nil {
		t.Fatalf("OpenS3: %v", err)
	}
	return f, b
}

func TestS3Objects(t *testing.T) {
	f, b := openFake(t, FlavourCeph)
	b.pageSize = 2
	ctx := context.Background()

	info := put(t, b, "a/b", "hello")
	if info.ETag != md5hex([]byte("hello")) || info.Size != 5 {
		t.Errorf("Put info = %+v", info)
	}
	if _, ok := f.objects["bkt/pre/fix/a/b"]; !ok {
		t.Errorf("the prefix was not applied: %v", f.objects)
	}
	if got := get(t, b, "a/b"); got != "hello" {
		t.Errorf("Get = %q", got)
	}
	head, err := b.Head(ctx, "a/b")
	if err != nil || head.Size != 5 || head.ETag != info.ETag || head.LastModified.IsZero() {
		t.Errorf("Head = %+v, %v", head, err)
	}

	for _, k := range []string{"a/c", "a/d", "a/e", "z"} {
		put(t, b, k, k)
	}
	before := f.count()
	if got, want := listKeys(t, b, "a/"), []string{"a/b", "a/c", "a/d", "a/e"}; !slices.Equal(got, want) {
		t.Errorf("List = %v, want %v", got, want)
	}
	if pages := f.count() - before; pages != 2 {
		t.Errorf("List made %d requests, want 2 pages", pages)
	}
	// Stop after the first: no further page is fetched.
	before = f.count()
	for range b.List(ctx, "") {
		break
	}
	if n := f.count() - before; n != 1 {
		t.Errorf("an early break made %d requests, want 1", n)
	}

	if err := b.Delete(ctx, "a/b"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := b.Delete(ctx, "a/b"); err != nil {
		t.Errorf("Delete of a missing key = %v", err)
	}

	// The not-found shapes: NoSuchKey on GET, a bodyless 404 on HEAD, the
	// word NotFound from another provider — one error.
	if _, _, err := b.Get(ctx, "a/b"); err != ErrNotFound {
		t.Errorf("Get NoSuchKey = %v, want ErrNotFound", err)
	}
	if _, err := b.Head(ctx, "a/b"); err != ErrNotFound {
		t.Errorf("Head 404 = %v, want ErrNotFound", err)
	}
	if _, _, err := b.Get(ctx, "a/variant"); err != ErrNotFound {
		t.Errorf("Get NotFound = %v, want ErrNotFound", err)
	}
	delete(f.buckets, "bkt")
	if _, _, err := b.Get(ctx, "a/c"); err != ErrNoBucket {
		t.Errorf("Get NoSuchBucket = %v, want ErrNoBucket", err)
	}
	f.buckets["bkt"] = true

	// The size is checked before the request for a body that can seek.
	if _, err := b.Put(ctx, "s", strings.NewReader("abc"), 4, PutOptions{}); !errors.Is(err, ErrSize) {
		t.Errorf("Put with a wrong size = %v, want ErrSize", err)
	}
	// ceph does not claim a conditional put.
	before = f.count()
	if _, err := b.Put(ctx, "c", strings.NewReader("x"), 1, PutOptions{IfAbsent: true}); !errors.Is(err, ErrUnsupported) {
		t.Errorf("ceph IfAbsent = %v, want ErrUnsupported", err)
	}
	if f.count() != before {
		t.Error("an unsupported Put was sent")
	}
}

func TestS3BadKeyNotSent(t *testing.T) {
	f, b := openFake(t, FlavourCeph)
	ctx := context.Background()
	before := f.count()
	for _, k := range []string{"../x", "/abs", "a//b", "a/.hidden", ""} {
		if _, _, err := b.Get(ctx, k); !errors.Is(err, ErrBadKey) {
			t.Errorf("Get(%q) = %v", k, err)
		}
		if _, err := b.Head(ctx, k); !errors.Is(err, ErrBadKey) {
			t.Errorf("Head(%q) = %v", k, err)
		}
		if _, err := b.Put(ctx, k, strings.NewReader("x"), 1, PutOptions{}); !errors.Is(err, ErrBadKey) {
			t.Errorf("Put(%q) = %v", k, err)
		}
		if err := b.Delete(ctx, k); !errors.Is(err, ErrBadKey) {
			t.Errorf("Delete(%q) = %v", k, err)
		}
		if _, err := b.PresignGet(ctx, k, time.Minute); !errors.Is(err, ErrBadKey) {
			t.Errorf("PresignGet(%q) = %v", k, err)
		}
		if _, err := b.PresignPut(ctx, k, time.Minute, 1); !errors.Is(err, ErrBadKey) {
			t.Errorf("PresignPut(%q) = %v", k, err)
		}
	}
	for _, err := range b.List(ctx, "../") {
		if !errors.Is(err, ErrBadKey) {
			t.Errorf("List(../) = %v", err)
		}
	}
	// The prefix counts toward the length limit.
	long := strings.Repeat("a", MaxKeyLength-2)
	if _, err := b.Head(ctx, long); !errors.Is(err, ErrBadKey) {
		t.Errorf("a key too long with the prefix = %v", err)
	}
	if f.count() != before {
		t.Errorf("bad keys reached the provider: %v", f.requests[before:])
	}
}

func TestS3ConditionalPutAWS(t *testing.T) {
	_, b := openFake(t, FlavourAWS)
	ctx := context.Background()
	if _, err := b.Put(ctx, "once", strings.NewReader("1"), 1, PutOptions{IfAbsent: true}); err != nil {
		t.Fatalf("first IfAbsent: %v", err)
	}
	if _, err := b.Put(ctx, "once", strings.NewReader("2"), 1, PutOptions{IfAbsent: true}); err != ErrExists {
		t.Errorf("second IfAbsent = %v, want ErrExists", err)
	}
}

func TestS3PresignShape(t *testing.T) {
	f, b := openFake(t, FlavourCeph)
	ctx := context.Background()
	if _, err := b.PresignGet(ctx, "k", MaxLinkTTL+time.Second); !errors.Is(err, ErrBadTTL) {
		t.Errorf("ttl beyond the limit = %v", err)
	}
	put(t, b, "lvl/1", "level one")
	link, err := b.PresignGet(ctx, "lvl/1", 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(link.URL)
	q := u.Query()
	if link.Method != http.MethodGet || u.Path != "/bkt/pre/fix/lvl/1" || q.Get("X-Amz-Expires") != "600" ||
		q.Get("X-Amz-Signature") == "" || !strings.HasPrefix(q.Get("X-Amz-Credential"), "AKIDFAKE/") {
		t.Errorf("GET link = %s", link.URL)
	}
	if time.Until(link.Expires) < 9*time.Minute {
		t.Errorf("GET link expiry = %v", link.Expires)
	}
	if strings.Contains(link.URL, "fake-secret-value") {
		t.Error("the secret is in the link")
	}
	resp, err := http.Get(link.URL)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(raw) != "level one" {
		t.Errorf("GET by link = %d %q", resp.StatusCode, raw)
	}

	pl, err := b.PresignPut(ctx, "lvl/2", time.Hour, 3)
	if err != nil {
		t.Fatal(err)
	}
	if pl.Method != http.MethodPut || pl.Header.Get("Content-Length") != "3" {
		t.Errorf("PUT link = %+v", pl)
	}
	req, _ := http.NewRequest(pl.Method, pl.URL, bytes.NewReader([]byte("two")))
	for k, v := range pl.Header {
		if k != "Content-Length" {
			req.Header[k] = v
		}
	}
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(f.objects["bkt/pre/fix/lvl/2"]) != "two" {
		t.Errorf("PUT by link = %d, stored %q", resp.StatusCode, f.objects["bkt/pre/fix/lvl/2"])
	}
}
