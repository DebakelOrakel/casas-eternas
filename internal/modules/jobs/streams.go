package jobs

import (
	"context"
	"fmt"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"github.com/DebakelOrakel/casas-eternas/internal/relay"
)

// The jobs module's streams on the relay (docs/decisions/detail-ladder.md,
// "The relay and the coordinator"):
//
//   - TASKS  jobs.task.<pool>.<jobId> — the tasks, a work queue: each one
//     goes to exactly one worker. Its message id is the task id, so a task
//     published twice (a coordinator restarting) is dropped by JetStream; the
//     job's id last, so a cancel purges the job's tasks in one call.
//   - DONE   jobs.done.<taskId> — what the workers report back, a work queue
//     the coordinator reads.
//   - EVENTS jobs.event.<jobId> — progress, for the client; kept briefly.
const (
	streamTasks  = "tasks"
	streamDone   = "done"
	streamEvents = "events"

	// How long JetStream remembers a task id to drop a second publish.
	taskDedupWindow = 10 * time.Minute
	// How long progress is kept: long enough for a client that reconnects.
	eventRetention = time.Hour
)

// declareStreams creates (or updates) the module's streams.
func declareStreams(ctx context.Context, conn *relay.Conn) error {
	configs := []jetstream.StreamConfig{
		{
			Name:       conn.StreamName(streamTasks),
			Subjects:   []string{conn.Subject("task", ">")},
			Retention:  jetstream.WorkQueuePolicy,
			Duplicates: taskDedupWindow,
		},
		{
			Name:      conn.StreamName(streamDone),
			Subjects:  []string{conn.Subject("done", ">")},
			Retention: jetstream.WorkQueuePolicy,
		},
		{
			Name:      conn.StreamName(streamEvents),
			Subjects:  []string{conn.Subject("event", ">")},
			Retention: jetstream.LimitsPolicy,
			MaxAge:    eventRetention,
		},
	}
	for _, config := range configs {
		if _, err := conn.DeclareStream(ctx, config); err != nil {
			return fmt.Errorf("jobs: stream %s: %w", config.Name, err)
		}
	}
	return nil
}

// WorkerGrant is what a job worker may do on the bus (internal/modules/relay
// gives it to a token with subject token.SubjectWorker): take tasks from
// TASKS through its consumer and acknowledge them, report on its task's
// `done` and its job's `event`, and hear `cancel`. Nothing that reads
// another module's subjects or manages a stream. Mirrors what
// client/scripts/jobWorker.ts's `serve` does; a worker asking for more is
// refused by the bus, which is the point.
func WorkerGrant() relay.Grant {
	const tasks = "JOBS_TASKS"
	return relay.Grant{
		Publish: []string{
			"jobs.done.>",
			"jobs.event.>",
			// A fresh job token for the task in hand (coordinator.go,
			// handleToken); the answer comes back on the worker's inbox.
			"jobs.token.>",
			// That it is there, and what it does (presence.go).
			"jobs.worker.>",
			// The JetStream API calls of a pull consumer on TASKS: the
			// account check, creating or updating the shared consumer,
			// reading it, pulling the next task.
			"$JS.API.INFO",
			"$JS.API.CONSUMER.CREATE." + tasks + ".>",
			"$JS.API.CONSUMER.DURABLE.CREATE." + tasks + ".>",
			"$JS.API.CONSUMER.INFO." + tasks + ".>",
			"$JS.API.CONSUMER.MSG.NEXT." + tasks + ".>",
			// Acknowledgements and "still working" go to the task's reply.
			"$JS.ACK." + tasks + ".>",
		},
		Subscribe: []string{
			"jobs.cancel.>",
			// Replies: the JetStream API's answers and the pulled tasks.
			"_INBOX.>",
		},
	}
}
