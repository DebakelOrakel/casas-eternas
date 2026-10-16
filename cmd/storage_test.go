package cmd

import (
	"strings"
	"testing"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

// A local worker reaches this server over its own API (DEC-0038, step 3).
func TestLoopbackURL(t *testing.T) {
	cases := []struct {
		listen, cert, ca, want, wantErr string
	}{
		{listen: ":8080", want: "http://127.0.0.1:8080/v1"},
		{listen: "0.0.0.0:8080", want: "http://127.0.0.1:8080/v1"},
		{listen: "[::]:8080", want: "http://[::1]:8080/v1"},
		{listen: "localhost:9000", want: "http://localhost:9000/v1"},
		{listen: "10.0.0.5:8080", want: "http://10.0.0.5:8080/v1"},
		{listen: ":8443", cert: "c.pem", want: "https://localhost:8443/v1"},
		{listen: ":8443", cert: "c.pem", ca: "ca.pem", wantErr: "client certificate"},
		{listen: "nonsense", wantErr: "global.listen"},
	}
	for _, c := range cases {
		var g config.Global
		g.Listen, g.TLS.Cert, g.TLS.CA = c.listen, c.cert, c.ca
		got, err := loopbackURL(g)
		if c.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Errorf("%s: err = %v, want %q", c.listen, err, c.wantErr)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%s (tls %v): %q, %v, want %q", c.listen, c.cert != "", got, err, c.want)
		}
	}
}
