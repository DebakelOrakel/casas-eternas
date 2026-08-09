package cmd

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"

	"github.com/DebakelOrakel/casas-eternas/internal/artifacts"
	"github.com/DebakelOrakel/casas-eternas/internal/auth"
	"github.com/DebakelOrakel/casas-eternas/internal/bake"
	"github.com/DebakelOrakel/casas-eternas/internal/client"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
	"github.com/DebakelOrakel/casas-eternas/internal/server"
	"github.com/DebakelOrakel/casas-eternas/internal/session"
	"github.com/DebakelOrakel/casas-eternas/internal/world"
)

// Start resolves the flags into plain configuration, builds the selected
// modules and hands them to the server.
//
// This function is the ONLY place viper is read on the way to a module: every
// package under internal/ takes a struct instead, so a module can be tested
// without a command line and never knows what its flag is called.
func Start(cmd *cobra.Command, args []string) error {
	targets, err := config.ParseTargets(viper.GetStringSlice(flagTarget))
	if err != nil {
		return err
	}

	srv := config.Server{
		Listen:  viper.GetString(flagListen),
		TLSCert: viper.GetString(flagTLSCert),
		TLSKey:  viper.GetString(flagTLSKey),
		TLSCA:   viper.GetString(flagTLSCA),
	}
	if err := srv.Validate(); err != nil {
		return err
	}

	modules, gate, err := buildModules(targets)
	if err != nil {
		return err
	}

	slog.Info("starting", "targets", targets.Names())
	return server.Run(cmd.Context(), srv, modules, gate)
}

// buildModules constructs exactly the selected modules, in a fixed order so
// mounting and shutdown are reproducible rather than map-order dependent.
func buildModules(targets config.Targets) ([]server.Module, func(http.Handler) http.Handler, error) {
	var modules []server.Module

	// Resolved ONCE and handed to every module that needs it. Three modules
	// deciding independently what the flag said is how the value the client is
	// told drifts from the value the server enforces.
	authMode, err := config.ParseAuthMode(viper.GetString(flagAuthMode))
	if err != nil {
		return nil, nil, err
	}
	caller, login, err := buildAuth(authMode)
	if err != nil {
		return nil, nil, err
	}
	// Mounted whenever there is something to log in to, regardless of --target:
	// a deployment serving only the artifact store still has to let its callers
	// authenticate, and there is nowhere else to do it.
	if login != nil {
		modules = append(modules, login)
	}

	if targets.Has(config.TargetClient) {
		m, err := client.New(client.Config{Dir: viper.GetString(flagDirClient), AuthMode: authMode})
		if err != nil {
			return nil, nil, err
		}
		modules = append(modules, m)
	}
	if targets.Has(config.TargetWorld) {
		m, err := world.New(world.Config{Dir: viper.GetString(flagDirWorlds), Identity: caller})
		if err != nil {
			return nil, nil, err
		}
		modules = append(modules, m)
	}
	if targets.Has(config.TargetArtifacts) {
		m, err := artifacts.New(artifacts.Config{Dir: viper.GetString(flagDirArtifacts)})
		if err != nil {
			return nil, nil, err
		}
		modules = append(modules, m)
	}
	if targets.Has(config.TargetBake) {
		m, err := bake.New(bake.Config{
			WorldsDir:     viper.GetString(flagDirWorlds),
			ArtifactsDir:  viper.GetString(flagDirArtifacts),
			BakerPath:     bakerPath(),
			Identity:      caller,
			Listen:        viper.GetString(flagListen),
			MaxConcurrent: viper.GetInt(flagBakeMax),
		})
		if err != nil {
			return nil, nil, err
		}
		modules = append(modules, m)
	}
	// THE PUBLIC SURFACE, in one readable list. Everything else under /v1/ needs
	// a caller (see server.Gate). Named here because this is where every module
	// is already known — the server package deliberately knows about none of
	// them, and the alternative of repeating three string literals is how a path
	// stops being exempt without anyone deciding that it should.
	return modules, server.Gate(caller, []string{
		client.ConfigPath,       // where the API is and how to log in
		server.CapabilitiesPath, // "is this server answering", asked while logged out
		session.Path,            // the login endpoint itself
	}), nil
}

// bakerPath resolves --baker, defaulting to the bundle beside the binary.
//
// Beside the BINARY rather than beside the working directory: a server is
// started from wherever its data lives, and the bundle ships with the program.
func bakerPath() string {
	if configured := viper.GetString(flagBaker); configured != "" {
		return configured
	}
	executable, err := os.Executable()
	if err != nil {
		return "baker.mjs"
	}
	return filepath.Join(filepath.Dir(executable), "baker.mjs")
}

// buildAuth assembles what authentication needs: the process's one identity
// resolver, and the login module — which exists only in a mode that has
// something to log in to.
//
// A mode that CHECKS identity and cannot verify a token would attribute every
// request to nobody, which looks exactly like a permission bug from the outside.
// So every ingredient it needs is required here, at startup, where the message
// can name the missing flag.
func buildAuth(mode config.AuthMode) (*identity.Resolver, server.Module, error) {
	if !mode.ChecksIdentity() {
		return identity.NewResolver(mode, nil), nil, nil
	}

	if mode == config.AuthOIDC {
		// The declared, empty path: the mode parses and the resolver would
		// verify the tokens this server issues, but nothing issues them yet.
		return nil, nil, fmt.Errorf("--auth-mode %s is not implemented yet", mode)
	}

	// Users before the key, so a start that is going to fail fails BEFORE
	// warning about something else. Warning about an ephemeral signing key and
	// then refusing to start for an unrelated reason sends the reader after the
	// wrong problem.
	users, err := auth.NewUsers(viper.GetString(flagAuthHtpasswd))
	if err != nil {
		return nil, nil, fmt.Errorf("--%s: %w", flagAuthHtpasswd, err)
	}

	key, err := signingKey()
	if err != nil {
		return nil, nil, err
	}
	tokens, err := auth.NewTokens(key)
	if err != nil {
		return nil, nil, err
	}
	resolver := identity.NewResolver(mode, tokens)
	login, err := session.New(session.Config{
		Users:  users,
		Tokens: tokens,
		TTL:    viper.GetDuration(flagAuthTokenTTL),
	})
	if err != nil {
		return nil, nil, err
	}
	slog.Info("authentication ready", "mode", mode, "users", users.Path(), "token ttl", viper.GetDuration(flagAuthTokenTTL))
	return resolver, login, nil
}

// signingKey reads the configured key, or makes an ephemeral one and says so.
//
// Generating rather than refusing keeps a single local server easy to start.
// Saying so loudly is the other half: the consequences — sessions lost on
// restart, replicas that reject each other's tokens — are invisible until they
// bite, and by then they look like a bug rather than a missing flag.
func signingKey() ([]byte, error) {
	if path := viper.GetString(flagAuthKey); path != "" {
		return auth.ReadKey(path)
	}
	key, err := auth.GenerateKey()
	if err != nil {
		return nil, err
	}
	slog.Warn("no signing key configured, generated an ephemeral one",
		"flag", "--"+flagAuthKey,
		"consequence", "sessions end at restart, and replicas will not accept each other's tokens")
	return key, nil
}
