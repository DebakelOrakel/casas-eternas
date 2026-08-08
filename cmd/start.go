package cmd

import (
	"log/slog"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"

	"github.com/DebakelOrakel/casas-eternas/internal/artifacts"
	"github.com/DebakelOrakel/casas-eternas/internal/client"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/server"
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

	modules, err := buildModules(targets)
	if err != nil {
		return err
	}

	slog.Info("starting", "targets", targets.Names())
	return server.Run(cmd.Context(), srv, modules)
}

// buildModules constructs exactly the selected modules, in a fixed order so
// mounting and shutdown are reproducible rather than map-order dependent.
func buildModules(targets config.Targets) ([]server.Module, error) {
	var modules []server.Module

	if targets.Has(config.TargetClient) {
		m, err := client.New(client.Config{})
		if err != nil {
			return nil, err
		}
		modules = append(modules, m)
	}
	if targets.Has(config.TargetWorld) {
		m, err := world.New(world.Config{Dir: viper.GetString(flagDirWorlds)})
		if err != nil {
			return nil, err
		}
		modules = append(modules, m)
	}
	if targets.Has(config.TargetArtifacts) {
		m, err := artifacts.New(artifacts.Config{Dir: viper.GetString(flagDirArtifacts)})
		if err != nil {
			return nil, err
		}
		modules = append(modules, m)
	}
	return modules, nil
}
