// Package relay is how a module talks over the message bus (the relay
// target, internal/modules/relay): a connection in the same process or to a
// NATS URL, subjects that start with the owning module's name, and the
// module's own streams.
//
// A leaf like token and identity: it knows no module. The one rule it
// enforces is the namespace — a module's subjects begin with its name, as its
// HTTP routes live under /v1/<module>, and no module publishes into another's
// (docs/decisions/detail-ladder.md, fork 9).
package relay

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Grant is what one kind of bus client may do: the subjects it may publish
// to and subscribe to (NATS wildcards). A module grants it for the clients
// it serves — jobs for its workers — so the bus itself names no subject.
type Grant struct {
	Publish   []string
	Subscribe []string
}

// Conn is one module's connection to the bus.
type Conn struct {
	module string
	nc     *nats.Conn
	js     jetstream.JetStream
}

// Connect reaches the bus: over `url` when it is set (the relay in another
// process, or an external NATS cluster), else in the process through
// `server` (the co-resident relay). Neither is a composition error worth
// naming at startup.
//
// `token` gives the connection's credential, asked again at every
// (re)connect so a reconnect after hours never presents an expired one;
// nil where the bus checks nobody.
func Connect(module string, server *natsserver.Server, url string, token func() string) (*Conn, error) {
	if module == "" || strings.ContainsAny(module, ".*> ") {
		return nil, fmt.Errorf("relay: %q is not a module name", module)
	}
	var (
		nc  *nats.Conn
		err error
	)
	options := []nats.Option{nats.Name("casas-" + module)}
	if token != nil {
		options = append(options, nats.TokenHandler(token))
	}
	switch {
	case url != "":
		// A relay restarting under a running module is a pause, not an end:
		// reconnect without limit.
		nc, err = nats.Connect(url, append(options, nats.MaxReconnects(-1), nats.ReconnectWait(time.Second))...)
	case server != nil:
		nc, err = nats.Connect("", append(options, nats.InProcessServer(server))...)
	default:
		return nil, errors.New("relay: none in this process and global.services.relay is not set")
	}
	if err != nil {
		return nil, fmt.Errorf("relay: %w", err)
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("relay: %w", err)
	}
	return &Conn{module: module, nc: nc, js: js}, nil
}

// Subject is a subject of this connection's module: `<module>.<parts…>`.
func (c *Conn) Subject(parts ...string) string {
	return strings.Join(append([]string{c.module}, parts...), ".")
}

// StreamName is a stream of this module: `<MODULE>_<NAME>`.
func (c *Conn) StreamName(name string) string {
	return strings.ToUpper(c.module) + "_" + strings.ToUpper(name)
}

// DeclareStream creates or updates one of the module's streams. Its name and
// every subject must be the module's own (StreamName, Subject); anything else
// is refused rather than published into another module's namespace.
func (c *Conn) DeclareStream(ctx context.Context, config jetstream.StreamConfig) (jetstream.Stream, error) {
	if !strings.HasPrefix(config.Name, strings.ToUpper(c.module)+"_") {
		return nil, fmt.Errorf("relay: stream %q is not module %s's", config.Name, c.module)
	}
	for _, subject := range config.Subjects {
		if !strings.HasPrefix(subject, c.module+".") {
			return nil, fmt.Errorf("relay: subject %q is not module %s's", subject, c.module)
		}
	}
	return c.js.CreateOrUpdateStream(ctx, config)
}

// JetStream is the connection's JetStream context, for consumers and
// publishing on the module's subjects.
func (c *Conn) JetStream() jetstream.JetStream { return c.js }

// NATS is the plain connection (core subscriptions, flushes).
func (c *Conn) NATS() *nats.Conn { return c.nc }

// Close drains what is in flight and closes the connection.
func (c *Conn) Close() {
	if c.nc == nil {
		return
	}
	_ = c.nc.Drain()
	c.nc = nil
}
