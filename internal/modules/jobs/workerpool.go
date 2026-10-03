package jobs

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// The LOCAL WORKERS (docs/decisions/detail-ladder.md, "Workers"): long-lived
// Node processes serving the coordinator's tasks over the relay
// (`job-worker.mjs --serve`). The module starts `jobs.max-concurrent` of them
// and keeps them: one that dies is started again after a pause. They replace
// the subprocess per job — a worker keeps the parent level it has read, tile
// after tile.

// serveConfig is the worker's serving argument, its one JSON argv entry.
type serveConfig struct {
	Relay string   `json:"relay"`
	Pools []string `json:"pools"`
}

const (
	// The pause before a worker that died is started again: long enough not
	// to spin on a worker that cannot start, short enough not to be noticed.
	workerRestartPause = 3 * time.Second
	// How long a worker may take to finish after it was asked to stop.
	workerStopGrace = 10 * time.Second
	// How long a local worker's bus token holds. Minted at every start of
	// the worker, so this bounds only how long one worker may run without a
	// restart before a reconnect is refused — far beyond any job.
	workerTokenTTL = 30 * 24 * time.Hour
)

// workerTokenEnv carries a worker's bus token into the process: in its
// environment, not its argv, where any `ps` would show it. Not a CASAS_*
// name, which is the server's configuration namespace.
const workerTokenEnv = "RELAY_TOKEN"

type workerPool struct {
	cancel context.CancelFunc
	done   sync.WaitGroup
}

// startWorkerPool starts `count` serving workers on the relay at `relayURL`.
// With `tokens` (a mode that checks identity, so the relay does) each
// worker is started with a bus token of its own.
func startWorkerPool(workerPath, relayURL string, count, maxHeapMB int, tokens *token.Tokens) *workerPool {
	ctx, cancel := context.WithCancel(context.Background())
	pool := &workerPool{cancel: cancel}
	config, _ := json.Marshal(serveConfig{Relay: relayURL, Pools: []string{poolLevel, poolTile}})
	for i := range count {
		pool.done.Add(1)
		go func() {
			defer pool.done.Done()
			for ctx.Err() == nil {
				runWorker(ctx, i, workerPath, string(config), maxHeapMB, tokens)
				select {
				case <-ctx.Done():
				case <-time.After(workerRestartPause):
				}
			}
		}()
	}
	slog.Info("job workers started", "count", count, "relay", relayURL)
	return pool
}

// runWorker runs one worker until it exits or the pool stops.
func runWorker(ctx context.Context, index int, workerPath, config string, maxHeapMB int, tokens *token.Tokens) {
	cmd := exec.Command("node", "--max-old-space-size="+strconv.Itoa(maxHeapMB), workerPath, "--serve", config)
	if tokens != nil {
		busToken, _, err := tokens.IssueRelay(token.SubjectWorker, workerTokenTTL)
		if err != nil {
			slog.Error("job worker: no bus token", "worker", index, "err", err)
			return
		}
		cmd.Env = append(os.Environ(), workerTokenEnv+"="+busToken)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		slog.Error("job worker", "worker", index, "err", err)
		return
	}
	cmd.Stdout = io.Discard
	if err := cmd.Start(); err != nil {
		slog.Error("job worker did not start", "worker", index, "err", err)
		return
	}
	// The worker's own lines (its progress goes over the relay).
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			slog.Info("job worker", "worker", index, "says", scanner.Text())
		}
	}()
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case err := <-exited:
		if ctx.Err() == nil {
			slog.Warn("job worker exited, starting it again", "worker", index, "err", err)
		}
	case <-ctx.Done():
		// Asked to stop: a task in hand is left unacknowledged and goes to
		// another worker, which is harmless, a task being pure.
		_ = cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-exited:
		case <-time.After(workerStopGrace):
			_ = cmd.Process.Kill()
			<-exited
		}
	}
}

func (p *workerPool) stop() {
	p.cancel()
	p.done.Wait()
}
