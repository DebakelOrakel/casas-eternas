package artifacts

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

// The artifact store on disk — FLAT since 2026-08-12:
//
//	{dir}/{artifactUid}/elevation.u16
//	                   /rivers-{density}.f32
//	                   /riverLengths-{density}.u32
//	                   /meta.json
//
// The artifact uid is a minted uuid and means nothing; meta.json is the ONLY
// truth about what an entry is. The logical key — worldUid, worldId,
// pipelineVersion, stage — lives inside it, and `resolve` maps key → uid
// through an index built from the metas. That is the robustness lesson the
// path-encoded layouts kept teaching: every schema change made walkers blind
// and left ghost bytes nothing could list. Here a schema change edits meta
// fields, a manually copied directory (any name) is indexed as soon as its
// meta is readable, and a directory with no readable meta is reported with
// its bytes rather than haunting the usage total.
//
// The index is validated by MTIME, not rebuilt per call and not only at
// startup: each access stats the root, re-reads only new or changed child
// directories (writing meta.json into one bumps its mtime), and drops the
// vanished. A baker writing straight into the directory, or a human copying
// an entry in, is visible on the next request — no restart, no watcher.
//
// Everything else about this store keeps the artifact contract
// (docs/decisions/server-storage.md): idempotent writes (resolve hands the
// same uid to every writer of one key), no fsync (losing an entry costs a
// re-bake), droppable at any time.

// ErrNotFound is returned for an artifact that is not there.
var ErrNotFound = errors.New("artifact not found")

// ErrBadPath is returned for a name that cannot become a filesystem path.
var ErrBadPath = errors.New("invalid artifact path")

// maxSegment bounds one path component. Every segment is machine-minted today
// (uuid, fixed file names); 128 is headroom, not a promise.
const maxSegment = 128

// safeSegment rejects anything that could escape the store or confuse a
// filesystem. Deliberately NOT an allow-list of ASCII: manually copied
// directories arrive with arbitrary names, and the rule is about SEPARATORS
// and control characters, not about alphabet.
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
// plus what a listing displays. Unknown fields pass through untouched on disk.
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

// entry is one artifact directory as the index knows it.
type entry struct {
	uid   string
	bytes int64
	meta  *entryMeta // nil: no readable meta.json (mid-write, or junk)
	mtime time.Time
	// Last time this process touched the entry (resolve hit, read, write).
	// IN-MEMORY ONLY, deliberately: persisting per-read access would mean a
	// write per read, and losing recency across a restart costs at worst one
	// re-fetch of something the cache would have kept — cache stakes.
	lastAccess time.Time
}

// ListedArtifact is one entry of the listing — flat, the client groups.
type ListedArtifact struct {
	ArtifactUID string `json:"artifactUid"`
	Bytes       int64  `json:"bytes"`
	// Meta fields, flattened; zero values when the entry has no readable
	// meta.json and is only bytes with a directory name.
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

// Store is the filesystem-backed artifact store plus its mtime-validated
// index.
type Store struct {
	dir string
	// Byte cap the sweep enforces after writes; 0 = unlimited.
	cap int64

	mu      sync.Mutex
	entries map[string]*entry // uid → entry
	byKey   map[string]string // Key.String() → uid
}

// NewStore prepares the store, creating the root if it is absent. The first
// refresh happens lazily on first use — startup does not pay for a large
// store it may never read. capBytes bounds the store (0 = unlimited); the
// sweep runs after writes, which are the only operations that grow it.
func NewStore(dir string, capBytes int64) (*Store, error) {
	if dir == "" {
		return nil, fmt.Errorf("artifacts directory must not be empty")
	}
	if capBytes < 0 {
		return nil, fmt.Errorf("artifacts cap must be 0 (unlimited) or positive, got %d", capBytes)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("preparing %q: %w", dir, err)
	}
	return &Store{dir: dir, cap: capBytes, entries: map[string]*entry{}, byKey: map[string]string{}}, nil
}

// The public methods take a context (2026-08-12) even though the dir backend
// cannot honour cancellation — file I/O has no ctx. The parameter is the seam
// the storage union's future backends (S3) need; handlers already pass their
// request's, so growing a cancellable backend changes no caller.

func (s *Store) artifactDir(uid string) string { return filepath.Join(s.dir, uid) }

// refresh reconciles the index with the directory. Called under s.mu.
//
// One ReadDir of the root, then a stat per child: a child whose mtime is
// unchanged keeps its index entry untouched; a new or changed one gets its
// meta.json re-read and its bytes re-walked. Writing any file into an
// artifact directory bumps that directory's mtime, so a bake completing (the
// meta lands last) or a hand-copied entry is picked up on the next call.
func (s *Store) refresh() error {
	children, err := os.ReadDir(s.dir)
	if err != nil {
		return err
	}
	seen := make(map[string]bool, len(children))
	for _, child := range children {
		if !child.IsDir() {
			continue // stray files at the root are ignored entirely
		}
		uid := child.Name()
		seen[uid] = true
		info, err := child.Info()
		if err != nil {
			continue
		}
		// An entry WITHOUT a meta is re-read unconditionally: it is the one
		// state a coarse filesystem timestamp could freeze (meta written in
		// the same tick the scan ran), it is rare, and retrying costs one
		// ReadFile against a file that is usually still absent.
		if known, ok := s.entries[uid]; ok && known.meta != nil && known.mtime.Equal(info.ModTime()) {
			continue
		}
		s.index(uid, info.ModTime())
	}
	for uid, known := range s.entries {
		if !seen[uid] {
			delete(s.entries, uid)
			if known.meta != nil && s.byKey[known.meta.Key.String()] == uid {
				delete(s.byKey, known.meta.Key.String())
			}
		}
	}
	return nil
}

// index (re)reads one artifact directory into the index. Called under s.mu.
func (s *Store) index(uid string, mtime time.Time) {
	previous := s.entries[uid]
	next := &entry{uid: uid, mtime: mtime, bytes: dirBytes(s.artifactDir(uid))}
	if previous != nil {
		next.lastAccess = previous.lastAccess
	}
	if raw, err := os.ReadFile(filepath.Join(s.artifactDir(uid), "meta.json")); err == nil {
		var meta entryMeta
		if json.Unmarshal(raw, &meta) == nil && meta.Key.Valid() {
			next.meta = &meta
		}
	}
	s.entries[uid] = next
	if previous != nil && previous.meta != nil && (next.meta == nil || previous.meta.Key != next.meta.Key) {
		if s.byKey[previous.meta.Key.String()] == uid {
			delete(s.byKey, previous.meta.Key.String())
		}
	}
	if next.meta != nil {
		// First writer wins on a duplicate key (two racing bakes of one key on
		// two machines): both directories hold identical bytes, one of them
		// resolves, the other stays listed and deletable.
		if _, taken := s.byKey[next.meta.Key.String()]; !taken || s.byKey[next.meta.Key.String()] == uid {
			s.byKey[next.meta.Key.String()] = uid
		}
	}
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
// mints a directory and reserves the mapping, so every concurrent writer of
// one key lands in the same place — the idempotency the path grammar used to
// provide by construction.
//
// The returned names are the files currently present, which is the batch
// existence answer (`present` used to be its own endpoint).
func (s *Store) Resolve(ctx context.Context, key Key, create bool) (string, []string, error) {
	if !key.Valid() {
		return "", nil, ErrBadPath
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.refresh(); err != nil {
		return "", nil, err
	}
	uid, ok := s.byKey[key.String()]
	if !ok {
		if !create {
			return "", nil, ErrNotFound
		}
		minted, err := mintUID()
		if err != nil {
			return "", nil, err
		}
		if err := os.MkdirAll(s.artifactDir(minted), 0o755); err != nil {
			return "", nil, err
		}
		// Reserved in the index before any meta exists, so a second resolve
		// of the same key reuses it. A crash before the meta lands leaves an
		// empty directory the listing reports as unresolved bytes.
		s.entries[minted] = &entry{uid: minted, mtime: time.Now()}
		s.byKey[key.String()] = minted
		uid = minted
	}
	if e, ok := s.entries[uid]; ok {
		e.lastAccess = time.Now()
	}
	return uid, s.fileNames(uid), nil
}

// touch records an access for the eviction sweep's recency ordering.
func (s *Store) touch(uid string) {
	s.mu.Lock()
	if e, ok := s.entries[uid]; ok {
		e.lastAccess = time.Now()
	}
	s.mu.Unlock()
}

// fileNames lists an artifact's files (top level plus one nested level, the
// shape tiles will use). Called under s.mu.
func (s *Store) fileNames(uid string) []string {
	names := []string{}
	root := s.artifactDir(uid)
	children, err := os.ReadDir(root)
	if err != nil {
		return names
	}
	for _, child := range children {
		if strings.HasPrefix(child.Name(), ".tmp-") {
			continue
		}
		if !child.IsDir() {
			names = append(names, child.Name())
			continue
		}
		nested, err := os.ReadDir(filepath.Join(root, child.Name()))
		if err != nil {
			continue
		}
		for _, inner := range nested {
			if !inner.IsDir() && !strings.HasPrefix(inner.Name(), ".tmp-") {
				names = append(names, child.Name()+"/"+inner.Name())
			}
		}
	}
	sort.Strings(names)
	return names
}

// filePath resolves one file inside an artifact. `name` may contain slashes
// so a future tile layout (`tiles/12_7`) needs no new route — every segment
// is checked, which is what keeps that flexibility from becoming a traversal.
func (s *Store) filePath(uid, name string) (string, error) {
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
	return filepath.Join(append([]string{s.artifactDir(uid)}, segments...)...), nil
}

// Read returns one artifact file.
func (s *Store) Read(ctx context.Context, uid, name string) ([]byte, error) {
	path, err := s.filePath(uid, name)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	s.touch(uid)
	return raw, nil
}

// Write stores one artifact file into an EXISTING artifact — the uid comes
// from Resolve, which is what keeps junk from minting entries. Writing
// meta.json is what makes an entry resolvable; the index picks it up through
// the directory's changed mtime on the next access.
func (s *Store) Write(ctx context.Context, uid, name string, body io.Reader) error {
	path, err := s.filePath(uid, name)
	if err != nil {
		return err
	}
	if _, err := os.Stat(s.artifactDir(uid)); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }() // no-op once the rename succeeded

	if _, err := io.Copy(tmp, body); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	// Rename without an fsync: atomic against a reader either way, and a power
	// cut costing one re-bake is cheaper than syncing every artifact write.
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	s.touch(uid)
	// The cap is enforced HERE and only here: writes are the one operation
	// that grows the store, so the write path is the whole trigger — no
	// timer, no background sweeper.
	s.enforceCap(uid)
	return nil
}

// enforceCap evicts whole artifacts until the store fits its cap, never the
// one just written. Order: meta-less entries past the grace first (strays and
// abandoned writes — junk clears itself under pressure), then least recently
// used, with the meta's own createdAt (then the directory mtime) standing in
// for entries this process has not touched.
func (s *Store) enforceCap(justWritten string) {
	if s.cap <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.refresh(); err != nil {
		return
	}
	var total int64
	for _, e := range s.entries {
		total += e.bytes
	}
	if total <= s.cap {
		return
	}
	candidates := make([]*entry, 0, len(s.entries))
	now := time.Now()
	for _, e := range s.entries {
		if e.uid == justWritten {
			continue
		}
		if e.meta == nil && e.lastAccess.IsZero() && now.Sub(e.mtime) < evictionGrace {
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
		return e.mtime
	}
	sort.Slice(candidates, func(i, j int) bool {
		iStray := candidates[i].meta == nil
		jStray := candidates[j].meta == nil
		if iStray != jStray {
			return iStray
		}
		return recency(candidates[i]).Before(recency(candidates[j]))
	})
	for _, victim := range candidates {
		if total <= s.cap {
			break
		}
		if err := os.RemoveAll(s.artifactDir(victim.uid)); err != nil {
			continue
		}
		total -= victim.bytes
		delete(s.entries, victim.uid)
		if victim.meta != nil && s.byKey[victim.meta.Key.String()] == victim.uid {
			delete(s.byKey, victim.meta.Key.String())
		}
	}
}

// List reports every entry, largest first — flat; grouping is the reader's
// business, and both tiers group the same way.
func (s *Store) List(ctx context.Context) ([]ListedArtifact, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.refresh(); err != nil {
		return nil, err
	}
	out := make([]ListedArtifact, 0, len(s.entries))
	for _, e := range s.entries {
		if e.bytes == 0 && e.meta == nil {
			continue // a freshly minted, still-empty directory
		}
		item := ListedArtifact{ArtifactUID: e.uid, Bytes: e.bytes}
		if e.meta != nil {
			item.WorldUID = e.meta.Key.WorldUID
			item.WorldID = e.meta.Key.WorldID
			item.PipelineVersion = e.meta.Key.PipelineVersion
			item.Stage = e.meta.Key.Stage
			item.Label = e.meta.Label
			item.Width = e.meta.Width
			item.Height = e.meta.Height
			item.BakeMs = e.meta.BakeMs
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Bytes > out[j].Bytes })
	return out, nil
}

// RemoveArtifact drops one entry. Absent counts as removed.
func (s *Store) RemoveArtifact(ctx context.Context, uid string) error {
	if !safeSegment(uid) {
		return ErrBadPath
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.RemoveAll(s.artifactDir(uid)); err != nil {
		return err
	}
	if e, ok := s.entries[uid]; ok {
		delete(s.entries, uid)
		if e.meta != nil && s.byKey[e.meta.Key.String()] == uid {
			delete(s.byKey, e.meta.Key.String())
		}
	}
	return nil
}

// RemoveWorld drops every entry whose meta names the world — the sweep
// "delete a world, its artifacts go too" works in this unit.
func (s *Store) RemoveWorld(ctx context.Context, worldUID string) error {
	if !safeSegment(worldUID) {
		return ErrBadPath
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.refresh(); err != nil {
		return err
	}
	found := false
	for uid, e := range s.entries {
		if e.meta == nil || e.meta.Key.WorldUID != worldUID {
			continue
		}
		found = true
		if err := os.RemoveAll(s.artifactDir(uid)); err != nil {
			return err
		}
		delete(s.entries, uid)
		delete(s.byKey, e.meta.Key.String())
	}
	if !found {
		return ErrNotFound
	}
	return nil
}

// Clear drops everything. Safe by construction — every byte in here is a
// deterministic function of a world and a pipeline version, so the worst case
// is that the next reader bakes again.
func (s *Store) Clear(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	children, err := os.ReadDir(s.dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	for _, child := range children {
		if err := os.RemoveAll(filepath.Join(s.dir, child.Name())); err != nil {
			return err
		}
	}
	s.entries = map[string]*entry{}
	s.byKey = map[string]string{}
	return nil
}

// Usage reports the total bytes held, for the storage panel's readout.
func (s *Store) Usage(ctx context.Context) (int64, error) {
	var total int64
	err := filepath.WalkDir(s.dir, func(_ string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil // an unreadable corner is not worth failing the whole figure
		}
		if entry.IsDir() {
			return nil
		}
		if info, err := entry.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total, err
}

// dirBytes totals every file under a directory. Unreadable corners are skipped
// rather than failing the figure — a listing that refuses to render because one
// entry is odd is worse than one that is slightly low.
func dirBytes(dir string) int64 {
	var total int64
	_ = filepath.WalkDir(dir, func(_ string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if info, err := entry.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}
