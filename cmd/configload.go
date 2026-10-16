package cmd

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"

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

	if err := refuseRenamedKeys(); err != nil {
		return config.Config{}, err
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
		DecodeHook: mapstructure.ComposeDecodeHookFunc(
			mapstructure.StringToTimeDurationHookFunc(),
			// Environment values arrive as STRINGS whatever the key's type —
			// CASAS_JOBS_MAX_CONCURRENT=3 must land in an int field. Exact
			// parsing only, so "abc" stays a loud start error rather than a
			// weakly-typed guess.
			func(from reflect.Kind, to reflect.Kind, value any) (any, error) {
				if from != reflect.String || to != reflect.Int {
					return value, nil
				}
				return strconv.Atoi(strings.TrimSpace(value.(string)))
			},
		),
	})
	if err != nil {
		return config.Config{}, err
	}
	if err := decoder.Decode(settings); err != nil {
		return config.Config{}, fmt.Errorf("configuration: %w", err)
	}
	dropDefaultDir(&cfg.World.Storage, keyWorldPath)
	dropDefaultDir(&cfg.Artifacts.Storage, keyArtsPath)
	return cfg, cfg.Validate()
}

// dropDefaultDir keeps the flag default of dir.path from counting as a dir
// block beside `type: s3`. A path that was SET (file, variable, flag) stays
// and is refused there as a foreign block; viper's IsSet does not count a
// flag default. With any other type the default is the path, as before.
func dropDefaultDir(storage *config.ObjectStorage, pathKey string) {
	if storage.Type == "s3" && !viper.IsSet(pathKey) {
		storage.Dir = nil
	}
}

// refuseRenamedKeys is the HARD BREAK of DEC-0038: a key it replaced, in the
// file or as a CASAS_* variable, refuses to start with the new key named.
// Checked before decoding, because the generic "invalid keys" message would
// not say what to write instead — and a variable with an old name would not
// be seen at all, since viper reads only variables of keys it knows.
func refuseRenamedKeys() error {
	olds := make([]string, 0, len(renamedKeys))
	for old := range renamedKeys {
		olds = append(olds, old)
	}
	sort.Strings(olds) // one stable message when several are set
	for _, old := range olds {
		renamed := renamedKeys[old]
		if viper.InConfig(old) {
			return fmt.Errorf("%s is renamed: use %s (docs/decisions/object-storage.md)", old, renamed)
		}
		variable := "CASAS_" + strings.ToUpper(envKey.Replace(old))
		if _, set := os.LookupEnv(variable); set {
			return fmt.Errorf("%s is renamed: use CASAS_%s (docs/decisions/object-storage.md)", variable, strings.ToUpper(envKey.Replace(renamed)))
		}
	}
	return nil
}
