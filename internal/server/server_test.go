package server

import (
	"net/http"
	"strings"
	"testing"
)

// A module whose Mount registers whatever patterns it is given — enough to
// provoke ServeMux's own duplicate-pattern panic, which is the realistic way
// a Mount blows up.
type patternModule struct{ patterns []string }

func (m patternModule) Name() string { return "pattern" }
func (m patternModule) Mount(mux *http.ServeMux) error {
	for _, p := range m.patterns {
		mux.HandleFunc(p, func(http.ResponseWriter, *http.Request) {})
	}
	return nil
}
func (m patternModule) Close() error { return nil }

// Two modules claiming one route is a composition bug in cmd/, and it must
// surface as an error naming the conflict — not as a process-killing panic
// from inside the mount loop.
func TestMountTurnsPanicsIntoErrors(t *testing.T) {
	mux := http.NewServeMux()
	if err := mount(patternModule{patterns: []string{"GET /v1/things"}}, mux); err != nil {
		t.Fatalf("first claim: %v", err)
	}
	err := mount(patternModule{patterns: []string{"GET /v1/things"}}, mux)
	if err == nil {
		t.Fatal("a duplicate route pattern mounted without complaint")
	}
	if !strings.Contains(err.Error(), "panic") {
		t.Errorf("the error should say it was a recovered panic, got: %v", err)
	}
}
