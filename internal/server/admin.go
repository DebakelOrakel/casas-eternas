// The admin socket: a SECOND listener carrying the modules' administration
// handlers, deliberately not a port. A unix socket's reachability is file
// permissions, so "who may administer" becomes a question the platform
// already answers — mode 0600 on a plain machine, pods/exec RBAC on a
// cluster — instead of a credential this server would have to store and
// check. That is also why these handlers never see the Gate: there is no
// token to inspect, and putting the routes on the network listener would
// turn the whole model into a hole. See docs/decisions/server-user-admin.md.

package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

// AdminHandler mounts every resident AdminModule and answers everything
// else with the targets that DO run here — the reply for an exec into the
// wrong pod, where "404" alone would read as a broken CLI rather than a
// mis-aimed one. Exported for composition and its tests; serveAdmin is the
// caller that gives it its socket.
func AdminHandler(modules []Module, names []string) (http.Handler, error) {
	mux := http.NewServeMux()
	for _, m := range modules {
		a, ok := m.(AdminModule)
		if !ok {
			continue
		}
		if err := mountAdmin(m, a, mux); err != nil {
			return nil, fmt.Errorf("mounting %s admin routes: %w", m.Name(), err)
		}
		slog.Info("admin routes mounted", "module", m.Name())
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error":   "no admin handler for this path in this process",
			"targets": names,
		})
	})
	return mux, nil
}

// mountAdmin is mount's twin for admin routes: a pattern conflict surfaces as
// an error naming the module, not as a stack trace.
func mountAdmin(m Module, a AdminModule, mux *http.ServeMux) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("panic: %v", recovered)
		}
	}()
	return a.MountAdmin(mux)
}

// serveAdmin binds the admin socket and serves in the background; the
// returned shutdown drains it and removes the socket file. Nil-and-nil means
// no socket is configured.
func serveAdmin(cfg config.Server, modules []Module, names []string, serveErr chan<- error) (func(context.Context) error, error) {
	if cfg.AdminSocket == "" {
		return nil, nil
	}
	handler, err := AdminHandler(modules, names)
	if err != nil {
		return nil, err
	}
	// A socket file left by a dead process refuses the bind and answers
	// nothing if dialled — remove it first. A LIVE process cannot be
	// clobbered this way into being unreachable-but-running: whichever store
	// module both processes would share has already refused the second one
	// on its file lock.
	_ = os.Remove(cfg.AdminSocket)
	listener, err := net.Listen("unix", cfg.AdminSocket)
	if err != nil {
		return nil, fmt.Errorf("admin socket %q: %w", cfg.AdminSocket, err)
	}
	// Narrowed after the bind, because the bind creates the file under the
	// umask. The window is real but tiny, and the alternative — juggling the
	// process umask — races every other thread creating files.
	if err := os.Chmod(cfg.AdminSocket, 0o600); err != nil {
		listener.Close()
		return nil, fmt.Errorf("admin socket %q: %w", cfg.AdminSocket, err)
	}
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		slog.Info("admin socket listening", "path", cfg.AdminSocket)
		if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- fmt.Errorf("admin socket: %w", err)
		}
	}()
	return func(ctx context.Context) error {
		defer os.Remove(cfg.AdminSocket)
		return srv.Shutdown(ctx)
	}, nil
}
