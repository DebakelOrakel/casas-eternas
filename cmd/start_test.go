package cmd

import (
	"os"
	"testing"
)

// Moved here with the function (2026-08-12): the address a bake Job comes
// back to is composition, not bake mechanics.
func TestServerBaseURLUsesTheListenPort(t *testing.T) {
	t.Setenv("CASAS_POD_IP", "10.1.2.3")
	if got := serverBaseURL(":9090"); got != "http://10.1.2.3:9090/v1" {
		t.Errorf("serverBaseURL = %q", got)
	}
	if got := serverBaseURL("0.0.0.0:8080"); got != "http://10.1.2.3:8080/v1" {
		t.Errorf("serverBaseURL = %q", got)
	}
	// Without the downward API there is no address a Job could come back to,
	// and an empty string is what makes the composition refuse rather than
	// create Jobs that cannot reach anything.
	_ = os.Unsetenv("CASAS_POD_IP")
	if got := serverBaseURL(":8080"); got != "" {
		t.Errorf("serverBaseURL without POD_IP = %q, want empty", got)
	}
}
