package config

import "testing"

// The failure this guards is not "a typo is rejected" — it is what a typo would
// do if it were NOT. ChecksIdentity counts everything that is not `none` as a
// mode that checks, so `--auth-mode passwrod` would start a server that refuses
// every request while looking healthy. That reads as a permission bug and gets
// debugged as one.
func TestParseAuthMode(t *testing.T) {
	for _, valid := range []string{"none", "password", "oidc"} {
		mode, err := ParseAuthMode(valid)
		if err != nil {
			t.Errorf("ParseAuthMode(%q) errored: %v", valid, err)
		}
		if string(mode) != valid {
			t.Errorf("ParseAuthMode(%q) = %q", valid, mode)
		}
	}

	// Surrounding whitespace survives a container environment or a YAML file
	// more often than anyone expects, and it is not a mistake worth failing on.
	if mode, err := ParseAuthMode("  password\n"); err != nil || mode != AuthPassword {
		t.Errorf("padded value = %q, %v; want password, nil", mode, err)
	}

	// Empty included: the flag defaults to `none`, so an empty value can only
	// come from someone passing one, and guessing what they meant is the habit
	// this whole function exists to break.
	for _, invalid := range []string{"", "token", "passwrod", "NONE", "basic"} {
		if _, err := ParseAuthMode(invalid); err == nil {
			t.Errorf("ParseAuthMode(%q) accepted an unknown mode", invalid)
		}
	}
}

// The predicate every authorisation decision hangs off. It is separate from the
// parser on purpose: a zero-valued Config (a module constructed in a test
// without naming a mode) must read as "not checking", not as "checking, and
// therefore refusing everyone".
func TestChecksIdentity(t *testing.T) {
	cases := map[AuthMode]bool{
		AuthNone:     false,
		"":           false,
		AuthPassword: true,
		AuthOIDC:     true,
	}
	for mode, want := range cases {
		if got := mode.ChecksIdentity(); got != want {
			t.Errorf("AuthMode(%q).ChecksIdentity() = %v, want %v", mode, got, want)
		}
	}
}
