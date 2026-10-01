// Package relay runs the message bus the other modules and the workers talk
// over: an embedded NATS server with JetStream (docs/decisions/
// detail-ladder.md, forks 8 and 9).
//
// A target of its own rather than a part of jobs: JetStream keeps its queues
// on disk (one process per store directory), the workers connect to its port
// and not to the jobs module's HTTP API, and a deployment can run it as its
// own pod — or not at all, pointing `global.services.relay` at an external
// NATS cluster instead. Under `-t all` the modules reach it in the process.
//
// It carries no subjects of its own. A subject's first token is the module
// that owns it (`jobs.task.…`); the module declares its streams through
// internal/relay. Named for the role, not the technology: it will carry more
// than jobs.
package relay

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

// Config carries the full configuration tree (every module holds it whole —
// decided 2026-08-12). The module reads Global and its OWN section
// (`relay.*`), nothing else.
type Config struct {
	All config.Config
}

// Module is the running bus.
type Module struct {
	server *natsserver.Server
	listen string
}

// How long the embedded server may take to accept connections before a
// start is refused: it opens its store and its port, nothing slower.
const readyTimeout = 10 * time.Second

// New starts the bus. Started here rather than in Mount, because the
// modules wired after it connect to it while they are built.
func New(cfg Config) (*Module, error) {
	section := cfg.All.Relay
	if err := section.Storage.Validate("relay"); err != nil {
		return nil, err
	}
	host, portText, err := net.SplitHostPort(section.Listen)
	if err != nil {
		return nil, fmt.Errorf("relay.listen %q: %w", section.Listen, err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		return nil, fmt.Errorf("relay.listen %q: port: %w", section.Listen, err)
	}
	opts := &natsserver.Options{
		ServerName: "casas-relay",
		Host:       host,
		Port:       port,
		JetStream:  true,
		StoreDir:   section.Storage.DirPath(),
		// The process owns signals and logging; the server says what goes
		// wrong through its errors and its readiness, nothing on its own.
		NoSigs: true,
		NoLog:  true,
	}
	server, err := natsserver.NewServer(opts)
	if err != nil {
		return nil, fmt.Errorf("relay: %w", err)
	}
	go server.Start()
	if !server.ReadyForConnections(readyTimeout) {
		server.Shutdown()
		return nil, errors.New("relay: the server did not accept connections in time")
	}
	slog.Info("relay ready", "listen", server.ClientURL(), "store", section.Storage.DirPath())
	return &Module{server: server, listen: server.ClientURL()}, nil
}

// Name identifies the module in logs and errors.
func (m *Module) Name() string { return "relay" }

// Describe says where the bus listens, under /v1/capabilities (whose keys
// are flat across modules, hence the prefix).
func (m *Module) Describe() map[string]any {
	return map[string]any{"relayListen": m.listen}
}

// Mount claims no routes: the bus speaks NATS on its own port.
func (m *Module) Mount(*http.ServeMux) error { return nil }

// Server is the running NATS server, for connections in the same process
// (internal/relay). Nil after Close.
func (m *Module) Server() *natsserver.Server { return m.server }

// URL is the address workers on this machine connect to.
func (m *Module) URL() string { return m.listen }

// Close shuts the server down and waits for it, so the store is released
// before the process exits.
func (m *Module) Close() error {
	if m.server == nil {
		return nil
	}
	m.server.Shutdown()
	m.server.WaitForShutdown()
	m.server = nil
	return nil
}
