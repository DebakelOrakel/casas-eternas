package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

// Flag names as constants: each is referenced three times — at definition, at
// the viper binding and at the read — and a typo in any of them fails silently
// as a zero value rather than loudly at compile time.
const (
	flagTarget       = "target"
	flagDirArtifacts = "dir-artifacts"
	flagDirWorlds    = "dir-worlds"
	flagListen       = "listen"
	flagTLSCert      = "tls-cert"
	flagTLSKey       = "tls-key"
	flagTLSCA        = "tls-ca"
	flagBaker        = "baker"
	flagDirClient    = "dir-client"
	flagBakeMax      = "bake-max-concurrent"
	flagAuthMode     = "auth-mode"
)

const (
	textTarget       = `The target modules to start: all, client, world, artifacts, bake. Repeatable.`
	textDirArtifacts = `The directory to the artifact store.`
	textDirWorlds    = `The directory the saved worlds live in.`
	textBaker        = `Path to the bake bundle (npm run build:baker). Defaults to baker.mjs beside the binary.`
	textDirClient    = `The directory the built client is served from. Empty serves only /config.json, which is what a dev run alongside "npm run dev" wants.`
	textBakeMax      = `How many bakes may run at once. One 8192² bake peaks near 2.6 GB, so raising this raises the memory the host must have.`
	textAuthMode     = `How the server establishes who is asking: none (local, one synthetic owner), password (this server holds the users), oidc (a foreign provider does). See docs/decisions/server-auth.md.`

	textListen  = `Address to listen on, as host:port. ":8080" binds every interface, "127.0.0.1:8080" keeps a local instance off the network.`
	textTLSCert = `Path to the server certificate. Enables HTTPS together with --tls-key.`
	textTLSKey  = `Path to the server private key. Enables HTTPS together with --tls-cert.`
	textTLSCA   = `Path to the CA that CLIENT certificates are verified against. Setting it turns on mutual TLS.`
)

// RootCmd represents the base command when called without any subcommands
var RootCmd = &cobra.Command{
	Use:   "casas-eternas",
	Short: "Server for casas-eternas — stores worlds and derived artifacts.",
	Long: `Server for casas-eternas.

It stores what the browser client makes and derives: named worlds, and the
content-addressed artifacts baked from them. It generates nothing itself.

One binary runs every part; "start --target" chooses which.`,
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
  casas-eternas start -t bake                bake worker only
  casas-eternas start -t client              frontend only`,
	RunE: Start,
}

func init() {
	cobra.OnInitialize(initConfig)

	// Persistent, because transport belongs to the PROCESS and not to any one
	// module: whichever modules run, they share one listener and one TLS
	// identity. The --dir-* flags below are the opposite case — they configure
	// one specific module, so they sit on the subcommand that starts it.
	RootCmd.PersistentFlags().String(flagListen, ":8080", textListen)
	RootCmd.PersistentFlags().String(flagTLSCert, "", textTLSCert)
	RootCmd.PersistentFlags().String(flagTLSKey, "", textTLSKey)
	RootCmd.PersistentFlags().String(flagTLSCA, "", textTLSCA)

	// Selection and configuration stay separate flags on purpose. Making a path
	// flag's PRESENCE its enable switch was considered and rejected: it forbids
	// defaults (a defaulted flag is always "present"), and a module that owns no
	// directory would need a second mechanism anyway.
	StartCmd.Flags().StringSliceP(flagTarget, "t", []string{}, textTarget)
	StartCmd.Flags().String(flagDirArtifacts, "./artifacts", textDirArtifacts)
	StartCmd.Flags().String(flagDirWorlds, "./worlds", textDirWorlds)
	StartCmd.Flags().String(flagBaker, "", textBaker)
	StartCmd.Flags().String(flagDirClient, "", textDirClient)
	StartCmd.Flags().Int(flagBakeMax, 1, textBakeMax)
	// On StartCmd rather than persistent: it configures the MODULES that start
	// builds, the way --dir-worlds does. The persistent flags configure the
	// process's socket, which is a different thing (see config.Server).
	StartCmd.Flags().String(flagAuthMode, string(config.DefaultAuthMode), textAuthMode)

	for _, err := range []error{
		viper.BindPFlag(flagListen, RootCmd.PersistentFlags().Lookup(flagListen)),
		viper.BindPFlag(flagTLSCert, RootCmd.PersistentFlags().Lookup(flagTLSCert)),
		viper.BindPFlag(flagTLSKey, RootCmd.PersistentFlags().Lookup(flagTLSKey)),
		viper.BindPFlag(flagTLSCA, RootCmd.PersistentFlags().Lookup(flagTLSCA)),
		viper.BindPFlag(flagTarget, StartCmd.Flags().Lookup(flagTarget)),
		viper.BindPFlag(flagDirArtifacts, StartCmd.Flags().Lookup(flagDirArtifacts)),
		viper.BindPFlag(flagDirWorlds, StartCmd.Flags().Lookup(flagDirWorlds)),
		viper.BindPFlag(flagBaker, StartCmd.Flags().Lookup(flagBaker)),
		viper.BindPFlag(flagAuthMode, StartCmd.Flags().Lookup(flagAuthMode)),
		viper.BindPFlag(flagDirClient, StartCmd.Flags().Lookup(flagDirClient)),
		viper.BindPFlag(flagBakeMax, StartCmd.Flags().Lookup(flagBakeMax)),
	} {
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

	}

	RootCmd.AddCommand(StartCmd)
}

// initConfig reads in config file and ENV variables if set.
func initConfig() {
	// Prefixed, so the bound flags claim CASAS_TARGET / CASAS_DIR_ARTIFACTS rather
	// than the bare TARGET / DIR_ARTIFACTS — names generic enough that a container
	// runtime or a sidecar would eventually collide with them.
	viper.SetEnvPrefix("CASAS")
	viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))
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
