package cmd

import (
	"net"
	"strings"
	"testing"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

// Without TLS a local worker reaches this server over the public listener
// (DEC-0038, step 3).
func TestLocalWorkerAPIWithoutTLS(t *testing.T) {
	cases := []struct {
		listen, want, wantErr string
	}{
		{listen: ":8080", want: "http://127.0.0.1:8080/v1"},
		{listen: "0.0.0.0:8080", want: "http://127.0.0.1:8080/v1"},
		{listen: "[::]:8080", want: "http://[::1]:8080/v1"},
		{listen: "localhost:9000", want: "http://localhost:9000/v1"},
		{listen: "10.0.0.5:8080", want: "http://10.0.0.5:8080/v1"},
		{listen: "nonsense", wantErr: "global.listen"},
	}
	for _, c := range cases {
		var g config.Global
		g.Listen = c.listen
		got, listener, err := localWorkerAPI(g)
		if listener != nil {
			listener.Close()
			t.Errorf("%s: an internal listener without TLS", c.listen)
		}
		if c.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Errorf("%s: err = %v, want %q", c.listen, err, c.wantErr)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%s: %q, %v, want %q", c.listen, got, err, c.want)
		}
	}
}

// With TLS the local worker gets the internal listener: bound to exactly
// 127.0.0.1 (never a wildcard, it speaks plain HTTP), on a port of its own,
// and the URL names that address — whatever the public listener binds.
func TestLocalWorkerAPIWithTLSOpensTheInternalListener(t *testing.T) {
	for _, listen := range []string{":8443", "0.0.0.0:8443", "[::]:8443", "casas.example.org:443"} {
		var g config.Global
		g.Listen, g.TLS.Cert, g.TLS.Key = listen, "c.pem", "k.pem"
		got, listener, err := localWorkerAPI(g)
		if err != nil {
			t.Fatalf("%s: %v", listen, err)
		}
		addr, ok := listener.Addr().(*net.TCPAddr)
		if !ok || !addr.IP.Equal(net.IPv4(127, 0, 0, 1)) || addr.Port == 0 {
			t.Errorf("%s: bound to %v, want 127.0.0.1 with a port", listen, listener.Addr())
		}
		if want := "http://" + listener.Addr().String() + "/v1"; got != want {
			t.Errorf("%s: %q, want %q", listen, got, want)
		}
		listener.Close()
	}
}
