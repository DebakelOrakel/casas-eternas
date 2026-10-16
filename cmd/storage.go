package cmd

import (
	"context"
	"errors"
	"fmt"
	"net"

	"github.com/DebakelOrakel/casas-eternas/internal/blob"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/modules/artifacts"
	"github.com/DebakelOrakel/casas-eternas/internal/server"
)

// openObjectStorage maps a validated storage union to the blob leaf
// (DEC-0038): `dir` to a blob.Dir at dir.path that signs its links with
// `signer` (nil: no links), `s3` to a blob.S3 opened with `opts`. Here and
// not in internal/config, because the leaf does not import the
// configuration and the configuration does not know the leaf; the world
// store will use the same function when it moves onto the leaf.
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

// loopbackURL is this server's own API as a job worker on the same machine
// reaches it. Since DEC-0038 step 3 a local worker writes its artifacts
// over HTTP, as a cluster worker always did: the store's index lives in
// this process (one process per store) and sees only what passes through
// it. A wildcard host becomes the loopback address.
//
// With global.tls.cert the scheme is https and a wildcard host becomes
// "localhost", the name a certificate for a local run carries. With
// global.tls.ca (a client certificate required) the worker cannot connect
// at all, so that refuses to start instead of failing every job.
func loopbackURL(g config.Global) (string, error) {
	host, port, err := net.SplitHostPort(g.Listen)
	if err != nil {
		return "", fmt.Errorf("global.listen %q: %w", g.Listen, err)
	}
	scheme := "http"
	if g.TLS.Cert != "" {
		if g.TLS.CA != "" {
			return "", errors.New("jobs beside artifacts outside a cluster: a local worker writes over this server's API, and global.tls.ca requires a client certificate it does not have")
		}
		scheme = "https"
	}
	switch {
	case host != "" && host != "0.0.0.0" && host != "::":
	case scheme == "https":
		host = "localhost"
	case host == "::":
		host = "::1"
	default:
		host = "127.0.0.1"
	}
	return scheme + "://" + net.JoinHostPort(host, port) + server.APIPrefix, nil
}
