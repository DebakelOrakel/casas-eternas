// Package access answers "may this caller do that to this world" — the
// per-world ACL docs/design/access-control.md decided: a (user → role) list
// plus a public bit, levels totally ordered so the check is one rank
// comparison. Authorization here is DATA, not code — the matrix is a table,
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

import "fmt"

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
	// Editor also writes revisions and commissions bakes — a shared world
	// nobody may bake cannot be played together at 4K.
	Editor
	// Owner also shares (grants, the public flag, transfer) and deletes.
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
	ActionRead   Action = "world.read"
	ActionWrite  Action = "world.write"
	ActionBake   Action = "world.bake"
	ActionShare  Action = "world.share"
	ActionDelete Action = "world.delete"
)

// Required is the matrix from the design doc, folded through the total
// order: the LOWEST level that may perform the action. Unknown actions
// require Admin — failing closed is the only safe answer to a typo.
func Required(action Action) Level {
	switch action {
	case ActionRead:
		return Viewer
	case ActionWrite, ActionBake:
		return Editor
	case ActionShare, ActionDelete:
		return Owner
	default:
		return Admin
	}
}

// Grants is {uid}/grants.json — a world's ACL, beside its meta and OWNED BY
// THE SERVER: never part of the uploaded save, never rebuilt from one,
// which is what pins the owner against the re-stamp-per-upload bug.
type Grants struct {
	// Owner is the user ID pinned at creation; it moves only through an
	// explicit transfer (world.share), never by writing a revision.
	Owner string `json:"owner"`
	// Public makes every authenticated caller a viewer.
	Public bool `json:"public"`
	// Users grants named collaborators a role, BY NAME (see Level).
	Users map[string]string `json:"users,omitempty"`
}

// LevelOf ranks a caller against these grants. Unknown role names in the
// file rank as None here — ParseLevel's loud path belongs to the grants
// API that writes the file, not to every read on the request path.
func (g Grants) LevelOf(callerID string) Level {
	if callerID == "" {
		return None
	}
	if callerID == g.Owner {
		return Owner
	}
	if name, ok := g.Users[callerID]; ok {
		if level, err := ParseLevel(name); err == nil {
			return level
		}
		return None
	}
	if g.Public {
		return Viewer
	}
	return None
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
