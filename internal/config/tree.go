package config

import (
	"fmt"
	"net/url"
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
	Jobs      JobsConfig      `mapstructure:"jobs"`
	Client    ClientConfig    `mapstructure:"client"`
	Auth      AuthConfig      `mapstructure:"auth"`
	Docs      DocsConfig      `mapstructure:"docs"`
	Relay     RelayConfig     `mapstructure:"relay"`
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
	// The relay (message bus) when it is not co-resident: a NATS URL, e.g.
	// nats://relay:4222. Empty expects it in this process.
	Relay string `mapstructure:"relay"`
}

// ObjectStorage is the TAGGED UNION of the two stores that hold objects,
// world and artifacts (docs/decisions/object-storage.md, DEC-0038): `type`
// names the one backend block that must be present, and a FOREIGN block
// refuses to start. `type` is REQUIRED — no backend is inferred from a
// block. It is a flag with the default `dir`, so an s3 block without
// `type: s3` meets `type: dir` and is refused with a message that says so.
// The flag default of `dir.path` is not a block: cmd/ keeps Dir only where
// the path was set, or where the type is dir.
//
// Both stores run on both backends (artifacts since DEC-0038 step 3, the
// world store since step 5).
type ObjectStorage struct {
	Type string      `mapstructure:"type"`
	Dir  *DirStorage `mapstructure:"dir"`
	S3   *S3Storage  `mapstructure:"s3"`
}

type DirStorage struct {
	Path string `mapstructure:"path"`
}

// S3Storage is the s3 backend's block (DEC-0038, fork 3). The key pair is
// given as paths to files, never as values in the configuration file.
type S3Storage struct {
	// Flavour selects the provider's row of the capability table.
	Flavour  string `mapstructure:"flavour"`
	Region   string `mapstructure:"region"`
	Endpoint string `mapstructure:"endpoint"`
	Bucket   string `mapstructure:"bucket"`
	Prefix   string `mapstructure:"prefix"`
	// The files that hold the access key id and the secret key.
	AccessKeyFile string `mapstructure:"access-key-file"`
	SecretKeyFile string `mapstructure:"secret-key-file"`
}

// The S3 flavours, one per row of the capability table.
const (
	FlavourAWS  = "aws"
	FlavourCeph = "ceph"
)

// Validate checks the union rules. `section` names the owner for messages.
func (s ObjectStorage) Validate(section string) error {
	key := section + ".storage"
	switch s.Type {
	case "":
		return fmt.Errorf("%s.type is required (dir or s3)", key)
	case "dir":
		if s.S3 != nil {
			return fmt.Errorf("%s.s3 is set, but %s.type is dir — set %s.type: s3 (the backend is never inferred from a block)", key, key, key)
		}
		if s.Dir == nil || s.Dir.Path == "" {
			return fmt.Errorf("%s: type dir needs %s.dir.path", key, key)
		}
		return nil
	case "s3":
		if s.Dir != nil {
			return fmt.Errorf("%s.dir is set beside %s.type s3 — remove one of them", key, key)
		}
		if s.S3 == nil {
			return fmt.Errorf("%s: type s3 needs the %s.s3 block", key, key)
		}
		return s.S3.validate(key + ".s3")
	default:
		return fmt.Errorf("%s.type: unknown backend %q (dir or s3)", key, s.Type)
	}
}

func (s S3Storage) validate(key string) error {
	switch s.Flavour {
	case FlavourAWS:
		if s.Endpoint != "" {
			return fmt.Errorf("%s.endpoint: not for flavour aws (the endpoint comes from %s.region)", key, key)
		}
		if s.Region == "" {
			return fmt.Errorf("%s.region: flavour aws needs the bucket's region", key)
		}
	case FlavourCeph:
		if s.Endpoint == "" {
			return fmt.Errorf("%s.endpoint: flavour ceph needs the provider's endpoint", key)
		}
		if err := checkS3Endpoint(key, s.Endpoint); err != nil {
			return err
		}
	case "":
		return fmt.Errorf("%s.flavour is required (%s or %s)", key, FlavourAWS, FlavourCeph)
	default:
		return fmt.Errorf("%s.flavour: unknown flavour %q (%s or %s)", key, s.Flavour, FlavourAWS, FlavourCeph)
	}
	if s.Bucket == "" {
		return fmt.Errorf("%s.bucket is required", key)
	}
	if (s.AccessKeyFile == "") != (s.SecretKeyFile == "") {
		return fmt.Errorf("%s: set access-key-file and secret-key-file together", key)
	}
	return nil
}

// checkS3Endpoint refuses an endpoint that is not an https:// URL with a
// host. Over plain HTTP the S3 client must hash the whole body before it
// sends it, and it cannot do that with a body that does not seek (an
// upload that goes through the server): such an endpoint would start and
// then refuse every upload (measured 2026-10-16, DEC-0038). Every real
// provider speaks HTTPS.
func checkS3Endpoint(key, endpoint string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return fmt.Errorf("%s.endpoint %q: must be an https:// URL — over plain http the S3 client cannot upload a streamed body", key, endpoint)
	}
	return nil
}

// DirPath returns the directory path of a dir-backed storage. Call after
// Validate — an unvalidated union answers with an empty string.
func (s ObjectStorage) DirPath() string {
	if s.Dir == nil {
		return ""
	}
	return s.Dir.Path
}

// RequireDir checks a plain directory setting (a state-dir): the modules that
// need a filesystem have no union, because their shape must not suggest
// that s3 is possible (DEC-0038, fork 1). `key` is the full dotted key.
func RequireDir(key, path string) error {
	if path == "" {
		return fmt.Errorf("%s: a directory is required", key)
	}
	return nil
}

type WorldConfig struct {
	Storage       ObjectStorage `mapstructure:"storage"`
	KeepRevisions int           `mapstructure:"keep-revisions"`
	// The lifetime of the link a read of a zip or a preview is redirected
	// to, and the file with the key the dir backend signs that link with
	// (DEC-0038, fork 4: the same keys as artifacts', since 2026-10-16).
	ReadLinkTTL time.Duration `mapstructure:"read-link-ttl"`
	LinkKey     string        `mapstructure:"link-key"`
	// The previous key file of a key change-over: links signed with it are
	// still accepted; new ones are signed with LinkKey (2026-10-16).
	LinkKeyPrevious string `mapstructure:"link-key-previous"`
}

type ArtifactsConfig struct {
	Storage ObjectStorage `mapstructure:"storage"`
	// Cap is the human form ("50GB"); parse with ParseByteSize. Kept as the
	// string so the value in `casas-eternas start --help`, the file and the
	// error messages all read the same.
	Cap string `mapstructure:"cap"`
	// The lifetimes of the links the module gives for a read and for a
	// write, and the file with the key the dir backend signs its own links
	// with (DEC-0038, fork 4; module settings, because they hold for both
	// backends). The read lifetime and the key are used since DEC-0038 step
	// 3, the write lifetime since step 4.
	ReadLinkTTL  time.Duration `mapstructure:"read-link-ttl"`
	WriteLinkTTL time.Duration `mapstructure:"write-link-ttl"`
	LinkKey      string        `mapstructure:"link-key"`
	// The previous key file of a key change-over, as for world.
	LinkKeyPrevious string `mapstructure:"link-key-previous"`
}

type JobsConfig struct {
	Worker        string `mapstructure:"worker"`
	MaxConcurrent int    `mapstructure:"max-concurrent"`
	// The coordinator's state: jobs, their tasks and where each stands
	// (bbolt, jobs.db; docs/decisions/detail-ladder.md).
	StateDir string `mapstructure:"state-dir"`
}

// ClientConfig is the client module's section: the built bundle it serves.
// Empty serves only /config.json (the dev run beside vite).
type ClientConfig struct {
	ContentDir string `mapstructure:"content-dir"`
}

// DocsConfig is the documentation site's section: the built static site
// (npm run build:docs) the docs module serves under /docs/. Empty serves
// nothing.
type DocsConfig struct {
	ContentDir string `mapstructure:"content-dir"`
}

// RelayConfig is the message bus's section (docs/decisions/detail-ladder.md,
// fork 8): JetStream's store and the port the workers connect to.
type RelayConfig struct {
	StateDir string `mapstructure:"state-dir"`
	Listen   string `mapstructure:"listen"`
}

// AuthConfig is the auth SUBSYSTEM's own section — state only the process
// running login touches, today the credential registry (bbolt, auth.db) and
// the avatars beside it. Distinct from Global.Auth, which every process
// reads.
type AuthConfig struct {
	StateDir string `mapstructure:"state-dir"`
}

// Server projects the process-wide transport settings into the shape
// server.Run consumes.
func (g Global) Server() Server {
	return Server{Listen: g.Listen, TLSCert: g.TLS.Cert, TLSKey: g.TLS.Key, AdminSocket: g.Admin.Socket}
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
	if c.World.ReadLinkTTL < 0 {
		return fmt.Errorf("world.read-link-ttl: %v is negative", c.World.ReadLinkTTL)
	}
	if c.Artifacts.ReadLinkTTL < 0 {
		return fmt.Errorf("artifacts.read-link-ttl: %v is negative", c.Artifacts.ReadLinkTTL)
	}
	if c.Artifacts.WriteLinkTTL < 0 {
		return fmt.Errorf("artifacts.write-link-ttl: %v is negative", c.Artifacts.WriteLinkTTL)
	}
	return nil
}
