// Package blobtest holds test helpers for code on the blob leaf: a fake S3
// provider that the leaf's own tests and the stores' tests share.
//
// TEST-ONLY. Import it only from _test.go files; no other code may import
// it. The check: in `go list -f '{{.ImportPath}} {{.Imports}}' ./...` no
// package names it in its imports (only in TestImports). It imports no
// package of this repository, so that the blob package's internal tests can
// import it without a cycle.
package blobtest

import (
	"bufio"
	"bytes"
	"crypto/md5"
	"encoding/hex"
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
)

// Secret is the content of the secret key file that KeyFiles writes. A test
// can look for it in an error or a link: it must never be there.
const Secret = "fake-secret-value"

// S3 stands in for an S3 provider, enough for the leaf's wiring and the
// stores on it: buckets (HeadBucket, CreateBucket), versioning, CORS,
// objects (PUT with If-None-Match "*", GET, HEAD, DELETE), ListObjectsV2 in
// small pages, and the error shapes of a provider: NoSuchKey, a bodyless 404
// on HEAD, the word NotFound of another provider (a key that ends in
// "variant"), NoSuchBucket, and a HeadBucket answer set by AnswerHead (the
// 301 or 400 with x-amz-bucket-region of a bucket in another region, a 403).
//
// It does not check signatures. With Options.KeyID set, it checks that a
// request is signed (in its header or in its link) with that access key id.
// It serves path-style requests; Transport turns virtual-host ones into
// path style.
//
// Every method is safe for concurrent use.
type S3 struct {
	mu         sync.Mutex
	keyID      string
	pageSize   int
	buckets    map[string]bool
	objects    map[string]object // "<bucket>/<key>"
	versioning map[string]string
	cors       map[string]string
	heads      map[string]headAnswer
	created    []string // bodies of CreateBucket
	requests   []string // "METHOD host path?query"
	// conditional counts the PUTs with If-None-Match "*", refused counts
	// those answered 412.
	conditional, refused int
}

type object struct {
	data     []byte
	modified time.Time
}

type headAnswer struct {
	status int
	region string
}

// Options configure NewS3.
type Options struct {
	// KeyID, when set, is the only access key id the fake accepts; other
	// requests get 403 InvalidAccessKeyId.
	KeyID string
	// PageSize is the number of keys in one page of a listing. 0 means 2,
	// small, so that paging is exercised whatever MaxKeys says.
	PageSize int
	// TLS serves over HTTPS (httptest.NewTLSServer); use the server's
	// Client. Over plain HTTP the SDK must hash the payload and so needs a
	// seekable body; over HTTPS it sends it unsigned.
	TLS bool
}

// NewS3 starts a fake on a test server that the test's cleanup closes.
func NewS3(t testing.TB, opts Options) (*S3, *httptest.Server) {
	t.Helper()
	f := &S3{
		keyID:      opts.KeyID,
		pageSize:   opts.PageSize,
		buckets:    map[string]bool{},
		objects:    map[string]object{},
		versioning: map[string]string{},
		cors:       map[string]string{},
		heads:      map[string]headAnswer{},
	}
	if f.pageSize <= 0 {
		f.pageSize = 2
	}
	var srv *httptest.Server
	if opts.TLS {
		srv = httptest.NewTLSServer(f)
	} else {
		srv = httptest.NewServer(f)
	}
	t.Cleanup(srv.Close)
	return f, srv
}

// CreateBucket makes the bucket, as if it existed before the test.
func (f *S3) CreateBucket(bucket string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.buckets[bucket] = true
}

// DeleteBucket removes the bucket (not its objects), as if someone removed it.
func (f *S3) DeleteBucket(bucket string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.buckets, bucket)
}

// HasBucket reports whether the bucket exists.
func (f *S3) HasBucket(bucket string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.buckets[bucket]
}

// AnswerHead makes HeadBucket of `bucket` answer `status` without a body,
// with x-amz-bucket-region set to `region` when it is not empty: 301 is the
// documented answer for a bucket in another region, 400 is what an opt-in
// region (eu-central-2) answers, 403 is a bucket of another account.
func (f *S3) AnswerHead(bucket string, status int, region string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.heads[bucket] = headAnswer{status: status, region: region}
}

// Object returns the object's bytes and whether it exists.
func (f *S3) Object(bucket, key string) ([]byte, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.objects[bucket+"/"+key]
	return o.data, ok
}

// PutObject stores an object, as if it was written before.
func (f *S3) PutObject(bucket, key string, data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[bucket+"/"+key] = object{data: data, modified: time.Now()}
}

// DeleteObject removes an object, as if someone removed it.
func (f *S3) DeleteObject(bucket, key string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.objects, bucket+"/"+key)
}

// Keys returns the keys of every object in the bucket, sorted.
func (f *S3) Keys(bucket string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var keys []string
	for id := range f.objects {
		if k, ok := strings.CutPrefix(id, bucket+"/"); ok {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

// Versioning returns the bucket's versioning status: "", "Enabled" or
// "Suspended".
func (f *S3) Versioning(bucket string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.versioning[bucket]
}

// CORS returns the body of the bucket's last PutBucketCors, or "".
func (f *S3) CORS(bucket string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cors[bucket]
}

// Created returns the bodies of the CreateBucket requests, in order.
func (f *S3) Created() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.created...)
}

// Requests returns every request received, as "METHOD host path?query".
func (f *S3) Requests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requests...)
}

// Count returns the number of requests received.
func (f *S3) Count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

// Conditional returns the number of PUTs with If-None-Match "*", and of
// those the number refused with 412.
func (f *S3) Conditional() (sent, refused int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.conditional, f.refused
}

func xmlError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>fake</Message></Error>`, code)
}

func (f *S3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r.Method+" "+r.Host+" "+r.URL.RequestURI())
	q := r.URL.Query()
	if f.keyID != "" {
		auth := r.Header.Get("Authorization")
		if q.Get("X-Amz-Signature") != "" {
			auth = q.Get("X-Amz-Credential")
		}
		if !strings.Contains(auth, f.keyID+"/") {
			xmlError(w, http.StatusForbidden, "InvalidAccessKeyId")
			return
		}
	}
	bucket, key, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	body, err := readBody(r)
	if err != nil {
		xmlError(w, http.StatusBadRequest, "IncompleteBody")
		return
	}
	if key == "" {
		f.bucketOp(w, r, bucket, q, body)
		return
	}
	if !f.buckets[bucket] {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusNotFound) // HEAD has no body
		} else {
			xmlError(w, http.StatusNotFound, "NoSuchBucket")
		}
		return
	}
	id := bucket + "/" + key
	switch r.Method {
	case http.MethodPut:
		if status, code := checkLength(r, body); status != 0 {
			xmlError(w, status, code)
			return
		}
		if r.Header.Get("If-None-Match") == "*" {
			f.conditional++
			if _, ok := f.objects[id]; ok {
				f.refused++
				xmlError(w, http.StatusPreconditionFailed, "PreconditionFailed")
				return
			}
		}
		f.objects[id] = object{data: body, modified: time.Now()}
		w.Header().Set("ETag", `"`+MD5Hex(body)+`"`)
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
		w.Header().Set("ETag", `"`+MD5Hex(obj.data)+`"`)
		w.Header().Set("Last-Modified", obj.modified.UTC().Format(http.TimeFormat))
		w.Header().Set("Content-Length", strconv.Itoa(len(obj.data)))
		if r.Method == http.MethodGet {
			_, _ = w.Write(obj.data)
		}
	case http.MethodDelete:
		delete(f.objects, id)
		w.WriteHeader(http.StatusNoContent)
	default:
		xmlError(w, http.StatusMethodNotAllowed, "MethodNotAllowed")
	}
}

// checkLength refuses a PUT whose body does not have the length that was
// sent, as a provider does; a PUT without a length is refused too (S3
// answers 411 to a chunked transfer).
func checkLength(r *http.Request, body []byte) (int, string) {
	if strings.Contains(r.Header.Get("Content-Encoding"), "aws-chunked") {
		if d := r.Header.Get("X-Amz-Decoded-Content-Length"); d != "" && d != strconv.Itoa(len(body)) {
			return http.StatusBadRequest, "IncompleteBody"
		}
		return 0, ""
	}
	switch {
	case r.ContentLength < 0:
		return http.StatusLengthRequired, "MissingContentLength"
	case r.ContentLength != int64(len(body)):
		return http.StatusBadRequest, "IncompleteBody"
	}
	return 0, ""
}

func (f *S3) bucketOp(w http.ResponseWriter, r *http.Request, bucket string, q url.Values, body []byte) {
	switch {
	case r.Method == http.MethodHead:
		if a, ok := f.heads[bucket]; ok {
			if a.region != "" {
				w.Header().Set("X-Amz-Bucket-Region", a.region)
			}
			w.WriteHeader(a.status)
			return
		}
		if !f.buckets[bucket] {
			w.WriteHeader(http.StatusNotFound)
		}
	case r.Method == http.MethodPut && q.Has("versioning"):
		switch {
		case strings.Contains(string(body), "<Status>Enabled</Status>"):
			f.versioning[bucket] = "Enabled"
		case strings.Contains(string(body), "<Status>Suspended</Status>"):
			f.versioning[bucket] = "Suspended"
		}
	case r.Method == http.MethodGet && q.Has("versioning"):
		_, _ = fmt.Fprintf(w, `<VersioningConfiguration><Status>%s</Status></VersioningConfiguration>`, f.versioning[bucket])
	case r.Method == http.MethodPut && q.Has("cors"):
		f.cors[bucket] = string(body)
	case r.Method == http.MethodGet && q.Has("cors"):
		if f.cors[bucket] == "" {
			xmlError(w, http.StatusNotFound, "NoSuchCORSConfiguration")
			return
		}
		w.Header().Set("Content-Type", "application/xml")
		_, _ = io.WriteString(w, f.cors[bucket])
	case r.Method == http.MethodPut:
		f.buckets[bucket] = true
		f.created = append(f.created, string(body))
	case r.Method == http.MethodGet && q.Get("list-type") == "2":
		f.list(w, bucket, q)
	default:
		xmlError(w, http.StatusNotImplemented, "NotImplemented")
	}
}

func (f *S3) list(w http.ResponseWriter, bucket string, q url.Values) {
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
	truncated := len(keys) > f.pageSize
	if truncated {
		keys = keys[:f.pageSize]
	}
	type content struct {
		Key          string
		Size         int
		ETag         string
		LastModified string
	}
	out := struct {
		XMLName               xml.Name `xml:"ListBucketResult"`
		Name                  string
		Prefix                string
		KeyCount              int
		IsTruncated           bool
		NextContinuationToken string `xml:",omitempty"`
		Contents              []content
	}{Name: bucket, Prefix: prefix, KeyCount: len(keys), IsTruncated: truncated}
	for _, k := range keys {
		o := f.objects[bucket+"/"+k]
		out.Contents = append(out.Contents, content{Key: k, Size: len(o.data), ETag: `"` + MD5Hex(o.data) + `"`, LastModified: o.modified.UTC().Format("2006-01-02T15:04:05.000Z")})
	}
	if truncated {
		out.NextContinuationToken = keys[len(keys)-1]
	}
	w.Header().Set("Content-Type", "application/xml")
	_ = xml.NewEncoder(w).Encode(out)
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

// MD5Hex is the ETag the fake gives an object: the hex MD5 of its bytes, as
// S3 does for a single PUT.
func MD5Hex(b []byte) string { s := md5.Sum(b); return hex.EncodeToString(s[:]) }

// Transport sends every request to the fake's server and turns a
// virtual-host request into a path-style one: a host <bucket>.fake.test
// (a test endpoint "http://fake.test") or <bucket>.s3.<region>.amazonaws.com
// (the aws row's own endpoint). Any other host (a path-style endpoint, the
// ceph row) keeps its path. The original host stays in r.Host, so the fake
// records it.
func Transport(srv *httptest.Server) http.RoundTripper {
	target, _ := url.Parse(srv.URL)
	return rewrite{target: target, next: srv.Client().Transport}
}

type rewrite struct {
	target *url.URL
	next   http.RoundTripper
}

func (h rewrite) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	if r.Host == "" {
		r.Host = r.URL.Host
	}
	host := r.URL.Hostname()
	bucket, virtual := strings.CutSuffix(host, ".fake.test")
	if !virtual && strings.HasSuffix(host, ".amazonaws.com") {
		bucket, _, virtual = strings.Cut(host, ".s3.")
	}
	if virtual {
		r.URL.Path = "/" + bucket + r.URL.Path
		r.URL.RawPath = ""
	}
	r.URL.Scheme, r.URL.Host = h.target.Scheme, h.target.Host
	return h.next.RoundTrip(r)
}

// KeyFiles writes a fake key pair (the access key id `id` and Secret) into a
// temp directory, each file ending in a newline as the user's files do, and
// returns the two paths.
func KeyFiles(t testing.TB, id string) (accessKeyFile, secretKeyFile string) {
	t.Helper()
	dir := t.TempDir()
	accessKeyFile, secretKeyFile = filepath.Join(dir, "access"), filepath.Join(dir, "secret")
	if err := os.WriteFile(accessKeyFile, []byte(id+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secretKeyFile, []byte(Secret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return accessKeyFile, secretKeyFile
}
