package auth

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	_ "image/jpeg" // decoders for the avatar's dimension check
	_ "image/png"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/httpjson"
	"github.com/DebakelOrakel/casas-eternas/internal/user"
)

// THE PROFILE (docs/decisions/client-accounts.md, forks 5 and 6): what a
// signed-in user reads and changes about themselves, on the network
// listener. Every route takes the caller from a SESSION token — a job's or
// a worker's token is not a person — and acts on that id alone, so no
// route here takes a name.

// MePath is the caller's own profile.
const MePath = "/v1/auth/me"

// AvatarPath serves a user's picture to any signed-in user.
const AvatarPath = "/v1/auth/users/{id}/avatar"

// An avatar as the client sends it: already cropped and scaled in the
// browser (256 × 256), so the server checks and stores, and needs no image
// library beyond the standard decoders for the check.
const (
	maxAvatarBytes = 200 << 10
	minAvatarSide  = 64
	maxAvatarSide  = 1024
)

var avatarTypes = map[string]string{"image/jpeg": "jpeg", "image/png": "png"}

// MountProfile claims the profile routes.
func (m *Module) MountProfile(mux *http.ServeMux) {
	mux.HandleFunc("GET "+MePath, m.serveMe)
	mux.HandleFunc("PUT "+MePath, m.serveSetMe)
	mux.HandleFunc("PUT "+MePath+"/password", m.serveChangePassword)
	mux.HandleFunc("PUT "+MePath+"/avatar", m.servePutAvatar)
	mux.HandleFunc("DELETE "+MePath+"/avatar", m.serveDeleteAvatar)
	mux.HandleFunc("GET "+AvatarPath, m.serveAvatar)
}

// profile is what GET /v1/auth/me answers.
type profile struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	DisplayName string     `json:"displayName"`
	Admin       bool       `json:"admin"`
	CreatedAt   time.Time  `json:"createdAt"`
	LastLoginAt *time.Time `json:"lastLoginAt,omitempty"`
	// The picture's version, empty for none: the client asks for the picture
	// only when there is one, and asks again when this changes.
	Avatar string `json:"avatar"`
}

func profileOf(u user.User) profile {
	return profile{ID: u.ID, Name: u.Name, DisplayName: u.DisplayName, Admin: u.Admin(), CreatedAt: u.CreatedAt, LastLoginAt: u.LastLoginAt, Avatar: u.Avatar}
}

// me resolves the caller's own entry from a session token, or answers 401.
func (m *Module) me(w http.ResponseWriter, r *http.Request) (user.User, bool) {
	raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	id, _, err := m.cfg.Tokens.VerifySession(raw)
	if err != nil || raw == "" {
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return user.User{}, false
	}
	entry, ok := m.cfg.Registry.ByID(id)
	if !ok {
		// A valid token for a deleted user: as good as none.
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return user.User{}, false
	}
	return entry, true
}

func (m *Module) serveMe(w http.ResponseWriter, r *http.Request) {
	entry, ok := m.me(w, r)
	if !ok {
		return
	}
	httpjson.Write(w, http.StatusOK, profileOf(entry))
}

func (m *Module) serveSetMe(w http.ResponseWriter, r *http.Request) {
	entry, ok := m.me(w, r)
	if !ok {
		return
	}
	var body struct {
		DisplayName string `json:"displayName"`
	}
	if !decodeAdminBody(w, r, &body) {
		return
	}
	if err := m.cfg.Registry.SetDisplayName(entry.ID, body.DisplayName); err != nil {
		adminError(w, "setting a display name", err)
		return
	}
	entry, _ = m.cfg.Registry.ByID(entry.ID)
	httpjson.Write(w, http.StatusOK, profileOf(entry))
}

// serveChangePassword sets the caller's password, given the current one: a
// wrong current password answers 403, so a client tells it from a session
// that has run out (401).
func (m *Module) serveChangePassword(w http.ResponseWriter, r *http.Request) {
	entry, ok := m.me(w, r)
	if !ok {
		return
	}
	var body struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if !decodeAdminBody(w, r, &body) {
		return
	}
	changed, err := m.cfg.Registry.ChangePassword(entry.ID, body.Current, body.New)
	if err != nil {
		adminError(w, "changing a password", err)
		return
	}
	if !changed {
		httpjson.ClientError(w, http.StatusForbidden, "the current password is wrong")
		return
	}
	slog.Info("password changed by its user", "user", entry.Name, "id", entry.ID)
	w.WriteHeader(http.StatusNoContent)
}

// --- avatars ----------------------------------------------------------------

func (m *Module) avatarFile(id string) string {
	return filepath.Join(m.cfg.StorageDir, "avatars", id)
}

func (m *Module) servePutAvatar(w http.ResponseWriter, r *http.Request) {
	entry, ok := m.me(w, r)
	if !ok {
		return
	}
	mediaType := strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])
	format, known := avatarTypes[mediaType]
	if !known {
		httpjson.ClientError(w, http.StatusUnsupportedMediaType, "an avatar is image/jpeg or image/png")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAvatarBytes))
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		httpjson.ClientError(w, http.StatusRequestEntityTooLarge, "an avatar is at most 200 kB")
		return
	}
	if err != nil {
		httpjson.ClientError(w, http.StatusBadRequest, "reading the avatar: "+err.Error())
		return
	}
	config, decoded, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || decoded != format {
		httpjson.ClientError(w, http.StatusBadRequest, "the avatar is not a readable "+format+" image")
		return
	}
	if config.Width != config.Height || config.Width < minAvatarSide || config.Width > maxAvatarSide {
		httpjson.ClientError(w, http.StatusBadRequest, "an avatar is square, 64 to 1024 pixels a side")
		return
	}
	sum := sha256.Sum256(data)
	version := hex.EncodeToString(sum[:8])
	path := m.avatarFile(entry.ID)
	if err := writeFileAtomic(path, data); err != nil {
		httpjson.ServerError(w, "storing an avatar", err)
		return
	}
	if err := m.cfg.Registry.SetAvatar(entry.ID, version, mediaType); err != nil {
		adminError(w, "recording an avatar", err)
		return
	}
	httpjson.Write(w, http.StatusOK, map[string]string{"avatar": version})
}

func (m *Module) serveDeleteAvatar(w http.ResponseWriter, r *http.Request) {
	entry, ok := m.me(w, r)
	if !ok {
		return
	}
	if err := m.removeAvatar(entry.ID); err != nil {
		httpjson.ServerError(w, "removing an avatar", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// removeAvatar forgets a user's picture, the record and the file.
func (m *Module) removeAvatar(id string) error {
	if err := m.cfg.Registry.SetAvatar(id, "", ""); err != nil && !errors.Is(err, user.ErrUnknown) {
		return err
	}
	if err := os.Remove(m.avatarFile(id)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// serveAvatar answers a user's picture to any signed-in caller (the gate
// let them in), with its version as the ETag.
func (m *Module) serveAvatar(w http.ResponseWriter, r *http.Request) {
	entry, ok := m.cfg.Registry.ByID(r.PathValue("id"))
	if !ok || entry.Avatar == "" {
		http.NotFound(w, r)
		return
	}
	etag := `"` + entry.Avatar + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, no-cache")
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	data, err := os.ReadFile(m.avatarFile(entry.ID))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", entry.AvatarType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(data)
}

// writeFileAtomic writes beside the target and renames over it, so a reader
// never sees half a picture.
func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".avatar-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}
