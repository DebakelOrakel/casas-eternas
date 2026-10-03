package relay

import (
	"context"
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go/jetstream"
)

// An embedded server for the tests, on a free port with a temporary store.
func testServer(t *testing.T) *natsserver.Server {
	t.Helper()
	server, err := natsserver.NewServer(&natsserver.Options{Host: "127.0.0.1", Port: -1, JetStream: true, StoreDir: t.TempDir(), NoSigs: true, NoLog: true})
	if err != nil {
		t.Fatal(err)
	}
	go server.Start()
	if !server.ReadyForConnections(10 * time.Second) {
		t.Fatal("server not ready")
	}
	t.Cleanup(func() {
		server.Shutdown()
		server.WaitForShutdown()
	})
	return server
}

func TestConnectInProcessAndByURL(t *testing.T) {
	server := testServer(t)
	inProcess, err := Connect("jobs", server, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer inProcess.Close()
	byURL, err := Connect("jobs", nil, server.ClientURL(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer byURL.Close()
	if _, err := Connect("jobs", nil, "", nil); err == nil {
		t.Error("connected without a relay")
	}
	if _, err := Connect("jobs.task", server, "", nil); err == nil {
		t.Error("a module name with a dot was taken")
	}
}

// A module's subjects and streams carry its name, and the connection refuses
// to declare anything in another module's namespace.
func TestTheNamespaceIsTheModules(t *testing.T) {
	conn, err := Connect("jobs", testServer(t), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if got := conn.Subject("task", "tile"); got != "jobs.task.tile" {
		t.Errorf("subject %q", got)
	}
	if got := conn.StreamName("tasks"); got != "JOBS_TASKS" {
		t.Errorf("stream %q", got)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := conn.DeclareStream(ctx, jetstream.StreamConfig{Name: "JOBS_TASKS", Subjects: []string{"jobs.task.>"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.DeclareStream(ctx, jetstream.StreamConfig{Name: "JOBS_X", Subjects: []string{"world.event.>"}}); err == nil {
		t.Error("declared a stream on another module's subjects")
	}
	if _, err := conn.DeclareStream(ctx, jetstream.StreamConfig{Name: "WORLD_X", Subjects: []string{"jobs.x.>"}}); err == nil {
		t.Error("declared a stream under another module's name")
	}
}
