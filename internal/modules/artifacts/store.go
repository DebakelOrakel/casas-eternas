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
// truth about what an entry is. The logical key — worldUid, worldId,
// pipelineVersion, stage — lives inside it, and `resolve` maps key → uid
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
// a cluster worker always did (cmd/start.go). A consequence: an entry that
// is copied into the directory by hand is seen after a restart, not on the
// next request.
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
type Key struct {
	WorldUID        string `json:"worldUid"`
	WorldID         string `json:"worldId"`
	PipelineVersion string `json:"pipelineVersion"`
	Stage           string `json:"stage"`
}

// Valid reports whether the key is filled. Segments are not path components
// anymore, so the only requirement is that they are present and sane.
func (k Key) Valid() bool {
	return safeSegment(k.WorldUID) && safeSegment(k.WorldID) && safeSegment(k.PipelineVersion) && safeSegment(k.Stage)
}

func (k Key) String() string {
	return k.WorldUID + "\x00" + k.WorldID + "\x00" + k.PipelineVersion + "\x00" + k.Stage
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
	bytes int64
	meta  *entryMeta // nil: no readable meta.json (mid-write, or junk)
	// key remembers what a RESERVATION was minted for, before its meta.json
	// lands — it is what lets a write into a fresh artifact be ranked
	// against its world (the meta is exactly what has not been written yet).
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

// world answers which world an entry belongs to — the landed meta first,
// the reservation's key before that, "" for junk that has neither.
func (e *entry) world() string {
	if k := e.keyOf(); k != nil {
		return k.WorldUID
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

func (e *entry) setFile(name string, size int64) {
	e.bytes += size - e.files[name]
	e.files[name] = size
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
	WorldUID        string `json:"worldUid"`
	WorldID         string `json:"worldId"`
	PipelineVersion string `json:"pipelineVersion"`
	Stage           string `json:"stage"`
	Label           string `json:"label"`
	Width           int    `json:"width"`
	Height          int    `json:"height"`
	BakeMs          int    `json:"bakeMs"`
}

// evictionGrace shields a meta-less entry from the sweep while it may simply
// be mid-write: a bake takes minutes and its meta lands last, so an entry
// with no meta AND no in-process access time is only junk once it has sat
// unclaimed well past any bake's duration.
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
	s := &Store{bucket: bucket, cap: capBytes, entries: map[string]*entry{}, byKey: map[string]string{}, now: time.Now}
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
	// The metas, read in parallel: on S3 one GET each.
	var withMeta []*entry
	for _, e := range s.entries {
		if _, ok := e.files[metaName]; ok {
			withMeta = append(withMeta, e)
		}
	}
	work := make(chan *entry)
	var wg sync.WaitGroup
	for range min(parallelism, len(withMeta)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for e := range work {
				// Each goroutine writes only the entries it takes.
				e.meta = s.readMeta(ctx, e.uid)
			}
		}()
	}
	for _, e := range withMeta {
		work <- e
	}
	close(work)
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return err
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

// readMeta reads and parses one entry's meta.json; nil when it is missing,
// unreadable or names no valid key (the entry is then junk).
func (s *Store) readMeta(ctx context.Context, uid string) *entryMeta {
	key, err := objectKey(uid, metaName)
	if err != nil {
		return nil
	}
	body, _, err := s.bucket.Get(ctx, key)
	if err != nil {
		return nil
	}
	defer func() { _ = body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(body, metaLimit))
	if err != nil {
		return nil
	}
	return parseMeta(raw)
}

// metaLimit bounds the bytes read of one meta.json: a meta is a few hundred
// bytes; a larger file is not a meta this store can use.
const metaLimit = 1 << 20

func parseMeta(raw []byte) *entryMeta {
	var meta entryMeta
	if json.Unmarshal(raw, &meta) != nil || !meta.Key.Valid() {
		return nil
	}
	return &meta
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

// WorldOf answers which world an artifact belongs to — the checks' join
// key. From the meta when one has landed, from the reservation's key before
// that; false only for an entry that has neither (junk, or a hand-copied
// entry with no readable meta), which callers treat as admin-territory:
// fail closed, junk has no readers to serve.
func (s *Store) WorldOf(ctx context.Context, uid string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[uid]
	if !ok {
		return "", false
	}
	world := e.world()
	return world, world != ""
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
	s.mu.Lock()
	_, ok := s.entries[uid]
	s.mu.Unlock()
	if !ok {
		return ErrNotFound
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
	} else if size < 0 {
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
	e, ok := s.entries[uid]
	if !ok {
		// Removed while the bytes were on their way: the remover did not
		// know this object, so it goes now, or it would be an orphan the
		// index never lists.
		s.mu.Unlock()
		_ = s.bucket.Delete(context.WithoutCancel(ctx), key)
		return ErrNotFound
	}
	e.setFile(name, info.Size)
	e.modified = s.now()
	e.lastAccess = s.now()
	if name == metaName {
		if previous := e.meta; previous != nil && s.byKey[previous.Key.String()] == uid && (meta == nil || previous.Key != meta.Key) {
			delete(s.byKey, previous.Key.String())
		}
		e.meta = meta
		if meta != nil {
			s.claimKey(e)
		}
	}
	victims := s.sweepLocked(uid)
	s.mu.Unlock()
	// The cap is enforced HERE and only here: writes are the one operation
	// that grows the store, so the write path is the whole trigger — no
	// timer, no background sweeper.
	s.deleteObjects(context.WithoutCancel(ctx), victims)
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
// never the one just written, and drops them from the index. Order:
// meta-less entries past the grace first (strays and abandoned writes —
// junk clears itself under pressure), then least recently used, with the
// meta's own createdAt (then the newest write) standing in for entries this
// process has not touched. Returns the object keys to delete, which the
// caller deletes after it has released s.mu. Called under s.mu.
func (s *Store) sweepLocked(justWritten string) []string {
	if s.cap <= 0 {
		return nil
	}
	total := s.totalLocked()
	if total <= s.cap {
		return nil
	}
	candidates := make([]*entry, 0, len(s.entries))
	now := s.now()
	for _, e := range s.entries {
		if e.uid == justWritten {
			continue
		}
		if e.meta == nil && e.lastAccess.IsZero() && now.Sub(e.modified) < evictionGrace {
			continue // possibly another writer mid-bake — spared until stale
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
		total -= victim.bytes
		keys = append(keys, s.dropLocked(victim.uid)...)
	}
	return keys
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
	keys := make([]string, 0, len(e.files))
	for name := range e.files {
		keys = append(keys, uid+"/"+name)
	}
	delete(s.entries, uid)
	s.dropKeys(uid)
	return keys
}

// deleteObjects deletes the objects of entries already dropped from the
// index, `parallelism` at a time and outside s.mu: on S3 a world's tiles
// are tens of thousands of round trips, and the lock must not wait for
// them. An object that does not go is logged; it is an orphan until the
// next start indexes it as junk.
func (s *Store) deleteObjects(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	work := make(chan string)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var first error
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
			item.WorldUID = e.meta.Key.WorldUID
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
			item.WorldUID = e.key.WorldUID
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

// RemoveLevel drops one level of a world — the whole level and every tile
// of it — and, when `worldID` or `pipeline` is set, only that terrain's or
// that version's. Returns how many artifacts went.
func (s *Store) RemoveLevel(ctx context.Context, worldUID string, level int, worldID, pipeline string) (int, error) {
	if !safeSegment(worldUID) {
		return 0, ErrBadPath
	}
	removed, err := s.removeWhere(ctx, func(e *entry) bool {
		key := e.keyOf()
		if key == nil || key.WorldUID != worldUID || (worldID != "" && key.WorldID != worldID) || (pipeline != "" && key.PipelineVersion != pipeline) {
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

// RemoveWorld drops every entry whose meta names the world — the sweep
// "delete a world, its artifacts go too" works in this unit.
func (s *Store) RemoveWorld(ctx context.Context, worldUID string) error {
	if !safeSegment(worldUID) {
		return ErrBadPath
	}
	removed, err := s.removeWhere(ctx, func(e *entry) bool { return e.world() == worldUID })
	if err != nil {
		return err
	}
	if removed == 0 {
		return ErrNotFound
	}
	return nil
}

// Clear drops everything. Safe by construction — every byte in here is a
// deterministic function of a world and a pipeline version, so the worst case
// is that the next reader bakes again. It lists the bucket rather than
// trusting the index, so objects the index does not know (a top-level
// stray, a key the index could not hold) go too.
func (s *Store) Clear(ctx context.Context) error {
	s.mu.Lock()
	s.entries = map[string]*entry{}
	s.byKey = map[string]string{}
	s.mu.Unlock()
	var keys []string
	for info, err := range s.bucket.List(ctx, "") {
		if err != nil {
			return err
		}
		keys = append(keys, info.Key)
	}
	return s.deleteObjects(ctx, keys)
}

// Usage reports the total bytes held, for the storage panel's readout: the
// index's sum, which is the listing's sum by construction.
func (s *Store) Usage(ctx context.Context) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.totalLocked(), nil
}
