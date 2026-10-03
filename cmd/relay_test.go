package cmd

import (
	"context"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/modules/jobs"
	relaymodule "github.com/DebakelOrakel/casas-eternas/internal/modules/relay"
	"github.com/DebakelOrakel/casas-eternas/internal/relay"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// The bus as start.go composes it in a mode that checks identity: the jobs
// module connects with its token and declares its streams, and a worker
// with a worker's token does everything a serving worker does — creates
// the shared consumer on the task stream, pulls a task, says it is still
// working, reports on `done` and `event`, acknowledges — and nothing
// beyond: it may not read the task stream's subjects directly.
func TestWorkerGrantCoversAServingWorker(t *testing.T) {
	tokens, err := token.NewTokens([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	var tree config.Config
	tree.Relay.Storage.Dir = &config.DirStorage{Path: t.TempDir()}
	tree.Relay.Listen = "127.0.0.1:-1"
	bus, err := relaymodule.New(relaymodule.Config{All: tree, Tokens: tokens, Grants: map[string]relay.Grant{token.SubjectWorker: jobs.WorkerGrant()}})
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	module, err := relay.Connect("jobs", bus.Server(), "", relayToken(tokens, "jobs"))
	if err != nil {
		t.Fatalf("the jobs module: %v", err)
	}
	defer module.Close()
	// The streams as the jobs module declares them (streams.go).
	for _, stream := range [][2]string{{"tasks", "task"}, {"done", "done"}, {"events", "event"}} {
		if _, err := module.DeclareStream(ctx, jetstream.StreamConfig{Name: module.StreamName(stream[0]), Subjects: []string{module.Subject(stream[1], ">")}}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := module.JetStream().Publish(ctx, "jobs.task.tile.j1", []byte("task")); err != nil {
		t.Fatal(err)
	}

	workerToken, _, err := tokens.IssueRelay(token.SubjectWorker, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := nats.Connect(bus.URL(), nats.Token(workerToken))
	if err != nil {
		t.Fatalf("a worker: %v", err)
	}
	defer worker.Close()
	js, err := jetstream.New(worker)
	if err != nil {
		t.Fatal(err)
	}
	consumer, err := js.CreateOrUpdateConsumer(ctx, "JOBS_TASKS", jetstream.ConsumerConfig{Durable: "workers", AckPolicy: jetstream.AckExplicitPolicy})
	if err != nil {
		t.Fatalf("the worker creates the shared consumer: %v", err)
	}
	if _, err := js.Consumer(ctx, "JOBS_TASKS", "workers"); err != nil {
		t.Fatalf("the worker reads the consumer: %v", err)
	}
	batch, err := consumer.Fetch(1, jetstream.FetchMaxWait(5*time.Second))
	if err != nil {
		t.Fatalf("the worker pulls: %v", err)
	}
	pulled := 0
	for msg := range batch.Messages() {
		pulled++
		if err := msg.InProgress(); err != nil {
			t.Fatalf("still working: %v", err)
		}
		if err := worker.Publish("jobs.event.j1", []byte("{}")); err != nil {
			t.Fatal(err)
		}
		if _, err := js.Publish(ctx, "jobs.done.t1", []byte("{}")); err != nil {
			t.Fatalf("the worker reports done: %v", err)
		}
		if err := msg.DoubleAck(ctx); err != nil {
			t.Fatalf("the worker acknowledges: %v", err)
		}
	}
	if err := batch.Error(); err != nil {
		t.Fatalf("the pull: %v", err)
	}
	if pulled != 1 {
		t.Fatalf("pulled %d tasks, want 1", pulled)
	}

	// Beyond the grant: a stream's management is the module's. The refusal
	// comes back as no answer, so the call waits out its own short deadline.
	refused, cancelRefused := context.WithTimeout(ctx, time.Second)
	defer cancelRefused()
	if err := js.DeleteStream(refused, "JOBS_DONE"); err == nil {
		t.Error("the worker deleted a stream")
	}
}
