// The admin CLI: `casas-eternas auth user add|list|delete|passwd|reset|block|
// unblock`, `auth role bind|list`, `auth code add|list|revoke` and
// `auth service add|list|delete|rotate` — thin
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

const (
	flagPasswordStdin = "password-stdin"
	flagCodeUses      = "uses"
	flagCodeValid     = "valid"
)

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

var authUserResetCmd = &cobra.Command{
	Use:   "reset <name>",
	Short: "Makes a reset code: it sets the user's password once, within a day, and ends their sessions.",
	Long: `Makes a reset code for a user who cannot sign in. The code is printed
ONCE on stdout; the user spends it in the sign-in window ("I have a code")
with a new password. A new code for the same user ends the last one.`,
	Args:              cobra.ExactArgs(1),
	ValidArgsFunction: completeUserNames,
	RunE:              runAuthUserReset,
}

var authUserBlockCmd = &cobra.Command{
	Use:               "block <name>",
	Short:             "Blocks a user: no sign-in, and their sessions end within an access token's life. Their worlds stay theirs.",
	Args:              cobra.ExactArgs(1),
	ValidArgsFunction: completeUserNames,
	RunE:              func(cmd *cobra.Command, args []string) error { return setBlocked(cmd, args[0], true) },
}

var authUserUnblockCmd = &cobra.Command{
	Use:               "unblock <name>",
	Short:             "Lets a blocked user sign in again.",
	Args:              cobra.ExactArgs(1),
	ValidArgsFunction: completeUserNames,
	RunE:              func(cmd *cobra.Command, args []string) error { return setBlocked(cmd, args[0], false) },
}

// The code RESOURCE: invite codes, the only way to a new account besides
// `user add` (docs/decisions/client-accounts.md, fork 4). `add` prints the
// code ONCE on stdout, like a service credential; the server keeps only
// its hash.
var authCodeCmd = &cobra.Command{
	Use:   "code",
	Short: "Manages invite codes — how a new user makes an account.",
}

var authCodeAddCmd = &cobra.Command{
	Use:   "add",
	Short: "Makes an invite code for a number of registrations, valid for a while.",
	Example: `  casas-eternas auth code add                          # one registration, 14 days
  casas-eternas auth code add --uses 5 --valid 72h`,
	Args: cobra.NoArgs,
	RunE: runAuthCodeAdd,
}

var authCodeListCmd = &cobra.Command{
	Use:   "list",
	Short: "Lists the invite codes not yet spent or expired.",
	Args:  cobra.NoArgs,
	RunE:  runAuthCodeList,
}

var authCodeRevokeCmd = &cobra.Command{
	Use:               "revoke <id>",
	Short:             "Ends an invite code before it is spent.",
	Args:              cobra.ExactArgs(1),
	ValidArgsFunction: completeCodeIDs,
	RunE:              runAuthCodeRevoke,
}

// The role RESOURCE, beside the user resource: `user` is who exists and how
// they prove it, `role` is what their sessions may claim. One global role
// per user — a field, not a set — so bind REPLACES, and binding `user` is
// the way back to the default. Per-world rights are grants on the world,
// deliberately not roles here (docs/design/access-control.md). The route
// behind bind stays under /v1/auth/users/{name}/role: the CLI groups by
// task, the API by record, and the record is the user's.
var authRoleCmd = &cobra.Command{
	Use:   "role",
	Short: "Manages global roles — what a user's sessions may claim.",
}

var authRoleBindCmd = &cobra.Command{
	Use:   "bind <name> <user|admin>",
	Short: "Binds a user's global role; it takes effect within an access token's life.",
	Example: `  casas-eternas auth role bind ada admin
  casas-eternas auth role bind ada user     # back to the default`,
	Args:              cobra.ExactArgs(2),
	ValidArgsFunction: completeRoleArgs,
	RunE:              runAuthRoleBind,
}

var authRoleListCmd = &cobra.Command{
	Use:   "list",
	Short: "Lists every binding that deviates from the default role.",
	Args:  cobra.NoArgs,
	RunE:  runAuthRoleList,
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

// The service RESOURCE: machines — job workers in the cluster and outside
// it — that trade a name and a secret for a short-lived bus token
// (internal/modules/auth/service.go). `add` and `rotate` print the
// credential ONCE, as `<name>:<secret>` on stdout and nothing else there,
// so it pipes straight into a Secret; what to do with it goes to stderr.
var authServiceCmd = &cobra.Command{
	Use:   "service",
	Short: "Manages service accounts — the credentials job workers prove themselves with.",
}

var authServiceAddCmd = &cobra.Command{
	Use:   "add <name>",
	Short: "Creates a service account and prints its credential, once.",
	Example: `  casas-eternas auth service add cluster-workers > credentials
  kubectl create secret generic casas-eternas-worker --from-file=credentials`,
	Args:              cobra.ExactArgs(1),
	ValidArgsFunction: cobra.NoFileCompletions,
	RunE:              runAuthServiceAdd,
}

var authServiceListCmd = &cobra.Command{
	Use:   "list",
	Short: "Lists every service account.",
	Args:  cobra.NoArgs,
	RunE:  runAuthServiceList,
}

var authServiceDeleteCmd = &cobra.Command{
	Use:               "delete <name>",
	Short:             "Removes a service account; the bus tokens it bought run out within the hour.",
	Args:              cobra.ExactArgs(1),
	ValidArgsFunction: completeServiceNames,
	RunE:              runAuthServiceDelete,
}

var authServiceRotateCmd = &cobra.Command{
	Use:               "rotate <name>",
	Short:             "Replaces a service account's secret and prints the new credential, once; the old one stops working.",
	Args:              cobra.ExactArgs(1),
	ValidArgsFunction: completeServiceNames,
	RunE:              runAuthServiceRotate,
}

func runAuthServiceAdd(cmd *cobra.Command, args []string) error {
	var created auth.CreatedService
	if err := adminRequest(http.MethodPost, auth.ServicesPath, map[string]string{"name": args[0]}, &created); err != nil {
		return err
	}
	fmt.Fprintf(cmd.OutOrStdout(), "%s:%s\n", created.Name, created.Secret)
	fmt.Fprintf(cmd.ErrOrStderr(), "created service account %s (%s); the credential above is shown once\n", created.Name, created.ID)
	return nil
}

func runAuthServiceList(cmd *cobra.Command, args []string) error {
	var listing struct {
		Services []user.Service `json:"services"`
	}
	if err := adminRequest(http.MethodGet, auth.ServicesPath, nil, &listing); err != nil {
		return err
	}
	w := tabwriter.NewWriter(cmd.OutOrStdout(), 2, 8, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tID\tCREATED")
	for _, s := range listing.Services {
		fmt.Fprintf(w, "%s\t%s\t%s\n", s.Name, s.ID, s.CreatedAt.UTC().Format("2006-01-02 15:04"))
	}
	return w.Flush()
}

func runAuthServiceDelete(cmd *cobra.Command, args []string) error {
	if err := adminRequest(http.MethodDelete, auth.ServicesPath+"/"+args[0], nil, nil); err != nil {
		return err
	}
	fmt.Fprintf(cmd.OutOrStdout(), "deleted service account %s\n", args[0])
	return nil
}

func runAuthServiceRotate(cmd *cobra.Command, args []string) error {
	var rotated auth.CreatedService
	if err := adminRequest(http.MethodPost, auth.ServicesPath+"/"+args[0]+"/rotate", nil, &rotated); err != nil {
		return err
	}
	fmt.Fprintf(cmd.OutOrStdout(), "%s:%s\n", rotated.Name, rotated.Secret)
	fmt.Fprintf(cmd.ErrOrStderr(), "rotated %s; the old secret no longer works, the credential above is shown once\n", rotated.Name)
	return nil
}

// completeServiceNames offers the service accounts that exist, best effort
// like completeUserNames.
func completeServiceNames(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	if len(args) != 0 {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	var listing struct {
		Services []user.Service `json:"services"`
	}
	if err := adminRequest(http.MethodGet, auth.ServicesPath, nil, &listing); err != nil {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	names := make([]string, 0, len(listing.Services))
	for _, s := range listing.Services {
		names = append(names, s.Name)
	}
	return names, cobra.ShellCompDirectiveNoFileComp
}

func runAuthRoleBind(cmd *cobra.Command, args []string) error {
	if err := adminRequest(http.MethodPut, auth.UsersPath+"/"+args[0]+"/role",
		map[string]string{"role": args[1]}, nil); err != nil {
		return err
	}
	fmt.Fprintf(cmd.OutOrStdout(), "role %s bound to %s (takes effect at their next token renewal)\n", args[1], args[0])
	return nil
}

// runAuthRoleList projects the user listing onto its bindings — no second
// endpoint, because the store is the one truth and this is presentation.
func runAuthRoleList(cmd *cobra.Command, args []string) error {
	var listing struct {
		Users []user.Listing `json:"users"`
	}
	if err := adminRequest(http.MethodGet, auth.UsersPath, nil, &listing); err != nil {
		return err
	}
	w := tabwriter.NewWriter(cmd.OutOrStdout(), 2, 8, 2, ' ', 0)
	bound := 0
	for _, u := range listing.Users {
		if u.Role == "" {
			continue
		}
		if bound == 0 {
			fmt.Fprintln(w, "NAME\tROLE")
		}
		bound++
		fmt.Fprintf(w, "%s\t%s\n", u.Name, u.Role)
	}
	if bound == 0 {
		fmt.Fprintf(w, "no bindings — every user has the default role (%s)\n", user.RoleUser)
	}
	return w.Flush()
}

// completeRoleArgs offers user names for the first argument and the role
// vocabulary for the second.
func completeRoleArgs(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	switch len(args) {
	case 0:
		return completeUserNames(cmd, args, toComplete)
	case 1:
		return []string{user.RoleUser, user.RoleAdmin}, cobra.ShellCompDirectiveNoFileComp
	default:
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
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
	authCodeAddCmd.Flags().Int(flagCodeUses, 1, "How many registrations the code allows.")
	authCodeAddCmd.Flags().Duration(flagCodeValid, 14*24*time.Hour, "How long the code holds, rounded up to whole hours.")
	authUserCmd.AddCommand(authUserAddCmd, authUserListCmd, authUserDeleteCmd, authUserPasswdCmd, authUserResetCmd, authUserBlockCmd, authUserUnblockCmd)
	authRoleCmd.AddCommand(authRoleBindCmd, authRoleListCmd)
	authCodeCmd.AddCommand(authCodeAddCmd, authCodeListCmd, authCodeRevokeCmd)
	authServiceCmd.AddCommand(authServiceAddCmd, authServiceListCmd, authServiceDeleteCmd, authServiceRotateCmd)
	authCmd.AddCommand(authUserCmd, authRoleCmd, authCodeCmd, authServiceCmd)
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
	fmt.Fprintln(w, "NAME\tID\tROLE\tCREATED\tLOGIN")
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
		if u.Blocked {
			login = "blocked"
		}
		role := u.Role
		if role == "" {
			role = user.RoleUser
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", u.Name, u.ID, role, created, login)
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

func runAuthUserReset(cmd *cobra.Command, args []string) error {
	var created struct {
		Code      string    `json:"code"`
		ExpiresAt time.Time `json:"expiresAt"`
	}
	if err := adminRequest(http.MethodPost, auth.UsersPath+"/"+args[0]+"/reset", nil, &created); err != nil {
		return err
	}
	fmt.Fprintln(cmd.OutOrStdout(), created.Code)
	fmt.Fprintf(cmd.ErrOrStderr(), "reset code for %s, valid until %s; shown once\n", args[0], created.ExpiresAt.Local().Format("2006-01-02 15:04"))
	return nil
}

func setBlocked(cmd *cobra.Command, name string, blocked bool) error {
	if err := adminRequest(http.MethodPut, auth.UsersPath+"/"+name+"/blocked", map[string]bool{"blocked": blocked}, nil); err != nil {
		return err
	}
	if blocked {
		fmt.Fprintf(cmd.OutOrStdout(), "blocked %s; their sessions end within an access token's life\n", name)
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "unblocked %s\n", name)
	}
	return nil
}

func runAuthCodeAdd(cmd *cobra.Command, args []string) error {
	uses, err := cmd.Flags().GetInt(flagCodeUses)
	if err != nil {
		return err
	}
	valid, err := cmd.Flags().GetDuration(flagCodeValid)
	if err != nil {
		return err
	}
	hours := int((valid + time.Hour - 1) / time.Hour)
	var created struct {
		user.Invite
		Code string `json:"code"`
	}
	if err := adminRequest(http.MethodPost, auth.InvitesPath, map[string]int{"uses": uses, "validHours": hours}, &created); err != nil {
		return err
	}
	fmt.Fprintln(cmd.OutOrStdout(), created.Code)
	fmt.Fprintf(cmd.ErrOrStderr(), "invite %s for %d registration(s), valid until %s; shown once\n", created.ID, created.Uses, created.ExpiresAt.Local().Format("2006-01-02 15:04"))
	return nil
}

func runAuthCodeList(cmd *cobra.Command, args []string) error {
	var listing struct {
		Invites []user.Invite `json:"invites"`
	}
	if err := adminRequest(http.MethodGet, auth.InvitesPath, nil, &listing); err != nil {
		return err
	}
	w := tabwriter.NewWriter(cmd.OutOrStdout(), 2, 8, 2, ' ', 0)
	fmt.Fprintln(w, "ID	CODE	LEFT	EXPIRES	BY")
	for _, invite := range listing.Invites {
		// The code's last group: the code itself is never kept.
		code := "••••-••••-••••-" + invite.Hint
		if invite.Hint == "" {
			code = "-"
		}
		fmt.Fprintf(w, "%s\t%s\t%d/%d\t%s\t%s\n", invite.ID, code, invite.Left, invite.Uses, invite.ExpiresAt.Local().Format("2006-01-02 15:04"), invite.CreatedBy)
	}
	return w.Flush()
}

func runAuthCodeRevoke(cmd *cobra.Command, args []string) error {
	if err := adminRequest(http.MethodDelete, auth.InvitesPath+"/"+args[0], nil, nil); err != nil {
		return err
	}
	fmt.Fprintf(cmd.OutOrStdout(), "revoked %s\n", args[0])
	return nil
}

// completeCodeIDs offers the open invite codes' ids, best effort like
// completeUserNames.
func completeCodeIDs(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	if len(args) != 0 {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	var listing struct {
		Invites []user.Invite `json:"invites"`
	}
	if err := adminRequest(http.MethodGet, auth.InvitesPath, nil, &listing); err != nil {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	ids := make([]string, 0, len(listing.Invites))
	for _, invite := range listing.Invites {
		ids = append(ids, invite.ID)
	}
	return ids, cobra.ShellCompDirectiveNoFileComp
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
