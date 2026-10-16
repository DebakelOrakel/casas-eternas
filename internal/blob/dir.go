package blob

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"iter"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Dir is the backend for files under a root directory. All file access
// goes through an os.Root, so no key and no symlink can reach outside the
// root, in addition to the key rule.
//
// Limits the S3 backend does not have: a key cannot be both an object and
// the directory of another ("a" and "a/b"); such a Put fails. Delete
// removes the directories that it makes empty, up to (not including) the
// root, as S3 has no directories that stay behind.
type Dir struct {
	root   *os.Root
	signer *LinkSigner
}

var _ Bucket = (*Dir)(nil)

// tmpPrefix starts the name of a file that a Put has not finished. The key
// rule refuses a segment that starts with '.', so no key has this name.
const tmpPrefix = ".tmp-"

// OpenDir opens (and makes, when missing) the directory `root`. `signer`
// signs the links; nil means no links (Presign answers ErrUnsupported).
func OpenDir(root string, signer *LinkSigner) (*Dir, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	return &Dir{root: r, signer: signer}, nil
}

// Close releases the root.
func (d *Dir) Close() error { return d.root.Close() }

// Signer returns the link signer, for the route that verifies the links.
func (d *Dir) Signer() *LinkSigner { return d.signer }

func (d *Dir) Get(_ context.Context, key string) (io.ReadCloser, Info, error) {
	if err := CheckKey(key); err != nil {
		return nil, Info{}, err
	}
	f, err := d.root.Open(key)
	if err != nil {
		return nil, Info{}, dirError(err)
	}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, Info{}, err
	}
	if !st.Mode().IsRegular() {
		_ = f.Close()
		return nil, Info{}, ErrNotFound
	}
	return f, dirInfo(key, st), nil
}

func (d *Dir) Head(_ context.Context, key string) (Info, error) {
	if err := CheckKey(key); err != nil {
		return Info{}, err
	}
	st, err := d.root.Stat(key)
	if err != nil {
		return Info{}, dirError(err)
	}
	if !st.Mode().IsRegular() {
		return Info{}, ErrNotFound
	}
	return dirInfo(key, st), nil
}

// Put writes into a temp file in the key's own directory and renames it
// into place (or, with IfAbsent, links it, which fails when the name
// exists). Without opts.Sync there is no fsync: atomic against a reader,
// and a power cut costs a write that can be made again. With it, the file
// is synced before the rename and the directory after it.
func (d *Dir) Put(ctx context.Context, key string, body io.Reader, size int64, opts PutOptions) (Info, error) {
	if err := CheckKey(key); err != nil {
		return Info{}, err
	}
	if size < 0 {
		return Info{}, fmt.Errorf("%w: size %d is negative", ErrSize, size)
	}
	dir := path.Dir(key)
	tmp, f, err := d.createTemp(dir)
	if err != nil {
		return Info{}, err
	}
	defer func() {
		// A no-op once renamed. A failed Put leaves no empty directory.
		if d.root.Remove(tmp) == nil {
			d.removeEmptyParents(dir)
		}
	}()

	n, err := io.CopyN(f, body, size)
	if err == nil {
		// One byte more must not exist: the body is exactly `size` long.
		var one [1]byte
		if m, _ := io.ReadFull(body, one[:]); m > 0 {
			err = fmt.Errorf("%w: more than %d bytes", ErrSize, size)
		}
	} else if errors.Is(err, io.EOF) {
		err = fmt.Errorf("%w: %d of %d bytes", ErrSize, n, size)
	}
	if err == nil && opts.Sync {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = ctx.Err()
	}
	if err != nil {
		return Info{}, err
	}
	if opts.IfAbsent {
		if err := d.root.Link(tmp, key); err != nil {
			if errors.Is(err, fs.ErrExist) {
				return Info{}, ErrExists
			}
			return Info{}, err
		}
	} else if err := d.root.Rename(tmp, key); err != nil {
		return Info{}, err
	}
	if opts.Sync {
		d.syncDir(dir)
	}
	return d.Head(ctx, key)
}

// syncDir flushes the directory entry, so that the rename survives a crash
// and not only the file's content. Failures are ignored: some filesystems
// refuse to sync a directory handle, and a store that cannot be written is
// a worse result than one that is a little less durable.
func (d *Dir) syncDir(dir string) {
	h, err := d.root.Open(dir)
	if err != nil {
		return
	}
	_ = h.Sync()
	_ = h.Close()
}

// LocalPath returns the path of the object's file, for a process on the
// same machine that reads the file itself (a local job worker reads a world
// save of tens of megabytes so, not through the server). Only Dir has it:
// an S3 object has no path. The key goes through the key rule, and the
// object must be a regular file under the root now; a missing one is
// ErrNotFound. The path starts with the root as OpenDir was given it.
func (d *Dir) LocalPath(key string) (string, error) {
	if _, err := d.Head(context.Background(), key); err != nil {
		return "", err
	}
	return filepath.Join(d.root.Name(), filepath.FromSlash(key)), nil
}

// putAttempts bounds how often Put makes the key's directory again when a
// Delete removed it (an empty parent) between MkdirAll and the temp file.
const putAttempts = 8

// createTemp makes the key's directory and a new temp file in it. A
// concurrent Delete can remove the directory when it is empty (see
// removeEmptyParents), that is, before the temp file is in it; then the
// open answers ENOENT and the directory is made again. Once the temp file
// is in the directory, the directory is not empty and stays until the
// rename has put the object there.
func (d *Dir) createTemp(dir string) (string, *os.File, error) {
	var lastErr error
	for range putAttempts {
		if dir != "." {
			if err := d.root.MkdirAll(dir, 0o755); err != nil {
				if !errors.Is(err, fs.ErrNotExist) && d.dirExists(path.Dir(dir)) {
					return "", nil, err
				}
				// A parent removed while MkdirAll made its child.
				lastErr = err
				continue
			}
		}
		var rnd [8]byte
		_, _ = rand.Read(rnd[:])
		tmp := path.Join(dir, tmpPrefix+hex.EncodeToString(rnd[:]))
		f, err := d.root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			return tmp, f, nil
		}
		// ENOENT, or on macOS EINVAL when the directory went while the
		// open was inside it: the test is whether it is still there.
		if !errors.Is(err, fs.ErrNotExist) && d.dirExists(dir) {
			return "", nil, err
		}
		lastErr = err
	}
	return "", nil, lastErr
}

// dirExists reports whether `dir` is a directory under the root now.
func (d *Dir) dirExists(dir string) bool {
	st, err := d.root.Lstat(dir)
	return err == nil && st.IsDir()
}

func (d *Dir) Delete(_ context.Context, key string) error {
	if err := CheckKey(key); err != nil {
		return err
	}
	st, err := d.root.Lstat(key)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if st.IsDir() {
		// A directory is not an object; S3 has nothing at such a key.
		return nil
	}
	if err := d.root.Remove(key); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	d.removeEmptyParents(path.Dir(key))
	return nil
}

// removeEmptyParents removes `dir` and its parents while they are empty, up
// to (not including) the root. Remove on a directory is rmdir: it removes
// only an empty one, so a directory that a concurrent Put has put a temp
// file or an object into stays (ENOTEMPTY or EEXIST), and one that another
// Delete has removed already is gone (ENOENT). Either ends the walk without
// an error: the object is deleted, and a directory left behind costs
// nothing. Put makes a directory again when it is removed under it
// (createTemp).
func (d *Dir) removeEmptyParents(dir string) {
	for dir != "." && dir != "/" && dir != "" {
		// A real directory only: a symlink to a directory is not removed.
		if st, err := d.root.Lstat(dir); err != nil || !st.IsDir() {
			return
		}
		if err := d.root.Remove(dir); err != nil {
			return
		}
		dir = path.Dir(dir)
	}
}

// RemoveJunk removes `name`, a file or a directory with all it holds,
// directly under the root, when `name` is NOT a valid key: a name copied
// in by hand (a space, a non-ASCII character) that List reports but that
// Delete refuses, so that the store that indexed it as junk cannot remove
// it. A narrow path on purpose: one segment, never a valid key (those go
// through Delete), never "." or "..", never a temp file, and through the
// os.Root like every other access, so it cannot leave the root. A missing
// name is not an error.
//
// Only Dir has it: in an S3 bucket only this server writes, and every key
// it writes passes CheckKey.
func (d *Dir) RemoveJunk(_ context.Context, name string) error {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") || strings.HasPrefix(name, tmpPrefix) {
		return keyError(name, "not a top-level junk name")
	}
	if CheckKey(name) == nil {
		return keyError(name, "a valid key; use Delete")
	}
	return d.removeTopLevel(name)
}

// RemoveTree removes the directory `name` directly under the root with all
// it holds, after a store deleted every object under the prefix name+"/":
// what stays there is what Delete cannot remove, the names that break the
// key rule (an editor's .DS_Store, a temp file of an interrupted Put, a
// file copied in by hand). The narrow path of RemoveJunk, for the other
// half of the names: `name` must be ONE valid key segment (no "/", so never
// the root and never a path into a subtree), it goes through the os.Root,
// and a symlink in the tree is removed, not followed. A missing name is not
// an error.
//
// Only Dir has it: an S3 bucket has no names besides its keys, so deleting
// the listed objects leaves nothing.
func (d *Dir) RemoveTree(_ context.Context, name string) error {
	if strings.Contains(name, "/") {
		return keyError(name, "not a single segment")
	}
	if err := CheckKey(name); err != nil {
		return err
	}
	return d.removeTopLevel(name)
}

// removeTopLevel removes a name directly under the root, with all it holds.
// The callers check the name.
func (d *Dir) removeTopLevel(name string) error {
	if err := d.root.RemoveAll(name); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// List walks the root from the deepest directory that the prefix names
// whole, and yields each regular file whose key has the prefix. Temp files
// are skipped.
func (d *Dir) List(ctx context.Context, prefix string) iter.Seq2[Info, error] {
	return func(yield func(Info, error) bool) {
		if err := checkPrefix(prefix); err != nil {
			yield(Info{}, err)
			return
		}
		start := "."
		if i := strings.LastIndexByte(prefix, '/'); i > 0 {
			start = prefix[:i]
		}
		fsys := d.root.FS()
		err := fs.WalkDir(fsys, start, func(p string, e fs.DirEntry, err error) error {
			if err != nil {
				if p == start && errors.Is(err, fs.ErrNotExist) {
					return fs.SkipAll // nothing under this prefix
				}
				return err
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if strings.HasPrefix(e.Name(), tmpPrefix) {
				return nil
			}
			if e.IsDir() || !e.Type().IsRegular() || !strings.HasPrefix(p, prefix) {
				return nil
			}
			st, err := e.Info()
			if errors.Is(err, fs.ErrNotExist) {
				return nil // deleted while we walked
			}
			if err != nil {
				return err
			}
			if !yield(dirInfo(p, st), nil) {
				return errStop
			}
			return nil
		})
		if err != nil && !errors.Is(err, errStop) {
			yield(Info{}, err)
		}
	}
}

var errStop = errors.New("stop")

func (d *Dir) PresignGet(_ context.Context, key string, ttl time.Duration) (Link, error) {
	if d.signer == nil {
		return Link{}, fmt.Errorf("%w: no link signer", ErrUnsupported)
	}
	return d.signer.Sign(http.MethodGet, key, ttl, 0)
}

func (d *Dir) PresignPut(_ context.Context, key string, ttl time.Duration, length int64) (Link, error) {
	if d.signer == nil {
		return Link{}, fmt.Errorf("%w: no link signer", ErrUnsupported)
	}
	return d.signer.Sign(http.MethodPut, key, ttl, length)
}

func dirInfo(key string, st fs.FileInfo) Info {
	mod := st.ModTime()
	return Info{
		Key:          key,
		Size:         st.Size(),
		ETag:         strconv.FormatInt(mod.UnixNano(), 16) + "-" + strconv.FormatInt(st.Size(), 16),
		LastModified: mod,
	}
}

// dirError gives a missing file (or a path through a file, ENOTDIR) the one
// not-found shape.
func dirError(err error) error {
	if errors.Is(err, fs.ErrNotExist) || isNotDir(err) {
		return ErrNotFound
	}
	return err
}

func isNotDir(err error) bool { return errors.Is(err, syscall.ENOTDIR) }
