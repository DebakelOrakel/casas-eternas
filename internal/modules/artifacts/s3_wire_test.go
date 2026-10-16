package artifacts

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/blob"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
)

// The artifact store on the real AWS bucket, end to end through the module
// (DEC-0038, step 3). Skipped unless CASAS_TEST_S3_AWS=1; the key files are
// the repository's dev/secrets ones (or CASAS_TEST_S3_AWS_ACCESS_KEY_FILE /
// _SECRET_KEY_FILE), the identity casas-eternas-dev
// (deploy/aws/storage.yaml). Every object is under test/<random>/ of the
// artifacts bucket and is deleted at the end; the bucket is never deleted.
// It never prints a key or a link.
func TestAWSWireArtifacts(t *testing.T) {
	if os.Getenv("CASAS_TEST_S3_AWS") != "1" {
		t.Skip("set CASAS_TEST_S3_AWS=1 to run against AWS")
	}
	env := func(name, fallback string) string {
		if v := os.Getenv(name); v != "" {
			return v
		}
		return fallback
	}
	var r [6]byte
	_, _ = rand.Read(r[:])
	prefix := "test/" + hex.EncodeToString(r[:])
	ctx := context.Background()
	bucket, err := blob.OpenS3(ctx, blob.S3Config{
		Flavour:       blob.FlavourAWS,
		Region:        "eu-central-2",
		Bucket:        "casas-eternas-dev-artifacts",
		Prefix:        prefix,
		AccessKeyFile: env("CASAS_TEST_S3_AWS_ACCESS_KEY_FILE", "../../../dev/secrets/aws-access-key"),
		SecretKeyFile: env("CASAS_TEST_S3_AWS_SECRET_KEY_FILE", "../../../dev/secrets/aws-secret-key"),
	}, BucketOptions())
	if err != nil {
		t.Fatalf("OpenS3: %v", err)
	}
	t.Cleanup(func() {
		var keys []string
		for info, err := range bucket.List(context.Background(), "") {
			if err != nil {
				t.Errorf("cleanup list: %v", err)
				return
			}
			keys = append(keys, info.Key)
		}
		for _, k := range keys {
			if err := bucket.Delete(context.Background(), k); err != nil {
				t.Errorf("cleanup delete: %v", err)
			}
		}
		for info, err := range bucket.List(context.Background(), "") {
			if err == nil {
				t.Errorf("left after cleanup: %s", info.Key)
			}
		}
	})
	rank := func(context.Context, string, string) (bool, access.Level) { return true, access.Admin }
	_, mux := newModule(t, bucket, identity.NewResolver(config.AuthNone, nil), rank)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	key := testKey()
	keyJSON, _ := json.Marshal(key)
	createBody := strings.TrimSuffix(string(keyJSON), "}") + `,"create":true}`
	response, err := http.Post(srv.URL+"/v1/artifacts/resolve", "application/json", strings.NewReader(createBody))
	if err != nil {
		t.Fatal(err)
	}
	var minted struct {
		ArtifactUID string `json:"artifactUid"`
	}
	_ = json.NewDecoder(response.Body).Decode(&minted)
	_ = response.Body.Close()
	if minted.ArtifactUID == "" {
		t.Fatalf("resolve = %d", response.StatusCode)
	}

	// Uploads through the server: a body that cannot seek (the request's),
	// with its length, as the browser and the worker send it.
	payload := bytes.Repeat([]byte("artifact-bytes-"), 70_000) // ~1 MiB
	put := func(name string, body []byte) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPut, srv.URL+"/v1/artifacts/"+minted.ArtifactUID+"/"+name, bytes.NewReader(body))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusNoContent {
			t.Fatalf("put %s = %d", name, res.StatusCode)
		}
	}
	put("elevation.u16", payload)
	put("meta.json", []byte(metaFor(key, "wire")))

	// A restart: the index comes from the bucket's listing and the metas.
	restarted, err := NewStore(ctx, bucket, 0)
	if err != nil {
		t.Fatal(err)
	}
	if uid, files, err := restarted.Resolve(ctx, key, false); err != nil || uid != minted.ArtifactUID || len(files) != 2 {
		t.Fatalf("after restart: %q %v %v", uid, files, err)
	}

	// The read: 302 to a presigned GET on AWS, followed by Go's client
	// with the caller's Authorization header, which it drops on a redirect
	// to another host (S3 refuses a request that carries two kinds of
	// authorization).
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/v1/artifacts/"+minted.ArtifactUID+"/elevation.u16", nil)
	req.Header.Set("Authorization", "Bearer some-session")
	req.Header.Set("Origin", "https://casas.example")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK || !bytes.Equal(got, payload) {
		t.Fatalf("followed read = %d, %d bytes (want %d)", res.StatusCode, len(got), len(payload))
	}
	if !strings.HasSuffix(res.Request.URL.Host, ".amazonaws.com") {
		t.Errorf("the bytes came from %s, want the bucket", res.Request.URL.Host)
	}
	// The bucket's CORS rule answers a browser's origin.
	if acao := res.Header.Get("Access-Control-Allow-Origin"); acao != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", acao)
	}

	// What a client that KEPT the Authorization header on the redirect
	// would get: measured, not asserted (the Fetch standard drops it on a
	// cross-origin redirect; Go and Node do).
	noFollow := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	first, err := noFollow.Get(srv.URL + "/v1/artifacts/" + minted.ArtifactUID + "/elevation.u16")
	if err != nil {
		t.Fatal(err)
	}
	_ = first.Body.Close()
	kept, _ := http.NewRequest(http.MethodGet, first.Header.Get("Location"), nil)
	kept.Header.Set("Authorization", "Bearer some-session")
	keptRes, err := http.DefaultClient.Do(kept)
	if err != nil {
		t.Fatal(err)
	}
	_ = keptRes.Body.Close()
	t.Logf("a presigned GET with an Authorization header too answers %d", keptRes.StatusCode)

	// Removal deletes the objects in the bucket.
	if err := restarted.RemoveWorld(ctx, key.WorldUID); err != nil {
		t.Fatal(err)
	}
	for info, err := range bucket.List(ctx, "") {
		if err == nil {
			t.Errorf("left after RemoveWorld: %s", info.Key)
		}
	}
}
