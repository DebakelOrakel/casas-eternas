package auth

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/httpjson"
	"github.com/DebakelOrakel/casas-eternas/internal/user"
)

// CODES over HTTP (docs/decisions/client-accounts.md, forks 3 and 4;
// internal/user/codes.go): an admin makes invite and reset codes through
// the admin API, and anyone holding one redeems it on the public route —
// an invite makes an account, a reset sets a password, and either signs
// the holder in.

// InvitesPath is the admin collection of invite codes.
const InvitesPath = "/v1/auth/invites"

// RedeemPath is where a code is spent. Public, like the login.
const RedeemPath = "/v1/auth/redeem"

// actorKey carries who made an admin call, for the records a call writes:
// the admin's login name on the network, "admin socket" on the socket.
type actorKey struct{}

func actorOf(r *http.Request) string {
	if name, ok := r.Context().Value(actorKey{}).(string); ok {
		return name
	}
	return "admin socket"
}

func withActor(r *http.Request, name string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), actorKey{}, name))
}

// inviteCreated is what creating an invite answers: the record and the code,
// which exists only in this answer.
type inviteCreated struct {
	user.Invite
	Code string `json:"code"`
}

func (m *Module) serveCreateInvite(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Uses       int `json:"uses"`
		ValidHours int `json:"validHours"`
	}
	if !decodeAdminBody(w, r, &body) {
		return
	}
	invite, code, err := m.cfg.Registry.CreateInvite(body.Uses, time.Duration(body.ValidHours)*time.Hour, actorOf(r))
	if err != nil {
		adminError(w, "creating an invite", err)
		return
	}
	slog.Info("invite created through the admin API", "id", invite.ID, "uses", invite.Uses, "expires", invite.ExpiresAt, "by", actorOf(r))
	w.Header().Set("Cache-Control", "no-store")
	httpjson.Write(w, http.StatusCreated, inviteCreated{Invite: invite, Code: code})
}

func (m *Module) serveListInvites(w http.ResponseWriter, r *http.Request) {
	invites, err := m.cfg.Registry.ListInvites()
	if err != nil {
		httpjson.ServerError(w, "listing invites", err)
		return
	}
	if invites == nil {
		invites = []user.Invite{}
	}
	httpjson.Write(w, http.StatusOK, map[string]any{"invites": invites})
}

func (m *Module) serveRevokeInvite(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := m.cfg.Registry.RevokeInvite(id); err != nil {
		adminError(w, "revoking an invite", err)
		return
	}
	slog.Info("invite revoked through the admin API", "id", id, "by", actorOf(r))
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) serveCreateReset(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	code, expires, err := m.cfg.Registry.CreateReset(name)
	if err != nil {
		adminError(w, "creating a reset code", err)
		return
	}
	slog.Info("reset code created through the admin API", "user", name, "expires", expires, "by", actorOf(r))
	w.Header().Set("Cache-Control", "no-store")
	httpjson.Write(w, http.StatusCreated, map[string]any{"code": code, "expiresAt": expires})
}

// --- redeeming ---------------------------------------------------------------

// Failed redemptions a client address may make in redeemWindow before it is
// turned away: generous for a typo, nothing for a guesser of 80 bits.
const (
	redeemFailures = 10
	redeemWindow   = 15 * time.Minute
)

type limiter struct {
	mu       sync.Mutex
	failures map[string][]time.Time
}

func (l *limiter) blocked(addr string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	recent := l.failures[addr][:0]
	for _, at := range l.failures[addr] {
		if now.Sub(at) < redeemWindow {
			recent = append(recent, at)
		}
	}
	if len(recent) == 0 {
		delete(l.failures, addr)
	} else {
		l.failures[addr] = recent
	}
	return len(recent) >= redeemFailures
}

// limiterSweepAt is the number of addresses past which a failure sweeps
// every address's stale entries: blocked prunes only the address it is
// asked about, so addresses that fail once and never come back would
// otherwise stay for good.
const limiterSweepAt = 1024

func (l *limiter) fail(addr string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.failures == nil {
		l.failures = map[string][]time.Time{}
	}
	if len(l.failures) >= limiterSweepAt {
		for known, times := range l.failures {
			if now.Sub(times[len(times)-1]) >= redeemWindow {
				delete(l.failures, known)
			}
		}
	}
	l.failures[addr] = append(l.failures[addr], now)
}

// clientAddr is who is asking, for the limiter. The connection's address,
// unless that is a private or loopback one — a router in front (the
// cluster's) — and X-Forwarded-For is set: then its LAST entry, the one
// that router appended. The first entry is the client's own word and was
// trusted until 2026-10-04, which let anyone pass the limiter with a new
// address per request.
func clientAddr(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer := net.ParseIP(host)
	forwarded := r.Header.Values("X-Forwarded-For")
	if peer == nil || !(peer.IsLoopback() || peer.IsPrivate()) || len(forwarded) == 0 {
		return host
	}
	hops := strings.Split(forwarded[len(forwarded)-1], ",")
	if last := strings.TrimSpace(hops[len(hops)-1]); last != "" {
		return last
	}
	return host
}

// serveRedeem spends a code and signs its holder in, answering as the login
// does. A code that is not valid answers 403 the same way whatever was wrong.
func (m *Module) serveRedeem(w http.ResponseWriter, r *http.Request) {
	addr, now := clientAddr(r), time.Now()
	if m.redeem.blocked(addr, now) {
		httpjson.ClientError(w, http.StatusTooManyRequests, "too many attempts; try again later")
		return
	}
	var body struct {
		Code     string `json:"code"`
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAdminBody))
	if err := decoder.Decode(&body); err != nil {
		httpjson.ClientError(w, http.StatusBadRequest, "body: "+err.Error())
		return
	}
	entry, err := m.cfg.Registry.Redeem(body.Code, strings.TrimSpace(body.Name), body.Password)
	switch {
	case errors.Is(err, user.ErrCode):
		m.redeem.fail(addr, now)
		slog.Info("a code was refused", "from", addr)
		httpjson.ClientError(w, http.StatusForbidden, err.Error())
		return
	case errors.Is(err, user.ErrInvalid):
		// A bad name is checked after the code, so its answer tells a valid
		// code from an invalid one: it counts against the limiter too.
		m.redeem.fail(addr, now)
		adminError(w, "redeeming a code", err)
		return
	case err != nil:
		adminError(w, "redeeming a code", err)
		return
	}
	slog.Info("code redeemed", "user", entry.Name, "id", entry.ID, "invite", entry.InvitedBy)
	m.signIn(w, entry)
}
