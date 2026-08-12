// Package world is the world SUBSYSTEM, not merely a store. Today it holds the
// saves — named, mutable, owned; later it grows the tile database and the world
// loop, which is why it is named for the domain rather than for its first job.
//
// Its counterpart internal/artifacts is the opposite kind of thing: a bag of
// derived files with no behaviour. That is the whole reason they are separate
// modules — mutable vs immutable, owned vs ownerless, irreplaceable vs
// recomputable — and only this one holds data a user can actually lose.
// See docs/decisions/server-storage.md.
package world

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/httpjson"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
)

// uploadLimit caps an accepted save. A world zip is tens of megabytes at the
// current resolutions; this leaves generous headroom while keeping a single
// request from exhausting memory, since the archive must be read whole to be
// inspected. A candidate for a flag once a real deployment has an opinion.
const uploadLimit = 512 << 20 // 512 MiB

// Config carries the full configuration tree (every module holds it whole —
// decided 2026-08-12) plus the module's wiring. No viper here by design; the
// module reads Global and its OWN section (`world.*`), nothing else.
type Config struct {
	All config.Config
	// Identity answers who a request comes from. The one resolver cmd/ builds is
	// shared with every module, so who a caller IS has one answer in the
	// process — this module holds the answerer, not the auth mode it was
	// configured with.
	Identity *identity.Resolver
}

// Module serves the world store.
type Module struct {
	cfg   Config
	store *Store
}

// New prepares the store. The directory is created eagerly so a bad
// world.storage fails at startup, naming the setting, rather than on the
// first upload hours later.
func New(cfg Config) (*Module, error) {
	store, err := NewStore(cfg.All.World.Storage.DirPath(), cfg.All.World.KeepRevisions)
	if err != nil {
		return nil, fmt.Errorf("world.storage: %w", err)
	}
	return &Module{cfg: cfg, store: store}, nil
}

// Name identifies the module in logs and errors.
func (m *Module) Name() string { return "world" }

// Store exposes the store to cmd/, the composition root — which is the ONE
// caller this is meant for: cross-module needs (bake's world reads) are
// closures over this store, built where every module is already known.
// Modules never call each other's accessors directly.
func (m *Module) Store() *Store { return m.store }

// Mount claims the world store's routes. Worlds are addressed by their stable
// uid, never by their terrain hash — see docs/decisions/server-storage.md for
// why those are two different identities.
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("GET /v1/worlds", m.handleList)
	mux.HandleFunc("GET /v1/worlds/{uid}", m.handleGet)
	mux.HandleFunc("GET /v1/worlds/{uid}/meta", m.handleMeta)
	mux.HandleFunc("GET /v1/worlds/{uid}/preview.png", m.handlePreview)
	mux.HandleFunc("PUT /v1/worlds/{uid}", m.handlePut)
	mux.HandleFunc("DELETE /v1/worlds/{uid}", m.handleDelete)
	return nil
}

// Close releases the store. Nothing is held open.
func (m *Module) Close() error { return nil }

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	metas, err := m.store.List(r.Context())
	if err != nil {
		httpjson.ServerError(w, "listing worlds", err)
		return
	}
	if metas == nil {
		metas = []Meta{}
	}
	httpjson.Write(w, http.StatusOK, metas)
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	data, meta, err := m.store.ReadCurrent(r.Context(), uid)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	// The revision IS the ETag: it is exactly the token a client passes back
	// in If-Match, so deriving a second one would only invite the two to drift.
	w.Header().Set("ETag", etag(meta.Revision))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}

// handleMeta answers a world's record without its bytes — what a peer service
// needs: a world-less bake target admitting a request asks this route who owns
// the world and whether it has a revision, at the cost of a lookup rather than
// a download.
func (m *Module) handleMeta(w http.ResponseWriter, r *http.Request) {
	meta, err := m.store.Get(r.Context(), r.PathValue("uid"))
	if err != nil {
		respondStoreError(w, err)
		return
	}
	httpjson.Write(w, http.StatusOK, meta)
}

func (m *Module) handlePreview(w http.ResponseWriter, r *http.Request) {
	raw, err := m.store.ReadPreview(r.Context(), r.PathValue("uid"))
	if err != nil {
		respondStoreError(w, err)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	_, _ = w.Write(raw)
}

func (m *Module) handlePut(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if !ValidUID(uid) {
		httpjson.ClientError(w, http.StatusBadRequest, "not a valid world uid")
		return
	}
	expected, ok := parseIfMatch(r.Header.Get("If-Match"))
	if !ok {
		httpjson.ClientError(w, http.StatusBadRequest, `If-Match must be a revision like "3", or absent to create`)
		return
	}

	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, uploadLimit))
	if err != nil {
		httpjson.ClientError(w, http.StatusRequestEntityTooLarge, "world upload too large or truncated")
		return
	}

	info, err := inspectSave(data)
	if err != nil {
		httpjson.ClientError(w, http.StatusBadRequest, err.Error())
		return
	}
	// The uid in the path and the one inside the save must agree. Accepting a
	// mismatch would file a world under an id its own recipe does not carry —
	// so the next upload from the same client would create a second entry.
	if info.UID != uid {
		httpjson.ClientError(w, http.StatusBadRequest, fmt.Sprintf("save carries uid %s but was addressed as %s", info.UID, uid))
		return
	}

	meta, err := m.store.Put(r.Context(), uid, data, info, m.cfg.Identity.Caller(r), expected)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	slog.Info("world stored", "uid", uid, "revision", meta.Revision, "bytes", meta.Size)
	w.Header().Set("ETag", etag(meta.Revision))
	status := http.StatusOK
	if meta.Revision == 1 {
		status = http.StatusCreated
	}
	httpjson.Write(w, status, meta)
}

func (m *Module) handleDelete(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if err := m.store.Delete(r.Context(), uid); err != nil {
		respondStoreError(w, err)
		return
	}
	slog.Info("world deleted", "uid", uid)
	w.WriteHeader(http.StatusNoContent)
}

// parseIfMatch reads the header as the revision the caller believes is
// current. Absent means "create; fail if it already exists", which is why the
// zero value is meaningful rather than merely a default.
//
// Returns ok=false for a header that is present but unparseable — silently
// treating that as "create" would turn a client bug into an overwrite refusal
// that looks like a server fault.
func parseIfMatch(header string) (int, bool) {
	if header == "" {
		return 0, true
	}
	trimmed := header
	if len(trimmed) >= 2 && trimmed[0] == '"' && trimmed[len(trimmed)-1] == '"' {
		trimmed = trimmed[1 : len(trimmed)-1]
	}
	revision, err := strconv.Atoi(trimmed)
	if err != nil || revision < 1 {
		return 0, false
	}
	return revision, true
}

func etag(revision int) string { return `"` + strconv.Itoa(revision) + `"` }

// respondStoreError maps the store's sentinels onto status codes. Kept in one
// place so a new caller cannot invent its own mapping.
func respondStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httpjson.ClientError(w, http.StatusNotFound, "no such world")
	case errors.Is(err, ErrExists):
		// 409, not 412: nothing was asked to be matched. The caller said
		// "create" and something is already there.
		httpjson.ClientError(w, http.StatusConflict, "world already exists; send If-Match with its revision to update it")
	case errors.Is(err, ErrRevisionMismatch):
		// 412 is what RFC 9110 specifies for a failed If-Match. The plan
		// originally said 409; that is the code for the case above.
		httpjson.ClientError(w, http.StatusPreconditionFailed, "revision mismatch; fetch the world again and retry")
	default:
		httpjson.ServerError(w, "world store", err)
	}
}
