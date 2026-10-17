// Package access answers "may this caller do that to this world" — the
// per-world ACL docs/design/access-control.md decided: a (principal → role)
// list, where a principal is a user or one of two pseudo-principals
// (docs/decisions/roles-and-visibility.md, DEC-0040), levels totally
// ordered so the check is one rank comparison. Authorization here is DATA, not code — the matrix is a table,
// the grants are a JSON file, Can is a lookup — which is exactly the form a
// later engine migration would start from, should groups or a second
// resource type ever earn one.
//
// A LEAF: it imports nothing of this repo. The modules embed it and cmd/
// wires the grants lookups, the same composition that distributes
// identity.Resolver — there is deliberately no decision SERVICE, because the
// decision data lives beside each world and centralising it would buy the
// Zanzibar costs without the Zanzibar benefits.
package access

import (
	"encoding/json"
	"fmt"
)

// Level is a rank in the total order none < viewer < editor < owner < admin.
//
// The ORDER is interpretation, not storage: grants.json records role names,
// and a future role that breaks the total order (conceivable in the game
// era) switches this interpretation back to a matrix without touching any
// file or API.
type Level int

const (
	// None is the absence of any grant — the zero value on purpose.
	None Level = iota
	// Viewer reads: the zip, the preview, the artifacts, bake status.
	// Artifacts ARE world data, which is why reading them is not
	// "informational".
	Viewer
	// Editor also writes revisions. (Every reader orders bakes since
	// DEC-0039, fork 5; the jobs module checks that.)
	Editor
	// Owner also shares (grants, the visibility, transfer) and deletes.
	Owner
	// Admin is the operator: global, never stored in grants.json — it
	// arrives as the session token's claim.
	Admin
)

// levelNames is the storage vocabulary. Admin is deliberately absent: it is
// not grantable per world, so a grants file claiming it is invalid.
var levelNames = map[string]Level{"viewer": Viewer, "editor": Editor, "owner": Owner}

// ParseLevel resolves a stored role name. Unknown names FAIL — a typo in a
// hand-edited grants file must not silently become "no access" for someone
// the owner meant to invite, nor anything more.
func ParseLevel(name string) (Level, error) {
	if level, ok := levelNames[name]; ok {
		return level, nil
	}
	return None, fmt.Errorf("unknown role %q (grantable: viewer, editor, owner)", name)
}

// String names a level for storage and messages.
func (l Level) String() string {
	switch l {
	case Viewer:
		return "viewer"
	case Editor:
		return "editor"
	case Owner:
		return "owner"
	case Admin:
		return "admin"
	default:
		return "none"
	}
}

// Action names something a caller wants to do. Named values ("world.…")
// rather than an enum precisely so a later `game.*` family is additive.
type Action string

const (
	ActionRead  Action = "world.read"
	ActionWrite Action = "world.write"
	// ActionShare changes the grants: collaborators, and the visibility up
	// to signed in.
	ActionShare  Action = "world.share"
	ActionDelete Action = "world.delete"
	// ActionPublish makes a world readable by every caller, the anonymous
	// one included (VisibilityPublic). The operator's: anonymous reads load
	// the server with nobody to answer for them (DEC-0040, fork 4).
	ActionPublish Action = "world.publish"
	// ActionTemplate sets or removes a world's template mark (Grants.Template).
	// The operator's, not the owner's: a template is offered to EVERY visitor
	// of the server, signed in or not, which is a decision about the server
	// and not about one world (docs/decisions/template-worlds.md).
	ActionTemplate Action = "world.template"
)

// Required is the matrix from the design doc, folded through the total
// order: the LOWEST level that may perform the action. Unknown actions
// require Admin — failing closed is the only safe answer to a typo.
func Required(action Action) Level {
	switch action {
	case ActionRead:
		return Viewer
	case ActionWrite:
		return Editor
	case ActionShare, ActionDelete:
		return Owner
	case ActionTemplate, ActionPublish:
		return Admin
	default:
		return Admin
	}
}

// worldActions is every world action, in the order Actions answers them.
var worldActions = []Action{ActionRead, ActionWrite, ActionShare, ActionDelete, ActionPublish, ActionTemplate}

// Actions answers the world actions a caller of `level` may perform — what
// the API gives the client in place of a level, so that the client derives
// no rule of its own (DEC-0040, fork 7). Empty below Viewer.
func Actions(level Level) []Action {
	allowed := []Action{}
	for _, action := range worldActions {
		if level >= Required(action) {
			allowed = append(allowed, action)
		}
	}
	return allowed
}

// The visibility of a world: which pseudo-principal holds the viewer role
// on it (DEC-0040, fork 4). The wire and storage names.
const (
	// VisibilityPrivate: the owner and the named users only.
	VisibilityPrivate = "private"
	// VisibilitySignedIn: every signed-in caller is a viewer.
	VisibilitySignedIn = "signedIn"
	// VisibilityPublic: every caller is a viewer, the anonymous one too.
	VisibilityPublic = "public"
)

// Grants is {uid}/grants.json — a world's ACL, beside its meta and OWNED BY
// THE SERVER: never part of the uploaded save, never rebuilt from one,
// which is what pins the owner against the re-stamp-per-upload bug.
type Grants struct {
	// Owner is the user ID pinned at creation; it moves only through an
	// explicit transfer (world.share), never by writing a revision.
	Owner string `json:"owner"`
	// Authenticated is the role of every signed-in caller (the
	// pseudo-principal "authenticated"); empty for none. Only "viewer" is
	// granted to it (SetVisibility).
	Authenticated string `json:"authenticated,omitempty"`
	// Anyone is the role of every caller, the anonymous one included (the
	// pseudo-principal "anyone"); empty for none. Only "viewer", and only by
	// an admin (ActionPublish).
	Anyone string `json:"anyone,omitempty"`
	// Template marks a world the server offers as a start to copy
	// (docs/decisions/template-worlds.md). A PURPOSE, not a right: it
	// grants nothing (DEC-0040, fork 5); who reads the world is its
	// visibility. Set only by an admin (ActionTemplate) — the owner's share
	// path keeps it as it is (world.Store.WriteGrants).
	Template bool `json:"template,omitempty"`
	// Users grants named collaborators a role, BY NAME (see Level).
	Users map[string]string `json:"users,omitempty"`
}

// UnmarshalJSON reads the current form and the form before DEC-0040. The
// old form always holds "public" (it had no omitempty), and the new one
// never does, so the key tells them apart: there `public` made every
// signed-in caller a viewer, and `template` made every caller one. The
// next write stores the new form.
func (g *Grants) UnmarshalJSON(data []byte) error {
	type plain Grants
	var read struct {
		plain
		Public *bool `json:"public"`
	}
	if err := json.Unmarshal(data, &read); err != nil {
		return err
	}
	*g = Grants(read.plain)
	if read.Public != nil {
		if *read.Public {
			g.Authenticated = "viewer"
		}
		if g.Template {
			g.Anyone = "viewer"
		}
	}
	return nil
}

// Visibility names the widest pseudo-principal grant.
func (g Grants) Visibility() string {
	switch {
	case g.Anyone != "":
		return VisibilityPublic
	case g.Authenticated != "":
		return VisibilitySignedIn
	default:
		return VisibilityPrivate
	}
}

// WithVisibility answers the grants with the pseudo-principals set to the
// visibility `v`. False for an unknown name.
func (g Grants) WithVisibility(v string) (Grants, bool) {
	switch v {
	case VisibilityPrivate:
		g.Authenticated, g.Anyone = "", ""
	case VisibilitySignedIn:
		g.Authenticated, g.Anyone = "viewer", ""
	case VisibilityPublic:
		g.Authenticated, g.Anyone = "viewer", "viewer"
	default:
		return g, false
	}
	return g, true
}

// LevelOf ranks a caller against these grants: the highest role of the
// caller's own grant and the pseudo-principals' that apply. An unknown role
// name in the file grants nothing — ParseLevel's loud path belongs to the
// grants API that writes the file, not to every read on the request path —
// but it does not take anything away either: the caller then ranks as any
// other signed-in caller does. A typo in the file must not leave a named
// collaborator seeing less than a stranger.
//
// The empty caller id is the anonymous one: only "anyone" applies to it.
func (g Grants) LevelOf(callerID string) Level {
	level := roleLevel(g.Anyone)
	if callerID == "" {
		return level
	}
	level = max(level, roleLevel(g.Authenticated))
	if callerID == g.Owner {
		return Owner
	}
	return max(level, roleLevel(g.Users[callerID]))
}

// roleLevel is a stored role name's level; None for an empty or unknown one.
func roleLevel(name string) Level {
	level, err := ParseLevel(name)
	if err != nil {
		return None
	}
	return level
}

// Can is the whole check: one rank comparison. `admin` comes from the
// session token's claim (identity.Resolver.Admin); the none-mode short
// circuit lives with the caller, which knows the mode — this package
// deliberately does not.
func Can(callerID string, admin bool, action Action, grants Grants) bool {
	if admin {
		return true
	}
	return grants.LevelOf(callerID) >= Required(action)
}

// LevelFromString reads a REPORTED level — the wire form of String(), as the
// world service's meta endpoint answers it to a peer ranking a caller.
// Tolerant where ParseLevel is strict: every String() output is valid here
// (including none and admin, which are never grantable and so never parse),
// and anything else ranks as None — a peer must fail closed, not open.
func LevelFromString(name string) Level {
	switch name {
	case "viewer":
		return Viewer
	case "editor":
		return Editor
	case "owner":
		return Owner
	case "admin":
		return Admin
	default:
		return None
	}
}
