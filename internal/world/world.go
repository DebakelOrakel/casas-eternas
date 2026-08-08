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
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
)

// uploadLimit caps an accepted save. A world zip is tens of megabytes at the
// current resolutions; this leaves generous headroom while keeping a single
// request from exhausting memory, since the archive must be read whole to be
// inspected. A candidate for a flag once a real deployment has an opinion.
const uploadLimit = 512 << 20 // 512 MiB

// Config is what cmd/ resolves from the flags. No viper here by design.
type Config struct {
	// Dir is where saved worlds live, one directory per world. Named for its
	// CONTENTS rather than for this module, because the module will grow a tile
	// database and a loop that need directories of their own.
	Dir string
}

// Module serves the world store.
type Module struct {
	store *Store
}

// New prepares the store. The directory is created eagerly so a bad
// --dir-worlds fails at startup, naming the flag, rather than on the first
// upload hours later.
func New(cfg Config) (*Module, error) {
	store, err := NewStore(cfg.Dir)
	if err != nil {
		return nil, fmt.Errorf("--dir-worlds: %w", err)
	}
	return &Module{store: store}, nil
}

// Name identifies the module in logs and errors.
func (m *Module) Name() string { return "world" }

// Mount claims the world store's routes. Worlds are addressed by their stable
// uid, never by their terrain hash — see docs/decisions/server-storage.md for
// why those are two different identities.
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("GET /v1/worlds", m.handleList)
	mux.HandleFunc("GET /v1/worlds/{uid}", m.handleGet)
	mux.HandleFunc("GET /v1/worlds/{uid}/preview.png", m.handlePreview)
	mux.HandleFunc("PUT /v1/worlds/{uid}", m.handlePut)
	mux.HandleFunc("DELETE /v1/worlds/{uid}", m.handleDelete)
	return nil
}

// Close releases the store. Nothing is held open.
func (m *Module) Close() error { return nil }

// callerIdentity resolves who is asking.
//
// Always "local" while authMode is `none`, but routed through a function from
// day one so that token and OIDC land HERE rather than as a refactor of every
// handler. The design doc's point: build with a notion of identity, check it
// later.
func callerIdentity(r *http.Request) string { return "local" }

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	metas, err := m.store.List()
	if err != nil {
		serverError(w, "listing worlds", err)
		return
	}
	if metas == nil {
		metas = []Meta{}
	}
	writeJSON(w, http.StatusOK, metas)
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	data, meta, err := m.store.ReadCurrent(uid)
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

func (m *Module) handlePreview(w http.ResponseWriter, r *http.Request) {
	raw, err := m.store.ReadPreview(r.PathValue("uid"))
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
		clientError(w, http.StatusBadRequest, "not a valid world uid")
		return
	}
	expected, ok := parseIfMatch(r.Header.Get("If-Match"))
	if !ok {
		clientError(w, http.StatusBadRequest, `If-Match must be a revision like "3", or absent to create`)
		return
	}

	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, uploadLimit))
	if err != nil {
		clientError(w, http.StatusRequestEntityTooLarge, "world upload too large or truncated")
		return
	}

	info, err := inspectSave(data)
	if err != nil {
		clientError(w, http.StatusBadRequest, err.Error())
		return
	}
	// The uid in the path and the one inside the save must agree. Accepting a
	// mismatch would file a world under an id its own recipe does not carry —
	// so the next upload from the same client would create a second entry.
	if info.UID != uid {
		clientError(w, http.StatusBadRequest, fmt.Sprintf("save carries uid %s but was addressed as %s", info.UID, uid))
		return
	}

	meta, err := m.store.Put(uid, data, info, callerIdentity(r), expected)
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
	writeJSON(w, status, meta)
}

func (m *Module) handleDelete(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if err := m.store.Delete(uid); err != nil {
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
		clientError(w, http.StatusNotFound, "no such world")
	case errors.Is(err, ErrExists):
		// 409, not 412: nothing was asked to be matched. The caller said
		// "create" and something is already there.
		clientError(w, http.StatusConflict, "world already exists; send If-Match with its revision to update it")
	case errors.Is(err, ErrRevisionMismatch):
		// 412 is what RFC 9110 specifies for a failed If-Match. The plan
		// originally said 409; that is the code for the case above.
		clientError(w, http.StatusPreconditionFailed, "revision mismatch; fetch the world again and retry")
	default:
		serverError(w, "world store", err)
	}
}

func clientError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// serverError logs the detail and returns a generic message: the cause belongs
// in the operator's log, not in a response body.
func serverError(w http.ResponseWriter, context string, err error) {
	slog.Error(context, "err", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
