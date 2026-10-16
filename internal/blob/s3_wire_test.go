package blob

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// Wire tests against the real providers. Skipped unless their variable is
// set; they never print a key or a link.
//
// AWS: CASAS_TEST_S3_AWS=1. The key files default to the repository's
// dev/secrets/aws-access-key and dev/secrets/aws-secret-key (override with
// CASAS_TEST_S3_AWS_ACCESS_KEY_FILE / _SECRET_KEY_FILE). The identity is
// casas-eternas-dev (deploy/aws/storage.yaml): it may touch only the two
// buckets below, may not delete a bucket, and may not delete an object
// version on the worlds bucket. So:
//   - the buckets are fixed and made by Open on the first run;
//   - every object of a run is under test/<random>/ and is deleted at the
//     end; nothing is written to the worlds bucket (a delete there would
//     leave a version that this identity cannot remove);
//   - no bucket is ever deleted.
//
// Ceph: CASAS_TEST_S3_CEPH=1 with CASAS_TEST_S3_CEPH_ENDPOINT, _BUCKET,
// _ACCESS_KEY_FILE, _SECRET_KEY_FILE. No cloudscale bucket exists yet, so
// it has not run (2026-10-16).

const (
	awsRegion         = "eu-central-2"
	awsWorldsBucket   = "casas-eternas-dev-worlds"
	awsArtifactBucket = "casas-eternas-dev-artifacts"
)

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func runPrefix(t *testing.T) string {
	var r [6]byte
	_, _ = rand.Read(r[:])
	return "test/" + hex.EncodeToString(r[:]) + "/"
}

func awsConfig(t *testing.T, bucket, prefix string) S3Config {
	if os.Getenv("CASAS_TEST_S3_AWS") != "1" {
		t.Skip("set CASAS_TEST_S3_AWS=1 to run against AWS")
	}
	return S3Config{
		Flavour:       FlavourAWS,
		Region:        awsRegion,
		Bucket:        bucket,
		Prefix:        prefix,
		AccessKeyFile: envOr("CASAS_TEST_S3_AWS_ACCESS_KEY_FILE", "../../dev/secrets/aws-access-key"),
		SecretKeyFile: envOr("CASAS_TEST_S3_AWS_SECRET_KEY_FILE", "../../dev/secrets/aws-secret-key"),
	}
}

// cleanUp deletes every object under the run's prefix and checks that
// none is left.
func cleanUp(t *testing.T, b *S3) {
	t.Cleanup(func() {
		ctx := context.Background()
		var keys []string
		for info, err := range b.List(ctx, "") {
			if err != nil {
				t.Errorf("cleanup list: %v", err)
				return
			}
			keys = append(keys, info.Key)
		}
		for _, k := range keys {
			if err := b.Delete(ctx, k); err != nil {
				t.Errorf("cleanup delete %s: %v", k, err)
			}
		}
		for info, err := range b.List(ctx, "") {
			if err == nil {
				t.Errorf("cleanup left %s", info.Key)
			}
		}
		t.Logf("cleanup: %d objects deleted under the run prefix", len(keys))
	})
}

func TestAWSWire(t *testing.T) {
	prefix := runPrefix(t)
	ctx := context.Background()

	t.Run("worlds bucket: open and versioning", func(t *testing.T) {
		b, err := OpenS3(ctx, awsConfig(t, awsWorldsBucket, prefix), OpenOptions{Versioning: true})
		if err != nil {
			t.Fatalf("OpenS3: %v", err)
		}
		v, err := b.client.GetBucketVersioning(ctx, &s3.GetBucketVersioningInput{Bucket: aws.String(awsWorldsBucket)})
		if err != nil {
			t.Fatal(err)
		}
		if v.Status != types.BucketVersioningStatusEnabled {
			t.Errorf("versioning = %q, want Enabled", v.Status)
		}
	})

	cors := []CORSRule{{
		AllowedOrigins: []string{"http://localhost:5173"},
		AllowedMethods: []string{"GET", "HEAD"},
		AllowedHeaders: []string{"*"},
		ExposeHeaders:  []string{"ETag"},
		MaxAge:         time.Hour,
	}}
	b, err := OpenS3(ctx, awsConfig(t, awsArtifactBucket, prefix), OpenOptions{CORS: cors})
	if err != nil {
		t.Fatalf("OpenS3 artifacts: %v", err)
	}
	cleanUp(t, b)

	t.Run("CORS as configured", func(t *testing.T) {
		out, err := b.client.GetBucketCors(ctx, &s3.GetBucketCorsInput{Bucket: aws.String(awsArtifactBucket)})
		if err != nil {
			t.Fatal(err)
		}
		if len(out.CORSRules) != 1 {
			t.Fatalf("CORS rules = %d, want 1", len(out.CORSRules))
		}
		r := out.CORSRules[0]
		if !slices.Equal(r.AllowedOrigins, cors[0].AllowedOrigins) || !slices.Equal(r.AllowedMethods, cors[0].AllowedMethods) ||
			!slices.Equal(r.ExposeHeaders, cors[0].ExposeHeaders) || aws.ToInt32(r.MaxAgeSeconds) != 3600 {
			t.Errorf("CORS rule = %+v", r)
		}
	})

	t.Run("objects", func(t *testing.T) { wireObjects(t, b) })

	t.Run("default checksums accepted", func(t *testing.T) {
		put(t, b, "sum", "checksum me")
		out, err := b.client.HeadObject(ctx, &s3.HeadObjectInput{
			Bucket: aws.String(awsArtifactBucket), Key: aws.String(prefix + "sum"), ChecksumMode: types.ChecksumModeEnabled,
		})
		if err != nil {
			t.Fatal(err)
		}
		if out.ChecksumCRC32 == nil {
			t.Error("no CRC32 stored: the SDK's default checksum did not arrive")
		}
		t.Logf("measured: PutObject with the default checksum accepted; stored CRC32 present = %v", out.ChecksumCRC32 != nil)
		// A body that cannot seek: over TLS the SDK sends it chunked with
		// a trailing checksum.
		body := io.MultiReader(strings.NewReader("no "), strings.NewReader("seek"))
		if _, err := b.Put(ctx, "stream", body, 7, PutOptions{}); err != nil {
			t.Errorf("Put of a body that cannot seek: %v", err)
		} else if got := get(t, b, "stream"); got != "no seek" {
			t.Errorf("stream = %q", got)
		}
	})

	t.Run("conditional put", func(t *testing.T) {
		if _, err := b.Put(ctx, "once", strings.NewReader("1"), 1, PutOptions{IfAbsent: true}); err != nil {
			t.Fatalf("first IfAbsent: %v", err)
		}
		_, err := b.Put(ctx, "once", strings.NewReader("2"), 1, PutOptions{IfAbsent: true})
		if err != ErrExists {
			t.Errorf("second IfAbsent = %v, want ErrExists", err)
		}
		if got := get(t, b, "once"); got != "1" {
			t.Errorf("object = %q, want 1", got)
		}
	})

	t.Run("presigned links over plain HTTP", func(t *testing.T) { wireLinks(t, b) })

	t.Run("CORS answers a presigned GET", func(t *testing.T) {
		put(t, b, "cors", "x")
		link, err := b.PresignGet(ctx, "cors", time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		link.Header = http.Header{"Origin": {"http://localhost:5173"}}
		req, _ := http.NewRequest(link.Method, link.URL, nil)
		req.Header = link.Header
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("send: %v", errors.Unwrap(err))
		}
		_ = resp.Body.Close()
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
			t.Errorf("Access-Control-Allow-Origin = %q (status %d)", got, resp.StatusCode)
		}
	})

	t.Run("wrong region named", func(t *testing.T) {
		for _, wrong := range []string{"eu-west-1", "us-east-1"} {
			cfg := awsConfig(t, awsArtifactBucket, prefix)
			cfg.Region = wrong
			_, err := OpenS3(ctx, cfg, OpenOptions{})
			if err == nil || !strings.Contains(err.Error(), "is in region "+awsRegion) {
				t.Errorf("region %s: %v", wrong, err)
				continue
			}
			t.Logf("measured: signed for %s: %s", wrong, err)
		}
	})
}

func wireObjects(t *testing.T, b *S3) {
	ctx := context.Background()
	info := put(t, b, "a/b", "hello")
	if info.Size != 5 || info.ETag == "" {
		t.Errorf("Put info = %+v", info)
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
	b.pageSize = 2
	if got, want := listKeys(t, b, "a/"), []string{"a/b", "a/c", "a/d", "a/e"}; !slices.Equal(got, want) {
		t.Errorf("List over pages = %v, want %v", got, want)
	}
	b.pageSize = 0
	if err := b.Delete(ctx, "a/b"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := b.Delete(ctx, "a/b"); err != nil {
		t.Errorf("Delete of a missing key = %v", err)
	}
	if _, _, err := b.Get(ctx, "a/b"); err != ErrNotFound {
		t.Errorf("Get missing = %v, want ErrNotFound", err)
	}
	if _, err := b.Head(ctx, "a/b"); err != ErrNotFound {
		t.Errorf("Head missing = %v, want ErrNotFound", err)
	}
}

func wireLinks(t *testing.T, b *S3) {
	ctx := context.Background()
	put(t, b, "linked", "by link")
	link, err := b.PresignGet(ctx, "linked", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if code, body := do(t, link, nil); code != http.StatusOK || body != "by link" {
		t.Errorf("presigned GET = %d %q", code, body)
	}

	payload := []byte("uploaded by link")
	pl, err := b.PresignPut(ctx, "uploaded", time.Minute, int64(len(payload)))
	if err != nil {
		t.Fatal(err)
	}
	lower := strings.ToLower(pl.URL)
	if strings.Contains(lower, "x-amz-checksum") || strings.Contains(lower, "x-amz-sdk-checksum") {
		t.Error("the presigned PUT carries checksum parameters")
	}
	var signed []string
	for k := range pl.Header {
		signed = append(signed, k)
	}
	slices.Sort(signed)
	t.Logf("measured: presigned PUT signs headers %v", signed)
	if code, body := do(t, pl, payload); code != http.StatusOK {
		t.Errorf("presigned PUT = %d %s", code, firstLine(body))
	} else if got := get(t, b, "uploaded"); got != string(payload) {
		t.Errorf("uploaded = %q", got)
	}
	// Another length than the signed one.
	short, err := b.PresignPut(ctx, "short", time.Minute, 3)
	if err != nil {
		t.Fatal(err)
	}
	code, _ := do(t, short, []byte("four"))
	t.Logf("measured: presigned PUT with another length answers %d", code)
	if code/100 == 2 {
		t.Error("a PUT with another length than the signed one was accepted")
	}

	// Expired: a 1-second link two seconds later.
	exp, err := b.PresignGet(ctx, "linked", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Second)
	code, _ = do(t, exp, nil)
	t.Logf("measured: expired presigned GET answers %d", code)
	if code != http.StatusForbidden {
		t.Errorf("expired link = %d, want 403", code)
	}
}

// do sends a link with net/http alone, as a browser or a worker would.
func do(t *testing.T, l Link, body []byte) (int, string) {
	t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(l.Method, l.URL, r)
	if err != nil {
		t.Fatal(errors.New("bad link")) // never the link itself
	}
	for k, v := range l.Header {
		if k == "Content-Length" {
			continue // net/http sets it from the body
		}
		req.Header[k] = v
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("send: %v", errors.Unwrap(err)) // the url.Error holds the link
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(raw)
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(s, "\n")
	return s
}

func TestCephWire(t *testing.T) {
	if os.Getenv("CASAS_TEST_S3_CEPH") != "1" {
		t.Skip("set CASAS_TEST_S3_CEPH=1 (and its _ENDPOINT, _BUCKET, _ACCESS_KEY_FILE, _SECRET_KEY_FILE) to run against Ceph RGW; no cloudscale bucket exists yet")
	}
	cfg := S3Config{
		Flavour:       FlavourCeph,
		Region:        os.Getenv("CASAS_TEST_S3_CEPH_REGION"),
		Endpoint:      os.Getenv("CASAS_TEST_S3_CEPH_ENDPOINT"),
		Bucket:        os.Getenv("CASAS_TEST_S3_CEPH_BUCKET"),
		Prefix:        runPrefix(t),
		AccessKeyFile: os.Getenv("CASAS_TEST_S3_CEPH_ACCESS_KEY_FILE"),
		SecretKeyFile: os.Getenv("CASAS_TEST_S3_CEPH_SECRET_KEY_FILE"),
	}
	b, err := OpenS3(context.Background(), cfg, OpenOptions{})
	if err != nil {
		t.Fatalf("OpenS3: %v", err)
	}
	cleanUp(t, b)
	t.Run("objects", func(t *testing.T) { wireObjects(t, b) })
	t.Run("presigned links over plain HTTP", func(t *testing.T) { wireLinks(t, b) })
}
