package cmd

import (
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/modules/auth"
	"github.com/DebakelOrakel/casas-eternas/internal/server"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
	"github.com/DebakelOrakel/casas-eternas/internal/user"
)

// serveOnSocket serves a composed admin handler on a real unix socket — the
// CLI's whole world, minus cobra.
func serveOnSocket(t *testing.T, modules []server.Module, names []string) string {
	t.Helper()
	// Short directory, not t.TempDir(): a unix socket path is capped around
	// 104 bytes on darwin.
	dir, err := os.MkdirTemp("", "adm")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "admin.sock")

	handler, err := server.AdminHandler(modules, names)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: handler}
	go func() { _ = srv.Serve(listener) }()
	t.Cleanup(func() { _ = srv.Close() })
	return socket
}

func authModuleFixture(t *testing.T) *auth.Module {
	t.Helper()
	registry, err := user.NewRegistry(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatal(err)
	}
	module, err := auth.New(auth.Config{Tokens: tokens, TTL: time.Hour, SessionTTL: 24 * time.Hour, Registry: registry, StorageDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { module.Close() })
	return module
}

// The CLI's request loop against a live socket: create, list, wrong password
// refused by the server it administered.
func TestAdminRequestRoundTrip(t *testing.T) {
	socket := serveOnSocket(t, []server.Module{authModuleFixture(t)}, []string{"auth"})

	var created user.User
	err := adminRequestOver(socket, http.MethodPost, auth.UsersPath,
		map[string]string{"name": "ada", "password": "Geheim-2026"}, &created)
	if err != nil {
		t.Fatalf("create over the socket: %v", err)
	}
	if created.Name != "ada" || created.ID == "" {
		t.Errorf("created = %+v", created)
	}

	var listing struct {
		Users []user.Listing `json:"users"`
	}
	if err := adminRequestOver(socket, http.MethodGet, auth.UsersPath, nil, &listing); err != nil {
		t.Fatal(err)
	}
	if len(listing.Users) != 1 || listing.Users[0].ID != created.ID || !listing.Users[0].HasCredential {
		t.Errorf("listing = %+v", listing.Users)
	}

	// The server's refusal arrives as its message, not as a bare status.
	err = adminRequestOver(socket, http.MethodPost, auth.UsersPath,
		map[string]string{"name": "ada", "password": "Xx-passwort1"}, nil)
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("duplicate create: %v", err)
	}
}

// Exec'd into the wrong process, the CLI must say WHICH targets run there
// and where to go — a bare 404 reads as a broken CLI.
func TestAdminRequestNamesTheWrongPod(t *testing.T) {
	// A process serving only the world target: no admin handlers at all.
	socket := serveOnSocket(t, nil, []string{"world"})

	err := adminRequestOver(socket, http.MethodGet, auth.UsersPath, nil, nil)
	if err == nil {
		t.Fatal("the wrong pod answered success")
	}
	if !strings.Contains(err.Error(), "world") || !strings.Contains(err.Error(), "auth target") {
		t.Errorf("the wrong-pod message does not point anywhere: %v", err)
	}
}
