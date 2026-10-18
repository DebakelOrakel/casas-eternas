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

	if err := refuseOldKeys(); err != nil {
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
			// A list from the environment is one comma-separated string
			// (CASAS_GLOBAL_PEERS=http://a:8080,http://b:8080).
			mapstructure.StringToSliceHookFunc(","),
			// Environment values arrive as STRINGS whatever the key's type —
			// CASAS_JOBS_MAX_CONCURRENT=3 must land in an int field, and
			// CASAS_JOBS_SCALE_WORKERS=false in a bool one. Exact parsing
			// only, so "abc" stays a loud start error rather than a
			// weakly-typed guess.
			func(from reflect.Kind, to reflect.Kind, value any) (any, error) {
				if from != reflect.String {
					return value, nil
				}
				switch to {
				case reflect.Int:
					return strconv.Atoi(strings.TrimSpace(value.(string)))
				case reflect.Bool:
					return strconv.ParseBool(strings.TrimSpace(value.(string)))
				}
				return value, nil
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

// refuseOldKeys is the HARD BREAK of DEC-0038 and of the keys removed
// after it: a key it renamed or removed, in the file or as a CASAS_*
// variable, refuses to start, with the new key named or the reason given.
// Checked before decoding, because the generic "invalid keys" message would
// not say what to do instead — and a variable with an old name would not be
// seen at all, since viper reads only variables of keys it knows.
func refuseOldKeys() error {
	variable := func(key string) string { return "CASAS_" + strings.ToUpper(envKey.Replace(key)) }
	for _, old := range sortedKeys(renamedKeys) {
		renamed := renamedKeys[old]
		if viper.InConfig(old) {
			return fmt.Errorf("%s is renamed: use %s (docs/decisions/object-storage.md)", old, renamed)
		}
		if _, set := os.LookupEnv(variable(old)); set {
			return fmt.Errorf("%s is renamed: use %s (docs/decisions/object-storage.md)", variable(old), variable(renamed))
		}
	}
	for _, old := range sortedKeys(removedKeys) {
		reason := removedKeys[old]
		if viper.InConfig(old) {
			return fmt.Errorf("%s is removed: %s", old, reason)
		}
		if _, set := os.LookupEnv(variable(old)); set {
			return fmt.Errorf("%s is removed: %s", variable(old), reason)
		}
	}
	return nil
}

// sortedKeys gives one stable message when several old keys are set.
func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
