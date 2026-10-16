package blob

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"iter"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

// The flavours, one per row of the capability table. The names are the
// values of the s3 block's `flavour` (internal/config: FlavourAWS,
// FlavourCeph); the store maps the block, this leaf does not import it.
const (
	FlavourAWS  = "aws"
	FlavourCeph = "ceph"
)

// flavour is one row of the capability table: every way in which the
// providers differ is one field here. A row claims only what was measured;
// an unmeasured field takes the value that claims nothing.
type flavour struct {
	// endpointFromRegion: the SDK derives the endpoint from the region,
	// and a configured endpoint is refused. Else the endpoint is required.
	endpointFromRegion bool
	// pathStyle: <endpoint>/<bucket>/<key>; else <bucket>.<endpoint>/<key>.
	pathStyle bool
	// regionHeader: a request signed for the wrong region is refused with
	// the bucket's region in x-amz-bucket-region; the probe names it.
	regionHeader bool
	// locationConstraint: CreateBucket names the region (except
	// us-east-1, where AWS refuses it).
	locationConstraint bool
	// conditionalPut: If-None-Match "*" on PutObject is honoured.
	conditionalPut bool
	// The SDK's request checksums (x-amz-checksum-crc32 on PutObject) and
	// the check of response checksums.
	requestChecksum  aws.RequestChecksumCalculation
	responseChecksum aws.ResponseChecksumValidation
}

var flavours = map[string]flavour{
	// Measured against eu-central-2 on 2026-10-16 (s3_wire_test.go,
	// TestAWSWire):
	//   - the SDK's default checksums (WhenSupported: a CRC32 on each
	//     PutObject) are accepted, and HeadObject with ChecksumMode
	//     returns the stored CRC32;
	//   - If-None-Match "*" answers 412 on an existing key (ErrExists);
	//   - HeadBucket signed for the wrong region (eu-west-1, us-east-1)
	//     answers 400, not the 301 of the documentation (probably because
	//     eu-central-2 is an opt-in region); x-amz-bucket-region names the
	//     region in both cases, so the probe reads the header whatever the
	//     status (a bucket in a default region would answer 301);
	//   - presigned PUT links carry no checksum parameters (the SDK's
	//     presign turns the default checksum off: withNoDefaultChecksumAPIOption)
	//     and work from plain
	//     net/http; Content-Length is signed into them, so another length
	//     is refused (403); an expired link is refused (403);
	//   - the bucket's CORS rule answers a presigned GET with an Origin
	//     with Access-Control-Allow-Origin.
	FlavourAWS: {
		endpointFromRegion: true,
		pathStyle:          false,
		regionHeader:       true,
		locationConstraint: true,
		conditionalPut:     true,
		requestChecksum:    aws.RequestChecksumCalculationWhenSupported,
		responseChecksum:   aws.ResponseChecksumValidationWhenSupported,
	},
	// Ceph RGW as cloudscale runs it. NOT measured yet (no bucket; the
	// wire test TestCephWire is skipped). Each field below claims nothing:
	//   - path style and a configured endpoint: how RGW is reached
	//     (https://objects.lpg.cloudscale.ch); this is the setup, not a claim;
	//   - one zonegroup, so no wrong-region answer and no LocationConstraint;
	//   - no conditional put: RGW's If-None-Match is version dependent;
	//   - checksums only when an operation requires them: older RGW
	//     versions refuse x-amz-checksum-crc32.
	FlavourCeph: {
		endpointFromRegion: false,
		pathStyle:          true,
		regionHeader:       false,
		locationConstraint: false,
		conditionalPut:     false,
		requestChecksum:    aws.RequestChecksumCalculationWhenRequired,
		responseChecksum:   aws.ResponseChecksumValidationWhenRequired,
	},
}

// cephDefaultRegion is the signing scope when a ceph block gives none.
// Unmeasured: RGW is said to accept any region name for its one zonegroup;
// the wire test will tell.
const cephDefaultRegion = "us-east-1"

// S3Config is the leaf's own view of an s3 block (DEC-0038, fork 3).
type S3Config struct {
	Flavour  string
	Region   string
	Endpoint string
	Bucket   string
	// Prefix places every key under it ("a/b" or "a/b/" both give
	// "a/b/<key>"); it follows the key rule.
	Prefix string
	// The files with the access key id and the secret key. White space at
	// both ends is trimmed (the files end in a newline).
	AccessKeyFile string
	SecretKeyFile string
	// HTTPClient is optional; nil uses the SDK's.
	HTTPClient *http.Client

	// testEndpoint replaces the endpoint for any flavour; tests only (the
	// httptest fake stands in for AWS).
	testEndpoint string
}

// OpenOptions are what the store asks of its bucket. Open applies them to
// a new bucket and to an existing one (so a changed rule takes effect at
// the next start).
type OpenOptions struct {
	// Versioning turns versioning on (worlds: a delete leaves a marker, and
	// the identity may not delete a version). False leaves it as it is.
	Versioning bool
	// CORS replaces the bucket's CORS rules when not empty (artifacts:
	// the browser loads presigned GETs from another origin).
	CORS []CORSRule
}

// CORSRule is one CORS rule of a bucket.
type CORSRule struct {
	AllowedOrigins []string
	AllowedMethods []string
	AllowedHeaders []string
	ExposeHeaders  []string
	MaxAge         time.Duration
}

// ReadLinkCORS is the CORS rule of a bucket whose presigned GETs a browser
// follows (the 302 of a read, DEC-0038 step 3; the artifacts bucket and,
// since 2026-10-16, the worlds bucket). The allowed origin is "*", with no
// credentials: a presigned GET is a capability URL (the right was checked
// when it was issued, DEC-0038, fork 5), and anyone who holds it can use it
// outside a browser, so a narrower origin protects nothing. "*" also covers
// the `Origin: null` a browser sends after a redirect from a third origin
// (the API on another host than the page), and it needs no setting.
//
// Every request header is allowed: the browser sends the read with the
// session's Authorization header, and on the redirect to the bucket it
// drops the header but still asks for it in the preflight (measured in
// Safari 26.6, 2026-10-16: OPTIONS with Access-Control-Request-Headers:
// authorization, then a GET without it). A rule that does not allow it
// fails the read.
func ReadLinkCORS() []CORSRule {
	return []CORSRule{{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{http.MethodGet, http.MethodHead},
		AllowedHeaders: []string{"*"},
		ExposeHeaders:  []string{"ETag", "Content-Length"},
		MaxAge:         time.Hour,
	}}
}

// S3 is the backend for one bucket.
type S3 struct {
	client  *s3.Client
	presign *s3.PresignClient
	bucket  string
	prefix  string // "" or ends in "/"
	row     flavour
	// pageSize is MaxKeys for List; 0 is the provider's (1000). Tests set it.
	pageSize int32
}

var _ Bucket = (*S3)(nil)

// OpenS3 checks the configuration, reads the key files, probes the bucket
// (HeadBucket) and makes it when it is missing, then applies `opts`. A
// wrong bucket, region or key so fails at start, not at the first request.
// Open may create its own bucket and nothing else; it never deletes one.
func OpenS3(ctx context.Context, cfg S3Config, opts OpenOptions) (*S3, error) {
	row, ok := flavours[cfg.Flavour]
	if !ok {
		return nil, fmt.Errorf("blob: s3 flavour %q is unknown (%s or %s)", cfg.Flavour, FlavourAWS, FlavourCeph)
	}
	if cfg.Bucket == "" {
		return nil, errors.New("blob: s3 needs a bucket")
	}
	region := cfg.Region
	endpoint := cfg.Endpoint
	if row.endpointFromRegion {
		if endpoint != "" {
			return nil, fmt.Errorf("blob: flavour %s takes no endpoint (it comes from the region)", cfg.Flavour)
		}
		if region == "" {
			return nil, fmt.Errorf("blob: flavour %s needs the bucket's region", cfg.Flavour)
		}
	} else {
		if endpoint == "" {
			return nil, fmt.Errorf("blob: flavour %s needs an endpoint", cfg.Flavour)
		}
		if region == "" {
			region = cephDefaultRegion
		}
	}
	if cfg.testEndpoint != "" {
		endpoint = cfg.testEndpoint
	}
	prefix := strings.TrimSuffix(cfg.Prefix, "/")
	if prefix != "" {
		if err := CheckKey(prefix); err != nil {
			return nil, fmt.Errorf("blob: s3 prefix: %w", err)
		}
		prefix += "/"
	}
	creds, err := readKeyPair(cfg.AccessKeyFile, cfg.SecretKeyFile)
	if err != nil {
		return nil, err
	}

	o := s3.Options{
		Region:                     region,
		Credentials:                aws.NewCredentialsCache(creds),
		UsePathStyle:               row.pathStyle,
		RequestChecksumCalculation: row.requestChecksum,
		ResponseChecksumValidation: row.responseChecksum,
	}
	if endpoint != "" {
		o.BaseEndpoint = aws.String(endpoint)
	}
	if cfg.HTTPClient != nil {
		o.HTTPClient = cfg.HTTPClient
	}
	client := s3.New(o)
	b := &S3{
		client:  client,
		presign: s3.NewPresignClient(client),
		bucket:  cfg.Bucket,
		prefix:  prefix,
		row:     row,
	}
	if err := b.probe(ctx, region); err != nil {
		return nil, err
	}
	if err := b.apply(ctx, opts); err != nil {
		return nil, err
	}
	return b, nil
}

// readKeyPair reads the two key files. The messages name the files, never
// their content.
func readKeyPair(accessFile, secretFile string) (aws.CredentialsProvider, error) {
	if accessFile == "" || secretFile == "" {
		return nil, errors.New("blob: s3 needs access-key-file and secret-key-file (no other credential source is built)")
	}
	read := func(path string) (string, error) {
		raw, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("blob: s3 key file: %w", err)
		}
		v := string(bytes.TrimSpace(raw))
		if v == "" {
			return "", fmt.Errorf("blob: s3 key file %s is empty", path)
		}
		return v, nil
	}
	id, err := read(accessFile)
	if err != nil {
		return nil, err
	}
	secret, err := read(secretFile)
	if err != nil {
		return nil, err
	}
	return aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
		return aws.Credentials{AccessKeyID: id, SecretAccessKey: secret, Source: "blob key files"}, nil
	}), nil
}

// probe makes sure the bucket is there and in this region, and creates it
// when it is missing. It creates only on a clear "not found": a wrong
// region or a refusal must never lead to a bucket made elsewhere.
func (b *S3) probe(ctx context.Context, region string) error {
	_, err := b.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: &b.bucket})
	if err == nil {
		return nil
	}
	// The region header comes before the status: AWS names the bucket's
	// region on a 301 (documented) and on a 400 (measured, for a bucket in
	// the opt-in region eu-central-2).
	if b.row.regionHeader {
		if other := header(err, "X-Amz-Bucket-Region"); other != "" && other != region {
			return fmt.Errorf("blob: bucket %s is in region %s, not %s — set the s3 block's region to %s (HTTP %d)", b.bucket, other, region, other, status(err))
		}
	}
	switch status(err) {
	case http.StatusNotFound:
		return b.create(ctx, region)
	case http.StatusMovedPermanently:
		return fmt.Errorf("blob: bucket %s answered a redirect (wrong region or endpoint?): %w", b.bucket, err)
	case http.StatusForbidden:
		return fmt.Errorf("blob: bucket %s: access denied — the name belongs to someone else, or the identity lacks s3:ListBucket on it: %w", b.bucket, err)
	}
	return fmt.Errorf("blob: probe bucket %s: %w", b.bucket, err)
}

func (b *S3) create(ctx context.Context, region string) error {
	in := &s3.CreateBucketInput{Bucket: &b.bucket}
	if b.row.locationConstraint && region != "us-east-1" {
		in.CreateBucketConfiguration = &types.CreateBucketConfiguration{
			LocationConstraint: types.BucketLocationConstraint(region),
		}
	}
	_, err := b.client.CreateBucket(ctx, in)
	var owned *types.BucketAlreadyOwnedByYou
	var taken *types.BucketAlreadyExists
	switch {
	case err == nil, errors.As(err, &owned):
	case errors.As(err, &taken):
		return fmt.Errorf("blob: bucket name %s is taken by another account (bucket names are global)", b.bucket)
	default:
		return fmt.Errorf("blob: create bucket %s: %w", b.bucket, err)
	}
	// A new bucket can answer 404 for a short time.
	w := s3.NewBucketExistsWaiter(b.client, func(o *s3.BucketExistsWaiterOptions) {
		o.MinDelay = 200 * time.Millisecond
		o.MaxDelay = 2 * time.Second
	})
	if err := w.Wait(ctx, &s3.HeadBucketInput{Bucket: &b.bucket}, time.Minute); err != nil {
		return fmt.Errorf("blob: bucket %s made but not reachable: %w", b.bucket, err)
	}
	return nil
}

func (b *S3) apply(ctx context.Context, opts OpenOptions) error {
	if opts.Versioning {
		v, err := b.client.GetBucketVersioning(ctx, &s3.GetBucketVersioningInput{Bucket: &b.bucket})
		if err != nil {
			return fmt.Errorf("blob: bucket %s versioning: %w", b.bucket, err)
		}
		if v.Status != types.BucketVersioningStatusEnabled {
			_, err := b.client.PutBucketVersioning(ctx, &s3.PutBucketVersioningInput{
				Bucket:                  &b.bucket,
				VersioningConfiguration: &types.VersioningConfiguration{Status: types.BucketVersioningStatusEnabled},
			})
			if err != nil {
				return fmt.Errorf("blob: bucket %s versioning on: %w", b.bucket, err)
			}
		}
	}
	if len(opts.CORS) > 0 {
		rules := make([]types.CORSRule, len(opts.CORS))
		for i, r := range opts.CORS {
			rules[i] = types.CORSRule{
				AllowedOrigins: r.AllowedOrigins,
				AllowedMethods: r.AllowedMethods,
				AllowedHeaders: r.AllowedHeaders,
				ExposeHeaders:  r.ExposeHeaders,
			}
			if r.MaxAge > 0 {
				rules[i].MaxAgeSeconds = aws.Int32(int32(r.MaxAge / time.Second))
			}
		}
		_, err := b.client.PutBucketCors(ctx, &s3.PutBucketCorsInput{
			Bucket:            &b.bucket,
			CORSConfiguration: &types.CORSConfiguration{CORSRules: rules},
		})
		if err != nil {
			return fmt.Errorf("blob: bucket %s CORS: %w", b.bucket, err)
		}
	}
	return nil
}

// full checks the key and places it under the prefix.
func (b *S3) full(key string) (string, error) {
	if err := CheckKey(key); err != nil {
		return "", err
	}
	full := b.prefix + key
	if len(full) > MaxKeyLength {
		return "", keyError(full, fmt.Sprintf("longer than %d bytes with the prefix", MaxKeyLength))
	}
	return full, nil
}

func (b *S3) Get(ctx context.Context, key string) (io.ReadCloser, Info, error) {
	k, err := b.full(key)
	if err != nil {
		return nil, Info{}, err
	}
	out, err := b.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &b.bucket, Key: &k})
	if err != nil {
		return nil, Info{}, s3Error(err)
	}
	return out.Body, Info{
		Key:          key,
		Size:         aws.ToInt64(out.ContentLength),
		ETag:         etag(out.ETag),
		LastModified: aws.ToTime(out.LastModified),
	}, nil
}

func (b *S3) Head(ctx context.Context, key string) (Info, error) {
	k, err := b.full(key)
	if err != nil {
		return Info{}, err
	}
	out, err := b.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &b.bucket, Key: &k})
	if err != nil {
		return Info{}, s3Error(err)
	}
	return Info{
		Key:          key,
		Size:         aws.ToInt64(out.ContentLength),
		ETag:         etag(out.ETag),
		LastModified: aws.ToTime(out.LastModified),
	}, nil
}

// Put sends one PutObject: atomic on S3 by itself. A body that can seek is
// measured before it is sent (ErrSize); for another body net/http refuses
// a length that does not match. The returned Info has no LastModified (S3
// does not answer it on a PUT; Head does).
func (b *S3) Put(ctx context.Context, key string, body io.Reader, size int64, opts PutOptions) (Info, error) {
	k, err := b.full(key)
	if err != nil {
		return Info{}, err
	}
	if size < 0 {
		return Info{}, fmt.Errorf("%w: size %d is negative", ErrSize, size)
	}
	if opts.IfAbsent && !b.row.conditionalPut {
		return Info{}, fmt.Errorf("%w: conditional put", ErrUnsupported)
	}
	if s, ok := body.(io.Seeker); ok {
		if err := checkSeekLength(s, size); err != nil {
			return Info{}, err
		}
	}
	in := &s3.PutObjectInput{Bucket: &b.bucket, Key: &k, Body: body, ContentLength: aws.Int64(size)}
	if opts.ContentType != "" {
		in.ContentType = aws.String(opts.ContentType)
	}
	if opts.IfAbsent {
		in.IfNoneMatch = aws.String("*")
	}
	out, err := b.client.PutObject(ctx, in)
	if err != nil {
		return Info{}, s3Error(err)
	}
	return Info{Key: key, Size: size, ETag: etag(out.ETag)}, nil
}

func checkSeekLength(s io.Seeker, size int64) error {
	cur, err := s.Seek(0, io.SeekCurrent)
	if err != nil {
		return nil // a Seeker that cannot seek: leave it to net/http
	}
	end, err := s.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	if _, err := s.Seek(cur, io.SeekStart); err != nil {
		return err
	}
	if end-cur != size {
		return fmt.Errorf("%w: body has %d bytes, %d given", ErrSize, end-cur, size)
	}
	return nil
}

func (b *S3) Delete(ctx context.Context, key string) error {
	k, err := b.full(key)
	if err != nil {
		return err
	}
	_, err = b.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &b.bucket, Key: &k})
	if err != nil {
		if err := s3Error(err); errors.Is(err, ErrNotFound) {
			return nil
		}
		return s3Error(err)
	}
	return nil
}

func (b *S3) List(ctx context.Context, prefix string) iter.Seq2[Info, error] {
	return func(yield func(Info, error) bool) {
		if err := checkPrefix(prefix); err != nil {
			yield(Info{}, err)
			return
		}
		full := b.prefix + prefix
		in := &s3.ListObjectsV2Input{Bucket: &b.bucket, Prefix: &full}
		if b.pageSize > 0 {
			in.MaxKeys = aws.Int32(b.pageSize)
		}
		pages := s3.NewListObjectsV2Paginator(b.client, in)
		for pages.HasMorePages() {
			page, err := pages.NextPage(ctx)
			if err != nil {
				yield(Info{}, s3Error(err))
				return
			}
			for _, o := range page.Contents {
				k := aws.ToString(o.Key)
				if !strings.HasPrefix(k, b.prefix) {
					continue // cannot happen: the provider filtered by it
				}
				info := Info{
					Key:          strings.TrimPrefix(k, b.prefix),
					Size:         aws.ToInt64(o.Size),
					ETag:         etag(o.ETag),
					LastModified: aws.ToTime(o.LastModified),
				}
				if !yield(info, nil) {
					return
				}
			}
		}
	}
}

func (b *S3) PresignGet(ctx context.Context, key string, ttl time.Duration) (Link, error) {
	k, err := b.full(key)
	if err != nil {
		return Link{}, err
	}
	if err := checkTTL(ttl); err != nil {
		return Link{}, err
	}
	now := time.Now()
	req, err := b.presign.PresignGetObject(ctx, &s3.GetObjectInput{Bucket: &b.bucket, Key: &k}, s3.WithPresignExpires(ttl))
	if err != nil {
		return Link{}, err
	}
	return Link{Method: req.Method, URL: req.URL, Header: linkHeader(req.SignedHeader), Expires: now.Add(ttl)}, nil
}

func (b *S3) PresignPut(ctx context.Context, key string, ttl time.Duration, length int64) (Link, error) {
	k, err := b.full(key)
	if err != nil {
		return Link{}, err
	}
	if err := checkTTL(ttl); err != nil {
		return Link{}, err
	}
	if length < 0 {
		return Link{}, fmt.Errorf("%w: length %d is negative", ErrSize, length)
	}
	now := time.Now()
	req, err := b.presign.PresignPutObject(ctx, &s3.PutObjectInput{Bucket: &b.bucket, Key: &k, ContentLength: aws.Int64(length)}, s3.WithPresignExpires(ttl))
	if err != nil {
		return Link{}, err
	}
	return Link{Method: req.Method, URL: req.URL, Header: linkHeader(req.SignedHeader), Expires: now.Add(ttl)}, nil
}

// linkHeader keeps the signed headers a client must send. Host comes from
// the URL, so it is dropped.
func linkHeader(signed http.Header) http.Header {
	h := http.Header{}
	for k, v := range signed {
		if strings.EqualFold(k, "Host") {
			continue
		}
		h[http.CanonicalHeaderKey(k)] = v
	}
	return h
}

// s3Error gives the provider's answers this package's shapes.
func s3Error(err error) error {
	var noKey *types.NoSuchKey
	var notFound *types.NotFound
	var noBucket *types.NoSuchBucket
	switch {
	case errors.As(err, &noBucket):
		return ErrNoBucket
	case errors.As(err, &noKey), errors.As(err, &notFound):
		return ErrNotFound
	}
	var api smithy.APIError
	if errors.As(err, &api) {
		switch api.ErrorCode() {
		case "NoSuchBucket":
			return ErrNoBucket
		case "NoSuchKey", "NotFound":
			return ErrNotFound
		case "PreconditionFailed", "ConditionalRequestConflict":
			return ErrExists
		}
	}
	switch status(err) {
	case http.StatusNotFound:
		return ErrNotFound
	case http.StatusPreconditionFailed:
		return ErrExists
	}
	return err
}

func status(err error) int {
	var re *awshttp.ResponseError
	if errors.As(err, &re) {
		return re.HTTPStatusCode()
	}
	return 0
}

func header(err error, name string) string {
	var re *awshttp.ResponseError
	if errors.As(err, &re) && re.Response != nil {
		return re.Response.Header.Get(name)
	}
	return ""
}

func etag(p *string) string { return strings.Trim(aws.ToString(p), `"`) }
