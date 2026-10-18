package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

// THE PEERS' CAPABILITIES (global.peers, docs/decisions/helm-chart.md): in a
// split deployment the browser asks one process — the one the ingress sends
// /v1/capabilities to — what the server can do, and that process runs only
// some of the modules. With peers it reports theirs too, so the answer is
// the deployment's. Asked when the capabilities are asked, not at start, so
// no process waits for another to start; a peer that does not answer is
// left out, which is the honest answer, and asked again after peerCacheTTL.

// localQuery asks a process for its own capabilities only: what a process
// asks its peers, so two that name each other do not ask round in a circle.
const localQuery = "local"

// How long the peers' answer is kept, and how long one peer may take.
const (
	peerCacheTTL = 10 * time.Second
	peerTimeout  = 2 * time.Second
)

// peerCapabilities is the merged answer of the peers: their modules, and
// the values their modules describe.
type peerCapabilities struct {
	Modules   []string
	Described map[string]any
}

type peerCache struct {
	peers  []string
	client *http.Client

	mu     sync.Mutex
	at     time.Time
	answer peerCapabilities
}

func newPeerCache(peers []string) *peerCache {
	trimmed := make([]string, 0, len(peers))
	for _, peer := range peers {
		if peer = strings.TrimRight(strings.TrimSpace(peer), "/"); peer != "" {
			trimmed = append(trimmed, peer)
		}
	}
	return &peerCache{peers: trimmed, client: &http.Client{Timeout: peerTimeout}}
}

// get answers the peers' capabilities, from the cache while it is fresh.
// Callers wait for one asking at a time, which is what a cache is for.
func (c *peerCache) get(ctx context.Context) peerCapabilities {
	if len(c.peers) == 0 {
		return peerCapabilities{}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.at.IsZero() && time.Since(c.at) < peerCacheTTL {
		return c.answer
	}
	answers := make([]map[string]any, len(c.peers))
	var wg sync.WaitGroup
	for i, peer := range c.peers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answers[i] = c.ask(ctx, peer)
		}()
	}
	wg.Wait()
	merged := peerCapabilities{Described: map[string]any{}}
	for _, answer := range answers {
		if answer == nil {
			continue
		}
		if modules, ok := answer["modules"].([]any); ok {
			for _, module := range modules {
				if name, ok := module.(string); ok && !slices.Contains(merged.Modules, name) {
					merged.Modules = append(merged.Modules, name)
				}
			}
		}
		for key, value := range answer {
			// The modules are merged above; the version is the peer's own
			// build, not something this process may speak for.
			if key == "modules" || key == "version" {
				continue
			}
			if _, taken := merged.Described[key]; !taken {
				merged.Described[key] = value
			}
		}
	}
	c.at, c.answer = time.Now(), merged
	return merged
}

// ask asks one peer for its own capabilities; nil when it did not answer.
func (c *peerCache) ask(ctx context.Context, peer string) map[string]any {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, peer+CapabilitiesPath+"?"+localQuery, nil)
	if err != nil {
		return nil
	}
	response, err := c.client.Do(request)
	if err != nil {
		slog.Warn("peer not answering its capabilities", "peer", peer, "err", err)
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		slog.Warn("peer answered its capabilities with an error", "peer", peer, "status", response.StatusCode)
		return nil
	}
	var answer map[string]any
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&answer); err != nil {
		slog.Warn("peer answered, but not with capabilities", "peer", peer, "err", err)
		return nil
	}
	return answer
}
