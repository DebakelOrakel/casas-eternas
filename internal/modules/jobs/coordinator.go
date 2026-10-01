package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	bolt "go.etcd.io/bbolt"

	"github.com/DebakelOrakel/casas-eternas/internal/relay"
)

// THE COORDINATOR (docs/decisions/detail-ladder.md, "The relay and the
// coordinator"). A job — what a caller orders — is a graph of TASKS: pure
// computations whose dependencies are declared before they start, each with
// one artifact as its result. The coordinator publishes every task whose
// dependencies are done to the relay (`jobs.task.<pool>.<jobId>`), a worker computes
// it and reports on `jobs.done.<taskId>`, and the coordinator releases what
// waited on it. Which worker computes what, and when, changes no byte.
//
// Its state lives in bbolt (jobs.db) and is written through on every change,
// so a restart picks up where it stood: what was published is still in
// JetStream, what was ready and not yet published is published again (the
// task id is the message id, so JetStream drops a second copy).

// Task pools — a worker pulls from the pools it serves.
const (
	poolLevel = "level"
	poolTile  = "tile"
)

// The plan a job runs. Empty: one task, the request itself. PlanRefine:
// level 1, then every land and shelf tile the level reports.
const PlanRefine = "refine"

// The highest level a refine plan reaches: level 1, then the tiles of
// levels 2 and 3 (docs/decisions/detail-ladder.md, step 5). Level 4 is on
// demand near the camera, never planned.
const maxRefineStage = 3

// The deepest level with tiles (TILE_SPECS in the client's meshTile.ts).
const maxTileStage = 3

type taskState string

const (
	taskWaiting   taskState = "waiting"
	taskQueued    taskState = "queued"
	taskRunning   taskState = "running"
	taskDone      taskState = "done"
	taskFailed    taskState = "failed"
	taskCancelled taskState = "cancelled"
)

// Task is one computation of a job.
type Task struct {
	ID      string    `json:"id"`
	JobID   string    `json:"jobId"`
	Pool    string    `json:"pool"`
	Request Request   `json:"request"`
	Deps    []string  `json:"deps,omitempty"`
	State   taskState `json:"state"`
	// For a tile: the upstream tiles of its level, handed to the worker
	// (Spec.Upstream).
	Upstream []TileRef `json:"upstream,omitempty"`
	Error    string    `json:"error,omitempty"`
	Result   *Result   `json:"result,omitempty"`
}

// taskDone is what a worker reports on jobs.done.<taskId>.
type taskDoneReport struct {
	TaskID string  `json:"taskId"`
	OK     bool    `json:"ok"`
	Error  string  `json:"error,omitempty"`
	Result *Result `json:"result,omitempty"`
	// For the level task of a refine plan: the tile levels' tasks, planned
	// from level 1's drainage by the worker (client/src/generator/pipeline/
	// tilePlan.ts). The coordinator wires them and knows no hydrology.
	Tasks []plannedTask `json:"tasks,omitempty"`
}

// plannedTask is one tile of a refine plan: its level and place, the
// tiles it waits for (its parents and its upstream tiles, as [level, x,
// y]), and the upstream tiles of its own level, whose outflow it reads.
type plannedTask struct {
	Level    int       `json:"level"`
	X        int       `json:"x"`
	Y        int       `json:"y"`
	After    [][3]int  `json:"after,omitempty"`
	Upstream []TileRef `json:"upstream,omitempty"`
}

// taskEvent is what a worker reports on jobs.event.<jobId> while it works.
type taskEvent struct {
	TaskID  string `json:"taskId"`
	Phase   string `json:"phase"`
	Percent int    `json:"percent"`
}

var (
	bucketJobs  = []byte("jobs")
	bucketTasks = []byte("tasks")
)

// specFor resolves a task's request into what the worker needs (where the
// world and the artifact store are, a token) — the jobs module's own spec
// builder, shared with the cluster runner.
type specFor func(ctx context.Context, jobID string, request Request) (Spec, error)

type coordinator struct {
	mu       sync.Mutex
	db       *bolt.DB
	conn     *relay.Conn
	registry *registry
	spec     specFor
	tasks    map[string]*Task
	byJob    map[string][]string
	stream   jetstream.Stream
	consume  jetstream.ConsumeContext
	events   *nats.Subscription
	ctx      context.Context
	cancel   context.CancelFunc
}

// newCoordinator opens jobs.db, restores the jobs into the registry, and
// starts reading the workers' reports.
func newCoordinator(dir string, conn *relay.Conn, reg *registry, spec specFor) (*coordinator, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("jobs.storage: %w", err)
	}
	db, err := bolt.Open(filepath.Join(dir, "jobs.db"), 0o600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, fmt.Errorf("jobs.storage: %w (is another process holding jobs.db?)", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &coordinator{db: db, conn: conn, registry: reg, spec: spec, tasks: map[string]*Task{}, byJob: map[string][]string{}, ctx: ctx, cancel: cancel}
	fail := func(err error) (*coordinator, error) {
		c.close()
		return nil, err
	}
	if err := c.load(); err != nil {
		return fail(err)
	}
	js := conn.JetStream()
	c.stream, err = js.Stream(ctx, conn.StreamName(streamTasks))
	if err != nil {
		return fail(fmt.Errorf("jobs: %w", err))
	}
	done, err := js.CreateOrUpdateConsumer(ctx, conn.StreamName(streamDone), jetstream.ConsumerConfig{
		Durable:   "coordinator",
		AckPolicy: jetstream.AckExplicitPolicy,
	})
	if err != nil {
		return fail(fmt.Errorf("jobs: %w", err))
	}
	c.consume, err = done.Consume(c.handleDone)
	if err != nil {
		return fail(fmt.Errorf("jobs: %w", err))
	}
	// Progress is fleeting: a core subscription, no acknowledgement.
	c.events, err = conn.NATS().Subscribe(conn.Subject("event", "*"), c.handleEvent)
	if err != nil {
		return fail(fmt.Errorf("jobs: %w", err))
	}
	c.reconcile()
	return c, nil
}

// load reads jobs.db into the registry and the task table.
func (c *coordinator) load() error {
	return c.db.Update(func(tx *bolt.Tx) error {
		jobsBucket, err := tx.CreateBucketIfNotExists(bucketJobs)
		if err != nil {
			return err
		}
		tasksBucket, err := tx.CreateBucketIfNotExists(bucketTasks)
		if err != nil {
			return err
		}
		var restored []Job
		if err := jobsBucket.ForEach(func(_, value []byte) error {
			var job Job
			if err := json.Unmarshal(value, &job); err != nil {
				return err
			}
			restored = append(restored, job)
			return nil
		}); err != nil {
			return err
		}
		sort.Slice(restored, func(i, j int) bool { return restored[i].QueuedAt.Before(restored[j].QueuedAt) })
		for _, job := range restored {
			c.registry.add(job)
		}
		return tasksBucket.ForEach(func(_, value []byte) error {
			var task Task
			if err := json.Unmarshal(value, &task); err != nil {
				return err
			}
			c.tasks[task.ID] = &task
			c.byJob[task.JobID] = append(c.byJob[task.JobID], task.ID)
			return nil
		})
	})
}

// save writes a job and tasks through to jobs.db.
func (c *coordinator) save(job *Job, tasks ...*Task) {
	err := c.db.Update(func(tx *bolt.Tx) error {
		if job != nil {
			raw, err := json.Marshal(job)
			if err != nil {
				return err
			}
			if err := tx.Bucket(bucketJobs).Put([]byte(job.ID), raw); err != nil {
				return err
			}
		}
		for _, task := range tasks {
			raw, err := json.Marshal(task)
			if err != nil {
				return err
			}
			if err := tx.Bucket(bucketTasks).Put([]byte(task.ID), raw); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		slog.Error("jobs.db write failed", "err", err)
	}
}

// updateJob mutates a job in the registry and writes it through.
func (c *coordinator) updateJob(id string, mutate func(*Job)) (Job, bool) {
	job, ok := c.registry.update(id, mutate)
	if ok {
		c.save(&job)
	}
	return job, ok
}

// submit plans a job and publishes what can start.
func (c *coordinator) submit(job Job) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	first := &Task{ID: job.ID + "-0", JobID: job.ID, Pool: poolFor(job.Request), Request: job.Request, State: taskWaiting}
	first.Request.Plan = ""
	// A plan starts at level 1, whatever level it refines up to.
	first.Request.Stage = 1
	c.tasks[first.ID] = first
	c.byJob[job.ID] = []string{first.ID}
	c.save(&job, first)
	c.dispatchReady(job.ID)
	return nil
}

func poolFor(request Request) string {
	if request.Scope.Kind == ScopeTile {
		return poolTile
	}
	return poolLevel
}

// dispatchReady publishes every waiting task of the job whose dependencies
// are done. Called with the lock held.
func (c *coordinator) dispatchReady(jobID string) {
	var ready []*Task
	for _, id := range c.byJob[jobID] {
		if task := c.tasks[id]; task.State == taskWaiting && c.depsDone(task) {
			ready = append(ready, task)
		}
	}
	if len(ready) == 0 {
		return
	}
	if err := c.publish(ready); err != nil {
		c.failJob(jobID, fmt.Sprintf("could not hand out the tasks: %v", err))
		return
	}
	c.save(nil, ready...)
}

func (c *coordinator) depsDone(task *Task) bool {
	for _, dep := range task.Deps {
		if d, ok := c.tasks[dep]; !ok || d.State != taskDone {
			return false
		}
	}
	return true
}

// publish hands tasks to the relay, in batches published without waiting
// for each acknowledgement: a refine plan releases thousands of tiles at
// once, and one round trip each, under the lock, held the coordinator for a
// minute (measured 2026-10-01: ~7000 tiles, ~50 s). The task id is the
// message id: a second publish of the same task (a restart) is dropped by
// JetStream.
func (c *coordinator) publish(tasks []*Task) error {
	js := c.conn.JetStream()
	for start := 0; start < len(tasks); start += publishBatch {
		batch := tasks[start:min(start+publishBatch, len(tasks))]
		futures := make([]jetstream.PubAckFuture, 0, len(batch))
		for _, task := range batch {
			spec, err := c.spec(c.ctx, task.JobID, task.Request)
			if err != nil {
				return err
			}
			spec.TaskID = task.ID
			spec.JobID = task.JobID
			spec.Upstream = task.Upstream
			// A plan keeps what is already there; a single order computes again.
			if job, ok := c.registry.get(task.JobID); ok && job.Request.Plan != "" {
				spec.Reuse = true
			}
			raw, err := json.Marshal(spec)
			if err != nil {
				return err
			}
			future, err := js.PublishAsync(c.conn.Subject("task", task.Pool, task.JobID), raw, jetstream.WithMsgID(task.ID))
			if err != nil {
				return err
			}
			futures = append(futures, future)
		}
		select {
		case <-js.PublishAsyncComplete():
		case <-time.After(publishWait):
			return fmt.Errorf("the relay did not acknowledge %d tasks in %s", len(batch), publishWait)
		}
		for i, future := range futures {
			select {
			case <-future.Ok():
				batch[i].State = taskQueued
			case err := <-future.Err():
				return err
			}
		}
	}
	return nil
}

const (
	// Tasks published before waiting for their acknowledgements; below the
	// JetStream context's own limit of pending publishes (4000).
	publishBatch = 1000
	// How long one batch may wait for them.
	publishWait = 30 * time.Second
)

// reconcile publishes, after a restart, what was ready and not published.
func (c *coordinator) reconcile() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for jobID := range c.byJob {
		if job, ok := c.registry.get(jobID); ok && (job.State == StateQueued || job.State == StateRunning) {
			c.dispatchReady(jobID)
		}
	}
}

// handleDone takes a worker's report.
func (c *coordinator) handleDone(msg jetstream.Msg) {
	var report taskDoneReport
	if err := json.Unmarshal(msg.Data(), &report); err != nil {
		slog.Warn("jobs: an unreadable task report", "subject", msg.Subject(), "err", err)
		_ = msg.Term()
		return
	}
	c.mu.Lock()
	c.applyDone(report)
	c.mu.Unlock()
	_ = msg.Ack()
}

func (c *coordinator) applyDone(report taskDoneReport) {
	task, ok := c.tasks[report.TaskID]
	if !ok || task.State == taskDone || task.State == taskCancelled {
		// Unknown, a second report of one done, or one the caller stopped.
		return
	}
	job, ok := c.registry.get(task.JobID)
	if !ok || job.State == StateCancelled || job.State == StateFailed {
		return
	}
	if !report.OK {
		task.State = taskFailed
		task.Error = report.Error
		c.save(nil, task)
		c.failJob(task.JobID, report.Error)
		return
	}
	task.State = taskDone
	task.Result = report.Result
	c.save(nil, task)
	// A refine plan grows its tile levels off its level, up to the level
	// asked for: every tile waits for level 1 and for what the plan says.
	if job.Request.Plan == PlanRefine && task.Pool == poolLevel {
		planned := filterPlanned(report.Tasks, job.Request.Stage)
		byPlace := map[[3]int]string{}
		added := make([]*Task, 0, len(planned))
		for _, p := range planned {
			request := Request{WorldUID: job.Request.WorldUID, Stage: p.Level, ErosionRounds: job.Request.ErosionRounds, Scope: Scope{Kind: ScopeTile, X: p.X, Y: p.Y}}
			t := &Task{ID: fmt.Sprintf("%s-%d", job.ID, len(c.byJob[job.ID])+len(added)), JobID: job.ID, Pool: poolTile, Request: request, Deps: []string{task.ID}, Upstream: p.Upstream, State: taskWaiting}
			byPlace[[3]int{p.Level, p.X, p.Y}] = t.ID
			added = append(added, t)
		}
		// The dependencies once every task has its id: a tile may wait for
		// one listed after it.
		for i, p := range planned {
			for _, after := range p.After {
				if id, ok := byPlace[after]; ok {
					added[i].Deps = append(added[i].Deps, id)
				}
			}
		}
		for _, t := range added {
			c.tasks[t.ID] = t
			c.byJob[job.ID] = append(c.byJob[job.ID], t.ID)
		}
		c.save(nil, added...)
	}
	c.progress(task.JobID)
	c.dispatchReady(task.JobID)
}

// filterPlanned is the plan's tasks up to a level, in the plan's order.
func filterPlanned(tasks []plannedTask, stage int) []plannedTask {
	var out []plannedTask
	for _, t := range tasks {
		if t.Level <= stage {
			out = append(out, t)
		}
	}
	return out
}

// progress says a job's state from its tasks, and ends it when all are done.
func (c *coordinator) progress(jobID string) {
	ids := c.byJob[jobID]
	done := 0
	var first *Task
	for _, id := range ids {
		task := c.tasks[id]
		if first == nil {
			first = task
		}
		if task.State == taskDone {
			done++
		}
	}
	now := time.Now()
	c.updateJob(jobID, func(j *Job) {
		if j.StartedAt == nil {
			j.StartedAt = &now
		}
		if done == len(ids) {
			j.State = StateDone
			j.Percent = 100
			j.EndedAt = &now
			if first != nil {
				j.Result = first.Result
			}
			return
		}
		j.State = StateRunning
		if len(ids) > 1 {
			j.Phase = "tiles"
			j.Percent = (done - 1) * 100 / (len(ids) - 1)
		}
	})
}

// handleEvent takes a worker's progress.
func (c *coordinator) handleEvent(msg *nats.Msg) {
	var event taskEvent
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		return
	}
	jobID := strings.TrimPrefix(msg.Subject, c.conn.Subject("event")+".")
	c.mu.Lock()
	defer c.mu.Unlock()
	task, ok := c.tasks[event.TaskID]
	if !ok || task.JobID != jobID || (task.State != taskQueued && task.State != taskRunning) {
		return
	}
	if task.State == taskQueued {
		task.State = taskRunning
		c.save(nil, task)
	}
	// A job of one task, or the level of a refine plan before its tiles:
	// the task's own phase. Once the tiles run, the share done says more.
	if len(c.byJob[jobID]) > 1 {
		return
	}
	now := time.Now()
	c.updateJob(jobID, func(j *Job) {
		if j.State != StateQueued && j.State != StateRunning {
			return
		}
		if j.StartedAt == nil {
			j.StartedAt = &now
		}
		j.State = StateRunning
		j.Phase = event.Phase
		j.Percent = min(100, max(0, event.Percent))
	})
}

// failJob ends a job and withdraws what of it is still queued. Called with
// the lock held.
func (c *coordinator) failJob(jobID, reason string) {
	c.endJob(jobID, StateFailed, reason)
}

// cancelJob stops a job a caller cancelled; false when it had already ended.
func (c *coordinator) cancelJob(jobID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	job, ok := c.registry.get(jobID)
	if !ok || (job.State != StateQueued && job.State != StateRunning) {
		return false
	}
	c.endJob(jobID, StateCancelled, "")
	// A worker computing one of its tasks stops it.
	_ = c.conn.NATS().Publish(c.conn.Subject("cancel", jobID), nil)
	return true
}

func (c *coordinator) endJob(jobID string, state State, reason string) {
	var ended []*Task
	queued := false
	for _, id := range c.byJob[jobID] {
		task := c.tasks[id]
		if task.State == taskDone || task.State == taskFailed {
			continue
		}
		queued = queued || task.State == taskQueued
		task.State = taskCancelled
		ended = append(ended, task)
	}
	// What waits in the stream goes with one purge of the job's subjects. A
	// task a worker holds is gone from under it too; its report is ignored.
	if queued {
		ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
		if err := c.stream.Purge(ctx, jetstream.WithPurgeSubject(c.conn.Subject("task", "*", jobID))); err != nil {
			slog.Warn("jobs: could not withdraw the tasks", "job", jobID, "err", err)
		}
		cancel()
	}
	c.save(nil, ended...)
	now := time.Now()
	c.updateJob(jobID, func(j *Job) {
		j.State = state
		j.Error = reason
		j.EndedAt = &now
	})
}

func (c *coordinator) close() {
	if c.consume != nil {
		c.consume.Stop()
	}
	if c.events != nil {
		_ = c.events.Unsubscribe()
	}
	c.cancel()
	if c.db != nil {
		_ = c.db.Close()
	}
}
