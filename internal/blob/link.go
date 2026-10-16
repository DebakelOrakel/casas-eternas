package blob

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"
)

// The Dir backend's own links (DEC-0038, fork 5): no S3 server is embedded,
// the server signs a link and serves it. The link is
//
//	<base><key>?exp=<unix seconds>[&len=<bytes>]&sig=<base64url HMAC>
//
// where the HMAC-SHA256 is over the method, the key, the expiry and, for a
// PUT, the length. This file builds and checks the query; the route that
// serves `<base><key>` is the module's (internal/modules/artifacts,
// handleLink), so the base path is a parameter.

// MinLinkKeyLength is the shortest signing key accepted, in bytes.
const MinLinkKeyLength = 32

var (
	// ErrLinkInvalid: the link is malformed or its signature does not match
	// (a changed method, key, expiry or length all land here).
	ErrLinkInvalid = errors.New("blob: link is not valid")
	// ErrLinkExpired: the signature matches but the expiry has passed.
	ErrLinkExpired = errors.New("blob: link has expired")
	// ErrTooLarge: a PUT link for more bytes than the signer allows.
	ErrTooLarge = errors.New("blob: upload is larger than the limit")
)

// linkEqual compares two MACs. A variable only so that a test can see that
// the constant-time compare is the one used.
var linkEqual = hmac.Equal

// LinkSigner signs and checks Dir links. It signs with the first key and
// accepts each of them, so a key change-over is: add the new key first,
// keep the old one second until the old links have expired, then drop it.
type LinkSigner struct {
	base   string
	keys   [][]byte
	maxPut int64
	now    func() time.Time
}

// NewLinkSigner makes a signer for links under `base` (a path that ends in
// "/", e.g. "/v1/artifacts/blob/"). `maxPut` is the largest length a PUT
// link may carry (> 0). Each key has at least MinLinkKeyLength bytes.
func NewLinkSigner(base string, maxPut int64, keys ...[]byte) (*LinkSigner, error) {
	if base == "" || base[len(base)-1] != '/' {
		return nil, fmt.Errorf("blob: link base %q must end in /", base)
	}
	if maxPut <= 0 {
		return nil, fmt.Errorf("blob: link upload limit %d must be positive", maxPut)
	}
	if len(keys) == 0 {
		return nil, errors.New("blob: a link signer needs a key")
	}
	own := make([][]byte, len(keys))
	for i, k := range keys {
		if len(k) < MinLinkKeyLength {
			// Never the key in the message, only its length.
			return nil, fmt.Errorf("blob: link key %d has %d bytes, needs at least %d", i, len(k), MinLinkKeyLength)
		}
		own[i] = bytes.Clone(k)
	}
	return &LinkSigner{base: base, keys: own, maxPut: maxPut, now: time.Now}, nil
}

// ReadLinkKey reads a link key from a file and trims white space at both
// ends (a file written by an editor or `echo` ends in a newline). An empty
// path makes an EPHEMERAL random key: links made with it die when the
// process ends. A path that is set but cannot be read is an error, not an
// ephemeral key: a typo must not silently make links that die at restart.
func ReadLinkKey(path string) (key []byte, ephemeral bool, err error) {
	if path == "" {
		key = make([]byte, MinLinkKeyLength)
		if _, err := rand.Read(key); err != nil {
			return nil, false, err
		}
		return key, true, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false, fmt.Errorf("blob: link key: %w", err)
	}
	key = bytes.TrimSpace(raw)
	if len(key) < MinLinkKeyLength {
		return nil, false, fmt.Errorf("blob: link key %s has %d bytes, needs at least %d", path, len(key), MinLinkKeyLength)
	}
	return key, false, nil
}

// Sign returns a link for `method` (GET or PUT) on `key`. `length` is used
// only for PUT.
func (s *LinkSigner) Sign(method, key string, ttl time.Duration, length int64) (Link, error) {
	if err := CheckKey(key); err != nil {
		return Link{}, err
	}
	if err := checkTTL(ttl); err != nil {
		return Link{}, err
	}
	q := url.Values{}
	switch method {
	case http.MethodGet:
	case http.MethodPut:
		if length < 0 {
			return Link{}, fmt.Errorf("blob: link length %d is negative", length)
		}
		if length > s.maxPut {
			return Link{}, fmt.Errorf("%w: %d > %d bytes", ErrTooLarge, length, s.maxPut)
		}
		q.Set("len", strconv.FormatInt(length, 10))
	default:
		return Link{}, fmt.Errorf("blob: no links for method %q", method)
	}
	exp := s.now().Add(ttl).Truncate(time.Second)
	expText := strconv.FormatInt(exp.Unix(), 10)
	q.Set("exp", expText)
	q.Set("sig", base64.RawURLEncoding.EncodeToString(linkMAC(s.keys[0], method, key, expText, q.Get("len"))))
	return Link{Method: method, URL: s.base + key + "?" + q.Encode(), Header: http.Header{}, Expires: exp}, nil
}

// Verify checks a request on `key` (the path after the base) with the
// link's query. It returns the signed length for a PUT (0 for a GET); the
// route must then read exactly that many bytes (Dir.Put does). A HEAD is
// checked as a GET by the caller.
//
// The order: the key rule, the form of the query, the signature against
// every key (constant time), and only then the expiry, so that an expired
// answer is given only for a link that we did sign.
func (s *LinkSigner) Verify(method, key string, q url.Values) (int64, error) {
	if err := CheckKey(key); err != nil {
		return 0, err
	}
	if method != http.MethodGet && method != http.MethodPut {
		return 0, fmt.Errorf("%w: method %q", ErrLinkInvalid, method)
	}
	expText, sigText := q.Get("exp"), q.Get("sig")
	if len(q["exp"]) != 1 || len(q["sig"]) != 1 || len(q["len"]) > 1 {
		return 0, fmt.Errorf("%w: needs one exp and one sig", ErrLinkInvalid)
	}
	exp, err := strconv.ParseInt(expText, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: exp", ErrLinkInvalid)
	}
	lenText := q.Get("len")
	var length int64
	if method == http.MethodPut {
		length, err = strconv.ParseInt(lenText, 10, 64)
		if err != nil || length < 0 {
			return 0, fmt.Errorf("%w: len", ErrLinkInvalid)
		}
	} else if _, has := q["len"]; has {
		return 0, fmt.Errorf("%w: len on a GET link", ErrLinkInvalid)
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigText)
	if err != nil || len(sig) != sha256.Size {
		return 0, fmt.Errorf("%w: sig", ErrLinkInvalid)
	}
	matched := false
	for _, k := range s.keys {
		// No early exit: each key is tried, so the time does not say which.
		if linkEqual(sig, linkMAC(k, method, key, expText, lenText)) {
			matched = true
		}
	}
	if !matched {
		return 0, ErrLinkInvalid
	}
	if !s.now().Before(time.Unix(exp, 0)) {
		return 0, ErrLinkExpired
	}
	if length > s.maxPut {
		return 0, fmt.Errorf("%w: %d > %d bytes", ErrTooLarge, length, s.maxPut)
	}
	return length, nil
}

// linkMAC is the HMAC over the signed fields. The fields are joined by
// newlines; no field can hold one (the key rule, a fixed method, decimal
// numbers), so the joint text is not ambiguous. The version tag lets a
// later format refuse links of this one.
func linkMAC(key []byte, method, objectKey, exp, length string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte("casas-blob-link-v1\n" + method + "\n" + objectKey + "\n" + exp + "\n" + length))
	return m.Sum(nil)
}
