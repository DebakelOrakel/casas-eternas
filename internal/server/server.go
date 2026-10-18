// Package server owns the HTTP lifecycle: one public listener, one mux, and
// whichever modules were selected mounted onto it.
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
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"slices"
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
// depend on how the server is deployed — a job its workers run over the relay
// is a different thing to watch than one that runs as a subprocess, and the
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
//
// `internal`, when not nil, is a second listener that serves the SAME
// handler, gate included, over plain HTTP: the address of the job workers
// this process starts itself, when the public listener speaks TLS with a
// certificate for a public name they cannot verify on localhost. It must be
// on a loopback address; cmd/ opens it (it has to know the address before
// the modules are built), Run serves it and closes it.
func Run(ctx context.Context, cfg config.Server, build string, modules []Module, gate func(http.Handler) http.Handler, internal net.Listener) (err error) {
	if internal != nil {
		// Closed on every way out; after a Shutdown it is closed already,
		// and the second Close only reports that.
		defer internal.Close()
		if loopbackErr := requireLoopback(internal); loopbackErr != nil {
			return loopbackErr
		}
	}
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
	mux.HandleFunc("GET "+CapabilitiesPath, capabilitiesHandler(names, described, build, newPeerCache(cfg.Peers)))

	tlsConfig := buildTLS(cfg)

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

	// Buffered for EVERY server (public, internal, admin), so no goroutine
	// can block on a channel nobody reads after another has already decided
	// the outcome.
	serveErr := make(chan error, 3)

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

	// The internal listener: the same handler, no TLS, no other settings.
	var internalSrv *http.Server
	if internal != nil {
		internalSrv = &http.Server{Handler: handler, ReadHeaderTimeout: srv.ReadHeaderTimeout}
		go func() {
			slog.Info("internal listener for the local job workers", "addr", internal.Addr().String(), "tls", false)
			serveErr <- internalSrv.Serve(internal)
		}()
	}

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
		// Both listeners at the same time, each with the whole grace: one
		// after the other, the internal listener took new requests while the
		// public one drained, and its own requests in flight (a local
		// worker's uploads) had only what was left of the grace (until
		// 2026-10-16).
		internalErr := make(chan error, 1)
		if internalSrv != nil {
			go func() { internalErr <- internalSrv.Shutdown(shutdownCtx) }()
		} else {
			internalErr <- nil
		}
		shutdownErr := srv.Shutdown(shutdownCtx)
		return errors.Join(shutdownErr, <-internalErr)
	}
}

// buildTLS returns nil when TLS is off — http.Server treats that as plain HTTP.
// Clients are not asked for a certificate: tokens authenticate them (mutual
// TLS was removed 2026-10-16, docs/decisions/server-storage.md).
func buildTLS(cfg config.Server) *tls.Config {
	if !cfg.TLSEnabled() {
		return nil
	}
	return &tls.Config{MinVersion: tls.VersionTLS12}
}

// requireLoopback refuses an internal listener that is not on a loopback
// address. cmd/ opens it on 127.0.0.1; this is the guard that a plain-HTTP
// listener never reaches the network by a composition mistake.
func requireLoopback(listener net.Listener) error {
	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok || !addr.IP.IsLoopback() {
		return fmt.Errorf("the internal listener must be on a loopback address, not %s", listener.Addr())
	}
	return nil
}

// capabilitiesHandler answers /v1/capabilities: this process's modules and
// what they describe, and with peers (global.peers, peers.go) theirs too,
// unless the asker wants this process's own only (?local, what a peer asks).
func capabilitiesHandler(names []string, described map[string]any, build string, peers *peerCache) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		modules := names
		body := map[string]any{}
		if !r.URL.Query().Has(localQuery) {
			theirs := peers.get(r.Context())
			modules = slices.Clone(names)
			for _, module := range theirs.Modules {
				if !slices.Contains(modules, module) {
					modules = append(modules, module)
				}
			}
			for key, value := range theirs.Described {
				body[key] = value
			}
		}
		// This process's own values win over a peer's of the same key.
		for key, value := range described {
			body[key] = value
		}
		// `version` alongside `modules` because both answer "what am I talking
		// to". It is provenance and not a contract: a client may show it or log
		// it, it may never branch on it — what a server can DO is the module
		// list and the described capabilities beside it, which say so
		// directly instead of asking anyone to know which build gained what.
		body["modules"] = modules
		body["version"] = build
		_ = json.NewEncoder(w).Encode(body)
	}
}
