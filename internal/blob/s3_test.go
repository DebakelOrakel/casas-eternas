package blob

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/blob/blobtest"
)

// newFake starts the shared fake provider; it accepts only requests signed
// with the access key id of the key files that fakeConfig writes.
func newFake(t *testing.T) (*blobtest.S3, *httptest.Server) {
	return blobtest.NewS3(t, blobtest.Options{KeyID: "AKIDFAKE"})
}

func md5hex(b []byte) string { return blobtest.MD5Hex(b) }

func fakeConfig(t *testing.T, srv *httptest.Server, flavour, bucket string) S3Config {
	a, s := blobtest.KeyFiles(t, "AKIDFAKE")
	cfg := S3Config{Flavour: flavour, Bucket: bucket, Prefix: "pre/fix/", AccessKeyFile: a, SecretKeyFile: s}
	switch flavour {
	case FlavourCeph:
		cfg.Endpoint = srv.URL
	case FlavourAWS:
		cfg.Region = "eu-central-2"
		cfg.testEndpoint = "http://fake.test"
		cfg.HTTPClient = &http.Client{Transport: blobtest.Transport(srv)}
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
	if created := f.Created(); !f.HasBucket("worlds") || len(created) != 1 || strings.Contains(created[0], "LocationConstraint") {
		t.Errorf("ceph create: bucket %v, bodies %q", f.HasBucket("worlds"), created)
	}
	if f.Versioning("worlds") != "Enabled" {
		t.Error("versioning not turned on")
	}
	if c := f.CORS("worlds"); !strings.Contains(c, "https://casas.example") || !strings.Contains(c, "<MaxAgeSeconds>3600</MaxAgeSeconds>") {
		t.Errorf("CORS body = %s", c)
	}

	// Again: the bucket exists, so no second create and no second
	// versioning PUT.
	before := f.Count()
	if _, err := OpenS3(ctx, cfg, OpenOptions{Versioning: true}); err != nil {
		t.Fatalf("OpenS3 again: %v", err)
	}
	for _, r := range f.Requests()[before:] {
		if strings.HasPrefix(r, "PUT") {
			t.Errorf("a second Open sent %s", r)
		}
	}

	// aws: virtual host and the region's LocationConstraint.
	acfg := fakeConfig(t, srv, FlavourAWS, "artifacts")
	if _, err := OpenS3(ctx, acfg, OpenOptions{}); err != nil {
		t.Fatalf("OpenS3 aws: %v", err)
	}
	if created := f.Created(); len(created) != 2 || !strings.Contains(created[1], "<LocationConstraint>eu-central-2</LocationConstraint>") {
		t.Errorf("aws create body = %q", created)
	}
	if requests := f.Requests(); !slices.ContainsFunc(requests, func(r string) bool { return strings.HasPrefix(r, "HEAD artifacts.fake.test /") }) {
		t.Errorf("aws did not use the virtual host: %v", requests)
	}
}

func TestS3OpenRefusals(t *testing.T) {
	f, srv := newFake(t)
	ctx := context.Background()

	// 301 is documented; 400 is what eu-central-2 answers.
	f.AnswerHead("elsewhere", http.StatusMovedPermanently, "us-west-2")
	f.AnswerHead("optin", http.StatusBadRequest, "us-west-2")
	for _, bucket := range []string{"elsewhere", "optin"} {
		_, err := OpenS3(ctx, fakeConfig(t, srv, FlavourAWS, bucket), OpenOptions{})
		if err == nil || !strings.Contains(err.Error(), "is in region us-west-2") {
			t.Errorf("wrong region (%s) = %v", bucket, err)
		}
	}
	f.AnswerHead("theirs", http.StatusForbidden, "")
	if _, err := OpenS3(ctx, fakeConfig(t, srv, FlavourAWS, "theirs"), OpenOptions{}); err == nil || !strings.Contains(err.Error(), "access denied") {
		t.Errorf("forbidden = %v", err)
	}
	if created := f.Created(); len(created) != 0 {
		t.Errorf("a refusal led to a create: %q", created)
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
		} else if strings.Contains(err.Error(), blobtest.Secret) {
			t.Errorf("%s: the error shows the secret", name)
		}
	}

	// A key id other than the file's is refused by the fake: the trimmed
	// file content is what signs.
	wrong := base
	wrong.AccessKeyFile, wrong.SecretKeyFile = blobtest.KeyFiles(t, "AKIDOTHER")
	if _, err := OpenS3(ctx, wrong, OpenOptions{}); err == nil {
		t.Error("a request signed with another key id was accepted")
	}
}

func openFake(t *testing.T, flavour string) (*blobtest.S3, *S3) {
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
	if _, ok := f.Object("bkt", "pre/fix/a/b"); !ok {
		t.Errorf("the prefix was not applied: %v", f.Keys("bkt"))
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
	before := f.Count()
	if got, want := listKeys(t, b, "a/"), []string{"a/b", "a/c", "a/d", "a/e"}; !slices.Equal(got, want) {
		t.Errorf("List = %v, want %v", got, want)
	}
	if pages := f.Count() - before; pages != 2 {
		t.Errorf("List made %d requests, want 2 pages", pages)
	}
	// Stop after the first: no further page is fetched.
	before = f.Count()
	for range b.List(ctx, "") {
		break
	}
	if n := f.Count() - before; n != 1 {
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
	f.DeleteBucket("bkt")
	if _, _, err := b.Get(ctx, "a/c"); err != ErrNoBucket {
		t.Errorf("Get NoSuchBucket = %v, want ErrNoBucket", err)
	}
	f.CreateBucket("bkt")

	// The size is checked before the request for a body that can seek.
	if _, err := b.Put(ctx, "s", strings.NewReader("abc"), 4, PutOptions{}); !errors.Is(err, ErrSize) {
		t.Errorf("Put with a wrong size = %v, want ErrSize", err)
	}
	// ceph does not claim a conditional put.
	before = f.Count()
	if _, err := b.Put(ctx, "c", strings.NewReader("x"), 1, PutOptions{IfAbsent: true}); !errors.Is(err, ErrUnsupported) {
		t.Errorf("ceph IfAbsent = %v, want ErrUnsupported", err)
	}
	if f.Count() != before {
		t.Error("an unsupported Put was sent")
	}
}

func TestS3BadKeyNotSent(t *testing.T) {
	f, b := openFake(t, FlavourCeph)
	ctx := context.Background()
	before := f.Count()
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
	if f.Count() != before {
		t.Errorf("bad keys reached the provider: %v", f.Requests()[before:])
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
	if strings.Contains(link.URL, blobtest.Secret) {
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
	if stored, _ := f.Object("bkt", "pre/fix/lvl/2"); resp.StatusCode != http.StatusOK || string(stored) != "two" {
		t.Errorf("PUT by link = %d, stored %q", resp.StatusCode, stored)
	}
}
