package world

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/blob"
)

// The world store's keys in its bucket (DEC-0038 step 5: a blob.Bucket, a
// directory or an S3 bucket, one code path).
//
//	{uid}/meta.json                 the world: name, owner, current revision
//	{uid}/grants.json               the ACL, server-owned
//	{uid}/rev/{n}/world.zip         the save exactly as uploaded
//	{uid}/rev/{n}/preview.png       extracted at upload
//	{uid}/rev/{n}/meta.json         size, erosionRun, when
//
// The layout is the one the store had on disk before the leaf (a Dir's key
// is the file's path under its root), so an existing ./data/worlds opens as
// it is, with no migration. Two properties it is chosen for. Everything of
// a world is under the prefix {uid}/, so dropping one is one listing and
// its deletes, and inspecting the store needs no tooling. And revisions are
// separate keys rather than one overwritten object, so an upload never
// destroys the copy it replaces — which matters because this is the half of
// the system holding data that cannot be recomputed.
//
// Revisions are a SAFETY MARGIN, not a history feature (decided 2026-08-11):
// nothing serves an old revision over the API, so keeping every one forever
// was write-only storage. The store retains the newest `keepRevisions` and
// prunes older ones on upload; a byte-identical re-upload is deduplicated via
// the revision's content hash and mints no new revision at all.

// ErrNotFound is returned for a world (or revision) that is not there.
var ErrNotFound = errors.New("world not found")

// ErrRevisionMismatch is returned when the caller's expected revision is not
// the one stored — someone else wrote in between. Deliberately distinct from
// a generic failure, because the handler must turn it into 412 rather than 500.
var ErrRevisionMismatch = errors.New("revision mismatch")

// ErrExists is returned when a create-only write finds a world already there.
var ErrExists = errors.New("world already exists")

// ErrNoGrants is returned when a change to a world's grants finds no grants
// document to change — a world from before grants existed. Its owner is a
// question for the migration rule, which a template mark must not answer
// by the way.
var ErrNoGrants = errors.New("world has no grants")

// safeUID is what may become a key segment. Deliberately strict — the uid
// is a UUID from our own client, so anything else is either a bug or an
// attempt at path traversal, and there is no reason to be liberal about it.
var safeUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Meta is {uid}/meta.json — the world itself.
type Meta struct {
	UID   string `json:"uid"`
	Name  string `json:"name"`
	Owner string `json:"owner"`
	// Revision of the CURRENT contents. Also the ETag, and what a caller
	// passes back in If-Match.
	Revision  int       `json:"revision"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	// Mirrored from the newest revision so a listing needs one object per
	// world rather than a walk into every revision.
	Size       int64 `json:"size"`
	ErosionRun int   `json:"erosionRun"`
	HasPreview bool  `json:"hasPreview"`
	// Display data mirrored the same way (2026-08-12, for the load/save
	// panels): the recipe's seed, the build that wrote the save, and the
	// current revision's content hash. Empty until a world is uploaded again.
	Seed        string `json:"seed"`
	Generator   string `json:"generator"`
	ContentHash string `json:"contentHash"`
	// The save's shape and its accepted progress, mirrored the same way
	// (2026-10-11, for the world list): `kind` and `status.progress` of
	// world.yaml. Empty until a world is uploaded again.
	Kind     string `json:"kind"`
	Progress string `json:"progress"`
	// Whether the world is a template (access.Grants.Template), mirrored from
	// grants.json like the owner — a DISPLAY MIRROR: the rank is read from
	// the grants, never from here (2026-10-15, docs/decisions/
	// template-worlds.md).
	Template bool `json:"template"`
}

// RevisionMeta is {uid}/rev/{n}/meta.json.
type RevisionMeta struct {
	Revision   int       `json:"revision"`
	Size       int64     `json:"size"`
	ErosionRun int       `json:"erosionRun"`
	HasPreview bool      `json:"hasPreview"`
	CreatedAt  time.Time `json:"createdAt"`
	// SHA-256 of the zip bytes as uploaded — what the dedupe compares.
	// Deliberately a plain byte hash and NOT the client's worldId: that one
	// hashes dequantised layers and would differ between writer and reader
	// (the trap server-storage.md records under "What changes in world.yaml").
	ContentHash string `json:"contentHash"`
}

// Store is the world store on a blob.Bucket.
//
// THE INDEX. Each world's meta.json and grants.json are read once, at start,
// from one List of the bucket and a Get of each (16 at a time), and then
// kept in memory: Get, List and the ranking (ReadGrants, once per request
// and once per world in a listing) read no object. That holds because this
// process is the ONE WRITER of its bucket (one process per store, CLAUDE.md):
// every write passes through this store and updates the index after the
// bucket accepted it. An object changed in the bucket by hand is seen at the
// next start.
//
// Its methods take a context; the Dir backend cannot cancel file I/O, the S3
// backend can.
type Store struct {
	bucket blob.Bucket
	// How many revisions to retain per world; older ones are pruned on
	// upload. 0 keeps every revision (the pre-2026-08-11 behaviour).
	keepRevisions int
	// One mutex per world, so two uploads of the SAME world serialise while
	// uploads of different worlds do not. The revision check alone is not
	// enough: without this, two requests could both read revision 3 and both
	// decide they may write 4.
	//
	// In-process only: the lock IS the concurrency model (one writer). A
	// second process against one bucket is out of the model. What the
	// bucket adds against it is the conditional write (put, ifAbsent) on the
	// keys that are created once — a revision's save and a new world's
	// meta.json — where the provider has it.
	//
	// Counted (worldLock.refs): an entry stays in the map while a writer
	// holds it or waits on it, and goes when the last one is done. So the
	// map holds only the worlds being written, and a writer that comes while
	// another waits gets the SAME mutex. Until 2026-10-16 Delete dropped the
	// entry while a writer waited on it, and the next writer got a fresh
	// mutex: two writers of one world ran at once.
	locksMu sync.Mutex
	locks   map[string]*worldLock

	mu     sync.RWMutex
	worlds map[string]worldEntry // uid -> the world's meta and grants
	// taken is the highest revision number with objects in the bucket, per
	// uid — a world's or one without meta.json (claimRevision).
	taken map[string]int

	// noConditional is set when the bucket refused a conditional write
	// (blob.ErrUnsupported: a flavour whose row does not claim it, ceph
	// today). From then on create-only keys are plain writes, protected by
	// the lock alone.
	noConditional atomic.Bool

	// now is injected so tests can be deterministic about timestamps.
	now func() time.Time
}

// worldEntry is a world in the index: a uid whose meta.json exists.
type worldEntry struct {
	meta Meta
	// metaErr: meta.json exists but does not parse. Get answers the error,
	// List skips the world.
	metaErr error
	grants  access.Grants
	// hasGrants: grants.json exists. False is the legacy state (a world
	// from before grants), not an error.
	hasGrants bool
	// grantsErr: grants.json exists but does not parse — corrupt is NOT
	// absent (readGrants).
	grantsErr error
}

// documentLimit bounds the bytes read of one meta.json or grants.json: they
// are some hundred bytes; a larger object is not one this store wrote.
const documentLimit = 1 << 20

// indexParallelism is how many documents the start reads at once: on S3
// each is one GET.
const indexParallelism = 16

// BucketOptions are what the store asks of an s3 bucket. VERSIONING, because
// the worlds are the only copy of what a user made. A delete or an overwrite
// leaves the earlier version, and the identity may not delete a version
// (deploy/aws/storage.yaml), so neither a bug nor a stolen key can destroy
// a world for good. And CORS, because the browser follows the 302 of a zip
// or preview read to the bucket's origin (blob.ReadLinkCORS, the same rule
// as the artifacts bucket; since 2026-10-16, before that the server sent
// the bytes itself).
func BucketOptions() blob.OpenOptions {
	return blob.OpenOptions{Versioning: true, CORS: blob.ReadLinkCORS()}
}

// NewStore opens the store on `bucket` and builds the index, so a bucket
// that cannot be read fails at start. keepRevisions bounds how many
// revisions each world retains (0 = all).
func NewStore(ctx context.Context, bucket blob.Bucket, keepRevisions int) (*Store, error) {
	if bucket == nil {
		return nil, fmt.Errorf("world store needs a bucket")
	}
	if keepRevisions < 0 {
		return nil, fmt.Errorf("keep-revisions must be 0 (keep all) or positive, got %d", keepRevisions)
	}
	s := &Store{bucket: bucket, keepRevisions: keepRevisions, worlds: map[string]worldEntry{}, taken: map[string]int{}, locks: map[string]*worldLock{}, now: time.Now}
	if err := s.load(ctx); err != nil {
		return nil, fmt.Errorf("indexing the world store: %w", err)
	}
	return s, nil
}

// load builds the index from one List and a read of each world's documents.
// Keys that are not under a valid uid are ignored (a stray file, an editor's
// .DS_Store), as stray directories always were.
func (s *Store) load(ctx context.Context) error {
	started := time.Now()
	type found struct{ meta, grants bool }
	seen := map[string]*found{}
	taken := map[string]int{}
	for info, err := range s.bucket.List(ctx, "") {
		if err != nil {
			return err
		}
		uid, rest, ok := strings.Cut(info.Key, "/")
		if !ok || !ValidUID(uid) {
			continue
		}
		f := seen[uid]
		if f == nil {
			f = &found{}
			seen[uid] = f
		}
		switch rest {
		case metaName:
			f.meta = true
		case grantsName:
			f.grants = true
		}
		if n, ok := revisionOf(rest); ok {
			taken[uid] = max(taken[uid], n)
		}
	}
	// A uid without meta.json is not a world: an upload that ended before
	// its meta, or a delete that ended after it. Its objects stay (they cost
	// little and may be a user's only copy); claimRevision steps over their
	// revisions.
	var uids []string
	for uid, f := range seen {
		if f.meta {
			uids = append(uids, uid)
		}
	}
	entries := make([]worldEntry, len(uids))
	work := make(chan int)
	var wg sync.WaitGroup
	for range min(indexParallelism, len(uids)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range work {
				// Each goroutine writes only the entries it takes.
				entries[i] = s.readEntry(ctx, uids[i], seen[uids[i]].grants)
			}
		}()
	}
	for i := range uids {
		work <- i
	}
	close(work)
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return err
	}
	worlds := make(map[string]worldEntry, len(uids))
	for i, uid := range uids {
		worlds[uid] = entries[i]
	}
	s.mu.Lock()
	s.worlds, s.taken = worlds, taken
	s.mu.Unlock()
	slog.Info("world store indexed", "worlds", len(worlds), "took", time.Since(started).Round(time.Millisecond))
	return nil
}

// readEntry reads one world's documents from the bucket. A read that fails
// (other than a document that went in between) is recorded as the
// document's error, as a parse error is: the world then answers that error
// rather than look absent.
func (s *Store) readEntry(ctx context.Context, uid string, hasGrants bool) worldEntry {
	var e worldEntry
	raw, err := s.read(ctx, metaKey(uid), documentLimit)
	switch {
	case err != nil:
		e.metaErr = fmt.Errorf("world %s: reading its metadata: %w", uid, err)
	default:
		if err := json.Unmarshal(raw, &e.meta); err != nil {
			// A meta.json that will not parse is a corrupt entry, not a
			// missing one; saying so is what keeps a bug from looking like an
			// empty store.
			e.metaErr = fmt.Errorf("world %s has unreadable metadata: %w", uid, err)
		}
	}
	if !hasGrants {
		return e
	}
	raw, err = s.read(ctx, grantsKey(uid), documentLimit)
	switch {
	case errors.Is(err, blob.ErrNotFound):
	case err != nil:
		e.hasGrants, e.grantsErr = true, fmt.Errorf("world %s: reading its grants: %w", uid, err)
	default:
		e.hasGrants = true
		if err := json.Unmarshal(raw, &e.grants); err != nil {
			// Corrupt is NOT absent: absent means legacy rules, and a parse
			// error promoted to "no grants" would silently reopen a shared
			// world.
			e.grantsErr = fmt.Errorf("world %s has unreadable grants: %w", uid, err)
		}
	}
	return e
}

// read returns an object's bytes; limit > 0 refuses a larger object.
func (s *Store) read(ctx context.Context, key string, limit int64) ([]byte, error) {
	body, info, err := s.bucket.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	defer func() { _ = body.Close() }()
	if limit > 0 && info.Size > limit {
		return nil, fmt.Errorf("%s: %d bytes, more than %d", key, info.Size, limit)
	}
	return io.ReadAll(body)
}

// put writes one object, durably (blob.PutOptions.Sync). With ifAbsent it
// is a conditional write that fails with blob.ErrExists when the key is
// taken — on a backend that has one. On a backend without (blob.
// ErrUnsupported, the ceph row today) it is a plain write, and the world's
// lock alone keeps two writes apart: this process is the one writer.
func (s *Store) put(ctx context.Context, key string, data []byte, contentType string, ifAbsent bool) error {
	opts := blob.PutOptions{Sync: true, ContentType: contentType}
	if ifAbsent && !s.noConditional.Load() {
		opts.IfAbsent = true
		_, err := s.bucket.Put(ctx, key, bytes.NewReader(data), int64(len(data)), opts)
		if !errors.Is(err, blob.ErrUnsupported) {
			return err
		}
		if !s.noConditional.Swap(true) {
			slog.Info("world store: the bucket has no conditional write; create-only keys rely on the in-process lock")
		}
		opts.IfAbsent = false
	}
	_, err := s.bucket.Put(ctx, key, bytes.NewReader(data), int64(len(data)), opts)
	return err
}

// encodeJSON is a document's bytes as the store writes them.
func encodeJSON(value any) ([]byte, error) {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(raw, '\n'), nil
}

// putJSON writes a document. The overwritten ones (a world's meta.json after
// its creation, grants.json) are plain writes: with one writer the world's
// lock is enough. SEVERAL REPLICAS against one bucket would need each
// overwrite to be conditional on the ETag that was read (If-Match), or two
// writers could each replace the other's meta; that is not built — the
// leaf has no If-Match, and the store is one process.
func (s *Store) putJSON(ctx context.Context, key string, value any, ifAbsent bool) error {
	raw, err := encodeJSON(value)
	if err != nil {
		return err
	}
	return s.put(ctx, key, raw, "application/json", ifAbsent)
}

// worldLock is one world's mutex and the number of writers that hold it or
// wait on it.
type worldLock struct {
	mu   sync.Mutex
	refs int
}

// lock takes the world's mutex and answers the function that releases it.
func (s *Store) lock(uid string) (unlock func()) {
	s.locksMu.Lock()
	l := s.locks[uid]
	if l == nil {
		l = &worldLock{}
		s.locks[uid] = l
	}
	l.refs++
	s.locksMu.Unlock()
	l.mu.Lock()
	return func() {
		l.mu.Unlock()
		s.locksMu.Lock()
		l.refs--
		if l.refs == 0 {
			delete(s.locks, uid)
		}
		s.locksMu.Unlock()
	}
}

// writeTimeout bounds a write sequence that no longer ends with its
// request (detach). Long enough for a save of the upload limit (512 MiB)
// on a slow link to the bucket; a write that takes longer has a problem
// that waiting does not solve.
const writeTimeout = 10 * time.Minute

// detach is the context of a sequence of writes that must not stop
// half-way when its request ends (a closed browser tab, a client
// timeout): the request's values without its cancel, and writeTimeout.
// The store writes several objects for one change (a revision is a save,
// a preview, two metas), and a cancel between them leaves a revision that
// the meta does not name, or a world without its meta.
func detach(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), writeTimeout)
}

const (
	metaName    = "meta.json"
	grantsName  = "grants.json"
	zipName     = "world.zip"
	previewName = "preview.png"
)

func metaKey(uid string) string   { return uid + "/" + metaName }
func grantsKey(uid string) string { return uid + "/" + grantsName }

// revPrefix is the prefix of every key of one revision; the trailing "/"
// keeps revision 1 from matching revision 10.
func revPrefix(uid string, revision int) string {
	return uid + "/rev/" + strconv.Itoa(revision) + "/"
}
func revKey(uid string, revision int, name string) string { return revPrefix(uid, revision) + name }

// revisionOf reads the revision number of a key's rest after "{uid}/":
// "rev/{n}/…".
func revisionOf(rest string) (int, bool) {
	tail, ok := strings.CutPrefix(rest, "rev/")
	if !ok {
		return 0, false
	}
	number, _, ok := strings.Cut(tail, "/")
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(number)
	return n, err == nil && n > 0
}

// entry returns a world's index entry.
func (s *Store) entry(uid string) (worldEntry, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.worlds[uid]
	return e, ok
}

// update changes a world's index entry; called after the bucket accepted
// the write, under the world's lock.
func (s *Store) update(uid string, change func(e *worldEntry)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.worlds[uid]
	change(&e)
	s.worlds[uid] = e
}

// readGrants is the lockless half of ReadGrants, for callers already
// holding the world's lock. found=false is the LEGITIMATE legacy state — a
// world from before grants existed — not an error. grants.json is
// SERVER-owned, beside the meta: never part of the uploaded save, never
// rebuilt from one. Deleting the world removes it with everything else.
func (s *Store) readGrants(uid string) (access.Grants, bool, error) {
	e, ok := s.entry(uid)
	if !ok || !e.hasGrants {
		return access.Grants{}, false, nil
	}
	if e.grantsErr != nil {
		return access.Grants{}, false, e.grantsErr
	}
	return e.grants, true, nil
}

// ReadGrants answers a world's ACL. The world must exist; found reports
// whether a grants document does — see readGrants.
func (s *Store) ReadGrants(ctx context.Context, uid string) (access.Grants, bool, error) {
	if _, err := s.Get(ctx, uid); err != nil {
		return access.Grants{}, false, err
	}
	return s.readGrants(uid)
}

// WriteGrants replaces a world's ACL — the transfer/share path. Under the
// world's lock like Put, so a share and an upload cannot interleave their
// reads of the document.
//
// The template mark is NOT the share path's to change: whatever grants.Template
// says, the mark stays as it is stored. SetTemplate, the admin's, is its one
// writer — so a share API built on this cannot let an owner offer a world to
// every visitor of the server.
func (s *Store) WriteGrants(ctx context.Context, uid string, grants access.Grants) error {
	if grants.Owner == "" {
		return fmt.Errorf("grants must name an owner — a world with nobody at the top can never be shared or deleted again")
	}
	for id, role := range grants.Users {
		if _, err := access.ParseLevel(role); err != nil {
			return fmt.Errorf("grant for %s: %w", id, err)
		}
	}
	ctx, cancel := detach(ctx)
	defer cancel()
	defer s.lock(uid)()
	meta, err := s.readMeta(uid)
	if err != nil {
		return err
	}
	held, _, err := s.readGrants(uid)
	if err != nil {
		return err
	}
	grants.Template = held.Template
	if err := s.writeGrants(ctx, uid, grants); err != nil {
		return err
	}
	// Keep the display mirror honest immediately, not at the next upload.
	return s.mirrorGrants(ctx, uid, meta, grants)
}

// writeGrants stores a world's grants and enters them into the index.
// Under the world's lock, held by the caller.
func (s *Store) writeGrants(ctx context.Context, uid string, grants access.Grants) error {
	if err := s.putJSON(ctx, grantsKey(uid), grants, false); err != nil {
		return err
	}
	s.update(uid, func(e *worldEntry) { e.grants, e.hasGrants, e.grantsErr = grants, true, nil })
	return nil
}

// SetTemplate sets or removes a world's template mark — the admin's
// (access.ActionTemplate), and the mark's one writer. The world's CONTENT is
// not touched, so neither its revision nor its terrain id moves.
//
// A world without grants.json is refused with ErrNoGrants: the mark lives in
// the grants, and minting them here would decide the world's owner by the way.
func (s *Store) SetTemplate(ctx context.Context, uid string, on bool) (Meta, error) {
	if !ValidUID(uid) {
		return Meta{}, ErrNotFound
	}
	ctx, cancel := detach(ctx)
	defer cancel()
	defer s.lock(uid)()
	meta, err := s.readMeta(uid)
	if err != nil {
		return Meta{}, err
	}
	grants, found, err := s.readGrants(uid)
	if err != nil {
		return Meta{}, err
	}
	if !found {
		return Meta{}, ErrNoGrants
	}
	if grants.Template != on {
		grants.Template = on
		if err := s.writeGrants(ctx, uid, grants); err != nil {
			return Meta{}, err
		}
	}
	if err := s.mirrorGrants(ctx, uid, meta, grants); err != nil {
		return Meta{}, err
	}
	return s.readMeta(uid)
}

// mirrorGrants writes the owner and the template mark into the display
// mirror in meta.json where they differ from the grants. Under the world's
// lock, held by the caller.
func (s *Store) mirrorGrants(ctx context.Context, uid string, meta Meta, grants access.Grants) error {
	if meta.Owner == grants.Owner && meta.Template == grants.Template {
		return nil
	}
	meta.Owner = grants.Owner
	meta.Template = grants.Template
	return s.writeMeta(ctx, uid, meta, false)
}

// writeMeta stores a world's meta.json and enters it into the index. With
// create, the write is conditional (the world must not exist yet). Under
// the world's lock, held by the caller.
func (s *Store) writeMeta(ctx context.Context, uid string, meta Meta, create bool) error {
	if err := s.putJSON(ctx, metaKey(uid), meta, create); err != nil {
		return err
	}
	s.update(uid, func(e *worldEntry) { e.meta, e.metaErr = meta, nil })
	return nil
}

// ValidUID reports whether a uid may be used as a key segment.
func ValidUID(uid string) bool { return safeUID.MatchString(uid) }

// Get returns a world's metadata.
func (s *Store) Get(ctx context.Context, uid string) (Meta, error) {
	if !ValidUID(uid) {
		return Meta{}, ErrNotFound
	}
	return s.readMeta(uid)
}

func (s *Store) readMeta(uid string) (Meta, error) {
	e, ok := s.entry(uid)
	if !ok {
		return Meta{}, ErrNotFound
	}
	if e.metaErr != nil {
		return Meta{}, e.metaErr
	}
	return e.meta, nil
}

// List returns every world, newest first, from the index. An entry whose
// meta did not parse is SKIPPED rather than failing the whole listing: one
// broken world should not make the panel unusable.
func (s *Store) List(ctx context.Context) ([]Meta, error) {
	s.mu.RLock()
	metas := make([]Meta, 0, len(s.worlds))
	for _, e := range s.worlds {
		if e.metaErr == nil {
			metas = append(metas, e.meta)
		}
	}
	s.mu.RUnlock()
	sort.Slice(metas, func(i, j int) bool { return metas[i].UpdatedAt.After(metas[j].UpdatedAt) })
	return metas, nil
}

// Put stores a new revision of a world.
//
// `expected` is the revision the caller believes is current: 0 means "this
// must not exist yet". A mismatch is refused rather than reconciled, because
// the alternative — last writer wins — silently destroys the other machine's
// work, and a world is precisely the thing that cannot be recomputed.
func (s *Store) Put(ctx context.Context, uid string, data []byte, info SaveInfo, owner string, expected int) (Meta, error) {
	if !ValidUID(uid) {
		return Meta{}, fmt.Errorf("invalid world uid")
	}
	ctx, cancel := detach(ctx)
	defer cancel()
	defer s.lock(uid)()

	current, err := s.readMeta(uid)
	creating := false
	switch {
	case errors.Is(err, ErrNotFound):
		if expected != 0 {
			return Meta{}, ErrRevisionMismatch
		}
		creating = true
	case err != nil:
		return Meta{}, err
	default:
		if expected == 0 {
			return Meta{}, ErrExists
		}
		if expected != current.Revision {
			return Meta{}, ErrRevisionMismatch
		}
	}

	contentHash := hex.EncodeToString(func() []byte { h := sha256.Sum256(data); return h[:] }())

	// Dedupe: a byte-identical re-upload of the current revision changes
	// nothing and mints nothing — the caller gets the current state back, the
	// same answer a new revision would have encoded, minus the copy stored.
	// Compared only against the CURRENT revision (that is the one being
	// replaced); an older identical revision has been superseded in between,
	// so re-uploading it is a real change of current state.
	if current.Revision > 0 {
		if rev, err := s.readRevisionMeta(ctx, uid, current.Revision); err == nil && rev.ContentHash != "" && rev.ContentHash == contentHash {
			return current, nil
		}
	}

	// Payload first, metadata last — the same ordering the client's artifact
	// writer uses, and for the same reason: an interrupted upload must read as
	// ABSENT rather than as a complete entry pointing at half a file.
	revision, err := s.claimRevision(ctx, uid, current.Revision, creating, data)
	if err != nil {
		return Meta{}, err
	}
	// The rest of the revision is this upload's once the save is claimed:
	// plain writes, which also replace what an interrupted upload left.
	if len(info.Preview) > 0 {
		if err := s.put(ctx, revKey(uid, revision, previewName), info.Preview, "image/png", false); err != nil {
			return Meta{}, err
		}
	}

	now := s.now()
	revMeta := RevisionMeta{
		Revision:    revision,
		Size:        int64(len(data)),
		ErosionRun:  info.ErosionRun,
		HasPreview:  len(info.Preview) > 0,
		CreatedAt:   now,
		ContentHash: contentHash,
	}
	if err := s.putJSON(ctx, revKey(uid, revision, metaName), revMeta, false); err != nil {
		return Meta{}, err
	}

	// THE OWNER IS PINNED AT CREATION (2026-08-12, docs/decisions/
	// server-users.md and the access-control design): grants.json is written
	// once, when the world first exists, and ownership moves only through an
	// explicit transfer — never by writing a revision. Meta.Owner is a
	// DISPLAY MIRROR of it from here on; re-stamping it per upload was the
	// standing bug where a shared world's first editor save stole the world.
	displayOwner, template := current.Owner, false
	var created access.Grants
	if creating {
		// A plain write: grants.json without a meta.json is what an
		// interrupted creation leaves, and this one replaces it. The
		// world's meta.json below is the conditional write of a creation.
		created = access.Grants{Owner: owner}
		if err := s.putJSON(ctx, grantsKey(uid), created, false); err != nil {
			return Meta{}, err
		}
		displayOwner = owner
	} else if grants, found, grantsErr := s.readGrants(uid); grantsErr == nil && found {
		displayOwner, template = grants.Owner, grants.Template
	}
	// A world from before grants existed has neither: its meta keeps the
	// owner it already recorded (NOT the current caller), and no grants are
	// minted for it here — the migration rule for a checking server decides
	// that case deliberately, not a side effect of an upload.

	meta := Meta{
		UID:         uid,
		Name:        info.Name,
		Owner:       displayOwner,
		Revision:    revision,
		CreatedAt:   current.CreatedAt,
		UpdatedAt:   now,
		Size:        revMeta.Size,
		ErosionRun:  revMeta.ErosionRun,
		HasPreview:  revMeta.HasPreview,
		Seed:        info.Seed,
		Generator:   info.Generator,
		ContentHash: contentHash,
		Kind:        info.Kind,
		Progress:    info.Progress,
		Template:    template,
	}
	if meta.CreatedAt.IsZero() {
		meta.CreatedAt = now
	}
	// The world's own meta.json goes last of all: until it names the new
	// revision, the store still resolves to the previous one, so a crash
	// anywhere above leaves the old world intact rather than half-replaced.
	// At a creation it is conditional: another writer that created the world
	// in between makes this ErrExists, not an overwrite.
	raw, err := encodeJSON(meta)
	if err != nil {
		return Meta{}, err
	}
	if err := s.put(ctx, metaKey(uid), raw, "application/json", creating); err != nil {
		if err := s.settleMeta(ctx, uid, raw, creating, err); err != nil {
			return Meta{}, err
		}
	}
	s.update(uid, func(e *worldEntry) {
		e.meta, e.metaErr = meta, nil
		if creating {
			e.grants, e.hasGrants, e.grantsErr = created, true, nil
		}
	})
	// Retention, after the new revision is fully in force. Best-effort: a
	// prune that fails leaves extra safety copies, which is the harmless
	// direction, and must not fail an upload that already succeeded.
	s.pruneRevisions(ctx, uid, revision)
	return meta, nil
}

// settleMeta decides what a meta.json Put that answered `putErr` did. The
// object may be stored all the same: the answer was lost, the request was
// cut, or the SDK's retry of a conditional write met the object of its own
// first try (412, ErrExists). So the store reads meta.json back:
//
//   - the bytes are the ones it wrote: the write is done, nil;
//   - at a creation, another meta.json is there: the world exists, made by
//     another writer or by an earlier try whose answer was lost. The index
//     enters what the bucket holds (meta and grants), so Get, a retry and
//     an update all see that world; ErrExists (409);
//   - else putErr (ErrExists at a creation).
//
// Until 2026-10-16 an error here left the index without a world whose
// meta.json was stored: Get answered 404, a retry 409, an update 412, until
// a restart.
func (s *Store) settleMeta(ctx context.Context, uid string, ours []byte, creating bool, putErr error) error {
	held, readErr := s.read(ctx, metaKey(uid), documentLimit)
	switch {
	case readErr == nil && bytes.Equal(held, ours):
		slog.Warn("world store: the meta write answered an error, but the meta is stored", "uid", uid, "err", putErr)
		return nil
	case creating && readErr == nil:
		entry := s.readEntry(ctx, uid, true)
		if entry.metaErr == nil {
			s.mu.Lock()
			s.worlds[uid] = entry
			s.mu.Unlock()
		}
		return ErrExists
	case creating && errors.Is(putErr, blob.ErrExists):
		return ErrExists
	}
	return putErr
}

// claimRevision writes the save of the next free revision with a
// conditional write and answers the revision it took.
//
// The next free revision is one above the current one AND above every
// revision that has objects in the bucket (s.taken): an upload that ended
// before its meta.json (a crash, a lost connection to the bucket) leaves a
// revision the meta never named. Its number is stepped over — the meta
// names revisions, it does not count them, and a gap is something
// pruneRevisions expects — and the orphan goes with the next prunes. The
// index knows every such revision: those of a crash from the List at start,
// those of a failure in this process from here (the number is recorded
// once the save is claimed).
//
// So a save that exists at the chosen number was written by ANOTHER WRITER
// against the same bucket, outside the model: the answer is
// ErrRevisionMismatch (ErrExists at a creation), never an overwrite of the
// other writer's save. On a bucket without the conditional write (ceph) the
// save is a plain write, and the world's lock alone keeps two uploads apart.
//
// A claim that answers an error takes its number all the same: the save
// may be stored although the Put failed (a lost answer, a cut request, or
// the SDK's retry that meets its own first try and answers 412). Until
// 2026-10-16 the number stayed free, and every later update chose it again
// and answered 412 until a restart.
func (s *Store) claimRevision(ctx context.Context, uid string, current int, creating bool, data []byte) (int, error) {
	s.mu.RLock()
	revision := max(current, s.taken[uid]) + 1
	s.mu.RUnlock()
	if err := s.put(ctx, revKey(uid, revision, zipName), data, "application/zip", true); err != nil {
		s.mu.Lock()
		s.taken[uid] = max(s.taken[uid], revision)
		s.mu.Unlock()
		if errors.Is(err, blob.ErrExists) {
			slog.Warn("world store: another writer took the revision", "uid", uid, "revision", revision)
			if creating {
				return 0, ErrExists
			}
			return 0, ErrRevisionMismatch
		}
		return 0, err
	}
	s.mu.Lock()
	s.taken[uid] = max(s.taken[uid], revision)
	s.mu.Unlock()
	return revision, nil
}

func (s *Store) readRevisionMeta(ctx context.Context, uid string, revision int) (RevisionMeta, error) {
	raw, err := s.read(ctx, revKey(uid, revision, metaName), documentLimit)
	if err != nil {
		return RevisionMeta{}, err
	}
	var meta RevisionMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return RevisionMeta{}, err
	}
	return meta, nil
}

// pruneRevisions keeps the newest keepRevisions WHOLE revisions — those with
// a revision meta.json — and drops the rest that are older than the current
// one. 0 keeps all. An orphan (a save whose upload ended before its
// revision meta, claimRevision) uses up no slot and is dropped. The current
// revision is never dropped, and a revision above it is not touched (it is
// not this store's to judge). Lists the world's revisions rather than
// counting down from the current number, so a gap does not end the sweep
// early.
//
// Until 2026-10-16 the sweep counted numbers: orphans took slots, and the
// last good revision before the current one could go while an orphan
// stayed.
func (s *Store) pruneRevisions(ctx context.Context, uid string, current int) {
	if s.keepRevisions <= 0 {
		return
	}
	keys := map[int][]string{}
	whole := map[int]bool{}
	for info, err := range s.bucket.List(ctx, uid+"/rev/") {
		if err != nil {
			slog.Warn("world store: listing revisions to prune", "uid", uid, "err", err)
			return
		}
		rest := strings.TrimPrefix(info.Key, uid+"/")
		n, ok := revisionOf(rest)
		if !ok || n >= current {
			continue
		}
		keys[n] = append(keys[n], info.Key)
		if rest == "rev/"+strconv.Itoa(n)+"/"+metaName {
			whole[n] = true
		}
	}
	older := make([]int, 0, len(keys))
	for n := range keys {
		older = append(older, n)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(older)))
	kept := 1 // the current revision
	var doomed []string
	for _, n := range older {
		if whole[n] && kept < s.keepRevisions {
			kept++
			continue
		}
		doomed = append(doomed, keys[n]...)
	}
	_ = s.deleteKeys(ctx, uid, doomed)
}

// deleteKeys deletes the keys in order and answers the first error. A key
// that breaks the leaf's key rule (a file copied in by hand, e.g. Finder's
// .DS_Store in a Dir) cannot be deleted through the leaf; it is logged and
// left, so that one stray file does not fail the delete of a world (Delete
// removes it after, with the world's tree).
func (s *Store) deleteKeys(ctx context.Context, uid string, keys []string) error {
	var first error
	for _, key := range keys {
		err := s.bucket.Delete(ctx, key)
		switch {
		case err == nil:
		case errors.Is(err, blob.ErrBadKey):
			slog.Warn("world store: an object whose key the leaf refuses is not deleted by its key", "uid", uid, "key", key)
		case first == nil:
			first = err
		}
	}
	return first
}

// ReadCurrent returns the bytes of a world's current revision.
func (s *Store) ReadCurrent(ctx context.Context, uid string) ([]byte, Meta, error) {
	meta, err := s.Get(ctx, uid)
	if err != nil {
		return nil, Meta{}, err
	}
	raw, err := s.read(ctx, revKey(uid, meta.Revision, zipName), 0)
	if err != nil {
		if errors.Is(err, blob.ErrNotFound) {
			return nil, Meta{}, ErrNotFound
		}
		return nil, Meta{}, err
	}
	return raw, meta, nil
}

// localFiles is a bucket whose objects are files on this machine (blob.Dir).
type localFiles interface {
	LocalPath(key string) (string, error)
}

// LocalFiles reports whether CurrentZipPath can answer: the bucket is a
// directory on this machine. cmd/ asks it to choose how a local job worker
// reads its world.
func (s *Store) LocalFiles() bool {
	_, ok := s.bucket.(localFiles)
	return ok
}

// CurrentZipPath returns where the current revision's save lives, verifying
// that it exists. For a co-resident consumer (the bake runner) that streams
// the file itself instead of pulling tens of megabytes through this process —
// the path is handed out, the LAYOUT around it stays this store's business.
// Only on a bucket with LocalFiles; else an error.
func (s *Store) CurrentZipPath(ctx context.Context, uid string) (string, error) {
	files, ok := s.bucket.(localFiles)
	if !ok {
		return "", fmt.Errorf("the world store's bucket has no local files")
	}
	meta, err := s.Get(ctx, uid)
	if err != nil {
		return "", err
	}
	if meta.Revision < 1 {
		return "", ErrNotFound
	}
	path, err := files.LocalPath(revKey(uid, meta.Revision, zipName))
	if err != nil {
		return "", ErrNotFound
	}
	return path, nil
}

// ReadPreview returns the current revision's thumbnail.
func (s *Store) ReadPreview(ctx context.Context, uid string) ([]byte, error) {
	meta, err := s.Get(ctx, uid)
	if err != nil {
		return nil, err
	}
	if !meta.HasPreview {
		return nil, ErrNotFound
	}
	raw, err := s.read(ctx, revKey(uid, meta.Revision, previewName), 0)
	if err != nil {
		if errors.Is(err, blob.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return raw, nil
}

// ZipLink returns a link to read the current revision's save, with `ttl`
// to live, and the meta it was made from (its revision is the ETag of the
// 302). A presigned GET on s3, the module's own signed link on dir
// (blob.Dir.PresignGet). The right is the caller's to check first.
func (s *Store) ZipLink(ctx context.Context, uid string, ttl time.Duration) (blob.Link, Meta, error) {
	meta, err := s.Get(ctx, uid)
	if err != nil {
		return blob.Link{}, Meta{}, err
	}
	if meta.Revision < 1 {
		return blob.Link{}, Meta{}, ErrNotFound
	}
	link, err := s.bucket.PresignGet(ctx, revKey(uid, meta.Revision, zipName), ttl)
	if err != nil {
		return blob.Link{}, Meta{}, err
	}
	return link, meta, nil
}

// PreviewLink returns a link to read the current revision's thumbnail, as
// ZipLink. ErrNotFound when the revision has none.
func (s *Store) PreviewLink(ctx context.Context, uid string, ttl time.Duration) (blob.Link, error) {
	meta, err := s.Get(ctx, uid)
	if err != nil {
		return blob.Link{}, err
	}
	if !meta.HasPreview || meta.Revision < 1 {
		return blob.Link{}, ErrNotFound
	}
	return s.bucket.PresignGet(ctx, revKey(uid, meta.Revision, previewName), ttl)
}

// treeRemover is the dir backend's path for what stays under {uid}/ after
// its keys are deleted (blob.Dir.RemoveTree): the names the leaf refuses,
// an editor's .DS_Store, a temp file of an interrupted write. S3 has none,
// as only this server writes into its bucket, and every key it writes is
// valid.
type treeRemover interface {
	RemoveTree(ctx context.Context, name string) error
}

// Delete removes a world and every revision of it: every key under {uid}/,
// and on a directory also the names there that are not keys, with their
// directories (as the store did before the leaf).
// On a versioned bucket (s3, BucketOptions) each delete leaves a delete
// marker and the earlier versions, which the identity cannot remove: a
// deleted world can be restored by an operator.
func (s *Store) Delete(ctx context.Context, uid string) error {
	if !ValidUID(uid) {
		return ErrNotFound
	}
	ctx, cancel := detach(ctx)
	defer cancel()
	// The lock's entry goes when its last writer is done (lock), not here: a
	// writer waiting on it proceeds after us and finds the world gone, and a
	// writer arriving meanwhile waits on the same mutex.
	defer s.lock(uid)()

	if _, err := s.readMeta(uid); err != nil {
		return err
	}
	// meta.json goes FIRST here — the mirror of the write order. Removing it
	// makes the world absent immediately, so an interrupted delete leaves
	// orphaned revision objects rather than a world that still lists but has
	// no contents behind it.
	if err := s.bucket.Delete(ctx, metaKey(uid)); err != nil {
		return err
	}
	s.mu.Lock()
	delete(s.worlds, uid)
	s.mu.Unlock()
	var keys []string
	for info, err := range s.bucket.List(ctx, uid+"/") {
		if err != nil {
			return err
		}
		keys = append(keys, info.Key)
	}
	if err := s.deleteKeys(ctx, uid, keys); err != nil {
		// What is left keeps its revision numbers taken.
		return err
	}
	if tree, ok := s.bucket.(treeRemover); ok {
		// Under the world's lock, so no write of this world is in it.
		if err := tree.RemoveTree(ctx, uid); err != nil {
			return err
		}
	}
	s.mu.Lock()
	delete(s.taken, uid)
	s.mu.Unlock()
	return nil
}
