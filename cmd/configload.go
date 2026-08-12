package cmd

import (
	"errors"
	"fmt"
	"io/fs"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/go-viper/mapstructure/v2"
	"github.com/spf13/viper"
)

// loadConfig folds file, environment and flags into the one typed tree —
// the single place viper's merged state is read on the way to a module.
//
// STRICT on purpose, twice over. Viper's own Unmarshal silently ignores keys
// the struct does not have, which turns every typo in casas.yaml into a
// default nobody chose; decoding with ErrorUnused makes an unknown key a
// start error, the same loudness as an unknown target. And a target key in
// the FILE is refused explicitly: the same file serves every process of a
// split deployment, so a role in it would give every process the same role.
func loadConfig() (config.Config, error) {
	if path := viper.GetString(flagConfig); path != "" {
		viper.SetConfigFile(path)
		if err := viper.ReadInConfig(); err != nil {
			return config.Config{}, fmt.Errorf("--config: %w", err)
		}
	} else {
		// The default file is optional; a missing one is the ordinary
		// flags-and-defaults start, not an error.
		viper.SetConfigFile("casas.yaml")
		if err := viper.ReadInConfig(); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return config.Config{}, fmt.Errorf("casas.yaml: %w", err)
		}
	}

	for _, key := range []string{"target", "targets"} {
		if viper.InConfig(key) {
			return config.Config{}, fmt.Errorf("%q is not a config-file key — target selection is the process role; use -t or CASAS_TARGET", key)
		}
	}

	settings := viper.AllSettings()
	// The two bound keys that are deliberately not part of the tree: the role
	// selection and the path this very file was read from.
	delete(settings, flagTarget)
	delete(settings, flagConfig)

	var cfg config.Config
	decoder, err := mapstructure.NewDecoder(&mapstructure.DecoderConfig{
		Result:      &cfg,
		ErrorUnused: true,
		DecodeHook:  mapstructure.StringToTimeDurationHookFunc(),
	})
	if err != nil {
		return config.Config{}, err
	}
	if err := decoder.Decode(settings); err != nil {
		return config.Config{}, fmt.Errorf("configuration: %w", err)
	}
	return cfg, cfg.Validate()
}
