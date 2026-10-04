package jobs

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"
)

// THE WORKER SCALER (docs/decisions/detail-ladder.md, addendum 2026-10-03):
// in a cluster the coordinator's workers are a Deployment
// (deploy/manifests.yaml, `casas-eternas/component: worker`), and this
// module sets its replicas — not KEDA, because the coordinator knows the
// plan, not only a queue, and the jobs target stays able to run alone.
//
// The rule is deliberately plain: while any job is open, as many workers as
// there are tasks to compute, up to `jobs.max-concurrent`, and NEVER fewer
// than are already running — so no worker is stopped in the middle of a
// task, and no per-pod bookkeeping of who is busy is needed. When every job
// is through, zero. A level-1 job is one task and gets one worker; its
// tiles, once planned, get the rest.
//
// A loop that compares and corrects, not a reaction to events: it also puts
// the number right after this server restarts, or after someone applied the
// manifests and set it back to 0 mid-run.

// How often the scaler looks. Workers take tens of seconds to start; a
// tighter loop would buy nothing.
const scaleEvery = 10 * time.Second

type workerScaler struct {
	api *clusterAPI
	// The open jobs and their handed-out tasks (coordinator.workload).
	workload func() (open, tasks int)
	max      int
	// The replicas last seen or set, -1 before the first look: what the
	// jobs window compares the connected workers with (presence.go).
	wanted atomic.Int64
	// The Deployment the scaler found, remembered so a missing one is said
	// once rather than every ten seconds.
	missingSaid bool
}

// wantWorkers is the rule above: `open` jobs not finished, `tasks` waiting
// to be computed or being computed, `current` replicas now, `max` the cap.
func wantWorkers(open, tasks, current, max int) int {
	if open == 0 {
		return 0
	}
	want := tasks
	if want > max {
		want = max
	}
	if want < 1 {
		// An open job whose next tasks are not planned yet still needs a
		// worker to plan them.
		want = 1
	}
	if want < current {
		want = current
	}
	return want
}

func (s *workerScaler) run(ctx context.Context) {
	ticker := time.NewTicker(scaleEvery)
	defer ticker.Stop()
	for {
		s.step(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *workerScaler) step(ctx context.Context) {
	names, err := s.api.workerDeployments(ctx)
	if err != nil {
		slog.Warn("worker scaler", "err", err)
		return
	}
	if len(names) != 1 {
		if !s.missingSaid {
			slog.Error("worker scaler: want exactly one Deployment labelled "+workerSelector+"; refinements wait until there is", "found", names)
			s.missingSaid = true
		}
		return
	}
	s.missingSaid = false
	current, err := s.api.replicas(ctx, names[0])
	if err != nil {
		slog.Warn("worker scaler", "err", err)
		return
	}
	open, tasks := s.workload()
	want := wantWorkers(open, tasks, current, s.max)
	s.wanted.Store(int64(current))
	if want == current {
		return
	}
	if err := s.api.scale(ctx, names[0], want); err != nil {
		slog.Warn("worker scaler", "err", err)
		return
	}
	s.wanted.Store(int64(want))
	slog.Info("workers scaled", "deployment", names[0], "from", current, "to", want, "open jobs", open, "tasks", tasks)
}
