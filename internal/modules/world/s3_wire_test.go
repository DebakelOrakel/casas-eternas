package world

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/DebakelOrakel/casas-eternas/internal/blob"
)

// The world store on the real AWS bucket (DEC-0038, step 5). Skipped unless
// CASAS_TEST_S3_AWS=1; the key files are the repository's dev/secrets ones
// (or CASAS_TEST_S3_AWS_ACCESS_KEY_FILE / _SECRET_KEY_FILE), the identity
// casas-eternas-dev (deploy/aws/storage.yaml). Everything is under
// test/<random>/ of the worlds bucket.
//
// WHAT STAYS. The worlds bucket is versioned and the identity may not delete
// a version (s3:DeleteObjectVersion is not granted, on purpose). So every
// object this test writes stays as a noncurrent version, and every delete
// leaves a delete marker; the test deletes what it wrote (the current view
// under the prefix is empty at the end) and logs the versions and markers
// that stay. Kept small on purpose: a few objects of some hundred bytes.
// An operator cleans them (a lifecycle rule for noncurrent versions and
// expired delete markers under test/, or a deletion by an admin identity),
// docs/operations/concepts.md.
//
// It never prints a key or a link.
func TestAWSWireWorlds(t *testing.T) {
	ctx := context.Background()
	bucket, raw, bucketName := openAWSWorlds(t)
	if v, err := raw.GetBucketVersioning(ctx, &s3.GetBucketVersioningInput{Bucket: aws.String(bucketName)}); err != nil || v.Status != "Enabled" {
		t.Fatalf("versioning = %v, %v; want Enabled", v, err)
	}

	a := newTestStoreOn(t, bucket, 3)
	_, muxA := adminModule(a)
	if got := upload(t, muxA, sampleUID, ""); got.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", got.Code, got.Body)
	}
	// A second writer, indexed at revision 1 (outside the model, what the
	// conditional write is for).
	b := newTestStoreOn(t, bucket, 3)
	_, muxB := adminModule(b)
	if got := upload(t, muxA, sampleUID, "1").Code; got != http.StatusOK {
		t.Fatalf("update = %d", got)
	}
	// B's stale update meets A's revision 2: If-None-Match "*" answers 412,
	// and nothing of B's is stored.
	if got := upload(t, muxB, sampleUID, "1").Code; got != http.StatusPreconditionFailed {
		t.Errorf("the second writer's update = %d, want 412", got)
	}

	// A restart: the index from the listing.
	c := newTestStoreOn(t, bucket, 3)
	list, err := c.List(ctx)
	if err != nil || len(list) != 1 || list[0].Revision != 2 {
		t.Fatalf("after a restart: %+v, %v", list, err)
	}
	_, muxC := adminModule(c)
	code, body := follow(t, muxC, bucket, "/v1/worlds/"+sampleUID)
	want := buildSave(t, sampleYAML(), []byte("PNG"), map[string][]byte{"payload": []byte("body-1")})
	if code != http.StatusOK || !bytes.Equal(body, want) {
		t.Errorf("read back = %d, %d bytes, equal %v", code, len(body), bytes.Equal(body, want))
	}

	// Delete, then create the same uid again: the conditional writes meet
	// the delete markers that the delete left (a user who deletes the
	// server's copy and saves the local one again).
	if got := do(muxC, http.MethodDelete, "/v1/worlds/"+sampleUID, nil, nil).Code; got != http.StatusNoContent {
		t.Fatalf("delete = %d", got)
	}
	if got := upload(t, muxC, sampleUID, ""); got.Code != http.StatusCreated || got.Header().Get("ETag") != `"1"` {
		t.Errorf("create over delete markers = %d, ETag %s; want 201 at revision 1", got.Code, got.Header().Get("ETag"))
	}
	if got := do(muxC, http.MethodDelete, "/v1/worlds/"+sampleUID, nil, nil).Code; got != http.StatusNoContent {
		t.Fatalf("second delete = %d", got)
	}
	for info, err := range bucket.List(ctx, "") {
		if err == nil {
			t.Errorf("current object left: %s", info.Key)
		}
	}
}

// openAWSWorlds opens the dev worlds bucket under a fresh test/<random>
// prefix, with the store's BucketOptions, or skips. The cleanup logs what
// the test leaves (reportVersions).
func openAWSWorlds(t *testing.T) (*blob.S3, *s3.Client, string) {
	t.Helper()
	if os.Getenv("CASAS_TEST_S3_AWS") != "1" {
		t.Skip("set CASAS_TEST_S3_AWS=1 to run against AWS")
	}
	env := func(name, fallback string) string {
		if v := os.Getenv(name); v != "" {
			return v
		}
		return fallback
	}
	const region, bucketName = "eu-central-2", "casas-eternas-dev-worlds"
	accessFile := env("CASAS_TEST_S3_AWS_ACCESS_KEY_FILE", "../../../dev/secrets/aws-access-key")
	secretFile := env("CASAS_TEST_S3_AWS_SECRET_KEY_FILE", "../../../dev/secrets/aws-secret-key")
	var r [6]byte
	_, _ = rand.Read(r[:])
	prefix := "test/" + hex.EncodeToString(r[:])
	bucket, err := blob.OpenS3(context.Background(), blob.S3Config{
		Flavour: blob.FlavourAWS, Region: region, Bucket: bucketName, Prefix: prefix,
		AccessKeyFile: accessFile, SecretKeyFile: secretFile,
	}, BucketOptions())
	if err != nil {
		t.Fatalf("OpenS3: %v", err)
	}
	raw := rawClient(t, region, accessFile, secretFile)
	t.Cleanup(func() { reportVersions(t, raw, bucketName, prefix+"/") })
	return bucket, raw, bucketName
}

// The reads by link against AWS, with ONE upload (each write leaves a
// version on this bucket): the zip and the preview answer 302 to a
// presigned GET; Go's client follows it from a real server and drops the
// caller's Authorization on the cross-origin redirect (else AWS answers
// 400); the bucket answers a GET with an Origin with
// `Access-Control-Allow-Origin: *`; the 304 comes before any redirect.
// Run alone: go test -run TestAWSWireWorldLinks ./internal/modules/world
// with CASAS_TEST_S3_AWS=1.
func TestAWSWireWorldLinks(t *testing.T) {
	ctx := context.Background()
	bucket, raw, bucketName := openAWSWorlds(t)
	if cors, err := raw.GetBucketCors(ctx, &s3.GetBucketCorsInput{Bucket: aws.String(bucketName)}); err != nil || len(cors.CORSRules) != 1 || cors.CORSRules[0].AllowedOrigins[0] != "*" {
		t.Errorf("the bucket's CORS rule = %+v, %v; want the read-link rule", cors, err)
	}
	store := newTestStoreOn(t, bucket, 3)
	_, mux := adminModule(store)
	save := buildSave(t, sampleYAML(), []byte("PNG"), nil)
	if got := do(mux, http.MethodPut, "/v1/worlds/"+sampleUID, save, nil); got.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", got.Code, got.Body)
	}
	t.Cleanup(func() { _ = store.Delete(ctx, sampleUID) })

	srv := httptest.NewServer(mux)
	defer srv.Close()
	read := func(path string, header http.Header) (*http.Response, []byte) {
		t.Helper()
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+path, nil)
		request.Header = header
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = response.Body.Close() }()
		body, _ := io.ReadAll(response.Body)
		return response, body
	}
	// A caller's Authorization and an Origin, as a browser or a worker
	// sends them: Go keeps the Origin and drops the Authorization on the
	// redirect to another host.
	header := http.Header{"Authorization": {"Bearer not-for-the-bucket"}, "Origin": {"https://casas.example"}}
	response, body := read("/v1/worlds/"+sampleUID, header)
	if response.StatusCode != http.StatusOK || !bytes.Equal(body, save) {
		t.Errorf("zip by link = %d, %d bytes, equal %v", response.StatusCode, len(body), bytes.Equal(body, save))
	}
	if !strings.HasSuffix(response.Request.URL.Host, ".amazonaws.com") {
		t.Errorf("the zip came from %s, want the bucket", response.Request.URL.Host)
	}
	if got := response.Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
	if got := response.Header.Get("Content-Type"); got != "application/zip" {
		t.Errorf("Content-Type = %q", got)
	}
	response, body = read("/v1/worlds/"+sampleUID+"/preview.png", header)
	if response.StatusCode != http.StatusOK || string(body) != "PNG" {
		t.Errorf("preview by link = %d %q", response.StatusCode, body)
	}
	response, _ = read("/v1/worlds/"+sampleUID, http.Header{"If-None-Match": {`"1"`}})
	if response.StatusCode != http.StatusNotModified || response.Request.URL.Host != strings.TrimPrefix(srv.URL, "http://") {
		t.Errorf("If-None-Match of the revision = %d from %s, want 304 from the server", response.StatusCode, response.Request.URL.Host)
	}
}

// rawClient is an SDK client of its own, for what the leaf does not do:
// read the bucket's versioning and list the versions.
func rawClient(t *testing.T, region, accessFile, secretFile string) *s3.Client {
	t.Helper()
	read := func(path string) string {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("reading a key file: %v", err) // the path's error, no content
		}
		return strings.TrimSpace(string(b))
	}
	id, secret := read(accessFile), read(secretFile)
	return s3.New(s3.Options{
		Region: region,
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return aws.Credentials{AccessKeyID: id, SecretAccessKey: secret}, nil
		}),
	})
}

// reportVersions logs the versions and delete markers under the prefix:
// what this run leaves in the bucket.
func reportVersions(t *testing.T, client *s3.Client, bucket, prefix string) {
	var versions, markers int
	var size int64
	pages := s3.NewListObjectVersionsPaginator(client, &s3.ListObjectVersionsInput{Bucket: aws.String(bucket), Prefix: aws.String(prefix)})
	for pages.HasMorePages() {
		page, err := pages.NextPage(context.Background())
		if err != nil {
			t.Errorf("listing the versions: %v", err)
			return
		}
		for _, v := range page.Versions {
			versions++
			size += aws.ToInt64(v.Size)
		}
		markers += len(page.DeleteMarkers)
	}
	t.Logf("left under %s: %d versions (%d bytes), %d delete markers", prefix, versions, size, markers)
}
