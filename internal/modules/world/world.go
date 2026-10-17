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
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/blob"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/httpjson"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
)

// uploadLimit caps an accepted save. A world zip is tens of megabytes at the
// current resolutions; this leaves generous headroom while keeping a single
// request from exhausting memory, since the archive must be read whole to be
// inspected. A candidate for a flag once a real deployment has an opinion.
const uploadLimit = 512 << 20 // 512 MiB

// LinkBase is the base of the dir backend's own links (DEC-0038, fork 5):
// a link is LinkBase + the object's key, so the zip of revision 3 is
// `GET /v1/worlds/{uid}/rev/3/world.zip?exp=…&sig=…`. In this module's
// namespace and below the uid, so the route cannot collide with the
// `{uid}` routes (a `/v1/worlds/blob/{key...}` would: the mux finds it and
// `/v1/worlds/{uid}/meta` both matching `/v1/worlds/blob/meta`, with
// neither more specific, and refuses to register them). The link is the
// authorization, so the gate lets a request with a valid one through
// without credentials (SignedRequest).
const LinkBase = "/v1/worlds/"

// Config carries the full configuration tree (every module holds it whole —
// decided 2026-08-12) plus the module's wiring. No viper here by design; the
// module reads Global and its OWN section (`world.*`), nothing else.
type Config struct {
	All config.Config
	// Bucket is the store's bucket, opened by cmd/ from world.storage
	// (DEC-0038 step 5: dir or s3, with BucketOptions). The module closes it.
	Bucket blob.Bucket
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
	// signer checks the dir backend's links; nil on s3, whose links the
	// provider checks.
	signer *blob.LinkSigner
	// readTTL is the lifetime of a read link (world.read-link-ttl).
	readTTL time.Duration
}

// signing is what a Dir that makes its own links offers.
type signing interface{ Signer() *blob.LinkSigner }

// NewLinkSigner makes the signer of the dir backend's links from
// world.link-key (DEC-0038, fork 4). Without a key file the key is
// ephemeral and the links die at restart, which is logged. With
// world.link-key-previous the signer also accepts the links of the key
// before (a change-over, 2026-10-16); it signs with world.link-key. The
// signer makes GET links only; its upload limit is the module's, unused.
func NewLinkSigner(cfg config.Config) (*blob.LinkSigner, error) {
	key, ephemeral, err := blob.ReadLinkKey(cfg.World.LinkKey)
	if err != nil {
		return nil, fmt.Errorf("world.link-key: %w", err)
	}
	if ephemeral {
		slog.Warn("world.link-key is not set: the world links use an ephemeral key and stop working at restart")
	}
	previous, err := blob.ReadPreviousLinkKey(cfg.World.LinkKeyPrevious)
	if err != nil {
		return nil, fmt.Errorf("world.link-key-previous: %w", err)
	}
	keys := [][]byte{key}
	if previous != nil {
		keys = append(keys, previous)
	}
	return blob.NewLinkSigner(LinkBase, uploadLimit, keys...)
}

// New prepares the store and builds its index from the bucket, so a bad
// world.storage fails at startup, naming the setting, rather than on the
// first upload hours later.
func New(ctx context.Context, cfg Config) (*Module, error) {
	if cfg.Bucket == nil {
		return nil, fmt.Errorf("world needs its bucket; that is cmd/'s job")
	}
	readTTL := cfg.All.World.ReadLinkTTL
	if readTTL <= 0 || readTTL > blob.MaxLinkTTL {
		return nil, fmt.Errorf("world.read-link-ttl: %v must be in (0, %v]", readTTL, blob.MaxLinkTTL)
	}
	store, err := NewStore(ctx, cfg.Bucket, cfg.All.World.KeepRevisions)
	if err != nil {
		return nil, fmt.Errorf("world.storage: %w", err)
	}
	m := &Module{cfg: cfg, store: store, readTTL: readTTL}
	if d, ok := cfg.Bucket.(signing); ok {
		m.signer = d.Signer()
	}
	return m, nil
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
	mux.HandleFunc("POST /v1/worlds/{uid}/copy", m.handleCopy)
	mux.HandleFunc("PUT /v1/worlds/{uid}/template", m.handleTemplate)
	mux.HandleFunc("DELETE /v1/worlds/{uid}/template", m.handleTemplate)
	mux.HandleFunc("PUT /v1/worlds/{uid}/visibility", m.handleVisibility)
	// The two routes a world-less artifacts target asks (DEC-0039): the
	// caller's level on a terrain, and a job worker's report of one.
	mux.HandleFunc("GET /v1/worlds/terrain-access", m.handleTerrainAccess)
	mux.HandleFunc("POST /v1/worlds/{uid}/terrains", m.handleAddTerrain)
	// The dir backend's own links (LinkBase). Not mounted on s3: the
	// provider serves its links.
	if m.signer != nil {
		mux.HandleFunc("GET /v1/worlds/{uid}/rev/{revision}/{name}", m.handleLink)
	}
	return nil
}

// SignedRequest answers whether a request is a GET (or HEAD) with a link
// this module signed (blob.LinkSigner.Signed). cmd/ hands it to
// server.Gate, which lets such a request through WITHOUT credentials: the
// link is the authorization. False on s3, whose links the provider checks.
func (m *Module) SignedRequest(r *http.Request) bool {
	if m.signer == nil || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return false
	}
	return m.signer.Signed(r)
}

// AnonymousReads names the requests this module ranks for a caller WITHOUT
// credentials, rather than the gate refusing them: the reads of a world —
// the list, the archive, its meta and its preview — because a template is
// readable by everyone (the "anyone" grant, access.VisibilityPublic,
// DEC-0040). cmd/ hands it to server.Gate. The module then answers such a
// caller only with public worlds: the list holds nothing else, and every
// other world answers 401, as the gate would have.
//
// A pure function of the request, so the gate needs to know no module.
func AnonymousReads(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	path := r.URL.Path
	// The terrain's level: an anonymous caller reads the artifacts of a
	// template (DEC-0039, fork 4), and a world-less artifacts target asks
	// here for it.
	if path == "/v1/worlds" || path == "/v1/worlds/terrain-access" {
		return true
	}
	rest, ok := strings.CutPrefix(path, "/v1/worlds/")
	if !ok {
		return false
	}
	uid, tail, _ := strings.Cut(rest, "/")
	if !ValidUID(uid) {
		return false
	}
	return tail == "" || tail == "meta" || tail == "preview.png"
}

// Close releases the bucket when it holds something open (a Dir's root).
func (m *Module) Close() error {
	if c, ok := m.cfg.Bucket.(io.Closer); ok {
		return c.Close()
	}
	return nil
}

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

// TerrainAccess answers the caller's highest level over the worlds whose
// terrain ids hold `worldID` (Meta.Terrains), and whether more than one
// world holds it — what the artifacts module needs to rank a read or a
// removal of an artifact (DEC-0039, forks 4 and 6). A terrain no world
// holds ranks nobody, the admin included: its artifacts are reachable
// only as the operator's (the artifacts module checks that first).
func (m *Module) TerrainAccess(ctx context.Context, worldID, callerID string, admin bool) (level access.Level, shared bool) {
	uids := m.store.WithTerrain(worldID)
	for _, uid := range uids {
		if _, l := m.AccessFor(ctx, uid, callerID, admin); l > level {
			level = l
		}
	}
	return level, len(uids) > 1
}

// Terrains answers a world's terrain ids (Meta.Terrains); nil for a world
// that is not there.
func (m *Module) Terrains(ctx context.Context, uid string) []string {
	meta, err := m.store.Get(ctx, uid)
	if err != nil {
		return nil
	}
	return meta.Terrains
}

// AddTerrain records a terrain id a job worker reports for its world
// (Store.AddTerrains). The caller (cmd/'s closure, or handleAddTerrain)
// has checked that the report comes from a job of that world.
func (m *Module) AddTerrain(ctx context.Context, uid, worldID string) error {
	return m.store.AddTerrains(ctx, uid, worldID)
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
	// no other action is elevated (and the routes that write a world refuse
	// a job before they rank it, refuseJob). Found missing 2026-08-13, the first time
	// a checking server met a cluster bake — the job's GET got the
	// stranger's 404 and the bake died in three seconds.
	if exists && level < access.Viewer && action == access.ActionRead {
		if _, jobWorld, ok := m.cfg.Identity.JobToken(r); ok && jobWorld == uid {
			level = access.Viewer
		}
	}
	if level < access.Viewer && caller == identity.Anonymous {
		// No credentials, on a route the gate let through for templates
		// (AnonymousReads): every other world answers what the gate answers,
		// so this says nothing about whether the world exists.
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return false
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

// refuseJob answers 403 to a bake job's token on a route that writes a
// world: create, copy, delete, the template mark. A job READS the world it
// was made for (gate) and writes artifacts; it never writes a world.
// Before 2026-10-16 a job token could create or copy one, and the world's
// owner was then "job" (token.SubjectJob) — owned by every job token. The
// refusal does not look at the world, so it says nothing about whether one
// exists. True when it answered.
func (m *Module) refuseJob(w http.ResponseWriter, r *http.Request) bool {
	if _, _, ok := m.cfg.Identity.JobToken(r); !ok {
		return false
	}
	httpjson.ClientError(w, http.StatusForbidden, "a job token reads its world; it does not write worlds")
	return true
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	metas, err := m.store.List(r.Context())
	if err != nil {
		httpjson.ServerError(w, "listing worlds", err)
		return
	}
	// The listing IS the visibility rule: own + granted + signed in +
	// public, nothing else — for the anonymous caller public alone. One
	// grants read per world — N is small, and the design doc blesses exactly
	// this until it is not. Each entry says the caller's level on it (for
	// peers, as the meta endpoint) and the actions that level allows: the
	// client offers "open" or "copy" on a template, the template mark and
	// the visibility by them (DEC-0040, fork 7).
	caller, admin := m.callerOf(r)
	visible := make([]listedWorld, 0, len(metas))
	for _, meta := range metas {
		if _, level := m.AccessFor(r.Context(), meta.UID, caller, admin); level >= access.Viewer {
			visible = append(visible, listedWorld{Meta: meta, CallerLevel: level.String(), Actions: access.Actions(level)})
		}
	}
	httpjson.Write(w, http.StatusOK, visible)
}

// listedWorld is one entry of the list, and of the meta endpoint: the
// world's record, the caller's level on it, and the actions the caller may
// perform on it.
type listedWorld struct {
	Meta
	CallerLevel string          `json:"callerLevel"`
	Actions     []access.Action `json:"actions"`
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if !m.gate(w, r, uid, access.ActionRead) {
		return
	}
	// A reader that holds this revision already (a job worker baking tile
	// after tile of one world) asks with If-None-Match and gets 304 without
	// the archive — tens of MB per task otherwise. Answered BEFORE the
	// redirect: the link's answer (the bucket's) knows nothing of revisions.
	if match := r.Header.Get("If-None-Match"); match != "" {
		if meta, err := m.store.Get(r.Context(), uid); err == nil && match == etag(meta.Revision) {
			w.Header().Set("ETag", etag(meta.Revision))
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	// The right is checked; the bytes (35–70 MB) come from a link: a
	// presigned GET on s3, so they do not pass through this server, or this
	// module's own signed link on dir.
	link, meta, err := m.store.ZipLink(r.Context(), uid, m.readTTL)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	// The revision IS the ETag: it is exactly the token a client passes back
	// in If-Match, so deriving a second one would only invite the two to drift.
	// It is on the 302, because the answer of the link is the bucket's, whose
	// ETag is its own (an MD5 on S3): a reader that keeps the revision reads
	// it here (the job worker, client/scripts/readWorld.ts, follows the
	// redirect itself; the browser asks the meta first, worldClient.ts).
	w.Header().Set("ETag", etag(meta.Revision))
	redirect(w, r, link)
}

// redirect answers 302 to a read link. A link is valid for minutes; a
// redirect cached past that would send the client to a dead link.
func redirect(w http.ResponseWriter, r *http.Request, link blob.Link) {
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, link.URL, http.StatusFound)
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
	httpjson.Write(w, http.StatusOK, listedWorld{Meta: meta, CallerLevel: level.String(), Actions: access.Actions(level)})
}

func (m *Module) handlePreview(w http.ResponseWriter, r *http.Request) {
	if !m.gate(w, r, r.PathValue("uid"), access.ActionRead) {
		return
	}
	// By link, as the zip: the browser fetches the thumbnail (fetch, not
	// <img src>, worldClient.ts fetchWorldPreview) and follows the 302.
	link, err := m.store.PreviewLink(r.Context(), r.PathValue("uid"), m.readTTL)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	redirect(w, r, link)
}

// handleLink serves a dir link: a zip or a preview of a revision. No
// caller is needed: the gate let the request through for its signature
// (SignedRequest), and it is checked again here, where its result decides.
// The key is LinkBase's remainder, built from the path's segments and
// checked by the key rule and the signature (a changed or escaped path
// does not verify). The answers say no more than the link holder knows:
// 403 for a link that does not verify, 410 for one of ours that has
// expired, 404 for a signed key whose object has gone (a pruned revision).
func (m *Module) handleLink(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("uid") + "/rev/" + r.PathValue("revision") + "/" + r.PathValue("name")
	if _, err := m.signer.Verify(http.MethodGet, key, r.URL.Query()); err != nil {
		if errors.Is(err, blob.ErrLinkExpired) {
			httpjson.ClientError(w, http.StatusGone, "the link has expired")
			return
		}
		httpjson.ClientError(w, http.StatusForbidden, "the link is not valid")
		return
	}
	body, info, err := m.store.bucket.Get(r.Context(), key)
	if err != nil {
		if errors.Is(err, blob.ErrNotFound) {
			httpjson.ClientError(w, http.StatusNotFound, "no such world")
			return
		}
		httpjson.ServerError(w, "world store", err)
		return
	}
	defer func() { _ = body.Close() }()
	// No validators here: the revision is the 302's ETag, and a revision's
	// objects do not change under their key.
	contentType := "application/octet-stream"
	switch r.PathValue("name") {
	case zipName:
		contentType = "application/zip"
	case previewName:
		contentType = "image/png"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	_, _ = io.Copy(w, body)
}

func (m *Module) handlePut(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if !ValidUID(uid) {
		httpjson.ClientError(w, http.StatusBadRequest, "not a valid world uid")
		return
	}
	if m.refuseJob(w, r) {
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
	exists, level := m.AccessFor(r.Context(), uid, caller, admin)
	if exists {
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
	// Created when the world did not exist: its first revision is not
	// always 1 (a revision an interrupted upload left is stepped over,
	// claimRevision).
	status := http.StatusOK
	if !exists {
		status = http.StatusCreated
	}
	httpjson.Write(w, status, meta)
}

func (m *Module) handleDelete(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if m.refuseJob(w, r) || !m.gate(w, r, uid, access.ActionDelete) {
		return
	}
	if err := m.store.Delete(r.Context(), uid); err != nil {
		respondStoreError(w, err)
		return
	}
	slog.Info("world deleted", "uid", uid)
	w.WriteHeader(http.StatusNoContent)
}

// handleCopy makes a new world of an existing one: a new uid, the caller as
// its owner, the same content — world.yaml's metadata says the new uid and,
// as the annotation CopiedFromAnnotation, the source's. Done here rather than
// by a download and an upload, so tens of MB do not travel twice.
//
// Any world the caller may READ may be copied, not templates only: a viewer
// can download the archive and upload it under a new uid anyway, so a
// narrower rule would refuse nothing a caller cannot already do. A world the
// caller may not read is the stranger's 404, as everywhere. The anonymous
// caller never gets here — the gate refuses it — because a copy on the
// server needs an owner.
func (m *Module) handleCopy(w http.ResponseWriter, r *http.Request) {
	source := r.PathValue("uid")
	if m.refuseJob(w, r) || !m.gate(w, r, source, access.ActionRead) {
		return
	}
	data, sourceMeta, err := m.store.ReadCurrent(r.Context(), source)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	uid := newUID()
	copied, err := copySave(data, uid, source)
	if err != nil {
		// The stored save is the server's own; failing to read it back is
		// the store's fault, not the caller's.
		httpjson.ServerError(w, "copying world", err)
		return
	}
	info, err := inspectSave(copied)
	if err != nil {
		httpjson.ServerError(w, "copying world", err)
		return
	}
	meta, err := m.store.Put(r.Context(), uid, copied, info, m.cfg.Identity.Caller(r), 0)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	// The same terrain by construction, so the copy reads the source's
	// artifacts at once (DEC-0039, fork 3).
	if len(sourceMeta.Terrains) > 0 {
		if err := m.store.AddTerrains(r.Context(), uid, sourceMeta.Terrains...); err != nil {
			slog.Warn("world copied without its terrain ids; its first job records them", "uid", uid, "err", err)
		} else if meta, err = m.store.Get(r.Context(), uid); err != nil {
			respondStoreError(w, err)
			return
		}
	}
	slog.Info("world copied", "uid", uid, "from", source, "bytes", meta.Size)
	w.Header().Set("ETag", etag(meta.Revision))
	httpjson.Write(w, http.StatusCreated, meta)
}

// handleTerrainAccess answers TerrainAccess for the caller:
// `?worldId=` → {callerLevel, shared}. A terrain the caller cannot read
// answers "none", not 404: the answer is a rank, as the meta's callerLevel
// is. `shared` says one bit about worlds the caller may not see (that
// another world holds the terrain); it is what a removal must know.
func (m *Module) handleTerrainAccess(w http.ResponseWriter, r *http.Request) {
	worldID := r.URL.Query().Get("worldId")
	if !ValidTerrain(worldID) {
		httpjson.ClientError(w, http.StatusBadRequest, "worldId must be a terrain id")
		return
	}
	caller, admin := m.callerOf(r)
	level, shared := m.TerrainAccess(r.Context(), worldID, caller, admin)
	if level < access.Viewer {
		shared = false
	}
	httpjson.Write(w, http.StatusOK, struct {
		CallerLevel string `json:"callerLevel"`
		Shared      bool   `json:"shared"`
	}{level.String(), shared})
}

// handleAddTerrain records a terrain id of a world: `{worldId}`. Only a job
// token for that world (or the operator) may: the worker derived the id
// from the world's stored save, which is what makes the record
// trustworthy (DEC-0039, fork 3). Anyone else gets 403; the answer does
// not look at the world, so it says nothing about whether one exists.
func (m *Module) handleAddTerrain(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	_, jobWorld, job := m.cfg.Identity.JobToken(r)
	_, admin := m.callerOf(r)
	if !admin && (!job || jobWorld != uid) {
		httpjson.ClientError(w, http.StatusForbidden, "only a job of this world reports its terrain")
		return
	}
	var request struct {
		WorldID string `json:"worldId"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&request); err != nil || !ValidTerrain(request.WorldID) {
		httpjson.ClientError(w, http.StatusBadRequest, "expected {worldId}")
		return
	}
	if err := m.store.AddTerrains(r.Context(), uid, request.WorldID); err != nil {
		respondStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleTemplate sets (PUT) or removes (DELETE) the template mark — the
// admin's (access.ActionTemplate). Answers the world's record with the mark
// as it now stands; both are idempotent.
func (m *Module) handleTemplate(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if m.refuseJob(w, r) || !m.gate(w, r, uid, access.ActionTemplate) {
		return
	}
	meta, err := m.store.SetTemplate(r.Context(), uid, r.Method == http.MethodPut)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	slog.Info("world template mark", "uid", uid, "template", meta.Template)
	httpjson.Write(w, http.StatusOK, meta)
}

// handleVisibility sets which pseudo-principal reads a world, body
// {"visibility": "private" | "signedIn" | "public"} (DEC-0040, fork 4).
// The owner's (access.ActionShare) up to signed in; making a world public
// takes the admin (access.ActionPublish). The owner may narrow a public
// world: who reads their world is theirs to restrict. Answers the world's
// record; idempotent.
func (m *Module) handleVisibility(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if m.refuseJob(w, r) || !m.gate(w, r, uid, access.ActionShare) {
		return
	}
	var request struct {
		Visibility string `json:"visibility"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&request); err != nil {
		httpjson.ClientError(w, http.StatusBadRequest, "body must be {\"visibility\": \"private\" | \"signedIn\" | \"public\"}")
		return
	}
	if request.Visibility == access.VisibilityPublic && !m.gate(w, r, uid, access.ActionPublish) {
		return
	}
	meta, err := m.store.SetVisibility(r.Context(), uid, request.Visibility)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	slog.Info("world visibility", "uid", uid, "visibility", meta.Visibility)
	httpjson.Write(w, http.StatusOK, meta)
}

// newUID is a random (version 4) UUID, the shape the client mints
// (client/src/world/identity.ts, newWorldUid) and ValidUID accepts.
func newUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never fails (Go 1.24+)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
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
	case errors.Is(err, ErrNoGrants):
		httpjson.ClientError(w, http.StatusConflict, "world has no grants yet (it predates them); give it an owner first")
	case errors.Is(err, ErrTooManyTerrains):
		httpjson.ClientError(w, http.StatusConflict, err.Error())
	case errors.Is(err, ErrBadVisibility):
		httpjson.ClientError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, ErrRevisionMismatch):
		// 412 is what RFC 9110 specifies for a failed If-Match. The plan
		// originally said 409; that is the code for the case above.
		httpjson.ClientError(w, http.StatusPreconditionFailed, "revision mismatch; fetch the world again and retry")
	default:
		httpjson.ServerError(w, "world store", err)
	}
}
