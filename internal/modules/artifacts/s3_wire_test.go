package artifacts

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

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
	m, mux := newModule(t, bucket, identity.NewResolver(config.AuthNone, nil), adminWorlds())
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

	// A worker's write (DEC-0038, step 4): a write link from the module, a
	// presigned PUT straight to the bucket without the caller's
	// credentials, then the commit, which makes it readable by the 302.
	workerBytes := bytes.Repeat([]byte("worker-bytes-"), 20_000) // ~254 KiB
	linkFor := func(name string, size int) writeLinkResponse {
		t.Helper()
		res, err := http.Post(srv.URL+"/v1/artifacts/"+minted.ArtifactUID+"/write-link", "application/json",
			strings.NewReader(`{"name":"`+name+`","size":`+strconv.Itoa(size)+`}`))
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = res.Body.Close() }()
		var link writeLinkResponse
		if res.StatusCode != http.StatusOK || json.NewDecoder(res.Body).Decode(&link) != nil {
			t.Fatalf("write-link %s = %d", name, res.StatusCode)
		}
		return link
	}
	upload := func(link writeLinkResponse, target string, body []byte) int {
		t.Helper()
		req, _ := http.NewRequest(link.Method, target, bytes.NewReader(body))
		for name, value := range link.Header {
			req.Header.Set(name, value)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
		return res.StatusCode
	}
	link := linkFor("worker.bin", len(workerBytes))
	if !strings.Contains(link.URL, ".amazonaws.com/") {
		t.Fatal("the write link does not go to the bucket")
	}
	// Trust: the link writes exactly its key with exactly its length.
	other := strings.Replace(link.URL, "/worker.bin?", "/other.bin?", 1)
	code := upload(link, other, workerBytes)
	t.Logf("measured: key A's presigned PUT used for key B answers %d", code)
	if code != http.StatusForbidden {
		t.Errorf("key A's link for key B = %d, want 403", code)
	}
	code = upload(link, link.URL, workerBytes[:len(workerBytes)-1])
	t.Logf("measured: a presigned PUT with another length answers %d", code)
	if code != http.StatusForbidden {
		t.Errorf("another length = %d, want 403", code)
	}
	if _, err := bucket.Head(ctx, minted.ArtifactUID+"/other.bin"); !errors.Is(err, blob.ErrNotFound) {
		t.Errorf("key B was written: %v", err)
	}
	// Expired: the refusal the worker answers with a fresh link.
	short, err := m.store.WriteLink(ctx, minted.ArtifactUID, "worker.bin", int64(len(workerBytes)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Until(short.Expires) + 1500*time.Millisecond)
	code = upload(writeLinkResponse{Method: short.Method, URL: short.URL}, short.URL, workerBytes)
	t.Logf("measured: an expired presigned PUT answers %d", code)
	if code != http.StatusForbidden {
		t.Errorf("expired write link = %d, want 403", code)
	}
	if code := upload(link, link.URL, workerBytes); code != http.StatusOK {
		t.Fatalf("upload by link = %d", code)
	}
	beforeCommit, err := noRedirect().Get(srv.URL + "/v1/artifacts/" + minted.ArtifactUID + "/worker.bin")
	if err != nil {
		t.Fatal(err)
	}
	_ = beforeCommit.Body.Close()
	if beforeCommit.StatusCode != http.StatusNotFound {
		t.Errorf("read before the commit = %d, want 404", beforeCommit.StatusCode)
	}
	commitBody := `{"files":[{"name":"worker.bin","size":` + strconv.Itoa(len(workerBytes)) + `}]}`
	committed, err := http.Post(srv.URL+"/v1/artifacts/"+minted.ArtifactUID+"/commit", "application/json", strings.NewReader(commitBody))
	if err != nil {
		t.Fatal(err)
	}
	_ = committed.Body.Close()
	if committed.StatusCode != http.StatusNoContent {
		t.Fatalf("commit = %d", committed.StatusCode)
	}
	readBack, err := http.Get(srv.URL + "/v1/artifacts/" + minted.ArtifactUID + "/worker.bin")
	if err != nil {
		t.Fatal(err)
	}
	gotWorker, _ := io.ReadAll(readBack.Body)
	_ = readBack.Body.Close()
	if readBack.StatusCode != http.StatusOK || !bytes.Equal(gotWorker, workerBytes) || !strings.HasSuffix(readBack.Request.URL.Host, ".amazonaws.com") {
		t.Errorf("read after the commit = %d, %d bytes from %s", readBack.StatusCode, len(gotWorker), readBack.Request.URL.Host)
	}
	// The meta last, as a writer writes it: after it the artifact is whole
	// and takes no more uploads by link.
	put("meta.json", []byte(metaFor(key, "wire")))

	// A restart: the index comes from the bucket's listing and the metas.
	restarted, err := NewStore(ctx, bucket, 0)
	if err != nil {
		t.Fatal(err)
	}
	if uid, files, err := restarted.Resolve(ctx, key, false); err != nil || uid != minted.ArtifactUID || len(files) != 3 {
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
	first, err := noRedirect().Get(srv.URL + "/v1/artifacts/" + minted.ArtifactUID + "/elevation.u16")
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
	if _, err := restarted.RemoveTerrain(ctx, key.WorldID); err != nil {
		t.Fatal(err)
	}
	for info, err := range bucket.List(ctx, "") {
		if err == nil {
			t.Errorf("left after RemoveTerrain: %s", info.Key)
		}
	}
}

// noRedirect is a client that answers the redirect itself.
func noRedirect() *http.Client {
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
