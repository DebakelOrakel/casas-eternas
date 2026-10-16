package cmd

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/modules/auth"
	"github.com/DebakelOrakel/casas-eternas/internal/user"
)

// The artifacts module's questions to a world service over HTTP
// (artifactWorlds with global.services.worlds, DEC-0039): the job of a
// world records its terrain, nobody else does, and a world's and a
// terrain's rank come back through the world service's gate — the
// anonymous terrain-access included.
func TestArtifactWorldsOverHTTP(t *testing.T) {
	cfg := passwordConfig(t)
	keyFile := filepath.Join(t.TempDir(), "session.key")
	if err := os.WriteFile(keyFile, bytes.Repeat([]byte("k"), 48), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg.Global.Auth.SessionKey = keyFile
	seed, err := user.NewRegistry(cfg.Auth.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seed.Create("ada", "Pw12345-geheim"); err != nil {
		t.Fatal(err)
	}
	if err := seed.Close(); err != nil {
		t.Fatal(err)
	}
	cfg.World.Storage.Type = "dir"
	cfg.World.Storage.Dir = &config.DirStorage{Path: t.TempDir()}
	cfg.World.ReadLinkTTL = 15 * time.Minute
	cfg.World.KeepRevisions = 3
	modules, gate, _, err := buildModules(context.Background(), config.Targets{config.TargetAuth: true, config.TargetWorld: true}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer closeAll(t, modules)
	mux := http.NewServeMux()
	for _, m := range modules {
		if err := m.Mount(mux); err != nil {
			t.Fatal(err)
		}
	}
	srv := httptest.NewServer(gate(mux))
	defer srv.Close()

	login, _ := http.NewRequest(http.MethodPost, srv.URL+auth.Path, nil)
	login.SetBasicAuth("ada", "Pw12345-geheim")
	response, err := http.DefaultClient.Do(login)
	if err != nil {
		t.Fatal(err)
	}
	var session struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(response.Body).Decode(&session)
	_ = response.Body.Close()
	if session.Token == "" {
		t.Fatalf("login = %d", response.StatusCode)
	}
	ada := "Bearer " + session.Token

	const uid = "9f2c1b4e-7a30-4d55-8c11-2b6e5d0a1f83"
	var save bytes.Buffer
	zw := zip.NewWriter(&save)
	f, _ := zw.Create("world.yaml")
	_, _ = f.Write([]byte("apiVersion: casas-eternas/v1alpha1\nkind: FlatWorld\nmetadata:\n  name: alpha\n  uid: " + uid + "\n"))
	_ = zw.Close()
	put, _ := http.NewRequest(http.MethodPut, srv.URL+"/v1/worlds/"+uid, bytes.NewReader(save.Bytes()))
	put.Header.Set("Authorization", ada)
	if response, err := http.DefaultClient.Do(put); err != nil || response.StatusCode != http.StatusCreated {
		t.Fatalf("create = %v %v", response, err)
	}

	caller, tokens, err := buildIdentity(config.AuthPassword, cfg)
	if err != nil {
		t.Fatal(err)
	}
	lookup, err := artifactWorlds(caller, nil, config.AuthPassword, srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	job, _, err := tokens.IssueJob("job-1", uid, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := lookup.addTerrain(ctx, uid, "t1", ada); err == nil {
		t.Error("the owner's session recorded a terrain")
	}
	if err := lookup.addTerrain(ctx, uid, "t1", "Bearer "+job); err != nil {
		t.Fatalf("the job's report: %v", err)
	}
	if exists, level, terrains := lookup.world(ctx, uid, ada); !exists || level != access.Owner || !slices.Equal(terrains, []string{"t1"}) {
		t.Errorf("world = %v %s %v, want the owner and [t1]", exists, level, terrains)
	}
	if exists, _, terrains := lookup.world(ctx, uid, "Bearer "+job); !exists || !slices.Equal(terrains, []string{"t1"}) {
		t.Errorf("world for its job = %v %v, want [t1]", exists, terrains)
	}
	if level, shared := lookup.terrain(ctx, "t1", ada); level != access.Owner || shared {
		t.Errorf("terrain = %s shared %v, want owner alone", level, shared)
	}
	if level, _ := lookup.terrain(ctx, "t1", ""); level != access.None {
		t.Errorf("the anonymous terrain rank = %s, want none (no template)", level)
	}
}
