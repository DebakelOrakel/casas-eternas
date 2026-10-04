// SERVICE ACCOUNTS (internal/user/service.go): the machines' door into this
// server. Two halves:
//
//   - the administration, on the admin socket only, like the users'
//     (`casas-eternas auth service add|list|delete|rotate`);
//   - the token route on the network listener, where a worker — in the
//     cluster or outside it — trades its account's name and secret for a
//     short-lived bus token, and comes back for a new one before it runs
//     out. Basic auth like the login, so `curl -u` works too.
//
// The token is for the bus alone (token.AudienceRelay) and names the worker,
// not a job: what a worker may read and write over HTTP comes with each task
// as that job's own token (docs/decisions/detail-ladder.md, addendum
// 2026-10-03).

package auth

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/httpjson"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
	"github.com/DebakelOrakel/casas-eternas/internal/user"
)

// TokenPath is where a service account trades its secret for a bus token.
const TokenPath = "/v1/auth/token"

// ServicesPath is the admin collection of service accounts.
const ServicesPath = "/v1/auth/services"

// ServiceTokenTTL is how long a bus token bought with a service account's
// secret holds. Short, because it is also how long a deleted or rotated
// account keeps working; a worker asks again well before it ends.
const ServiceTokenTTL = time.Hour

// MountServiceAdmin claims the service-account administration on the admin
// socket.
func (m *Module) MountServiceAdmin(mux *http.ServeMux) {
	mux.HandleFunc("GET "+ServicesPath, m.serveListServices)
	mux.HandleFunc("POST "+ServicesPath, m.serveCreateService)
	mux.HandleFunc("DELETE "+ServicesPath+"/{name}", m.serveDeleteService)
	mux.HandleFunc("POST "+ServicesPath+"/{name}/rotate", m.serveRotateService)
}

// CreatedService is what creating or rotating answers: the account and its
// secret, which exists only in this answer.
type CreatedService struct {
	user.Service
	Secret string `json:"secret"`
}

func (m *Module) serveListServices(w http.ResponseWriter, r *http.Request) {
	services, err := m.cfg.Registry.ListServices()
	if err != nil {
		httpjson.ServerError(w, "listing service accounts", err)
		return
	}
	if services == nil {
		services = []user.Service{}
	}
	httpjson.Write(w, http.StatusOK, map[string]any{"services": services})
}

func (m *Module) serveCreateService(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !decodeAdminBody(w, r, &body) {
		return
	}
	created, secret, err := m.cfg.Registry.CreateService(body.Name)
	if err != nil {
		adminError(w, "creating a service account", err)
		return
	}
	slog.Info("service account created through the admin API", "service", created.Name, "id", created.ID)
	w.Header().Set("Cache-Control", "no-store")
	httpjson.Write(w, http.StatusCreated, CreatedService{Service: created, Secret: secret})
}

func (m *Module) serveDeleteService(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := m.cfg.Registry.DeleteService(name); err != nil {
		adminError(w, "deleting a service account", err)
		return
	}
	slog.Info("service account deleted through the admin API", "service", name)
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) serveRotateService(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	secret, err := m.cfg.Registry.RotateService(name)
	if err != nil {
		adminError(w, "rotating a service account's secret", err)
		return
	}
	slog.Info("service account secret rotated through the admin API", "service", name)
	w.Header().Set("Cache-Control", "no-store")
	httpjson.Write(w, http.StatusOK, CreatedService{Service: user.Service{Name: name}, Secret: secret})
}

// serviceTokenResponse is what the token route answers.
type serviceTokenResponse struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// serveServiceToken trades a service account's name and secret (basic auth)
// for a bus token. Refused the same way whatever was wrong, as the login is.
func (m *Module) serveServiceToken(w http.ResponseWriter, r *http.Request) {
	name, secret, ok := r.BasicAuth()
	if !ok || name == "" {
		unauthorized(w)
		return
	}
	account, valid, err := m.cfg.Registry.VerifyService(name, secret)
	if err != nil {
		slog.Error("cannot check a service account", "error", err)
		http.Error(w, "credentials cannot be checked", http.StatusInternalServerError)
		return
	}
	if !valid {
		unauthorized(w)
		return
	}
	issued, expires, err := m.cfg.Tokens.IssueRelay(token.WorkerSubject(account.ID), ServiceTokenTTL)
	if err != nil {
		slog.Error("cannot issue a bus token", "error", err, "service", name)
		http.Error(w, "cannot issue a token", http.StatusInternalServerError)
		return
	}
	slog.Info("bus token issued", "service", name, "id", account.ID, "expires", expires)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(serviceTokenResponse{Token: issued, ExpiresAt: expires})
}
