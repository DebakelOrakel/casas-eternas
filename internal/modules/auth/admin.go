// The user administration — served ONLY on the admin socket
// (server.AdminModule): possession of the socket is the authorization, which
// is why no handler here looks at a token. When the admin panels arrive
// (docs/design/frontend-surfaces.md) these same handlers appear on the
// network listener token-gated behind the adm claim — they gain a gate, they
// do not move.

package auth

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/DebakelOrakel/casas-eternas/internal/httpjson"
	"github.com/DebakelOrakel/casas-eternas/internal/user"
)

// UsersPath is the admin collection: the module's namespace, like every
// other route this module claims.
const UsersPath = "/v1/auth/users"

// maxAdminBody bounds a request body. A user record is a name and a
// password; anything beyond a few kilobytes is a mistake or an attack, and
// reading it to find out which is the vulnerability.
const maxAdminBody = 4 << 10

// MountAdmin claims the user CRUD — the `auth user add|list|delete|passwd`
// surface (docs/decisions/server-user-admin.md).
func (m *Module) MountAdmin(mux *http.ServeMux) error {
	mux.HandleFunc("GET "+UsersPath, m.serveListUsers)
	mux.HandleFunc("POST "+UsersPath, m.serveCreateUser)
	mux.HandleFunc("DELETE "+UsersPath+"/{name}", m.serveDeleteUser)
	mux.HandleFunc("PUT "+UsersPath+"/{name}/password", m.serveSetPassword)
	mux.HandleFunc("PUT "+UsersPath+"/{name}/role", m.serveSetRole)
	return nil
}

// credentialBody carries what create and set-password take. The password
// travels in the BODY, never the path: paths land in logs.
type credentialBody struct {
	Name     string `json:"name,omitempty"`
	Password string `json:"password"`
}

func (m *Module) serveListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := m.cfg.Registry.List()
	if err != nil {
		httpjson.ServerError(w, "listing users", err)
		return
	}
	// An empty list is a real answer (the bootstrap state), and it must be
	// `[]`, not JSON null — the CLI ranges over it.
	if users == nil {
		users = []user.Listing{}
	}
	httpjson.Write(w, http.StatusOK, map[string]any{"users": users})
}

func (m *Module) serveCreateUser(w http.ResponseWriter, r *http.Request) {
	var body credentialBody
	if !decodeAdminBody(w, r, &body) {
		return
	}
	entry, err := m.cfg.Registry.Create(body.Name, body.Password)
	if err != nil {
		adminError(w, "creating a user", err)
		return
	}
	slog.Info("user created over the admin socket", "user", entry.Name, "id", entry.ID)
	httpjson.Write(w, http.StatusCreated, entry)
}

func (m *Module) serveDeleteUser(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := m.cfg.Registry.Delete(name); err != nil {
		adminError(w, "deleting a user", err)
		return
	}
	slog.Info("user deleted over the admin socket", "user", name)
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) serveSetPassword(w http.ResponseWriter, r *http.Request) {
	var body credentialBody
	if !decodeAdminBody(w, r, &body) {
		return
	}
	name := r.PathValue("name")
	if err := m.cfg.Registry.SetPassword(name, body.Password); err != nil {
		adminError(w, "setting a password", err)
		return
	}
	slog.Info("password set over the admin socket", "user", name)
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) serveSetRole(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Role string `json:"role"`
	}
	if !decodeAdminBody(w, r, &body) {
		return
	}
	name := r.PathValue("name")
	if err := m.cfg.Registry.SetRole(name, body.Role); err != nil {
		adminError(w, "setting a role", err)
		return
	}
	slog.Info("role set over the admin socket", "user", name, "role", body.Role)
	w.WriteHeader(http.StatusNoContent)
}

// decodeAdminBody reads one JSON body, reporting false after answering. The
// unknown-field refusal is the same loudness rule as the config loader's: a
// typo'd "pasword" that silently decodes to an empty password is a lockout
// with no message.
func decodeAdminBody(w http.ResponseWriter, r *http.Request, into any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAdminBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		httpjson.ClientError(w, http.StatusBadRequest, "body: "+err.Error())
		return false
	}
	return true
}

// adminError maps the registry's sentinels onto statuses. The default is a
// 500 that logs the cause and answers generically — a store failure is the
// operator's business, not the caller's.
func adminError(w http.ResponseWriter, context string, err error) {
	switch {
	case errors.Is(err, user.ErrUnknown):
		httpjson.ClientError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, user.ErrExists):
		httpjson.ClientError(w, http.StatusConflict, err.Error())
	case errors.Is(err, user.ErrInvalid):
		httpjson.ClientError(w, http.StatusBadRequest, err.Error())
	default:
		httpjson.ServerError(w, context, err)
	}
}
