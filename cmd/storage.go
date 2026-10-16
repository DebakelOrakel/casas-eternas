package cmd

import (
	"context"
	"fmt"
	"net"

	"github.com/DebakelOrakel/casas-eternas/internal/blob"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/modules/artifacts"
	"github.com/DebakelOrakel/casas-eternas/internal/modules/world"
	"github.com/DebakelOrakel/casas-eternas/internal/server"
)

// openObjectStorage maps a validated storage union to the blob leaf
// (DEC-0038): `dir` to a blob.Dir at dir.path that signs its links with
// `signer` (nil: no links), `s3` to a blob.S3 opened with `opts`. Here and
// not in internal/config, because the leaf does not import the
// configuration and the configuration does not know the leaf. Both stores
// use it (the world store since DEC-0038 step 5).
func openObjectStorage(ctx context.Context, section string, storage config.ObjectStorage, signer *blob.LinkSigner, opts blob.OpenOptions) (blob.Bucket, error) {
	switch storage.Type {
	case "dir":
		d, err := blob.OpenDir(storage.DirPath(), signer)
		if err != nil {
			return nil, fmt.Errorf("%s.storage.dir.path: %w", section, err)
		}
		return d, nil
	case "s3":
		s := storage.S3
		b, err := blob.OpenS3(ctx, blob.S3Config{
			Flavour:       s.Flavour,
			Region:        s.Region,
			Endpoint:      s.Endpoint,
			Bucket:        s.Bucket,
			Prefix:        s.Prefix,
			AccessKeyFile: s.AccessKeyFile,
			SecretKeyFile: s.SecretKeyFile,
		}, opts)
		if err != nil {
			return nil, fmt.Errorf("%s.storage.s3: %w", section, err)
		}
		return b, nil
	default:
		// Validate refused it already; this is the guard for a caller that
		// did not validate.
		return nil, fmt.Errorf("%s.storage.type: unknown backend %q", section, storage.Type)
	}
}

// openArtifactBucket opens the artifact store's bucket. Only the dir
// backend reads artifacts.link-key: on s3 the provider signs the links
// (DEC-0038, fork 4).
func openArtifactBucket(ctx context.Context, cfg config.Config) (blob.Bucket, error) {
	var signer *blob.LinkSigner
	if cfg.Artifacts.Storage.Type == "dir" {
		var err error
		signer, err = artifacts.NewLinkSigner(cfg)
		if err != nil {
			return nil, err
		}
	}
	return openObjectStorage(ctx, "artifacts", cfg.Artifacts.Storage, signer, artifacts.BucketOptions())
}

// openWorldBucket opens the world store's bucket: on s3 with versioning
// (world.BucketOptions). No link signer: the world store gives no links,
// its zips and previews are served through the server.
func openWorldBucket(ctx context.Context, cfg config.Config) (blob.Bucket, error) {
	return openObjectStorage(ctx, "world", cfg.World.Storage, nil, world.BucketOptions())
}

// internalListenAddr is where the internal listener binds: the IPv4
// loopback address, a free port. Exactly 127.0.0.1, never a wildcard: the
// listener speaks plain HTTP. No flag: the port is known only to this
// process and the workers it starts.
const internalListenAddr = "127.0.0.1:0"

// listenInternal opens the internal listener. A variable, so that a test
// can hold the listener that a failed wiring must close again.
var listenInternal = func() (net.Listener, error) { return net.Listen("tcp", internalListenAddr) }

// localWorkerAPI is this server's own API as a job worker on the same
// machine reaches it. Since DEC-0038 step 3 a local worker writes its
// artifacts over HTTP, as a cluster worker always did: the store's index
// lives in this process (one process per store) and sees only what passes
// through it.
//
// Without TLS that is the public listener (loopbackURL). With
// global.tls.cert it is not: the certificate names the public host, and a
// worker that asks for localhost cannot verify it (nor one signed by a
// private authority it does not trust). So an INTERNAL LISTENER is opened
// on 127.0.0.1, plain HTTP, and server.Run serves the same handler on it,
// gate included — a worker still needs its job token. Only the local
// workers learn its address. The listener is returned for server.Run; nil
// without TLS.
func localWorkerAPI(g config.Global) (string, net.Listener, error) {
	if !g.Server().TLSEnabled() {
		url, err := loopbackURL(g)
		return url, nil, err
	}
	listener, err := listenInternal()
	if err != nil {
		return "", nil, fmt.Errorf("the internal listener for the local job workers: %w", err)
	}
	return "http://" + listener.Addr().String() + server.APIPrefix, listener, nil
}

// loopbackURL is the plain-HTTP public listener as a process on the same
// machine reaches it: a wildcard host becomes the loopback address.
func loopbackURL(g config.Global) (string, error) {
	host, port, err := net.SplitHostPort(g.Listen)
	if err != nil {
		return "", fmt.Errorf("global.listen %q: %w", g.Listen, err)
	}
	switch host {
	case "", "0.0.0.0":
		host = "127.0.0.1"
	case "::":
		host = "::1"
	}
	return "http://" + net.JoinHostPort(host, port) + server.APIPrefix, nil
}
