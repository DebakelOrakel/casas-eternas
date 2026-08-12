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

// Start resolves file, environment and flags into the one typed configuration
// tree, builds the selected modules and hands them to the server.
//
// This function (through loadConfig) is the ONLY place viper is read on the
// way to a module: every package under internal/ takes the tree instead, so a
// module can be tested without a command line and never knows what its flag
// is called.
func Start(cmd *cobra.Command, args []string) error {
	targets, err := config.ParseTargets(viper.GetStringSlice(flagTarget))
	if err != nil {
		return err
	}

	cfg, err := loadConfig()
	if err != nil {
		return err
	}

	modules, gate, err := buildModules(targets, cfg)
	if err != nil {
		return err
	}

	slog.Info("starting", "targets", targets.Names())
	return server.Run(cmd.Context(), cfg.Global.Server(), modules, gate)
}

// buildModules constructs exactly the selected modules, in a fixed order so
// mounting and shutdown are reproducible rather than map-order dependent.
//
// Target-scoped validation happens here, for SELECTED targets only: a
// world-only deployment does not have to configure artifact storage it will
// never touch.
func buildModules(targets config.Targets, cfg config.Config) ([]server.Module, func(http.Handler) http.Handler, error) {
	var modules []server.Module

	// Resolved ONCE and handed to every module that needs it. Three modules
	// deciding independently what the setting said is how the value the client
	// is told drifts from the value the server enforces.
	authMode, err := config.ParseAuthMode(cfg.Global.Auth.Mode)
	if err != nil {
		return nil, nil, err
	}
	caller, tokens, login, err := buildAuth(authMode, cfg)
	if err != nil {
		return nil, nil, err
	}
	// Mounted whenever there is something to log in to, regardless of --target:
	// a deployment serving only the artifact store still has to let its callers
	// authenticate, and there is nowhere else to do it.
	// The client is told where to log in only when something is listening there.
	loginPath := ""
	if login != nil {
		modules = append(modules, login)
		loginPath = session.Path
	}

	if targets.Has(config.TargetClient) {
		m, err := client.New(client.Config{All: cfg, LoginPath: loginPath})
		if err != nil {
			return nil, nil, err
		}
		modules = append(modules, m)
	}
	// The world STORE outlives the if below: when bake runs co-resident, its
	// world accessors are closures over this same store, so the per-world
	// locks and the layout have one owner in the process.
	var worldStore *world.Store
	if targets.Has(config.TargetWorld) {
		if err := cfg.World.Storage.Validate("world"); err != nil {
			return nil, nil, err
		}
		m, err := world.New(world.Config{All: cfg, Identity: caller})
		if err != nil {
			return nil, nil, err
		}
		worldStore = m.Store()
		modules = append(modules, m)
	}
	if targets.Has(config.TargetArtifacts) {
		if err := cfg.Artifacts.Storage.Validate("artifacts"); err != nil {
			return nil, nil, err
		}
		m, err := artifacts.New(artifacts.Config{All: cfg})
		if err != nil {
			return nil, nil, err
		}
		modules = append(modules, m)
	}
	if targets.Has(config.TargetBake) {
		// Bake still reads the world and artifacts sections — the remaining
		// cross-module coupling its decoupling (A3) removes; keeping the
		// reads HERE makes the coupling visible at the composition root
		// rather than buried in the module.
		if err := cfg.Artifacts.Storage.Validate("artifacts"); err != nil {
			return nil, nil, fmt.Errorf("bake needs the artifact storage until its decoupling lands: %w", err)
		}
		store := worldStore
		if store == nil {
			// `-t bake` without `-t world`: no world module runs, but the bake
			// still needs the saves. Opening the store here (same package,
			// same layout owner) is the stopgap; A3 replaces it with HTTP via
			// global.services.worlds.
			if err := cfg.World.Storage.Validate("world"); err != nil {
				return nil, nil, fmt.Errorf("bake needs the world storage until its decoupling lands: %w", err)
			}
			var err error
			store, err = world.NewStore(cfg.World.Storage.DirPath(), cfg.World.KeepRevisions)
			if err != nil {
				return nil, nil, fmt.Errorf("world.storage: %w", err)
			}
		}
		m, err := bake.New(bake.Config{
			WorldOwner: func(uid string) (string, bool) {
				meta, err := store.Get(uid)
				return meta.Owner, err == nil && meta.Revision >= 1
			},
			WorldZip: func(uid string) (string, bool) {
				path, err := store.CurrentZipPath(uid)
				return path, err == nil
			},
			ArtifactsDir:  cfg.Artifacts.Storage.DirPath(),
			BakerPath:     bakerPath(cfg.Bake.Baker),
			Identity:      caller,
			Tokens:        tokens,
			Listen:        cfg.Global.Listen,
			MaxConcurrent: cfg.Bake.MaxConcurrent,
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

// bakerPath resolves bake.baker, defaulting to the bundle beside the binary.
//
// Beside the BINARY rather than beside the working directory: a server is
// started from wherever its data lives, and the bundle ships with the program.
func bakerPath(configured string) string {
	if configured != "" {
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
// can name the missing setting.
func buildAuth(mode config.AuthMode, cfg config.Config) (*identity.Resolver, *auth.Tokens, server.Module, error) {
	if !mode.ChecksIdentity() {
		// No issuer either: a Job talking to a server that checks nobody needs
		// no credential, and handing it one would be a token nothing verifies.
		return identity.NewResolver(mode, nil), nil, nil, nil
	}

	if mode == config.AuthOIDC {
		// The declared, empty path: the mode parses and the resolver would
		// verify the tokens this server issues, but nothing issues them yet.
		return nil, nil, nil, fmt.Errorf("auth mode %s is not implemented yet", mode)
	}

	// Users before the key, so a start that is going to fail fails BEFORE
	// warning about something else. Warning about an ephemeral signing key and
	// then refusing to start for an unrelated reason sends the reader after the
	// wrong problem.
	users, err := auth.NewUsers(cfg.Global.Auth.Htpasswd)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("%s: %w", keyAuthHtpass, err)
	}

	key, err := signingKey(cfg.Global.Auth.SessionKey)
	if err != nil {
		return nil, nil, nil, err
	}
	tokens, err := auth.NewTokens(key)
	if err != nil {
		return nil, nil, nil, err
	}
	resolver := identity.NewResolver(mode, tokens)
	login, err := session.New(session.Config{
		Users:  users,
		Tokens: tokens,
		TTL:    cfg.Global.Auth.TokenTTL,
	})
	if err != nil {
		return nil, nil, nil, err
	}
	slog.Info("authentication ready", "mode", mode, "users", users.Path(), "token ttl", cfg.Global.Auth.TokenTTL)
	return resolver, tokens, login, nil
}

// signingKey reads the configured key, or makes an ephemeral one and says so.
//
// Generating rather than refusing keeps a single local server easy to start.
// Saying so loudly is the other half: the consequences — sessions lost on
// restart, replicas that reject each other's tokens — are invisible until they
// bite, and by then they look like a bug rather than a missing setting.
func signingKey(path string) ([]byte, error) {
	if path != "" {
		return auth.ReadKey(path)
	}
	key, err := auth.GenerateKey()
	if err != nil {
		return nil, err
	}
	slog.Warn("no signing key configured, generated an ephemeral one",
		"setting", keyAuthKey,
		"consequence", "sessions end at restart, and replicas will not accept each other's tokens")
	return key, nil
}
