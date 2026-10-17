package access

import (
	"encoding/json"
	"slices"
	"testing"
)

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
		{"view", ActionShare, false},
		{"view", ActionDelete, false},

		{"ed", ActionRead, true},
		{"ed", ActionWrite, true},
		{"ed", ActionShare, false},
		{"ed", ActionDelete, false},

		{"own", ActionRead, true},
		{"own", ActionWrite, true},
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
	for _, action := range []Action{ActionRead, ActionWrite, ActionShare, ActionDelete} {
		if !Can("operator", true, action, grants) {
			t.Errorf("admin refused %s", action)
		}
	}
}

func TestSignedInMakesAuthenticatedCallersViewers(t *testing.T) {
	grants := Grants{Owner: "own", Authenticated: "viewer"}
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
	grants.Authenticated = "viewer"
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

// The pseudo-principal "anyone" opens READING to every caller, the
// anonymous one (empty id) included, and nothing more; "authenticated" does
// not reach the anonymous caller. The template mark grants nothing
// (DEC-0040, fork 5), and setting it, or the public visibility, is the
// admin's alone.
func TestAnyoneMakesEveryCallerAViewer(t *testing.T) {
	grants := Grants{Owner: "own", Anyone: "viewer"}
	for _, caller := range []string{"", "stranger"} {
		if !Can(caller, false, ActionRead, grants) {
			t.Errorf("caller %q refused reading a public world", caller)
		}
		if Can(caller, false, ActionWrite, grants) {
			t.Errorf("caller %q may write a public world", caller)
		}
	}
	if Can("", false, ActionRead, Grants{Owner: "own", Authenticated: "viewer"}) {
		t.Error("a world for signed-in callers opened to the anonymous caller")
	}
	if Can("stranger", false, ActionRead, Grants{Owner: "own", Template: true}) {
		t.Error("the template mark granted reading")
	}
	for _, action := range []Action{ActionTemplate, ActionPublish} {
		if Can("own", false, action, grants) {
			t.Errorf("the owner may %s", action)
		}
		if !Can("operator", true, action, grants) {
			t.Errorf("the admin may not %s", action)
		}
	}
}

// grants.json from before DEC-0040 always holds "public": public made the
// signed-in callers viewers, template every caller. The new form never
// holds it, so a template mark there grants nothing.
func TestOldGrantsAreRead(t *testing.T) {
	for _, c := range []struct {
		file, visibility string
		template         bool
	}{
		{`{"owner":"own","public":false}`, VisibilityPrivate, false},
		{`{"owner":"own","public":true}`, VisibilitySignedIn, false},
		{`{"owner":"own","public":false,"template":true}`, VisibilityPublic, true},
		{`{"owner":"own","template":true}`, VisibilityPrivate, true},
		{`{"owner":"own","authenticated":"viewer"}`, VisibilitySignedIn, false},
	} {
		var g Grants
		if err := json.Unmarshal([]byte(c.file), &g); err != nil {
			t.Fatal(err)
		}
		if g.Visibility() != c.visibility || g.Template != c.template || g.Owner != "own" {
			t.Errorf("%s → %+v, want %s, template %v", c.file, g, c.visibility, c.template)
		}
		written, _ := json.Marshal(g)
		var again Grants
		_ = json.Unmarshal(written, &again)
		if again.Visibility() != c.visibility || again.Template != c.template {
			t.Errorf("%s does not survive a write: %s", c.file, written)
		}
	}
}

func TestVisibilityRoundTrip(t *testing.T) {
	for _, v := range []string{VisibilityPrivate, VisibilitySignedIn, VisibilityPublic} {
		g, ok := Grants{Owner: "own", Users: map[string]string{"ed": "editor"}}.WithVisibility(v)
		if !ok || g.Visibility() != v || g.Users["ed"] != "editor" {
			t.Errorf("WithVisibility(%s) = %+v %v", v, g, ok)
		}
	}
	if _, ok := (Grants{}).WithVisibility("everyone"); ok {
		t.Error("an unknown visibility was accepted")
	}
}

// The actions follow the levels: what the API gives the client.
func TestActionsFollowTheLevel(t *testing.T) {
	for _, c := range []struct {
		level Level
		want  []Action
	}{
		{None, []Action{}},
		{Viewer, []Action{ActionRead}},
		{Editor, []Action{ActionRead, ActionWrite}},
		{Owner, []Action{ActionRead, ActionWrite, ActionShare, ActionDelete}},
		{Admin, []Action{ActionRead, ActionWrite, ActionShare, ActionDelete, ActionPublish, ActionTemplate}},
	} {
		if got := Actions(c.level); !slices.Equal(got, c.want) {
			t.Errorf("Actions(%s) = %v, want %v", c.level, got, c.want)
		}
	}
}
