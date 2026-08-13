package config

import (
	"fmt"
	"time"
)

// The full configuration tree — what casas.yaml holds, what every flag and
// CASAS_* variable maps into, and what every module receives whole.
//
// ONE VOCABULARY (decided 2026-08-12, modelled on Loki/Mimir): the config key
// IS the flag name IS the environment name — `world.storage.dir.path` ↔
// `--world.storage.dir.path` ↔ `CASAS_WORLD_STORAGE_DIR_PATH`. Process-wide
// settings live under `global:`; each target has its own section; a module
// reads Global plus ITS OWN section and nothing else (the one temporary
// exception is bake, which still reads the world/artifacts sections until its
// decoupling lands — marked at the read site).
//
// TARGET SELECTION IS DELIBERATELY ABSENT: the same file is shared by every
// process of a split deployment, and a role in a shared file would give every
// process the same role. `-t` / CASAS_TARGET select; the loader refuses a
// target key in the file, loudly.
//
// This package still imports neither cobra nor viper — the tree is plain
// data with mapstructure tags; reading files/env/flags into it is cmd/'s
// business, exactly once.

// Config is the whole tree. Modules receive it complete (Loki-style, decided
// 2026-08-12) — the boundary is the read discipline above, enforced by
// review, not the compiler.
type Config struct {
	Global    Global          `mapstructure:"global"`
	World     WorldConfig     `mapstructure:"world"`
	Artifacts ArtifactsConfig `mapstructure:"artifacts"`
	Bake      BakeConfig      `mapstructure:"bake"`
	Client    ClientConfig    `mapstructure:"client"`
	Auth      AuthConfig      `mapstructure:"auth"`
	Docs      DocsConfig      `mapstructure:"docs"`
}

// Global is everything that belongs to the PROCESS, not to a target: the
// socket, TLS, how callers are authenticated, and where peer services live.
type Global struct {
	Listen   string        `mapstructure:"listen"`
	TLS      TLSConfig     `mapstructure:"tls"`
	Auth     AuthSettings  `mapstructure:"auth"`
	Admin    AdminSettings `mapstructure:"admin"`
	Services Services      `mapstructure:"services"`
}

// AdminSettings is the process's local administration channel. GLOBAL, not a
// target section: the socket is process-level like the listener — every
// resident module may contribute admin handlers under its namespace
// (docs/decisions/server-user-admin.md).
type AdminSettings struct {
	// Socket is the path of a unix domain socket serving the admin API over
	// plain HTTP. Possession IS the authorization — file permissions (or
	// pods/exec RBAC) gate it, no token involved. Empty serves no socket.
	Socket string `mapstructure:"socket"`
}

type TLSConfig struct {
	Cert string `mapstructure:"cert"`
	Key  string `mapstructure:"key"`
	CA   string `mapstructure:"ca"`
}

// AuthSettings is the file/flag shape of authentication; `Mode` is parsed
// through ParseAuthMode at validation so a typo refuses to start. GLOBAL,
// because every process reads it: the mode and the shared key are what let
// each verify locally. The auth subsystem's own STATE lives in AuthConfig.
type AuthSettings struct {
	Mode       string        `mapstructure:"mode"`
	SessionKey string        `mapstructure:"session-key"`
	TokenTTL   time.Duration `mapstructure:"token-ttl"`
	SessionTTL time.Duration `mapstructure:"session-ttl"`
	// Admins are LOGIN NAMES whose sessions carry the admin claim, checked
	// at login by the process holding the registry. Global (not AuthConfig)
	// because it is policy an operator writes, not state a process keeps.
	Admins []string `mapstructure:"admins"`
}

// Services are the peer addresses for split deployments — static on purpose:
// addresses are configuration (or the platform's DNS), capabilities are
// self-description; nobody guesses, nobody registers. Empty means "expected
// co-resident". Validated against each peer's /v1/capabilities at startup by
// whoever needs it (see docs/design/access-control.md and the bake
// decoupling plan).
type Services struct {
	Worlds    string `mapstructure:"worlds"`
	Artifacts string `mapstructure:"artifacts"`
}

// Storage is a TAGGED UNION, Kubernetes-volume-source style: `type` names
// the one backend block that must be present, and FOREIGN blocks must be
// absent — `type: dir` beside a configured s3 block is almost always a
// copy-paste accident and refuses to start. `dir` is the only implemented
// backend; the shape reserves room for s3 (which, honestly, will not be a
// mere backend swap: the artifact store's mtime index and both stores'
// rename atomicity are filesystem semantics).
type Storage struct {
	Type string      `mapstructure:"type"`
	Dir  *DirStorage `mapstructure:"dir"`
}

type DirStorage struct {
	Path string `mapstructure:"path"`
}

// Validate checks the union rules. `section` names the owner for messages.
func (s Storage) Validate(section string) error {
	kind := s.Type
	if kind == "" {
		// Type may be omitted when exactly one backend block says it all.
		if s.Dir != nil {
			kind = "dir"
		}
	}
	switch kind {
	case "":
		return fmt.Errorf("%s.storage: no backend configured (set %s.storage.dir.path)", section, section)
	case "dir":
		if s.Dir == nil || s.Dir.Path == "" {
			return fmt.Errorf("%s.storage: type dir needs %s.storage.dir.path", section, section)
		}
		return nil
	default:
		return fmt.Errorf("%s.storage.type: unknown backend %q (implemented: dir)", section, kind)
	}
}

// DirPath returns the directory path of a dir-backed storage. Call after
// Validate — an unvalidated union answers with an empty string.
func (s Storage) DirPath() string {
	if s.Dir == nil {
		return ""
	}
	return s.Dir.Path
}

type WorldConfig struct {
	Storage       Storage `mapstructure:"storage"`
	KeepRevisions int     `mapstructure:"keep-revisions"`
}

type ArtifactsConfig struct {
	Storage Storage `mapstructure:"storage"`
	// Cap is the human form ("50GB"); parse with ParseByteSize. Kept as the
	// string so the value in `casas-eternas start --help`, the file and the
	// error messages all read the same.
	Cap string `mapstructure:"cap"`
}

type BakeConfig struct {
	Baker         string `mapstructure:"baker"`
	MaxConcurrent int    `mapstructure:"max-concurrent"`
}

type ClientConfig struct {
	Storage Storage `mapstructure:"storage"`
}

// DocsConfig is the documentation site's section: the built static site
// (npm run build:docs) the docs module serves under /docs/.
type DocsConfig struct {
	Storage Storage `mapstructure:"storage"`
}

// AuthConfig is the auth SUBSYSTEM's own section — state only the process
// running login touches, today the user registry (users.json). Shaped like
// every other target section (storage union) because that is what auth is on
// its way to becoming — docs/design/access-control.md, "an auth target".
// Distinct from Global.Auth, which every process reads.
type AuthConfig struct {
	Storage Storage `mapstructure:"storage"`
}

// Server projects the process-wide transport settings into the shape
// server.Run consumes.
func (g Global) Server() Server {
	return Server{Listen: g.Listen, TLSCert: g.TLS.Cert, TLSKey: g.TLS.Key, TLSCA: g.TLS.CA, AdminSocket: g.Admin.Socket}
}

// Validate checks everything that does not depend on which targets run;
// target-scoped storage is validated by the caller for SELECTED targets
// only, so a world-only deployment does not have to configure artifact
// storage it will never touch.
func (c Config) Validate() error {
	if err := c.Global.Server().Validate(); err != nil {
		return err
	}
	if _, err := ParseAuthMode(c.Global.Auth.Mode); err != nil {
		return err
	}
	if _, err := ParseByteSize(c.Artifacts.Cap); err != nil {
		return fmt.Errorf("artifacts.cap: %w", err)
	}
	return nil
}
