package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// A module whose Mount registers whatever patterns it is given — enough to
// provoke ServeMux's own duplicate-pattern panic, which is the realistic way
// a Mount blows up.
type patternModule struct{ patterns []string }

func (m patternModule) Name() string { return "pattern" }
func (m patternModule) Mount(mux *http.ServeMux) error {
	for _, p := range m.patterns {
		mux.HandleFunc(p, func(http.ResponseWriter, *http.Request) {})
	}
	return nil
}
func (m patternModule) Close() error { return nil }

// Two modules claiming one route is a composition bug in cmd/, and it must
// surface as an error naming the conflict — not as a process-killing panic
// from inside the mount loop.
func TestMountTurnsPanicsIntoErrors(t *testing.T) {
	mux := http.NewServeMux()
	if err := mount(patternModule{patterns: []string{"GET /v1/things"}}, mux); err != nil {
		t.Fatalf("first claim: %v", err)
	}
	err := mount(patternModule{patterns: []string{"GET /v1/things"}}, mux)
	if err == nil {
		t.Fatal("a duplicate route pattern mounted without complaint")
	}
	if !strings.Contains(err.Error(), "panic") {
		t.Errorf("the error should say it was a recovered panic, got: %v", err)
	}
}

// A module with one route behind the gate, standing for any API route.
type worldsModule struct{}

func (worldsModule) Name() string { return "worlds" }
func (worldsModule) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("GET /v1/worlds/{uid}", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	return nil
}
func (worldsModule) Close() error { return nil }

// selfSigned writes a certificate for casas.test (not localhost, as a real
// one names the public host) and its key, and answers the two paths and a
// pool that trusts the certificate.
func selfSigned(t *testing.T) (string, string, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "casas.test"},
		DNSNames:     []string{"casas.test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return certPath, keyPath, pool
}

// freePort is a loopback port nothing listens on, for the public listener,
// whose address Run takes as configuration.
func freePort(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().String()
}

// The internal listener (cmd/ opens it for the local job workers when the
// public listener speaks TLS): plain HTTP, the SAME gate — a request
// without a token is refused, a job token passes, the public paths stay
// public — while the public listener still serves TLS only. Both close
// when the server stops.
func TestInternalListenerServesTheGatedHandler(t *testing.T) {
	gate, tokens := newGate(t, config.AuthPassword)
	certPath, keyPath, pool := selfSigned(t)
	public := freePort(t)
	internal, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, config.Server{Listen: public, TLSCert: certPath, TLSKey: keyPath}, "test", []Module{worldsModule{}}, gate, internal)
	}()

	base := "http://" + internal.Addr().String()
	get := func(client *http.Client, url, bearer string) (int, error) {
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		resp, err := client.Do(req)
		if err != nil {
			return 0, err
		}
		resp.Body.Close()
		return resp.StatusCode, nil
	}
	// Up when the capabilities answer on the public listener.
	tlsClient := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: "casas.test"}}}
	deadline := time.Now().Add(5 * time.Second)
	for {
		code, err := get(tlsClient, "https://"+public+CapabilitiesPath, "")
		if err == nil && code == http.StatusOK {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the public listener did not answer over TLS: %d, %v", code, err)
		}
		time.Sleep(20 * time.Millisecond)
	}

	job, _, err := tokens.Issue(token.SubjectJob, token.JobAudience("job-1"), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	plain := &http.Client{Timeout: 2 * time.Second}
	for _, c := range []struct {
		path, bearer string
		want         int
	}{
		{"/v1/worlds/abc", "", http.StatusUnauthorized},
		{"/v1/worlds/abc", "not-a-token", http.StatusUnauthorized},
		{"/v1/worlds/abc", job, http.StatusOK},
		{CapabilitiesPath, "", http.StatusOK},
	} {
		if code, err := get(plain, base+c.path, c.bearer); err != nil || code != c.want {
			t.Errorf("internal %s (token %v): %d, %v, want %d", c.path, c.bearer != "", code, err, c.want)
		}
	}
	// The public listener is not weakened: plain HTTP gets no API there.
	if code, err := get(plain, "http://"+public+"/v1/worlds/abc", job); err == nil && code == http.StatusOK {
		t.Errorf("the public listener answered plain HTTP with the API")
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return after the cancel")
	}
	if conn, err := net.DialTimeout("tcp", internal.Addr().String(), time.Second); err == nil {
		conn.Close()
		t.Error("the internal listener still accepts after the server stopped")
	}
}

// A listener whose address is not on the loopback interface.
type foreignListener struct{ net.Listener }

func (foreignListener) Addr() net.Addr { return &net.TCPAddr{IP: net.IPv4(10, 0, 0, 5), Port: 8081} }

// The internal listener speaks plain HTTP, so Run refuses one that is not on
// a loopback address — and closes it.
func TestInternalListenerMustBeLoopback(t *testing.T) {
	inner, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	err = Run(context.Background(), config.Server{Listen: freePort(t)}, "test", nil, nil, foreignListener{inner})
	if err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("want a non-loopback internal listener refused, got %v", err)
	}
	if conn, err := net.DialTimeout("tcp", inner.Addr().String(), time.Second); err == nil {
		conn.Close()
		t.Error("the refused listener was not closed")
	}
}
