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
//
// WHO MAY CONNECT (docs/decisions/detail-ladder.md, fork 9, "Access"): in a
// mode that checks identity, a client presents a token of this server's
// own, minted with the shared key for the bus's audience — the same tokens
// as everywhere, no second set of passwords. A module (`module:<name>`) may
// do anything; a worker may do what the module serving it grants
// (`Grants`), nothing else. The check runs in this process through the
// embedded server's custom authentication, which is what NATS's auth
// callout is for a server that is not embedded. Where nothing checks
// identity, the bus checks nobody either, as before.
package relay

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
	busrelay "github.com/DebakelOrakel/casas-eternas/internal/relay"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// Config carries the full configuration tree (every module holds it whole —
// decided 2026-08-12). The module reads Global and its OWN section
// (`relay.*`), nothing else.
type Config struct {
	All config.Config
	// The issuer/verifier over the shared key; nil where identity is not
	// checked, which leaves the bus open (loopback, as `relay.listen`
	// defaults to).
	Tokens *token.Tokens
	// What each non-module subject may do on the bus, by the subject's kind
	// (token.SubjectWorker → the jobs module's worker grant, for `worker` and
	// every `worker:<id>`). Composed in cmd/, so the bus names no module's
	// subjects.
	Grants map[string]busrelay.Grant
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
	if err := config.RequireDir("relay.state-dir", section.StateDir); err != nil {
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
	// The embedded server reports a port it cannot bind only by never
	// becoming ready; trying the address first says what is wrong.
	if port > 0 {
		probe, err := net.Listen("tcp", section.Listen)
		if err != nil {
			return nil, fmt.Errorf("relay.listen %q: %w", section.Listen, err)
		}
		probe.Close()
	}
	// A message may be up to maxPayload: the refine plan a level task
	// reports lists every tile of levels 2 and 3 with what it waits for —
	// ~10 000 tiles and past NATS's default of 1 MB on a 2048 × 1024 world
	// (2026-10-01). 8 MB is NATS's own recommended ceiling; bulk bytes
	// (worlds, artifacts) stay HTTP.
	const maxPayload = 8 << 20
	// The server pings every client this often. A WebSocket client passes
	// a router (ingress-nginx, OpenShift's HAProxy) that cuts a connection
	// silent for 60 s by default; NATS's own default of 2 min would let an
	// idle worker be cut, so the traffic in both directions stays under it
	// without an annotation that would hold for every path of the ingress.
	const pingInterval = 30 * time.Second
	opts := &natsserver.Options{
		ServerName: "casas-relay",
		Host:       host,
		Port:       port,
		JetStream:  true,
		StoreDir:   section.StateDir,
		MaxPayload: maxPayload,
		// The process owns signals and logging; the server says what goes
		// wrong through its errors and its readiness, nothing on its own.
		NoSigs:       true,
		NoLog:        true,
		PingInterval: pingInterval,
	}
	if section.WebSocket != "" {
		ws, err := websocketOptions(section.WebSocket, cfg.All.Global.TLS.Cert, cfg.All.Global.TLS.Key)
		if err != nil {
			return nil, err
		}
		opts.Websocket = ws
	}
	if cfg.Tokens != nil {
		opts.CustomClientAuthentication = tokenAuth{tokens: cfg.Tokens, grants: cfg.Grants}
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
	slog.Info("relay ready", "listen", server.ClientURL(), "websocket", section.WebSocket, "store", section.StateDir, "checks tokens", cfg.Tokens != nil)
	warnIfExposed(section.Listen)
	return &Module{server: server, listen: server.ClientURL()}, nil
}

// websocketOptions is the WebSocket listener at `listen` (relay.websocket),
// for workers outside the cluster (docs/decisions/detail-ladder.md, "a
// worker outside the cluster"). It sits behind the ingress on a path of
// the server's own host (`/relay`): NATS takes a WebSocket on any path, so
// the ingress rewrites nothing. TLS ends at the ingress, so the listener is
// plain — unless global.tls is set (a server without an ingress), then it
// speaks TLS with the same certificate. The clients prove themselves with
// the same tokens as on relay.listen (tokenAuth).
func websocketOptions(listen, certFile, keyFile string) (natsserver.WebsocketOpts, error) {
	host, portText, err := net.SplitHostPort(listen)
	if err != nil {
		return natsserver.WebsocketOpts{}, fmt.Errorf("relay.websocket %q: %w", listen, err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port <= 0 {
		return natsserver.WebsocketOpts{}, fmt.Errorf("relay.websocket %q: port must be a number above 0", listen)
	}
	probe, err := net.Listen("tcp", listen)
	if err != nil {
		return natsserver.WebsocketOpts{}, fmt.Errorf("relay.websocket %q: %w", listen, err)
	}
	probe.Close()
	ws := natsserver.WebsocketOpts{Host: host, Port: port, NoTLS: true}
	if certFile != "" && keyFile != "" {
		tlsConfig, err := natsserver.GenTLSConfig(&natsserver.TLSConfigOpts{CertFile: certFile, KeyFile: keyFile})
		if err != nil {
			return natsserver.WebsocketOpts{}, fmt.Errorf("relay.websocket: global.tls: %w", err)
		}
		ws.TLSConfig = tlsConfig
		ws.NoTLS = false
	}
	return ws, nil
}

// warnIfExposed warns, once at start, when the bus listens on more than
// the loopback interface: it speaks plain NATS over TCP, so its traffic
// (tokens included) is not encrypted. Nothing else changes; a cluster
// network is a trusted network of that kind. The plan for clients from
// outside is in DEC-0038, "Open".
func warnIfExposed(listen string) {
	host, _, err := net.SplitHostPort(listen)
	if err != nil || isLoopback(host) {
		return
	}
	slog.Warn("relay: the bus listens beyond loopback and its traffic is not encrypted; use it only on a trusted network (e.g. a cluster network)", "listen", listen)
}

// isLoopback reports whether `host` names only the loopback interface: a
// loopback IP or "localhost". An empty host is every interface.
func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// tokenAuth admits a client by the token it presents (see the package
// comment).
type tokenAuth struct {
	tokens *token.Tokens
	grants map[string]busrelay.Grant
}

// Check verifies the connection's token and gives the client its rights: a
// module all of them, a granted subject its grant, anyone else none — a
// valid bus token for a subject nobody granted is refused, not let in
// with nothing to do.
func (a tokenAuth) Check(c natsserver.ClientAuthentication) bool {
	opts := c.GetOpts()
	if opts == nil {
		return false
	}
	subject, err := a.tokens.VerifyRelay(opts.Token)
	if err != nil {
		return false
	}
	user := &natsserver.User{Username: subject}
	if !strings.HasPrefix(subject, token.ModuleSubject("")) {
		grant, ok := a.grants[token.SubjectKind(subject)]
		if !ok {
			return false
		}
		user.Permissions = &natsserver.Permissions{
			Publish:   &natsserver.SubjectPermission{Allow: grant.Publish},
			Subscribe: &natsserver.SubjectPermission{Allow: grant.Subscribe},
		}
	}
	c.RegisterUser(user)
	return true
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
