package artifacts

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// The pipeline builds (PipelineWorld): the jobs module puts them in this
// process; everyone reads them, the anonymous caller too; no HTTP caller
// writes them, not even a job; only the operator removes them; every
// listing shows them.
func TestPipelineBuildsHaveTheirOwnRules(t *testing.T) {
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatal(err)
	}
	user, _, err := tokens.IssueSession("someone", false, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	admin, _, err := tokens.IssueSession("root", true, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	job, _, err := tokens.IssueJob("job-1", "a754f0db-ff5c-4b45-9f2c-1b4e7a30d001", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	m, mux := newModule(t, openTestDir(t, t.TempDir()), identity.NewResolver(config.AuthPassword, tokens), noWorlds())
	ctx := context.Background()

	if _, err := m.PipelineFileLink(ctx, "v11-x", "pipeline.mjs"); err != ErrNotFound {
		t.Fatalf("before the put: %v, want ErrNotFound", err)
	}
	if err := m.PutPipelineFile(ctx, "v11-x", "pipeline.mjs", []byte("the module")); err != nil {
		t.Fatal(err)
	}
	link, err := m.PipelineFileLink(ctx, "v11-x", "pipeline.mjs")
	if err != nil || !strings.HasPrefix(link, LinkBase) {
		t.Fatalf("link %q, %v", link, err)
	}

	// Read: a resolve and the file, without a caller.
	resolveBody := `{"worldId":"` + PipelineWorld + `","pipelineVersion":"v11-x","stage":"pipeline.mjs"}`
	resolved := doAs(mux, http.MethodPost, "/v1/artifacts/resolve", resolveBody, "")
	var found resolveResponse
	if resolved.Code != http.StatusOK || json.Unmarshal(resolved.Body.Bytes(), &found) != nil {
		t.Fatalf("anonymous resolve = %d", resolved.Code)
	}
	read := follow(t, mux, "/v1/artifacts/"+found.ArtifactUID+"/pipeline.mjs", "")
	if body, _ := io.ReadAll(read.Body); read.Code != http.StatusOK || string(body) != "the module" {
		t.Errorf("anonymous read = %d %q", read.Code, body)
	}

	// Write: refused to every caller, a job and the admin too.
	createBody := strings.TrimSuffix(resolveBody, "}") + `,"create":true}`
	for name, bearer := range map[string]string{"job": job, "admin": admin, "user": user} {
		if got := doAs(mux, http.MethodPost, "/v1/artifacts/resolve", createBody, bearer).Code; got != http.StatusForbidden {
			t.Errorf("%s resolve with create = %d, want 403", name, got)
		}
		if got := doAs(mux, http.MethodPut, "/v1/artifacts/"+found.ArtifactUID+"/pipeline.mjs", "other", bearer).Code; got != http.StatusForbidden {
			t.Errorf("%s PUT = %d, want 403", name, got)
		}
	}

	// The jobs module of another process writes with its own credential:
	// the reserve, the file and the meta.
	module, _, err := tokens.IssuePipelineFiles("jobs", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	otherBody := `{"worldId":"` + PipelineWorld + `","pipelineVersion":"v11-x","stage":"pipeline.json","create":true}`
	created := doAs(mux, http.MethodPost, "/v1/artifacts/resolve", otherBody, module)
	var minted resolveResponse
	if created.Code != http.StatusOK || json.Unmarshal(created.Body.Bytes(), &minted) != nil {
		t.Fatalf("module resolve with create = %d", created.Code)
	}
	if got := doAs(mux, http.MethodPut, "/v1/artifacts/"+minted.ArtifactUID+"/pipeline.json", "{}", module).Code; got != http.StatusNoContent {
		t.Errorf("module PUT = %d, want 204", got)
	}
	meta := `{"key":{"worldId":"` + PipelineWorld + `","pipelineVersion":"v11-x","stage":"pipeline.json"},"createdAt":1}`
	if got := doAs(mux, http.MethodPut, "/v1/artifacts/"+minted.ArtifactUID+"/meta.json", meta, module).Code; got != http.StatusNoContent {
		t.Errorf("module PUT meta = %d, want 204", got)
	}
	if _, err := m.PipelineFileLink(ctx, "v11-x", "pipeline.json"); err != nil {
		t.Errorf("the module's file is not whole: %v", err)
	}
	// Its credential writes no world's artifacts.
	worldBody := `{"worldId":"ba90bda173d581ef","pipelineVersion":"v11-x","stage":"L1","create":true}`
	if got := doAs(mux, http.MethodPost, "/v1/artifacts/resolve", worldBody, module).Code; got == http.StatusOK {
		t.Error("the module's credential reserved a world's artifact")
	}

	// Listed for everyone, removable by nobody but the operator.
	var listed struct {
		Artifacts []callerArtifact `json:"artifacts"`
	}
	_ = json.Unmarshal(doAs(mux, http.MethodGet, "/v1/artifacts", "", user).Body.Bytes(), &listed)
	if len(listed.Artifacts) != 2 || listed.Artifacts[0].WorldID != PipelineWorld || len(listed.Artifacts[0].Actions) != 0 {
		t.Errorf("a user's listing = %+v", listed.Artifacts)
	}
	if got := doAs(mux, http.MethodDelete, "/v1/artifacts/"+found.ArtifactUID, "", user).Code; got != http.StatusForbidden {
		t.Errorf("user remove = %d, want 403", got)
	}
	if got := doAs(mux, http.MethodDelete, "/v1/artifacts/"+found.ArtifactUID, "", admin).Code; got != http.StatusNoContent {
		t.Errorf("admin remove = %d, want 204", got)
	}
}
