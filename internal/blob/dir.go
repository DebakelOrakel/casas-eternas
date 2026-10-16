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
// the directory of another ("a" and "a/b"); such a Put fails. Delete does
// not remove directories that become empty.
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
// exists). No fsync, as in the stores today: atomic against a reader, and
// a power cut costs a write that can be made again.
func (d *Dir) Put(ctx context.Context, key string, body io.Reader, size int64, opts PutOptions) (Info, error) {
	if err := CheckKey(key); err != nil {
		return Info{}, err
	}
	if size < 0 {
		return Info{}, fmt.Errorf("%w: size %d is negative", ErrSize, size)
	}
	dir := path.Dir(key)
	if dir != "." {
		if err := d.root.MkdirAll(dir, 0o755); err != nil {
			return Info{}, err
		}
	}
	var rnd [8]byte
	_, _ = rand.Read(rnd[:])
	tmp := path.Join(dir, tmpPrefix+hex.EncodeToString(rnd[:]))
	f, err := d.root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return Info{}, err
	}
	defer func() { _ = d.root.Remove(tmp) }() // no-op once renamed

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
	return d.Head(ctx, key)
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
