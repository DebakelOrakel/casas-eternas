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
//   - TASKS  jobs.task.<pool>[.urgent] — the tasks, a work queue: each one
//     goes to exactly one worker. Its message id is the task id, so a task
//     published twice (a coordinator restarting) is dropped by JetStream.
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
