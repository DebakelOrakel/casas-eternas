package world

import (
	"bufio"
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/blob"
)

// fakeS3 stands in for an S3 provider, enough for the world store's wiring:
// one bucket made by Open, versioning, objects with conditional PUT,
// ListObjectsV2 with pages of two, delete. It does not check signatures.
// A smaller cousin of the leaf's own fake (internal/blob/s3_test.go), which
// is not visible from here.
type fakeS3 struct {
	mu         sync.Mutex
	buckets    map[string]bool
	versioning map[string]bool
	objects    map[string][]byte // "<bucket>/<key>"
	// conditional counts the PUTs with If-None-Match "*", refused counts
	// those answered 412.
	conditional, refused int
}

func newFakeS3(t *testing.T) (*fakeS3, *httptest.Server) {
	t.Helper()
	f := &fakeS3{buckets: map[string]bool{}, versioning: map[string]bool{}, objects: map[string][]byte{}}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, srv
}

func fakeError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>fake</Message></Error>`, code)
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	bucket, key, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	body, err := readBody(r)
	if err != nil {
		fakeError(w, http.StatusBadRequest, "IncompleteBody")
		return
	}
	q := r.URL.Query()
	if key == "" {
		switch {
		case r.Method == http.MethodHead:
			if !f.buckets[bucket] {
				w.WriteHeader(http.StatusNotFound)
			}
		case r.Method == http.MethodPut && q.Has("versioning"):
			f.versioning[bucket] = strings.Contains(string(body), "<Status>Enabled</Status>")
		case r.Method == http.MethodGet && q.Has("versioning"):
			status := ""
			if f.versioning[bucket] {
				status = "Enabled"
			}
			_, _ = fmt.Fprintf(w, `<VersioningConfiguration><Status>%s</Status></VersioningConfiguration>`, status)
		case r.Method == http.MethodPut:
			f.buckets[bucket] = true
		case r.Method == http.MethodGet && q.Get("list-type") == "2":
			f.list(w, bucket, q)
		default:
			fakeError(w, http.StatusNotImplemented, "NotImplemented")
		}
		return
	}
	if !f.buckets[bucket] {
		fakeError(w, http.StatusNotFound, "NoSuchBucket")
		return
	}
	id := bucket + "/" + key
	switch r.Method {
	case http.MethodPut:
		if r.Header.Get("If-None-Match") == "*" {
			f.conditional++
			if _, ok := f.objects[id]; ok {
				f.refused++
				fakeError(w, http.StatusPreconditionFailed, "PreconditionFailed")
				return
			}
		}
		f.objects[id] = body
		w.Header().Set("ETag", `"x"`)
	case http.MethodGet, http.MethodHead:
		obj, ok := f.objects[id]
		if !ok {
			if r.Method == http.MethodHead {
				w.WriteHeader(http.StatusNotFound)
			} else {
				fakeError(w, http.StatusNotFound, "NoSuchKey")
			}
			return
		}
		w.Header().Set("ETag", `"x"`)
		w.Header().Set("Last-Modified", time.Unix(1_800_000_000, 0).UTC().Format(http.TimeFormat))
		w.Header().Set("Content-Length", strconv.Itoa(len(obj)))
		if r.Method == http.MethodGet {
			_, _ = w.Write(obj)
		}
	case http.MethodDelete:
		delete(f.objects, id)
		w.WriteHeader(http.StatusNoContent)
	default:
		fakeError(w, http.StatusMethodNotAllowed, "MethodNotAllowed")
	}
}

// readBody reads a request body, decoding the SDK's aws-chunked encoding
// (a trailing checksum over HTTPS): "<hex size>\r\n<bytes>\r\n" per chunk,
// then a chunk of size 0 and the trailer.
func readBody(r *http.Request) ([]byte, error) {
	if !strings.Contains(r.Header.Get("Content-Encoding"), "aws-chunked") {
		return io.ReadAll(r.Body)
	}
	var out bytes.Buffer
	br := bufio.NewReader(r.Body)
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return nil, err
		}
		sizeHex, _, _ := strings.Cut(strings.TrimSpace(line), ";")
		size, err := strconv.ParseInt(sizeHex, 16, 64)
		if err != nil {
			return nil, err
		}
		if size == 0 {
			_, _ = io.Copy(io.Discard, br) // the trailer
			return out.Bytes(), nil
		}
		if _, err := io.CopyN(&out, br, size); err != nil {
			return nil, err
		}
		if _, err := br.Discard(2); err != nil { // \r\n
			return nil, err
		}
	}
}

func (f *fakeS3) list(w http.ResponseWriter, bucket string, q url.Values) {
	prefix := q.Get("prefix")
	var keys []string
	for id := range f.objects {
		if k, ok := strings.CutPrefix(id, bucket+"/"); ok && strings.HasPrefix(k, prefix) && k > q.Get("continuation-token") {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	const page = 2 // small, so that paging is exercised
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

// toFake sends every request to the fake: a virtual-host request
// (<bucket>.s3.<region>.amazonaws.com, the aws row) becomes a path-style
// one, a path-style request (the ceph row) keeps its path.
type toFake struct{ target *url.URL }

func (h toFake) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	if bucket, _, ok := strings.Cut(r.URL.Hostname(), ".s3."); ok && strings.HasSuffix(r.URL.Hostname(), ".amazonaws.com") {
		r.URL.Path = "/" + bucket + r.URL.Path
		r.URL.RawPath = ""
	}
	r.URL.Scheme, r.URL.Host = h.target.Scheme, h.target.Host
	r.Host = h.target.Host
	return http.DefaultTransport.RoundTrip(r)
}

// openFakeBucket opens a blob.S3 of `flavour` on the fake with the store's
// BucketOptions, as cmd/ does.
func openFakeBucket(t *testing.T, srv *httptest.Server, flavour string) *blob.S3 {
	t.Helper()
	dir := t.TempDir()
	access, secret := filepath.Join(dir, "access"), filepath.Join(dir, "secret")
	for _, p := range []string{access, secret} {
		if err := os.WriteFile(p, []byte("fake\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	target, _ := url.Parse(srv.URL)
	cfg := blob.S3Config{
		Flavour: flavour, Bucket: "worlds", Prefix: "test/run",
		AccessKeyFile: access, SecretKeyFile: secret,
		HTTPClient: &http.Client{Transport: toFake{target}},
	}
	switch flavour {
	case blob.FlavourAWS:
		cfg.Region = "eu-central-2"
	case blob.FlavourCeph:
		cfg.Endpoint = "https://objects.fake.test"
	}
	b, err := blob.OpenS3(context.Background(), cfg, BucketOptions())
	if err != nil {
		t.Fatalf("OpenS3 %s: %v", flavour, err)
	}
	return b
}
