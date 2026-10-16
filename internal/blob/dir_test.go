package blob

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCheckKey(t *testing.T) {
	good := []string{"a", "a/b", "worlds/abc-123/rev_0001.zip", "x.y", "a/b..c", "A-Z_0.9"}
	for _, k := range good {
		if err := CheckKey(k); err != nil {
			t.Errorf("CheckKey(%q) = %v, want nil", k, err)
		}
	}
	bad := []string{
		"", "/a", "a/", "a//b", ".", "..", "a/../b", "../a", "a/..", ".hidden", "a/.tmp-x",
		`a\b`, "a b", "a\x00b", "a\nb", "ä", "a?b", "a#b", "a%2e", "a:b", "~a",
		strings.Repeat("a", MaxKeyLength+1),
	}
	for _, k := range bad {
		if err := CheckKey(k); !errors.Is(err, ErrBadKey) {
			t.Errorf("CheckKey(%q) = %v, want ErrBadKey", k, err)
		}
	}
	if err := checkPrefix(""); err != nil {
		t.Errorf("checkPrefix(\"\") = %v", err)
	}
	for _, p := range []string{"a/", "a/b", "a/b/"} {
		if err := checkPrefix(p); err != nil {
			t.Errorf("checkPrefix(%q) = %v", p, err)
		}
	}
	for _, p := range []string{"/", "../", "a//", "a/../"} {
		if err := checkPrefix(p); !errors.Is(err, ErrBadKey) {
			t.Errorf("checkPrefix(%q) = %v, want ErrBadKey", p, err)
		}
	}
}

func openDir(t *testing.T, signer *LinkSigner) (*Dir, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "store")
	d, err := OpenDir(root, signer)
	if err != nil {
		t.Fatalf("OpenDir: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d, root
}

func put(t *testing.T, b Bucket, key, body string) Info {
	t.Helper()
	info, err := b.Put(context.Background(), key, strings.NewReader(body), int64(len(body)), PutOptions{})
	if err != nil {
		t.Fatalf("Put %s: %v", key, err)
	}
	return info
}

func get(t *testing.T, b Bucket, key string) string {
	t.Helper()
	r, _, err := b.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("Get %s: %v", key, err)
	}
	defer func() { _ = r.Close() }()
	raw, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read %s: %v", key, err)
	}
	return string(raw)
}

func listKeys(t *testing.T, b Bucket, prefix string) []string {
	t.Helper()
	var keys []string
	for info, err := range b.List(context.Background(), prefix) {
		if err != nil {
			t.Fatalf("List %q: %v", prefix, err)
		}
		keys = append(keys, info.Key)
	}
	slices.Sort(keys)
	return keys
}

func TestDirRoundTrip(t *testing.T) {
	d, root := openDir(t, nil)
	ctx := context.Background()
	info := put(t, d, "a/b/c.bin", "hello")
	if info.Size != 5 || info.ETag == "" || info.LastModified.IsZero() {
		t.Errorf("Put info = %+v", info)
	}
	if got := get(t, d, "a/b/c.bin"); got != "hello" {
		t.Errorf("Get = %q", got)
	}
	if _, err := os.Stat(filepath.Join(root, "a", "b", "c.bin")); err != nil {
		t.Errorf("file not under the root: %v", err)
	}
	head, err := d.Head(ctx, "a/b/c.bin")
	if err != nil || head.Size != 5 || head.ETag != info.ETag {
		t.Errorf("Head = %+v, %v", head, err)
	}
	put(t, d, "a/b/c.bin", "changed!")
	if got := get(t, d, "a/b/c.bin"); got != "changed!" {
		t.Errorf("Get after overwrite = %q", got)
	}
	put(t, d, "a/bc", "1")
	put(t, d, "a/b/d", "2")
	put(t, d, "z", "3")
	if got, want := listKeys(t, d, ""), []string{"a/b/c.bin", "a/b/d", "a/bc", "z"}; !slices.Equal(got, want) {
		t.Errorf("List all = %v, want %v", got, want)
	}
	if got, want := listKeys(t, d, "a/b"), []string{"a/b/c.bin", "a/b/d", "a/bc"}; !slices.Equal(got, want) {
		t.Errorf("List a/b = %v, want %v", got, want)
	}
	if got, want := listKeys(t, d, "a/b/"), []string{"a/b/c.bin", "a/b/d"}; !slices.Equal(got, want) {
		t.Errorf("List a/b/ = %v, want %v", got, want)
	}
	if got := listKeys(t, d, "nothing/here/"); len(got) != 0 {
		t.Errorf("List of a missing prefix = %v", got)
	}
	if err := d.Delete(ctx, "a/b/c.bin"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := d.Delete(ctx, "a/b/c.bin"); err != nil {
		t.Errorf("Delete of a missing key = %v, want nil", err)
	}
	if _, _, err := d.Get(ctx, "a/b/c.bin"); err != ErrNotFound {
		t.Errorf("Get after Delete = %v, want ErrNotFound", err)
	}
	if _, err := d.Head(ctx, "a/b/c.bin"); err != ErrNotFound {
		t.Errorf("Head after Delete = %v, want ErrNotFound", err)
	}
	// A directory and a path through a file are not objects either.
	if _, err := d.Head(ctx, "a/b"); err != ErrNotFound {
		t.Errorf("Head of a directory = %v, want ErrNotFound", err)
	}
	if _, err := d.Head(ctx, "z/below"); err != ErrNotFound {
		t.Errorf("Head through a file = %v, want ErrNotFound", err)
	}
}

func TestDirPutSize(t *testing.T) {
	d, root := openDir(t, nil)
	ctx := context.Background()
	if _, err := d.Put(ctx, "k", strings.NewReader("short"), 10, PutOptions{}); !errors.Is(err, ErrSize) {
		t.Errorf("short body = %v, want ErrSize", err)
	}
	if _, err := d.Put(ctx, "k", strings.NewReader("too long body"), 3, PutOptions{}); !errors.Is(err, ErrSize) {
		t.Errorf("long body = %v, want ErrSize", err)
	}
	if _, err := d.Head(ctx, "k"); err != ErrNotFound {
		t.Errorf("a refused Put left an object: %v", err)
	}
	assertNoTemp(t, root)
}

func assertNoTemp(t *testing.T, root string) {
	t.Helper()
	_ = filepath.WalkDir(root, func(p string, e os.DirEntry, err error) error {
		if err == nil && strings.HasPrefix(e.Name(), tmpPrefix) {
			t.Errorf("temp file left: %s", p)
		}
		return nil
	})
}

// failingReader gives some bytes, then an error: a broken upload.
type failingReader struct{ n int }

func (f *failingReader) Read(p []byte) (int, error) {
	if f.n <= 0 {
		return 0, errors.New("connection lost")
	}
	m := min(len(p), f.n)
	for i := range m {
		p[i] = 'x'
	}
	f.n -= m
	return m, nil
}

func TestDirPutAtomic(t *testing.T) {
	d, root := openDir(t, nil)
	ctx := context.Background()
	put(t, d, "obj", "old")
	// A broken upload leaves the old object as it was, and no temp file.
	if _, err := d.Put(ctx, "obj", &failingReader{n: 100}, 1000, PutOptions{}); err == nil {
		t.Fatal("a broken body was accepted")
	}
	if got := get(t, d, "obj"); got != "old" {
		t.Errorf("after a broken Put = %q, want old", got)
	}
	assertNoTemp(t, root)

	// Readers during writes see one whole version or the other.
	a, b := strings.Repeat("A", 1<<16), strings.Repeat("B", 1<<16)
	put(t, d, "obj", a)
	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			body := a
			if i%2 == 1 {
				body = b
			}
			if _, err := d.Put(ctx, "obj", strings.NewReader(body), int64(len(body)), PutOptions{}); err != nil {
				t.Errorf("Put: %v", err)
				return
			}
		}
	}()
	for range 200 {
		if got := get(t, d, "obj"); got != a && got != b {
			t.Fatalf("a reader saw a mixed or partial object (%d bytes)", len(got))
		}
	}
	close(stop)
	wg.Wait()
	// No temp files are listed while they exist; none are left after.
	for _, k := range listKeys(t, d, "") {
		if k != "obj" {
			t.Errorf("List shows %q", k)
		}
	}
	assertNoTemp(t, root)
}

func TestDirIfAbsent(t *testing.T) {
	d, root := openDir(t, nil)
	ctx := context.Background()
	if _, err := d.Put(ctx, "once", strings.NewReader("first"), 5, PutOptions{IfAbsent: true}); err != nil {
		t.Fatalf("first IfAbsent Put: %v", err)
	}
	if _, err := d.Put(ctx, "once", strings.NewReader("other"), 5, PutOptions{IfAbsent: true}); err != ErrExists {
		t.Errorf("second IfAbsent Put = %v, want ErrExists", err)
	}
	if got := get(t, d, "once"); got != "first" {
		t.Errorf("object = %q, want first", got)
	}
	assertNoTemp(t, root)
}

func TestDirTraversalRefused(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "store")
	d, err := OpenDir(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = d.Close() }()
	ctx := context.Background()
	secret := filepath.Join(parent, "secret")
	if err := os.WriteFile(secret, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"../secret", "a/../../secret", "/etc/passwd", "..", `..\secret`} {
		if _, _, err := d.Get(ctx, k); !errors.Is(err, ErrBadKey) {
			t.Errorf("Get(%q) = %v, want ErrBadKey", k, err)
		}
		if _, err := d.Put(ctx, k, strings.NewReader("x"), 1, PutOptions{}); !errors.Is(err, ErrBadKey) {
			t.Errorf("Put(%q) = %v, want ErrBadKey", k, err)
		}
		if err := d.Delete(ctx, k); !errors.Is(err, ErrBadKey) {
			t.Errorf("Delete(%q) = %v, want ErrBadKey", k, err)
		}
	}
	// A symlink inside the root that points out of it is not followed.
	if err := os.Symlink(parent, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := d.Get(ctx, "escape/secret"); err == nil {
		t.Error("Get through a symlink out of the root succeeded")
	}
	if _, err := d.Put(ctx, "escape/new", strings.NewReader("x"), 1, PutOptions{}); err == nil {
		t.Error("Put through a symlink out of the root succeeded")
	}
	if _, err := os.Stat(filepath.Join(parent, "new")); err == nil {
		t.Error("a file was written outside the root")
	}
	if raw, _ := os.ReadFile(secret); string(raw) != "outside" {
		t.Error("the file outside the root changed")
	}
}

// --- links ------------------------------------------------------------

var (
	keyA = bytes.Repeat([]byte{'a'}, 32)
	keyB = bytes.Repeat([]byte{'b'}, 40)
)

func newSigner(t *testing.T, now time.Time, keys ...[]byte) *LinkSigner {
	t.Helper()
	s, err := NewLinkSigner("/v1/artifacts/blob/", 1<<20, keys...)
	if err != nil {
		t.Fatalf("NewLinkSigner: %v", err)
	}
	s.now = func() time.Time { return now }
	return s
}

// splitLink returns the key and the query of a link made under the base.
func splitLink(t *testing.T, link Link) (string, url.Values) {
	t.Helper()
	u, err := url.Parse(link.URL)
	if err != nil {
		t.Fatal(err)
	}
	key, ok := strings.CutPrefix(u.Path, "/v1/artifacts/blob/")
	if !ok {
		t.Fatalf("link %s is not under the base", link.URL)
	}
	return key, u.Query()
}

func TestLinkSignerRules(t *testing.T) {
	if _, err := NewLinkSigner("/v1/blob", 1, keyA); err == nil {
		t.Error("a base without a trailing / was accepted")
	}
	if _, err := NewLinkSigner("/b/", 1, []byte("short")); err == nil {
		t.Error("a short key was accepted")
	}
	if _, err := NewLinkSigner("/b/", 1); err == nil {
		t.Error("a signer without a key was accepted")
	}
	if _, err := NewLinkSigner("/b/", 0, keyA); err == nil {
		t.Error("a zero upload limit was accepted")
	}
	s := newSigner(t, time.Now(), keyA)
	if _, err := s.Sign(http.MethodGet, "../x", time.Minute, 0); !errors.Is(err, ErrBadKey) {
		t.Errorf("Sign of a bad key = %v, want ErrBadKey", err)
	}
	if _, err := s.Sign(http.MethodGet, "x", 0, 0); !errors.Is(err, ErrBadTTL) {
		t.Errorf("Sign with ttl 0 = %v, want ErrBadTTL", err)
	}
	if _, err := s.Sign(http.MethodGet, "x", MaxLinkTTL+time.Second, 0); !errors.Is(err, ErrBadTTL) {
		t.Errorf("Sign beyond MaxLinkTTL = %v, want ErrBadTTL", err)
	}
	if _, err := s.Sign(http.MethodDelete, "x", time.Minute, 0); err == nil {
		t.Error("a DELETE link was signed")
	}
	if _, err := s.Sign(http.MethodPut, "x", time.Minute, 1<<20+1); !errors.Is(err, ErrTooLarge) {
		t.Errorf("Sign above the limit = %v, want ErrTooLarge", err)
	}
}

func TestLinkVerify(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	s := newSigner(t, now, keyA)

	get, err := s.Sign(http.MethodGet, "levels/1.bin", time.Minute, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(get.URL, "/v1/artifacts/blob/levels/1.bin?") || !get.Expires.Equal(now.Add(time.Minute)) {
		t.Errorf("GET link = %+v", get)
	}
	key, q := splitLink(t, get)
	if n, err := s.Verify(http.MethodGet, key, q); err != nil || n != 0 {
		t.Errorf("valid GET = %d, %v", n, err)
	}

	putLink, err := s.Sign(http.MethodPut, "levels/1.bin", time.Minute, 4096)
	if err != nil {
		t.Fatal(err)
	}
	pkey, pq := splitLink(t, putLink)
	if n, err := s.Verify(http.MethodPut, pkey, pq); err != nil || n != 4096 {
		t.Errorf("valid PUT = %d, %v", n, err)
	}

	with := func(q url.Values, k, v string) url.Values {
		c := url.Values{}
		for kk, vv := range q {
			c[kk] = slices.Clone(vv)
		}
		c.Set(k, v)
		return c
	}
	cases := []struct {
		name   string
		method string
		key    string
		q      url.Values
		want   error
	}{
		{"GET link used for PUT", http.MethodPut, key, with(q, "len", "1"), ErrLinkInvalid},
		{"PUT link used for GET", http.MethodGet, pkey, pq, ErrLinkInvalid},
		{"other key", http.MethodGet, "levels/2.bin", q, ErrLinkInvalid},
		{"bad key", http.MethodGet, "../x", q, ErrBadKey},
		{"later exp", http.MethodGet, key, with(q, "exp", "1900000000"), ErrLinkInvalid},
		{"other len", http.MethodPut, pkey, with(pq, "len", "4097"), ErrLinkInvalid},
		{"no sig", http.MethodGet, key, with(q, "sig", ""), ErrLinkInvalid},
		{"changed sig", http.MethodGet, key, with(q, "sig", strings.Repeat("A", 43)), ErrLinkInvalid},
		{"no exp", http.MethodGet, key, url.Values{"sig": q["sig"]}, ErrLinkInvalid},
		{"two exp", http.MethodGet, key, url.Values{"sig": q["sig"], "exp": {q.Get("exp"), q.Get("exp")}}, ErrLinkInvalid},
		{"HEAD method", http.MethodHead, key, q, ErrLinkInvalid},
	}
	for _, c := range cases {
		if _, err := s.Verify(c.method, c.key, c.q); !errors.Is(err, c.want) {
			t.Errorf("%s: %v, want %v", c.name, err, c.want)
		}
	}

	// Expired: the same link a minute and a second later.
	late := newSigner(t, now.Add(time.Minute+time.Second), keyA)
	if _, err := late.Verify(http.MethodGet, key, q); !errors.Is(err, ErrLinkExpired) {
		t.Errorf("expired = %v, want ErrLinkExpired", err)
	}
	// Exactly at the expiry it is expired.
	at := newSigner(t, now.Add(time.Minute), keyA)
	if _, err := at.Verify(http.MethodGet, key, q); !errors.Is(err, ErrLinkExpired) {
		t.Errorf("at the expiry = %v, want ErrLinkExpired", err)
	}
	// An expired link with a forged signature is invalid, not expired.
	if _, err := late.Verify(http.MethodGet, key, with(q, "sig", strings.Repeat("A", 43))); !errors.Is(err, ErrLinkInvalid) {
		t.Errorf("expired and forged = %v, want ErrLinkInvalid", err)
	}
	// Another key does not verify it.
	other := newSigner(t, now, keyB)
	if _, err := other.Verify(http.MethodGet, key, q); !errors.Is(err, ErrLinkInvalid) {
		t.Errorf("other key = %v, want ErrLinkInvalid", err)
	}
	// A lower upload limit at verification refuses a link signed above it.
	small, _ := NewLinkSigner("/v1/artifacts/blob/", 1000, keyA)
	small.now = func() time.Time { return now }
	if _, err := small.Verify(http.MethodPut, pkey, pq); !errors.Is(err, ErrTooLarge) {
		t.Errorf("above the limit = %v, want ErrTooLarge", err)
	}
}

func TestLinkRotation(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	old := newSigner(t, now, keyA)
	link, err := old.Sign(http.MethodGet, "a", time.Hour, 0)
	if err != nil {
		t.Fatal(err)
	}
	key, q := splitLink(t, link)
	// The change-over: the new key first, the old one still accepted.
	both := newSigner(t, now, keyB, keyA)
	if _, err := both.Verify(http.MethodGet, key, q); err != nil {
		t.Errorf("old link after rotation = %v, want nil", err)
	}
	fresh, _ := both.Sign(http.MethodGet, "a", time.Hour, 0)
	fkey, fq := splitLink(t, fresh)
	if _, err := newSigner(t, now, keyB).Verify(http.MethodGet, fkey, fq); err != nil {
		t.Errorf("a new link is not signed with the first key: %v", err)
	}
	if _, err := old.Verify(http.MethodGet, fkey, fq); !errors.Is(err, ErrLinkInvalid) {
		t.Errorf("a new link verified with the old key alone: %v", err)
	}
	// The old key dropped: its links die.
	if _, err := newSigner(t, now, keyB).Verify(http.MethodGet, key, q); !errors.Is(err, ErrLinkInvalid) {
		t.Errorf("old link after the old key went = %v, want ErrLinkInvalid", err)
	}
}

func TestLinkConstantTimeCompare(t *testing.T) {
	calls := 0
	saved := linkEqual
	linkEqual = func(a, b []byte) bool { calls++; return saved(a, b) }
	defer func() { linkEqual = saved }()

	now := time.Unix(1_800_000_000, 0)
	s := newSigner(t, now, keyB, keyA)
	link, _ := s.Sign(http.MethodGet, "a", time.Minute, 0)
	key, q := splitLink(t, link)
	if _, err := s.Verify(http.MethodGet, key, q); err != nil {
		t.Fatal(err)
	}
	// Every key is compared, also after the first one matched.
	if calls != 2 {
		t.Errorf("constant-time compares = %d, want 2 (one per key)", calls)
	}
}

func TestReadLinkKey(t *testing.T) {
	k1, eph, err := ReadLinkKey("")
	if err != nil || !eph || len(k1) < MinLinkKeyLength {
		t.Fatalf("ephemeral key = %d bytes, %v, %v", len(k1), eph, err)
	}
	k2, _, _ := ReadLinkKey("")
	if bytes.Equal(k1, k2) {
		t.Error("two ephemeral keys are the same")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "link-key")
	body := "  " + strings.Repeat("k", 32) + "\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	k, eph, err := ReadLinkKey(path)
	if err != nil || eph || string(k) != strings.Repeat("k", 32) {
		t.Errorf("file key: %d bytes, ephemeral %v, %v", len(k), eph, err)
	}
	short := filepath.Join(dir, "short")
	_ = os.WriteFile(short, []byte(strings.Repeat("k", 31)+"\n\n"), 0o600)
	if _, _, err := ReadLinkKey(short); err == nil {
		t.Error("a 31-byte key was accepted")
	} else if strings.Contains(err.Error(), "kkkk") {
		t.Error("the error shows the key")
	}
	if _, _, err := ReadLinkKey(filepath.Join(dir, "missing")); err == nil {
		t.Error("a missing key file made an ephemeral key")
	}
}

func TestDirPresign(t *testing.T) {
	d, _ := openDir(t, nil)
	ctx := context.Background()
	if _, err := d.PresignGet(ctx, "a", time.Minute); !errors.Is(err, ErrUnsupported) {
		t.Errorf("PresignGet without a signer = %v, want ErrUnsupported", err)
	}
	s := newSigner(t, time.Now(), keyA)
	d2, _ := openDir(t, s)
	link, err := d2.PresignPut(ctx, "a/b", time.Minute, 3)
	if err != nil || link.Method != http.MethodPut {
		t.Fatalf("PresignPut = %+v, %v", link, err)
	}
	key, q := splitLink(t, link)
	n, err := d2.Signer().Verify(http.MethodPut, key, q)
	if err != nil {
		t.Fatal(err)
	}
	// The route's part: verify, then Put exactly the signed length.
	if _, err := d2.Put(ctx, key, strings.NewReader("abcd"), n, PutOptions{}); !errors.Is(err, ErrSize) {
		t.Errorf("Put of more than the signed length = %v, want ErrSize", err)
	}
	if _, err := d2.Put(ctx, key, strings.NewReader("abc"), n, PutOptions{}); err != nil {
		t.Errorf("Put of the signed length = %v", err)
	}
	if _, err := d2.PresignGet(ctx, "../a", time.Minute); !errors.Is(err, ErrBadKey) {
		t.Errorf("PresignGet of a bad key = %v, want ErrBadKey", err)
	}
}

// Delete removes the directories it makes empty, up to the root, and
// keeps a directory that still holds something.
func TestDirDeleteRemovesEmptyParents(t *testing.T) {
	d, root := openDir(t, nil)
	ctx := context.Background()
	put(t, d, "a/b/c/one", "1")
	put(t, d, "a/two", "2")
	if err := d.Delete(ctx, "a/b/c/one"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "a", "b")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a/b still exists after its last object went: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "a")); err != nil {
		t.Errorf("a holds a/two and must stay: %v", err)
	}
	if err := d.Delete(ctx, "a/two"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "a")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a still exists after its last object went: %v", err)
	}
	if _, err := os.Stat(root); err != nil {
		t.Errorf("the root must stay: %v", err)
	}
	// A Put after that makes the directories again.
	put(t, d, "a/b/c/one", "again")
	if got := get(t, d, "a/b/c/one"); got != "again" {
		t.Errorf("Get after a re-Put = %q", got)
	}
}

// A symlink to a directory inside the root is not removed by the walk.
func TestDirDeleteKeepsASymlinkedParent(t *testing.T) {
	d, root := openDir(t, nil)
	ctx := context.Background()
	put(t, d, "real/x", "1")
	if err := os.Symlink("real", filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if err := d.Delete(ctx, "link/x"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(root, "link")); err != nil {
		t.Errorf("the symlink was removed: %v", err)
	}
}

// A Put and a Delete in the same directory at the same time: the Delete
// may remove the directory that the Put has just made, and the Put must
// still succeed.
func TestDirConcurrentPutDelete(t *testing.T) {
	d, root := openDir(t, nil)
	ctx := context.Background()
	const rounds = 300
	var wg sync.WaitGroup
	errs := make(chan error, 2*rounds)
	for i := range rounds {
		key := "e/" + strings.Repeat("x", i%7+1) + "/f" + string(rune('a'+i%26))
		wg.Add(2)
		go func() {
			defer wg.Done()
			if _, err := d.Put(ctx, key, strings.NewReader("p"), 1, PutOptions{}); err != nil {
				errs <- err
			}
		}()
		go func() {
			defer wg.Done()
			if err := d.Delete(ctx, "e/"+strings.Repeat("x", (i+3)%7+1)+"/g"); err != nil {
				errs <- err
			}
		}()
		// A Delete of a key whose object exists, so that the walk runs.
		other := "e/" + strings.Repeat("x", (i+1)%7+1) + "/h"
		put(t, d, other, "h")
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := d.Delete(ctx, other); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent Put/Delete: %v", err)
	}
	// No temp file is left, and every key List names can be read.
	for _, key := range listKeys(t, d, "") {
		get(t, d, key)
	}
	_ = filepath.WalkDir(root, func(p string, e os.DirEntry, err error) error {
		if err == nil && strings.HasPrefix(e.Name(), tmpPrefix) {
			t.Errorf("a temp file is left: %s", p)
		}
		return nil
	})
}

// RemoveJunk removes a top-level name that is not a valid key, with what
// it holds, and refuses everything else.
func TestDirRemoveJunk(t *testing.T) {
	d, root := openDir(t, nil)
	ctx := context.Background()
	for _, name := range []string{"copy of entry", "Ärger", "tab\there"} {
		dir := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Join(dir, "inner dir"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "inner dir", "ä.bin"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := d.Delete(ctx, name+"/meta.json"); !errors.Is(err, ErrBadKey) {
			t.Fatalf("Delete(%q) = %v, want ErrBadKey (the reason this exists)", name, err)
		}
		if err := d.RemoveJunk(ctx, name); err != nil {
			t.Errorf("RemoveJunk(%q) = %v", name, err)
		}
		if _, err := os.Lstat(dir); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%q is still there: %v", name, err)
		}
		if err := d.RemoveJunk(ctx, name); err != nil {
			t.Errorf("RemoveJunk(%q) a second time = %v, want nil", name, err)
		}
	}
	put(t, d, "valid/x", "1")
	refused := []string{"", ".", "..", "valid", "a b/c", "../outside", "a\\b", ".tmp-1234", "a\x00b"}
	for _, name := range refused {
		if err := d.RemoveJunk(ctx, name); !errors.Is(err, ErrBadKey) {
			t.Errorf("RemoveJunk(%q) = %v, want ErrBadKey", name, err)
		}
	}
	if got := get(t, d, "valid/x"); got != "1" {
		t.Errorf("a valid key changed: %q", got)
	}
	// A symlink with a junk name pointing out of the root: the link goes,
	// the target stays.
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "keep"), []byte("k"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "bad link")); err != nil {
		t.Fatal(err)
	}
	if err := d.RemoveJunk(ctx, "bad link"); err != nil {
		t.Errorf("RemoveJunk(symlink) = %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "keep")); err != nil {
		t.Errorf("a file outside the root went: %v", err)
	}
}
