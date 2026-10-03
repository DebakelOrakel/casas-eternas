package relay

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
	busrelay "github.com/DebakelOrakel/casas-eternas/internal/relay"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

func relayConfig(dir, listen string) Config {
	var tree config.Config
	tree.Relay.Storage.Dir = &config.DirStorage{Path: dir}
	tree.Relay.Listen = listen
	return Config{All: tree}
}

// The bus starts on its port, keeps a JetStream stream on its store, and is
// gone after Close.
func TestRelayCarriesAStream(t *testing.T) {
	dir := t.TempDir()
	// Port -1: a free one, so the test never collides with a running server.
	m, err := New(relayConfig(dir, "127.0.0.1:-1"))
	if err != nil {
		t.Fatal(err)
	}
	if m.Name() != "relay" || m.Describe()["relayListen"] == "" {
		t.Errorf("name %q, describe %v", m.Name(), m.Describe())
	}

	conn, err := nats.Connect(m.URL())
	if err != nil {
		t.Fatal(err)
	}
	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stream, err := js.CreateStream(ctx, jetstream.StreamConfig{Name: "TEST", Subjects: []string{"test.>"}, Retention: jetstream.WorkQueuePolicy})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := js.Publish(ctx, "test.one", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	// Past NATS's default of 1 MB: a refine plan's report is ~1.3 MB on a
	// 2048 × 1024 world (relay.go, maxPayload).
	if _, err := js.Publish(ctx, "test.big", make([]byte, 2<<20)); err != nil {
		t.Errorf("a 2 MB message: %v", err)
	}
	consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{Durable: "reader", AckPolicy: jetstream.AckExplicitPolicy})
	if err != nil {
		t.Fatal(err)
	}
	batch, err := consumer.Fetch(1, jetstream.FetchMaxWait(5*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	got := 0
	for msg := range batch.Messages() {
		got++
		if string(msg.Data()) != "hello" {
			t.Errorf("message %q", msg.Data())
		}
		if err := msg.Ack(); err != nil {
			t.Fatal(err)
		}
	}
	if got != 1 {
		t.Errorf("fetched %d messages, want 1", got)
	}
	conn.Close()

	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if m.Server() != nil {
		t.Error("the server is still held after Close")
	}
	if err := m.Close(); err != nil {
		t.Errorf("a second Close: %v", err)
	}
}

// A start that cannot work says why instead of half-running.
func TestRelayRefusesABadConfig(t *testing.T) {
	if _, err := New(relayConfig("", "127.0.0.1:-1")); err == nil {
		t.Error("no store directory, but the relay started")
	}
	if _, err := New(relayConfig(t.TempDir(), "no-port")); err == nil {
		t.Error("a listen address without a port, but the relay started")
	}
}

// A port that is taken is named as such, not as a server that never came up.
func TestRelaySaysItsPortIsTaken(t *testing.T) {
	held, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	_, err = New(relayConfig(t.TempDir(), held.Addr().String()))
	if err == nil || !strings.Contains(err.Error(), "relay.listen") {
		t.Errorf("err = %v, want a relay.listen error", err)
	}
}

// With tokens the bus admits only this server's bus tokens: a module may do
// anything, a worker only what its grant allows, and no token, a session's
// token or a bus token for an ungranted subject gets in at all.
func TestRelayChecksTokens(t *testing.T) {
	tokens, err := token.NewTokens([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	cfg := relayConfig(t.TempDir(), "127.0.0.1:-1")
	cfg.Tokens = tokens
	cfg.Grants = map[string]busrelay.Grant{token.SubjectWorker: {Publish: []string{"jobs.done.>"}, Subscribe: []string{"_INBOX.>"}}}
	m, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()

	relayToken := func(subject string) string {
		raw, _, err := tokens.IssueRelay(subject, time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	session, _, err := tokens.IssueSession("u1", false, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for name, raw := range map[string]string{"no token": "", "a session token": session, "an ungranted subject": relayToken("stranger")} {
		if conn, err := nats.Connect(m.URL(), nats.Token(raw)); err == nil {
			conn.Close()
			t.Errorf("%s: connected", name)
		}
	}

	// A refused publish is reported asynchronously, as a permissions error.
	denied := make(chan error, 1)
	worker, err := nats.Connect(m.URL(), nats.Token(relayToken(token.SubjectWorker)), nats.ErrorHandler(func(_ *nats.Conn, _ *nats.Subscription, err error) {
		denied <- err
	}))
	if err != nil {
		t.Fatalf("a worker: %v", err)
	}
	defer worker.Close()
	module, err := nats.Connect(m.URL(), nats.Token(relayToken(token.ModuleSubject("jobs"))))
	if err != nil {
		t.Fatalf("a module: %v", err)
	}
	defer module.Close()

	got := make(chan string, 4)
	if _, err := module.Subscribe(">", func(msg *nats.Msg) { got <- msg.Subject }); err != nil {
		t.Fatal(err)
	}
	if err := module.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := worker.Publish("jobs.done.t1", nil); err != nil {
		t.Fatal(err)
	}
	if err := worker.Publish("world.secret", nil); err != nil {
		t.Fatal(err)
	}
	if err := worker.Flush(); err != nil {
		t.Fatal(err)
	}
	select {
	case subject := <-got:
		if subject != "jobs.done.t1" {
			t.Errorf("the module heard %q first, want jobs.done.t1", subject)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the worker's granted publish never arrived")
	}
	select {
	case err := <-denied:
		if !strings.Contains(strings.ToLower(err.Error()), "permission") {
			t.Errorf("the refused publish: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Error("the worker's ungranted publish was not refused")
	}
	select {
	case subject := <-got:
		t.Errorf("the module heard %q, which the worker may not publish", subject)
	case <-time.After(200 * time.Millisecond):
	}
}
