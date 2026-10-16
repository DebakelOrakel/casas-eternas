// Package blob opens a bucket or a directory and moves objects in and out
// (docs/decisions/object-storage.md, DEC-0038, fork 6). It is a LEAF: it has
// no routes and imports no module, so any module may import it. Each store
// keeps its layout private and talks to a Bucket; both backends implement
// the same interface, so a store has one code path.
//
// Two backends:
//
//   - Dir: files under a root directory. Put is a temp file and a rename in
//     the same directory. It signs its own links (LinkSigner); the route that
//     serves them belongs to the module, not to this package.
//   - S3: aws-sdk-go-v2 against Amazon S3 or Ceph RGW. The differences
//     between the providers are one row each of a capability table
//     (flavours in s3.go); a row claims only what was measured.
//
// Every key goes through CheckKey, in one place, before a backend signs or
// sends anything; so a bad key never reaches the provider and Dir never
// leaves its root.
//
// Status 2026-10-16 (DEC-0038): the artifact store runs on it (cmd/
// opens the Bucket from artifacts.storage, cmd/storage.go); the world store
// follows. The mapping from internal/config's storage blocks to S3Config is
// cmd/'s work, so this leaf does not import internal/config.
package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
	"iter"
	"net/http"
	"strings"
	"time"
)

// Bucket is what a store uses. Keys are relative to the bucket's prefix (S3)
// or root (Dir); the backend places them.
type Bucket interface {
	// Get opens the object for reading. The caller closes the reader. A
	// missing object is ErrNotFound.
	Get(ctx context.Context, key string) (io.ReadCloser, Info, error)
	// Put writes the object atomically: a reader sees the old object or the
	// new one, never a part. `size` is the exact length of `body`; a body
	// that is shorter or longer is refused (ErrSize) and nothing is written.
	Put(ctx context.Context, key string, body io.Reader, size int64, opts PutOptions) (Info, error)
	// Head returns the object's metadata. A missing object is ErrNotFound.
	Head(ctx context.Context, key string) (Info, error)
	// List yields every object whose key starts with `prefix` (a plain
	// string prefix, not a directory). The pages are fetched as the loop
	// runs. The order is not part of the contract. An error ends the
	// sequence as its last pair.
	List(ctx context.Context, prefix string) iter.Seq2[Info, error]
	// Delete removes the object. A missing object is not an error. On a
	// versioned bucket it leaves a delete marker.
	Delete(ctx context.Context, key string) error
	// PresignGet returns a link that reads the object without credentials
	// until it expires.
	PresignGet(ctx context.Context, key string, ttl time.Duration) (Link, error)
	// PresignPut returns a link that writes the object with exactly
	// `length` bytes until it expires.
	PresignPut(ctx context.Context, key string, ttl time.Duration, length int64) (Link, error)
}

// Info is an object's metadata.
type Info struct {
	Key  string
	Size int64
	// ETag is an opaque tag that changes when the object changes. On S3 it
	// is the provider's ETag (for a single PUT the hex MD5 of the bytes);
	// on Dir it is made from the modification time and the size, NOT from
	// the content. Do not compare it across backends.
	ETag         string
	LastModified time.Time
}

// PutOptions modify a Put.
type PutOptions struct {
	// IfAbsent writes only when no object has the key; else ErrExists.
	// Dir: a hard link, which fails when the name exists. S3: If-None-Match
	// "*", only on a flavour whose row has it (else ErrUnsupported).
	IfAbsent bool
	// ContentType is stored with the object on S3. Dir ignores it.
	ContentType string
}

// Link is a presigned request. The holder sends Method to URL with every
// header in Header (a provider can sign headers into the link; a request
// without them is refused).
type Link struct {
	Method  string
	URL     string
	Header  http.Header
	Expires time.Time
}

// MaxLinkTTL is the longest lifetime a link may have: the limit of
// Signature V4, applied to Dir's links too so that the backends agree.
const MaxLinkTTL = 7 * 24 * time.Hour

var (
	// ErrNotFound: no object has the key. One shape for every provider
	// answer that means this (NoSuchKey, a bodyless 404 on HEAD, NotFound).
	ErrNotFound = errors.New("blob: object not found")
	// ErrBadKey: the key breaks the key rule (see CheckKey). Returned
	// before anything is signed or sent.
	ErrBadKey = errors.New("blob: bad key")
	// ErrExists: a Put with IfAbsent met an existing object.
	ErrExists = errors.New("blob: object exists")
	// ErrSize: the body does not have the length that was given.
	ErrSize = errors.New("blob: body length does not match")
	// ErrUnsupported: the backend cannot do this (e.g. IfAbsent on a
	// flavour whose row does not claim it, or links on a Dir without a
	// signer).
	ErrUnsupported = errors.New("blob: not supported by this backend")
	// ErrNoBucket: the bucket is missing (after Open, someone removed it).
	ErrNoBucket = errors.New("blob: bucket not found")
	// ErrBadTTL: a link lifetime that is not positive or longer than
	// MaxLinkTTL.
	ErrBadTTL = errors.New("blob: bad link lifetime")
)

// The key rule. A key is one or more SEGMENTS joined by "/":
//
//   - a segment is not empty and has only ASCII letters, digits, '.', '_'
//     and '-';
//   - a segment does not start with '.' (this refuses "." and ".." and
//     keeps Dir's temp files, which start with ".tmp-", apart from keys);
//   - so no leading or trailing "/", no "//", no backslash, no space, no
//     control or non-ASCII character;
//   - at most MaxKeyLength bytes in all (S3's limit), prefix included.
const MaxKeyLength = 1024

// CheckKey applies the key rule. Every backend calls it first.
func CheckKey(key string) error {
	if key == "" {
		return keyError(key, "empty")
	}
	if len(key) > MaxKeyLength {
		return keyError(key, fmt.Sprintf("longer than %d bytes", MaxKeyLength))
	}
	for seg := range strings.SplitSeq(key, "/") {
		if err := checkSegment(key, seg); err != nil {
			return err
		}
	}
	return nil
}

// checkPrefix applies the key rule to a List prefix: empty is allowed, a
// trailing "/" is allowed, and the last segment may be a part of one.
func checkPrefix(prefix string) error {
	if prefix == "" {
		return nil
	}
	if len(prefix) > MaxKeyLength {
		return keyError(prefix, fmt.Sprintf("longer than %d bytes", MaxKeyLength))
	}
	// A part of a segment follows the same rule as a whole one.
	for seg := range strings.SplitSeq(strings.TrimSuffix(prefix, "/"), "/") {
		if err := checkSegment(prefix, seg); err != nil {
			return err
		}
	}
	return nil
}

func checkSegment(key, seg string) error {
	if seg == "" {
		return keyError(key, "empty segment")
	}
	if seg[0] == '.' {
		return keyError(key, "segment starts with '.'")
	}
	for i := 0; i < len(seg); i++ {
		c := seg[i]
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-'
		if !ok {
			return keyError(key, fmt.Sprintf("character %q is not allowed", c))
		}
	}
	return nil
}

func keyError(key, why string) error {
	// %q, so a key with control characters cannot forge a log line.
	return fmt.Errorf("%w %q: %s", ErrBadKey, key, why)
}

func checkTTL(ttl time.Duration) error {
	if ttl <= 0 || ttl > MaxLinkTTL {
		return fmt.Errorf("%w: %v (must be in (0, %v])", ErrBadTTL, ttl, MaxLinkTTL)
	}
	return nil
}
