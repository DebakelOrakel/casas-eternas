// clidump walks the server's cobra command tree and emits it as JSON — the
// single source the documentation site renders its CLI and configuration
// reference pages from (docs/decisions/documentation-architecture.md,
// addendum 2). The vocabulary lives ONCE, in cmd/: a key is its flag is its
// CASAS_* variable, and this tool only projects that — it never adds a word.
//
// The output is committed as docs/operations/cli-reference.json and guarded
// by `make lint`, which regenerates and diffs it: a new flag that skips
// `make cli-reference` fails the lint instead of silently missing from the
// docs.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"

	"github.com/DebakelOrakel/casas-eternas/cmd"
)

type flagDoc struct {
	Name      string `json:"name"`
	Shorthand string `json:"shorthand,omitempty"`
	Default   string `json:"default,omitempty"`
	Usage     string `json:"usage"`
	// Env is set for flags that are also reachable as a CASAS_* variable —
	// bound through viper. A purely local flag (--password-stdin) has none.
	Env string `json:"env,omitempty"`
}

type commandDoc struct {
	// Path is the full invocation ("casas-eternas auth user add").
	Path    string    `json:"path"`
	Use     string    `json:"use"`
	Short   string    `json:"short"`
	Long    string    `json:"long,omitempty"`
	Example string    `json:"example,omitempty"`
	Flags   []flagDoc `json:"flags,omitempty"`
}

// keyDoc is one row of the configuration reference: every dotted key of the
// one vocabulary, whether it has a flag (most) or exists only in the file
// and environment (the storage `type` selectors).
type keyDoc struct {
	Key     string `json:"key"`
	Env     string `json:"env"`
	Default string `json:"default,omitempty"`
	Usage   string `json:"usage,omitempty"`
	// Command names where the flag lives, for the cross-link; empty for
	// file-only keys.
	Command string `json:"command,omitempty"`
}

type dump struct {
	Binary   string       `json:"binary"`
	Commands []commandDoc `json:"commands"`
	Keys     []keyDoc     `json:"keys"`
}

// envName mirrors initConfig's SetEnvPrefix + replacer — the one derivation
// rule, applied here at generation time instead of at lookup time.
var envReplacer = strings.NewReplacer(".", "_", "-", "_")

func envName(key string) string {
	return "CASAS_" + strings.ToUpper(envReplacer.Replace(key))
}

func main() {
	bound := map[string]bool{}
	for _, key := range viper.AllKeys() {
		bound[key] = true
	}

	result := dump{Binary: cmd.RootCmd.Name()}
	keys := map[string]keyDoc{}
	walk(cmd.RootCmd, cmd.RootCmd.Name(), bound, &result.Commands, keys)

	// The storage `type` selectors exist only as viper defaults — no flag,
	// no help text; the guides explain the union, the row still belongs in
	// the reference so the key is findable.
	for key := range bound {
		if _, seen := keys[key]; !seen && strings.Contains(key, ".") {
			keys[key] = keyDoc{Key: key, Env: envName(key), Default: viper.GetString(key)}
		}
	}
	for _, doc := range keys {
		result.Keys = append(result.Keys, doc)
	}
	sort.Slice(result.Keys, func(i, j int) bool { return result.Keys[i].Key < result.Keys[j].Key })

	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(string(encoded))
}

// walk collects a command and its visible children, depth-first with the
// children sorted by name so the output is deterministic — it is diffed by
// the lint.
func walk(c *cobra.Command, path string, bound map[string]bool, out *[]commandDoc, keys map[string]keyDoc) {
	if c.Hidden {
		return
	}
	doc := commandDoc{Path: path, Use: c.Use, Short: c.Short, Long: c.Long, Example: c.Example}
	c.LocalFlags().VisitAll(func(f *pflag.Flag) {
		if f.Hidden {
			return
		}
		flag := flagDoc{Name: f.Name, Shorthand: f.Shorthand, Default: f.DefValue, Usage: f.Usage}
		if bound[f.Name] {
			flag.Env = envName(f.Name)
		}
		doc.Flags = append(doc.Flags, flag)
		// Dotted flags ARE config-file keys — the configuration page's rows.
		if strings.Contains(f.Name, ".") {
			keys[f.Name] = keyDoc{Key: f.Name, Env: envName(f.Name), Default: f.DefValue, Usage: f.Usage, Command: path}
		}
	})
	*out = append(*out, doc)

	children := make([]*cobra.Command, 0, len(c.Commands()))
	children = append(children, c.Commands()...)
	sort.Slice(children, func(i, j int) bool { return children[i].Name() < children[j].Name() })
	for _, child := range children {
		walk(child, path+" "+child.Name(), bound, out, keys)
	}
}
