// Package config holds the resolved configuration the modules run on.
//
// It deliberately imports neither cobra nor viper. Flag names, environment
// variables and defaults are cmd/'s business; everything below this line sees
// plain values it can be tested against without building a command line. That
// boundary is the reason a module never needs to know what its flag is called.
package config

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Target names a module that `start` can run. They are the values of `--target`,
// so they are user-facing surface: renaming one breaks deployment manifests and
// container environments, not just code.
type Target string

const (
	// TargetAll is not a module — it is the shorthand that selects every one.
	TargetAll       Target = "all"
	TargetClient    Target = "client"
	TargetWorld     Target = "world"
	TargetArtifacts Target = "artifacts"
	TargetJobs      Target = "jobs"
	TargetDocs      Target = "docs"
	// TargetAuth is the login process: the one that opens the credential
	// store and serves /v1/auth/session. Every OTHER process still verifies
	// tokens locally over the shared key; this target is where they are
	// issued and where users are administered. In the local mode (`none`)
	// it has nothing to do and contributes no module. Added 2026-08-13,
	// docs/decisions/server-user-admin.md.
	TargetAuth Target = "auth"
)

// modules lists the real targets, in the order they are reported to the user.
// TargetAll is absent on purpose: it expands to this, so having it in the list
// would let "all" select itself.
var modules = []Target{TargetClient, TargetWorld, TargetArtifacts, TargetJobs, TargetDocs, TargetAuth}

// Targets is a resolved selection: every module that should run.
type Targets map[Target]bool

// Has reports whether the module was selected.
func (t Targets) Has(m Target) bool { return t[m] }

// Names returns the selected modules in a stable order, for logging.
func (t Targets) Names() []string {
	out := make([]string, 0, len(t))
	for m := range t {
		out = append(out, string(m))
	}
	sort.Strings(out)
	return out
}

// ParseTargets resolves the raw --target values.
//
// An empty selection is an ERROR rather than an implicit "all": with `all`
// available as a one-word shorthand, starting nothing is far more likely to be
// a mistake than an intention, and a process that silently does nothing is the
// worse failure mode. Unknown names fail for the same reason — a typo that
// starts no modules would otherwise look exactly like a healthy server.
func ParseTargets(raw []string) (Targets, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("no target selected; valid targets: %s", strings.Join(ValidTargets(), ", "))
	}
	selected := Targets{}
	for _, value := range raw {
		switch target := Target(strings.TrimSpace(value)); target {
		case TargetAll:
			for _, m := range modules {
				selected[m] = true
			}
		case TargetClient, TargetWorld, TargetArtifacts, TargetJobs, TargetDocs, TargetAuth:
			selected[target] = true
		default:
			return nil, fmt.Errorf("unknown target %q; valid targets: %s", value, strings.Join(ValidTargets(), ", "))
		}
	}
	return selected, nil
}

// ValidTargets lists every value `-t` accepts, `all` first. EXPORTED so the
// flag's help text and its shell completion render from the same list the
// parser enforces — a target added here appears everywhere at once, which is
// the one-vocabulary rule applied to an enumeration.
func ValidTargets() []string {
	names := make([]string, 0, len(modules)+1)
	names = append(names, string(TargetAll))
	for _, m := range modules {
		names = append(names, string(m))
	}
	return names
}

// AuthMode is how the server establishes who is asking. The values are
// user-facing surface — they are what `global.auth.mode` takes and what the client is
// told in /config.json — so renaming one breaks deployments, not just code.
//
// The axis is WHERE THE USERS LIVE, not what the request header looks like:
// `password` and `oidc` both arrive as `Authorization: Bearer`, and the
// difference that matters is who issued the token and who can verify it. The
// middle value was called `token` until 2026-08-09, which named the header
// instead of the question. See docs/decisions/server-auth.md.
type AuthMode string

const (
	// AuthNone is the LOCAL mode, and that is a definition rather than a
	// default: a synthetic identity owns everything, so nobody else can be
	// present and there is nothing to protect anyone from.
	AuthNone AuthMode = "none"
	// AuthPassword: this server holds the user database (auth.db, under
	// auth.storage), and logging in exchanges credentials for a token it
	// issues itself.
	AuthPassword AuthMode = "password"
	// AuthOIDC: a foreign identity provider holds the users. It is a second
	// LOGIN METHOD rather than a second token — the session it produces is
	// still issued here, so the API only ever sees one kind.
	AuthOIDC AuthMode = "oidc"
)

// authModes lists them in the order they are reported to the user, which is
// also least to most machinery.
var authModes = []AuthMode{AuthNone, AuthPassword, AuthOIDC}

// DefaultAuthMode is what the server runs as unless `global.auth.mode` says otherwise.
// Kept here rather than in the module that reports it, so the value the client
// is TOLD and the value the server ENFORCES cannot differ.
const DefaultAuthMode = AuthNone

// ParseAuthMode resolves the raw `global.auth.mode` value.
//
// Unknown values FAIL rather than falling back to the default, and that is the
// whole point of the function: ChecksIdentity treats anything that is not
// `none` as a mode that checks, so a typo would not start an unprotected
// server — it would start one that refuses everybody, which looks like a
// permission bug rather than a misconfiguration. Loud beats either.
func ParseAuthMode(raw string) (AuthMode, error) {
	switch mode := AuthMode(strings.TrimSpace(raw)); mode {
	case AuthNone, AuthPassword, AuthOIDC:
		return mode, nil
	default:
		return "", fmt.Errorf("unknown auth mode %q; valid modes: %s", raw, strings.Join(ValidAuthModes(), ", "))
	}
}

// ValidAuthModes lists every value `global.auth.mode` accepts, least to most
// machinery — exported for the same reason as ValidTargets.
func ValidAuthModes() []string {
	names := make([]string, 0, len(authModes))
	for _, m := range authModes {
		names = append(names, string(m))
	}
	return names
}

// ChecksIdentity reports whether authorisation decisions mean anything. The
// one place callers should ask, so "is this the local mode" is never spelled
// out as a comparison in three different files.
func (m AuthMode) ChecksIdentity() bool { return m != AuthNone && m != "" }

// ParseByteSize resolves a human size ("50GB", "500 MB", "1.5TB", bare bytes)
// into bytes. Empty and "0" mean zero — which `artifacts.cap` reads as
// "unlimited". Decimal units (kB = 1000), matching how the panels report
// sizes; a cap is a budget, not an allocator.
func ParseByteSize(raw string) (int64, error) {
	text := strings.TrimSpace(strings.ToUpper(raw))
	if text == "" {
		return 0, nil
	}
	units := []struct {
		suffix string
		factor float64
	}{
		{"TB", 1e12}, {"GB", 1e9}, {"MB", 1e6}, {"KB", 1e3}, {"B", 1},
	}
	factor := 1.0
	for _, unit := range units {
		if strings.HasSuffix(text, unit.suffix) {
			factor = unit.factor
			text = strings.TrimSpace(strings.TrimSuffix(text, unit.suffix))
			break
		}
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || value < 0 {
		return 0, fmt.Errorf("not a size: %q (examples: 50GB, 500MB, 0 for unlimited)", raw)
	}
	return int64(value * factor), nil
}

// Server is the process-wide transport configuration — the part that belongs to
// the process rather than to any one module, which is why its flags are
// persistent on the root command.
type Server struct {
	// Listen is a host:port address. A bare ":8080" binds every interface;
	// "127.0.0.1:8080" keeps a local instance off the network.
	Listen string

	// TLSCert and TLSKey enable HTTPS when both are set.
	TLSCert string
	TLSKey  string

	// TLSCA is the certificate authority used to verify CLIENT certificates.
	// Setting it turns on mutual TLS; serving plain HTTPS needs only the pair
	// above.
	TLSCA string

	// AdminSocket is the unix-socket path of the local admin channel; empty
	// serves none. Plain HTTP, no TLS, no gate: reaching the socket IS the
	// authorization (docs/decisions/server-user-admin.md).
	AdminSocket string
}

// TLSEnabled reports whether the server should serve HTTPS.
func (s Server) TLSEnabled() bool { return s.TLSCert != "" && s.TLSKey != "" }

// Validate catches the half-configured cases early, where the message can still
// name the setting that is missing.
func (s Server) Validate() error {
	if s.Listen == "" {
		return fmt.Errorf("global.listen must not be empty")
	}
	if (s.TLSCert == "") != (s.TLSKey == "") {
		return fmt.Errorf("global.tls.cert and global.tls.key must be given together")
	}
	if s.TLSCA != "" && !s.TLSEnabled() {
		return fmt.Errorf("global.tls.ca requires global.tls.cert and global.tls.key")
	}
	return nil
}
