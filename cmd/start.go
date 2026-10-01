package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	natsserver "github.com/nats-io/nats-server/v2/server"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
	"github.com/DebakelOrakel/casas-eternas/internal/modules/artifacts"
	"github.com/DebakelOrakel/casas-eternas/internal/modules/auth"
	"github.com/DebakelOrakel/casas-eternas/internal/modules/client"
	"github.com/DebakelOrakel/casas-eternas/internal/modules/docs"
	"github.com/DebakelOrakel/casas-eternas/internal/modules/jobs"
	relaymodule "github.com/DebakelOrakel/casas-eternas/internal/modules/relay"
	"github.com/DebakelOrakel/casas-eternas/internal/modules/world"
	"github.com/DebakelOrakel/casas-eternas/internal/relay"
	"github.com/DebakelOrakel/casas-eternas/internal/server"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
	"github.com/DebakelOrakel/casas-eternas/internal/user"
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
	return server.Run(cmd.Context(), cfg.Global.Server(), buildVersion, modules, gate)
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
	// Login is the auth TARGET's job (2026-08-13, server-user-admin.md): only
	// the process running it opens the credential store; every process still
	// verifies tokens locally through the resolver below. The store opens
	// FIRST so a start that is going to fail fails before the signing-key
	// warning sends the reader after the wrong problem.
	var registry *user.Registry
	if targets.Has(config.TargetAuth) && authMode.ChecksIdentity() {
		registry, err = openCredentials(cfg)
		if err != nil {
			return nil, nil, err
		}
	} else if targets.Has(config.TargetAuth) {
		slog.Info("auth target selected, but nothing to log in to", "mode", authMode)
	}
	// Once the auth module owns the registry (below), its Close releases the
	// store's lock on shutdown. Until then every failed return here must, or
	// the bbolt lock outlives the failed start for an in-process caller —
	// one deferred close for all of them, disarmed when the wiring succeeds.
	wired := false
	// The relay, when this process runs it: started before the modules that
	// connect to it, and stopped again (store and port released) when the
	// wiring fails after it.
	var relayModule *relaymodule.Module
	defer func() {
		if !wired && registry != nil {
			registry.Close()
		}
		if !wired && relayModule != nil {
			relayModule.Close()
		}
	}()
	if targets.Has(config.TargetRelay) {
		relayModule, err = relaymodule.New(relaymodule.Config{All: cfg})
		if err != nil {
			return nil, nil, err
		}
		modules = append(modules, relayModule)
	}

	caller, tokens, err := buildIdentity(authMode, cfg)
	if err != nil {
		return nil, nil, err
	}

	// The client is told where to log in only when something is listening
	// there; a split client-only process leaves it empty until the services
	// wiring (frontend-surfaces) teaches it the auth service's address.
	loginPath := ""
	if registry != nil {
		login, err := auth.New(auth.Config{
			Tokens:   tokens,
			TTL:      cfg.Global.Auth.TokenTTL,
			Registry: registry,
		})
		if err != nil {
			return nil, nil, err
		}
		modules = append(modules, login)
		loginPath = auth.Path
		slog.Info("authentication ready", "mode", authMode,
			"registry", cfg.Auth.Storage.DirPath(), "token ttl", cfg.Global.Auth.TokenTTL)
	}

	if targets.Has(config.TargetClient) {
		m, err := client.New(client.Config{All: cfg, LoginPath: loginPath})
		if err != nil {
			return nil, nil, err
		}
		modules = append(modules, m)
	}
	if targets.Has(config.TargetDocs) {
		m, err := docs.New(docs.Config{All: cfg})
		if err != nil {
			return nil, nil, err
		}
		modules = append(modules, m)
	}
	// The world MODULE outlives the if below: when artifacts or bake run
	// co-resident, their world ranking is a closure over this same module,
	// so the grants, the per-world locks and the layout have one owner in
	// the process.
	var worldModule *world.Module
	if targets.Has(config.TargetWorld) {
		if err := cfg.World.Storage.Validate("world"); err != nil {
			return nil, nil, err
		}
		// The migration rule for pre-registry worlds needs name→id; without a
		// registry (local mode) legacy worlds are admin-only, which the nil
		// closure expresses.
		var legacyOwner func(string) (string, bool)
		if registry != nil {
			legacyOwner = func(name string) (string, bool) {
				entry, ok := registry.ByName(name)
				return entry.ID, ok
			}
		}
		m, err := world.New(world.Config{All: cfg, Identity: caller, LegacyOwner: legacyOwner})
		if err != nil {
			return nil, nil, err
		}
		worldModule = m
		modules = append(modules, m)
	}
	// The ONE ranking closure artifacts and bake consult — local over the
	// co-resident world module, HTTP against global.services.worlds, or the
	// local-mode short circuit. Built once so the capability handshake runs
	// once and both consumers agree by construction.
	var rankWorld func(ctx context.Context, uid, bearer string) (bool, access.Level)
	if targets.Has(config.TargetArtifacts) || targets.Has(config.TargetJobs) {
		rankWorld, err = worldRanking(caller, worldModule, authMode, cfg.Global.Services.Worlds)
		if err != nil {
			return nil, nil, err
		}
	}
	if targets.Has(config.TargetArtifacts) {
		if err := cfg.Artifacts.Storage.Validate("artifacts"); err != nil {
			return nil, nil, err
		}
		m, err := artifacts.New(artifacts.Config{All: cfg, Identity: caller, WorldAccess: rankWorld})
		if err != nil {
			return nil, nil, err
		}
		modules = append(modules, m)
	}
	if targets.Has(config.TargetJobs) {
		bcfg, err := bakeConfig(targets, cfg, worldModule, rankWorld, caller, tokens)
		if err != nil {
			return nil, nil, err
		}
		// The bus the coordinator and its workers talk over: the relay in
		// this process, or the one global.services.relay names. A jobs target
		// needs one of the two (docs/decisions/detail-ladder.md, fork 8).
		var server *natsserver.Server
		bcfg.RelayURL = cfg.Global.Services.Relay
		if relayModule != nil {
			server = relayModule.Server()
			if bcfg.RelayURL == "" {
				bcfg.RelayURL = relayModule.URL()
			}
		}
		if err := cfg.Jobs.Storage.Validate("jobs"); err != nil {
			return nil, nil, err
		}
		bcfg.StorageDir = cfg.Jobs.Storage.DirPath()
		bcfg.Relay, err = relay.Connect("jobs", server, cfg.Global.Services.Relay)
		if err != nil {
			return nil, nil, fmt.Errorf("jobs: %w (run -t relay in this process or set global.services.relay)", err)
		}
		m, err := jobs.New(bcfg)
		if err != nil {
			bcfg.Relay.Close()
			return nil, nil, err
		}
		modules = append(modules, m)
	}
	// THE PUBLIC SURFACE, in one readable list. Everything else under /v1/ needs
	// a caller (see server.Gate). Named here because this is where every module
	// is already known — the server package deliberately knows about none of
	// them, and the alternative of repeating three string literals is how a path
	// stops being exempt without anyone deciding that it should.
	wired = true
	return modules, server.Gate(caller, []string{
		client.ConfigPath,       // where the API is and how to log in
		server.CapabilitiesPath, // "is this server answering", asked while logged out
		auth.Path,               // the login endpoint itself
	}), nil
}

// bakeConfig wires the bake module's two sides — where its worlds come from,
// where its artifacts go — from what ELSE this process runs. Each side on its
// own: co-resident store when the target is selected here, HTTP against the
// configured peer service when it is not. This is the composition that makes
// "a target must be able to run alone" true for bake.
func bakeConfig(targets config.Targets, cfg config.Config, worldModule *world.Module, rankWorld func(context.Context, string, string) (bool, access.Level), caller *identity.Resolver, tokens *token.Tokens) (jobs.Config, error) {
	inCluster := jobs.InCluster()
	selfURL := serverBaseURL(cfg.Global.Listen)
	if inCluster && selfURL == "" {
		return jobs.Config{}, fmt.Errorf("CASAS_POD_IP is not set: a cluster bake Job reaches this server by its pod IP (deploy/manifests.yaml wires it)")
	}
	bcfg := jobs.Config{
		WorkerPath:    workerPath(cfg.Jobs.Worker),
		Identity:      caller,
		Tokens:        tokens,
		SelfURL:       selfURL,
		MaxConcurrent: cfg.Jobs.MaxConcurrent,
	}

	// The ranking is the shared closure built in buildModules; what remains
	// here is where the BAKER reads the bytes from.
	bcfg.WorldAccess = rankWorld
	switch {
	case worldModule != nil:
		if inCluster {
			// The Job runs on another node and reaches this same server by IP.
			bcfg.WorldsURL = selfURL
		} else {
			store := worldModule.Store()
			bcfg.WorldZip = func(ctx context.Context, uid string) (string, bool) {
				path, err := store.CurrentZipPath(ctx, uid)
				return path, err == nil
			}
		}
	case cfg.Global.Services.Worlds != "":
		bcfg.WorldsURL = strings.TrimRight(cfg.Global.Services.Worlds, "/") + server.APIPrefix
	default:
		return jobs.Config{}, fmt.Errorf("jobs need a world source: select the world target too, or set global.services.worlds")
	}

	switch {
	case targets.Has(config.TargetArtifacts):
		// Already validated in the artifacts block above.
		if inCluster {
			bcfg.ArtifactsURL = selfURL
		} else {
			bcfg.ArtifactsDir = cfg.Artifacts.Storage.DirPath()
		}
	case cfg.Global.Services.Artifacts != "":
		base := strings.TrimRight(cfg.Global.Services.Artifacts, "/")
		if err := requireCapability(keySvcArts, base, "artifacts"); err != nil {
			return jobs.Config{}, err
		}
		bcfg.ArtifactsURL = base + server.APIPrefix
	default:
		return jobs.Config{}, fmt.Errorf("jobs need an artifact sink: select the artifacts target too, or set global.services.artifacts")
	}
	return bcfg, nil
}

// worldRanking builds the ONE closure artifacts and bake rank worlds with.
// Three compositions, decided by what else this process runs:
//
//   - co-resident world module: resolve the forwarded bearer locally (the
//     none-mode short circuit folds in here as admin) and ask AccessFor;
//   - global.services.worlds: forward the caller's own Authorization header
//     to the peer's meta endpoint — the service that OWNS the grants ranks
//     the caller and answers `callerLevel`, so grants never travel and no
//     service identity has to exist;
//   - neither, in the local MODE: everything ranks admin, because every
//     check answers yes there by design.
//
// Neither, in a CHECKING mode, is a refusal: a process that must rank
// callers against worlds it cannot see is misconfigured.
func worldRanking(resolver *identity.Resolver, worldModule *world.Module, mode config.AuthMode, servicesWorlds string) (func(ctx context.Context, uid, bearer string) (bool, access.Level), error) {
	if worldModule != nil {
		m := worldModule
		return func(ctx context.Context, uid, bearer string) (bool, access.Level) {
			callerID, admin := resolver.ResolveBearer(bearer)
			if !resolver.ChecksIdentity() {
				admin = true
			}
			return m.AccessFor(ctx, uid, callerID, admin)
		}, nil
	}
	if servicesWorlds != "" {
		base := strings.TrimRight(servicesWorlds, "/")
		if err := requireCapability(keySvcWorlds, base, "world"); err != nil {
			return nil, err
		}
		client := &http.Client{Timeout: 10 * time.Second}
		return func(ctx context.Context, uid, bearer string) (bool, access.Level) {
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, base+server.APIPrefix+"/worlds/"+url.PathEscape(uid)+"/meta", nil)
			if err != nil {
				return false, access.None
			}
			if bearer != "" {
				request.Header.Set("Authorization", bearer)
			}
			response, err := client.Do(request)
			if err != nil {
				// Logged here because the consumer can only say "not found" —
				// an unreachable peer must not masquerade as a missing world.
				slog.Warn("world service unreachable", "base", base, "err", err)
				return false, access.None
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				return false, access.None
			}
			var body struct {
				CallerLevel string `json:"callerLevel"`
			}
			if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&body) != nil {
				return false, access.None
			}
			return true, access.LevelFromString(body.CallerLevel)
		}, nil
	}
	if !mode.ChecksIdentity() {
		return func(context.Context, string, string) (bool, access.Level) { return true, access.Admin }, nil
	}
	return nil, fmt.Errorf("a checking server needs a world source to rank callers: select the world target too, or set global.services.worlds")
}

// requireCapability refuses to start against a peer that does not run the
// module this process depends on. Addresses are configuration, capabilities
// are self-description — this is the handshake between the two, and failing
// NOW names the misconfiguration instead of letting every later request 404.
// `key` is the config key the address came from, so the message names exactly
// the setting to fix.
func requireCapability(key, base, module string) error {
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Get(base + server.CapabilitiesPath)
	if err != nil {
		return fmt.Errorf("%s: %s is unreachable: %w", key, base, err)
	}
	defer response.Body.Close()
	var capabilities struct {
		Modules []string `json:"modules"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&capabilities); err != nil {
		return fmt.Errorf("%s: %s answered, but not with capabilities: %w", key, base, err)
	}
	if !slices.Contains(capabilities.Modules, module) {
		return fmt.Errorf("%s: %s runs %v, not the %s module", key, base, capabilities.Modules, module)
	}
	return nil
}

// serverBaseURL is the address a bake Job on another node uses to reach this
// server. The pod's own IP, injected by the downward API — a Job cannot mount
// this pod's ReadWriteOnce volume, so HTTP is the only way back, and the pod
// IP needs no Service to exist first. Empty outside a cluster.
//
// If the server pod is replaced mid-bake the address dies with it; so does the
// bake's reason to exist, since nobody is waiting for it any more.
func serverBaseURL(listen string) string {
	ip := os.Getenv("CASAS_POD_IP")
	if ip == "" {
		return ""
	}
	port := "8080"
	if index := strings.LastIndex(listen, ":"); index >= 0 && index+1 < len(listen) {
		port = listen[index+1:]
	}
	return fmt.Sprintf("http://%s:%s%s", ip, port, server.APIPrefix)
}

// workerPath resolves jobs.worker, defaulting to the bundle beside the binary.
//
// Beside the BINARY rather than beside the working directory: a server is
// started from wherever its data lives, and the bundle ships with the program.
func workerPath(configured string) string {
	if configured != "" {
		return configured
	}
	executable, err := os.Executable()
	if err != nil {
		return "job-worker.mjs"
	}
	return filepath.Join(filepath.Dir(executable), "job-worker.mjs")
}

// buildIdentity is what EVERY process needs in a checking mode: the one
// resolver that answers "who is asking", and the token issuer/verifier over
// the shared key. It opens no store — that is openCredentials' job, on the
// auth target alone, which is what lets world/artifacts/bake targets run
// without auth.storage.
//
// A mode that CHECKS identity and cannot verify a token would attribute every
// request to nobody, which looks exactly like a permission bug from the
// outside. So the key is resolved here, at startup, where the message can
// name the missing setting.
func buildIdentity(mode config.AuthMode, cfg config.Config) (*identity.Resolver, *token.Tokens, error) {
	if !mode.ChecksIdentity() {
		// No issuer either: a Job talking to a server that checks nobody needs
		// no credential, and handing it one would be a token nothing verifies.
		return identity.NewResolver(mode, nil), nil, nil
	}
	if mode == config.AuthOIDC {
		// The declared, empty path: the mode parses and the resolver would
		// verify the tokens this server issues, but nothing issues them yet.
		return nil, nil, fmt.Errorf("auth mode %s is not implemented yet", mode)
	}
	key, err := signingKey(cfg.Global.Auth.SessionKey)
	if err != nil {
		return nil, nil, err
	}
	tokens, err := token.NewTokens(key)
	if err != nil {
		return nil, nil, err
	}
	return identity.NewResolver(mode, tokens), tokens, nil
}

// openCredentials opens (or founds) the auth target's user store — the one
// store that both verifies logins and records who exists. It lives under
// auth.storage, not global: only the login-serving process reads or writes
// it. Opened eagerly so a bad path refuses to start, like every other store.
func openCredentials(cfg config.Config) (*user.Registry, error) {
	if err := cfg.Auth.Storage.Validate("auth"); err != nil {
		return nil, err
	}
	registry, err := user.NewRegistry(cfg.Auth.Storage.DirPath())
	if err != nil {
		return nil, fmt.Errorf("auth.storage: %w", err)
	}
	// Every later failure must release auth.db — its lock is the one-process
	// rule, and a refused start must not leave it held until process exit.
	fail := func(err error) (*user.Registry, error) {
		registry.Close()
		return nil, err
	}

	// An empty credential store is two very different situations, told apart
	// by the admin socket. WITH a socket it is the bootstrap state — exec in,
	// create the first user — and deserves a loud hint. WITHOUT one there is
	// no way to add a user at runtime, so a server that starts could only
	// ever refuse everybody: a misconfiguration wearing a permission bug's
	// clothes, refused here where the message can say what to configure.
	if !registry.HasCredentials() {
		if cfg.Global.Admin.Socket == "" {
			return fail(fmt.Errorf("no credentials in %s and no %s to bootstrap over — nobody could ever log in", cfg.Auth.Storage.DirPath(), keyAdminSock))
		}
		slog.Warn("the credential store is empty — nobody can log in until a user exists",
			"bootstrap", "casas-eternas auth user add <name> (over the admin socket)", "socket", cfg.Global.Admin.Socket)
	}
	return registry, nil
}

// signingKey reads the configured key, or makes an ephemeral one and says so.
//
// Generating rather than refusing keeps a single local server easy to start.
// Saying so loudly is the other half: the consequences — sessions lost on
// restart, replicas that reject each other's tokens — are invisible until they
// bite, and by then they look like a bug rather than a missing setting.
func signingKey(path string) ([]byte, error) {
	if path != "" {
		return token.ReadKey(path)
	}
	key, err := token.GenerateKey()
	if err != nil {
		return nil, err
	}
	slog.Warn("no signing key configured, generated an ephemeral one",
		"setting", keyAuthKey,
		"consequence", "sessions end at restart, and replicas will not accept each other's tokens")
	return key, nil
}
