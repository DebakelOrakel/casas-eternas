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
	keyTLSCA       = "global.tls.ca"
	keyAuthMode    = "global.auth.mode"
	keyAuthHtpass  = "global.auth.htpasswd"
	keyAuthKey     = "global.auth.session-key"
	keyAuthTknTTL  = "global.auth.token-ttl"
	keyAuthSessTTL = "global.auth.session-ttl"
	keyAuthAdmins  = "global.auth.admins"
	keySvcWorlds   = "global.services.worlds"
	keySvcArts     = "global.services.artifacts"

	keyWorldPath  = "world.storage.dir.path"
	keyKeepRevs   = "world.keep-revisions"
	keyArtsPath   = "artifacts.storage.dir.path"
	keyArtsCap    = "artifacts.cap"
	keyClientPath = "client.storage.dir.path"
	keyAuthStore  = "auth.storage.dir.path"
	keyBaker      = "bake.baker"
	keyBakeMax    = "bake.max-concurrent"
)

const (
	textConfig = `Path to the configuration file. Default: ./casas.yaml if it exists. Flags and CASAS_* variables override the file.`
	textTarget = `The target modules to start: all, client, world, artifacts, bake. Repeatable. Deliberately NOT a config-file key — the same file serves differently-targeted processes.`

	textListen      = `Address to listen on, as host:port. ":8080" binds every interface, "127.0.0.1:8080" keeps a local instance off the network.`
	textTLSCert     = `Path to the server certificate. Enables HTTPS together with global.tls.key.`
	textTLSKey      = `Path to the server private key. Enables HTTPS together with global.tls.cert.`
	textTLSCA       = `Path to the CA that CLIENT certificates are verified against. Setting it turns on mutual TLS.`
	textAuthMode    = `How the server establishes who is asking: none (local, one synthetic owner), password (this server holds the users), oidc (a foreign provider does). See docs/decisions/server-auth.md.`
	textAuthHtpass  = `Path to the htpasswd file holding the users, bcrypt cost 10 or above (htpasswd -B -C 12). Required by auth mode password. Re-read on every sign-in, so changing it needs no restart.`
	textAuthKey     = `Path to the key that session tokens are signed with, at least 32 bytes. Without it a key is generated at startup, which means sessions do not survive a restart and several replicas do not agree.`
	textAuthTknTTL  = `How long an issued token is valid.`
	textAuthSessTTL = `How long a login lasts before a password is needed again. Has no effect until token renewal exists; until then global.auth.token-ttl is the one that matters.`
	textAuthAdmins  = `Login names whose sessions carry the admin claim. Checked at login by the process holding the user registry; a change takes effect at the member's next login.`
	textSvcWorlds   = `URL of the service running the world module, when it is not co-resident. Empty expects it in this process.`
	textSvcArts     = `URL of the service running the artifacts module, when it is not co-resident. Empty expects it in this process.`

	textWorldPath  = `The directory the saved worlds live in.`
	textKeepRevs   = `How many revisions of each world to retain; older ones are pruned on upload. 0 keeps every revision.`
	textArtsPath   = `The directory of the artifact store.`
	textArtsCap    = `Size the artifact store may grow to before least-recently-used artifacts are evicted, e.g. "50GB". 0 or empty keeps it unlimited.`
	textClientPath = `The directory the built client is served from. Empty serves only /config.json, which is what a dev run alongside "npm run dev" wants.`
	textAuthStore  = `The directory the auth subsystem's state lives in — the user registry (users.json), minted at first login.`
	textBaker      = `Path to the bake bundle (npm run build:baker). Defaults to baker.mjs beside the binary.`
	textBakeMax    = `How many bakes may run at once. One 8192² bake peaks near 2.6 GB, so raising this raises the memory the host must have.`
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
	Long: `Starts the selected modules in a single process.

  casas-eternas start --target all           everything, for local play
  casas-eternas start -t world -t artifacts  storage only, no client
  casas-eternas start -t client              frontend only`,
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
	RootCmd.PersistentFlags().String(keyTLSCA, "", textTLSCA)

	// Selection and configuration stay separate on purpose; see the vocabulary
	// note at the top for why --target is a flag and never a file key.
	StartCmd.Flags().StringSliceP(flagTarget, "t", []string{}, textTarget)
	StartCmd.Flags().String(keyAuthMode, string(config.DefaultAuthMode), textAuthMode)
	StartCmd.Flags().String(keyAuthHtpass, "", textAuthHtpass)
	StartCmd.Flags().String(keyAuthKey, "", textAuthKey)
	StartCmd.Flags().Duration(keyAuthTknTTL, 720*time.Hour, textAuthTknTTL)
	StartCmd.Flags().Duration(keyAuthSessTTL, 720*time.Hour, textAuthSessTTL)
	StartCmd.Flags().StringSlice(keyAuthAdmins, nil, textAuthAdmins)
	StartCmd.Flags().String(keySvcWorlds, "", textSvcWorlds)
	StartCmd.Flags().String(keySvcArts, "", textSvcArts)
	StartCmd.Flags().String(keyWorldPath, "./worlds", textWorldPath)
	StartCmd.Flags().Int(keyKeepRevs, 3, textKeepRevs)
	StartCmd.Flags().String(keyArtsPath, "./artifacts", textArtsPath)
	StartCmd.Flags().String(keyArtsCap, "", textArtsCap)
	StartCmd.Flags().String(keyClientPath, "", textClientPath)
	StartCmd.Flags().String(keyAuthStore, "./auth", textAuthStore)
	StartCmd.Flags().String(keyBaker, "", textBaker)
	StartCmd.Flags().Int(keyBakeMax, 1, textBakeMax)

	bindings := map[string]*cobra.Command{
		flagConfig: RootCmd,
		keyListen:  RootCmd, keyTLSCert: RootCmd, keyTLSKey: RootCmd, keyTLSCA: RootCmd,
		flagTarget: StartCmd, keyAuthMode: StartCmd, keyAuthHtpass: StartCmd, keyAuthKey: StartCmd,
		keyAuthTknTTL: StartCmd, keyAuthSessTTL: StartCmd, keyAuthAdmins: StartCmd,
		keySvcWorlds: StartCmd, keySvcArts: StartCmd, keyAuthStore: StartCmd,
		keyWorldPath: StartCmd, keyKeepRevs: StartCmd, keyArtsPath: StartCmd, keyArtsCap: StartCmd,
		keyClientPath: StartCmd, keyBaker: StartCmd, keyBakeMax: StartCmd,
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

	// Keys that exist in the tree but have no flag (the storage union's type
	// selectors). SetDefault makes them known to viper, which is what lets a
	// file or CASAS_* variable reach them through Unmarshal.
	for _, key := range []string{"world.storage.type", "artifacts.storage.type", "client.storage.type", "auth.storage.type"} {
		viper.SetDefault(key, "")
	}

	RootCmd.AddCommand(StartCmd)
}

// initConfig wires the environment side of the vocabulary.
func initConfig() {
	// Prefixed, so the bound keys claim CASAS_TARGET / CASAS_WORLD_STORAGE_DIR_PATH
	// rather than bare names generic enough that a container runtime or a
	// sidecar would eventually collide with them. Dots and dashes both become
	// underscores: `global.auth.session-key` → CASAS_GLOBAL_AUTH_SESSION_KEY.
	viper.SetEnvPrefix("CASAS")
	viper.SetEnvKeyReplacer(strings.NewReplacer(".", "_", "-", "_"))
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
