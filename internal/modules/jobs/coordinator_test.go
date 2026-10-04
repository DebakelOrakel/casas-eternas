package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/DebakelOrakel/casas-eternas/internal/relay"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
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
	conn, err := relay.Connect("jobs", server, "", nil)
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
	spec := Spec{Stage: request.Stage, ErosionRounds: request.ErosionRounds, StageName: request.StageName()}
	if request.Scope.Kind == ScopeTile {
		spec.Tile = &TileRef{X: request.Scope.X, Y: request.Scope.Y}
	}
	return spec, nil
}

// fakeWorker serves tasks as a Node worker would: a level reports a plan —
// two level-2 tiles, the second downstream of the first, and a level-3
// tile on the first — a tile reports done, or `failTile` fails, when set.
// Returns how many tasks it computed, and how many of them it was allowed
// to reuse; `order` (when not nil) gets each task's stage name as computed.
func fakeWorker(t *testing.T, server *natsserver.Server, failTile bool) (stop func(), computed, reused *atomic.Int32) {
	t.Helper()
	conn, err := relay.Connect("jobs", server, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	consumer, err := conn.JetStream().CreateOrUpdateConsumer(ctx, conn.StreamName(streamTasks), jetstream.ConsumerConfig{Durable: "fake", AckPolicy: jetstream.AckExplicitPolicy})
	if err != nil {
		t.Fatal(err)
	}
	computed, reused = &atomic.Int32{}, &atomic.Int32{}
	consume, err := consumer.Consume(func(msg jetstream.Msg) {
		var spec Spec
		_ = json.Unmarshal(msg.Data(), &spec)
		if spec.Reuse {
			reused.Add(1)
		}
		event, _ := json.Marshal(taskEvent{TaskID: spec.TaskID, Phase: "erosion", Percent: 50})
		_ = conn.NATS().Publish(conn.Subject("event", spec.JobID), event)
		stage := "L1"
		if spec.Tile != nil {
			stage = "L2"
		}
		report := taskDoneReport{TaskID: spec.TaskID, OK: true, Result: &Result{Stage: stage}}
		if spec.Stage == 1 {
			report.Tasks = []plannedTask{
				{Level: 2, X: 1, Y: 0, After: [][3]int{{2, 0, 0}}, Upstream: []TileRef{{X: 0, Y: 0}}},
				{Level: 2, X: 0, Y: 0},
				{Level: 3, X: 0, Y: 0, After: [][3]int{{2, 0, 0}}},
			}
		} else if failTile {
			report = taskDoneReport{TaskID: spec.TaskID, Error: "tile went wrong"}
		}
		place := "L1"
		if spec.Tile != nil {
			place = fmt.Sprintf("L%d:%d,%d", spec.Stage, spec.Tile.X, spec.Tile.Y)
		}
		computedOrder.Lock()
		computedOrder.names = append(computedOrder.names, place)
		computedOrder.Unlock()
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
	}, computed, reused
}

// The tasks the fake workers computed, in order.
var computedOrder struct {
	sync.Mutex
	names []string
}

// A plan to level 3: every tile after what it waits for — its upstream
// tile, its parent.
func TestCoordinatorRunsTilesInPlanOrder(t *testing.T) {
	server, conn := coordinatorRelay(t)
	reg := newRegistry(jobHistory)
	c, err := newCoordinator(t.TempDir(), conn, reg, plainSpec, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	computedOrder.Lock()
	computedOrder.names = nil
	computedOrder.Unlock()
	stop, computed, _ := fakeWorker(t, server, false)
	defer stop()
	job := submitted(t, c, reg, Request{WorldUID: "w", Stage: 3, Scope: Scope{Kind: ScopeWorld}, Plan: PlanRefine})
	waitForJob(t, reg, job.ID, StateDone)
	computedOrder.Lock()
	order := append([]string(nil), computedOrder.names...)
	computedOrder.Unlock()
	at := map[string]int{}
	for i, name := range order {
		at[name] = i
	}
	if computed.Load() != 4 || at["L2:0,0"] > at["L2:1,0"] || at["L2:0,0"] > at["L3:0,0"] || at["L1"] != 0 {
		t.Errorf("computed %d in order %v", computed.Load(), order)
	}
	// Its levels, counted: one task at level 1, two at 2, one at 3, all
	// done, each started and ended.
	job, _ = reg.get(job.ID)
	want := map[int]int{1: 1, 2: 2, 3: 1}
	if len(job.Levels) != 3 {
		t.Fatalf("levels %+v", job.Levels)
	}
	for _, lp := range job.Levels {
		if lp.Total != want[lp.Stage] || lp.Done != lp.Total || lp.StartedAt == nil || lp.EndedAt == nil {
			t.Errorf("level %+v", lp)
		}
	}
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
	c, err := newCoordinator(t.TempDir(), conn, reg, plainSpec, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	stop, computed, _ := fakeWorker(t, server, false)
	defer stop()
	job := submitted(t, c, reg, Request{WorldUID: "w", Stage: 2, ErosionRounds: 12, Scope: Scope{Kind: ScopeWorld}, Plan: PlanRefine})
	done := waitForJob(t, reg, job.ID, StateDone)
	if computed.Load() != 3 || done.Result == nil || done.Result.Stage != "L1" || done.Percent != 100 {
		t.Errorf("computed %d, result %+v, percent %d", computed.Load(), done.Result, done.Percent)
	}
	c.mu.Lock()
	tasks := c.byJob[job.ID]
	tile := c.tasks[tasks[1]]
	c.mu.Unlock()
	// The level-3 tile is past the plan's stage; the first tile waits for
	// level 1 and for its upstream tile, listed after it.
	if len(tasks) != 3 || tile.Request.Stage != 2 || tile.Request.Scope.X != 1 || len(tile.Deps) != 2 || tile.Deps[0] != tasks[0] || tile.Deps[1] != tasks[2] || len(tile.Upstream) != 1 {
		t.Errorf("tasks %v, tile %+v", tasks, tile)
	}
}

// A plan stops at the level it refines up to, and its tasks may reuse what is
// already there; a single order may not.
func TestCoordinatorStopsAPlanAtItsStage(t *testing.T) {
	server, conn := coordinatorRelay(t)
	reg := newRegistry(jobHistory)
	c, err := newCoordinator(t.TempDir(), conn, reg, plainSpec, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	stop, computed, reused := fakeWorker(t, server, false)
	defer stop()
	plan := submitted(t, c, reg, Request{WorldUID: "w", Stage: 1, Scope: Scope{Kind: ScopeWorld}, Plan: PlanRefine})
	waitForJob(t, reg, plan.ID, StateDone)
	if computed.Load() != 1 || reused.Load() != 1 {
		t.Errorf("plan to stage 1: computed %d, reused %d, want 1 and 1", computed.Load(), reused.Load())
	}
	single := submitted(t, c, reg, Request{WorldUID: "w", Stage: 1, Scope: Scope{Kind: ScopeWorld}})
	waitForJob(t, reg, single.ID, StateDone)
	if computed.Load() != 2 || reused.Load() != 1 {
		t.Errorf("single order: computed %d, reused %d, want 2 and 1", computed.Load(), reused.Load())
	}
}

// A failed task ends its job, and says why.
func TestCoordinatorFailsAJobOnAFailedTask(t *testing.T) {
	server, conn := coordinatorRelay(t)
	reg := newRegistry(jobHistory)
	c, err := newCoordinator(t.TempDir(), conn, reg, plainSpec, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	stop, _, _ := fakeWorker(t, server, true)
	defer stop()
	job := submitted(t, c, reg, Request{WorldUID: "w", Stage: 2, Scope: Scope{Kind: ScopeWorld}, Plan: PlanRefine})
	failed := waitForJob(t, reg, job.ID, StateFailed)
	if !strings.Contains(failed.Error, "tile went wrong") {
		t.Errorf("error %q", failed.Error)
	}
}

// A cancelled job's queued task is withdrawn from the relay.
func TestCoordinatorWithdrawsACancelledJob(t *testing.T) {
	_, conn := coordinatorRelay(t)
	reg := newRegistry(jobHistory)
	c, err := newCoordinator(t.TempDir(), conn, reg, plainSpec, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	job := submitted(t, c, reg, Request{WorldUID: "w", Stage: 1, Scope: Scope{Kind: ScopeWorld}})
	// Another job's task stays.
	submitted(t, c, reg, Request{WorldUID: "v", Stage: 1, Scope: Scope{Kind: ScopeWorld}})
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
	if info.State.Msgs != 1 {
		t.Errorf("%d tasks left on the relay, want the other job's one", info.State.Msgs)
	}
}

// A coordinator started again over the same jobs.db knows its jobs, and a
// job whose task waited finishes once a worker comes.
func TestCoordinatorSurvivesARestart(t *testing.T) {
	server, conn := coordinatorRelay(t)
	dir := t.TempDir()
	reg := newRegistry(jobHistory)
	c, err := newCoordinator(dir, conn, reg, plainSpec, nil)
	if err != nil {
		t.Fatal(err)
	}
	job := submitted(t, c, reg, Request{WorldUID: "w", Stage: 2, Scope: Scope{Kind: ScopeWorld}, Plan: PlanRefine})
	c.close()

	again := newRegistry(jobHistory)
	c2, err := newCoordinator(dir, conn, again, plainSpec, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.close()
	if restored, ok := again.get(job.ID); !ok || restored.State != StateQueued {
		t.Fatalf("restored %+v, %v", restored, ok)
	}
	stop, computed, _ := fakeWorker(t, server, false)
	defer stop()
	waitForJob(t, again, job.ID, StateDone)
	// The level was published once, before the restart; a second publish of
	// it would have been dropped by its message id.
	if computed.Load() != 3 {
		t.Errorf("computed %d tasks, want 3", computed.Load())
	}
}

// A worker holding a task gets a fresh job token for it, naming the job and
// its world; once the job is cancelled, or for a task that is not there,
// it gets none — which is what makes a cancel stop a worker's writes.
func TestCoordinatorRenewsTokensForOpenTasksOnly(t *testing.T) {
	_, conn := coordinatorRelay(t)
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatal(err)
	}
	reg := newRegistry(jobHistory)
	c, err := newCoordinator(t.TempDir(), conn, reg, plainSpec, func(jobID, worldUID string) (string, time.Time, error) {
		return tokens.IssueJob(jobID, worldUID, time.Hour)
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	ask := func(taskID string) tokenReply {
		t.Helper()
		msg, err := conn.NATS().Request(conn.Subject("token", taskID), nil, 5*time.Second)
		if err != nil {
			t.Fatalf("token request: %v", err)
		}
		var reply tokenReply
		if err := json.Unmarshal(msg.Data, &reply); err != nil {
			t.Fatal(err)
		}
		return reply
	}
	job := submitted(t, c, reg, Request{WorldUID: "w", Stage: 1, Scope: Scope{Kind: ScopeWorld}})

	fresh := ask(job.ID + "-0")
	if fresh.Token == "" {
		t.Fatalf("no token for an open task: %+v", fresh)
	}
	if time.Until(fresh.ExpiresAt) <= 0 {
		t.Errorf("the token expires at %v", fresh.ExpiresAt)
	}
	subject, jobID, world, err := tokens.VerifyJob(fresh.Token)
	if err != nil || subject != token.SubjectJob || jobID != job.ID || world != "w" {
		t.Errorf("token names %q %q %q (%v), want the job and its world", subject, jobID, world, err)
	}
	if reply := ask("no-such-task"); reply.Token != "" || reply.Error == "" {
		t.Errorf("an unknown task got %+v", reply)
	}
	if !c.cancelJob(job.ID) {
		t.Fatal("cancel refused")
	}
	if reply := ask(job.ID + "-0"); reply.Token != "" || reply.Error == "" {
		t.Errorf("a cancelled job's task got %+v", reply)
	}
}
