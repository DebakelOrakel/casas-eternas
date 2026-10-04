package jobs

import (
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// A worker is listed while it reports, gone when it says it leaves or when
// it has not been heard from for presenceGone; a report on another
// worker's subject is not taken.
func TestPresence(t *testing.T) {
	p := newPresence()
	now := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	p.now = func() time.Time { return now }
	report := func(id, subjectID, extra string) {
		p.handle(&nats.Msg{Subject: "jobs.worker." + subjectID, Data: []byte(`{"id":"` + id + `","host":"h-` + id + `","cores":8,"startedAt":"2026-10-04T11:00:00Z"` + extra + `}`)})
	}
	report("a", "a", `,"task":{"jobId":"j","taskId":"j-3","phase":"erosion","percent":40}`)
	report("b", "b", "")
	report("c", "other", "")
	listed := p.list()
	if len(listed) != 2 || listed[0].ID != "a" || listed[0].Task == nil || listed[0].Task.Percent != 40 || listed[1].Task != nil {
		t.Fatalf("listed = %+v", listed)
	}
	report("b", "b", `,"leaving":true`)
	if listed := p.list(); len(listed) != 1 || listed[0].ID != "a" {
		t.Errorf("after b left = %+v", listed)
	}
	now = now.Add(presenceGone + time.Second)
	if listed := p.list(); len(listed) != 0 {
		t.Errorf("after a went quiet = %+v", listed)
	}
}
