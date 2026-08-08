package artifacts

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

// The artifact store on disk, mirroring the client's own path grammar
// (client/src/storage/ArtifactStore.ts) one level below the root:
//
//	{dir}/{worldId}/{pipelineVersion}/{stage}/elevation.u16
//	                                         /rivers.f32
//	                                         /riverLengths.u32
//	                                         /meta.json
//
// Deliberately NOT under the same root as the world store, even though the
// client's local paths begin `worlds/`: there, `worldId` is a CONTENT HASH,
// while a world is addressed by its stable uid. Sharing a prefix would imply a
// relationship that does not exist — an artifact's worldId can belong to a
// world that was never uploaded at all.
//
// Everything about this store is the opposite of internal/world, and each
// difference is deliberate (docs/decisions/server-storage.md):
//
//   - writes are IDEMPOTENT, so two clients racing to upload the same bake
//     both succeed and no locking is needed. That is what content addressing
//     buys: the key IS the description of the bytes.
//   - no fsync. Losing an entry to a power cut costs a re-bake, and paying
//     milliseconds on every write to avoid that is the wrong trade — exactly
//     the opposite conclusion from the world store, where a loss is permanent.
//   - entries are droppable at any time, which is why a size cap belongs here
//     and nowhere else.

// ErrNotFound is returned for an artifact that is not there.
var ErrNotFound = errors.New("artifact not found")

// ErrBadPath is returned for a key that cannot become a filesystem path.
var ErrBadPath = errors.New("invalid artifact path")

// maxSegment bounds one path component. The client's world ids carry a
// human-readable seed label, which it sanitises but does not shorten beyond 24
// characters plus a 16-character hash; 128 leaves room without inviting a
// filename no filesystem will take.
const maxSegment = 128

// safeSegment rejects anything that could escape the store or confuse a
// filesystem. Deliberately NOT an allow-list of ASCII: the client's label
// sanitiser keeps accents on purpose ("Ätna" must not become "tna"), so the
// rule is about SEPARATORS and control characters, not about alphabet.
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

// Key addresses one stage of one bake.
type Key struct {
	WorldID         string
	PipelineVersion string
	Stage           string
}

// Valid reports whether every component may become a path segment.
func (k Key) Valid() bool {
	return safeSegment(k.WorldID) && safeSegment(k.PipelineVersion) && safeSegment(k.Stage)
}

// StageInfo is what a listing reports about one baked stage.
type StageInfo struct {
	PipelineVersion string `json:"pipelineVersion"`
	Stage           string `json:"stage"`
	Bytes           int64  `json:"bytes"`
	// Read out of the stage's own meta.json, which the client writes. Zero
	// when it is absent or unreadable — an incomplete entry still counts
	// toward size, because it still occupies the disk.
	Width  int `json:"width"`
	Height int `json:"height"`
	BakeMs int `json:"bakeMs"`
}

// WorldArtifacts groups every stage baked for one world id.
type WorldArtifacts struct {
	WorldID string      `json:"worldId"`
	Bytes   int64       `json:"bytes"`
	Stages  []StageInfo `json:"stages"`
}

// Store is the filesystem-backed artifact store.
type Store struct {
	dir string
}

// NewStore prepares the store, creating the root if it is absent.
func NewStore(dir string) (*Store, error) {
	if dir == "" {
		return nil, fmt.Errorf("artifacts directory must not be empty")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("preparing %q: %w", dir, err)
	}
	return &Store{dir: dir}, nil
}

func (s *Store) stageDir(key Key) string {
	return filepath.Join(s.dir, key.WorldID, key.PipelineVersion, key.Stage)
}

// filePath resolves one file inside a stage. `name` may contain slashes so a
// future tile layout (`tiles/12_7`) needs no new route — every segment is
// checked, which is what keeps that flexibility from becoming a traversal.
func (s *Store) filePath(key Key, name string) (string, error) {
	if !key.Valid() {
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
	return filepath.Join(append([]string{s.stageDir(key)}, segments...)...), nil
}

// Read returns one artifact file.
func (s *Store) Read(key Key, name string) ([]byte, error) {
	path, err := s.filePath(key, name)
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
	return raw, nil
}

// Write stores one artifact file, replacing any previous copy.
//
// No locking and no conflict check: the key describes the bytes, so a repeated
// write is a no-op by construction and two clients uploading the same bake
// cannot disagree. That is precisely why the world store needs an optimistic
// lock and this one does not.
func (s *Store) Write(key Key, name string, body io.Reader) error {
	path, err := s.filePath(key, name)
	if err != nil {
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
	return os.Rename(tmpName, path)
}

// Present reports which of `names` exist for a key, in the order asked.
//
// The one addition plain REST needs here: at 8192² with tiled artifacts there
// are over a hundred files per stage, and discovering which are missing must
// not cost a hundred round trips.
func (s *Store) Present(key Key, names []string) ([]string, error) {
	if !key.Valid() {
		return nil, ErrBadPath
	}
	present := make([]string, 0, len(names))
	for _, name := range names {
		path, err := s.filePath(key, name)
		if err != nil {
			// A malformed name is simply absent rather than fatal: the caller
			// asked "do you have this", and the answer is no.
			continue
		}
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			present = append(present, name)
		}
	}
	return present, nil
}

// List walks the store and reports every world's stages, largest world first.
//
// Reads only each stage's meta.json — a few hundred bytes — never the rasters,
// so a listing stays cheap enough that no index is needed yet. The trigger for
// one is eviction needing to sort by access time.
func (s *Store) List() ([]WorldArtifacts, error) {
	worldDirs, err := os.ReadDir(s.dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}

	out := make([]WorldArtifacts, 0, len(worldDirs))
	for _, worldEntry := range worldDirs {
		if !worldEntry.IsDir() {
			continue
		}
		world := WorldArtifacts{WorldID: worldEntry.Name()}
		versionDirs, err := os.ReadDir(filepath.Join(s.dir, world.WorldID))
		if err != nil {
			continue
		}
		for _, versionEntry := range versionDirs {
			if !versionEntry.IsDir() {
				continue
			}
			stageDirs, err := os.ReadDir(filepath.Join(s.dir, world.WorldID, versionEntry.Name()))
			if err != nil {
				continue
			}
			for _, stageEntry := range stageDirs {
				if !stageEntry.IsDir() {
					continue
				}
				key := Key{WorldID: world.WorldID, PipelineVersion: versionEntry.Name(), Stage: stageEntry.Name()}
				info := s.describeStage(key)
				world.Bytes += info.Bytes
				world.Stages = append(world.Stages, info)
			}
		}
		if len(world.Stages) == 0 {
			continue
		}
		sort.Slice(world.Stages, func(i, j int) bool { return world.Stages[i].Bytes < world.Stages[j].Bytes })
		out = append(out, world)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Bytes > out[j].Bytes })
	return out, nil
}

func (s *Store) describeStage(key Key) StageInfo {
	info := StageInfo{PipelineVersion: key.PipelineVersion, Stage: key.Stage}
	dir := s.stageDir(key)
	if _, err := os.Stat(dir); err != nil {
		return info
	}
	// Walked rather than listed: a stage may hold nested files once artifacts
	// are tiled (`tiles/12_7`), and a flat listing reported those stages as
	// zero bytes while Usage counted them — the two figures disagreed by
	// exactly the nested files, which is the kind of understatement a size
	// readout must not have.
	info.Bytes = dirBytes(dir)
	// meta.json is the client's own, written last so its presence means the
	// entry is complete. Unreadable leaves the dimensions at zero rather than
	// dropping the stage — the bytes are on disk either way.
	raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return info
	}
	var meta struct {
		Width  int `json:"width"`
		Height int `json:"height"`
		BakeMs int `json:"bakeMs"`
	}
	if json.Unmarshal(raw, &meta) == nil {
		info.Width, info.Height, info.BakeMs = meta.Width, meta.Height, meta.BakeMs
	}
	return info
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

// RemoveFile drops one artifact. Absent counts as removed: the caller wanted
// the bytes gone, and they are.
func (s *Store) RemoveFile(key Key, name string) error {
	path, err := s.filePath(key, name)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// RemoveWorld drops every artifact of one world id.
func (s *Store) RemoveWorld(worldID string) error {
	if !safeSegment(worldID) {
		return ErrBadPath
	}
	path := filepath.Join(s.dir, worldID)
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	return os.RemoveAll(path)
}

// Clear drops everything. Safe by construction — every byte in here is a
// deterministic function of a world and a pipeline version, so the worst case
// is that the next reader bakes again.
func (s *Store) Clear() error {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(s.dir, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

// Usage reports the total bytes held, for the storage panel's readout.
func (s *Store) Usage() (int64, error) {
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
