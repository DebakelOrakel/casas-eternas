package server

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

// holdModule's route waits until it is released and says when a request
// has arrived.
type holdModule struct {
	arrived chan struct{}
	release chan struct{}
}

func (holdModule) Name() string { return "hold" }
func (m holdModule) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("GET /v1/hold", func(w http.ResponseWriter, _ *http.Request) {
		m.arrived <- struct{}{}
		<-m.release
		w.WriteHeader(http.StatusOK)
	})
	return nil
}
func (holdModule) Close() error { return nil }

// L10 (review of 2026-10-16): the public and the internal listener shut
// down at the same time, each with the full grace. Before, the internal
// one shut down only after the public one had drained: it took new
// requests all that time, and its own in-flight requests (a local
// worker's uploads) had only what was left of the grace.
func TestBothListenersShutDownTogether(t *testing.T) {
	public := freePort(t)
	internal, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	hold := holdModule{arrived: make(chan struct{}, 1), release: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, config.Server{Listen: public}, "test", []Module{hold}, nil, internal)
	}()
	client := &http.Client{Timeout: 10 * time.Second}
	deadline := time.Now().Add(5 * time.Second)
	for {
		resp, err := client.Get("http://" + public + CapabilitiesPath)
		if err == nil {
			resp.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the public listener did not answer: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	held := make(chan error, 1)
	go func() {
		resp, err := client.Get("http://" + public + "/v1/hold")
		if err == nil {
			resp.Body.Close()
		}
		held <- err
	}()
	<-hold.arrived

	cancel()
	// While the public request drains, the internal listener takes nothing
	// new.
	closed := false
	for end := time.Now().Add(2 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		conn, err := net.DialTimeout("tcp", internal.Addr().String(), 200*time.Millisecond)
		if err != nil {
			closed = true
			break
		}
		conn.Close()
	}
	close(hold.release)
	if !closed {
		t.Error("the internal listener still accepts while the public one drains")
	}
	if err := <-held; err != nil {
		t.Errorf("the request in flight was cut off: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return")
	}
}
