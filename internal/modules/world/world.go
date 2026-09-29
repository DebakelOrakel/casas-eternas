// Package world is the world SUBSYSTEM, not merely a store. Today it holds the
// saves — named, mutable, owned; later it grows the tile database and the world
// loop, which is why it is named for the domain rather than for its first job.
//
// Its counterpart internal/modules/artifacts is the opposite kind of thing: a bag of
// derived files with no behaviour. That is the whole reason they are separate
// modules — mutable vs immutable, owned vs ownerless, irreplaceable vs
// recomputable — and only this one holds data a user can actually lose.
// See docs/decisions/server-storage.md.
package world

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
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
	// LegacyOwner maps a pre-registry owner NAME to a user id — the migration
	// rule for worlds without grants.json on a checking server: the meta's
	// owner, IF it maps to a registry user, is the owner; otherwise the world
	// is admin-only. Injected by cmd/ as a closure over the registry; nil
	// when no registry exists, which makes every legacy world admin-only.
	LegacyOwner func(name string) (id string, ok bool)
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

// AccessFor answers whether a world exists and the caller's level on it —
// the ONE ranking in the process: this module's handlers use it directly,
// artifacts and bake get it injected as a closure by cmd/. Admin outranks
// everything; the none-mode short circuit happens where the caller is
// resolved (callerOf / cmd/'s closure), which is what knows the mode.
func (m *Module) AccessFor(ctx context.Context, uid, callerID string, admin bool) (exists bool, level access.Level) {
	meta, err := m.store.Get(ctx, uid)
	if err != nil {
		return false, access.None
	}
	if admin {
		return true, access.Admin
	}
	grants, found, err := m.store.ReadGrants(ctx, uid)
	if err != nil {
		// Corrupt grants FAIL CLOSED: an unreadable ACL must never reopen a
		// shared world under legacy rules.
		slog.Error("unreadable grants", "uid", uid, "err", err)
		return true, access.None
	}
	if !found {
		// The migration rule for worlds from before grants existed: the
		// meta's owner, if it maps to a registry user, is the owner; a
		// synthetic or unmapped owner leaves the world admin-only — switching
		// a server to `password` never silently gives worlds away.
		if meta.Owner != "" && meta.Owner != identity.Local && m.cfg.LegacyOwner != nil {
			if id, ok := m.cfg.LegacyOwner(meta.Owner); ok && id == callerID {
				return true, access.Owner
			}
		}
		return true, access.None
	}
	return true, grants.LevelOf(callerID)
}

// callerOf resolves the request once for the checks: in the local mode the
// synthetic caller is treated as admin, which is the design's stated rule —
// every check answers yes there, while the DATA is still written correctly.
func (m *Module) callerOf(r *http.Request) (caller string, admin bool) {
	caller, admin = m.cfg.Identity.ResolveBearer(r.Header.Get("Authorization"))
	if !m.cfg.Identity.ChecksIdentity() {
		admin = true
	}
	return caller, admin
}

// gate refuses a request below the action's level, with the shape the
// visibility rule demands: a world the caller may not READ answers 404 —
// private means invisible, exactly like the filtered listing — and only on
// a readable world does 403 distinguish "not yours to do".
func (m *Module) gate(w http.ResponseWriter, r *http.Request, uid string, action access.Action) bool {
	caller, admin := m.callerOf(r)
	exists, level := m.AccessFor(r.Context(), uid, caller, admin)
	// A bake Job READS the world it was created to bake — the same one-claim
	// narrowing the artifact store applies to the job's writes, mirrored here
	// for its one read. Read ONLY: a job writes artifacts, never worlds, so
	// no other action is elevated. Found missing 2026-08-13, the first time
	// a checking server met a cluster bake — the job's GET got the
	// stranger's 404 and the bake died in three seconds.
	if exists && level < access.Viewer && action == access.ActionRead {
		if _, jobWorld, ok := m.cfg.Identity.JobToken(r); ok && jobWorld == uid {
			level = access.Viewer
		}
	}
	if !exists || level < access.Viewer {
		httpjson.ClientError(w, http.StatusNotFound, "no such world")
		return false
	}
	if level < access.Required(action) {
		httpjson.ClientError(w, http.StatusForbidden, fmt.Sprintf("%s needs %s access to this world", action, access.Required(action)))
		return false
	}
	return true
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	metas, err := m.store.List(r.Context())
	if err != nil {
		httpjson.ServerError(w, "listing worlds", err)
		return
	}
	// The listing IS the visibility rule: own + granted + public, nothing
	// else. One grants read per world — N is small, and the design doc
	// blesses exactly this until it is not.
	caller, admin := m.callerOf(r)
	visible := make([]Meta, 0, len(metas))
	for _, meta := range metas {
		if _, level := m.AccessFor(r.Context(), meta.UID, caller, admin); level >= access.Viewer {
			visible = append(visible, meta)
		}
	}
	httpjson.Write(w, http.StatusOK, visible)
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if !m.gate(w, r, uid, access.ActionRead) {
		return
	}
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

// handleMeta answers a world's record without its bytes — what a peer
// service needs: a world-less bake or artifacts target ranking a request
// asks this route, forwarding the caller's own Authorization header. The
// answer therefore carries `callerLevel`: the service that OWNS the grants
// ranks the caller, and the peer only compares — grants never travel.
func (m *Module) handleMeta(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if !m.gate(w, r, uid, access.ActionRead) {
		return
	}
	meta, err := m.store.Get(r.Context(), uid)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	caller, admin := m.callerOf(r)
	_, level := m.AccessFor(r.Context(), uid, caller, admin)
	httpjson.Write(w, http.StatusOK, struct {
		Meta
		CallerLevel string `json:"callerLevel"`
	}{Meta: meta, CallerLevel: level.String()})
}

func (m *Module) handlePreview(w http.ResponseWriter, r *http.Request) {
	if !m.gate(w, r, r.PathValue("uid"), access.ActionRead) {
		return
	}
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
	// Creating is open to every authenticated caller — the store pins them
	// as owner. Writing into an EXISTING world needs editor access, with the
	// same visibility shape as everywhere: unreadable means 404.
	caller, admin := m.callerOf(r)
	if exists, level := m.AccessFor(r.Context(), uid, caller, admin); exists {
		if level < access.Viewer {
			httpjson.ClientError(w, http.StatusNotFound, "no such world")
			return
		}
		if level < access.Editor {
			httpjson.ClientError(w, http.StatusForbidden, "world.write needs editor access to this world")
			return
		}
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
	if !m.gate(w, r, uid, access.ActionDelete) {
		return
	}
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
