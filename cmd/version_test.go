package cmd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

// A binary with no bake bundle beside it still reports everything it knows.
//
// This is the property worth a test rather than the happy path: `version` is
// most useful on a world or auth target, which HAS no baker, and an earlier
// shape of this command would have returned the lookup error — turning "which
// build am I running" into a failed command on exactly the processes where the
// question gets asked.
func TestVersionReportsWithoutABaker(t *testing.T) {
	viper.Reset()
	t.Cleanup(viper.Reset)
	// An empty directory: no casas.yaml to read, and no baker.mjs to find.
	t.Chdir(t.TempDir())
	viper.Set(keyWorker, "job-worker.mjs")

	var out bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&out)
	if err := RunVersion(cmd, nil); err != nil {
		t.Fatalf("version: %v", err)
	}

	text := out.String()
	for _, want := range []string{"casas-eternas", "binary", "api", "/v1", "pipeline", "unknown", "go"} {
		if !strings.Contains(text, want) {
			t.Errorf("version output missing %q:\n%s", want, text)
		}
	}
}
