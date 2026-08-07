package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

const (
	textAlertmanagerHost        = `The Host of the Alertmanager to query for alerts.`
	textAlertmanagerUseTLS      = `Wether to use TLS when connecting to the Alertmanager.`
	textAlertmanagerInsecureTLS = `Whether to skip TLS verification when connecting to the Alertmanager.`

	textEnableElection = `Enable leader election for controller manager.
	Enabling this will ensure there is only one active controller manager.`
	textEnableHTTP2 = `If set, HTTP/2 will be enabled for the metrics and webhook servers`
	textProbeAddr   = `The address the probe endpoint binds to.`
	textMetricsAddr = `The address the metrics endpoint binds to.
Use :8443 for HTTPS or :8080 for HTTP, or leave as 0 to disable the metrics service.`
	textMetricsSecure = `If set, the metrics endpoint is served securely via HTTPS.
	Use --metrics-secure=false to use HTTP instead.`
	textMetricsCertPath = `The directory that contains the metrics server certificate.`
	textMetricsCertName = `The name of the metrics server certificate file.`
	textMetricsCertKey  = `The name of the metrics server key file.`
)

// RootCmd represents the base command when called without any subcommands
var RootCmd = &cobra.Command{
	Use:   "casas-eternas",
	Short: "TODO: Short",
	Long:  `TODO: Long`,
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("nothing to do here")
	},
}

// CacheCmd represents the artifact cache.
var CacheCmd = &cobra.Command{
	Use:   "cache",
	Short: "Starts the artifact cache.",
	Run:   Cache,
}

func init() {
	cobra.OnInitialize(initConfig)

	RootCmd.AddCommand(CacheCmd)
}

// initConfig reads in config file and ENV variables if set.
func initConfig() {
	viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))
	viper.AutomaticEnv() // read in environment variables that match
}

// Execute adds all child commands to the root command and sets flags appropriately.
// This is called by main.main(). It only needs to happen once to the rootCmd.
func Execute() {
	if err := RootCmd.Execute(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}
