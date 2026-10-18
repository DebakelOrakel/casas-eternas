package jobs

import (
	"os"
	"regexp"
	"strconv"
	"testing"
)

// Two numbers in this package are copies of numbers that live elsewhere and
// cannot be imported: the erosion rounds mirror a TypeScript constant, the
// Node heap ceiling is repeated in the chart's values (deploy/helm), which
// put it on the worker Deployment's command line. Their
// comments say "change the two together"; this test is what makes that
// true rather than hoped for.

func mirrored(t *testing.T, text, pattern string) int {
	t.Helper()
	match := regexp.MustCompile(pattern).FindStringSubmatch(text)
	if match == nil {
		t.Fatalf("pattern %q not found", pattern)
	}
	value, err := strconv.Atoi(match[1])
	if err != nil {
		t.Fatalf("pattern %q matched %q, not a number", pattern, match[1])
	}
	return value
}

func TestErosionRoundsMirrorTheClient(t *testing.T) {
	source, err := os.ReadFile("../../../client/src/world/bakeSettings.ts")
	if err != nil {
		t.Skipf("client source not beside the server: %v", err)
	}
	if got := mirrored(t, string(source), `AMPLIFY_EROSION_ROUNDS = (\d+)`); got != defaultErosionRounds {
		t.Errorf("client AMPLIFY_EROSION_ROUNDS = %d, defaultErosionRounds = %d", got, defaultErosionRounds)
	}
}

func TestNodeHeapMirrorsTheWorkerDeployment(t *testing.T) {
	values, err := os.ReadFile("../../../deploy/helm/values.yaml")
	if err != nil {
		t.Skipf("the chart not beside the server: %v", err)
	}
	if got := mirrored(t, string(values), `(?m)^  heapMB: (\d+)`); got != nodeHeapMB {
		t.Errorf("deploy/helm/values.yaml workers.heapMB = %d, nodeHeapMB = %d", got, nodeHeapMB)
	}
}
