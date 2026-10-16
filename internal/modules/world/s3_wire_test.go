package world

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
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
	ctx := context.Background()
	bucket, err := blob.OpenS3(ctx, blob.S3Config{
		Flavour: blob.FlavourAWS, Region: region, Bucket: bucketName, Prefix: prefix,
		AccessKeyFile: accessFile, SecretKeyFile: secretFile,
	}, BucketOptions())
	if err != nil {
		t.Fatalf("OpenS3: %v", err)
	}
	raw := rawClient(t, region, accessFile, secretFile)
	if v, err := raw.GetBucketVersioning(ctx, &s3.GetBucketVersioningInput{Bucket: aws.String(bucketName)}); err != nil || v.Status != "Enabled" {
		t.Fatalf("versioning = %v, %v; want Enabled", v, err)
	}
	t.Cleanup(func() { reportVersions(t, raw, bucketName, prefix+"/") })

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
	got := do(muxC, http.MethodGet, "/v1/worlds/"+sampleUID, nil, nil)
	want := buildSave(t, sampleYAML(), []byte("PNG"), map[string][]byte{"payload": []byte("body-1")})
	if got.Code != http.StatusOK || !bytes.Equal(got.Body.Bytes(), want) {
		t.Errorf("read back = %d, %d bytes, equal %v", got.Code, got.Body.Len(), bytes.Equal(got.Body.Bytes(), want))
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
