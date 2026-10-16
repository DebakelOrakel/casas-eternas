package artifacts

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/DebakelOrakel/casas-eternas/internal/blob"
)

// The artifact store — FLAT since 2026-08-12, on the blob leaf since
// 2026-10-16 (docs/decisions/object-storage.md, DEC-0038, step 3):
//
//	{artifactUid}/meta.json
//	{artifactUid}/<the stage's files, named by the client — world/artifacts.ts>
//	{artifactUid}/<one directory level of them, e.g. family-1/elevation.u16>
//
// These are object keys in a blob.Bucket: files under a directory (Dir, the
// same layout as before, so an existing ./data/artifacts opens as it is) or
// objects in a bucket (S3). One code path for both.
//
// The artifact uid is a minted uuid and means nothing; meta.json is the ONLY
// truth about what an entry is. The logical key — worldId, pipelineVersion,
// stage, the CONTENT only (docs/decisions/artifacts-by-content.md, DEC-0039)
// — lives inside it, and `resolve` maps key → uid
// through an index built from the metas. That is the robustness lesson the
// path-encoded layouts kept teaching: every schema change made walkers blind
// and left ghost bytes nothing could list. Here a schema change edits meta
// fields, a manually copied entry (any name the key rule allows) is indexed
// as soon as its meta is readable, and an entry with no readable meta is
// reported with its bytes rather than haunting the usage total.
//
// THE INDEX is built from one List of the bucket when the store opens (and
// a read of each meta.json), then kept in memory: this process is the one
// writer (one process per store, CLAUDE.md), so every change goes through
// it. Until 2026-10-16 the index was validated by directory mtime on each
// access, which let a baker write straight into the directory; S3 has no
// directory mtime, so the co-resident job worker writes over HTTP now, as
// a cluster worker always did (cmd/start.go). Since step 4 a worker writes
// its bytes straight to the bucket by a write link the store signed, and
// the index learns of them when the worker commits them (WriteLink,
// Commit); the store stays the one that decides what the index holds. A
// consequence: an entry that is copied into the directory by hand is seen
// after a restart, not on the next request.
//
// Everything else about this store keeps the artifact contract
// (docs/decisions/server-storage.md): idempotent writes (resolve hands the
// same uid to every writer of one key), no fsync (losing an entry costs a
// re-bake), droppable at any time.

// ErrNotFound is returned for an artifact that is not there.
var ErrNotFound = errors.New("artifact not found")

// ErrBadPath is returned for a name that cannot become an object key.
var ErrBadPath = errors.New("invalid artifact path")

// metaName is the file that makes an entry what it is.
const metaName = "meta.json"

// maxSegment bounds one path component. Every segment is machine-minted today
// (uuid, fixed file names); 128 is headroom, not a promise.
const maxSegment = 128

// safeSegment rejects a logical key's segment that is empty, too long or
// holds a separator or control character. The key segments live in
// meta.json, not in object keys, so this is about sanity, not about
// alphabet. Object keys (uid and file names) pass blob.CheckKey in
// addition (objectKey).
func safeSegment(segment string) bool {
	if segment == "" || len(segment) > maxSegment {
		return false
	}
	if segment == "." || segment == ".." {
		return false
	}
	if strings.ContainsAny(segment, `/\`) {
		return false
	}
	for _, r := range segment {
		if r == 0 || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// Key is the LOGICAL identity of one bake — what `resolve` translates into a
// storage uid. The uid never carries meaning; this does.
//
// The CONTENT only, since DEC-0039 (fork 1): the terrain (the client's
// worldId), the pipeline version and the stage determine the bytes, so one
// artifact serves every world with that terrain — a copy of a template and
// the template alike. The world's uid left the key; which worlds may read
// an artifact is the world module's answer (its terrain ids).
type Key struct {
	WorldID         string `json:"worldId"`
	PipelineVersion string `json:"pipelineVersion"`
	Stage           string `json:"stage"`
}

// Valid reports whether the key is filled. Segments are not path components
// anymore, so the only requirement is that they are present and sane.
func (k Key) Valid() bool {
	return safeSegment(k.WorldID) && safeSegment(k.PipelineVersion) && safeSegment(k.Stage)
}

func (k Key) String() string {
	return k.WorldID + "\x00" + k.PipelineVersion + "\x00" + k.Stage
}

// entryMeta is the slice of the client's meta.json the server reads — the key
// plus what a listing displays. Unknown fields pass through untouched in the
// stored object.
type entryMeta struct {
	Key    Key    `json:"key"`
	Label  string `json:"label"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	BakeMs int    `json:"bakeMs"`
	// Milliseconds since epoch, as the client writes it — the eviction
	// fallback when no in-memory access time exists (fresh restart).
	CreatedAt int64 `json:"createdAt"`
}

// entry is one artifact as the index knows it.
type entry struct {
	uid string
	// files maps each file name (the key below the uid) to its size.
	files map[string]int64
	// pending maps each file name that a write link was given for, and
	// that no commit has confirmed yet, to the link's length and expiry
	// (DEC-0038, fork 7). Its object may be in the bucket already; the
	// listing does not show it until the commit. Removal deletes it too, and
	// the sweep spares the entry while a link is valid. The signed length
	// counts against the cap from the link on (uncommitted), and after the
	// link expires too: an expired upload no longer spares its entry, but
	// its object may be there until the entry goes. In memory only, as the
	// reservation is.
	pending map[string]pendingFile
	// writes counts the writes into the entry that are in progress in this
	// process: a server PUT (Write) between its check and its record, a
	// Commit between its check and its record. The sweep spares the entry
	// while it is not 0 (sweepLocked).
	writes int
	bytes  int64
	meta   *entryMeta // nil: no readable meta.json (mid-write, or junk)
	// key remembers what a RESERVATION was minted for, before its meta.json
	// lands — it is what lets a write into a fresh artifact be ranked
	// against its terrain (the meta is exactly what has not been written yet).
	key *Key
	// modified is the newest write: the newest LastModified of its objects
	// when the index was built, then the time of each write. The eviction
	// grace and the last fallback of the recency read it.
	modified time.Time
	// Last time this process touched the entry (resolve hit, link, write).
	// IN-MEMORY ONLY, deliberately (DEC-0017, kept for S3 by DEC-0038):
	// S3 has no atime, and persisting access per read would mean a write
	// per read; losing recency across a restart costs at worst one re-fetch
	// of something the cache would have kept — cache stakes. After a
	// restart the order falls back to the meta's createdAt, then to
	// `modified`.
	lastAccess time.Time
}

// terrain answers the terrain an entry belongs to — the landed meta first,
// the reservation's key before that, "" for junk that has neither.
func (e *entry) terrain() string {
	if k := e.keyOf(); k != nil {
		return k.WorldID
	}
	return ""
}

// keyOf is the entry's key: its meta's, or the reservation's while it is
// written; nil for junk.
func (e *entry) keyOf() *Key {
	if e.meta != nil {
		return &e.meta.Key
	}
	return e.key
}

// pendingFile is one upload by link that no commit has confirmed: the
// signed length and the link's expiry.
type pendingFile struct {
	size    int64
	expires time.Time
}

// uncommitted is the bytes the entry's pending uploads may have put into
// the bucket beyond what the index counts: each signed length, less the
// size of a committed file of the same name. Called under s.mu.
func (e *entry) uncommitted() int64 {
	var n int64
	for name, p := range e.pending {
		n += max(0, p.size-e.files[name])
	}
	return n
}

func (e *entry) setFile(name string, size int64) {
	e.bytes += size - e.files[name]
	e.files[name] = size
}

// uploading reports whether a write link for the entry is still valid: a
// writer may be uploading to the bucket now.
func (e *entry) uploading(now time.Time) bool {
	for _, p := range e.pending {
		if now.Before(p.expires) {
			return true
		}
	}
	return false
}

// spared reports whether the sweep must not take the entry now, because a
// writer may still be writing it (sweepLocked has the rule). Called under
// s.mu.
func (e *entry) spared(now time.Time) bool {
	if e.writes > 0 || e.uploading(now) {
		return true // a write is in flight
	}
	if e.meta != nil {
		return false // whole: the writer is done
	}
	// No meta yet: a reservation or a write in progress until it has sat
	// untouched for the grace; junk after that.
	touched := e.modified
	if e.lastAccess.After(touched) {
		touched = e.lastAccess
	}
	return now.Sub(touched) < evictionGrace
}

// StageLevel reads a stage's level and whether it names a tile: `L<n>` a
// whole level, `L<n>:<x>,<y>` one tile of it (the client's world/levels.ts
// parseStage). ok is false for any other stage.
func StageLevel(stage string) (level int, tile bool, ok bool) {
	if !strings.HasPrefix(stage, "L") {
		return 0, false, false
	}
	head, _, tile := strings.Cut(stage[1:], ":")
	n, err := strconv.Atoi(head)
	if err != nil || n < 0 {
		return 0, false, false
	}
	return n, tile, true
}

// ListedArtifact is one entry of the listing — flat, the client groups.
type ListedArtifact struct {
	ArtifactUID string `json:"artifactUid"`
	Bytes       int64  `json:"bytes"`
	// Meta fields, flattened; zero values when the entry has no readable
	// meta.json and is only bytes with a name.
	WorldID         string `json:"worldId"`
	PipelineVersion string `json:"pipelineVersion"`
	Stage           string `json:"stage"`
	Label           string `json:"label"`
	Width           int    `json:"width"`
	Height          int    `json:"height"`
	BakeMs          int    `json:"bakeMs"`
}

// evictionGrace shields a meta-less entry from the sweep while it may simply
// be mid-write: its meta lands last, so an entry with no meta is only junk
// once nothing has touched it (a resolve, a write link, a write, a commit,
// or, after a restart, the newest object's LastModified) for well past the
// time between two writes of one artifact. The worker resolves with create
// right before it writes (world/meshArtifacts.ts), so the gaps are an
// upload's length, not a bake's.
const evictionGrace = time.Hour

// parallelism bounds the requests the store sends at the same time when it
// reads the metas at open and when it deletes many objects: on S3 each is
// a round trip, and one after the other is minutes for a large store.
const parallelism = 16

// Store is the artifact store on a blob.Bucket plus its in-memory index.
type Store struct {
	bucket blob.Bucket
	// Byte cap the sweep enforces after writes; 0 = unlimited.
	cap int64

	mu      sync.Mutex
	entries map[string]*entry // uid → entry
	byKey   map[string]string // Key.String() → uid
	// foreign holds the top-level names that load found shaped like a world
	// (worldShaped): not indexed, never junk, never deleted by a clear.
	foreign map[string]bool
	// now is the clock; tests move it.
	now func() time.Time
}

// NewStore opens the store on `bucket` and builds the index from one List
// and a read of each meta.json, so a bucket that cannot be read fails at
// start. capBytes bounds the store (0 = unlimited); the sweep runs after
// writes, which are the only operations that grow it.
func NewStore(ctx context.Context, bucket blob.Bucket, capBytes int64) (*Store, error) {
	if bucket == nil {
		return nil, fmt.Errorf("artifacts store needs a bucket")
	}
	if capBytes < 0 {
		return nil, fmt.Errorf("artifacts cap must be 0 (unlimited) or positive, got %d", capBytes)
	}
	s := &Store{bucket: bucket, cap: capBytes, entries: map[string]*entry{}, byKey: map[string]string{}, foreign: map[string]bool{}, now: time.Now}
	if err := s.load(ctx); err != nil {
		return nil, fmt.Errorf("indexing the artifact store: %w", err)
	}
	return s, nil
}

// load builds the index. Objects at the top level (no uid) are ignored, as
// stray files at the root of the directory always were.
func (s *Store) load(ctx context.Context) error {
	started := time.Now()
	for info, err := range s.bucket.List(ctx, "") {
		if err != nil {
			return err
		}
		uid, name, ok := strings.Cut(info.Key, "/")
		if !ok || uid == "" || name == "" {
			continue
		}
		e := s.entries[uid]
		if e == nil {
			e = &entry{uid: uid, files: map[string]int64{}}
			s.entries[uid] = e
		}
		e.setFile(name, info.Size)
		if info.LastModified.After(e.modified) {
			e.modified = info.LastModified
		}
	}
	for uid, e := range s.entries {
		if worldShaped(e.fileNames()) {
			s.foreignLocked(uid)
		}
	}
	// The metas, read in parallel: on S3 one GET each.
	var withMeta []*entry
	for _, e := range s.entries {
		if _, ok := e.files[metaName]; ok {
			withMeta = append(withMeta, e)
		}
	}
	work := make(chan int)
	errs := make([]error, len(withMeta))
	world := make([]bool, len(withMeta))
	var old atomic.Int64
	var wg sync.WaitGroup
	for range min(parallelism, len(withMeta)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range work {
				// Each goroutine writes only the entries it takes.
				e := withMeta[i]
				e.meta, world[i], errs[i] = s.loadMeta(ctx, e.uid, &old)
			}
		}()
	}
	for i := range withMeta {
		work <- i
	}
	close(work)
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := errors.Join(errs...); err != nil {
		// An artifact store that indexed an unreadable meta as junk would
		// evict a whole artifact on a flaky start; failing the start names
		// the object, and the next start reads it again.
		return err
	}
	kept := withMeta[:0]
	for i, e := range withMeta {
		if world[i] {
			s.foreignLocked(e.uid)
			continue
		}
		kept = append(kept, e)
	}
	withMeta = kept
	if n := old.Load(); n > 0 {
		slog.Warn("artifact store: entries in the format before DEC-0039 (a world uid in the key) are junk; clear the store once (DELETE /v1/artifacts as an admin)", "count", n)
	}
	if len(s.foreign) > 0 {
		slog.Warn("artifact store: entries shaped like worlds are not indexed and never deleted; is the world store in the same storage?", "count", len(s.foreign))
	}
	// In a fixed order, so that "first writer wins" on a duplicate key
	// does not depend on map order: the older entry keeps the key.
	sort.Slice(withMeta, func(i, j int) bool {
		if !withMeta[i].modified.Equal(withMeta[j].modified) {
			return withMeta[i].modified.Before(withMeta[j].modified)
		}
		return withMeta[i].uid < withMeta[j].uid
	})
	metas := 0
	for _, e := range withMeta {
		if e.meta != nil {
			s.claimKey(e)
			metas++
		}
	}
	slog.Info("artifact store indexed", "artifacts", len(s.entries), "metas", metas, "took", time.Since(started).Round(time.Millisecond))
	return nil
}

// foreignLocked takes a top-level name out of the index as a world's
// (worldShaped). Called under s.mu, or before the store is shared.
func (s *Store) foreignLocked(uid string) {
	s.foreign[uid] = true
	delete(s.entries, uid)
	s.dropKeys(uid)
}

// worldShaped reports whether an entry's file names are a world store's
// ({uid}/grants.json, {uid}/rev/{n}/…, internal/modules/world). DEFENCE IN
// DEPTH: cmd/ refuses a world store in the same storage as this one when
// both run in one process, but two processes can be configured so; and to
// this store a world is junk (its meta.json names no artifact key), which
// the sweep and a clear delete. So such an entry is never indexed, never
// junk and never deleted, and the start says so. The names are kept apart
// on the write side too (writableName).
func worldShaped(names []string) bool {
	for _, name := range names {
		if name == worldGrantsName || strings.HasPrefix(name, worldRevisionsPrefix) {
			return true
		}
	}
	return false
}

// The world store's names that no artifact file may have.
const (
	worldGrantsName      = "grants.json"
	worldRevisionsPrefix = "rev/"
)

// writableName refuses a file name that would make an artifact look like a
// world (worldShaped): such an entry would never be swept again.
func writableName(name string) error {
	if worldShaped([]string{name}) {
		return ErrBadPath
	}
	return nil
}

// readMeta reads and parses one entry's meta.json. A meta that does not
// parse or names no valid key is (nil, nil): the entry is then junk. A
// meta that is not there is (nil, blob.ErrNotFound); any other error of
// the bucket (a 503, a lost connection) is that error — it is NOT "no
// meta", which would turn a whole artifact into junk.
func (s *Store) readMeta(ctx context.Context, uid string) (*entryMeta, error) {
	raw, err := s.readMetaRaw(ctx, uid)
	if err != nil {
		return nil, err
	}
	return parseMeta(raw), nil
}

func (s *Store) readMetaRaw(ctx context.Context, uid string) ([]byte, error) {
	key, err := objectKey(uid, metaName)
	if err != nil {
		return nil, err
	}
	body, _, err := s.bucket.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	defer func() { _ = body.Close() }()
	return io.ReadAll(io.LimitReader(body, metaLimit))
}

// metaReadAttempts and metaRetryDelay are how load reads a meta.json that
// the bucket does not give at the first try: a few times, a little longer
// each time, then the start fails with the object's key. A variable so
// that a test need not wait.
const metaReadAttempts = 4

var metaRetryDelay = 250 * time.Millisecond

// loadMeta reads one entry's meta.json at start: the meta (nil: junk),
// whether it is a world's meta (worldMeta), or the error that stayed after
// metaReadAttempts. A meta that went between the List and the read is no
// meta, as for an entry without one. A meta of the format before DEC-0039
// counts into `old`.
func (s *Store) loadMeta(ctx context.Context, uid string, old *atomic.Int64) (*entryMeta, bool, error) {
	var last error
	for attempt := range metaReadAttempts {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, false, ctx.Err()
			case <-time.After(time.Duration(attempt) * metaRetryDelay):
			}
		}
		raw, err := s.readMetaRaw(ctx, uid)
		switch {
		case err == nil:
			if meta := parseMeta(raw); meta != nil {
				return meta, false, nil
			}
			if oldFormat(raw) {
				old.Add(1)
			}
			return nil, worldMeta(raw), nil
		case errors.Is(err, blob.ErrNotFound):
			return nil, false, nil
		}
		last = err
	}
	return nil, false, fmt.Errorf("reading %s/%s, %d tries: %w", uid, metaName, metaReadAttempts, last)
}

// worldMeta reports whether a meta.json that names no artifact key is a
// world's ({uid, revision}, internal/modules/world): see worldShaped.
func worldMeta(raw []byte) bool {
	var world struct {
		UID      string          `json:"uid"`
		Revision *int            `json:"revision"`
		Key      json.RawMessage `json:"key"`
	}
	return json.Unmarshal(raw, &world) == nil && world.UID != "" && world.Revision != nil && world.Key == nil
}

// metaLimit bounds the bytes read of one meta.json: a meta is a few hundred
// bytes; a larger file is not a meta this store can use.
const metaLimit = 1 << 20

// parseMeta reads a meta.json. A meta of the format before DEC-0039, whose
// key names a world uid, is no meta (nil): its entry is junk, which the
// cap's sweep takes first and a clear removes. Such an entry may come from
// a browser's upload, which the store no longer trusts (DEC-0039, forks 2
// and 7), so it is not read as content.
func parseMeta(raw []byte) *entryMeta {
	var meta entryMeta
	if json.Unmarshal(raw, &meta) != nil || !meta.Key.Valid() || oldFormat(raw) {
		return nil
	}
	return &meta
}

// oldFormat reports whether a meta.json's key names a world uid — the
// format before DEC-0039.
func oldFormat(raw []byte) bool {
	var old struct {
		Key struct {
			WorldUID string `json:"worldUid"`
		} `json:"key"`
	}
	return json.Unmarshal(raw, &old) == nil && old.Key.WorldUID != ""
}

// claimKey maps the entry's meta key to it. First writer wins on a
// duplicate key (two racing bakes of one key): both hold identical bytes,
// one of them resolves, the other stays listed and deletable. Called under
// s.mu (or before the store is shared).
func (s *Store) claimKey(e *entry) {
	if e.meta == nil {
		return
	}
	k := e.meta.Key.String()
	if owner, taken := s.byKey[k]; !taken || owner == e.uid {
		s.byKey[k] = e.uid
	}
}

// objectKey is the bucket key of one artifact file. `name` may contain
// slashes so a tile layout (`tiles/12_7`) needs no new route — every
// segment is checked, by safeSegment and by the leaf's key rule, which is
// what keeps that flexibility from becoming a traversal.
func objectKey(uid, name string) (string, error) {
	if !safeSegment(uid) {
		return "", ErrBadPath
	}
	segments := strings.Split(name, "/")
	if len(segments) == 0 || len(segments) > 4 {
		return "", ErrBadPath
	}
	for _, segment := range segments {
		if !safeSegment(segment) {
			return "", ErrBadPath
		}
	}
	key := uid + "/" + name
	if blob.CheckKey(key) != nil {
		return "", ErrBadPath
	}
	return key, nil
}

// mintUID returns a fresh uuid-shaped identifier.
func mintUID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40 // version 4
	raw[8] = (raw[8] & 0x3f) | 0x80 // RFC 4122 variant
	h := hex.EncodeToString(raw)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32], nil
}

// Resolve maps a logical key to its artifact uid. With create, a missing key
// mints a uid and reserves the mapping, so every concurrent writer of one
// key lands in the same place — the idempotency the path grammar used to
// provide by construction. The reservation is held in memory only: no
// object exists until the first write, so a writer that never writes
// leaves nothing behind.
//
// The returned names are the files currently present, which is the batch
// existence answer (`present` used to be its own endpoint).
func (s *Store) Resolve(ctx context.Context, key Key, create bool) (string, []string, error) {
	if !key.Valid() {
		return "", nil, ErrBadPath
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	uid, ok := s.byKey[key.String()]
	if !ok {
		if !create {
			return "", nil, ErrNotFound
		}
		minted, err := mintUID()
		if err != nil {
			return "", nil, err
		}
		k := key
		s.entries[minted] = &entry{uid: minted, files: map[string]int64{}, key: &k, modified: s.now()}
		s.byKey[key.String()] = minted
		uid = minted
	}
	e := s.entries[uid]
	e.lastAccess = s.now()
	return uid, e.fileNames(), nil
}

// Whole answers, per key, whether that artifact is in the store with its
// meta.json — the writer's last file, so a whole one. One lock for the lot:
// a refine plan asks for thousands of tiles at once (2026-10-04). A whole
// artifact counts as used now, once: under artifacts.cap, a tile found here
// hours before the tile that reads it may be evicted in between, and that
// read then fails its job. No cap is set on the cluster (2026-10-04).
func (s *Store) Whole(ctx context.Context, keys []Key) ([]bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	whole := make([]bool, len(keys))
	for i, key := range keys {
		uid, ok := s.byKey[key.String()]
		if !ok {
			continue
		}
		if e, ok := s.entries[uid]; ok && e.meta != nil {
			whole[i] = true
			e.lastAccess = s.now()
		}
	}
	return whole, nil
}

// TerrainOf answers which terrain an artifact belongs to — the checks'
// join key. From the meta when one has landed, from the reservation's key
// before that; false only for an entry that has neither (junk, or a
// hand-copied entry with no readable meta), which callers treat as
// admin-territory: fail closed, junk has no readers to serve.
func (s *Store) TerrainOf(ctx context.Context, uid string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[uid]
	if !ok {
		return "", false
	}
	terrain := e.terrain()
	return terrain, terrain != ""
}

// fileNames lists an entry's files, sorted. Called under s.mu.
func (e *entry) fileNames() []string {
	names := make([]string, 0, len(e.files))
	for name := range e.files {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Link returns a link that reads one artifact file without credentials
// until `ttl` has passed: a presigned GET on S3, the server's own signed
// link on Dir. The caller has checked the right; the link carries it from
// here (DEC-0038, fork 5). A file the index does not have is ErrNotFound,
// so a miss is answered here and not by the provider.
func (s *Store) Link(ctx context.Context, uid, name string, ttl time.Duration) (blob.Link, error) {
	key, err := objectKey(uid, name)
	if err != nil {
		return blob.Link{}, err
	}
	s.mu.Lock()
	e, ok := s.entries[uid]
	if ok {
		_, ok = e.files[name]
	}
	if ok {
		e.lastAccess = s.now()
	}
	s.mu.Unlock()
	if !ok {
		return blob.Link{}, ErrNotFound
	}
	return s.bucket.PresignGet(ctx, key, ttl)
}

// Write stores one artifact file into an EXISTING artifact — the uid comes
// from Resolve, which is what keeps junk from minting entries. Writing
// meta.json is what makes an entry resolvable. `size` is the body's exact
// length, or -1 when it is not known (a chunked upload): the body is then
// spooled to a temporary file first, because the leaf's Put needs the
// length (an S3 PUT sends it).
func (s *Store) Write(ctx context.Context, uid, name string, body io.Reader, size int64) error {
	key, err := objectKey(uid, name)
	if err != nil {
		return err
	}
	if err := writableName(name); err != nil {
		return err
	}
	var meta *entryMeta
	if name == metaName {
		// Small, and the index needs its content: read it whole.
		raw, err := readExactly(body, size, metaLimit)
		if err != nil {
			return err
		}
		meta = parseMeta(raw)
		body, size = bytes.NewReader(raw), int64(len(raw))
	}
	s.mu.Lock()
	e, ok := s.entries[uid]
	if ok {
		if err := e.checkKey(meta); err != nil {
			s.mu.Unlock()
			return err
		}
		e.writes++ // in flight: the sweep spares it until the record
	}
	s.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	inFlight := true
	defer func() {
		if inFlight {
			s.mu.Lock()
			e.writes--
			s.mu.Unlock()
		}
	}()

	if name != metaName && size < 0 {
		spool, n, err := spoolToFile(body)
		if err != nil {
			return err
		}
		defer func() {
			_ = spool.Close()
			_ = os.Remove(spool.Name())
		}()
		body, size = spool, n
	}

	info, err := s.bucket.Put(ctx, key, body, size, blob.PutOptions{ContentType: "application/octet-stream"})
	if err != nil {
		if errors.Is(err, blob.ErrBadKey) {
			return ErrBadPath
		}
		return err
	}

	s.mu.Lock()
	e.writes--
	inFlight = false
	if s.entries[uid] != e {
		// Removed while the bytes were on their way: the remover did not
		// know this object, so it goes now, or it would be an orphan the
		// index never lists.
		s.mu.Unlock()
		_ = s.bucket.Delete(context.WithoutCancel(ctx), key)
		return ErrNotFound
	}
	s.recordLocked(e, name, info.Size, meta)
	victims := s.sweepLocked(uid)
	s.mu.Unlock()
	// The cap is enforced HERE and only here: writes are the one operation
	// that grows the store, so the write path is the whole trigger — no
	// timer, no background sweeper.
	s.deleteObjects(context.WithoutCancel(ctx), victims)
	return nil
}

// ErrKeyMismatch: a meta.json names another key than the artifact's — the
// key its reservation was minted for, or its landed meta's. Accepting it
// would move the artifact to that key, and so to another world: a writer
// with the right to world A would file bytes under world B's key.
var ErrKeyMismatch = errors.New("the meta.json names another key than the artifact's")

// checkKey refuses a meta whose key is not the entry's (ErrKeyMismatch). A
// meta that does not parse (nil) and an entry with no key yet (junk, or a
// reservation lost at a restart: only the operator writes there) pass.
// Called under s.mu.
func (e *entry) checkKey(meta *entryMeta) error {
	if meta == nil {
		return nil
	}
	if k := e.keyOf(); k != nil && *k != meta.Key {
		return ErrKeyMismatch
	}
	return nil
}

// recordLocked enters one stored file into the index: its size, the time,
// and for meta.json its parsed content (nil: not a meta this store can
// use), which maps the entry's key. Called under s.mu.
func (s *Store) recordLocked(e *entry, name string, size int64, meta *entryMeta) {
	e.setFile(name, size)
	delete(e.pending, name)
	e.modified = s.now()
	e.lastAccess = s.now()
	if name != metaName {
		return
	}
	if previous := e.meta; previous != nil && s.byKey[previous.Key.String()] == e.uid && (meta == nil || previous.Key != meta.Key) {
		delete(s.byKey, previous.Key.String())
	}
	e.meta = meta
	if meta != nil {
		s.claimKey(e)
	}
}

// WRITES BY LINK (DEC-0038, fork 7). A writer that is not this server's
// request handler (a job worker) uploads straight to the bucket: it asks
// for a write link per file, with the file's length (WriteLink), PUTs the
// bytes to the link, and then tells the store what it wrote (Commit). The
// index learns of the files only at the commit, after a Head of each, so
// it holds only what is in the bucket with the size that was signed.
//
// The length is signed into the link: the provider (s3) or the module's
// own route (dir) refuses another length, so a link lets its holder write
// exactly one key with exactly that many bytes until it expires.

// ErrNotSigned: a commit names a file that no write link was given for.
var ErrNotSigned = errors.New("no write link was given for this artifact file")

// ErrNotUploaded: a committed file is not in the bucket, or has another
// size than the commit says.
var ErrNotUploaded = errors.New("artifact file is not in the bucket as committed")

// errBadSize: a write link for a negative length.
var errBadSize = errors.New("artifact file length is not valid")

// errCommitted: a write link, or an upload by one, for an artifact whose
// meta.json is committed. The artifact is whole: its writer is done, and
// a link given before the commit must not let its holder change it (on
// dir the module's route refuses such an upload; on s3 the provider takes
// it until the link expires — artifacts.write-link-ttl bounds that).
var errCommitted = errors.New("the artifact is whole; it takes no more uploads by link")

// errTooManyPending: an artifact has maxPendingFiles uploads by link that
// no commit confirmed.
var errTooManyPending = errors.New("too many uncommitted uploads for this artifact")

// errStoreFull: the uncommitted uploads of all artifacts with this one
// would pass artifacts.cap.
var errStoreFull = errors.New("the uncommitted uploads would pass the store's cap")

// maxPendingFiles bounds the uploads by link per artifact that no commit
// confirmed: a write link names one file, and a writer that never commits
// would else get links for files without end. An artifact has 6 (a tile)
// to 12 (a level) files today (client/src/world/meshArtifacts.ts,
// meshTileArtifacts.ts); 64 is headroom for new files and for a fresh
// link per file after a refusal, which takes no second place.
const maxPendingFiles = 64

// WriteLink returns a link that writes one file of an EXISTING artifact
// (the uid comes from Resolve) with exactly `size` bytes until `ttl` has
// passed: a presigned PUT on S3, the server's own signed link on Dir. The
// caller has checked the right. The file is recorded as pending, so that a
// removal deletes it and a commit may name it.
func (s *Store) WriteLink(ctx context.Context, uid, name string, size int64, ttl time.Duration) (blob.Link, error) {
	key, err := objectKey(uid, name)
	if err != nil {
		return blob.Link{}, err
	}
	switch {
	case size < 0:
		return blob.Link{}, fmt.Errorf("%w: %d", errBadSize, size)
	case size > UploadLimit, name == metaName && size > metaLimit:
		return blob.Link{}, fmt.Errorf("%w: %d bytes", errTooLarge, size)
	}
	if err := writableName(name); err != nil {
		return blob.Link{}, err
	}
	s.mu.Lock()
	e, ok := s.entries[uid]
	if ok {
		err = s.admitLocked(e, name, size)
	}
	s.mu.Unlock()
	if !ok {
		return blob.Link{}, ErrNotFound
	}
	if err != nil {
		return blob.Link{}, err
	}
	link, err := s.bucket.PresignPut(ctx, key, ttl, size)
	if err != nil {
		if errors.Is(err, blob.ErrBadKey) {
			return blob.Link{}, ErrBadPath
		}
		return blob.Link{}, err
	}
	s.mu.Lock()
	e, ok = s.entries[uid]
	if !ok {
		s.mu.Unlock()
		// Removed while the link was signed: a commit would find no entry.
		return blob.Link{}, ErrNotFound
	}
	// Again under the lock that records it: another link may have been
	// given meanwhile.
	if err := s.admitLocked(e, name, size); err != nil {
		s.mu.Unlock()
		return blob.Link{}, err
	}
	if e.pending == nil {
		e.pending = map[string]pendingFile{}
	}
	p := e.pending[name]
	p.size = max(p.size, size)
	if link.Expires.After(p.expires) {
		p.expires = link.Expires
	}
	e.pending[name] = p
	e.lastAccess = s.now()
	// A link grows the store as a write does: the cap's sweep runs here too.
	victims := s.sweepLocked(uid)
	s.mu.Unlock()
	s.deleteObjects(context.WithoutCancel(ctx), victims)
	return link, nil
}

// admitLocked decides whether the entry may get a write link for `name`
// of `size` bytes: not when it is whole (errCommitted), when it has
// maxPendingFiles other uploads that no commit confirmed
// (errTooManyPending), or when the uncommitted uploads of the whole store
// would pass the cap with this one (errStoreFull). The last rule is what
// keeps a holder of write rights from filling the bucket with uploads the
// index does not list: the sweep can evict only what is committed, and
// spares what is still uploading. Called under s.mu.
func (s *Store) admitLocked(e *entry, name string, size int64) error {
	if e.meta != nil {
		return errCommitted
	}
	held, again := e.pending[name]
	if !again && len(e.pending) >= maxPendingFiles {
		return fmt.Errorf("%w: %d", errTooManyPending, len(e.pending))
	}
	if s.cap <= 0 {
		return nil
	}
	var total int64
	for _, other := range s.entries {
		total += other.uncommitted()
	}
	add := max(0, size-max(held.size, e.files[name]))
	if total+add > s.cap {
		return fmt.Errorf("%w: %d + %d bytes > %d", errStoreFull, total, add, s.cap)
	}
	return nil
}

// AcceptUpload decides whether an upload by a dir write link (the
// module's own route, handleLinkPut) may be stored: the link verifies, so
// this is about the artifact. Not when the artifact is gone or unknown
// (ErrNotFound), when it is whole (errCommitted: a link given before the
// commit is no longer valid), when no link for the file is pending
// (ErrNotSigned: e.g. one given before a restart), or for a meta.json
// whose key is not the artifact's (ErrKeyMismatch; `meta` is its bytes,
// nil for another file). On s3 the provider takes the upload without
// asking; the commit's checks are what holds there.
func (s *Store) AcceptUpload(uid, name string, meta []byte) error {
	var parsed *entryMeta
	if name == metaName {
		parsed = parseMeta(meta)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[uid]
	switch {
	case !ok:
		return ErrNotFound
	case e.meta != nil:
		return errCommitted
	}
	if _, signed := e.pending[name]; !signed {
		return ErrNotSigned
	}
	return e.checkKey(parsed)
}

// Upload is one file a writer says it uploaded by link, with its length.
type Upload struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// Commit enters files that a writer uploaded by link into the index. Each
// must be a file a write link was given for (or one the entry has
// already); a Head checks that its object is in the bucket with the size
// the writer says. A meta.json is read back, as Write reads it, so the
// commit that holds it makes the entry whole and resolvable. Either every
// file is entered or none.
func (s *Store) Commit(ctx context.Context, uid string, files []Upload) error {
	if len(files) == 0 {
		return ErrBadPath
	}
	keys := make([]string, len(files))
	for i, f := range files {
		key, err := objectKey(uid, f.Name)
		if err != nil {
			return err
		}
		keys[i] = key
	}
	s.mu.Lock()
	e, ok := s.entries[uid]
	var unsigned string
	if ok {
		e.writes++ // in flight: the sweep spares it until the record
		for _, f := range files {
			_, signed := e.pending[f.Name]
			_, held := e.files[f.Name]
			if !signed && !held {
				unsigned = f.Name
				break
			}
		}
	}
	s.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	inFlight := true
	defer func() {
		if inFlight {
			s.mu.Lock()
			e.writes--
			s.mu.Unlock()
		}
	}()
	if unsigned != "" {
		return fmt.Errorf("%w: %q", ErrNotSigned, unsigned)
	}

	// The Heads, in parallel: on S3 each is a round trip.
	sizes := make([]int64, len(files))
	errs := make([]error, len(files))
	work := make(chan int)
	var wg sync.WaitGroup
	for range min(parallelism, len(files)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range work {
				info, err := s.bucket.Head(ctx, keys[i])
				sizes[i], errs[i] = info.Size, err
			}
		}()
	}
	for i := range files {
		work <- i
	}
	close(work)
	wg.Wait()
	var meta *entryMeta
	hasMeta := false
	for i, f := range files {
		switch {
		case errors.Is(errs[i], blob.ErrNotFound):
			return fmt.Errorf("%w: %q is not there", ErrNotUploaded, f.Name)
		case errs[i] != nil:
			return errs[i]
		case sizes[i] != f.Size:
			return fmt.Errorf("%w: %q has %d bytes, not %d", ErrNotUploaded, f.Name, sizes[i], f.Size)
		}
		if f.Name == metaName {
			hasMeta = true
		}
	}
	if hasMeta {
		var err error
		meta, err = s.readMeta(ctx, uid)
		switch {
		case errors.Is(err, blob.ErrNotFound):
			return fmt.Errorf("%w: %q is not there", ErrNotUploaded, metaName)
		case err != nil:
			// The bucket did not give it (a 503, a lost connection): the
			// commit fails as a whole, and its writer tries again. Taken as
			// "no meta" until 2026-10-16, it answered success for an
			// artifact that stayed meta-less.
			return fmt.Errorf("reading the committed %s: %w", metaName, err)
		}
	}

	s.mu.Lock()
	e.writes--
	inFlight = false
	if s.entries[uid] != e {
		// Removed while the writer uploaded: the remover deleted the pending
		// objects it knew; these go now, or they would be orphans.
		s.mu.Unlock()
		_ = s.deleteObjects(context.WithoutCancel(ctx), keys)
		return ErrNotFound
	}
	if err := e.checkKey(meta); err != nil {
		// Nothing is entered (all or none). The meta.json in the bucket goes:
		// a start would believe it (load has only the bucket). A whole entry
		// whose meta was replaced so (on s3 a link given before its commit
		// can still write) goes as a whole: its meta.json is not its own any
		// more, and it is recomputable.
		var doomed []string
		if e.meta != nil {
			doomed = s.dropLocked(uid)
		} else {
			doomed = []string{uid + "/" + metaName}
		}
		s.mu.Unlock()
		slog.Warn("artifact commit refused: its meta.json names another key", "artifact", uid)
		_ = s.deleteObjects(context.WithoutCancel(ctx), doomed)
		return err
	}
	for i, f := range files {
		if f.Name != metaName {
			s.recordLocked(e, f.Name, sizes[i], nil)
		}
	}
	// The meta last, as a writer writes it.
	for i, f := range files {
		if f.Name == metaName {
			s.recordLocked(e, f.Name, sizes[i], meta)
		}
	}
	var stale []string
	if e.meta != nil {
		// Whole: its write links are no longer valid (admitLocked,
		// AcceptUpload), and an upload that no commit named is junk.
		for name := range e.pending {
			if _, held := e.files[name]; !held {
				stale = append(stale, uid+"/"+name)
			}
		}
		e.pending = nil
	}
	victims := s.sweepLocked(uid)
	s.mu.Unlock()
	s.deleteObjects(context.WithoutCancel(ctx), append(stale, victims...))
	return nil
}

// readExactly reads a body of `size` bytes (-1: unknown) of at most `limit`.
func readExactly(body io.Reader, size, limit int64) ([]byte, error) {
	if size > limit {
		return nil, fmt.Errorf("%w: %d bytes", errTooLarge, size)
	}
	raw, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("%w: more than %d bytes", errTooLarge, limit)
	}
	if size >= 0 && int64(len(raw)) != size {
		return nil, fmt.Errorf("%w: %d of %d bytes", blob.ErrSize, len(raw), size)
	}
	return raw, nil
}

// errTooLarge: a meta.json larger than metaLimit.
var errTooLarge = errors.New("artifact file too large")

// spoolToFile copies a body of unknown length to a temporary file and
// rewinds it.
func spoolToFile(body io.Reader) (*os.File, int64, error) {
	f, err := os.CreateTemp("", "casas-artifact-*")
	if err != nil {
		return nil, 0, err
	}
	n, err := io.Copy(f, body)
	if err == nil {
		_, err = f.Seek(0, io.SeekStart)
	}
	if err != nil {
		_ = f.Close()
		_ = os.Remove(f.Name())
		return nil, 0, err
	}
	return f, n, nil
}

// sweepLocked picks whole artifacts to evict until the store fits its cap,
// never the one just written, and drops them from the index.
//
// NEVER AN ENTRY THAT IS STILL BEING WRITTEN (entry.spared): one with a
// write in flight in this process (a server PUT or a commit between its
// check and its record, or a write link that is still valid), whole or
// not; and one with no meta that something touched less than
// evictionGrace ago — a reservation from resolve with create, a write
// between two files. Until 2026-10-16 the grace covered only entries this
// process had never touched, so a reservation it had just minted was a
// candidate, and its writer's next PUT answered 404. A meta-less entry
// becomes junk when no write is in flight AND the grace has passed since
// it was last touched — the files a writer left under a reservation the
// server forgot at a restart, among them.
//
// Order among the rest: meta-less entries first (strays and abandoned
// writes — junk clears itself under pressure), then least recently used,
// with the meta's own createdAt (then the newest write) standing in for
// entries this process has not touched. Returns the object keys to delete,
// which the caller deletes after it has released s.mu. Called under s.mu.
func (s *Store) sweepLocked(justWritten string) []string {
	if s.cap <= 0 {
		return nil
	}
	total := s.capUsageLocked()
	if total <= s.cap {
		return nil
	}
	candidates := make([]*entry, 0, len(s.entries))
	now := s.now()
	for _, e := range s.entries {
		if e.uid == justWritten {
			continue
		}
		if e.spared(now) {
			continue // a writer may still be writing it
		}
		candidates = append(candidates, e)
	}
	recency := func(e *entry) time.Time {
		if !e.lastAccess.IsZero() {
			return e.lastAccess
		}
		if e.meta != nil && e.meta.CreatedAt > 0 {
			return time.UnixMilli(e.meta.CreatedAt)
		}
		return e.modified
	}
	sort.Slice(candidates, func(i, j int) bool {
		iStray := candidates[i].meta == nil
		jStray := candidates[j].meta == nil
		if iStray != jStray {
			return iStray
		}
		return recency(candidates[i]).Before(recency(candidates[j]))
	})
	var keys []string
	for _, victim := range candidates {
		if total <= s.cap {
			break
		}
		total -= victim.bytes + victim.uncommitted()
		keys = append(keys, s.dropLocked(victim.uid)...)
	}
	return keys
}

// capUsageLocked is what the cap is compared with: the indexed bytes and
// the uncommitted uploads by link (entry.uncommitted), which may be in the
// bucket although the listing does not show them. Called under s.mu.
func (s *Store) capUsageLocked() int64 {
	var total int64
	for _, e := range s.entries {
		total += e.bytes + e.uncommitted()
	}
	return total
}

func (s *Store) totalLocked() int64 {
	var total int64
	for _, e := range s.entries {
		total += e.bytes
	}
	return total
}

// dropLocked removes an entry from the index and returns its object keys.
// Called under s.mu.
func (s *Store) dropLocked(uid string) []string {
	e, ok := s.entries[uid]
	if !ok {
		return nil
	}
	keys := make([]string, 0, len(e.files)+len(e.pending))
	for name := range e.files {
		keys = append(keys, uid+"/"+name)
	}
	// Uploaded by link and not committed: in the bucket, perhaps, but not
	// in the index. Deleting an absent object is no error.
	for name := range e.pending {
		if _, held := e.files[name]; !held {
			keys = append(keys, uid+"/"+name)
		}
	}
	delete(s.entries, uid)
	s.dropKeys(uid)
	return keys
}

// junkRemover is the dir backend's narrow cleanup path (blob.Dir.RemoveJunk):
// it removes a top-level name that is not a valid key. S3 has none, as only
// this server writes into its bucket, and every key it writes is valid.
type junkRemover interface {
	RemoveJunk(ctx context.Context, name string) error
}

// deleteObjects deletes the objects of entries already dropped from the
// index, `parallelism` at a time and outside s.mu: on S3 a world's tiles
// are tens of thousands of round trips, and the lock must not wait for
// them. An object that does not go is logged; it is an orphan until the
// next start indexes it as junk.
//
// An entry whose uid breaks the key rule (a directory copied in by hand,
// e.g. "copy of x" or a non-ASCII name) cannot be deleted object by
// object; on a bucket that has the junk path, the whole top-level name is
// removed after the objects. Such an entry is always junk: its meta.json
// cannot be read either. A file with a bad name under a VALID uid stays
// (logged): the junk path is for top-level names only.
func (s *Store) deleteObjects(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	junk, canRemoveJunk := s.bucket.(junkRemover)
	var badUIDs []string
	if canRemoveJunk {
		seen := map[string]bool{}
		kept := keys[:0:0]
		for _, key := range keys {
			uid, _, _ := strings.Cut(key, "/")
			if blob.CheckKey(uid) != nil {
				if !seen[uid] {
					seen[uid] = true
					badUIDs = append(badUIDs, uid)
				}
				continue
			}
			kept = append(kept, key)
		}
		keys = kept
	}
	work := make(chan string)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var first error
	for _, uid := range badUIDs {
		if err := junk.RemoveJunk(ctx, uid); err != nil {
			slog.Warn("artifact junk not removed", "name", uid, "err", err)
			if first == nil {
				first = err
			}
			continue
		}
		slog.Info("artifact junk removed: its name breaks the key rule", "name", uid)
	}
	for range min(parallelism, len(keys)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for key := range work {
				err := s.bucket.Delete(ctx, key)
				if errors.Is(err, blob.ErrBadKey) {
					// A file the key rule refuses (copied in by hand, e.g.
					// a name with a space): the leaf cannot reach it, so it
					// stays. Not an error of the removal.
					slog.Warn("artifact object left: its name breaks the key rule", "key", key)
					continue
				}
				if err != nil {
					slog.Warn("artifact object not deleted", "key", key, "err", err)
					mu.Lock()
					if first == nil {
						first = err
					}
					mu.Unlock()
				}
			}
		}()
	}
	for _, key := range keys {
		work <- key
	}
	close(work)
	wg.Wait()
	return first
}

// List reports every entry, largest first — flat; grouping is the reader's
// business, and both tiers group the same way.
func (s *Store) List(ctx context.Context) ([]ListedArtifact, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]ListedArtifact, 0, len(s.entries))
	for _, e := range s.entries {
		if e.bytes == 0 && e.meta == nil {
			continue // a freshly minted, still-empty reservation
		}
		item := ListedArtifact{ArtifactUID: e.uid, Bytes: e.bytes}
		switch {
		case e.meta != nil:
			item.WorldID = e.meta.Key.WorldID
			item.PipelineVersion = e.meta.Key.PipelineVersion
			item.Stage = e.meta.Key.Stage
			item.Label = e.meta.Label
			item.Width = e.meta.Width
			item.Height = e.meta.Height
			item.BakeMs = e.meta.BakeMs
		case e.key != nil:
			// A reservation being written: identified by what it was minted
			// for, so the listing (and its visibility filter) can attribute
			// the bytes before the meta lands.
			item.WorldID = e.key.WorldID
			item.PipelineVersion = e.key.PipelineVersion
			item.Stage = e.key.Stage
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Bytes > out[j].Bytes })
	return out, nil
}

// dropKeys removes every key mapping that points at uid. A reverse sweep on
// purpose: removal must NOT depend on the entry's meta, because a
// reservation whose writer has not finished (exactly what eviction's
// junk-first pass deletes) has none. Hanging the cleanup on the meta leaked
// the mapping, and the key then resolved to a dropped uid whose PUTs
// answered 404 (found 2026-08-12 by TestRemovalByArtifactAndByWorld).
func (s *Store) dropKeys(uid string) {
	for key, owner := range s.byKey {
		if owner == uid {
			delete(s.byKey, key)
		}
	}
}

// RemoveArtifact drops one entry. Absent counts as removed.
func (s *Store) RemoveArtifact(ctx context.Context, uid string) error {
	if !safeSegment(uid) {
		return ErrBadPath
	}
	s.mu.Lock()
	keys := s.dropLocked(uid)
	s.mu.Unlock()
	return s.deleteObjects(ctx, keys)
}

// removeWhere drops every entry `match` accepts; false when none did.
func (s *Store) removeWhere(ctx context.Context, match func(*entry) bool) (int, error) {
	s.mu.Lock()
	var keys []string
	removed := 0
	for uid, e := range s.entries {
		if !match(e) {
			continue
		}
		keys = append(keys, s.dropLocked(uid)...)
		removed++
	}
	s.mu.Unlock()
	return removed, s.deleteObjects(ctx, keys)
}

// RemoveLevel drops one level of a terrain — the whole level and every
// tile of it — and, when `pipeline` is set, only that version's. Returns
// how many artifacts went.
func (s *Store) RemoveLevel(ctx context.Context, worldID string, level int, pipeline string) (int, error) {
	if !safeSegment(worldID) {
		return 0, ErrBadPath
	}
	removed, err := s.removeWhere(ctx, func(e *entry) bool {
		key := e.keyOf()
		if key == nil || key.WorldID != worldID || (pipeline != "" && key.PipelineVersion != pipeline) {
			return false
		}
		n, _, ok := StageLevel(key.Stage)
		return ok && n == level
	})
	if err != nil {
		return removed, err
	}
	if removed == 0 {
		return 0, ErrNotFound
	}
	return removed, nil
}

// RemoveTerrain drops every entry of one terrain — the unit of the sweep
// "delete a world, its artifacts go too", for each terrain that no other
// world holds (the module decides which). Returns how many went.
func (s *Store) RemoveTerrain(ctx context.Context, worldID string) (int, error) {
	if !safeSegment(worldID) {
		return 0, ErrBadPath
	}
	return s.removeWhere(ctx, func(e *entry) bool { return e.terrain() == worldID })
}

// Clear drops everything. Safe by construction — every byte in here is a
// deterministic function of a world and a pipeline version, so the worst case
// is that the next reader bakes again. It lists the bucket rather than
// trusting the index, so objects the index does not know (a top-level
// stray, a key the index could not hold) go too — except what is shaped
// like a world (worldShaped, foreign), which is not this store's.
//
// The List comes FIRST, then the index is reset, and only the listed keys
// are deleted. So an artifact that is written while the clear lists is
// either dropped with the rest (in the index before the reset) or not
// touched (a fresh uid after the reset, which no listed key has; a write
// into a dropped entry deletes its own object, Write and Commit). Until 2026-10-16 the reset came first, and an artifact
// written between the reset and the List was in the index with its
// objects deleted.
func (s *Store) Clear(ctx context.Context) error {
	names := map[string][]string{}
	var keys []string
	for info, err := range s.bucket.List(ctx, "") {
		if err != nil {
			return err
		}
		keys = append(keys, info.Key)
		uid, name, _ := strings.Cut(info.Key, "/")
		names[uid] = append(names[uid], name)
	}
	s.mu.Lock()
	s.entries = map[string]*entry{}
	s.byKey = map[string]string{}
	doomed := keys[:0:0]
	for _, key := range keys {
		uid, _, _ := strings.Cut(key, "/")
		if s.foreign[uid] || worldShaped(names[uid]) {
			continue
		}
		doomed = append(doomed, key)
	}
	s.mu.Unlock()
	return s.deleteObjects(ctx, doomed)
}

// Usage reports the total bytes held, for the storage panel's readout: the
// index's sum, which is the listing's sum by construction.
func (s *Store) Usage(ctx context.Context) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.totalLocked(), nil
}
