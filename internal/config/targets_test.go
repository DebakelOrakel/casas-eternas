package config

import "testing"

// Every module is a target the flag accepts by name — relay was missing
// from the parser's own list until 2026-10-02.
func TestEveryModuleParsesAsATarget(t *testing.T) {
	for _, m := range modules {
		got, err := ParseTargets([]string{string(m)})
		if err != nil || !got[m] {
			t.Errorf("target %q: %v", m, err)
		}
	}
	if _, err := ParseTargets([]string{"nonsense"}); err == nil {
		t.Error("an unknown target was accepted")
	}
}
