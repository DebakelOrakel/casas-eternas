package jobs

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/DebakelOrakel/casas-eternas/internal/httpjson"
)

// WORKERS ON THE BUS: who is connected now, for the admin window's Worker
// section (docs/decisions/client-accounts.md, fork 8). A worker says it is
// there on jobs.worker.<id> every presenceEvery, with what it is doing; one
// not heard from for presenceGone is gone, and one that stops says so.
//
// The jobs module's knowledge, not the relay's or the auth module's: a
// worker is a jobs worker, and what it reports (its task, its phase) is
// jobs vocabulary. What a worker says of itself — its host, its service
// account — is its own word: the bus does not tell a subscriber who
// published. Good enough for a view of the fleet; nothing is decided by it.

const (
	presenceEvery = 15 * time.Second
	presenceGone  = 3 * presenceEvery
)

// WorkerPresence is one worker as it last reported, plus when that was.
type WorkerPresence struct {
	ID string `json:"id"`
	// Account is the service account it proved itself with; empty for a
	// worker of the jobs module's own pool.
	Account   string    `json:"account,omitempty"`
	Host      string    `json:"host"`
	Cores     int       `json:"cores"`
	Pools     []string  `json:"pools,omitempty"`
	Build     string    `json:"build,omitempty"`
	StartedAt time.Time `json:"startedAt"`
	// Task is what it computes now; nil while it waits for one.
	Task *struct {
		JobID   string `json:"jobId"`
		TaskID  string `json:"taskId"`
		Stage   string `json:"stage,omitempty"`
		Phase   string `json:"phase,omitempty"`
		Percent int    `json:"percent"`
	} `json:"task,omitempty"`
	// Leaving: the worker is stopping; it is dropped at once.
	Leaving bool      `json:"leaving,omitempty"`
	SeenAt  time.Time `json:"seenAt"`
}

type presence struct {
	mu      sync.Mutex
	workers map[string]WorkerPresence
	now     func() time.Time
}

func newPresence() *presence {
	return &presence{workers: map[string]WorkerPresence{}, now: time.Now}
}

func (p *presence) handle(msg *nats.Msg) {
	var report WorkerPresence
	if err := json.Unmarshal(msg.Data, &report); err != nil || report.ID == "" || !strings.HasSuffix(msg.Subject, "."+report.ID) {
		slog.Debug("jobs: an unreadable worker presence", "subject", msg.Subject)
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if report.Leaving {
		delete(p.workers, report.ID)
		return
	}
	report.SeenAt = p.now()
	p.workers[report.ID] = report
}

// list answers the workers heard from within presenceGone, by host, and
// forgets the others.
func (p *presence) list() []WorkerPresence {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	out := make([]WorkerPresence, 0, len(p.workers))
	for id, w := range p.workers {
		if now.Sub(w.SeenAt) > presenceGone {
			delete(p.workers, id)
			continue
		}
		out = append(out, w)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Host != out[j].Host {
			return out[i].Host < out[j].Host
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// workersAnswer is what GET /v1/jobs/workers answers. `connected` and
// `wanted` to anyone who may see jobs: the jobs window says "2 of 6
// workers connected" while a cluster scales up, which is otherwise a
// silent wait. `wanted` is the replicas the scaler last set, or this
// process's own workers; absent before the scaler has looked. The list
// itself — hosts, accounts — to an admin only: the operator's business.
type workersAnswer struct {
	Connected int              `json:"connected"`
	Wanted    *int             `json:"wanted,omitempty"`
	Workers   []WorkerPresence `json:"workers,omitempty"`
}

func (m *Module) handleWorkers(w http.ResponseWriter, r *http.Request) {
	listed := m.coord.presence.list()
	answer := workersAnswer{Connected: len(listed)}
	wanted := m.slots
	if m.scaler != nil {
		wanted = int(m.scaler.wanted.Load())
	}
	if wanted >= 0 {
		answer.Wanted = &wanted
	}
	// Where nothing checks identity, everyone counts as admin, as every
	// check answers yes there.
	if !m.cfg.Identity.ChecksIdentity() || m.cfg.Identity.Admin(r) {
		answer.Workers = listed
		if answer.Workers == nil {
			answer.Workers = []WorkerPresence{}
		}
	}
	httpjson.Write(w, http.StatusOK, answer)
}
