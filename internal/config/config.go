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
	"strings"
)

// Target names a module that `start` can run. They are the values of --target,
// so they are user-facing surface: renaming one breaks deployment manifests and
// container environments, not just code.
type Target string

const (
	// TargetAll is not a module — it is the shorthand that selects every one.
	TargetAll       Target = "all"
	TargetClient    Target = "client"
	TargetWorld     Target = "world"
	TargetArtifacts Target = "artifacts"
	TargetBake      Target = "bake"
)

// modules lists the real targets, in the order they are reported to the user.
// TargetAll is absent on purpose: it expands to this, so having it in the list
// would let "all" select itself.
var modules = []Target{TargetClient, TargetWorld, TargetArtifacts, TargetBake}

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
		return nil, fmt.Errorf("no target selected; valid targets: %s", validTargets())
	}
	selected := Targets{}
	for _, value := range raw {
		switch target := Target(strings.TrimSpace(value)); target {
		case TargetAll:
			for _, m := range modules {
				selected[m] = true
			}
		case TargetClient, TargetWorld, TargetArtifacts, TargetBake:
			selected[target] = true
		default:
			return nil, fmt.Errorf("unknown target %q; valid targets: %s", value, validTargets())
		}
	}
	return selected, nil
}

func validTargets() string {
	names := make([]string, 0, len(modules)+1)
	names = append(names, string(TargetAll))
	for _, m := range modules {
		names = append(names, string(m))
	}
	return strings.Join(names, ", ")
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
}

// TLSEnabled reports whether the server should serve HTTPS.
func (s Server) TLSEnabled() bool { return s.TLSCert != "" && s.TLSKey != "" }

// Validate catches the half-configured cases early, where the message can still
// name the flag that is missing.
func (s Server) Validate() error {
	if s.Listen == "" {
		return fmt.Errorf("--listen must not be empty")
	}
	if (s.TLSCert == "") != (s.TLSKey == "") {
		return fmt.Errorf("--tls-cert and --tls-key must be given together")
	}
	if s.TLSCA != "" && !s.TLSEnabled() {
		return fmt.Errorf("--tls-ca requires --tls-cert and --tls-key")
	}
	return nil
}
