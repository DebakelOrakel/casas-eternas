package config

import (
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
)

// SeparateStorage refuses a world store and an artifact store that share a
// storage root: one directory, or one nested in the other (dir); one
// bucket of one provider with equal or nested prefixes, where an empty
// prefix holds every other (s3). cmd/ asks it when both targets run in one
// process (review of 2026-10-16, DEC-0038).
//
// The reason: the artifact store owns its root. Its cap's sweep and its
// clear take every top-level entry that is not an artifact as junk, and a
// world is not an artifact — a shared root deletes worlds, the one data
// that cannot be made again (reproduced on dir). The artifact store also
// refuses to take an entry shaped like a world as junk (defence in depth,
// for two processes that this check cannot see).
//
// Directories are compared after filepath.Abs and, where they exist, with
// their symbolic links resolved. Both arguments are validated unions.
func SeparateStorage(world, artifacts ObjectStorage) error {
	refuse := func(detail string) error {
		return fmt.Errorf("world.storage and artifacts.storage share %s: the artifact store would delete the worlds as junk; give each store its own", detail)
	}
	switch {
	case world.Type == "dir" && artifacts.Type == "dir":
		a, b := realPath(world.DirPath()), realPath(artifacts.DirPath())
		if nested(a, b) || nested(b, a) {
			return refuse(fmt.Sprintf("a directory (%s and %s)", a, b))
		}
	case world.Type == "s3" && artifacts.Type == "s3" && world.S3 != nil && artifacts.S3 != nil:
		w, a := *world.S3, *artifacts.S3
		if w.Flavour != a.Flavour || endpointOf(w.Endpoint) != endpointOf(a.Endpoint) || w.Bucket != a.Bucket {
			return nil
		}
		p, q := strings.Trim(w.Prefix, "/"), strings.Trim(a.Prefix, "/")
		if p == "" || q == "" || p == q || strings.HasPrefix(p, q+"/") || strings.HasPrefix(q, p+"/") {
			return refuse(fmt.Sprintf("the bucket %s with the prefixes %q and %q", w.Bucket, w.Prefix, a.Prefix))
		}
	}
	return nil
}

// realPath is a directory as an absolute, clean path, with the symbolic
// links resolved of the longest part of it that exists (a store makes the
// rest).
func realPath(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = filepath.Clean(path)
	}
	rest := ""
	for dir := abs; ; dir = filepath.Dir(dir) {
		if resolved, err := filepath.EvalSymlinks(dir); err == nil {
			return filepath.Join(resolved, rest)
		}
		if filepath.Dir(dir) == dir {
			return abs
		}
		rest = filepath.Join(filepath.Base(dir), rest)
	}
}

// nested reports whether `inner` is `outer` or below it.
func nested(outer, inner string) bool {
	rel, err := filepath.Rel(outer, inner)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// endpointOf is an S3 endpoint as compared: scheme and host in lower case,
// no trailing "/". Empty (aws: the region names it) stays empty.
func endpointOf(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" {
		return strings.TrimSuffix(endpoint, "/")
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host) + strings.TrimSuffix(u.Path, "/")
}
