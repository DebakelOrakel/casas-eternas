package world

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"
)

// The world store on disk.
//
//	{dir}/{uid}/meta.json                 the world: name, owner, current revision
//	{dir}/{uid}/rev/{n}/world.zip         the save exactly as uploaded
//	{dir}/{uid}/rev/{n}/preview.png       extracted at upload
//	{dir}/{uid}/rev/{n}/meta.json         size, erosionRun, when
//
// Two properties this layout is chosen for. A world is a DIRECTORY, so
// dropping one is a single removal and inspecting the store needs no tooling.
// And revisions are separate directories rather than one overwritten file, so
// an upload never destroys the copy it replaces — which matters because this
// is the half of the system holding data that cannot be recomputed.
//
// Revisions are a SAFETY MARGIN, not a history feature (decided 2026-08-11):
// nothing serves an old revision over the API, so keeping every one forever
// was write-only storage. The store retains the newest `keepRevisions` and
// prunes older ones on upload; a byte-identical re-upload is deduplicated via
// the revision's content hash and mints no new revision at all.

// ErrNotFound is returned for a world (or revision) that is not there.
var ErrNotFound = errors.New("world not found")

// ErrRevisionMismatch is returned when the caller's expected revision is not
// the one on disk — someone else wrote in between. Deliberately distinct from
// a generic failure, because the handler must turn it into 412 rather than 500.
var ErrRevisionMismatch = errors.New("revision mismatch")

// ErrExists is returned when a create-only write finds a world already there.
var ErrExists = errors.New("world already exists")

// safeUID is what may become a directory name. Deliberately strict — the uid
// is a UUID from our own client, so anything else is either a bug or an
// attempt at path traversal, and there is no reason to be liberal about it.
var safeUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Meta is {dir}/{uid}/meta.json — the world itself.
type Meta struct {
	UID   string `json:"uid"`
	Name  string `json:"name"`
	Owner string `json:"owner"`
	// Revision of the CURRENT contents. Also the ETag, and what a caller
	// passes back in If-Match.
	Revision  int       `json:"revision"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	// Mirrored from the newest revision so a listing needs one file per
	// world rather than a walk into every revision directory.
	Size       int64 `json:"size"`
	ErosionRun int   `json:"erosionRun"`
	HasPreview bool  `json:"hasPreview"`
	// Display data mirrored the same way (2026-08-12, for the load/save
	// panels): the recipe's seed, the build that wrote the save, and the
	// current revision's content hash. Empty until a world is uploaded again.
	Seed        string `json:"seed"`
	Generator   string `json:"generator"`
	ContentHash string `json:"contentHash"`
}

// RevisionMeta is {dir}/{uid}/rev/{n}/meta.json.
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

// Store is the filesystem-backed world store.
type Store struct {
	dir string
	// How many revisions to retain per world; older ones are pruned on
	// upload. 0 keeps every revision (the pre-2026-08-11 behaviour).
	keepRevisions int
	// One mutex per world, so two uploads of the SAME world serialise while
	// uploads of different worlds do not. The revision check alone is not
	// enough: without this, two requests could both read revision 3 and both
	// decide they may write 4.
	//
	// In-process only. A second server process against one directory would
	// still race — out of scope while the deployment is one process, and the
	// reason to note it here rather than to discover it later.
	locks sync.Map // uid -> *sync.Mutex

	// now is injected so tests can be deterministic about timestamps.
	now func() time.Time
}

// NewStore prepares the store, creating the root if it is absent.
// keepRevisions bounds how many revisions each world retains (0 = all).
func NewStore(dir string, keepRevisions int) (*Store, error) {
	if dir == "" {
		return nil, fmt.Errorf("worlds directory must not be empty")
	}
	if keepRevisions < 0 {
		return nil, fmt.Errorf("keep-revisions must be 0 (keep all) or positive, got %d", keepRevisions)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("preparing %q: %w", dir, err)
	}
	return &Store{dir: dir, keepRevisions: keepRevisions, now: time.Now}, nil
}

func (s *Store) lock(uid string) *sync.Mutex {
	value, _ := s.locks.LoadOrStore(uid, &sync.Mutex{})
	return value.(*sync.Mutex)
}

func (s *Store) worldDir(uid string) string { return filepath.Join(s.dir, uid) }
func (s *Store) revDir(uid string, revision int) string {
	return filepath.Join(s.worldDir(uid), "rev", strconv.Itoa(revision))
}

// ValidUID reports whether a uid may be used as a path segment.
func ValidUID(uid string) bool { return safeUID.MatchString(uid) }

// Get returns a world's metadata.
func (s *Store) Get(uid string) (Meta, error) {
	if !ValidUID(uid) {
		return Meta{}, ErrNotFound
	}
	return s.readMeta(uid)
}

func (s *Store) readMeta(uid string) (Meta, error) {
	raw, err := os.ReadFile(filepath.Join(s.worldDir(uid), "meta.json"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Meta{}, ErrNotFound
		}
		return Meta{}, err
	}
	var meta Meta
	if err := json.Unmarshal(raw, &meta); err != nil {
		// A meta.json that will not parse is a corrupt entry, not a missing
		// one; saying so is what keeps a bug from looking like an empty store.
		return Meta{}, fmt.Errorf("world %s has unreadable metadata: %w", uid, err)
	}
	return meta, nil
}

// List returns every world, newest first.
//
// Reads one meta.json per world and never descends into the revisions — which
// is what keeps a listing cheap enough that no index is needed yet. An entry
// that will not parse is SKIPPED rather than failing the whole listing: one
// broken world should not make the panel unusable.
func (s *Store) List() ([]Meta, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	metas := make([]Meta, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !ValidUID(entry.Name()) {
			continue
		}
		meta, err := s.readMeta(entry.Name())
		if err != nil {
			continue
		}
		metas = append(metas, meta)
	}
	sort.Slice(metas, func(i, j int) bool { return metas[i].UpdatedAt.After(metas[j].UpdatedAt) })
	return metas, nil
}

// Put stores a new revision of a world.
//
// `expected` is the revision the caller believes is current: 0 means "this
// must not exist yet". A mismatch is refused rather than reconciled, because
// the alternative — last writer wins — silently destroys the other machine's
// work, and a world is precisely the thing that cannot be recomputed.
func (s *Store) Put(uid string, data []byte, info SaveInfo, owner string, expected int) (Meta, error) {
	if !ValidUID(uid) {
		return Meta{}, fmt.Errorf("invalid world uid")
	}
	mu := s.lock(uid)
	mu.Lock()
	defer mu.Unlock()

	current, err := s.readMeta(uid)
	switch {
	case errors.Is(err, ErrNotFound):
		if expected != 0 {
			return Meta{}, ErrRevisionMismatch
		}
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
	// same answer a new revision would have encoded, minus the copy on disk.
	// Compared only against the CURRENT revision (that is the one being
	// replaced); an older identical revision has been superseded in between,
	// so re-uploading it is a real change of current state.
	if current.Revision > 0 {
		if rev, err := s.readRevisionMeta(uid, current.Revision); err == nil && rev.ContentHash != "" && rev.ContentHash == contentHash {
			return current, nil
		}
	}

	revision := current.Revision + 1
	revDir := s.revDir(uid, revision)
	if err := os.MkdirAll(revDir, 0o755); err != nil {
		return Meta{}, err
	}

	// Payload first, metadata last — the same ordering the client's artifact
	// writer uses, and for the same reason: an interrupted upload must read as
	// ABSENT rather than as a complete entry pointing at half a file.
	if err := writeFileAtomic(filepath.Join(revDir, "world.zip"), data); err != nil {
		return Meta{}, err
	}
	if len(info.Preview) > 0 {
		if err := writeFileAtomic(filepath.Join(revDir, "preview.png"), info.Preview); err != nil {
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
	if err := writeJSONAtomic(filepath.Join(revDir, "meta.json"), revMeta); err != nil {
		return Meta{}, err
	}

	meta := Meta{
		UID:         uid,
		Name:        info.Name,
		Owner:       owner,
		Revision:    revision,
		CreatedAt:   current.CreatedAt,
		UpdatedAt:   now,
		Size:        revMeta.Size,
		ErosionRun:  revMeta.ErosionRun,
		HasPreview:  revMeta.HasPreview,
		Seed:        info.Seed,
		Generator:   info.Generator,
		ContentHash: contentHash,
	}
	if meta.CreatedAt.IsZero() {
		meta.CreatedAt = now
	}
	if meta.Owner == "" {
		meta.Owner = owner
	}
	// The world's own meta.json goes last of all: until it names the new
	// revision, the store still resolves to the previous one, so a crash
	// anywhere above leaves the old world intact rather than half-replaced.
	if err := writeJSONAtomic(filepath.Join(s.worldDir(uid), "meta.json"), meta); err != nil {
		return Meta{}, err
	}
	// Retention, after the new revision is fully in force. Best-effort: a
	// prune that fails leaves extra safety copies, which is the harmless
	// direction, and must not fail an upload that already succeeded.
	s.pruneRevisions(uid, revision)
	return meta, nil
}

func (s *Store) readRevisionMeta(uid string, revision int) (RevisionMeta, error) {
	raw, err := os.ReadFile(filepath.Join(s.revDir(uid, revision), "meta.json"))
	if err != nil {
		return RevisionMeta{}, err
	}
	var meta RevisionMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return RevisionMeta{}, err
	}
	return meta, nil
}

// pruneRevisions drops every revision older than the newest keepRevisions.
// 0 keeps all. Walks the rev directory rather than counting down from the
// current number, so a gap (a previously pruned or failed revision) does not
// end the sweep early.
func (s *Store) pruneRevisions(uid string, current int) {
	if s.keepRevisions <= 0 {
		return
	}
	oldest := current - s.keepRevisions + 1
	entries, err := os.ReadDir(filepath.Join(s.worldDir(uid), "rev"))
	if err != nil {
		return
	}
	for _, entry := range entries {
		n, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		if n < oldest {
			_ = os.RemoveAll(s.revDir(uid, n))
		}
	}
}

// ReadCurrent returns the bytes of a world's current revision.
func (s *Store) ReadCurrent(uid string) ([]byte, Meta, error) {
	meta, err := s.Get(uid)
	if err != nil {
		return nil, Meta{}, err
	}
	raw, err := os.ReadFile(filepath.Join(s.revDir(uid, meta.Revision), "world.zip"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, Meta{}, ErrNotFound
		}
		return nil, Meta{}, err
	}
	return raw, meta, nil
}

// CurrentZipPath returns where the current revision's save lives, verifying
// that it exists. For a co-resident consumer (the bake runner) that streams
// the file itself instead of pulling tens of megabytes through this process —
// the path is handed out, the LAYOUT around it stays this store's business.
func (s *Store) CurrentZipPath(uid string) (string, error) {
	meta, err := s.Get(uid)
	if err != nil {
		return "", err
	}
	if meta.Revision < 1 {
		return "", ErrNotFound
	}
	path := filepath.Join(s.revDir(uid, meta.Revision), "world.zip")
	if _, err := os.Stat(path); err != nil {
		return "", ErrNotFound
	}
	return path, nil
}

// ReadPreview returns the current revision's thumbnail.
func (s *Store) ReadPreview(uid string) ([]byte, error) {
	meta, err := s.Get(uid)
	if err != nil {
		return nil, err
	}
	if !meta.HasPreview {
		return nil, ErrNotFound
	}
	raw, err := os.ReadFile(filepath.Join(s.revDir(uid, meta.Revision), "preview.png"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return raw, nil
}

// Delete removes a world and every revision of it.
func (s *Store) Delete(uid string) error {
	if !ValidUID(uid) {
		return ErrNotFound
	}
	mu := s.lock(uid)
	mu.Lock()
	defer mu.Unlock()

	if _, err := s.readMeta(uid); err != nil {
		return err
	}
	// meta.json goes FIRST here — the mirror of the write order. Removing it
	// makes the world absent immediately, so an interrupted delete leaves
	// orphaned revision files rather than a world that still lists but has no
	// contents behind it.
	if err := os.Remove(filepath.Join(s.worldDir(uid), "meta.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.RemoveAll(s.worldDir(uid))
}

// writeFileAtomic writes via a temporary file in the SAME directory and
// renames it into place. Rename is atomic within one filesystem, so a reader
// sees either the old contents or the new ones and never a partial write —
// which a plain os.WriteFile cannot promise.
//
// The file is fsynced before the rename and the directory after it. That costs
// real milliseconds and is skipped for artifacts, where losing an entry costs
// a re-bake; here it is the difference between a power cut costing a save and
// costing nothing.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }() // no-op once the rename succeeded

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	return syncDir(dir)
}

func writeJSONAtomic(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(raw, '\n'))
}

// syncDir flushes the directory entry itself, so the rename survives a crash
// and not just the file's contents. Failures are tolerated because some
// filesystems refuse to sync a directory handle at all, and a store that
// cannot be written is a worse outcome than one that is slightly less durable.
func syncDir(dir string) error {
	handle, err := os.Open(dir)
	if err != nil {
		return nil
	}
	defer func() { _ = handle.Close() }()
	_ = handle.Sync()
	return nil
}
