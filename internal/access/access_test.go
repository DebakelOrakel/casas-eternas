package access

import "testing"

// The matrix from the design doc, row by row — the table IS the
// specification, so the test states it whole rather than sampling.
func TestTheMatrix(t *testing.T) {
	grants := Grants{
		Owner: "own",
		Users: map[string]string{"ed": "editor", "view": "viewer"},
	}
	cases := []struct {
		caller string
		action Action
		want   bool
	}{
		{"view", ActionRead, true},
		{"view", ActionWrite, false},
		{"view", ActionBake, false},
		{"view", ActionShare, false},
		{"view", ActionDelete, false},

		{"ed", ActionRead, true},
		{"ed", ActionWrite, true},
		{"ed", ActionBake, true},
		{"ed", ActionShare, false},
		{"ed", ActionDelete, false},

		{"own", ActionRead, true},
		{"own", ActionWrite, true},
		{"own", ActionBake, true},
		{"own", ActionShare, true},
		{"own", ActionDelete, true},

		{"stranger", ActionRead, false},
	}
	for _, c := range cases {
		if got := Can(c.caller, false, c.action, grants); got != c.want {
			t.Errorf("Can(%s, %s) = %v, want %v", c.caller, c.action, got, c.want)
		}
	}
	// The admin claim overrides everything, including on a world it appears
	// nowhere in.
	for _, action := range []Action{ActionRead, ActionWrite, ActionBake, ActionShare, ActionDelete} {
		if !Can("operator", true, action, grants) {
			t.Errorf("admin refused %s", action)
		}
	}
}

func TestPublicMakesAuthenticatedCallersViewers(t *testing.T) {
	grants := Grants{Owner: "own", Public: true}
	if !Can("stranger", false, ActionRead, grants) {
		t.Error("a public world refused a reader")
	}
	if Can("stranger", false, ActionWrite, grants) {
		t.Error("public granted more than viewing")
	}
	if Can("", false, ActionRead, grants) {
		t.Error("an empty caller id ranked above None")
	}
}

// Unknown actions must fail CLOSED — a typo in a check must never widen it.
func TestUnknownActionRequiresAdmin(t *testing.T) {
	grants := Grants{Owner: "own"}
	if Can("own", false, Action("wolrd.delete"), grants) {
		t.Error("a typoed action was granted to a non-admin")
	}
}

// A hand-edited grants file with a bad role name ranks as None on the read
// path; the loud refusal belongs to the API that writes the file.
func TestUnknownRoleNameRanksAsNone(t *testing.T) {
	grants := Grants{Owner: "own", Users: map[string]string{"x": "emperor"}}
	if got := grants.LevelOf("x"); got != None {
		t.Errorf("emperor ranked as %v", got)
	}
	// ... and no lower than a stranger: on a public world the bad name is a
	// viewer like everyone else, not locked out by the typo.
	grants.Public = true
	if got := grants.LevelOf("x"); got != Viewer {
		t.Errorf("emperor on a public world ranked as %v, want Viewer", got)
	}
	if _, err := ParseLevel("emperor"); err == nil {
		t.Error("ParseLevel accepted an unknown role")
	}
	if _, err := ParseLevel("admin"); err == nil {
		t.Error("admin must not be grantable per world")
	}
}

// The order is the check — each level strictly adds.
func TestLevelsAreTotallyOrdered(t *testing.T) {
	order := []Level{None, Viewer, Editor, Owner, Admin}
	for i := 1; i < len(order); i++ {
		if order[i-1] >= order[i] {
			t.Errorf("%v is not below %v", order[i-1], order[i])
		}
	}
	for _, name := range []string{"viewer", "editor", "owner"} {
		level, err := ParseLevel(name)
		if err != nil {
			t.Fatalf("ParseLevel(%s): %v", name, err)
		}
		if level.String() != name {
			t.Errorf("round trip %s → %v → %s", name, level, level.String())
		}
	}
}
