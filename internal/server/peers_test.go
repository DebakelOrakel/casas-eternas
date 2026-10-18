package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
)

// The process the browser asks reports its peers' modules and values beside
// its own; its own values win; a peer that does not answer is left out; and
// a peer is asked for its own only, so peers that name each other do not
// ask round in a circle.
func TestCapabilitiesReportThePeers(t *testing.T) {
	var asked []string
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.URL.RawQuery)
		_, _ = w.Write([]byte(`{"modules":["jobs","relay"],"version":"other","jobWorkers":6,"bakeRunner":"peer"}`))
	}))
	defer peer.Close()
	silent := httptest.NewServer(http.NotFoundHandler())
	silentURL := silent.URL
	silent.Close()

	handler := capabilitiesHandler([]string{"client", "world"}, map[string]any{"bakeRunner": "own"}, "this", newPeerCache([]string{peer.URL + "/", silentURL}))
	answer := func(query string) map[string]any {
		recorder := httptest.NewRecorder()
		handler(recorder, httptest.NewRequest(http.MethodGet, CapabilitiesPath+query, nil))
		var body map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	modules := func(body map[string]any) []string {
		var out []string
		for _, m := range body["modules"].([]any) {
			out = append(out, m.(string))
		}
		return out
	}

	body := answer("")
	if got := modules(body); !slices.Equal(got, []string{"client", "world", "jobs", "relay"}) {
		t.Errorf("modules = %v, want own then the peer's", got)
	}
	if body["jobWorkers"] != float64(6) || body["bakeRunner"] != "own" || body["version"] != "this" {
		t.Errorf("described = %v, want the peer's jobWorkers, the own bakeRunner and version", body)
	}
	if len(asked) != 1 || asked[0] != localQuery {
		t.Errorf("the peer was asked %q, want once with ?%s", asked, localQuery)
	}
	// Cached: a second answer asks nobody.
	_ = answer("")
	if len(asked) != 1 {
		t.Errorf("the peer was asked %d times, want the cached answer", len(asked))
	}
	// Asked for its own only, the process reports itself.
	if got := modules(answer("?" + localQuery)); !slices.Equal(got, []string{"client", "world"}) {
		t.Errorf("?local modules = %v, want only the own", got)
	}
}
