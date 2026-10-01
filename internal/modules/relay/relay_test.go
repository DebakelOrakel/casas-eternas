package relay

import (
	"context"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
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
