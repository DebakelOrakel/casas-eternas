package jobs

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/DebakelOrakel/casas-eternas/internal/relay"
)

// A relay with the jobs streams, for the coordinator's tests.
func coordinatorRelay(t *testing.T) (*natsserver.Server, *relay.Conn) {
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
	conn, err := relay.Connect("jobs", server, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(conn.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := declareStreams(ctx, conn); err != nil {
		t.Fatal(err)
	}
	return server, conn
}

func plainSpec(_ context.Context, _ string, request Request) (Spec, error) {
	return Spec{Stage: request.Stage, ErosionRounds: request.ErosionRounds, StageName: request.StageName()}, nil
}

// fakeWorker serves tasks as a Node worker would: a level reports two tiles,
// a tile reports done — or `failTile` fails, when set. Returns how many tasks
// it computed.
func fakeWorker(t *testing.T, server *natsserver.Server, failTile bool) (stop func(), computed *atomic.Int32) {
	t.Helper()
	conn, err := relay.Connect("jobs", server, "")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	consumer, err := conn.JetStream().CreateOrUpdateConsumer(ctx, conn.StreamName(streamTasks), jetstream.ConsumerConfig{Durable: "fake", AckPolicy: jetstream.AckExplicitPolicy})
	if err != nil {
		t.Fatal(err)
	}
	computed = &atomic.Int32{}
	consume, err := consumer.Consume(func(msg jetstream.Msg) {
		var spec Spec
		_ = json.Unmarshal(msg.Data(), &spec)
		event, _ := json.Marshal(taskEvent{TaskID: spec.TaskID, Phase: "erosion", Percent: 50})
		_ = conn.NATS().Publish(conn.Subject("event", spec.JobID), event)
		stage := "L1"
		if spec.Tile != nil {
			stage = "L2"
		}
		report := taskDoneReport{TaskID: spec.TaskID, OK: true, Result: &Result{Stage: stage}}
		if spec.Stage == 1 {
			report.Tiles = [][2]int{{0, 0}, {1, 0}}
		} else if failTile {
			report = taskDoneReport{TaskID: spec.TaskID, Error: "tile went wrong"}
		}
		raw, _ := json.Marshal(report)
		if _, err := conn.JetStream().Publish(ctx, conn.Subject("done", spec.TaskID), raw); err == nil {
			computed.Add(1)
			_ = msg.Ack()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	return func() {
		consume.Stop()
		cancel()
		conn.Close()
	}, computed
}

func waitForJob(t *testing.T, reg *registry, id string, want State) Job {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if job, ok := reg.get(id); ok && job.State == want {
			return job
		}
		time.Sleep(20 * time.Millisecond)
	}
	job, _ := reg.get(id)
	t.Fatalf("job %s is %s (%q), want %s", id, job.State, job.Error, want)
	return job
}

func submitted(t *testing.T, c *coordinator, reg *registry, request Request) Job {
	t.Helper()
	job := reg.add(Job{ID: newID(), Request: request, State: StateQueued, QueuedAt: time.Now()})
	if err := c.submit(job); err != nil {
		t.Fatal(err)
	}
	return job
}

// A refine plan: level 1, then the tiles the level reports, each after it.
func TestCoordinatorRunsARefinePlan(t *testing.T) {
	server, conn := coordinatorRelay(t)
	reg := newRegistry(jobHistory)
	c, err := newCoordinator(t.TempDir(), conn, reg, plainSpec)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	stop, computed := fakeWorker(t, server, false)
	defer stop()
	job := submitted(t, c, reg, Request{WorldUID: "w", Stage: 1, ErosionRounds: 12, Scope: Scope{Kind: ScopeWorld}, Plan: PlanRefine})
	done := waitForJob(t, reg, job.ID, StateDone)
	if computed.Load() != 3 || done.Result == nil || done.Result.Stage != "L1" || done.Percent != 100 {
		t.Errorf("computed %d, result %+v, percent %d", computed.Load(), done.Result, done.Percent)
	}
	c.mu.Lock()
	tasks := c.byJob[job.ID]
	tile := c.tasks[tasks[1]]
	c.mu.Unlock()
	if len(tasks) != 3 || tile.Request.Stage != 2 || len(tile.Deps) != 1 || tile.Deps[0] != tasks[0] {
		t.Errorf("tasks %v, tile %+v", tasks, tile)
	}
}

// A failed task ends its job, and says why.
func TestCoordinatorFailsAJobOnAFailedTask(t *testing.T) {
	server, conn := coordinatorRelay(t)
	reg := newRegistry(jobHistory)
	c, err := newCoordinator(t.TempDir(), conn, reg, plainSpec)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	stop, _ := fakeWorker(t, server, true)
	defer stop()
	job := submitted(t, c, reg, Request{WorldUID: "w", Stage: 1, Scope: Scope{Kind: ScopeWorld}, Plan: PlanRefine})
	failed := waitForJob(t, reg, job.ID, StateFailed)
	if !strings.Contains(failed.Error, "tile went wrong") {
		t.Errorf("error %q", failed.Error)
	}
}

// A cancelled job's queued task is withdrawn from the relay.
func TestCoordinatorWithdrawsACancelledJob(t *testing.T) {
	_, conn := coordinatorRelay(t)
	reg := newRegistry(jobHistory)
	c, err := newCoordinator(t.TempDir(), conn, reg, plainSpec)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	job := submitted(t, c, reg, Request{WorldUID: "w", Stage: 1, Scope: Scope{Kind: ScopeWorld}})
	if !c.cancelJob(job.ID) {
		t.Fatal("cancel refused")
	}
	if c.cancelJob(job.ID) {
		t.Error("a second cancel was taken")
	}
	waitForJob(t, reg, job.ID, StateCancelled)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	info, err := c.stream.Info(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if info.State.Msgs != 0 {
		t.Errorf("%d tasks left on the relay", info.State.Msgs)
	}
}

// A coordinator started again over the same jobs.db knows its jobs, and a
// job whose task waited finishes once a worker comes.
func TestCoordinatorSurvivesARestart(t *testing.T) {
	server, conn := coordinatorRelay(t)
	dir := t.TempDir()
	reg := newRegistry(jobHistory)
	c, err := newCoordinator(dir, conn, reg, plainSpec)
	if err != nil {
		t.Fatal(err)
	}
	job := submitted(t, c, reg, Request{WorldUID: "w", Stage: 1, Scope: Scope{Kind: ScopeWorld}, Plan: PlanRefine})
	c.close()

	again := newRegistry(jobHistory)
	c2, err := newCoordinator(dir, conn, again, plainSpec)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.close()
	if restored, ok := again.get(job.ID); !ok || restored.State != StateQueued {
		t.Fatalf("restored %+v, %v", restored, ok)
	}
	stop, computed := fakeWorker(t, server, false)
	defer stop()
	waitForJob(t, again, job.ID, StateDone)
	// The level was published once, before the restart; a second publish of
	// it would have been dropped by its message id.
	if computed.Load() != 3 {
		t.Errorf("computed %d tasks, want 3", computed.Load())
	}
}
