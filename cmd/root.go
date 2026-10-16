package cmd

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

// ONE VOCABULARY (decided 2026-08-12): every setting has exactly one name,
// and it is the dotted config key — `world.storage.dir.path` is the key in
// casas.yaml, the flag `--world.storage.dir.path`, and (through the
// replacer) CASAS_WORLD_STORAGE_DIR_PATH. The flag names below ARE the viper
// keys, so the binding cannot drift.
//
// The one named exception is `--target/-t`: target selection is the process
// ROLE, deliberately not part of the shared config file (the same file
// serves every process of a split deployment), so it exists only as a flag
// and CASAS_TARGET. The loader refuses a target key in the file.
const (
	flagConfig = "config"
	flagTarget = "target"

	keyListen      = "global.listen"
	keyTLSCert     = "global.tls.cert"
	keyTLSKey      = "global.tls.key"
	keyAuthMode    = "global.auth.mode"
	keyAuthKey     = "global.auth.session-key"
	keyAuthTknTTL  = "global.auth.token-ttl"
	keyAuthSessTTL = "global.auth.session-ttl"
	keyAdminSock   = "global.admin.socket"
	keySvcWorlds   = "global.services.worlds"
	keySvcArts     = "global.services.artifacts"
	keySvcRelay    = "global.services.relay"

	keyWorldType    = "world.storage.type"
	keyWorldPath    = "world.storage.dir.path"
	keyKeepRevs     = "world.keep-revisions"
	keyWorldReadTTL = "world.read-link-ttl"
	keyWorldLinkKey = "world.link-key"
	keyWorldLinkOld = "world.link-key-previous"
	keyArtsType     = "artifacts.storage.type"
	keyArtsPath     = "artifacts.storage.dir.path"
	keyArtsCap      = "artifacts.cap"
	keyArtsReadTTL  = "artifacts.read-link-ttl"
	keyArtsWriteTTL = "artifacts.write-link-ttl"
	keyArtsLinkKey  = "artifacts.link-key"
	keyArtsLinkOld  = "artifacts.link-key-previous"
	keyClientDir    = "client.content-dir"
	keyAuthDir      = "auth.state-dir"
	keyDocsDir      = "docs.content-dir"
	keyWorker       = "jobs.worker"
	keyJobsMax      = "jobs.max-concurrent"
	keyJobsDir      = "jobs.state-dir"
	keyRelayDir     = "relay.state-dir"
	keyRelayAddr    = "relay.listen"
)

// The s3 blocks' keys (DEC-0038, fork 3): file keys and CASAS_* variables,
// no flags. Bound to the environment without a default, so a block exists
// only where one of its keys was set (configload.go relies on that).
var s3Keys = []string{"flavour", "region", "endpoint", "bucket", "prefix", "access-key-file", "secret-key-file"}

// renamedKeys are the keys DEC-0038 replaced, in a HARD BREAK: an old key in
// the file or as a CASAS_* variable refuses to start, an old flag is unknown,
// and each message names the new key. No release reads both.
var renamedKeys = map[string]string{
	"jobs.storage.dir.path":   keyJobsDir,
	"jobs.storage.type":       keyJobsDir,
	"auth.storage.dir.path":   keyAuthDir,
	"auth.storage.type":       keyAuthDir,
	"relay.storage.dir.path":  keyRelayDir,
	"relay.storage.type":      keyRelayDir,
	"client.storage.dir.path": keyClientDir,
	"client.storage.type":     keyClientDir,
	"docs.storage.dir.path":   keyDocsDir,
	"docs.storage.type":       keyDocsDir,
}

// removedKeys are keys that went without a replacement, in the same HARD
// BREAK: the file key and the CASAS_* variable refuse to start, the flag is
// unknown, and each message says why the key went.
var removedKeys = map[string]string{
	// Removed 2026-10-16: nothing used it, and workers authenticate with
	// tokens (docs/decisions/server-storage.md, addendum 2026-10-16).
	"global.tls.ca": "mutual TLS is no longer supported, tokens authenticate clients (docs/decisions/server-storage.md)",
}

// The two enum texts are composed, not written: the value lists live in
// internal/config beside the parsers that enforce them, so the help, the
// error message and the shell completion cannot drift apart.
var (
	textTarget   = fmt.Sprintf(`The target modules to start: %s. Repeatable. Deliberately NOT a config-file key — the same file serves differently-targeted processes.`, strings.Join(config.ValidTargets(), ", "))
	textAuthMode = fmt.Sprintf(`How the server establishes who is asking: %s — none is local (one synthetic owner), password means this server holds the users, oidc a foreign provider. See docs/decisions/server-auth.md.`, strings.Join(config.ValidAuthModes(), ", "))
)

const (
	textConfig = `Path to the configuration file. Default: ./casas.yaml if it exists. Flags and CASAS_* variables override the file.`

	textListen      = `Address to listen on, as host:port. ":8080" binds every interface, "127.0.0.1:8080" keeps a local instance off the network.`
	textTLSCert     = `Path to the server certificate. Enables HTTPS together with global.tls.key.`
	textTLSKey      = `Path to the server private key. Enables HTTPS together with global.tls.cert.`
	textAuthKey     = `Path to the key that session tokens are signed with, at least 32 bytes. Without it a key is generated at startup, which means sessions do not survive a restart and several replicas do not agree.`
	textAuthTknTTL  = `How long an access token is valid. Short, because nothing is consulted when one is used: a session that is ended (a password changed or reset) stops working when its access token runs out.`
	textAuthSessTTL = `How long a login lasts before a password is needed again: the life of the refresh token that renews the access token.`
	textAdminSock   = `Path of a unix socket serving this process's admin API (user administration, over plain HTTP). Whoever can reach the socket is admin — file permissions gate it, no login. Empty serves none.`
	textSvcWorlds   = `URL of the service running the world module, when it is not co-resident. Empty expects it in this process.`
	textSvcArts     = `URL of the service running the artifacts module, when it is not co-resident. Empty expects it in this process.`
	textSvcRelay    = `NATS URL of the relay (the message bus), when it is not co-resident, e.g. nats://relay:4222. Empty expects it in this process.`

	textWorldType    = `The world store's backend: dir or s3. Required as soon as world.storage.s3 is set; the backend is never inferred from a block.`
	textWorldPath    = `The directory the saved worlds live in (backend dir).`
	textKeepRevs     = `How many revisions of each world to retain; older ones are pruned on upload. 0 keeps every revision.`
	textWorldReadTTL = `How long a link to read a world's save or preview is valid. A read is redirected to such a link: a presigned GET on s3, the server's own signed link on dir.`
	textWorldLinkKey = `Path to the key (at least 32 random bytes) the dir backend signs its world links with. Without it a key is generated at startup, so links do not survive a restart.`
	textWorldLinkOld = `Path to the previous world link key, during a key change-over (backend dir): links signed with it are still accepted, new links are signed with world.link-key. Set it to the old key file when world.link-key gets a new one, and remove it when the old links have expired (world.read-link-ttl). Empty: no previous key.`
	textArtsType     = `The artifact store's backend: dir or s3. Required as soon as artifacts.storage.s3 is set; the backend is never inferred from a block.`
	textArtsPath     = `The directory of the artifact store (backend dir).`
	textArtsCap      = `Size the artifact store may grow to before least-recently-used artifacts are evicted, e.g. "50GB". 0 or empty keeps it unlimited.`
	textArtsReadTTL  = `How long a link to read an artifact file is valid. A read is redirected to such a link: a presigned GET on s3, the server's own signed link on dir.`
	textArtsWriteTTL = `How long a link to write an artifact file is valid. A job worker asks for one per file it writes, with the file's length, and uploads to it straight to the bucket; it asks again when the link has less than 5 minutes left or is refused.`
	textArtsLinkKey  = `Path to the key (at least 32 random bytes) the dir backend signs its artifact links (to read and to write) with. Without it a key is generated at startup, so links do not survive a restart.`
	textArtsLinkOld  = `Path to the previous artifact link key, during a key change-over (backend dir): links signed with it are still accepted, new links are signed with artifacts.link-key. Set it to the old key file when artifacts.link-key gets a new one, and remove it when the old links have expired (the longer of artifacts.read-link-ttl and artifacts.write-link-ttl). Empty: no previous key.`
	textClientDir    = `The directory the built client is served from. Empty serves only /config.json, which is what a dev run alongside "npm run dev" wants.`
	textAuthDir      = `The directory the auth subsystem's state lives in — auth.db, holding users and their credentials, and the avatars. A users.json left by an older server is imported once when the database is founded.`
	textDocsDir      = `The directory the built documentation site is served from (npm run build:docs). Empty serves nothing, which is what a dev run wants.`
	textWorker       = `Path to the job worker bundle (npm run build:worker). Defaults to job-worker.mjs beside the binary.`
	textJobsMax      = `How many workers run at once on this machine (the coordinator starts and keeps them). One level-1 task of a real world holds some gigabytes, so raising this raises the memory the host must have.`
	textJobsDir      = `The directory of the jobs coordinator's state — jobs.db, holding the jobs, their tasks and where each stands.`
	textRelayDir     = `The directory of the relay's message store (JetStream).`
	textRelayAddr    = `Address the relay accepts worker connections on, as host:port. The default keeps it on this machine. Where global.auth.mode checks identity, the relay admits only this server's own tokens, so it may listen beyond the machine; in mode none it checks nobody.`
)

// RootCmd represents the base command when called without any subcommands
var RootCmd = &cobra.Command{
	Use:   "casas-eternas",
	Short: "Server for casas-eternas — stores worlds and derived artifacts.",
	Long: `Server for casas-eternas.

It stores what the browser client makes and derives: named worlds, and the
content-addressed artifacts baked from them. It generates nothing itself.

One binary runs every part; "start --target" chooses which. Configuration
comes from casas.yaml, CASAS_* variables and flags — one vocabulary: the
config key is the flag name is the variable name.`,
	// Showing the help beats printing success while doing nothing.
	RunE: func(cmd *cobra.Command, args []string) error {
		return cmd.Help()
	},
	// Usage on every runtime error would bury the message under a flag list;
	// cobra still prints it for genuine usage mistakes.
	SilenceUsage: true,
}

// StartCmd represents the start command.
var StartCmd = &cobra.Command{
	Use:   "start",
	Short: "Starts one or more modules.",
	Long:  `Starts the selected modules in a single process.`,
	Example: `  casas-eternas start --target all           everything, for local play
  casas-eternas start -t world -t artifacts  storage only, no client
  casas-eternas start -t client              frontend only`,
	// Everything start takes arrives as a flag; a stray positional argument
	// is a mangled flag, and ignoring it silently would run something the
	// caller did not ask for.
	Args: cobra.NoArgs,
	RunE: Start,
}

func init() {
	cobra.OnInitialize(initConfig)

	RootCmd.PersistentFlags().String(flagConfig, "", textConfig)

	// Persistent, because transport belongs to the PROCESS and not to any one
	// module: whichever modules run, they share one listener and one TLS
	// identity. The target-section flags below are the opposite case — they
	// configure one specific module, so they sit on the subcommand.
	RootCmd.PersistentFlags().String(keyListen, ":8080", textListen)
	RootCmd.PersistentFlags().String(keyTLSCert, "", textTLSCert)
	RootCmd.PersistentFlags().String(keyTLSKey, "", textTLSKey)
	RootCmd.PersistentFlags().String(keyAdminSock, "", textAdminSock)

	// Selection and configuration stay separate on purpose; see the vocabulary
	// note at the top for why --target is a flag and never a file key.
	StartCmd.Flags().StringSliceP(flagTarget, "t", []string{}, textTarget)
	StartCmd.Flags().String(keyAuthMode, string(config.DefaultAuthMode), textAuthMode)
	StartCmd.Flags().String(keyAuthKey, "", textAuthKey)
	StartCmd.Flags().Duration(keyAuthTknTTL, 15*time.Minute, textAuthTknTTL)
	StartCmd.Flags().Duration(keyAuthSessTTL, 720*time.Hour, textAuthSessTTL)
	StartCmd.Flags().String(keySvcWorlds, "", textSvcWorlds)
	StartCmd.Flags().String(keySvcArts, "", textSvcArts)
	StartCmd.Flags().String(keySvcRelay, "", textSvcRelay)
	StartCmd.Flags().String(keyWorldType, "dir", textWorldType)
	StartCmd.Flags().String(keyWorldPath, "./data/worlds", textWorldPath)
	StartCmd.Flags().Int(keyKeepRevs, 3, textKeepRevs)
	StartCmd.Flags().Duration(keyWorldReadTTL, 15*time.Minute, textWorldReadTTL)
	StartCmd.Flags().String(keyWorldLinkKey, "", textWorldLinkKey)
	StartCmd.Flags().String(keyWorldLinkOld, "", textWorldLinkOld)
	StartCmd.Flags().String(keyArtsType, "dir", textArtsType)
	StartCmd.Flags().String(keyArtsPath, "./data/artifacts", textArtsPath)
	StartCmd.Flags().String(keyArtsCap, "", textArtsCap)
	StartCmd.Flags().Duration(keyArtsReadTTL, 15*time.Minute, textArtsReadTTL)
	StartCmd.Flags().Duration(keyArtsWriteTTL, time.Hour, textArtsWriteTTL)
	StartCmd.Flags().String(keyArtsLinkKey, "", textArtsLinkKey)
	StartCmd.Flags().String(keyArtsLinkOld, "", textArtsLinkOld)
	StartCmd.Flags().String(keyClientDir, "", textClientDir)
	StartCmd.Flags().String(keyAuthDir, "./data/auth", textAuthDir)
	StartCmd.Flags().String(keyDocsDir, "", textDocsDir)
	StartCmd.Flags().String(keyWorker, "", textWorker)
	StartCmd.Flags().Int(keyJobsMax, 1, textJobsMax)
	StartCmd.Flags().String(keyJobsDir, "./data/jobs", textJobsDir)
	StartCmd.Flags().String(keyRelayDir, "./data/relay", textRelayDir)
	StartCmd.Flags().String(keyRelayAddr, "127.0.0.1:4222", textRelayAddr)

	bindings := map[string]*cobra.Command{
		flagConfig: RootCmd,
		keyListen:  RootCmd, keyTLSCert: RootCmd, keyTLSKey: RootCmd,
		keyAdminSock: RootCmd,
		flagTarget:   StartCmd, keyAuthMode: StartCmd, keyAuthKey: StartCmd,
		keyAuthTknTTL: StartCmd, keyAuthSessTTL: StartCmd,
		keySvcWorlds: StartCmd, keySvcArts: StartCmd, keyAuthDir: StartCmd,
		keyWorldType: StartCmd, keyWorldPath: StartCmd, keyKeepRevs: StartCmd,
		keyWorldReadTTL: StartCmd, keyWorldLinkKey: StartCmd, keyWorldLinkOld: StartCmd,
		keyArtsType: StartCmd, keyArtsPath: StartCmd, keyArtsCap: StartCmd,
		keyArtsReadTTL: StartCmd, keyArtsWriteTTL: StartCmd, keyArtsLinkKey: StartCmd, keyArtsLinkOld: StartCmd,
		keyClientDir: StartCmd, keyWorker: StartCmd, keyJobsMax: StartCmd, keyDocsDir: StartCmd,
		keySvcRelay: StartCmd, keyRelayDir: StartCmd, keyRelayAddr: StartCmd, keyJobsDir: StartCmd,
	}
	for key, cmd := range bindings {
		flags := cmd.Flags()
		if cmd == RootCmd {
			flags = cmd.PersistentFlags()
		}
		if err := viper.BindPFlag(key, flags.Lookup(key)); err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
	}

	// Keys that exist in the tree but have no flag (the s3 blocks). BindEnv
	// makes them known to viper, which is what lets a CASAS_* variable reach
	// them through Unmarshal; without a default, so that an s3 block exists
	// only where a key of it was set.
	for _, section := range []string{"world", "artifacts"} {
		for _, name := range s3Keys {
			if err := viper.BindEnv(section + ".storage.s3." + name); err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}
	}

	// An old flag is an unknown flag; say which flag replaced it, or why it
	// went. On the root command, because a removed persistent flag reaches
	// every subcommand, and a subcommand inherits this function.
	RootCmd.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
		for old, renamed := range renamedKeys {
			if strings.Contains(err.Error(), "--"+old) {
				return fmt.Errorf("%w (renamed: use --%s, docs/decisions/object-storage.md)", err, renamed)
			}
		}
		for old, reason := range removedKeys {
			if strings.Contains(err.Error(), "--"+old) {
				return fmt.Errorf("%w — removed: %s", err, reason)
			}
		}
		return err
	})

	// Shell completion for the two enum flags, from the same lists the
	// parsers enforce. Cobra generates the completion machinery itself
	// (`casas-eternas completion <shell>`); these only teach it the values.
	completeFrom := func(values []string) func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
		return func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
			return values, cobra.ShellCompDirectiveNoFileComp
		}
	}
	for key, values := range map[string][]string{
		flagTarget:  config.ValidTargets(),
		keyAuthMode: config.ValidAuthModes(),
	} {
		if err := StartCmd.RegisterFlagCompletionFunc(key, completeFrom(values)); err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
	}

	RootCmd.AddCommand(StartCmd)
}

// envKey turns a dotted key into the tail of its CASAS_* variable.
var envKey = strings.NewReplacer(".", "_", "-", "_")

// initConfig wires the environment side of the vocabulary.
func initConfig() {
	// Prefixed, so the bound keys claim CASAS_TARGET / CASAS_WORLD_STORAGE_DIR_PATH
	// rather than bare names generic enough that a container runtime or a
	// sidecar would eventually collide with them. Dots and dashes both become
	// underscores: `global.auth.session-key` → CASAS_GLOBAL_AUTH_SESSION_KEY.
	viper.SetEnvPrefix("CASAS")
	viper.SetEnvKeyReplacer(envKey)
	viper.AutomaticEnv() // read in environment variables that match
}

// Execute adds all child commands to the root command and sets flags appropriately.
// This is called by main.main(). It only needs to happen once to the rootCmd.
func Execute() {
	// Cobra has already reported the error on stderr by the time it comes back;
	// printing it again here produced every failure twice. All that is left to
	// do is fail the exit status.
	if err := RootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
