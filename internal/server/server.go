// Package server owns the HTTP lifecycle: one listener, one mux, and whichever
// modules were selected mounted onto it.
//
// Note what the modules do NOT do: they never import this package. Go satisfies
// interfaces structurally, so a module only has to have the three methods below
// to be mountable here. The dependency therefore points one way — server knows
// about modules, modules know about nothing — which is what keeps a module
// testable on its own.
package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

// Module is anything `start` can run. Mount is where a module claims its
// routes; Close releases whatever it opened, and is called even if startup
// fails later, so a module may allocate in its constructor.
type Module interface {
	Name() string
	Mount(mux *http.ServeMux) error
	Close() error
}

// Describer is an OPTIONAL second interface: a module that has something to say
// about how it works says it here, and it lands in /v1/capabilities.
//
// Optional and structural, like Module itself, so this package still knows about
// no module in particular. The client needs it because some of its own choices
// depend on how the server is deployed — a bake that runs as a Kubernetes Job is
// a different thing to watch than one that runs as a subprocess, and the
// notification announcing it has to pick its icon BEFORE the job exists, since a
// notification's icon may not change once shown.
type Describer interface {
	Describe() map[string]any
}

// AdminModule is an OPTIONAL third interface: a module with a local
// administration surface claims its admin routes here, and they are served
// ONLY on the unix admin socket — never on the network listener. No gate, no
// token: reaching the socket IS the authorization, which its 0600 file mode
// (and, on a cluster, pods/exec RBAC) enforces. Structural like the two
// above, so this package still knows about no module in particular.
// See docs/decisions/server-user-admin.md.
type AdminModule interface {
	MountAdmin(mux *http.ServeMux) error
}

// APIPrefix is the version prefix of every API route. One constant for the
// places that COMPOSE URLs (this package and cmd/); the modules' route
// patterns spell it out as literals on purpose — a pattern is a registered
// public surface, and hiding half of it behind a constant would make a grep
// for "/v1/worlds" miss the very line that claims it. Nothing imports this
// package except cmd/, which is exactly who composes.
const APIPrefix = "/v1"

// CapabilitiesPath says which modules this process runs. Public, and that is a
// decision rather than an oversight: it is what the client probes to tell a
// server that is down from one it is merely not logged in to, and answering 401
// here would report every logged-out user as "server unreachable".
const CapabilitiesPath = APIPrefix + "/capabilities"

// shutdownGrace bounds how long in-flight requests may finish after a signal.
// Uploading a world is the long pole here, hence seconds rather than the
// millisecond-scale value a pure API would use.
const shutdownGrace = 15 * time.Second

// mount calls a module's Mount, turning a panic into the error it should have
// been. The realistic panic here is ServeMux's own: two modules claiming the
// same route pattern. That is a composition bug in cmd/, and it should surface
// as "mounting <module>: <conflict>" naming the module that lost — not as a
// stack trace that leaves the operator to work out which of five Mount calls
// blew up.
func mount(m Module, mux *http.ServeMux) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("panic: %v", recovered)
		}
	}()
	return m.Mount(mux)
}

// Run mounts every module, serves until interrupted, then shuts down cleanly.
// It closes the modules on the way out regardless of how it leaves.
//
// `gate` wraps the finished mux — see Gate. It is a parameter rather than
// something built here because the exempt paths belong to the MODULES, and this
// package deliberately knows about none of them: a module only has to have the
// three methods above to be mountable, and importing one here to read a path
// constant would trade that away. cmd/ composes, so cmd/ names them.
//
// `build` is a parameter for the same reason. It is the binary's provenance,
// stamped into cmd/ at link time, and it appears here only because
// /v1/capabilities is where a client can read it. Holding it as state of this
// package would make the HTTP lifecycle the owner of a fact about the program
// — and would need a second place for the linker to write to.
func Run(ctx context.Context, cfg config.Server, build string, modules []Module, gate func(http.Handler) http.Handler) (err error) {
	if validateErr := cfg.Validate(); validateErr != nil {
		return validateErr
	}

	mux := http.NewServeMux()
	// Closed in reverse order so a module that was built on top of an earlier
	// one is torn down before its foundation.
	defer func() {
		for i := len(modules) - 1; i >= 0; i-- {
			if closeErr := modules[i].Close(); closeErr != nil {
				err = errors.Join(err, fmt.Errorf("closing %s: %w", modules[i].Name(), closeErr))
			}
		}
	}()

	names := make([]string, 0, len(modules))
	for _, m := range modules {
		if mountErr := mount(m, mux); mountErr != nil {
			return fmt.Errorf("mounting %s: %w", m.Name(), mountErr)
		}
		names = append(names, m.Name())
		slog.Info("module mounted", "module", m.Name())
	}
	// Mounted by the server rather than by a module, because it describes the
	// PROCESS: which modules this one runs. It is also what the client probes
	// to decide whether a configured server is actually answering — config.json
	// says where the storage is, this says what it can do, and only the storage
	// itself knows the latter.
	// Collected once at mount rather than per request: what a module has to say
	// about itself does not change while it runs, and a probe on every screen is
	// not the place to find that out again.
	described := map[string]any{}
	for _, m := range modules {
		if d, ok := m.(Describer); ok {
			for key, value := range d.Describe() {
				described[key] = value
			}
		}
	}
	mux.HandleFunc("GET "+CapabilitiesPath, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		// `version` alongside `modules` because both answer "what am I talking
		// to". It is provenance and not a contract: a client may show it or log
		// it, it may never branch on it — what a server can DO is the module
		// list and the described capabilities right below, which say so
		// directly instead of asking anyone to know which build gained what.
		body := map[string]any{"modules": names, "version": build}
		for key, value := range described {
			body[key] = value
		}
		_ = json.NewEncoder(w).Encode(body)
	})

	tlsConfig, err := buildTLS(cfg)
	if err != nil {
		return err
	}

	// Wrapped AFTER every module has mounted, so the gate covers routes it was
	// never told about — including any added later.
	var handler http.Handler = mux
	if gate != nil {
		handler = gate(mux)
	}

	srv := &http.Server{
		Addr:      cfg.Listen,
		Handler:   handler,
		TLSConfig: tlsConfig,
		// A world upload is large and a bake request is slow, so no
		// write timeout; the read header timeout still fends off a
		// connection that never sends a request.
		ReadHeaderTimeout: 10 * time.Second,
	}

	// SIGINT/SIGTERM cancel the context, which triggers the shutdown below.
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Buffered for BOTH servers, so neither goroutine can block on a channel
	// nobody reads after the other has already decided the outcome.
	serveErr := make(chan error, 2)

	adminShutdown, err := serveAdmin(cfg, modules, names, serveErr)
	if err != nil {
		return err
	}
	if adminShutdown != nil {
		// Registered after the module-close defer, so it runs BEFORE it:
		// admin handlers drain before the stores they write to close.
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownGrace)
			defer cancel()
			if adminErr := adminShutdown(shutdownCtx); adminErr != nil {
				err = errors.Join(err, fmt.Errorf("admin socket: %w", adminErr))
			}
		}()
	}

	go func() {
		slog.Info("listening", "addr", cfg.Listen, "tls", cfg.TLSEnabled())
		if cfg.TLSEnabled() {
			serveErr <- srv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
			return
		}
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		// ErrServerClosed only appears after a Shutdown we did not ask for
		// here, so at this point it would still be unexpected.
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
		slog.Info("shutting down", "grace", shutdownGrace)
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownGrace)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}

// buildTLS returns nil when TLS is off — http.Server treats that as plain HTTP.
// A CA turns on MUTUAL TLS: it is the authority client certificates are checked
// against, not the server's own chain.
func buildTLS(cfg config.Server) (*tls.Config, error) {
	if !cfg.TLSEnabled() {
		return nil, nil
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if cfg.TLSCA == "" {
		return tlsConfig, nil
	}
	pem, err := os.ReadFile(cfg.TLSCA)
	if err != nil {
		return nil, fmt.Errorf("reading global.tls.ca: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("global.tls.ca %q contains no usable certificate", cfg.TLSCA)
	}
	tlsConfig.ClientCAs = pool
	tlsConfig.ClientAuth = tls.RequireAndVerifyClientCert
	return tlsConfig, nil
}
