// Package artifacts is the ARTIFACT store: derived data such as the mesh
// level bakes and, later, their tiles.
//
// Named for what it HOLDS, not for being a cache — the client's OPFS copy is a
// cache, this one is the shared authoritative copy. What both do share is the
// property its counterpart internal/modules/world does NOT have: everything here is a
// deterministic function of a world plus a pipeline version, so it can be
// dropped at any time and recomputed. That is why the two are separate modules
// with deliberately different delete affordances in the UI.
//
// Addressing (2026-08-12): an artifact is a minted uuid; the LOGICAL key —
// worldId, pipelineVersion, stage — appears in exactly one request,
// `resolve`, which translates it to the uid every other route uses. The
// mapping is carried by each entry's own meta.json, so the disk layout says
// nothing a schema change could break. See the store's header for the whole
// argument.
//
// BY CONTENT since 2026-10-16 (docs/decisions/artifacts-by-content.md,
// DEC-0039): the key names the terrain, not the world, so every world with
// that terrain finds the artifact — a copy of a template at once. Two rules
// make that safe:
//
//   - ONLY A JOB WORKER WRITES (fork 2). Its token is bound to one world,
//     and it computes the bytes from that world's stored save, so the
//     content is a function of the key by construction. Any other caller
//     gets 403 on a write; the browser does not upload. (The local mode,
//     where every check answers yes, writes as before.)
//   - A CALLER READS THROUGH A WORLD (fork 4): they may read an artifact
//     when they may read a world whose terrain ids hold its worldId. The
//     world module keeps those ids; a job worker reports each one when it
//     resolves (fork 3, Config.AddTerrain), as the server cannot derive a
//     worldId from a save.
package artifacts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/blob"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/httpjson"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
)

// UploadLimit caps one artifact file. An amplified elevation raster is ~17 MB
// at 4096 and ~67 MB at 8192; this leaves room for the resolutions above that
// without letting a single request run away. A candidate for a flag once a
// deployment has an opinion. Exported because it also bounds the dir
// backend's PUT links (NewLinkSigner).
const UploadLimit = 512 << 20 // 512 MiB

// LinkBase is the path under which the dir backend serves its own links
// (DEC-0038, fork 5): `GET /v1/artifacts/blob/<key>?exp=…&sig=…`. In this
// module's namespace; the link is the authorization, so the gate lets a
// request with a valid one through without credentials (SignedRequest).
const LinkBase = "/v1/artifacts/blob/"

// Config carries the full configuration tree (every module holds it whole —
// decided 2026-08-12). No viper here by design; the module reads Global and
// its OWN section (`artifacts.*`), nothing else.
type Config struct {
	All config.Config
	// Bucket is where the bytes are: a blob.Dir or a blob.S3, opened by
	// cmd/ from artifacts.storage (cmd/storage.go). A Dir that signs links
	// (blob.OpenDir with NewLinkSigner) makes this module serve them.
	Bucket blob.Bucket
	// Identity answers who a request comes from — the one resolver cmd/
	// builds and every module shares.
	Identity *identity.Resolver
	// The three questions this module asks of the world module (DEC-0039),
	// each injected by cmd/: a closure over the co-resident world module, or
	// an HTTP call to the world service (global.services.worlds), which gets
	// the caller's own Authorization header. In the local mode they answer
	// Admin and record nothing, which is the none-mode short circuit.
	//
	// WorldAccess ranks a caller against a world and answers its terrain ids
	// — the sweep before a world is deleted, and a job token's check.
	WorldAccess func(ctx context.Context, worldUID, bearer string) (exists bool, level access.Level, terrains []string)
	// TerrainAccess ranks a caller against a terrain: their highest level
	// over the worlds that hold it, and whether more than one world holds
	// it. Artifacts INHERIT the visibility of those worlds, which is why
	// reading one is not "informational".
	TerrainAccess func(ctx context.Context, worldID, bearer string) (level access.Level, shared bool)
	// AddTerrain records that a job of world `worldUID` resolved terrain
	// `worldID`; `bearer` is the job's token, which a world service checks
	// again.
	AddTerrain func(ctx context.Context, worldUID, worldID, bearer string) error
}

// Module serves the artifact store.
type Module struct {
	cfg   Config
	store *Store
	// signer checks the dir backend's links; nil on s3, whose links the
	// provider checks.
	signer *blob.LinkSigner
	// readTTL is the lifetime of a read link (artifacts.read-link-ttl).
	readTTL time.Duration
	// writeTTL is the lifetime of a write link (artifacts.write-link-ttl).
	writeTTL time.Duration

	// bound remembers the terrains this process recorded for a job's world
	// (AddTerrain), so that the job's later requests — a write link and a
	// commit per file, a read per file — need no call to the world module.
	// A miss asks it (WorldAccess); losing the set at a restart costs one
	// call per world.
	boundMu sync.Mutex
	bound   map[string]map[string]bool // world uid → terrain ids
}

// signing is what a Dir that makes its own links offers.
type signing interface{ Signer() *blob.LinkSigner }

// NewLinkSigner makes the signer of the dir backend's links from
// artifacts.link-key (DEC-0038, fork 4). Without a key file the key is
// ephemeral and the links die at restart, which is logged. With
// artifacts.link-key-previous the signer also accepts the links of the
// key before (a change-over, 2026-10-16); it signs with artifacts.link-key.
func NewLinkSigner(cfg config.Config) (*blob.LinkSigner, error) {
	key, ephemeral, err := blob.ReadLinkKey(cfg.Artifacts.LinkKey)
	if err != nil {
		return nil, fmt.Errorf("artifacts.link-key: %w", err)
	}
	if ephemeral {
		slog.Warn("artifacts.link-key is not set: the artifact links use an ephemeral key and stop working at restart")
	}
	previous, err := blob.ReadPreviousLinkKey(cfg.Artifacts.LinkKeyPrevious)
	if err != nil {
		return nil, fmt.Errorf("artifacts.link-key-previous: %w", err)
	}
	keys := [][]byte{key}
	if previous != nil {
		keys = append(keys, previous)
	}
	return blob.NewLinkSigner(LinkBase, UploadLimit, keys...)
}

// BucketOptions are what the store asks of an s3 bucket: CORS, because the
// browser follows the 302 of a read to the bucket's origin
// (blob.ReadLinkCORS, which says why the rule is what it is).
func BucketOptions() blob.OpenOptions {
	return blob.OpenOptions{CORS: blob.ReadLinkCORS()}
}

// New prepares the store and builds its index from the bucket, so a bucket
// that cannot be read fails at startup rather than on first request.
func New(ctx context.Context, cfg Config) (*Module, error) {
	if cfg.Identity == nil || cfg.WorldAccess == nil || cfg.TerrainAccess == nil || cfg.AddTerrain == nil || cfg.Bucket == nil {
		return nil, fmt.Errorf("artifacts needs its bucket, identity and world wiring; that is cmd/'s job")
	}
	capBytes, err := config.ParseByteSize(cfg.All.Artifacts.Cap)
	if err != nil {
		return nil, fmt.Errorf("artifacts.cap: %w", err)
	}
	readTTL := cfg.All.Artifacts.ReadLinkTTL
	if readTTL <= 0 || readTTL > blob.MaxLinkTTL {
		return nil, fmt.Errorf("artifacts.read-link-ttl: %v must be in (0, %v]", readTTL, blob.MaxLinkTTL)
	}
	writeTTL := cfg.All.Artifacts.WriteLinkTTL
	if writeTTL <= 0 || writeTTL > blob.MaxLinkTTL {
		return nil, fmt.Errorf("artifacts.write-link-ttl: %v must be in (0, %v]", writeTTL, blob.MaxLinkTTL)
	}
	store, err := NewStore(ctx, cfg.Bucket, capBytes)
	if err != nil {
		return nil, fmt.Errorf("artifacts.storage: %w", err)
	}
	m := &Module{cfg: cfg, store: store, readTTL: readTTL, writeTTL: writeTTL, bound: map[string]map[string]bool{}}
	if d, ok := cfg.Bucket.(signing); ok {
		m.signer = d.Signer()
	}
	return m, nil
}

// Name identifies the module in logs and errors.
func (m *Module) Name() string { return "artifacts" }

// Store is the module's store, for a co-resident module's injected lookup
// (the jobs coordinator's ArtifactPresent, composed in cmd/) — the same
// handing-out the world module does.
func (m *Module) Store() *Store { return m.store }

// Mount claims the artifact routes.
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("POST /v1/artifacts/resolve", m.handleResolve)
	mux.HandleFunc("GET /v1/artifacts", m.handleList)
	mux.HandleFunc("GET /v1/artifacts/levels", m.handleLevels)
	mux.HandleFunc("DELETE /v1/artifacts", m.handleClear)
	mux.HandleFunc("DELETE /v1/artifacts/{artifactUID}", m.handleRemove)
	// `{name...}` rather than `{name}` so a future tile layout ("tiles/12_7")
	// needs no new route; every segment is validated in the store, which is
	// what keeps the flexibility from becoming a path traversal.
	mux.HandleFunc("GET /v1/artifacts/{artifactUID}/{name...}", m.handleGet)
	// The server's own upload. Since DEC-0039 only a job token or the local
	// mode writes (writing), and a job worker writes by link (the two
	// routes below, DEC-0038, fork 7); this route stays for the local mode.
	mux.HandleFunc("PUT /v1/artifacts/{artifactUID}/{name...}", m.handlePut)
	mux.HandleFunc("POST /v1/artifacts/{artifactUID}/write-link", m.handleWriteLink)
	mux.HandleFunc("POST /v1/artifacts/{artifactUID}/commit", m.handleCommit)
	// The dir backend's own links. More specific than the routes above, so
	// the mux sends /v1/artifacts/blob/… here (no uid is "blob": uids are
	// minted uuids). Not mounted on s3: the provider serves its links.
	if m.signer != nil {
		mux.HandleFunc("GET "+LinkBase+"{key...}", m.handleLink)
		mux.HandleFunc("PUT "+LinkBase+"{key...}", m.handleLinkPut)
	}
	return nil
}

// Close releases the bucket when it holds something open (a Dir's root).
func (m *Module) Close() error {
	if c, ok := m.cfg.Bucket.(io.Closer); ok {
		return c.Close()
	}
	return nil
}

// SignedRequest answers whether a request carries a link this module
// signed (blob.LinkSigner.Signed): a GET (or HEAD) or a PUT under LinkBase.
// cmd/ hands it to server.Gate, which lets such a request through WITHOUT
// credentials: the link is the authorization. False on s3, whose links the
// provider checks.
func (m *Module) SignedRequest(r *http.Request) bool {
	return m.signer != nil && m.signer.Signed(r)
}

// AnonymousReads names the requests this module ranks for a caller WITHOUT
// credentials, rather than the gate refusing them: a resolve and the read
// of a file, because the artifacts of a template are readable by everyone
// (DEC-0039, fork 4). The module ranks such a caller by the terrain
// (allowed): a resolve with create, and every terrain no template holds,
// is refused there. cmd/ hands it to server.Gate with the world module's.
// A pure function of the request, so the gate needs to know no module.
func AnonymousReads(r *http.Request) bool {
	if r.Method == http.MethodPost {
		return r.URL.Path == "/v1/artifacts/resolve"
	}
	if r.Method != http.MethodGet {
		return false
	}
	rest, ok := strings.CutPrefix(r.URL.Path, "/v1/artifacts/")
	if !ok {
		return false
	}
	uid, name, _ := strings.Cut(rest, "/")
	return uid != "" && name != "" && !strings.HasPrefix(r.URL.Path, LinkBase)
}

// operator answers "may this request do anything here": the admin claim, or
// the local mode, where every check answers yes by design.
func (m *Module) operator(r *http.Request) bool {
	if !m.cfg.Identity.ChecksIdentity() {
		return true
	}
	_, admin := m.cfg.Identity.ResolveBearer(r.Header.Get("Authorization"))
	return admin
}

// An operation on an artifact, for the check (allowed).
type operation int

const (
	reading operation = iota
	// writing: resolve with create, a write link, a commit, the server's
	// PUT — a job worker's only (DEC-0039, fork 2).
	writing
	// removing: one artifact or one level — an editor's of a terrain no
	// other world holds, else the operator's (DEC-0039, fork 6).
	removing
)

// allowed ranks a request against an artifact's terrain. Artifacts INHERIT
// the visibility of the worlds that hold the terrain, with the same shape:
// a terrain the caller may not read hides its artifacts behind 404, and
// only readable ones distinguish 403.
//
// Two bypasses, both deliberate: the operator (admin claim / local mode) —
// which is also what keeps ORPHANS reachable, artifacts of a terrain no
// world holds any more; and a job token whose world holds the terrain —
// the writer this system itself sent out, narrowed to the world it was
// sent for (step 4 of the access plan, 2026-08-12). A job does not remove.
func (m *Module) allowed(w http.ResponseWriter, r *http.Request, worldID string, op operation) bool {
	if m.operator(r) {
		if op == writing && m.cfg.Identity.ChecksIdentity() {
			// The admin is no job: content comes from a worker's bake.
			httpjson.ClientError(w, http.StatusForbidden, "only a job worker writes artifacts")
			return false
		}
		return true
	}
	if _, jobWorld, ok := m.cfg.Identity.JobToken(r); ok && jobWorld != "" && worldID != "" && op != removing && m.holds(r, jobWorld, worldID) {
		return true
	}
	if worldID == "" {
		// No terrain to rank against (junk entry): operator territory only.
		httpjson.ClientError(w, http.StatusNotFound, "no such artifact")
		return false
	}
	level, shared := m.cfg.TerrainAccess(r.Context(), worldID, r.Header.Get("Authorization"))
	if level < access.Viewer {
		httpjson.ClientError(w, http.StatusNotFound, "no such artifact")
		return false
	}
	switch op {
	case writing:
		httpjson.ClientError(w, http.StatusForbidden, "only a job worker writes artifacts")
		return false
	case removing:
		if level < access.Editor {
			httpjson.ClientError(w, http.StatusForbidden, "removing artifacts needs editor access to their world")
			return false
		}
		if shared {
			httpjson.ClientError(w, http.StatusForbidden, "these artifacts serve other worlds too; only an admin removes them")
			return false
		}
	}
	return true
}

// holds answers whether a job's world holds a terrain: from what this
// process recorded (bind), else from the world module.
func (m *Module) holds(r *http.Request, worldUID, worldID string) bool {
	m.boundMu.Lock()
	held := m.bound[worldUID][worldID]
	m.boundMu.Unlock()
	if held {
		return true
	}
	exists, _, terrains := m.cfg.WorldAccess(r.Context(), worldUID, r.Header.Get("Authorization"))
	if !exists || !slices.Contains(terrains, worldID) {
		return false
	}
	m.remember(worldUID, worldID)
	return true
}

func (m *Module) remember(worldUID, worldID string) {
	m.boundMu.Lock()
	defer m.boundMu.Unlock()
	set := m.bound[worldUID]
	if set == nil {
		set = map[string]bool{}
		m.bound[worldUID] = set
	}
	set[worldID] = true
}

// bind records the terrain of a job's resolve for the job's world
// (DEC-0039, fork 3): the worker derived the worldId from the world's
// stored save. On a read too — a job that finds what another world's job
// baked binds it, and computes nothing again. In the local mode no token
// names the world; the request's `world` does (resolveRequest.World).
// False when it answered.
func (m *Module) bind(w http.ResponseWriter, r *http.Request, worldID, world string) bool {
	_, jobWorld, ok := m.cfg.Identity.JobToken(r)
	if !m.cfg.Identity.ChecksIdentity() {
		jobWorld, ok = world, world != ""
	}
	if !ok || jobWorld == "" {
		return true
	}
	m.boundMu.Lock()
	held := m.bound[jobWorld][worldID]
	m.boundMu.Unlock()
	if held {
		return true
	}
	if err := m.cfg.AddTerrain(r.Context(), jobWorld, worldID, r.Header.Get("Authorization")); err != nil {
		// The job's world is gone, or the world module did not answer: the
		// job cannot go on either way.
		slog.Warn("terrain of a job not recorded", "uid", jobWorld, "world", worldID, "err", err)
		httpjson.ClientError(w, http.StatusServiceUnavailable, "the terrain of the job's world could not be recorded")
		return false
	}
	m.remember(jobWorld, worldID)
	return true
}

type resolveRequest struct {
	Key
	// With create, an absent key mints an artifact and returns its fresh uid —
	// the writer's path. Without it, absent is 404 — the reader's.
	Create bool `json:"create"`
	// World is the world uid the writer works for — NOT part of the key.
	// Read in the local mode only, where no job token names the world: the
	// terrain is recorded for it there (bind). A checking server reads the
	// world from the job's token and ignores this.
	World string `json:"world"`
}

type resolveResponse struct {
	ArtifactUID string `json:"artifactUid"`
	// The files currently present — the batch existence answer that used to be
	// its own `present` endpoint.
	Files []string `json:"files"`
}

func (m *Module) handleResolve(w http.ResponseWriter, r *http.Request) {
	var request resolveRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&request); err != nil {
		httpjson.ClientError(w, http.StatusBadRequest, "expected {worldId, pipelineVersion, stage, create?}")
		return
	}
	if !request.Key.Valid() {
		httpjson.ClientError(w, http.StatusBadRequest, "invalid artifact key")
		return
	}
	op := reading
	if request.Create {
		op = writing
	}
	if !m.bind(w, r, request.WorldID, request.World) || !m.allowed(w, r, request.WorldID, op) {
		return
	}
	uid, files, err := m.store.Resolve(r.Context(), request.Key, request.Create)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	if request.Create {
		slog.Info("artifact resolved for writing", "artifact", uid, "world", request.WorldID, "version", request.PipelineVersion, "stage", request.Stage)
	}
	httpjson.Write(w, http.StatusOK, resolveResponse{ArtifactUID: uid, Files: files})
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	worldID, _ := m.store.TerrainOf(r.Context(), r.PathValue("artifactUID"))
	if !m.allowed(w, r, worldID, reading) {
		return
	}
	// The right is checked; the bytes come from a link that carries it
	// (DEC-0038, step 3): a presigned GET on s3, so they do not pass through
	// this server, or this module's own signed link on dir.
	link, err := m.store.Link(r.Context(), r.PathValue("artifactUID"), r.PathValue("name"), m.readTTL)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	// A link is valid for minutes; a redirect cached past that would send
	// the client to a dead link.
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, link.URL, http.StatusFound)
}

// handleLink serves a dir link. No caller is needed: the gate let the
// request through for its signature (SignedRequest), and it is checked
// again here, where its result decides. The answers say no more than the
// link holder knows: 403 for a link that does not verify (whatever is
// wrong with it), 410 for one of ours that has expired, 404 for a signed
// key whose object has gone.
func (m *Module) handleLink(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	if _, err := m.signer.Verify(http.MethodGet, key, r.URL.Query()); err != nil {
		if errors.Is(err, blob.ErrLinkExpired) {
			httpjson.ClientError(w, http.StatusGone, "the link has expired")
			return
		}
		httpjson.ClientError(w, http.StatusForbidden, "the link is not valid")
		return
	}
	body, info, err := m.cfg.Bucket.Get(r.Context(), key)
	if err != nil {
		if errors.Is(err, blob.ErrNotFound) {
			httpjson.ClientError(w, http.StatusNotFound, "no such artifact")
			return
		}
		httpjson.ServerError(w, "artifact store", err)
		return
	}
	defer func() { _ = body.Close() }()
	// No conditional-request handling and no cache validators: an artifact is
	// immutable under its key, so a client that has it never asks again — and
	// one that asks does not have it.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	_, _ = io.Copy(w, body)
}

// handleLinkPut serves a dir write link: the bytes of one object, with
// exactly the signed length. As handleLink, no caller is needed. The
// answers are the ones a provider gives a presigned PUT (measured on AWS,
// DEC-0038 step 2): 403 for a link that does not verify and for a body of
// another length (the length is signed), 410 for one of ours that has
// expired. The index does not learn of the object here; the writer's
// commit tells it (handleCommit).
func (m *Module) handleLinkPut(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	length, err := m.signer.Verify(http.MethodPut, key, r.URL.Query())
	if err != nil {
		if errors.Is(err, blob.ErrLinkExpired) {
			httpjson.ClientError(w, http.StatusGone, "the link has expired")
			return
		}
		httpjson.ClientError(w, http.StatusForbidden, "the link is not valid")
		return
	}
	// A chunked body (-1) has no length to compare: refused as well.
	if r.ContentLength != length {
		httpjson.ClientError(w, http.StatusForbidden, "the link is for another length")
		return
	}
	body := &bodyReader{r: http.MaxBytesReader(w, r.Body, length)}
	// The artifact decides too: a link given before its commit is no longer
	// valid, nor one whose file is not pending (given before a restart),
	// and a meta.json must name the artifact's key (Store.AcceptUpload).
	// Answered as a provider answers a link it does not take: 403; a meta
	// that names another key 409, as at a commit.
	uid, name, _ := strings.Cut(key, "/")
	var meta []byte
	var payload io.Reader = body
	if name == metaName {
		raw, err := readExactly(body, length, metaLimit)
		if err != nil {
			httpjson.ClientError(w, http.StatusBadRequest, "the body ended before its length")
			return
		}
		meta, payload = raw, bytes.NewReader(raw)
	}
	if err := m.store.AcceptUpload(uid, name, meta); err != nil {
		if errors.Is(err, ErrKeyMismatch) {
			httpjson.ClientError(w, http.StatusConflict, err.Error())
			return
		}
		httpjson.ClientError(w, http.StatusForbidden, "the link is not valid any more")
		return
	}
	if _, err := m.cfg.Bucket.Put(r.Context(), key, payload, length, blob.PutOptions{ContentType: "application/octet-stream"}); err != nil {
		if body.failed || errors.Is(err, blob.ErrSize) {
			httpjson.ClientError(w, http.StatusBadRequest, "the body ended before its length")
			return
		}
		httpjson.ServerError(w, "storing an artifact", err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// WriteLinkCommitted is the code in the body of the 409 that write-link
// answers for a whole artifact: another writer committed it first, and its
// bytes are there. The client takes it as "already written"
// (HttpArtifactStore.ts). The other 409 of the route (too many uncommitted
// files) carries no code: it is a refusal.
const WriteLinkCommitted = "committed"

type writeLinkRequest struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// writeLinkResponse is a write link as a worker sends it: the method and
// URL, the headers to send with it (signed in on s3), and when it expires.
// The URL of a dir link is a path on this server, relative to the request.
// Content-Length is not among the headers: the client sends the body's own,
// and the link refuses another one.
type writeLinkResponse struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Header  map[string]string `json:"header"`
	Expires time.Time         `json:"expires"`
}

// handleWriteLink gives a writer a link to upload one file of an artifact
// straight to the bucket (DEC-0038, fork 7), with the file's length signed
// in and artifacts.write-link-ttl to live. The right is the right to write
// the artifact, as for handlePut: a job token whose world holds the
// artifact's terrain, or the local mode. The same route gives a fresh link when the
// one in hand has expired or was refused.
func (m *Module) handleWriteLink(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("artifactUID")
	var request writeLinkRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&request); err != nil || request.Name == "" {
		httpjson.ClientError(w, http.StatusBadRequest, "expected {name, size}")
		return
	}
	worldID, _ := m.store.TerrainOf(r.Context(), uid)
	if !m.allowed(w, r, worldID, writing) {
		return
	}
	link, err := m.store.WriteLink(r.Context(), uid, request.Name, request.Size, m.writeTTL)
	if err != nil {
		switch {
		case errors.Is(err, errTooLarge):
			httpjson.ClientError(w, http.StatusRequestEntityTooLarge, "artifact file too large")
		case errors.Is(err, errBadSize):
			httpjson.ClientError(w, http.StatusBadRequest, "size must be the file's length in bytes")
		case errors.Is(err, errCommitted):
			httpjson.ClientErrorCode(w, http.StatusConflict, WriteLinkCommitted, err.Error())
		case errors.Is(err, errTooManyPending):
			httpjson.ClientError(w, http.StatusConflict, err.Error())
		case errors.Is(err, errStoreFull):
			// A 5xx: the store is full for now, not the request wrong; the
			// worker gives its task back, and the sweep or a commit makes
			// room.
			httpjson.ClientError(w, http.StatusInsufficientStorage, err.Error())
		case errors.Is(err, ErrNotFound):
			httpjson.ClientError(w, http.StatusNotFound, "no such artifact — resolve with create first")
		default:
			respondStoreError(w, err)
		}
		return
	}
	header := map[string]string{}
	for name, values := range link.Header {
		if strings.EqualFold(name, "Content-Length") || strings.EqualFold(name, "Host") {
			continue
		}
		header[name] = strings.Join(values, ",")
	}
	httpjson.Write(w, http.StatusOK, writeLinkResponse{Method: link.Method, URL: link.URL, Header: header, Expires: link.Expires.UTC()})
}

type commitRequest struct {
	Files []Upload `json:"files"`
}

// handleCommit takes a writer's word that it uploaded files by link, checks
// each with a Head (there, and of the size it says) and enters them into
// the index. A writer commits once per artifact, with its meta.json, which
// it writes last; the commit makes the artifact whole. 409 when a file is
// not in the bucket as said, or was never signed.
func (m *Module) handleCommit(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("artifactUID")
	var request commitRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&request); err != nil || len(request.Files) == 0 {
		httpjson.ClientError(w, http.StatusBadRequest, "expected {files: [{name, size}]}")
		return
	}
	worldID, _ := m.store.TerrainOf(r.Context(), uid)
	if !m.allowed(w, r, worldID, writing) {
		return
	}
	if err := m.store.Commit(r.Context(), uid, request.Files); err != nil {
		switch {
		case errors.Is(err, ErrNotSigned), errors.Is(err, ErrNotUploaded), errors.Is(err, ErrKeyMismatch):
			httpjson.ClientError(w, http.StatusConflict, err.Error())
		case errors.Is(err, ErrNotFound):
			httpjson.ClientError(w, http.StatusNotFound, "no such artifact — resolve with create first")
		default:
			respondStoreError(w, err)
		}
		return
	}
	slog.Info("artifact files committed", "artifact", uid, "files", len(request.Files))
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handlePut(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("artifactUID")
	// Ranked via the RESERVATION's key when the meta has not landed yet —
	// which on the write path it by definition has not.
	worldID, _ := m.store.TerrainOf(r.Context(), uid)
	if !m.allowed(w, r, worldID, writing) {
		return
	}
	if r.ContentLength > UploadLimit {
		httpjson.ClientError(w, http.StatusRequestEntityTooLarge, "artifact upload too large or truncated")
		return
	}
	body := &bodyReader{r: http.MaxBytesReader(w, r.Body, UploadLimit)}
	// r.ContentLength is -1 for a chunked upload; the store spools it.
	if err := m.store.Write(r.Context(), uid, r.PathValue("name"), body, r.ContentLength); err != nil {
		switch {
		case errors.Is(err, ErrBadPath):
			httpjson.ClientError(w, http.StatusBadRequest, "invalid artifact path")
		case errors.Is(err, ErrKeyMismatch):
			httpjson.ClientError(w, http.StatusConflict, err.Error())
		case errors.Is(err, ErrNotFound):
			// Writing into an unminted uid: resolve with create first. Loud on
			// purpose — accepting the write would mint entries out of thin air.
			httpjson.ClientError(w, http.StatusNotFound, "no such artifact — resolve with create first")
		case body.failed || errors.Is(err, blob.ErrSize) || errors.Is(err, errTooLarge):
			// A body that exceeded the cap, or ended before its length,
			// surfaces from the copy, not from the path check, so it is
			// reported here rather than as a store fault.
			httpjson.ClientError(w, http.StatusRequestEntityTooLarge, "artifact upload too large or truncated")
		default:
			// The bucket refused or could not be reached: the server's
			// fault, not the upload's (on s3 a network error lands here).
			httpjson.ServerError(w, "storing an artifact", err)
		}
		return
	}
	slog.Info("artifact stored", "artifact", uid, "name", r.PathValue("name"))
	// 204 rather than 201: a repeated upload of the same key is a no-op by
	// construction, so "created" would be a claim this store cannot make.
	w.WriteHeader(http.StatusNoContent)
}

// bodyReader records whether reading the request body failed, so that a
// failed write can be told apart: the upload's fault (413) or the bucket's
// (500).
type bodyReader struct {
	r      io.Reader
	failed bool
}

func (b *bodyReader) Read(p []byte) (int, error) {
	n, err := b.r.Read(p)
	if err != nil && !errors.Is(err, io.EOF) {
		b.failed = true
	}
	return n, err
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	visible, bytes, err := m.visible(r)
	if err != nil {
		httpjson.ServerError(w, "listing artifacts", err)
		return
	}
	httpjson.Write(w, http.StatusOK, map[string]any{"artifacts": visible, "bytes": bytes})
}

// visible is what the caller may see of the store, and its size.
//
// The listing inherits the worlds' visibility: an artifact shows to
// whoever may read a world that holds its terrain. Meta-less entries
// (junk, mid-write) show only to the operator — they can rank nobody. One
// TerrainAccess per DISTINCT terrain, not per artifact. Each entry says
// what the caller may do with it (callerLevel: the caller's highest level
// over those worlds, "admin" for the operator; shared: other worlds hold
// the terrain too, so only an admin removes it), so a client greys out what
// it may not delete rather than letting the request fail.
func (m *Module) visible(r *http.Request) ([]callerArtifact, int64, error) {
	artifacts, err := m.store.List(r.Context())
	if err != nil {
		return nil, 0, err
	}
	visible := make([]callerArtifact, 0, len(artifacts))
	var bytes int64
	if m.operator(r) {
		for _, artifact := range artifacts {
			visible = append(visible, callerArtifact{artifact, access.Admin.String(), false})
		}
		// The operator sees the whole store, so the gauge is the whole store —
		// the cache-size figure the eviction reasons about.
		bytes, _ = m.store.Usage(r.Context())
		return visible, bytes, nil
	}
	// Anyone else sees what they may see, and its size: the store's whole
	// usage would tell them about worlds they cannot see.
	bearer := r.Header.Get("Authorization")
	type rank struct {
		level  access.Level
		shared bool
	}
	ranks := map[string]rank{}
	for _, artifact := range artifacts {
		if artifact.WorldID == "" {
			continue
		}
		got, ranked := ranks[artifact.WorldID]
		if !ranked {
			got.level, got.shared = m.cfg.TerrainAccess(r.Context(), artifact.WorldID, bearer)
			ranks[artifact.WorldID] = got
		}
		if got.level >= access.Viewer {
			visible = append(visible, callerArtifact{artifact, got.level.String(), got.shared})
			bytes += artifact.Bytes
		}
	}
	return visible, bytes, nil
}

// LevelSummary is one level of one terrain under one pipeline version: a
// whole level (count 1) or its tiles (count of them), and their bytes —
// what the artifact window shows as a row, instead of an entry per tile
// (a world refined to level 3 is ten thousand of them, 2026-10-02).
type LevelSummary struct {
	WorldID         string `json:"worldId"`
	PipelineVersion string `json:"pipelineVersion"`
	Level           int    `json:"level"`
	Tiles           bool   `json:"tiles"`
	Count           int    `json:"count"`
	Bytes           int64  `json:"bytes"`
	Label           string `json:"label"`
	BakeMs          int64  `json:"bakeMs"`
	CallerLevel     string `json:"callerLevel"`
	Shared          bool   `json:"shared"`
}

// handleLevels lists what the caller may see, summed per terrain,
// pipeline version and level. Entries whose stage is no level (junk, other
// kinds) are left out; the flat listing still shows them.
func (m *Module) handleLevels(w http.ResponseWriter, r *http.Request) {
	visible, bytes, err := m.visible(r)
	if err != nil {
		httpjson.ServerError(w, "listing artifacts", err)
		return
	}
	type groupKey struct {
		terrain, pipeline string
		level             int
		tiles             bool
	}
	groups := map[groupKey]*LevelSummary{}
	var order []groupKey
	for _, a := range visible {
		level, tile, ok := StageLevel(a.Stage)
		if !ok {
			continue
		}
		k := groupKey{a.WorldID, a.PipelineVersion, level, tile}
		g := groups[k]
		if g == nil {
			g = &LevelSummary{WorldID: a.WorldID, PipelineVersion: a.PipelineVersion, Level: level, Tiles: tile, Label: a.Label, CallerLevel: a.CallerLevel, Shared: a.Shared}
			groups[k] = g
			order = append(order, k)
		}
		g.Count++
		g.Bytes += a.Bytes
		g.BakeMs += int64(a.BakeMs)
	}
	sort.Slice(order, func(i, j int) bool {
		a, b := order[i], order[j]
		if a.terrain != b.terrain {
			return a.terrain < b.terrain
		}
		if a.level != b.level {
			return a.level < b.level
		}
		return a.pipeline < b.pipeline
	})
	out := make([]LevelSummary, 0, len(order))
	for _, k := range order {
		out = append(out, *groups[k])
	}
	httpjson.Write(w, http.StatusOK, map[string]any{"levels": out, "bytes": bytes})
}

// A listed artifact with the caller's level on its terrain, and whether
// other worlds hold the terrain too (see visible).
type callerArtifact struct {
	ListedArtifact
	CallerLevel string `json:"callerLevel"`
	Shared      bool   `json:"shared"`
}

func (m *Module) handleRemove(w http.ResponseWriter, r *http.Request) {
	// Editor suffices for a terrain only their world holds: an artifact is
	// recomputable by anyone who may bake, so dropping one destroys nothing
	// an editor could not remake. A shared one serves other people's worlds.
	worldID, _ := m.store.TerrainOf(r.Context(), r.PathValue("artifactUID"))
	if !m.allowed(w, r, worldID, removing) {
		return
	}
	if err := m.store.RemoveArtifact(r.Context(), r.PathValue("artifactUID")); err != nil {
		respondStoreError(w, err)
		return
	}
	slog.Info("artifact dropped", "artifact", r.PathValue("artifactUID"))
	w.WriteHeader(http.StatusNoContent)
}

// handleClear clears everything, or — with ?world={uid} — the artifacts of
// the world's terrains that no other world holds (the sweep before a world
// is deleted), or — with ?worldId={id}&level={n} — one level of a terrain,
// its tiles included, narrowed by &pipeline= to one version (the artifact
// window's "delete this level").
func (m *Module) handleClear(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if levelText := query.Get("level"); levelText != "" {
		level, err := strconv.Atoi(levelText)
		if err != nil || level < 0 {
			httpjson.ClientError(w, http.StatusBadRequest, "level must be a level's number")
			return
		}
		worldID := query.Get("worldId")
		if worldID == "" {
			httpjson.ClientError(w, http.StatusBadRequest, "a level is removed for one terrain: worldId is missing")
			return
		}
		if !m.allowed(w, r, worldID, removing) {
			return
		}
		removed, err := m.store.RemoveLevel(r.Context(), worldID, level, query.Get("pipeline"))
		if err != nil {
			respondStoreError(w, err)
			return
		}
		slog.Info("artifacts dropped", "world", worldID, "level", level, "count", removed)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if world := query.Get("world"); world != "" {
		m.sweepWorld(w, r, world)
		return
	}
	// Clearing EVERYTHING is store administration, not a per-world right.
	if !m.operator(r) {
		httpjson.ClientError(w, http.StatusForbidden, "clearing the whole store is an admin action")
		return
	}
	if err := m.store.Clear(r.Context()); err != nil {
		httpjson.ServerError(w, "clearing artifacts", err)
		return
	}
	slog.Info("artifact store cleared")
	w.WriteHeader(http.StatusNoContent)
}

// sweepWorld removes what a world takes with it when it is deleted: the
// artifacts of each of its terrains that no other world holds (DEC-0039,
// fork 6). A shared terrain stays, as it serves the other worlds. It rides
// on world.delete's level, and runs BEFORE the world is deleted: a world
// that is gone holds no terrain, and its artifacts are then the
// operator's (and the cap's).
func (m *Module) sweepWorld(w http.ResponseWriter, r *http.Request, world string) {
	bearer := r.Header.Get("Authorization")
	exists, level, terrains := m.cfg.WorldAccess(r.Context(), world, bearer)
	if !m.operator(r) {
		if !exists || level < access.Viewer {
			httpjson.ClientError(w, http.StatusNotFound, "no such world")
			return
		}
		if level < access.Owner {
			httpjson.ClientError(w, http.StatusForbidden, "sweeping a world's artifacts needs owner access to it")
			return
		}
	}
	removed := 0
	for _, worldID := range terrains {
		// Asked as the operator would be: whether ANY other world holds the
		// terrain, the caller's rights on it aside.
		if _, shared := m.cfg.TerrainAccess(r.Context(), worldID, bearer); shared {
			continue
		}
		n, err := m.store.RemoveTerrain(r.Context(), worldID)
		if err != nil {
			respondStoreError(w, err)
			return
		}
		removed += n
	}
	slog.Info("artifacts dropped", "uid", world, "count", removed)
	w.WriteHeader(http.StatusNoContent)
}

func respondStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httpjson.ClientError(w, http.StatusNotFound, "no such artifact")
	case errors.Is(err, ErrBadPath):
		httpjson.ClientError(w, http.StatusBadRequest, "invalid artifact path")
	default:
		httpjson.ServerError(w, "artifact store", err)
	}
}
