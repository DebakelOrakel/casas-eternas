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

// shutdownGrace bounds how long in-flight requests may finish after a signal.
// Uploading a world is the long pole here, hence seconds rather than the
// millisecond-scale value a pure API would use.
const shutdownGrace = 15 * time.Second

// Run mounts every module, serves until interrupted, then shuts down cleanly.
// It closes the modules on the way out regardless of how it leaves.
func Run(ctx context.Context, cfg config.Server, modules []Module) (err error) {
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

	for _, m := range modules {
		if mountErr := m.Mount(mux); mountErr != nil {
			return fmt.Errorf("mounting %s: %w", m.Name(), mountErr)
		}
		slog.Info("module mounted", "module", m.Name())
	}

	tlsConfig, err := buildTLS(cfg)
	if err != nil {
		return err
	}

	srv := &http.Server{
		Addr:      cfg.Listen,
		Handler:   mux,
		TLSConfig: tlsConfig,
		// A world upload is large and a bake request is slow, so no
		// write timeout; the read header timeout still fends off a
		// connection that never sends a request.
		ReadHeaderTimeout: 10 * time.Second,
	}

	// SIGINT/SIGTERM cancel the context, which triggers the shutdown below.
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
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
		return nil, fmt.Errorf("reading --tls-ca: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("--tls-ca %q contains no usable certificate", cfg.TLSCA)
	}
	tlsConfig.ClientCAs = pool
	tlsConfig.ClientAuth = tls.RequireAndVerifyClientCert
	return tlsConfig, nil
}
