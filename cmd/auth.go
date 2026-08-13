// The admin CLI: `casas-eternas auth user add|list|delete|passwd` — thin
// clients over the RUNNING server's unix admin socket, decided 2026-08-13
// (docs/decisions/server-user-admin.md). The grammar is <module> <resource>
// <verb>, the fourth surface of the one-vocabulary rule: `auth` is already
// the config section, the flag prefix, the env prefix and the route
// namespace.
//
// Thin is the design: cobra parses, the module decides. These commands never
// open auth.db — bbolt's file lock forbids it while the server runs, and two
// write paths onto one store is what the one-process rule exists to prevent.

package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/DebakelOrakel/casas-eternas/internal/modules/auth"
	"github.com/DebakelOrakel/casas-eternas/internal/user"
)

const flagPasswordStdin = "password-stdin"

const textPasswordStdin = `Read the password from stdin instead of prompting — for scripts and Jobs. Trailing newlines are stripped; nothing else is.`

var authCmd = &cobra.Command{
	Use:   "auth",
	Short: "Administers the auth subsystem of a running server.",
	Long: `Administers the auth subsystem of a RUNNING server, over its unix
admin socket (global.admin.socket). Whoever can reach the socket is admin —
file permissions gate it, no login. In a split deployment these commands
answer only in the process running the auth target.`,
}

var authUserCmd = &cobra.Command{
	Use:   "user",
	Short: "Manages the local users.",
}

var authUserAddCmd = &cobra.Command{
	Use:   "add <name>",
	Short: "Creates a user: identity and password in one step.",
	Example: `  casas-eternas auth user add ada
  echo -n 'the-password' | casas-eternas auth user add ada --password-stdin`,
	Args: cobra.ExactArgs(1),
	// The argument is a NEW name — nothing to complete, and certainly not
	// filenames.
	ValidArgsFunction: cobra.NoFileCompletions,
	RunE:              runAuthUserAdd,
}

var authUserListCmd = &cobra.Command{
	Use:   "list",
	Short: "Lists every user, and whether they can log in.",
	Args:  cobra.NoArgs,
	RunE:  runAuthUserList,
}

var authUserDeleteCmd = &cobra.Command{
	Use:               "delete <name>",
	Short:             "Removes a user. Their worlds fall to admins; re-adding the name mints a NEW identity.",
	Args:              cobra.ExactArgs(1),
	ValidArgsFunction: completeUserNames,
	RunE:              runAuthUserDelete,
}

var authUserPasswdCmd = &cobra.Command{
	Use:   "passwd <name>",
	Short: "Sets a user's password.",
	Example: `  casas-eternas auth user passwd ada
  echo -n 'the-password' | casas-eternas auth user passwd ada --password-stdin`,
	Args:              cobra.ExactArgs(1),
	ValidArgsFunction: completeUserNames,
	RunE:              runAuthUserPasswd,
}

// completeUserNames asks the running server, so tab completion offers the
// names that actually exist. Best effort by design: an unreachable socket
// answers with no candidates rather than an error — completion must never
// be the thing that fails.
func completeUserNames(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	if len(args) != 0 {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	var listing struct {
		Users []user.Listing `json:"users"`
	}
	if err := adminRequest(http.MethodGet, auth.UsersPath, nil, &listing); err != nil {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	names := make([]string, 0, len(listing.Users))
	for _, u := range listing.Users {
		names = append(names, u.Name)
	}
	return names, cobra.ShellCompDirectiveNoFileComp
}

func init() {
	authUserAddCmd.Flags().Bool(flagPasswordStdin, false, textPasswordStdin)
	authUserPasswdCmd.Flags().Bool(flagPasswordStdin, false, textPasswordStdin)
	authUserCmd.AddCommand(authUserAddCmd, authUserListCmd, authUserDeleteCmd, authUserPasswdCmd)
	authCmd.AddCommand(authUserCmd)
	RootCmd.AddCommand(authCmd)
}

func runAuthUserAdd(cmd *cobra.Command, args []string) error {
	password, err := readPassword(cmd, true)
	if err != nil {
		return err
	}
	var created user.User
	if err := adminRequest(http.MethodPost, auth.UsersPath,
		map[string]string{"name": args[0], "password": password}, &created); err != nil {
		return err
	}
	fmt.Fprintf(cmd.OutOrStdout(), "created %s (%s)\n", created.Name, created.ID)
	return nil
}

func runAuthUserList(cmd *cobra.Command, args []string) error {
	var listing struct {
		Users []user.Listing `json:"users"`
	}
	if err := adminRequest(http.MethodGet, auth.UsersPath, nil, &listing); err != nil {
		return err
	}
	w := tabwriter.NewWriter(cmd.OutOrStdout(), 2, 8, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tID\tCREATED\tLOGIN")
	for _, u := range listing.Users {
		created := "-"
		if !u.CreatedAt.IsZero() {
			created = u.CreatedAt.UTC().Format("2006-01-02 15:04")
		}
		login := "yes"
		if !u.HasCredential {
			// A real state, not an anomaly: an identity minted at a login
			// before passwords moved into the store, or OIDC-only one day.
			login = "no password"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", u.Name, u.ID, created, login)
	}
	return w.Flush()
}

func runAuthUserDelete(cmd *cobra.Command, args []string) error {
	if err := adminRequest(http.MethodDelete, auth.UsersPath+"/"+args[0], nil, nil); err != nil {
		return err
	}
	fmt.Fprintf(cmd.OutOrStdout(), "deleted %s\n", args[0])
	return nil
}

func runAuthUserPasswd(cmd *cobra.Command, args []string) error {
	password, err := readPassword(cmd, true)
	if err != nil {
		return err
	}
	if err := adminRequest(http.MethodPut, auth.UsersPath+"/"+args[0]+"/password",
		map[string]string{"password": password}, nil); err != nil {
		return err
	}
	fmt.Fprintf(cmd.OutOrStdout(), "password set for %s\n", args[0])
	return nil
}

// readPassword takes the password from the terminal (echo off, asked twice —
// a typo'd password set blind is a lockout) or, with --password-stdin, from
// stdin whole. Never from argv: arguments land in `ps` and shell history.
func readPassword(cmd *cobra.Command, confirm bool) (string, error) {
	fromStdin, err := cmd.Flags().GetBool(flagPasswordStdin)
	if err != nil {
		return "", err
	}
	if fromStdin {
		raw, err := io.ReadAll(cmd.InOrStdin())
		if err != nil {
			return "", fmt.Errorf("reading the password from stdin: %w", err)
		}
		return strings.TrimRight(string(raw), "\r\n"), nil
	}
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		return "", fmt.Errorf("stdin is not a terminal; pipe the password with --%s", flagPasswordStdin)
	}
	fmt.Fprint(cmd.ErrOrStderr(), "Password: ")
	first, err := term.ReadPassword(fd)
	fmt.Fprintln(cmd.ErrOrStderr())
	if err != nil {
		return "", err
	}
	if confirm {
		fmt.Fprint(cmd.ErrOrStderr(), "Repeat: ")
		second, err := term.ReadPassword(fd)
		fmt.Fprintln(cmd.ErrOrStderr())
		if err != nil {
			return "", err
		}
		if !bytes.Equal(first, second) {
			return "", fmt.Errorf("the passwords do not match")
		}
	}
	return string(first), nil
}

// adminRequest resolves the socket from the same config vocabulary the
// server reads, then delegates.
func adminRequest(method, path string, body any, into any) error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	socket := cfg.Global.Admin.Socket
	if socket == "" {
		return fmt.Errorf("no admin socket configured — set %s to where the server listens (flag, casas.yaml or CASAS_GLOBAL_ADMIN_SOCKET)", keyAdminSock)
	}
	return adminRequestOver(socket, method, path, body, into)
}

// adminRequestOver is the one door to the socket: dial it, and turn the
// module's error shape back into a message.
func adminRequestOver(socket, method, path string, body any, into any) error {
	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(raw)
	}
	// The host is a placeholder: the dialer below ignores it and opens the
	// socket. It still appears in error messages, so it names what it is.
	request, err := http.NewRequest(method, "http://admin-socket"+path, payload)
	if err != nil {
		return err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	client := http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socket)
			},
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("admin socket %s: %w (is the server running?)", socket, err)
	}
	defer response.Body.Close()

	if response.StatusCode >= 400 {
		// The module's error shape; `targets` is the wrong-pod answer.
		var remote struct {
			Error   string   `json:"error"`
			Targets []string `json:"targets"`
		}
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		if json.Unmarshal(raw, &remote) == nil && remote.Error != "" {
			if len(remote.Targets) > 0 {
				return fmt.Errorf("%s — this process runs %s; run this against the process serving the auth target", remote.Error, strings.Join(remote.Targets, ", "))
			}
			return fmt.Errorf("%s", remote.Error)
		}
		return fmt.Errorf("admin socket answered %s", response.Status)
	}
	if into != nil {
		return json.NewDecoder(response.Body).Decode(into)
	}
	return nil
}
